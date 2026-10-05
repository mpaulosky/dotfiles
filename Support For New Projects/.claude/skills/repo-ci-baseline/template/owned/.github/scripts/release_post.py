#!/usr/bin/env python3
"""Write the release blog post for a merged PR and refresh the release tables.

Called by .github/workflows/release.yml once per release, and usable for any
past Release/PR pair:

    python3 .github/scripts/release_post.py --pr 28 --tag v0.0.32

It writes docs/blogs/{merged-date}-pr-{n}-{slug}.md, updates the
docs/blogs/README.md index, the RELEASES_START/END table in README.md (copied
to docs/README.md with its relative links rebased), and in the GitHub Pages
site docs/index.html the RELEASES_HTML releases table and the BLOGS_HTML blog
post cards.

GitHub data comes from the gh CLI (GH_TOKEN). When ANTHROPIC_API_KEY is set,
the post opens with a short summary written by Claude (model from
ANTHROPIC_MODEL). Any API failure only drops the summary; it never fails the
release. Standard library only, so no pip install is needed to run it.
"""

import argparse
import bisect
import datetime
import html
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

DEFAULT_MODEL = "claude-sonnet-5"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
API_TIMEOUT_SECONDS = 60
DIFF_LIMIT = 60_000
TABLE_SIZE = 10

# Dependency bumps get the deterministic sections only: a summary of a
# version bump adds nothing the title doesn't say.
NO_SUMMARY_AUTHORS = {"dependabot[bot]"}

AREAS = ["src/", "tests/", ".github/", ".sandcastle/", "docs/"]
OTHER_AREA = "other"

# Lock files are noise, and the rest are written by this script.
DIFF_EXCLUDED_NAMES = {"package-lock.json", "pnpm-lock.yaml"}
DIFF_EXCLUDED_PATHS = {"README.md", "docs/README.md"}
DIFF_EXCLUDED_PREFIXES = ("docs/blogs/",)


class GitHub:
    """The GitHub API calls the script needs, made through the gh CLI."""

    def __init__(self, repository):
        self.repository = repository

    def _api(self, path, jq=None):
        command = ["gh", "api", f"repos/{self.repository}/{path}", "--paginate"]
        if jq:
            command += ["--jq", jq]
        return subprocess.run(command, check=True, capture_output=True, text=True).stdout

    def _list(self, path, jq=".[] | @json"):
        return [json.loads(line) for line in self._api(path, jq).splitlines() if line.strip()]

    def pull(self, number):
        return json.loads(self._api(f"pulls/{number}"))

    def pull_title(self, number):
        return self._api(f"pulls/{number}", ".title").strip()

    def commits(self, number):
        return self._list(f"pulls/{number}/commits?per_page=100")

    def files(self, number):
        return self._list(f"pulls/{number}/files?per_page=100")

    def releases(self):
        return self._list("releases?per_page=100", ".[] | select(.draft | not) | @json")


def log(message):
    print(message, flush=True)


def slugify(title):
    slug = re.sub(r"[^a-z0-9]", "-", title.lower())
    return re.sub(r"-+", "-", slug).strip("-") or "pr-update"


def version_key(tag):
    version = re.match(r"v?(\d+)\.(\d+)\.(\d+)", tag or "")
    return tuple(int(p) for p in version.groups()) if version else (0, 0, 0)


# Post sections


def commit_subject(commit):
    message = (commit.get("commit") or {}).get("message") or ""
    return message.splitlines()[0].strip() if message.strip() else "(no message)"


def render_commits(commits):
    lines = ["## Commits", ""]
    if not commits:
        lines.append("No commits were found.")
    for commit in commits:
        lines.append(f"- {sanitize_inline(commit_subject(commit))} (`{commit.get('sha', '')[:7]}`)")
    return "\n".join(lines) + "\n"


def code_name(name):
    """A file name as inline code; one with a backtick or a risky character is written as <code> instead."""
    if re.fullmatch(r"[A-Za-z0-9._/@+=,~()-]+(?: [A-Za-z0-9._/@+=,~()-]+)*", name):
        return f"`{name}`"
    # A space at either end would be trimmed by a code span, so the name keeps it as <code>.
    return code_html(name, trim=False)


def area_of(path):
    return next((area for area in AREAS if path.startswith(area)), OTHER_AREA)


def render_files(files):
    groups = {}
    for file in files:
        groups.setdefault(area_of(file["filename"]), []).append(file)

    lines = ["## Files changed", ""]
    if not files:
        lines.append("No files were changed.")
    for area in AREAS + [OTHER_AREA]:
        if area not in groups:
            continue
        lines += [f"### {area}", ""]
        for file in sorted(groups[area], key=lambda f: f["filename"]):
            lines.append(f"- {code_name(file['filename'])} (+{file.get('additions', 0)} / -{file.get('deletions', 0)})")
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def is_excluded_from_diff(path):
    name = path.rsplit("/", 1)[-1]
    return (
        name in DIFF_EXCLUDED_NAMES
        or name.endswith(".lock")
        or path in DIFF_EXCLUDED_PATHS
        or path.startswith(DIFF_EXCLUDED_PREFIXES)
    )


