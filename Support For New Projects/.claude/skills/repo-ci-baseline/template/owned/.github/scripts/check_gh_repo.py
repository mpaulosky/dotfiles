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
ASSIGNMENT_WORD = (r"""[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}"'`]*\}"""
                   r"""|[^ \t"';&|()]*)[ \t]+""")
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


# A program that runs a command without the caller's GH_REPO (sudo resets the environment, ssh and su start a new one).
WRAPPER = re.compile(r"(?<![A-Za-z0-9_.-])(sudo|doas|su|runuser|pkexec|ssh)(?![A-Za-z0-9_.-])")
ENV = re.compile(r"(?<![A-Za-z0-9_.-])env(?![A-Za-z0-9_.-])")


def command_words(before):
    """The part of before that belongs to gh's own command: what follows the last ; & or | outside quotes."""
    start = quote = 0
    index = 0
    while index < len(before):
        char = before[index]
        if char == "\\" and quote != "'":
            index += 1
        elif quote:
            quote = 0 if char == quote else quote
        elif char in "'\"":
            quote = char
        elif char in ";&|\n":
            start = index + 1
        index += 1
    return before[start:]


def env_drops_gh_repo(words):
    """Whether the options of the env command whose words follow (env -i, -u GH_REPO, -S) lose GH_REPO."""
    words = words.split()
    index = 0
    while index < len(words):
        word = words[index]
        index += 1
        if word == "--":
            return False
        if word in ("-", "--ignore-environment") or word.startswith(("--split-string", "--unset=GH_REPO")):
            return True
        if word == "--unset":
            if words[index:index + 1] == ["GH_REPO"]:
                return True
            index += 1
        elif word.startswith("--"):
            # A long option; --chdir takes the next word as its argument.
            if word == "--chdir":
                index += 1
        elif word.startswith("-"):
            for position, flag in enumerate(word[1:], 1):
                if flag in "iS":
                    return True
                if flag in "uC":
                    attached = word[position + 1:]
                    argument = attached or (words[index] if index < len(words) else "")
                    if flag == "u" and argument.strip("'\"") == "GH_REPO":
                        return True
                    if not attached:
                        index += 1
                    break
        elif not re.match(r"[A-Za-z_][A-Za-z0-9_]*=", word):
            return False
    return False


def wrapped(before):
    """Whether gh, after before on its line, runs behind a wrapper that drops the GH_REPO an earlier export set."""
    words = command_words(before)
    return WRAPPER.search(words) is not None or any(
        env_drops_gh_repo(words[env.end():]) for env in ENV.finditer(words))


def told(before, after, exported, earlier=""):
    """Whether the gh between before and after is told its repository.

    earlier is the text of the backslash-continued lines before this one: a wrapper or an assignment may have
    started on them, and bash reads them as one line.
    """
    before = earlier + before
    exported = exported and not wrapped(before)
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


# A shell operator, longest first: a redirection (with <<, <<-, <<< and &> before their shorter forms) or a separator.
OPERATOR = re.compile(r"<<<|<<-?|<&|<>|<|>>|>&|>\||>|&>>|&>|&&|\|\||;;|;|&|\|")
REDIRECTIONS = ("<<<", "<<", "<<-", "<&", "<>", "<", ">>", ">&", ">|", ">", "&>>", "&>")
# The redirections that write to their target.
WRITES = ("<>", ">>", ">&", ">|", ">", "&>>", "&>")
# The commands whose heredoc is data, never code: they print it, store it, or ignore it.
DATA_COMMANDS = ("cat", "tee", "echo", "printf", "read", "mail", "mailx", ":", "true")
# The files a data command may write to: text, not something a later command runs.
DATA_SUFFIXES = ("txt", "md", "json", "yml", "yaml", "log", "out", "csv", "tsv", "toml", "ini", "conf", "cfg", "html",
                 "xml", "env", "patch", "diff")
# Words before a command that aren't it.
BEFORE_COMMAND = ("{", "!", "if", "then", "else", "elif", "while", "until", "do", "time")
ASSIGNMENT_START = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\+?=")


