#!/usr/bin/env python3
"""Write release blog posts for past releases and refresh the release tables.

Called by .github/workflows/backfill-blog-posts.yml:

    python3 .github/scripts/backfill_blog_posts.py [--regenerate true] [--pr-numbers "1, 3"]

and by the docs job in .github/workflows/release.yml, which names the PRs its
run just released:

    python3 .github/scripts/backfill_blog_posts.py --wait-for-prs "187, 188"

Every non-draft GitHub Release names its source PR in a "Source PR: #n"
line. For each release whose PR has no docs/blogs/*-pr-{n}-*.md post (or
every release with --regenerate), it writes the post with release_post.py
under the release's existing tag. It never creates tags or Releases. Then
the README, docs/README.md and docs/index.html tables are rebuilt once, even
when no post was written, so docs/README.md follows a README-only
[skip-release] merge. When main is already up to date, no file changes.

GitHub's release list can lag a just-published Release by several seconds,
so with --wait-for-prs it lists again until every named PR has a Release,
every 2s for up to half a minute. A PR whose release failed never appears;
after the last attempt the run writes what is listed, and the next run
picks up the rest.
"""

import argparse
import os
import time
import urllib.request
from pathlib import Path

import release_post as rp


def parse_pr_numbers(text):
    """Parse "1, #3" into {1, 3}; empty text means no limit (None)."""
    numbers = {part.strip().lstrip("#") for part in (text or "").split(",")} - {""}
    if not numbers:
        return None
    if not all(n.isdigit() for n in numbers):
        raise ValueError(f"pr_numbers must be comma-separated PR numbers, got {text!r}")
    return {int(n) for n in numbers}


WAIT_ATTEMPTS = 15
WAIT_DELAY = 2


def listed_releases(gh, wait_for=None, attempts=WAIT_ATTEMPTS, delay=WAIT_DELAY, sleep=time.sleep):
    """The non-draft releases, once every PR in wait_for has one, or after the last attempt."""
    for attempt in range(1, attempts + 1):
        releases = gh.releases()
        named = {rp.source_pr_of(release) for release in releases}
        missing = sorted(set(wait_for or ()) - named)
        if not missing:
            return releases
        prs = ", ".join(f"#{number}" for number in missing)
        if attempt == attempts:
            rp.log(f"::warning::No Release is listed yet for PR {prs}; writing posts for the listed ones only.")
            return releases
        rp.log(f"The Release for PR {prs} isn't listed yet; listing again in {delay}s.")
        sleep(delay)


class ListedReleases:
    """gh with releases() fixed to one listing, so the posts and the tables agree."""

    def __init__(self, gh, releases):
        self._gh = gh
        self._releases = releases

    def releases(self):
        return self._releases

    def __getattr__(self, name):
        return getattr(self._gh, name)


def has_post(blog_dir, pr_number):
    return bool(rp.posts_for_pr(blog_dir, pr_number))


def select_releases(releases, blog_dir, regenerate=False, only=None):
    """The (pr, tag) pairs to write, oldest release first."""
    selected = []
    for release in releases:
        pr_number = rp.source_pr_of(release)
        if pr_number is None:
            rp.log(f"::notice::{release['tag_name']} has no 'Source PR: #n' line; skipping it.")
            continue
        if only is not None and pr_number not in only:
            continue
        if regenerate or not has_post(blog_dir, pr_number):
            selected.append((pr_number, release["tag_name"]))
    return sorted(selected, key=lambda pair: rp.version_key(pair[1]))


def run(repository, gh, root=Path("."), regenerate=False, only=None, api_key=None, model=rp.DEFAULT_MODEL,
        urlopen=urllib.request.urlopen, wait_for=None, sleep=time.sleep):
    """Write the selected posts, then the tables once; return the PR numbers written."""
    root = Path(root)
    blog_dir = root / "docs" / "blogs"
    gh = ListedReleases(gh, listed_releases(gh, wait_for, sleep=sleep))
    selected = select_releases(gh.releases(), blog_dir, regenerate, only)
    if not selected:
        rp.log("Every selected release already has a blog post; refreshing the tables only.")

    for pr_number, tag in selected:
        rp.write_post(gh, pr_number, tag, root, api_key, model, urlopen)
    # Even with no post to write: a README-only PR merged with [skip-release]
    # releases nothing, and this is what copies its README to docs/README.md.
    rp.update_tables(repository, gh, root)
    return [pr_number for pr_number, _ in selected]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--regenerate",
        default="false",
        help="'true' also rewrites posts that already exist (default: false)",
    )
    parser.add_argument("--pr-numbers", default="", help="comma-separated source PR numbers to limit the run to")
    parser.add_argument(
        "--wait-for-prs",
        default="",
        help="comma-separated PR numbers just released; list again until each has a Release",
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("REPOSITORY") or os.environ.get("GITHUB_REPOSITORY"),
        help="owner/name (default: $REPOSITORY or $GITHUB_REPOSITORY)",
    )
    args = parser.parse_args(argv)
    if not args.repo:
        parser.error("--repo is required when REPOSITORY and GITHUB_REPOSITORY are unset")
    try:
        only = parse_pr_numbers(args.pr_numbers)
        wait_for = parse_pr_numbers(args.wait_for_prs)
    except ValueError as error:
        parser.error(str(error))

    run(
        args.repo,
        rp.GitHub(args.repo),
        root=Path("."),
        regenerate=args.regenerate.strip().lower() == "true",
        only=only,
        api_key=(os.environ.get("ANTHROPIC_API_KEY") or "").strip() or None,
        model=(os.environ.get("ANTHROPIC_MODEL") or "").strip() or rp.DEFAULT_MODEL,
        wait_for=wait_for,
    )


if __name__ == "__main__":
    main()