def build_diff(files, limit=DIFF_LIMIT):
    """Rebuild a unified diff from the per-file patches the API returns."""
    parts = []
    for file in files:
        path = file["filename"]
        if is_excluded_from_diff(path):
            continue
        patch = file.get("patch") or "(no textual diff: binary or too large)"
        parts.append(f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{patch}\n")
    diff = "".join(parts)
    if len(diff) > limit:
        diff = diff[:limit] + f"\n[Diff truncated: showing the first {limit} of {len(diff)} characters.]\n"
    return diff


# AI summary


def build_prompt(pr, commits, diff):
    subjects = "\n".join(f"- {commit_subject(c)}" for c in commits) or "(none)"
    return (
        "Write a 3-5 sentence narrative summary of this merged pull request for a release blog post. "
        "Explain what changed and why, for a developer who uses the project. "
        "Answer with plain prose only: no heading, no lists, no preamble.\n\n"
        f"<title>{pr.get('title') or ''}</title>\n\n"
        f"<description>\n{pr.get('body') or '(none)'}\n</description>\n\n"
        f"<commits>\n{subjects}\n</commits>\n\n"
        f"<diff>\n{diff or '(empty)'}\n</diff>\n"
    )


def request_summary(api_key, model, prompt, urlopen=urllib.request.urlopen):
    """Return Claude's summary, or None after logging a warning. Never raises."""
    request = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(
            {"model": model, "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]}
        ).encode("utf-8"),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=API_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
        text = "".join(
            block.get("text", "") for block in payload.get("content", []) if block.get("type") == "text"
        ).strip()
    except Exception as error:  # noqa: BLE001 - any failure only drops the summary
        log(f"::warning::AI summary request failed ({type(error).__name__}: {error}); writing the post without it.")
        return None
    if not text:
        log("::warning::AI summary response had no text; writing the post without it.")
        return None
    return text


# Post file and blog index


ATX_HEADING = re.compile(r"^( {0,3})(#{1,6})(?=[ \t]|$)")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
SETEXT_UNDERLINE = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
THEMATIC_BREAK = re.compile(r"^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$")
INDENTED_CODE = re.compile(r"^( {4}|\t)")
# CommonMark's seven kinds of HTML block, as (start, end) pairs; the end is a
# pattern searched on each line, or HTML_ENDS_AT_BLANK. Their lines are raw
# HTML, so a "#" line inside one is text, not a heading.
HTML_ENDS_AT_BLANK = "blank line"
HTML_BLOCK_TAGS = (
    "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt"
    "|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li"
    "|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot"
    "|th|thead|title|tr|track|ul"
)
HTML_ATTRIBUTE = r"""\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?"""
HTML_BLOCKS = [
    (re.compile(r" {0,3}<(?:pre|script|style|textarea)(?:\s|>|$)", re.I | re.A), re.compile(r"</(?:pre|script|style|textarea)>", re.I | re.A)),
    (re.compile(r" {0,3}<!--", re.A), re.compile(r"-->", re.A)),
    (re.compile(r" {0,3}<\?", re.A), re.compile(r"\?>", re.A)),
    # Kind 4 needs an uppercase letter, as GitHub (cmark-gfm) reads it: "<!doctype" is text.
    (re.compile(r" {0,3}<![A-Z]", re.A), re.compile(r">", re.A)),
    (re.compile(r" {0,3}<!\[CDATA\[", re.A), re.compile(r"\]\]>", re.A)),
    (re.compile(rf" {{0,3}}</?(?:{HTML_BLOCK_TAGS})(?:\s|/?>|$)", re.I | re.A), HTML_ENDS_AT_BLANK),
]
# Kind 7: any other complete open or closing tag alone on its line. Unlike the
# others it can't interrupt a paragraph. All HTML patterns are re.ASCII: the
# tag grammar is ASCII, so a non-breaking space or "\u017f" (long s, which
# Unicode case-folds to "s") makes a line paragraph text, as GitHub reads it.
HTML_OTHER_TAG = re.compile(
    rf" {{0,3}}(?:<[A-Za-z][A-Za-z0-9-]*(?:{HTML_ATTRIBUTE})*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)\s*$",
    re.A,
)
# The level of the "## " post sections that nest_headings' text is inserted under.
SECTION_LEVEL = 2
QUOTE_MARKER = re.compile(r"^ {0,3}> ?")
LIST_MARKER = re.compile(r"^ {0,3}([-+*]|[0-9]{1,9}[.)])(?=[ \t]|$)")
# Position-anchored versions for scan_blocks, which matches containers at an
# offset into the line instead of slicing a new suffix for every level.
QUOTE_AT = re.compile(r" {0,3}> ?")
LIST_AT = re.compile(r" {0,3}([-+*]|[0-9]{1,9}[.)])(?=[ \t]|$)")
SPACES_AT = re.compile(r" *")


def closes_fence(fence, line):
    """Whether a line closes a fence opened by the marker run `fence`."""
    fence_match = FENCE.match(line)
    if not fence_match:
        return False
    marker, info = fence_match.groups()
    return marker[0] == fence[0] and len(marker) >= len(fence) and not info.strip()


def html_block_end(line, in_paragraph=False):
    """The end condition of an HTML block opened by this line, or None if it opens none.

    Kinds 1 to 5 end on the line matching their end pattern (possibly this
    one), kinds 6 and 7 at a blank line. Inside a paragraph, only kinds 1 to 6
    can start.
    """
    for start, end in HTML_BLOCKS:
        if start.match(line):
            return end
    if not in_paragraph and HTML_OTHER_TAG.match(line):
        return HTML_ENDS_AT_BLANK
    return None


def html_block_ends(end, line):
    """Whether an HTML block with this end condition ends on this (non-blank) line."""
    return end is not HTML_ENDS_AT_BLANK and bool(end.search(line))


def code_lines(lines):
    """Indexes of the lines that aren't Markdown text: fenced code and raw HTML blocks, at any depth.

    A fence closes on a run of the same character at least as long as the
    opener, with nothing but whitespace after it, or where its quote or list
    item ends; an HTML block closes as html_block_end() describes.
    """
    code = set()
    scan_blocks(list(lines), [], code)
    return code


def line_bounds(line):
    """(last non-space index, last index of a character a thematic break can't contain), -1 if none."""
    last_text = len(line.rstrip(" \t")) - 1
    last_other = last_text
    while last_other >= 0 and line[last_other] in " \t-*_":
        last_other -= 1
    return last_text, last_other


def list_width_at(line, pos, bounds):
    """The width of the list item marker and its spacing at `pos`, or None if none opens there.

    The content starts after the marker and 1 to 4 spaces; with more, or none
    at all, it starts one column after the marker. `bounds` is line_bounds(line),
    so ruling out a thematic break costs O(1) unless the rest of the line could
    be one.
    """
    marker = LIST_AT.match(line, pos)
    if not marker:
        return None
    last_text, last_other = bounds
    if last_other < pos and THEMATIC_BREAK.match(line[pos:]):
        return None
    end = marker.end()
    spaces = SPACES_AT.match(line, end).end() - end
    return end - pos + (spaces if last_text >= end and 1 <= spaces <= 4 else 1)


def list_item_width(line):
    """The content column of a list item opened by this line, or None if it opens none."""
    return list_width_at(line, 0, line_bounds(line))


def interrupts_paragraph(line):
    """Whether a line ends a paragraph in the same container by opening a new block.

    Only a non-empty list item interrupts, and an ordered one only when
    numbered 1. (A line that fails to continue a quote or list item is judged
    differently: there any list item opens a new block.)
    """
    width = list_item_width(line)
    return bool(
        ATX_HEADING.match(line)
        or FENCE.match(line)
        or THEMATIC_BREAK.match(line)
        or html_block_end(line, in_paragraph=True) is not None
        or QUOTE_MARKER.match(line)
        or (width is not None and line[width:].strip(" \t") and re.match(r" {0,3}([-+*]|1[.)])", line))
    )


def fence_content(raw, rest, block):
    """A fenced code line's text with the opener's indent removed, as CommonMark does.

    A top-level fence keeps the raw line, tabs and all; a nested one has its
    container markers stripped, from the tab-expanded line.
    """
    text = rest if block["nested"] else raw.removesuffix("\r")
    spaces = len(text) - len(text.lstrip(" "))
    return text[min(spaces, block["indent"]):]


def scan_blocks(lines, headings, code=None, blocks=None):
    """Finds the headings in Markdown lines, including those inside block quotes and list items.

    Appends (line index, prefix, level, rest of line) to `headings` for each
    ATX or setext heading, where the prefix is everything before the "#"s
    (container markers and indent). The later lines of a setext heading,
    including its underline, are set to None in `lines`. When `code` is a set,
    the indexes of fenced code and raw HTML block lines are added to it.
    When `blocks` is a list, each fenced code block is appended to it as
    {"kind": "fence", "lines", "content", "info", "nested"}, and each indented
    code line as {"kind": "indented", "lines", "content", "nested"}, where
    "nested" says whether a quote or list item holds it.

    This follows CommonMark's block parsing in one pass: each line first
    matches the open quotes and list items, may lazily continue an open
    paragraph, then opens new containers before its content is read. Columns
    are measured with tabs expanded to CommonMark's 4-column stops, and a
    blank line holds only spaces and tabs (a non-breaking space is text).
    """
    code = set() if code is None else code
    # Open containers, outermost first: {"kind": "quote"}, or
    # {"kind": "list", "width": content column, "has_content": bool}.
    # quote_levels holds the stack positions of the quotes, so a blank line,
    # which keeps every list item open, finds the first quote it ends in O(1).
    stack = []
    quote_levels = []
    paragraph = None  # [(line index, container prefix, text)] of the open paragraph
    fence = None
    fence_block = None  # the open fence's entry in `blocks`
    html_end = None  # end condition of the open HTML block, see html_block_end()

    def mark_content():
        if stack and stack[-1]["kind"] == "list":
            stack[-1]["has_content"] = True

    for index, raw in enumerate(lines):
        # A trailing "\r" is the rest of a CRLF line ending; tabs expand so
        # columns can be counted in spaces from here on.
        line = raw.removesuffix("\r").expandtabs(4)
        bounds = line_bounds(line)
        last_text = bounds[0]
        offset = 0
        if last_text < 0:
            matched = quote_levels[0] if quote_levels else len(stack)
        else:
            matched = 0
            for container in stack:
                if container["kind"] == "quote":
                    marker = QUOTE_AT.match(line, offset)
                    if not marker:
                        break
                    offset = marker.end()
                elif last_text >= offset:
                    if SPACES_AT.match(line, offset).end() - offset < container["width"]:
                        break
                    offset += container["width"]
                matched += 1
        rest = line[offset:]

        if matched < len(stack):
            # A line that opens no new block lazily continues the open paragraph.
            # Here any list item or HTML block opens one: the rule that only
            # some of them can interrupt a paragraph applies only once every
            # container matched.
            opens_block = (
                interrupts_paragraph(rest) or list_item_width(rest) is not None or html_block_end(rest) is not None
            )
            if paragraph is not None and rest.strip(" ") and not opens_block:
                paragraph.append((index, line[:offset], rest))
                continue
            del stack[matched:]
            while quote_levels and quote_levels[-1] >= matched:
                quote_levels.pop()
            paragraph = fence = fence_block = html_end = None

        if html_end is HTML_ENDS_AT_BLANK and not rest.strip(" "):
            html_end = None  # the blank line ends the block and is read as usual
        if fence is not None or html_end is not None:
            code.add(index)
            if fence is not None:
                closed = closes_fence(fence, rest)
                if fence_block is not None:
                    fence_block["lines"].append(index)
                    if not closed:
                        fence_block["content"].append(fence_content(raw, rest, fence_block))
                fence = None if closed else fence
                fence_block = None if closed else fence_block
            elif html_block_ends(html_end, rest):
                html_end = None
            continue

        # Open new quotes and list items. A quote always interrupts a paragraph;
        # a list item only when interrupts_paragraph() says so.
        opened = len(stack)
        while SPACES_AT.match(line, offset).end() - offset < 4:  # indented code opens no container
            marker = QUOTE_AT.match(line, offset)
            width = None if marker else list_width_at(line, offset, bounds)
            if marker:
                mark_content()
                quote_levels.append(len(stack))
                stack.append({"kind": "quote"})
                offset = marker.end()
            elif width is not None and (paragraph is None or interrupts_paragraph(line[offset:])):
                mark_content()
                stack.append({"kind": "list", "width": width, "has_content": last_text >= offset + width})
                offset += width
            else:
                break
            paragraph = None
        rest = line[offset:]

        if not rest.strip(" "):
            paragraph = None
            # An item that starts empty ends at its first blank line (not at its own marker line).
            if len(stack) == opened and stack and stack[-1]["kind"] == "list" and not stack[-1]["has_content"]:
                stack.pop()
            continue
        mark_content()

        fence_match = FENCE.match(rest)
        html_start = None if fence_match else html_block_end(rest, in_paragraph=paragraph is not None)
        if fence_match or html_start is not None:
            code.add(index)
            if fence_match:
                fence = fence_match.group(1)
                if blocks is not None:
                    fence_block = {
                        "kind": "fence",
                        "lines": [index],
                        "content": [],
                        "info": fence_match.group(2),
                        "indent": len(rest) - len(rest.lstrip(" ")),
                        "nested": bool(stack),
                    }
                    blocks.append(fence_block)
            elif not html_block_ends(html_start, rest):
                html_end = html_start
            paragraph = None
            continue
        heading = ATX_HEADING.match(rest)
        if heading:
            headings.append((index, line[:offset] + heading.group(1), len(heading.group(2)), rest[heading.end():]))
            paragraph = None
            continue
        if paragraph is not None:
            underline = SETEXT_UNDERLINE.match(rest)
            if underline:
                first, first_prefix, _ = paragraph[0]
                text = " ".join(part.strip(" ") for _, _, part in paragraph)
                headings.append((first, first_prefix, 1 if underline.group(1)[0] == "=" else 2, " " + text))
                for later, _, _ in paragraph[1:]:
                    lines[later] = None
                lines[index] = None
                paragraph = None
            elif THEMATIC_BREAK.match(rest):
                paragraph = None
            else:
                paragraph.append((index, line[:offset], rest))
            continue
        if INDENTED_CODE.match(rest):
            if blocks is not None:
                blocks.append({"kind": "indented", "lines": [index], "content": [rest[4:]], "nested": bool(stack)})
            continue
        if THEMATIC_BREAK.match(rest):
            continue
        paragraph = [(index, line[:offset], rest)]


# Untrusted Markdown. A PR's title, description and commits, and the AI
# summary of them, are written into docs/blogs and published by GitHub Pages
# (Jekyll, with kramdown), so none of them may carry live HTML, a script link,
# a kramdown attribute list or Liquid. Code keeps its text: a code block is
# re-emitted as a fence both parsers read the same way, and a code span holding
# anything that's escaped elsewhere becomes <code> with every symbol as an
# entity. From mpaulosky/dotfiles#48.

SAFE_SCHEMES = {"http", "https", "mailto"}
SCHEME = re.compile(r"([a-z][a-z0-9+.\-]*):")
# Besides letters and digits, what a scheme can be written with: its own
# symbols, the colon, entities (&#9; &colon;) and backslash escapes.
SCHEME_TEXT = set("+.-:&#;\\")
# Only these autolinks keep their angle brackets; any other "<" is escaped.
AUTOLINK = re.compile(r"<(?:https?://|mailto:)[^\s<>\"'`\\]*>", re.I)
LINK_DESTINATION_START = re.compile(r"\]\(|\]:")
# A footnote definition's start: its label has no brackets, backslashes or spaces.
FOOTNOTE_DEFINITION = re.compile(r"[ \t>]*\[\^[^\[\]\\\s]+\]:")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
CONTAINER_MARKER = re.compile(r"[ \t]*(?:>|(?:[-+*]|[0-9]{1,9}[.)])(?=[ \t]|$))")
BACKTICKS = re.compile(r"`+")
# Characters that make a code span unsafe to leave between backticks: a parser
# that pairs the backticks differently would read them as HTML, an attribute
# list, Liquid or a link.
CODE_SPAN_RISK = re.compile(r"[<{\]]")


DECIMAL_ZEROS = re.compile(r"&#0+(?=[0-9])")
HEX_ZEROS = re.compile(r"&#([xX])0+(?=[0-9a-fA-F])")
# Past 8 digits no reference names a character: the largest is &#1114111; (&#x10FFFF;).
OVERSIZED_REFERENCE = re.compile(r"&#(?:[xX][0-9a-fA-F]{9,}|[0-9]{9,});?")


def safe_unescape(text):
    """html.unescape that can't raise on untrusted text.

    Python refuses to convert more than 4300 digits, so html.unescape raises
    on "&#000...9;". Leading zeros don't change a reference's value, so they
    go first, and a reference still too long for any character becomes
    U+FFFD, as html.unescape makes any out-of-range one.
    """
    text = HEX_ZEROS.sub(r"&#\1", DECIMAL_ZEROS.sub("&#", text))
    return html.unescape(OVERSIZED_REFERENCE.sub("\ufffd", text))


def safe_destination(text, start):
    """Whether the link destination starting at text[start] has no scheme, or one in SAFE_SCHEMES.

    Browsers drop control characters and whitespace from a URL and decode
    entities, so "java&#9;script:" is still a javascript: link. The whole
    destination's scheme is read however long it is: padding ("j&#9;&#9;...
    avascript:", or an entity's leading zeros) can push it arbitrarily far
    from the start. The read stops at the first character that can't be part
    of a scheme, an entity or an escape, so it never runs into the next "](".
    """
    end = start
    while end < len(text) and (text[end].isalnum() or text[end] in SCHEME_TEXT):
        end += 1
    candidate = safe_unescape(text[start:end]).replace("\\", "")
    candidate = "".join(char for char in candidate if char > " " and char != "\x7f").lower()
    scheme = SCHEME.match(candidate)
    return not scheme or scheme.group(1) in SAFE_SCHEMES


def neutralize_links(text):
    """The text with a "#" in front of each link destination whose scheme isn't safe.

    Any "](" or "]:" counts, wherever it is, since a parser may read a link or
    reference definition where this one wouldn't; the destination may follow
    on the next line, after its quote markers. A "#" makes it a harmless
    fragment link. A footnote definition ("[^1]: text", alone at the start of
    its line) isn't a link; anything else ending in "]:", such as a label
    holding an escaped "\\[^", is read as one.
    """
    out = []
    done = 0
    for match in LINK_DESTINATION_START.finditer(text):
        if match.group() == "]:":
            line_start = text.rfind("\n", 0, match.start()) + 1
            if FOOTNOTE_DEFINITION.fullmatch(text, line_start, match.end()):
                continue
        start = match.end()
        while start < len(text) and text[start] in " \t\n>":
            start += 1
        if start < len(text) and text[start] == "<":
            start += 1
        if start >= done and not safe_destination(text, start):
            out.append(text[done:start] + "#")
            done = start
    return "".join(out) + text[done:]


def odd_backslashes_before(text, pos):
    count = 0
    while pos - count > 0 and text[pos - count - 1] == "\\":
        count += 1
    return count % 2 == 1


def code_html(content, trim=True):
    """A code span's text as <code>, every character but letters, digits and spaces as an entity.

    trim strips one space from each end, as CommonMark does for a code span;
    a file name, which isn't one, keeps them.
    """
    if trim and len(content) > 1 and content.startswith(" ") and content.endswith(" ") and content.strip(" "):
        content = content[1:-1]  # CommonMark strips one space from each side
    return "<code>" + "".join(char if char.isalnum() or char == " " else f"&#{ord(char)};" for char in content) + "</code>"


def escape_text(text, liquid):
    """Escape the HTML, attribute lists and (with liquid) Liquid in text outside code spans."""
    out = []
    pos = 0
    while pos < len(text):
        char = text[pos]
        if char == "<" and not odd_backslashes_before(text, pos):
            autolink = AUTOLINK.match(text, pos)
            if autolink:
                out.append(autolink.group())
                pos = autolink.end()
                continue
            out.append("&lt;")
        elif char == "{" and (liquid or text.startswith("{:", pos)):  # even after a backslash: parsers differ
            out.append("&#123;")
        else:
            out.append(char)
        pos += 1
    return "".join(out)


def escape_fence_marker(line):
    """The line with its first backtick or tilde escaped when it could open a fence.

    A real fence was re-emitted already, so this one only looked like one
    where it sat (in an HTML block, say).
    """
    pos = 0
    while True:
        marker = CONTAINER_MARKER.match(line, pos)
        if not marker or marker.end() == pos:
            break
        pos = marker.end()
    rest = line[pos:].lstrip(" \t")
    if rest.startswith(("```", "~~~")):
        cut = len(line) - len(rest)
        line = line[:cut] + "\\" + line[cut:]
    return line


def sanitize_spans(text, liquid=False):
    """Untrusted Markdown text (no code blocks) made safe, with code spans paired as CommonMark pairs them.

    A span holding anything risky becomes <code>; one that crossed a line
    break has it as a space, as CommonMark renders it.
    """
    out = []
    done = 0
    for start, end, content in code_spans(text):
        out.append(escape_text(text[done:start], liquid))
        out.append(code_html(content.replace("\n", " ")) if CODE_SPAN_RISK.search(content) else text[start:end])
        done = end
    out.append(escape_text(text[done:], liquid))
    return "".join(out)


# A line holding only spaces, tabs or a CR (the README is split on "\n" alone, so a CRLF line keeps its "\r").
BLANK_LINE = re.compile(r"\n[ \t\r]*(?:\n|$)")


def code_spans(text):
    """Each code span in text, as (start, end, content), with backtick runs paired as CommonMark pairs them.

    A run opens a span only where a later run of the same length closes it; a
    backslash escapes a run's first backtick. A span may cross line breaks,
    but not a blank line, which ends the paragraph. Runs and blank lines are
    indexed once, so a text full of unmatched runs still takes linear time.
    """
    runs = [(match.start(), len(match.group())) for match in BACKTICKS.finditer(text)]
    starts_by_length = {}
    for start, length in runs:
        starts_by_length.setdefault(length, []).append(start)
    blanks = [match.start() for match in BLANK_LINE.finditer(text)]
    search = 0
    for start, length in runs:
        if start < search:
            continue
        if odd_backslashes_before(text, start):
            start, length = start + 1, length - 1
            if not length:
                continue
        after = start + length
        blank = bisect.bisect_left(blanks, after)
        paragraph_end = blanks[blank] if blank < len(blanks) else len(text)
        candidates = starts_by_length.get(length, [])
        index = bisect.bisect_left(candidates, after)
        if index < len(candidates) and candidates[index] < paragraph_end:
            closer = candidates[index]
            yield start, closer + length, text[after:closer]
            search = closer + length


def link_label(markdown):
    """Sanitized Markdown made safe as a link's text: brackets outside code spans become entities.

    A title's "]" would otherwise close the label early, so "fix: ](https://x)"
    would make the row link somewhere else. A code span keeps its text: one
    holding "]" is already <code> with entities.
    """
    out = []
    done = 0
    for start, end, _ in [*code_spans(markdown), (len(markdown), len(markdown), "")]:
        out.append(markdown[done:start].replace("[", "&#91;").replace("]", "&#93;") + markdown[start:end])
        done = end
    return "".join(out)


def sanitize_inline(text, liquid=False):
    """A single line of untrusted text, such as a PR title or commit subject, made safe to publish."""
    return sanitize_spans(escape_fence_marker(neutralize_links(HTML_COMMENT.sub("", text))), liquid)


def sanitize_text(lines):
    """Untrusted Markdown text lines (no code blocks), made safe; HTML comments are dropped."""
    text = neutralize_links(HTML_COMMENT.sub("", "\n".join(lines)))
    return sanitize_spans("\n".join(escape_fence_marker(line) for line in text.split("\n"))).split("\n")


def code_fence(content, info):
    """A fenced code block both CommonMark and kramdown read the same way, with blank lines around it.

    The fence is longer than any backtick run in the code, so no line inside
    closes it, and it always has an info string, so it can't close a fence
    left open before it.
    """
    longest = max((len(run) for line in content for run in BACKTICKS.findall(line)), default=0)
    fence = "`" * max(3, longest + 1)
    word = re.match(r"[A-Za-z0-9_+#.-]+", info.strip())
    return ["", fence + (word.group() if word else "text"), *content, fence, ""]


def sanitize_markdown(markdown):
    """Untrusted Markdown, such as a PR description, made safe to publish on GitHub Pages.

    Every code block, nested or not, becomes a top-level fence (a block in a
    list or quote moves out of it); everything else is text for sanitize_text.
    """
    lines = re.split(r"\r\n|\r|\n", markdown)
    blocks = []
    scan_blocks(list(lines), [], blocks=blocks)
    # Indented code lines separated only by blank lines are one block.
    merged = []
    for block in blocks:
        last = merged[-1] if merged else None
        if (
            block["kind"] == "indented"
            and last is not None
            and last["kind"] == "indented"
            and all(not lines[i].strip(" \t") for i in range(last["lines"][-1] + 1, block["lines"][0]))
        ):
            gap = block["lines"][0] - last["lines"][-1] - 1
            last["content"] += [""] * gap + block["content"]
            last["lines"].append(block["lines"][-1])
        else:
            merged.append(dict(block, info=block.get("info", "")))
    starts = {block["lines"][0]: block for block in merged}

    out = []
    text = []
    index = 0
    while index < len(lines):
        block = starts.get(index)
        if block is None:
            text.append(lines[index])
            index += 1
            continue
        out += sanitize_text(text)
        text = []
        out += code_fence(block["content"], block["info"])
        index = block["lines"][-1] + 1
    out += sanitize_text(text)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip("\n")


def break_liquid_raw(text):
    """Text that can sit inside {% raw %}: each "{%" that would read as {% endraw %} is printed by Liquid instead."""
    return re.sub(r"\{%(?=-?\s*endraw)", "{% endraw %}{{ '{%' }}{% raw %}", text)


def nest_headings(markdown):
    """Re-levels the ATX headings in text inserted under a "## " section.

    Distinct levels keep their order but close up (#, ####, ###### become
    ###, ####, #####), and no heading sits more than one level below the one
    before it, so the post keeps a single H1 and never skips a level. Setext
    headings (a paragraph over a === or --- line, by CommonMark's paragraph
    rules) become ATX headings first. Headings inside block quotes and list
    items are re-levelled too, keeping their markers. Fenced code and raw HTML
    blocks are left alone.
    """
    lines = re.split(r"\r\n|\r|\n", markdown)  # CommonMark's three line endings; PR bodies often use CRLF
    headings = []  # (line index, prefix, original level, rest of line), in document order
    scan_blocks(lines, headings)

    rank = {level: i for i, level in enumerate(sorted({level for _, _, level, _ in headings}))}
    previous = SECTION_LEVEL
    for index, prefix, level, rest in headings:
        new_level = min(SECTION_LEVEL + 1 + rank[level], previous + 1, 6)
        lines[index] = f"{prefix}{'#' * new_level}{rest}"
        previous = new_level
    return "\n".join(line for line in lines if line is not None)


def render_post(pr, title_line, tag, merged_date, commits, files, summary, model):
    number = pr["number"]
    # A YAML double-quoted scalar: escape backslashes before quotes.
    safe_title = title_line.replace("\\", "\\\\").replace('"', '\\"')
    ai_note = (
        "Generated by release automation from the PR title, description, commits and changed files. "
        + (f"Includes an AI summary written by {model}." if summary else "No AI summary.")
    )
    front_matter = "\n".join(
        [
            "---",
            f'post_title: "{safe_title}"',
            "author1: mpaulosky",
            f'post_slug: "{tag.lower()}-pr-{number}"',
            "microsoft_alias: n/a",
            "categories:",
            "  - engineering",
            "tags:",
            f"  - release:{tag.lower()}",
            "  - automation",
            f'ai_note: "{ai_note}"',
            f'summary: "Release notes seed for {tag} from PR #{number}."',
            f'post_date: "{merged_date}"',
            "---",
            "",
        ]
    )
    sections = [
        f"# {sanitize_inline(title_line)}\n\n"
        f"- **Release tag:** `{tag}`\n"
        f"- **Source PR:** [#{number}]({pr.get('html_url') or ''})\n"
    ]
    if summary:
        sections.append(f"## Summary\n\n{nest_headings(sanitize_markdown(summary))}\n")
    body = (pr.get("body") or "").strip() or "No PR description was provided."
    sections.append(f"## PR description\n\n{nest_headings(sanitize_markdown(body))}\n")
    sections.append(render_commits(commits))
    sections.append(render_files(files))
    # Jekyll runs Liquid over the page first, even inside code; raw keeps the
    # text as written. The tags sit in HTML comments, so neither GitHub's view
    # of the file nor the Pages site shows them.
    return front_matter + "<!-- {% raw %} -->\n" + break_liquid_raw("\n".join(sections)) + "\n<!-- {% endraw %} -->\n"


def update_blog_index(blog_dir, merged_date, title_line, post_name):
    blog_index = blog_dir / "README.md"
    existing = blog_index.read_text(encoding="utf-8") if blog_index.exists() else ""

    # Keep the post rows, skipping the header and its separator. Matching the
    # header's first cell exactly keeps posts whose title mentions "Date".
    rows = []
    for line in existing.splitlines():
        line = line.strip()
        if not (line.startswith("|") and line.endswith("|")):
            continue
        first_cell = line.strip("|").split("|")[0].strip()
        if first_cell == "Date" or set(first_cell) <= set("-: "):
            continue
        rows.append(line)

    # Drop this post's old row, and rows whose post was deleted (write_post
    # removes a PR's post when its title or merge date gives it a new name).
    def linked_post_exists(row):
        linked = re.search(r"\]\(([^)]+\.md)\)", row)
        return not linked or (blog_dir / linked.group(1)).exists()

    row_title = link_label(sanitize_inline(title_line, liquid=True)).replace("|", "\\|")
    rows = [r for r in rows if f"({post_name})" not in r and linked_post_exists(r)]
    rows.insert(0, f"| {merged_date} | [{row_title}]({post_name}) | release,automation |")

    def row_date(row):
        parts = [p.strip() for p in row.strip("|").split("|")]
        return parts[0] if parts else "0000-00-00"

    # Stable sort by date only, so same-day rows keep their merge order.
    rows = sorted(rows, key=row_date, reverse=True)

    blog_index.write_text(
        "\n".join(
            [
                "## Release review posts",
                "",
                "This directory contains concise release-review posts for merged PR releases.",
                "",
                "| Date | Title | Tags |",
                "| ---- | ----- | ---- |",
                *rows,
                "",
            ]
        ),
        encoding="utf-8",
    )


def read_blog_posts(blog_dir):
    posts = []
    for path in blog_dir.glob("*.md"):
        pr = re.search(r"-pr-(\d+)-", path.name)
        if not pr:
            continue
        text = path.read_text(encoding="utf-8")
        front = re.match(r"---\n(.*?)\n---", text, flags=re.DOTALL)
        front = front.group(1) if front else ""
        title = re.search(r'^post_title: "(.*)"$', front, flags=re.MULTILINE)
        date = re.search(r'^post_date: "(.*)"$', front, flags=re.MULTILINE)
        tag = re.search(r"^\s*- release:(\S+)$", front, flags=re.MULTILINE)
        summary = re.search(r'^summary: "(.*)"$', front, flags=re.MULTILINE)
        posts.append(
            {
                "file": path.name,
                "pr": pr.group(1),
                "title": title.group(1).replace('\\"', '"') if title else path.stem,
                "date": date.group(1) if date else path.name[:10],
                "tag": tag.group(1) if tag else "",
                "excerpt": post_excerpt(text, summary.group(1).replace('\\"', '"') if summary else ""),
            }
        )
    return posts


# Blog card excerpts

EXCERPT_LENGTH = 200
SEED_SUMMARY = re.compile(r"^Release notes seed for ")
# Paragraphs that only point at an issue ("Fixes #16.") say nothing on a card.
ISSUE_REFERENCE = re.compile(r"^(?:(?:fixes|closes|resolves|refs|part of)\s+#\d+[\s,.]*)+$", flags=re.IGNORECASE)


def post_excerpt(text, summary=""):
    """A card's excerpt: the AI summary section, a real front matter summary, else the PR description.

    render_post writes the AI summary into a "## Summary" section and a
    "Release notes seed" line into the front matter, so the seed line is skipped.
    """
    ai_summary = first_paragraph(section(text, "Summary"))
    if ai_summary:
        return shorten(ai_summary)
    if summary and not SEED_SUMMARY.match(summary):
        return shorten(plain_text(summary))
    description = first_paragraph(section(text, "PR description"))
    if description and description != "No PR description was provided.":
        return shorten(description)
    return ""


def section(text, heading):
    """The body of the post's "## {heading}" section, up to the next heading of the same level.

    Posts written before the title became an H1 start with a "## " title and
    use "### " for these sections. Only the post's own section level is read,
    and lines inside fenced code are never headings, so a heading from the PR
    description (nested, or in a code example) never passes for a section.
    """
    lines = text.split("\n")
    code = code_lines(lines)
    headings = [index for index, line in enumerate(lines) if index not in code and ATX_HEADING.match(line)]
    if not headings:
        return ""
    level = "##" if lines[headings[0]].startswith("# ") else "###"
    starts = [index for index in headings if lines[index].startswith(level + " ")]
    for position, start in enumerate(starts):
        if lines[start] == f"{level} {heading}":
            end = starts[position + 1] if position + 1 < len(starts) else len(lines)
            return "\n".join(lines[start + 1:end]) + ("\n" if end < len(lines) else "")
    return ""


def first_paragraph(markdown):
    """The first paragraph of prose or list text, as plain text."""
    for block in re.split(r"\n\s*\n", blank_code(markdown)):
        lines = [line.strip() for line in block.strip().splitlines()]
        # "&lt;" opens what was an HTML block before the post escaped it.
        if not lines or lines[0].startswith(("#", "|", "<!--", ">", "&lt;")):
            continue
        # Join list items and wrapped lines into one line of text.
        plain = plain_text(" ".join(re.sub(r"^(?:[-*+]|\d+[.)])(?:\s+|$)", "", line) for line in lines))
        if plain and not ISSUE_REFERENCE.match(plain):
            return plain
    return ""


def blank_code(markdown):
    """The Markdown with fenced code and raw HTML block lines blanked, so they split and skip like blank lines."""
    lines = markdown.split("\n")
    code = code_lines(lines)
    return "\n".join("" if index in code else line for index, line in enumerate(lines))


def plain_text(markdown):
    """Drop Markdown link, code and emphasis markup, keeping the words."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", markdown)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"(\*\*|\*)(\S(?:.*?\S)?)\1", r"\2", text)
    # Underscores only mark emphasis at word edges, so snake_case names keep theirs.
    text = re.sub(r"(?<!\w)(__|_)(\S(?:.*?\S)?)\1(?!\w)", r"\2", text)
    # What sanitize_markdown escaped reads as the text it stands for.
    text = re.sub(r"</?code>", "", text)
    text = safe_unescape(re.sub(r"\\([!-/:-@\[-`{-~])", r"\1", text))
    return re.sub(r"\s+", " ", text).strip()


def shorten(text, limit=EXCERPT_LENGTH):
    """Cut text to at most limit characters at a word boundary, marking the cut with an ellipsis."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:.-–—")
    return cut + "…"


def newest_first(items):
    # Same-day items are ordered by release version, which follows merge order.
    return sorted(items, key=lambda item: (item["date"], version_key(item["tag"])), reverse=True)


# Release tables


def source_pr_of(release):
    """The PR number in the release body's "Source PR: #n" line, or None."""
    match = re.search(r"Source PR: #(\d+)", release.get("body") or "")
    return int(match.group(1)) if match else None


def posts_for_pr(blog_dir, pr_number):
    """The docs/blogs posts for a PR, sorted by name (so by date)."""
    return sorted(blog_dir.glob(f"*-pr-{pr_number}-*.md"))


def post_url(repository, name):
    return f"https://github.com/{repository}/blob/main/docs/blogs/{name}"


def release_entries(gh, repository, blog_dir, current=None):
    """The newest releases, newest first.

    current is {"tag", "date", "pr", "title"} for a release that is being
    created now and so isn't in the Releases API response yet.
    """
    entries = [dict(current)] if current else []
    for release in gh.releases():
        # On a re-run the release being created is already in the response.
        if current and release["tag_name"] == current["tag"]:
            continue
        source_pr = source_pr_of(release)
        entries.append(
            {
                "tag": release["tag_name"],
                "date": (release.get("published_at") or "")[:10],
                "pr": str(source_pr) if source_pr else "",
                "title": "",
                "name": release.get("name") or release["tag_name"],
            }
        )
    # Sort before slicing: a re-run for an older PR must not pin its row
    # above newer releases.
    entries = newest_first(entries)[:TABLE_SIZE]

    for entry in entries:
        if not entry["title"] and entry["pr"]:
            try:
                entry["title"] = gh.pull_title(int(entry["pr"]))
            except subprocess.CalledProcessError:
                entry["title"] = ""
        entry["title"] = entry["title"] or entry.get("name") or entry["tag"]
        entry["url"] = f"https://github.com/{repository}/releases/tag/{entry['tag']}"
        entry["post_url"] = ""
        if entry["pr"]:
            posts = posts_for_pr(blog_dir, entry["pr"])
            if posts:
                entry["post_url"] = post_url(repository, posts[-1].name)
    return entries


def render_releases_markdown(entries):
    rows = []
    for entry in entries:
        blog_cell = f"[Post]({entry['post_url']})" if entry["post_url"] else "—"
        title = sanitize_inline(entry["title"], liquid=True).replace("|", "\\|")
        rows.append(f"| [{entry['tag']}]({entry['url']}) | {entry['date']} | {title} | {blog_cell} |")
    return "\n".join(
        [
            "<!-- RELEASES_START -->",
            "",
            "| Version | Date | Title | Blog post |",
            "| ------- | ---- | ----- | --------- |",
            *rows,
            "",
            "<!-- RELEASES_END -->",
        ]
    )


def link(href, text):
    return f'<a href="{html.escape(href)}">{html.escape(text)}</a>'


def render_table(headers, rows, empty):
    lines = ['<div class="table-wrap">', "  <table>", "    <thead>", "      <tr>"]
    lines += [f"        <th>{html.escape(h)}</th>" for h in headers]
    lines += ["      </tr>", "    </thead>", "    <tbody>"]
    if not rows:
        lines.append(f'      <tr><td colspan="{len(headers)}">{html.escape(empty)}</td></tr>')
    for cells in rows:
        lines.append("      <tr>")
        lines += [f"        <td>{cell}</td>" for cell in cells]
        lines.append("      </tr>")
    lines += ["    </tbody>", "  </table>", "</div>"]
    return lines


def render_releases_html(entries):
    rows = [
        [
            link(e["url"], e["tag"]),
            html.escape(e["date"]),
            html.escape(e["title"]),
            link(e["post_url"], "Post") if e["post_url"] else "—",
        ]
        for e in entries
    ]
    return render_table(["Version", "Date", "Title", "Blog post"], rows, "No releases yet.")


def display_date(iso_date):
    """"2026-09-27" as "27 Sep 2026", or the text unchanged when it isn't an ISO date."""
    try:
        return datetime.date.fromisoformat(iso_date).strftime("%d %b %Y").lstrip("0")
    except ValueError:
        return iso_date


def render_blogs_html(posts, repository):
    """The newest posts as cards: date, release, linked title, excerpt and source PR."""
    newest = newest_first(posts)[:TABLE_SIZE]
    if not newest:
        return ['<p class="post-empty">No blog posts yet.</p>']
    lines = ['<ul class="post-grid">']
    for p in newest:
        meta = f'<time datetime="{html.escape(p["date"])}">{html.escape(display_date(p["date"]))}</time>'
        if p["tag"]:
            meta += f'<span class="post-tag">{html.escape(p["tag"])}</span>'
        lines += [
            '  <li class="post-card">',
            "    <article>",
            f'      <p class="post-meta">{meta}</p>',
            f'      <h3 class="post-title">{link(post_url(repository, p["file"]), p["title"])}</h3>',
        ]
        if p.get("excerpt"):
            lines.append(f'      <p class="post-excerpt">{html.escape(p["excerpt"])}</p>')
        pr_link = link(f"https://github.com/{repository}/pull/{p['pr']}", f"PR #{p['pr']}")
        lines += [f'      <p class="post-source">{pr_link}</p>', "    </article>", "  </li>"]
    lines.append("</ul>")
    return lines


def replace_between(text, name, lines):
    """Replace what's between <!-- {name}_START/END --> with lines, or None without markers."""
    pattern = re.compile(
        rf"^(?P<indent>[ \t]*)<!-- {name}_START -->.*?<!-- {name}_END -->", flags=re.DOTALL | re.MULTILINE
    )
    match = pattern.search(text)
    if not match:
        return None
    indent = match.group("indent")
    block = "\n".join(
        [f"{indent}<!-- {name}_START -->", *[f"{indent}{line}" for line in lines], f"{indent}<!-- {name}_END -->"]
    )
    return text[: match.start()] + block + text[match.end() :]


def update_readme(readme, releases_block, repository):
    # Migrate READMEs written by the previous workflow: drop the legacy
    # Dev Blog section and its BLOG_START/BLOG_END block.
    readme = re.sub(
        r"(?:^## Dev Blog[^\n]*\n\s*)?<!-- BLOG_START -->.*?<!-- BLOG_END -->\n?",
        "",
        readme,
        flags=re.DOTALL | re.MULTILINE,
    )
    readme = re.sub(r"\n{3,}", "\n\n", readme).strip("\n") + "\n" if readme.strip() else ""

    if "<!-- RELEASES_START -->" in readme and "<!-- RELEASES_END -->" in readme:
        return re.sub(
            r"<!-- RELEASES_START -->.*?<!-- RELEASES_END -->",
            lambda _match: releases_block,
            readme,
            flags=re.DOTALL,
        )

    releases_section = (
        "## Releases\n\n" + releases_block + f"\n\n[All releases →](https://github.com/{repository}/releases)\n"
    )
    about = re.search(r"^## About[^\n]*\n", readme, flags=re.MULTILINE)
    next_heading = re.search(r"^## ", readme[about.end() :], flags=re.MULTILINE) if about else None
    if next_heading:
        insert_at = about.end() + next_heading.start()
        return readme[:insert_at] + releases_section + "\n" + readme[insert_at:]
    suffix = "" if readme.endswith("\n") or not readme else "\n"
    separator = "\n" if readme else ""
    return readme + suffix + separator + releases_section


def update_index_html(path, entries, posts, repository):
    if not path.exists():
        log(f"::notice::{path} not found; skipping the Pages tables.")
        return
    text = path.read_text(encoding="utf-8")
    for name, lines in [
        ("RELEASES_HTML", render_releases_html(entries)),
        ("BLOGS_HTML", render_blogs_html(posts, repository)),
    ]:
        updated = replace_between(text, name, lines)
        if updated is None:
            log(f"::notice::{path} has no {name}_START/END markers; leaving that table alone.")
        else:
            text = updated
    path.write_text(text, encoding="utf-8")


# docs/README.md links


# README.md links by path from the repository root (docs/blogs/post.md,
# src/Web); copied verbatim into docs/ they would resolve one directory too
# deep. From TicketManager #104.

# What follows an inline link's destination: an optional "title", 'title' or
# (title), then the closing parenthesis.
LINK_INLINE_TAIL = re.compile(r"""(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*\)""")
LINK_ANGLE_DESTINATION = re.compile(r"<((?:[^<>\n\\]|\\.)+)>")
LINK_REFERENCE = re.compile(r"^(\s{0,3}\[[^\]]+\]:\s*)(<?)(\S+?)(>?)(?=\s|$)", re.MULTILINE)
# Not preceded by a name character, so data-src is not src, but a tag's
# continuation line may start with one. ASCII, as for HTML_BLOCKS: "\u017f"
# must not case-fold into "src".
LINK_HTML_ATTRIBUTE = re.compile(r"""(?<![\w-])((?:src|href)\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))""", re.I | re.A)


def rebase_link(target):
    """A link target as seen from docs/ rather than the repository root."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, flags=re.IGNORECASE) or target.startswith(("#", "?", "/")):
        return target
    path = target[2:] if target.startswith("./") else target
    if path == "docs" or path.startswith(("docs/", "docs#", "docs?")):
        return path[len("docs"):].lstrip("/") or "./"
    return "../" + path


def bare_destination_end(line, start):
    """The end of the bare link destination at line[start], or None if there is none.

    It runs to the first space or control character, or the first ")" that
    closes no "(" of its own, so docs/a_(b).md is one destination; a
    backslash escapes the next character.
    """
    depth = 0
    pos = start
    while pos < len(line):
        char = line[pos]
        if char == "\\" and pos + 1 < len(line) and not line[pos + 1].isspace():
            pos += 2
            continue
        if char <= " " or char == "\x7f":
            break
        if char == "(":
            depth += 1
        elif char == ")":
            if not depth:
                break
            depth -= 1
        pos += 1
    if depth or pos == start or line[start] == "<":
        return None
    return pos


def rebase_inline_links(line):
    """The line with each ](destination) rebased; anything that isn't a whole inline link is left alone."""
    out = []
    done = 0
    opener = line.find("](")
    while opener >= 0:
        start = opener + 2
        while start < len(line) and line[start] in " \t":
            start += 1
        angle = LINK_ANGLE_DESTINATION.match(line, start)
        if angle:
            target_start, target_end, end = angle.start(1), angle.end(1), angle.end()
        else:
            target_start = start
            target_end = end = bare_destination_end(line, start)
        tail = LINK_INLINE_TAIL.match(line, end) if end is not None else None
        if tail:
            out.append(line[done:target_start] + rebase_link(line[target_start:target_end]))
            done = target_end
            opener = line.find("](", tail.end())
        else:
            opener = line.find("](", opener + 2)
    return "".join(out) + line[done:]


