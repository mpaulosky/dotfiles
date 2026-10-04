#!/usr/bin/env python3
"""Print, as a JSON list, the merged PRs the release workflow still has to release.

Called by .github/workflows/release.yml before it releases anything:

    python3 .github/scripts/release_queue.py --repo owner/name [--pr 42]

Every release run shares one concurrency group, and GitHub keeps only the
newest pending run in a group, cancelling the one it replaces. So a run
doesn't release only the PR that started it: it releases every merged PR
that is still owed a release, oldest merge first. A PR whose run was
cancelled or failed is picked up by the next one, and versions follow merge
order. A manual run (--pr) goes through the same list, so a newer PR can't
be released ahead of an older one.

The cutoff is the newest published GitHub Release (a vMAJOR.MINOR.PATCH tag
whose body names its "Source PR: #n"), never just the newest git tag: a run
that pushed its tag but failed before the Release was published hasn't
released that PR. A PR is owed a release when it merged into main after the
cutoff PR, its title has no [skip-release] marker, Dependabot didn't open it,
no Release names it, and its merge commit isn't already inside the cutoff
Release's tag. The last rule keeps PRs merged before release automation
existed out of the list. With no Release at all, only the triggering PR is
queued.

A Dependabot PR never gets a Release of its own: a dependency bump isn't worth
a Release and blog post. It's folded into the next one instead. The next
Release's tag is on a later commit, so it contains the bump, and its generated
notes list the bump's PR among the changes since the previous Release.

Standard library only, like release_post.py; git and the gh CLI do the rest.
"""

import argparse
import json
import re
import subprocess
import sys

import release_post as rp

PAGE_SIZE = 100

SKIP_MARKER = "[skip-release]"
DEPENDABOT = "dependabot[bot]"


class GitHub(rp.GitHub):
    """release_post's gh wrapper, plus the PRs merged since a point in time."""

    def _closed_pulls_page(self, page):
        path = (
            f"repos/{self.repository}/pulls?state=closed&base=main&sort=updated&direction=desc"
            f"&per_page={PAGE_SIZE}&page={page}"
        )
        output = subprocess.run(["gh", "api", path], check=True, capture_output=True, text=True).stdout
        return json.loads(output)

    def merged_pulls(self, since):
        """Every PR merged into main at or after `since` (an ISO 8601 time), newest update first.

        PRs come sorted by last update, newest first, and a PR's update time is never
        earlier than its merge time. So once one PR was last updated before `since`,
        every PR after it was too, and none of them merged after `since`.
        """
        pulls = []
        page = 1
        while True:
            batch = self._closed_pulls_page(page)
            if not batch:
                return pulls
            for pr in batch:
                if pr.get("merged_at") and pr["merged_at"] >= since:
                    pulled = {key: pr.get(key) for key in ("number", "title", "merged_at", "merge_commit_sha")}
                    pulled["author"] = (pr.get("user") or {}).get("login")
                    pulls.append(pulled)
            if any((pr.get("updated_at") or "") < since for pr in batch):
                return pulls
            page += 1


def cutoff_release(releases):
    """(tag, source PR number) of the newest published Release by version, or (None, None)."""
    candidates = [
        (release["tag_name"], rp.source_pr_of(release))
        for release in releases
        if re.fullmatch(r"v\d+\.\d+\.\d+", release.get("tag_name") or "") and rp.source_pr_of(release) is not None
    ]
    if not candidates:
        return None, None
    return max(candidates, key=lambda candidate: rp.version_key(candidate[0]))


class UnknownMergeOrder(Exception):
    """A listed PR's merge commit isn't on the fetched main, so its place in the order is unknown."""


def main_history_order():
    """{merge commit sha: position} along main's first-parent history, oldest first.

    Fetches main first, so every PR already listed as merged has its commit here.
    """
    subprocess.run(["git", "fetch", "--quiet", "origin", "main"], check=True)
    output = subprocess.run(
        ["git", "rev-list", "--first-parent", "--reverse", "FETCH_HEAD"], check=True, capture_output=True, text=True
    ).stdout
    return {sha: position for position, sha in enumerate(output.split())}


def tag_contains(tag, sha):
    """Whether the commit is the tag's commit or one of its ancestors."""
    result = subprocess.run(["git", "merge-base", "--is-ancestor", sha, tag], capture_output=True)
    return result.returncode == 0


def author_of(pr):
    """The PR author's login: listed PRs carry "author", a PR fetched on its own carries "user"."""
    return pr.get("author") or (pr.get("user") or {}).get("login")


def owed(pr, released, in_cutoff):
    return (
        bool(pr.get("merged_at"))
        and SKIP_MARKER not in (pr.get("title") or "")
        and author_of(pr) != DEPENDABOT
        and pr["number"] not in released
        and not in_cutoff(pr.get("merge_commit_sha") or "")
    )


def queue(pulls, released, in_cutoff, has_cutoff, trigger=None, trigger_pull=None, main_order=None):
    """The PR numbers owed a release, oldest merge first.

    Order comes from each merge commit's position on main (main_order), never from
    merged_at: that has one-second resolution, so two merges in the same second would
    tie. main is fetched after the PRs are listed, so every one of them should be
    there; if one isn't, raise rather than guess its place.
    """
    main_order = main_order or {}
    by_number = {pr["number"]: pr for pr in pulls}
    if trigger is not None and trigger not in by_number and trigger_pull is not None:
        by_number[trigger] = trigger_pull
    if not has_cutoff:
        # A first release: don't sweep up history, just release what triggered the run.
        by_number = {trigger: by_number[trigger]} if trigger in by_number else {}
    pending = [pr for pr in by_number.values() if owed(pr, released, in_cutoff)]
    missing = [pr["number"] for pr in pending if pr.get("merge_commit_sha") not in main_order]
    if missing:
        numbers = ", ".join(f"#{n}" for n in missing)
        raise UnknownMergeOrder(f"merge commits of {numbers} aren't on the fetched main; retry the run")
    return [pr["number"] for pr in sorted(pending, key=lambda pr: main_order[pr["merge_commit_sha"]])]


def main(argv=None, gh=None, contains=tag_contains, main_order=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--pr", type=int, help="the PR that triggered this run")
    args = parser.parse_args(argv)

    gh = gh or GitHub(args.repo)
    releases = gh.releases()
    released = {n for n in (rp.source_pr_of(r) for r in releases) if n is not None}
    cutoff_tag, cutoff_pr = cutoff_release(releases)

    pulls = gh.merged_pulls(since=gh.pull(cutoff_pr)["merged_at"]) if cutoff_tag else []
    trigger_pull = None
    if args.pr is not None and all(pr["number"] != args.pr for pr in pulls):
        fetched = gh.pull(args.pr)
        # A manual run can name any PR; only one merged into main can be owed a release.
        if (fetched.get("base") or {}).get("ref") == "main":
            trigger_pull = fetched

    result = queue(
        pulls,
        released,
        in_cutoff=lambda sha: bool(cutoff_tag) and bool(sha) and contains(cutoff_tag, sha),
        has_cutoff=bool(cutoff_tag),
        trigger=args.pr,
        trigger_pull=trigger_pull,
        # Fetched only now, after the PRs are listed, so each listed merge is on it.
        main_order=main_history_order() if main_order is None else main_order,
    )
    # stdout carries only the JSON the workflow reads; the explanation goes to stderr.
    cutoff = f"{cutoff_tag} (PR #{cutoff_pr})" if cutoff_tag else "none"
    print(f"Newest published Release: {cutoff}. Queue: {result or 'empty'}.", file=sys.stderr)
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    main()