def tokens(text):
    """The words and operators of one logical line of shell as (kind, text, quoted) tuples, quotes and comments understood.

    kind is 'word' (text is the word without its quotes, quoted whether it had any), 'op' (a redirection or separator,
    or a parenthesis or backtick), 'open' for a $( and 'close' for the ) that ends it. A << inside a quote, a comment
    or (( )) is no operator. The word right before a redirection that is all digits (2>&1) is its file descriptor, dropped.
    """
    found = []
    word = None
    quoted = False
    double = False
    frames = []
    index = 0

    def flush():
        nonlocal word, quoted
        if word is not None:
            found.append(("word", "".join(word), quoted))
        word, quoted = None, False

    while index < len(text):
        char = text[index]
        if double:
            if char == "\\":
                word.append(text[index + 1:index + 2])
                index += 2
            elif char == '"':
                double = False
                index += 1
            elif text.startswith("$(", index) and not text.startswith("$((", index):
                flush()
                found.append(("open", "$(", False))
                frames.append(["double", 1])
                double = False
                index += 2
            else:
                word.append(char)
                index += 1
        elif char in " \t":
            flush()
            index += 1
        elif char == "\\":
            word = (word or []) + [text[index + 1:index + 2]]
            quoted = True
            index += 2
        elif char == "'":
            end = text.find("'", index + 1)
            end = len(text) if end < 0 else end
            word = (word or []) + [text[index + 1:end]]
            quoted = True
            index = end + 1
        elif char == '"':
            word = word or []
            quoted = double = True
            index += 1
        elif char == "#" and word is None:
            break
        elif text.startswith("((", index) or text.startswith("$((", index):
            # Arithmetic: its << is a shift, not a heredoc.
            depth, index = 0, text.index("(", index)
            while index < len(text):
                depth += (text[index] == "(") - (text[index] == ")")
                index += 1
                if depth == 0:
                    break
            word = (word or []) + ["0"]
        elif text.startswith("$(", index):
            flush()
            found.append(("open", "$(", False))
            frames.append(["normal", 1])
            index += 2
        elif char in "()":
            flush()
            if char == ")" and frames and frames[-1][1] == 1:
                double = frames.pop()[0] == "double"
                found.append(("close", ")", False))
                word, quoted = ([], True) if double else (None, False)
            else:
                if frames:
                    frames[-1][1] += 1 if char == "(" else -1
                found.append(("op", char, False))
            index += 1
        elif char == "`":
            flush()
            found.append(("op", char, False))
            index += 1
        elif operator := OPERATOR.match(text, index):
            descriptor = word is not None and not quoted and "".join(word).isdigit() and operator.group()[0] in "<>"
            if descriptor:
                word = None
            flush()
            found.append(("op", operator.group(), False))
            index = operator.end()
        else:
            word = (word or []) + [char]
            index += 1
    flush()
    return found


def heredoc_header(text):
    """The heredocs of one logical line as (delimiter, tabs, quoted), and whether the line feeds its data to a program.

    A body is data only when every command on the line is one that treats its input as data (cat, tee, echo,
    printf, read, mail, :, true), each file they write is text, and the line doesn't end in a pipe, whose
    consumer comes after the body. Any other command, a shell or an interpreter or an assignment-prefixed . among
    them, may run the body, so its body is read as code.
    """
    heredocs = []
    data = True
    redirect = None
    segment = []
    segments = []
    found = tokens(text)
    for kind, value, quoted in found + [("op", ";", False)]:
        if kind == "word" and redirect:
            if redirect in ("<<", "<<-"):
                heredocs.append((value, redirect == "<<-", quoted))
            elif redirect in WRITES:
                data = data and (value.isdigit() or value == "-" or value.startswith("/dev/")
                                 or value.rsplit("/", 1)[-1].rpartition(".")[2].lower() in DATA_SUFFIXES)
            redirect = None
        elif kind == "word":
            segment.append(value)
        elif kind == "op" and value in REDIRECTIONS:
            redirect = value
        else:
            segments.append(segment)
            segment = []
    for words in segments:
        while words and (words[0] in BEFORE_COMMAND or ASSIGNMENT_START.match(words[0])):
            words = words[1:]
        if words:
            command = words[0].rsplit("/", 1)[-1]
            data = data and command in DATA_COMMANDS
            if command == "tee":
                data = data and all(word.startswith("-") or word.rsplit("/", 1)[-1].rpartition(".")[2].lower()
                                    in DATA_SUFFIXES or word.startswith("/dev/") for word in words[1:])
    return heredocs, data and found[-1:] != [("op", "|", False)]


