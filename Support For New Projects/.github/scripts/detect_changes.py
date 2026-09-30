#!/usr/bin/env python3
"""Decide whether a pull request changes code, or only docs.

Called by the "Detect Changes" job in .github/workflows/ci.yml on a pull
request, from a full-history checkout of the PR merged into its base:

    python3 .github/scripts/detect_changes.py --base <base sha> --output "$GITHUB_OUTPUT"

It appends "code=true" or "code=false" to the output file. A PR is docs-only
when every changed path is under docs/ or ends in .md; the build, test matrix
and coverage are then skipped. Everything else counts as code, including
workflows, scripts and an empty diff, so an unexpected path runs the suite.

Diffing HEAD against the base the event names can also pick up commits that
reached main since, which only ever adds paths, so it errs toward building.
--no-renames lists a renamed file under both its paths, so moving code into
docs/ or to a .md name still counts as a code change.

Standard library only; git does the rest.
"""

import argparse
import subprocess
import sys


def is_doc(path):
    """Whether a changed path is documentation the build and tests don't read."""
    return path.startswith("docs/") or path.endswith(".md")


def changed_paths(base, head="HEAD", cwd=None):
    """Every path that differs between base and head, a rename under both its paths."""
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", base, head],
        cwd=cwd,
        check=True,
        capture_output=True,
    )
    # Decoded by hand: text=True would translate a "\r" in a file name to "\n".
    output = result.stdout.decode("utf-8", errors="surrogateescape")
    return [path for path in output.split("\0") if path]


def first_code_path(paths):
    """The first path that isn't docs, or None when every path is."""
    return next((path for path in paths if not is_doc(path)), None)


def for_log(path):
    """The path with its line breaks escaped. Git allows them in file names, and a
    raw one would let the rest of the name start a workflow command on the next
    log line (such as "::error::")."""
    return path.replace("\r", "\\r").replace("\n", "\\n")


def is_code_change(paths):
    """Whether the build and tests must run: any code path, or no paths at all."""
    return not paths or first_code_path(paths) is not None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True, help="the PR's base commit")
    parser.add_argument("--head", default="HEAD", help="the PR merged into its base")
    parser.add_argument("--output", required=True, help="the file to append code=true|false to")
    args = parser.parse_args(argv)

    paths = changed_paths(args.base, args.head)
    code = is_code_change(paths)
    if code and paths:
        print(f"Code change: {for_log(first_code_path(paths))}")
    elif not paths:
        print("No changed files; running the build and tests.")
    else:
        print(f"::notice::Docs-only change ({len(paths)} files); the build, tests and coverage are skipped.")

    with open(args.output, "a", encoding="utf-8") as output:
        output.write(f"code={'true' if code else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
