"""Checks that every gh command in the Template's Owned scripts and a repo's own scripts and skills is told its repository; the rules are in references/gotchas.md."""

import os
import re
import sys
from pathlib import Path

# A value that's never empty: literal (quoted or bare, with no expansion), or
# ${NAME:?...}, which stops the script when NAME is empty.
VALUE = (r"""("[^"$` \t]+"|'[^' \t]+'|[^ \t`"'$;&|,()<>]+"""
         r"""|"?\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}"'`]*\}"?)""")
EXPORTS = re.compile(r"^export GH_REPO=" + VALUE + r"[ \t]*(;[ \t]*)?(#.*)?$")
# gh or gh.exe as a word: not part of gh_, neigh or gh.executable, nor a folder in a path (~/.config/gh/hosts.yml).
GH_WORD = r"gh(?:\.exe)?(?![A-Za-z0-9_.-]|/)"
GH = re.compile(r"(?<![A-Za-z0-9_.-])" + GH_WORD)
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
# A bare gh whose line ends in || or &&: a lookup (command -v gh ||) that goes on to its own next command.
LOOKUP_LIST = re.compile(r"[ \t]*(\|\||&&)[ \t]*")
# A NAME=value word before a command, with the whitespace after it.
ASSIGNMENT_WORD = r"""[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^ \t"';&|()]*)[ \t]+"""
# The run of such words right before gh.
PREFIX = re.compile(r"(?<![A-Za-z0-9_])(?:" + ASSIGNMENT_WORD + r")+$")
ASSIGNMENT = re.compile(r"(?<![A-Za-z0-9_])GH_REPO=")
PREFIX_OF_GH = re.compile(r"GH_REPO=" + VALUE + r"[ \t]+(?:" + ASSIGNMENT_WORD + r")*" + GH_WORD)
UNSET = re.compile(r"(?<![A-Za-z0-9_])unset[ \t][^;&|]*(?<![A-Za-z0-9_])GH_REPO(?![A-Za-z0-9_])")
REPO = re.compile(r"repo([^A-Za-z0-9_-]|$)")
NAMES_ITS_OWN = re.compile(r"repo[ \t]+(list|create|clone|gitignore|license)\b")
READS_GH_REPO = re.compile(r"repo[ \t]+(rename|deploy-key|autolink)\b")
# gh repo <subcommand>, then a value that isn't a flag: its repository when
# it's owner/repo or ${NAME:?}.
NAMED = re.compile(r"repo[ \t]+[a-z-]+[ \t]+(?!-)" + VALUE)


def prefix_repository(before):
    """The value of the last GH_REPO= among the NAME=value words right before gh, or None when there is none."""
    prefix = PREFIX.search(before)
    if prefix is None:
        return None
    repositories = [word.partition("=")[2].rstrip(" \t") for word in re.findall(ASSIGNMENT_WORD, prefix.group())
                    if word.startswith("GH_REPO=")]
    return repositories[-1] if repositories else None


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
        return LOOKUP_LIST.fullmatch(after) is not None or (exported and ENDS.match(after) is not None)
    rest = after[subcommand.end():]
    if REPO.match(rest) and not READS_GH_REPO.match(rest):
        named = NAMED.match(rest)
        repository = named.group(1) if named else ""
        return bool(NAMES_ITS_OWN.match(rest)) or "/" in repository or "${" in repository
    prefixed = prefix_repository(before)
    return exported if prefixed is None else re.fullmatch(VALUE, prefixed) is not None


# A heredoc operator and its delimiter: <<EOF, <<-'EOF', <<"EOF", <<\\EOF (not the here-string <<<).
HEREDOC = re.compile(r"""(?<!<)<<(-?)[ \t]*(?:"([^"]*)"|'([^']*)'|\\?([^ \t;&|()<>"'\\]+))""")
# A word that may run the heredoc's body as code: sh, bash, /bin/bash, dash, zsh, ksh, eval, source, or . (as in . /dev/stdin).
SHELL_WORD = re.compile(
    r"(?<![A-Za-z0-9_.-])((ba|da|z|k)?sh|eval|source)(?![A-Za-z0-9_.-])|(?:^|[;&|({])[ \t]*\.[ \t]")


def data_heredocs(line, later):
    """The (delimiter, tabs, quoted) of each heredoc on line whose body is data, not code, in the order the bodies follow.

    A line that names a shell anywhere (bash <<EOF, cat <<EOF | sh, eval, source) feeds its body to it, so its body is
    read as code. An unquoted delimiter still lets bash run the $(...) and backticks in a data body.
    A heredoc whose delimiter never comes again, or one inside (( )), is no heredoc.
    """
    if SHELL_WORD.search(line):
        return []
    found = []
    for match in HEREDOC.finditer(line):
        if line[:match.start()].count("((") > line[:match.start()].count("))"):
            continue
        delimiter = next(group for group in match.groups()[1:] if group is not None)
        quoted = match.group(4) is None or match.group(0).count("\\") > 0
        if not any((text.lstrip("\t") if match.group(1) else text) == delimiter for text in later):
            continue
        found.append((delimiter, bool(match.group(1)), quoted))
    return found


def substitutions(line):
    """The commands bash runs in line's $(...) and backticks: the text inside each, to the line's end when unclosed."""
    found = []
    position = 0
    while position < len(line):
        if line[position] == "\\":
            position += 2
        elif line.startswith("$(", position):
            depth, end = 1, position + 2
            while end < len(line) and depth:
                depth += (line[end] == "(") - (line[end] == ")")
                end += 1
            found.append(line[position + 2:end - 1 if depth == 0 else end])
            position += 2
        elif line[position] == "`":
            end = position + 1
            while end < len(line) and line[end] != "`":
                end += 2 if line[end] == "\\" else 1
            found.append(line[position + 1:end])
            position = end + 1
        else:
            position += 1
    return found


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
    bodies = []
    for number, line in enumerate(lines, 1):
        if bodies:
            delimiter, tabs, quoted = bodies[0]
            if (line.lstrip("\t") if tabs else line) == delimiter:
                bodies.pop(0)
            elif not quoted and not OPT_OUT.search(line) and any(
                    not told(code[:match.start()], code[match.end():], exported)
                    for code in substitutions(line) for match in GH.finditer(code)):
                found.append(f"{path}:{number}: {shown(line)}")
            continue
        if re.match(r"[ \t]*#", line):
            continue
        bodies = data_heredocs(line, lines[number:])
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
    ".claude/skills/hardening-review/",
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
            code = [span for span in code_spans(line) if span.strip() not in ("gh", "gh.exe")]
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