def data_heredocs(header, later):
    """The (delimiter, tabs, quoted) of each heredoc on the logical line header whose body is data, not code, in the order the bodies follow.

    An unquoted delimiter still lets bash run the $(...) and backticks in a data body. A heredoc whose delimiter never
    comes again is no heredoc.
    """
    heredocs, data = heredoc_header(header)
    if not data:
        return []
    return [(delimiter, tabs, quoted) for delimiter, tabs, quoted in heredocs
            if any((text.lstrip("\t") if tabs else text) == delimiter for text in later)]


def logical_line(lines, number):
    """The logical line that starts at lines[number - 1], with its backslash continuations joined, and how many physical lines it takes."""
    text = lines[number - 1]
    count = 1
    # An odd number of trailing backslashes continues the line; an even number is escaped backslashes.
    while (len(text) - len(text.rstrip("\\"))) % 2 and number - 1 + count < len(lines):
        text = text[:-1] + lines[number - 1 + count]
        count += 1
    return text, count


def continued_text(lines, number):
    """The text of the physical lines right before lines[number - 1] that a trailing backslash joins to it, backslashes removed."""
    text = ""
    index = number - 2
    while index >= 0 and (len(lines[index]) - len(lines[index].rstrip("\\"))) % 2:
        text = lines[index][:-1] + text
        index -= 1
    return text


def close_parenthesis(line, start, depth):
    """The index in line at or after start where the substitution of the given depth ends, or len(line), and the depth left."""
    end = start
    while end < len(line) and depth:
        depth += (line[end] == "(") - (line[end] == ")")
        end += 1
    return (end - 1 if depth == 0 else end), depth


def substitutions(line, pending=None):
    """The commands bash runs in line's $(...) and backticks, as (texts, pending).

    A substitution still open at the line's end (pending: ('(', depth) or ('`',)) goes on in the next line: pass
    pending back in, and the start of that line up to the close is its text.
    """
    found = []
    position = 0
    if pending:
        if pending[0] == "(":
            end, depth = close_parenthesis(line, 0, pending[1])
            pending = ("(", depth) if depth else None
        else:
            end = 0
            while end < len(line) and line[end] != "`":
                end += 2 if line[end] == "\\" else 1
            pending = None if end < len(line) else pending
        found.append(line[:end])
        if pending:
            return found, pending
        position = end + 1
    while position < len(line):
        if line[position] == "\\":
            position += 2
        elif line.startswith("$(", position):
            end, depth = close_parenthesis(line, position + 2, 1)
            found.append(line[position + 2:end])
            pending = pending or (("(", depth) if depth else None)
            position += 2
        elif line[position] == "`":
            end = position + 1
            while end < len(line) and line[end] != "`":
                end += 2 if line[end] == "\\" else 1
            found.append(line[position + 1:end])
            if end >= len(line):
                pending = pending or ("`",)
            position = end + 1
        else:
            position += 1
    return found, pending


class Line(str):
    """A line of a file as bash reads it, NULs removed; .original is the line as written."""

    original = ""


def read_lines(path):
    """The lines of path as bash sees them: bash drops a NUL byte, so the file is read with its NULs removed."""
    data = Path(path).read_bytes()
    # Not splitlines(), which also breaks at characters bash doesn't.
    lines = []
    for written in data.decode("utf-8", errors="surrogateescape").split("\n"):
        line = Line(written.replace("\0", "").removesuffix("\r"))
        line.original = written.removesuffix("\r")
        lines.append(line)
    return lines


def for_log(text):
    """The text with its control characters escaped (\\r, \\n, \\x1b...), tab kept.

    A line or a file name comes from the PR. A raw \\r or \\n in it printed to the Actions log would let the rest of it
    start a workflow command (::error::, ::stop-commands::).
    """
    return "".join(char if char == "\t" or char.isprintable() else char.encode("unicode_escape").decode("ascii")
                   for char in text)


