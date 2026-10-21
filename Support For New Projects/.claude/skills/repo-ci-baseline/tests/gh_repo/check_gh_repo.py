"""Checks that every gh command in the Template's Owned scripts is told its
repository (mpaulosky/dotfiles#267).

A gh command reaches gh's default repository unless it's told which one, and in
a clone whose only remote is a fork that's the fork. A Baseline repo's gate
(auth0-management-app's .github/ci/gate-checks.sh) refuses such commands, and it
can't edit the Owned files that hold one, so the Template keeps its own to the
same rule:

- a script exports GH_REPO at the top level (in column 0, so not inside an if
  or a function), alone on its line but for a comment, before its first gh
  command, or writes GH_REPO=<value> as the prefix of the gh command itself;
- the value is literal, or a variable written ${NAME:?}, which stops the script
  when it's empty: gh ignores an empty GH_REPO, and GITHUB_REPOSITORY, say, is
  set only in Actions;
- gh repo's subcommands don't read GH_REPO, so each takes the repository as its
  first argument, the same literal or ${NAME:?}. view and edit have no -R. list,
  create, clone, gitignore and license name their own or need none, and rename,
  deploy-key and autolink read GH_REPO like any other gh command;
- gh is called by name, with its subcommand written out on the same line: a gh
  whose subcommand comes from a variable ("$@", a wrapper) or the next line
  hides it, so it counts only once the script has exported GH_REPO, and a
  backslash continuation never does.

Whole-line comments are skipped, and so are files that aren't UTF-8 text.

    python3 check_gh_repo.py <dir>...

Prints each untold command as file:line: text and exits 1 when there's one.
"""

import re
import sys
from pathlib import Path

# A value that's never empty: literal (quoted or bare, with no expansion), or
# ${NAME:?...}, which stops the script when NAME is empty.
VALUE = (r"""("[^"$` \t]+"|'[^' \t]+'|[^ \t`"'$;&|,()<>]+"""
         r"""|"?\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}"'`]*\}"?)""")
EXPORTS = re.compile(r"^export GH_REPO=" + VALUE + r"[ \t]*(;[ \t]*)?(#.*)?$")
TOLD = re.compile(r"(^|[^A-Za-z0-9_])GH_REPO=" + VALUE + r"[ \t]+$")
# gh as a word: not part of gh_, neigh or gh.exe.
GH = re.compile(r"(?<![A-Za-z0-9_.-])gh(?![A-Za-z0-9_.-])")
# Its subcommand, written out.
SUBCOMMAND = re.compile(r"[ \t]+(?=[a-z-])")
CONTINUED = re.compile(r"[ \t]*\\$")
REPO = re.compile(r"repo([^A-Za-z0-9_-]|$)")
NAMES_ITS_OWN = re.compile(r"repo[ \t]+(list|create|clone|gitignore|license)\b")
READS_GH_REPO = re.compile(r"repo[ \t]+(rename|deploy-key|autolink)\b")
# gh repo <subcommand>, then a value that isn't a flag: its repository when
# it's owner/repo or ${NAME:?}.
NAMED = re.compile(r"repo[ \t]+[a-z-]+[ \t]+(?!-)" + VALUE)


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
        for match in GH.finditer(line):
            before, after = line[:match.start()], line[match.end():]
            subcommand = SUBCOMMAND.match(after)
            rest = after[subcommand.end():] if subcommand else ""
            if not subcommand:
                told = exported and not CONTINUED.match(after)
            elif REPO.match(rest) and not READS_GH_REPO.match(rest):
                named = NAMED.match(rest)
                repository = named.group(1) if named else ""
                told = NAMES_ITS_OWN.match(rest) or "/" in repository or "${" in repository
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
