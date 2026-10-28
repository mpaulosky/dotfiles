"""Checks that every gh command in the Template's Owned scripts, and in a repo's
own scripts and skills, is told its repository (mpaulosky/dotfiles#267
and mpaulosky/dotfiles#321).

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

A line that is no gh command to run but names gh (command -v gh, echo "needs gh")
carries a comment saying so, # gh-repo: ok, and is skipped. A path such as
~/.config/gh/hosts.yml names no command either.

Whole-line comments are skipped, and so are binary files (with a NUL byte).
Bash doesn't care about encoding, so any other file is read whatever bytes it
holds.
Lines end only at a newline, as bash's do (an optional \r before it is
dropped), so a form feed or U+2028 can't put an export at the start of a line
bash never sees.

    python3 check_gh_repo.py <dir>...

Reads every file under each dir as a shell script. Prints each untold command
as file:line: text and exits 1 when there's one, or 2 when a root isn't a
directory, so a moved scripts/ can't pass unchecked.

    python3 check_gh_repo.py --repo <root>

The repo-wide check, which every repo's scripts/gate.sh runs
(mpaulosky/dotfiles#321). It walks scripts/, .github/ci/ and .claude/skills/
under root, skipping node_modules, .git, symlinks and the Owned Baseline files
(OWNED: the Template's Owned scripts and pre-push-review skill, which a repo
can't edit, and which test.sh checks in dotfiles). A .sh or .bash file, or one
with no extension and a sh or bash shebang, is checked as a script, with the
rules above; a .md file is checked as a skill; anything else is skipped. It
prints paths relative to root, and a hint on stderr when it finds any.

A skill's snippet stands alone, so there's no export. Only gh in code counts:
a fenced block's lines (a fence may sit in a blockquote or a list item; an
unclosed fence runs to the end of the file), and
inline code spans, but not a span that is only gh. Each gh command is told by
the GH_REPO=<value> prefix right before it, or by --repo <value>, --repo=<value>
or -R <value> after it on its line (not for gh api, which has no such flag).
gh repo's subcommands take the repository first, as in a script. A backslash
continuation or an expansion after gh, or a gh with no subcommand on its line,
is refused: a gh command stays on one line. <!-- gh-repo: ok --> on a line, or
# gh-repo: ok in a fenced block, skips it.
"""

import os
import re
import sys
from pathlib import Path

# A value that's never empty: literal (quoted or bare, with no expansion), or
# ${NAME:?...}, which stops the script when NAME is empty.
VALUE = (r"""("[^"$` \t]+"|'[^' \t]+'|[^ \t`"'$;&|,()<>]+"""
         r"""|"?\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}"'`]*\}"?)""")
EXPORTS = re.compile(r"^export GH_REPO=" + VALUE + r"[ \t]*(;[ \t]*)?(#.*)?$")
TOLD = re.compile(r"(^|[^A-Za-z0-9_])GH_REPO=" + VALUE + r"[ \t]+$")
# gh as a word: not part of gh_, neigh or gh.exe, nor a folder in a path (~/.config/gh/hosts.yml).
GH = re.compile(r"(?<![A-Za-z0-9_.-])gh(?![A-Za-z0-9_.-]|/)")
# A line that says its gh isn't a command to run (command -v gh, echo "needs gh"):
# # gh-repo: ok in a script, <!-- gh-repo: ok --> in a skill.
OPT_OUT = re.compile(r"(#|<!--)[ \t]*gh-repo:[ \t]*ok(?![A-Za-z0-9_-])")
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


def read_lines(path):
    """The lines of path as bash sees them, or None for a binary file."""
    data = Path(path).read_bytes()
    if b"\0" in data:
        return None
    # Not splitlines(), which also breaks at characters bash doesn't.
    text = data.decode("utf-8", errors="surrogateescape")
    return [line.removesuffix("\r") for line in text.split("\n")]


def shown(line):
    # surrogateescape keeps a byte that isn't UTF-8; print it as the replacement character.
    return line.encode("utf-8", errors="surrogateescape").decode("utf-8", errors="replace")


def untold(path):
    """Each line of path with a gh command not told its repository, as file:line: text."""
    lines = read_lines(path)
    if lines is None:
        return []
    found = []
    exported = False
    for number, line in enumerate(lines, 1):
        if re.match(r"[ \t]*#", line):
            continue
        if EXPORTS.match(line):
            exported = True
        elif UNSET.search(line) or any(
                not PREFIX_OF_GH.match(line, assignment.start()) for assignment in ASSIGNMENT.finditer(line)):
            exported = False
        if OPT_OUT.search(line):
            continue
        if any(not told(line[:match.start()], line[match.end():], exported) for match in GH.finditer(line)):
            found.append(f"{path}:{number}: {shown(line)}")
    return found


# Repo-relative paths --repo skips (the Owned Baseline files); a trailing / is a folder.
OWNED = (
    "scripts/gate.sh",
    "scripts/check-branch-name.sh",
    "scripts/check-pr-title.sh",
    "scripts/check-git-hooks.sh",
    "scripts/review.sh",
    "scripts/sync-copilot-review.sh",
    "scripts/tests/check-branch-name.test.sh",
    "scripts/tests/check-pr-title.test.sh",
    "scripts/tests/check-git-hooks.test.sh",
    "scripts/tests/sync-copilot-review.test.sh",
    ".claude/skills/pre-push-review/",
)
# The folders --repo walks.
SCOPE = ("scripts", ".github/ci", ".claude/skills")
SKIPPED_PARTS = ("node_modules", ".git")