def shown(line):
    # The line as written (a NUL at its ends is no use to the reader); surrogateescape keeps a byte that isn't UTF-8,
    # printed as the replacement character. Control characters are escaped, so the line can't start a log command.
    line = getattr(line, "original", line).strip("\0")
    return for_log(line.encode("utf-8", errors="surrogateescape").decode("utf-8", errors="replace"))


def untold(path):
    """Each line of path with a gh command not told its repository, as file:line: text."""
    lines = read_lines(path)
    found = []
    exported = False
    bodies = []
    # The first line of the bodies, the last line of the command that opens them, and a substitution a body leaves open.
    body_start = header_end = 0
    pending = None
    for number, line in enumerate(lines, 1):
        if bodies and number >= body_start:
            delimiter, tabs, quoted = bodies[0]
            if (line.lstrip("\t") if tabs else line) == delimiter:
                bodies.pop(0)
                pending = None
            else:
                codes, pending = substitutions(line, pending) if not quoted else ([], None)
                if not OPT_OUT.search(line) and any(
                        not told(code[:match.start()], code[match.end():], exported)
                        for code in codes for match in GH.finditer(code)):
                    found.append(f"{for_log(str(path))}:{number}: {shown(line)}")
            continue
        if re.match(r"[ \t]*#", line):
            continue
        if not bodies and number > header_end:
            header, count = logical_line(lines, number)
            header_end = number + count - 1
            body_start = header_end + 1
            bodies = data_heredocs(header, lines[header_end:])
        if EXPORTS.match(line):
            exported = True
        elif UNSET.search(line) or any(
                not PREFIX_OF_GH.match(line, assignment.start()) for assignment in ASSIGNMENT.finditer(line)):
            exported = False
        if OPT_OUT.search(line):
            continue
        earlier = continued_text(lines, number)
        if any(not told(line[:match.start()], line[match.end():], exported, earlier) for match in GH.finditer(line)):
            found.append(f"{for_log(str(path))}:{number}: {shown(line)}")
    return found


