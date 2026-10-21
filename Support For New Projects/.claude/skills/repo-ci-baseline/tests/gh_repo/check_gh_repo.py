"""Checks that every gh command in the Template's Owned scripts is told its
repository (mpaulosky/dotfiles#267).

A gh command reaches gh's default repository unless it's told which one, and in
a clone whose only remote is a fork that's the fork. A Baseline repo's gate
(auth0-management-app's .github/ci/gate-checks.sh) refuses such commands, and it
can't edit the Owned files that hold one, so the Template keeps its own to the
same rule:

- a script exports GH_REPO at the top level (in column 0, so not inside an if
  or a function), alone on its line but for a comment, before its first gh
  command, or writes GH_REPO=<value> as the prefix of the gh command itself. A
  later unset GH_REPO, or an assignment that isn't such an export or prefix,
  ends the export, and a prefix is judged even after one;
- the value is literal, or a variable written ${NAME:?}, which stops the script
  when it's empty, since gh ignores an empty GH_REPO. GITHUB_REPOSITORY is set
  only in Actions, so a script that also runs locally falls back to a remote
  first (references/gotchas.md has the lines) and guards the result;
- gh repo's subcommands don't read GH_REPO, so each takes the repository as its
  first argument, the same literal or ${NAME:?}. view and edit have no -R. list,
  create, clone, gitignore and license name their own or need none, and rename,
  deploy-key and autolink read GH_REPO like any other gh command;
- gh is called by name, with its subcommand written out on the same line;
  redirections before it (gh 2>/dev/null repo view) are looked past. A gh
  followed by an expansion ("$@", $sub, a wrapper's body) or a backslash
  continuation hides a subcommand that may be repo view, which ignores
  GH_REPO, so it's refused even after an export. A gh that ends its command,
  or a quoted word ("$work/bin/gh"), counts once the script has exported
  GH_REPO; anything else after it ({repo,} view, a list's ", ") is refused.

Whole-line comments are skipped, and so are binary files (with a NUL byte).
Bash doesn't care about encoding, so any other file is read whatever bytes it
holds.
Lines end only at a newline, as bash's do (an optional \r before it is
dropped), so a form feed or U+2028 can't put an export at the start of a line
bash never sees.

    python3 check_gh_repo.py <dir>...

Prints each untold command as file:line: text and exits 1 when there's one, or
2 when a root isn't a directory, so a moved scripts/ can't pass unchecked.
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
# A redirection, with its target: 2>/dev/null, >"$log", &>/dev/null, <<EOF.
REDIRECTION = re.compile(r"[ \t]*[0-9]*(&>>?|>>|>&|>\||<<<|<<-?|<&|<>|>|<)[ \t]*[^ \t;&|()]*")
# What ends a command after a bare gh.
ENDS = re.compile(r"[ \t]*([;&|)`]|$)")
# A GH_REPO= prefix right before gh, whatever its value.
PREFIX = re.compile(r"(^|[^A-Za-z0-9_])GH_REPO=[^ \t]*[ \t]+$")
ASSIGNMENT = re.compile(r"(?<![A-Za-z0-9_])GH_REPO=")
PREFIX_OF_GH = re.compile(r"GH_REPO=" + VALUE + r"[ \t]+gh(?![A-Za-z0-9_.-])")
UNSET = re.compile(r"(?<![A-Za-z0-9_])unset[ \t][^;&|]*(?<![A-Za-z0-9_])GH_REPO(?![A-Za-z0-9_])")
REPO = re.compile(r"repo([^A-Za-z0-9_-]|$)")
NAMES_ITS_OWN = re.compile(r"repo[ \t]+(list|create|clone|gitignore|license)\b")
READS_GH_REPO = re.compile(r"repo[ \t]+(rename|deploy-key|autolink)\b")
# gh repo <subcommand>, then a value that isn't a flag: its repository when
# it's owner/repo or ${NAME:?}.
NAMED = re.compile(r"repo[ \t]+[a-z-]+[ \t]+(?!-)" + VALUE)


def told(before, after, exported):
    """Whether the gh between before and after is told its repository."""
    # gh closing a quoted word: judge what follows the quote.
    if after[:1] in ("\"", "'"):
        after = after[1:]
    if HIDDEN.match(after):
        return False
    while redirection := REDIRECTION.match(after):
        after = after[redirection.end():]
    subcommand = SUBCOMMAND.match(after)
    if subcommand is None:
        return exported and ENDS.match(after) is not None
    rest = after[subcommand.end():]
    if REPO.match(rest) and not READS_GH_REPO.match(rest):
        named = NAMED.match(rest)
        repository = named.group(1) if named else ""
        return bool(NAMES_ITS_OWN.match(rest)) or "/" in repository or "${" in repository
    if PREFIX.search(before):
        return TOLD.search(before) is not None
    return exported


def untold(path):
    """Each line of path with a gh command not told its repository, as file:line: text."""
    data = Path(path).read_bytes()
    if b"\0" in data:
        return []
    # Not splitlines(), which also breaks at characters bash doesn't.
    text = data.decode("utf-8", errors="surrogateescape")
    found = []
    exported = False
    for number, line in enumerate((line.removesuffix("\r") for line in text.split("\n")), 1):
        if re.match(r"[ \t]*#", line):
            continue
        if EXPORTS.match(line):
            exported = True
        elif UNSET.search(line) or any(
                not PREFIX_OF_GH.match(line, assignment.start()) for assignment in ASSIGNMENT.finditer(line)):
            exported = False
        if any(not told(line[:match.start()], line[match.end():], exported) for match in GH.finditer(line)):
            # surrogateescape keeps a byte that isn't UTF-8; print it as the replacement character.
            shown = line.encode("utf-8", errors="surrogateescape").decode("utf-8", errors="replace")
            found.append(f"{path}:{number}: {shown}")
    return found


def main(argv):
    found = []
    for root in argv:
        if not Path(root).is_dir():
            print(f"check_gh_repo.py: {root} isn't a directory", file=sys.stderr)
            return 2
        for path in sorted(p for p in Path(root).rglob("*") if p.is_file()):
            found.extend(untold(path))
    if found:
        print("\n".join(found))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
