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
  when it's empty, since gh ignores an empty GH_REPO. GITHUB_REPOSITORY is set
  only in Actions, so a script that also runs locally falls back to a remote
  first (references/gotchas.md has the lines) and guards the result;
- gh repo's subcommands don't read GH_REPO, so each takes the repository as its
  first argument, the same literal or ${NAME:?}. view and edit have no -R. list,
  create, clone, gitignore and license name their own or need none, and rename,
  deploy-key and autolink read GH_REPO like any other gh command;
- gh is called by name, with its subcommand written out on the same line. A gh
  followed by an expansion ("$@", $sub, a wrapper's body) or a backslash
  continuation hides a subcommand that may be repo view, which ignores
  GH_REPO, so it's refused even after an export. A bare gh (command -v gh)
  counts once the script has exported GH_REPO.

Whole-line comments are skipped, and so are files that aren't UTF-8 text.
Lines end only at a newline, as bash's do (an optional \r before it is
dropped), so a form feed or U+2028 can't put an export at the start of a line
bash never sees.

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
# A backslash continuation, or a word gh's subcommand could come from.
HIDDEN = re.compile(r"""[ \t]*(\\$|["'`$])""")
REPO = re.compile(r"repo([^A-Za-z0-9_-]|$)")
NAMES_ITS_OWN = re.compile(r"repo[ \t]+(list|create|clone|gitignore|license)\b")
READS_GH_REPO = re.compile(r"repo[ \t]+(rename|deploy-key|autolink)\b")
# gh repo <subcommand>, then a value that isn't a flag: its repository when
# it's owner/repo or ${NAME:?}.
NAMED = re.compile(r"repo[ \t]+[a-z-]+[ \t]+(?!-)" + VALUE)


def untold(path):
    """Each line of path with a gh command not told its repository, as file:line: text."""
    try:
        # Not splitlines(), which also breaks at characters bash doesn't.
        lines = [line.removesuffix("\r") for line in Path(path).read_text(encoding="utf-8").split("\n")]
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
                told = exported and not HIDDEN.match(after)
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