def rebase_html_attribute(match):
    """A src= or href= attribute with its value rebased, keeping its spacing and quotes."""
    for group, quote in ((2, '"'), (3, "'"), (4, "")):
        if match.group(group) is not None:
            return match.group(1) + quote + rebase_link(match.group(group)) + quote


def rebase_text_links(lines):
    """Lines of Markdown text with their links rebased; code spans, which may cross lines, are left alone.

    A reference definition is read before any code span, so code in its label
    doesn't hide its destination.
    """
    text = "\n".join(lines)
    spans = [(start, end) for start, end, _ in code_spans(text)]  # in order, never overlapping
    first = 0  # the first span that may still reach this line or a later one
    out = []
    offset = 0
    for line in lines:
        end_of_line = offset + len(line)
        while first < len(spans) and spans[first][1] <= offset:
            first += 1
        # The parts of this line inside a span, relative to the line.
        inside = []
        index = first
        while index < len(spans) and spans[index][0] < end_of_line:
            start, end = spans[index]
            inside.append((max(start, offset) - offset, min(end, end_of_line) - offset))
            index += 1
        reference = LINK_REFERENCE.match(line)
        if reference and not any(start <= reference.start(3) < end for start, end in inside):
            out.append(line[:reference.start(3)] + rebase_link(reference.group(3)) + line[reference.end(3):])
        else:
            parts = []
            done = 0
            for start, end in [*inside, (len(line), len(line))]:
                prose = rebase_inline_links(line[done:start])
                parts.append(LINK_HTML_ATTRIBUTE.sub(rebase_html_attribute, prose) + line[start:end])
                done = end
            out.append("".join(parts))
        offset = end_of_line + 1
    return out