# Repo-relative paths --repo skips (the Owned Baseline files); a trailing / is a folder.
OWNED = (
    "scripts/gate.sh",
    "scripts/check-branch-name.sh",
    "scripts/check-pr-title.sh",
    "scripts/check-git-hooks.sh",
    "scripts/review.sh",
    "scripts/sync-copilot-review.sh",
    "scripts/watch-pr.sh",
    "scripts/tests/check-branch-name.test.sh",
    "scripts/tests/check-pr-title.test.sh",
    "scripts/tests/check-git-hooks.test.sh",
    "scripts/tests/sync-copilot-review.test.sh",
    "scripts/tests/watch-pr.test.sh",
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


# An indented code block's line: four spaces or a tab. A list item's marker line, which its indented lines belong to.
INDENTED = re.compile(r" {4}|\t")
LIST_ITEM = re.compile(r"[ \t]{0,3}(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)")
# A <pre> block opens at the start of a line (not <prefix>) and ends at the line with </pre>; <code> is one line's span.
PRE_OPEN = re.compile(r"[ \t]*<pre(?=[ \t>/]|$)", re.IGNORECASE)
PRE_CLOSE = re.compile(r"</pre\s*>", re.IGNORECASE)
CODE_ELEMENT = re.compile(r"<code(?:[ \t][^>]*)?>(.*?)</code\s*>", re.IGNORECASE)
HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>")


def code_in(line):
    """The code of a line that holds some inside prose: its inline code spans and <code> elements, bare gh named out."""
    spans = list(code_spans(line)) + [match.group(1) for match in CODE_ELEMENT.finditer(line)]
    # A span that is only gh names the tool in prose.
    return [span for span in spans if span.strip() not in ("gh", "gh.exe")]


def untold_markdown(path):
    """Each line of the Markdown file path with a gh command in code not told its repository.

    Code is a fenced block, an indented block (after a blank line, outside a list item), a <pre> block, an inline
    span and a <code> element on one line.
    """
    lines = read_lines(path)
    found = []
    fence = None
    pre = indented = in_list = False
    previous_blank = True
    for number, line in enumerate(lines, 1):
        # A fence in a blockquote or a list item: judge it, and its lines, without the markers.
        container = CONTAINER.match(line)
        inside = line[container.end():] if container else line
        opening = FENCE.match(inside)
        blank = not line.strip()
        after_blank, previous_blank = previous_blank, blank
        if fence:
            if opening and opening.group(1)[0] == fence[0] and len(opening.group(1)) >= len(fence) \
                    and not opening.group(2).strip():
                fence = None
                continue
            code = [inside]
        elif pre:
            end = PRE_CLOSE.search(line)
            pre = end is None
            code = [HTML_TAG.sub("", line[:end.start()] if end else line)]
        elif indented and (blank or INDENTED.match(line)):
            code = [line]
        elif not blank and INDENTED.match(line) and after_blank and not in_list:
            indented = True
            code = [line]
        else:
            indented = False
            if not blank and LIST_ITEM.match(line):
                in_list = True
            elif not blank and not line[:1].isspace():
                in_list = False
            if opening and not (opening.group(1)[0] == "`" and "`" in opening.group(2)):
                fence = opening.group(1)
                continue
            if PRE_OPEN.match(inside):
                end = PRE_CLOSE.search(inside)
                pre = end is None
                code = [HTML_TAG.sub("", inside[:end.start()] if end else inside)]
            else:
                code = code_in(line)
        if not OPT_OUT.search(line) and any(untold_in_code(piece) for piece in code):
            found.append(f"{for_log(str(path))}:{number}: {shown(line)}")
    return found


def kind(path, extensionless_is_shell=False):
    """'markdown', 'shell' or None for a file --repo doesn't check.

    An extensionless file is shell when it has a shell shebang, or always when extensionless_is_shell (under scripts/
    and .github/ci/, where `bash name` runs it whatever its first line says).
    """
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".md":
        return "markdown"
    if suffix in (".sh", ".bash", ".zsh"):
        return "shell"
    if suffix:
        return None
    if extensionless_is_shell:
        return "shell"
    with path.open("rb") as file:
        return "shell" if SHEBANG.match(file.readline(256)) else None


def walk(directory, root, seen):
    """The files under directory as (path, refusal): a symlink out of root or dangling is refused, not read.

    A symlink whose target is inside root is walked as what it points at. seen holds the folders already walked.
    """
    resolved = directory.resolve()
    if resolved in seen:
        return
    seen.add(resolved)
    for entry in sorted(directory.iterdir()):
        if entry.name in SKIPPED_PARTS:
            continue
        if entry.is_symlink():
            try:
                target = entry.resolve()
            except (OSError, RuntimeError):
                # Python 3.12 raises RuntimeError for a link that points at itself or at a cycle of links.
                yield entry, "a symlink to nothing"
                continue
            if not target.exists():
                yield entry, "a symlink to nothing"
                continue
            if not target.is_relative_to(root):
                yield entry, "a symlink to a target outside the repo"
                continue
        if entry.is_dir():
            yield from walk(entry, root, seen)
        elif entry.is_file():
            yield entry, None


def check_repo(root):
    """Each untold gh command in the repo at root, as relative-path:line: text, and each symlink it can't read."""
    root = Path(root)
    base = root.resolve()
    found = []
    done = set()
    for folder in SCOPE:
        top = root / folder
        if top.is_symlink() and not top.exists():
            found.append(f"{folder}: a symlink to nothing")
            continue
        if top.is_symlink() and not top.resolve().is_relative_to(base):
            found.append(f"{folder}: a symlink to a target outside the repo")
            continue
        if not top.is_dir():
            continue
        for path, refusal in walk(top, base, set()):
            if refusal:
                found.append(f"{for_log(path.relative_to(root).as_posix())}: {refusal}")
                continue
            # A file is judged by where it really is: a symlink reaching it first (or a folder walked once, through
            # a link) doesn't hide it, and a link's own path doesn't make it Owned.
            real = path.resolve().relative_to(base).as_posix()
            if is_owned(path.relative_to(root).as_posix()) and is_owned(real):
                continue
            checked = kind(path, folder != ".claude/skills")
            if checked is None or (real, checked) in done:
                continue
            done.add((real, checked))
            lines = untold_markdown(path) if checked == "markdown" else untold(path)
            shown_path = for_log(str(path))
            found.extend(for_log(real) + line[len(shown_path):] for line in lines)
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
