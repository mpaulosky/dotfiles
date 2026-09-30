#!/usr/bin/env python3
"""Print the body to publish a draft Release with, or fail if the draft names another PR.

Called by .github/workflows/release.yml when the tag it reserved already has a
draft Release:

    python3 .github/scripts/draft_release.py --pr 42 --notes-file notes.txt < draft-body.txt

A draft doesn't count as released anywhere in the workflow, so the release job
publishes it rather than leave the PR owed forever. The planner and the
ordering guard know a Release by its "Source PR: #n" marker, so:

- a draft whose markers all name this PR, including one on a line of its own,
  is published as it is;
- a draft with no marker, or one only inside a longer line, gets the release
  notes appended, which adds a line of its own;
- a draft naming any other PR is inconsistent, since publishing it would give
  the Release two sources. That exits 1, with the error on stderr, for a
  person to sort out.

Markers count anywhere in a line, the same pattern release_post.source_pr_of()
uses, so every parser agrees on which PRs a body names.

Standard library only, like release_post.py.
"""

import argparse
import re
import sys

SOURCE_PR = re.compile(r"Source PR: #(\d+)")


class OtherPrError(Exception):
    """The draft names a PR other than the one being released."""


def named_prs(body):
    """Every PR number a "Source PR: #n" marker in the body names, in order."""
    return [int(number) for number in SOURCE_PR.findall(body or "")]


def publish_body(body, pr_number, notes):
    """The body to publish the draft with. Raises OtherPrError if it names another PR."""
    body = body or ""
    others = [number for number in named_prs(body) if number != pr_number]
    if others:
        raise OtherPrError(f"names PR #{others[0]}, not #{pr_number}")
    own_line = re.compile(rf"^[ \t]*Source PR: #{pr_number}[ \t]*\r?$", re.MULTILINE)
    if own_line.search(body):
        return body
    return f"{body}\n\n{notes}\n" if body else f"{notes}\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pr", type=int, required=True, help="the PR being released")
    parser.add_argument("--notes-file", required=True, help="the release notes to append")
    parser.add_argument("--tag", default="the draft", help="the tag, for the error message")
    args = parser.parse_args(argv)
    with open(args.notes_file, encoding="utf-8") as notes_file:
        notes = notes_file.read().rstrip("\n")
    try:
        sys.stdout.write(publish_body(sys.stdin.read(), args.pr, notes))
    except OtherPrError as error:
        print(f"::error::The draft Release {args.tag} {error}. Fix or delete the draft, then re-run.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
