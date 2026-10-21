"""Checks that every gh command in the Template's Owned scripts is told its
repository (mpaulosky/dotfiles#267).

A gh command reaches gh's default repository unless it's told which one, and in
a clone whose only remote is a fork that's the fork. A Baseline repo's gate
(auth0-management-app's .github/ci/gate-checks.sh) refuses such commands, and it
can't edit the Owned files that hold one, so the Template keeps its own to the
same rule:

- a script exports GH_REPO, alone on its line but for a comment, with a value
  that isn't empty, before its first gh command, or writes GH_REPO=<value> as
  the prefix of the gh command itself;
- gh repo's subcommands don't read GH_REPO, so each takes the repository as its
  first argument (or -R, --repo), except list, create and clone, which name
  their own;
- a gh command stays on one line: a line that ends in gh, or continues it with
  a backslash, hides its command, unless the script has exported GH_REPO
  (command -v gh).

Whole-line comments are skipped, and so are files that aren't UTF-8 text.

    python3 check_gh_repo.py <dir>...

Prints each untold command as file:line: text and exits 1 when there's one.
"""

import re
import sys
from pathlib import Path

# A value gh receives: quoted and not empty, or bare up to the next blank.
VALUE = r"""("[^" \t]+"|'[^' \t]+'|[^ \t`"';&|,()<>]+)"""
EXPORTS = re.compile(r"^[ \t]*export GH_REPO=" + VALUE + r"[ \t]*(;[ \t]*)?(#.*)?$")
TOLD = re.compile(r"(^|[^A-Za-z0-9_])GH_REPO=" + VALUE + r"[ \t]+$")
COMMAND = re.compile(r"(?<![A-Za-z0-9_.-])gh[ \t]+(?=[a-z-])")
HIDDEN = re.compile(r"(?<![A-Za-z0-9_.-])gh[ \t]*\\$")
BARE = re.compile(r"(?<![A-Za-z0-9_.-])gh[ \t]*$")
REPO = re.compile(r"repo([^A-Za-z0-9_-]|$)")
NAMES_ITS_OWN = re.compile(r"repo[ \t]+(list|create|clone)\b")
# gh repo <subcommand>, then its repository: o/r (bare or quoted), a variable,
# or -R and --repo.
NAMED = re.compile(r"""repo[ \t]+[a-z-]+[ \t]+(["']?[^- \t<>`"'$&|;(][^ \t`<>&|;"']*/|"?\$|-R[ =]|--repo[ =])""")


def untold(path):
    """Each line of path with a gh command not told its repository, as file:line: text."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return []
    found = []
    exported = False
    for number, line in enumerate(lines, 1):
        if re.match(r"[ \t]*#", line):
            continue
        if EXPORTS.match(line):
            exported = True
        if HIDDEN.search(line) or (not exported and BARE.search(line)):
            found.append(f"{path}:{number}: {line}")
            continue
        for match in COMMAND.finditer(line):
            before, rest = line[:match.start()], line[match.end():]
            if REPO.match(rest):
                told = NAMES_ITS_OWN.match(rest) or NAMED.match(rest)
            else:
                told = exported or TOLD.search(before)
            if not told:
                found.append(f"{path}:{number}: {line}")
                break
    return found


def main(argv):
    found = []
    for root in argv:
        for path in sorted(p for p in Path(root).rglob("*") if p.is_file()):
            found.extend(untold(path))
    if found:
        print("\n".join(found))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