def is_owned(relative):
    """Whether the repo-relative path is an Owned Baseline file --repo skips, as itself or under a folder entry."""
    return any(relative == entry or (entry.endswith("/") and relative.startswith(entry)) for entry in OWNED)

# A Markdown fence: three or more backticks or tildes (a backtick fence's info
# string has no backtick, or it's an inline span), then the rest of the line.
FENCE = re.compile(r"[ \t]*(`{3,}|~{3,})(.*)$")
# What can come before a fence on its line: blockquote markers and list markers, in any order.
CONTAINER = re.compile(r"(?:[ \t]*(?:>|(?:[-*+]|[0-9]{1,9}[.)])(?=[ \t])))+")
# What a fence's first line says when it's the shell: #!/bin/sh, #!/usr/bin/env bash.
SHEBANG = re.compile(rb"#![ \t]*(\S*/)?(env[ \t]+(-\S+[ \t]+)*)?(ba)?sh([ \t]|$)")
# A skill's gh command is told by a flag on its own line, unless it's gh api or gh repo.
FLAG = re.compile(r"(^|[ \t])(--repo[ \t]+|--repo=|-R[ \t]+)" + VALUE)
# What ends the words that belong to one gh command on a line.
COMMAND_END = re.compile(r";|&&|\|\|")
HAS_NO_FLAG = re.compile(r"(api|repo)([^A-Za-z0-9_-]|$)")


def code_spans(line):
    """The inline code spans of line: text between backtick runs of the same length."""
    position = 0
    while position < len(line):
        if line[position] != "`":
            position += 1
            continue
        opening = position
        while position < len(line) and line[position] == "`":
            position += 1
        length = position - opening
        search = position
        while search < len(line):
            if line[search] != "`":
                search += 1
                continue
            closing = search
            while search < len(line) and line[search] == "`":
                search += 1
            if search - closing == length:
                yield line[position:closing]
                position = search
                break


def untold_in_code(code):
    """Whether a piece of code has a gh command not told its repository."""
    for match in GH.finditer(code):
        after = code[match.end():]
        # Only this command's own words: up to the next gh or the end of its command.
        own = after[:min((end.start() for end in (GH.search(after), COMMAND_END.search(after)) if end),
                         default=len(after))]
        if told(code[:match.start()], own, False):
            continue
        subcommand = SUBCOMMAND.match(own)
        if subcommand and not HAS_NO_FLAG.match(own[subcommand.end():]) and FLAG.search(own):
            continue
        return True
    return False


def untold_markdown(path):
    """Each line of the Markdown file path with a gh command in code not told its repository."""
    lines = read_lines(path)
    if lines is None:
        return []
    found = []
    fence = None
    for number, line in enumerate(lines, 1):
        # A fence in a blockquote or a list item: judge it, and its lines, without the markers.
        container = CONTAINER.match(line)
        inside = line[container.end():] if container else line
        opening = FENCE.match(inside)
        if fence:
            if opening and opening.group(1)[0] == fence[0] and len(opening.group(1)) >= len(fence) \
                    and not opening.group(2).strip():
                fence = None
                continue
            code = [inside]
        elif opening and not (opening.group(1)[0] == "`" and "`" in opening.group(2)):
            fence = opening.group(1)
            continue
        else:
            # A span that is only gh names the tool in prose.
            code = [span for span in code_spans(line) if span.strip() != "gh"]
        if not OPT_OUT.search(line) and any(untold_in_code(piece) for piece in code):
            found.append(f"{path}:{number}: {shown(line)}")
    return found


def kind(path):
    """'markdown', 'shell' or None for a file --repo doesn't check."""
    path = Path(path)
    if path.suffix == ".md":
        return "markdown"
    if path.suffix in (".sh", ".bash"):
        return "shell"
    if path.suffix:
        return None
    with path.open("rb") as file:
        return "shell" if SHEBANG.match(file.readline(256)) else None


def check_repo(root):
    """Each untold gh command in the repo at root, as relative-path:line: text."""
    root = Path(root)
    found = []
    for folder in SCOPE:
        top = root / folder
        if top.is_symlink() or not top.is_dir():
            continue
        for directory, subdirectories, names in os.walk(top):
            subdirectories[:] = sorted(d for d in subdirectories
                                       if d not in SKIPPED_PARTS and not (Path(directory) / d).is_symlink())
            for name in sorted(names):
                path = Path(directory) / name
                relative = path.relative_to(root).as_posix()
                if path.is_symlink() or not path.is_file() or is_owned(relative):
                    continue
                checked = kind(path)
                if checked is None:
                    continue
                lines = untold_markdown(path) if checked == "markdown" else untold(path)
                found.extend(relative + line[len(str(path)):] for line in lines)
    return found


HINT = ("check_gh_repo.py: export GH_REPO before the first gh command in a script; in a skill write "
        "GH_REPO=owner/repo (or \"${repo:?}\") before each gh command, or give --repo; gh repo's subcommands "
        "take the repository first. See references/gotchas.md in mpaulosky/dotfiles' repo-ci-baseline skill.")


def main(argv):
    if argv[:1] == ["--repo"]:
        if len(argv) != 2 or argv[1] == "--repo":
            print("usage: check_gh_repo.py --repo <root> | <dir>...", file=sys.stderr)
            return 2
        if not Path(argv[1]).is_dir():
            print(f"check_gh_repo.py: {argv[1]} isn't a directory", file=sys.stderr)
            return 2
        found = check_repo(argv[1])
        if found:
            print("\n".join(found))
            print(HINT, file=sys.stderr)
        return 1 if found else 0
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