def rebase_readme_links(markdown):
    """The README text with every relative link rebased for docs/README.md; code is left alone.

    Fenced and indented code blocks, at any depth, are copied as they are, and
    so are code spans. In a raw HTML block backticks are text, so its whole
    line is rebased.
    """
    lines = markdown.split("\n")
    raw = set()
    blocks = []
    scan_blocks(list(lines), [], raw, blocks)
    code = {index for block in blocks for index in block["lines"]}
    out = []
    text = []  # the run of text lines since the last code or HTML line
    for index, line in enumerate(lines):
        if index in code or index in raw:
            out += rebase_text_links(text)
            text = []
            out.append(line if index in code else LINK_HTML_ATTRIBUTE.sub(rebase_html_attribute, rebase_inline_links(line)))
        else:
            text.append(line)
    out += rebase_text_links(text)
    return "\n".join(out)


def write_post(gh, pr_number, tag, root=Path("."), api_key=None, model=DEFAULT_MODEL, urlopen=urllib.request.urlopen):
    """Write the post for a merged PR and its blog index row; return (merged_date, title_line)."""
    root = Path(root)
    pr = gh.pull(pr_number)
    commits = gh.commits(pr_number)
    files = gh.files(pr_number)

    title_line = (pr.get("title") or "").strip() or f"PR #{pr_number}"
    merged_date = (pr.get("merged_at") or "")[:10] or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")

    summary = None
    author = (pr.get("user") or {}).get("login") or ""
    if author in NO_SUMMARY_AUTHORS:
        log(f"::notice::PR #{pr_number} is by {author}; writing the post without an AI summary.")
    elif api_key:
        summary = request_summary(api_key, model, build_prompt(pr, commits, build_diff(files)), urlopen)
    else:
        log("::notice::ANTHROPIC_API_KEY is not set; writing the post without an AI summary.")

    blog_dir = root / "docs" / "blogs"
    blog_dir.mkdir(parents=True, exist_ok=True)
    post_name = f"{merged_date}-pr-{pr_number}-{slugify(title_line)}.md"
    # A renamed PR, or an older post dated differently, would otherwise leave
    # two posts for one PR.
    for old_post in posts_for_pr(blog_dir, pr_number):
        if old_post.name != post_name:
            old_post.unlink()
            log(f"Removed docs/blogs/{old_post.name}")
    (blog_dir / post_name).write_text(
        render_post(pr, title_line, tag, merged_date, commits, files, summary, model), encoding="utf-8"
    )
    log(f"Wrote docs/blogs/{post_name}")
    update_blog_index(blog_dir, merged_date, title_line, post_name)
    return merged_date, title_line


def update_tables(repository, gh, root=Path("."), current=None):
    """Rewrite the README, docs/README.md and docs/index.html release and blog tables."""
    root = Path(root)
    blog_dir = root / "docs" / "blogs"
    # The Releases tables come from the GitHub Releases API, not the blog
    # index, so releases without a blog post are listed too.
    entries = release_entries(gh, repository, blog_dir, current)

    readme_path = root / "README.md"
    readme = readme_path.read_text(encoding="utf-8") if readme_path.exists() else ""
    readme = update_readme(readme, render_releases_markdown(entries), repository)
    readme_path.write_text(readme, encoding="utf-8")
    # Only a repo that publishes its README as the Pages landing page keeps
    # this copy; don't create one in a repo whose docs site has its own.
    docs_readme = root / "docs" / "README.md"
    if docs_readme.exists():
        docs_readme.write_text(rebase_readme_links(readme), encoding="utf-8")

    update_index_html(root / "docs" / "index.html", entries, read_blog_posts(blog_dir), repository)


def run(repository, pr_number, tag, gh, root=Path("."), api_key=None, model=DEFAULT_MODEL, urlopen=urllib.request.urlopen):
    merged_date, title_line = write_post(gh, pr_number, tag, root, api_key, model, urlopen)
    # This runs before "Create tag and release", so the new release is passed in.
    current = {"tag": tag, "date": merged_date, "pr": str(pr_number), "title": title_line}
    update_tables(repository, gh, root, current)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--pr", type=int, required=True, help="merged PR number")
    parser.add_argument("--tag", required=True, help="release tag for the PR, e.g. v0.0.32")
    parser.add_argument(
        "--repo",
        default=os.environ.get("REPOSITORY") or os.environ.get("GITHUB_REPOSITORY"),
        help="owner/name (default: $REPOSITORY or $GITHUB_REPOSITORY)",
    )
    args = parser.parse_args(argv)
    if not args.repo:
        parser.error("--repo is required when REPOSITORY and GITHUB_REPOSITORY are unset")

    run(
        args.repo,
        args.pr,
        args.tag.strip(),
        GitHub(args.repo),
        api_key=(os.environ.get("ANTHROPIC_API_KEY") or "").strip() or None,
        model=(os.environ.get("ANTHROPIC_MODEL") or "").strip() or DEFAULT_MODEL,
    )


if __name__ == "__main__":
    main()
