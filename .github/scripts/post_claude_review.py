#!/usr/bin/env python3
"""Post Claude Review's findings as one PR review on the head commit.

Called by .github/workflows/claude-review.yml's post job, once Claude has
reviewed the PR:

    FINDINGS='{"summary": ..., "findings": [...]}' \\
        python3 .github/scripts/post_claude_review.py --repo owner/name --pr 42 --head <sha>

FINDINGS is the review step's structured output: a summary, plus a path,
line and body for each finding. Claude never holds a write token; this
script, in its own job, is what posts. It posts one COMMENT review pinned to
the head commit, each finding an inline comment on the new side of the
diff, so the PR records it the same way it records Copilot's.

GitHub rejects a whole review if one comment sits on a line outside the
diff, so a finding whose line isn't in the diff goes into the review body
instead. A finding on a changed file whose line isn't a line of that file
at all (past its end) is Claude citing the wrong number, not a finding
about unchanged code: it goes on the file's nearest line in the diff, as a
thread, with a note. A body finding opens no review thread to hold the merge, so the
body's second line is OFF_DIFF_MARKER, which PR Auto-Merge holds on while
that review is the latest of the head, past the review cap too. The step
passes with a warning: a failed check would leave the PR UNSTABLE, which
PR Auto-Merge never merges, and a later run with its jobs skipped would
replace it anyway. Only
malformed findings, a failed API call or empty findings fail the step: the
post job runs only once Claude has answered, so empty findings mean the
answer quoted a secret of the review job and was withheld.

The review job's check, inline in claude-review.yml, is what withholds it,
and it redacts anything shaped like a credential before the answer becomes
the FINDINGS the post job's log prints. This script redacts again with the
same CREDENTIAL, which must match the workflow's, and warns: those matches
are public text from the PR far more often than leaks. The body always
starts with MARKER: the review is posted as github-actions[bot], and the
marker is how PR Auto-Merge and the skill's landing decision tell it apart
from anything else posted under that login.

A comment may carry one GitHub suggestion, a fenced block the reader applies to the commented
line with one click, and only a single line (vet_suggestions): any other is turned into a
plain text fence. So is every suggestion in a comment moved to the nearest diff line, which
would replace the wrong line, and in a body finding, where none can be applied. A body
finding is indented under its bullet so its paragraphs stay with it.

Standard library only, like release_post.py; the gh CLI does the rest.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.parse

# Accepted limit (repo-ci-baseline's ADR 0004): the marker proves the login,
# not that Claude wrote the review; see claude-review.yml.
MARKER = "<!-- claude-review -->"
# The second line of a review with findings outside the diff.
OFF_DIFF_MARKER = "<!-- claude-review:off-diff -->"

# The new-side start of a hunk: "@@ -a,b +c,d @@" (",d" is optional).
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")

# Text shaped like a credential, in the formats the tokens are issued in, so
# a long snake_case name such as ghs_installation_token_value isn't one:
# Anthropic keys and OAuth tokens, GitHub tokens (classic, fine-grained and
# today's ghs_<digits>_<JWT> installation tokens), and JWTs. No boundary on
# the left, so text run up against a token (token_ghp_..., x-eyJ...) can't
# hide it; a match only warns, so redacting a little too much costs little.
CREDENTIAL = re.compile(
    r"sk-ant-[A-Za-z0-9_-]{20,}"
    r"|gh[pousr]_[0-9]+_eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"
    r"|gh[pousr]_[A-Za-z0-9]{36,}"
    r"|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
)
REDACTED = "[redacted]"

# CREDENTIAL scans from every `eyJ`, and a long run of token characters (the first segment of a JWT
# holds the letters e, y and J) is rescanned from each one: quadratic on text a diff can steer.
# So a token, with the dots joining its segments, that holds a run longer than MAX_TOKEN_RUN and
# one of the strings every CREDENTIAL alternative starts with (CREDENTIAL_START) is replaced whole
# before CREDENTIAL looks at the text: it leaves nothing of a long JWT (its signature included)
# behind. A long token without one can't match CREDENTIAL, and legitimate review text has them (a
# generated test's file name, a long identifier, a digest), so it is left alone. What is left has
# no run holding a start longer than MAX_TOKEN_RUN characters, which CREDENTIAL scans in time
# linear in the text.
MAX_TOKEN_RUN = 128
TOKEN_CHAIN = re.compile(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*")
CREDENTIAL_START = re.compile(r"eyJ|gh[pousr]_|sk-ant-|github_pat_")


def redact_credentials(text):
    """The text with credential-shaped text replaced, and how many were replaced."""
    count = 0

    def long_chain(match):
        nonlocal count
        chain = match.group()
        if any(len(run) > MAX_TOKEN_RUN for run in chain.split(".")) and CREDENTIAL_START.search(chain):
            count += 1
            return REDACTED
        return chain

    text = TOKEN_CHAIN.sub(long_chain, text)
    text, found = CREDENTIAL.subn(REDACTED, text)
    return text, count + found


MAX_PATH = 1024


def redact_path(path):
    """A finding's path with credential-shaped text replaced, and how many were replaced.

    Not the long-run rule: a long name that holds one of CREDENTIAL_START's strings without being
    a credential (a generated test's name with `eyJ` in it) would be replaced whole by it, and a
    path that no longer matches the diff leaves its finding outside it. A long name with none of
    them is left alone by redact_credentials already. A path past MAX_PATH is no real path and
    gets the full rule.
    """
    if len(path) > MAX_PATH:
        return redact_credentials(path)
    return CREDENTIAL.subn(REDACTED, path)

# A fence whose info string starts with `suggestion`, anywhere in a body (after a list or quote
# marker, or a lone CR, too): GitHub shows its content as a change the reader can apply with
# one click to the line the comment sits on, and the legacy `suggestion:-1+1` form changes more.
# Any whitespace but a line break may sit between the fence and the info string.
# A match starts only at the start of a run of fence characters, so a long run costs a linear scan.
SUGGESTION_FENCE = re.compile(r"(?i)((?<!`)`{3,}|(?<!~)~{3,})[^\S\r\n]*suggestion\b")
# The one form a comment may keep: a fence on its own lines whose info string is exactly
# `suggestion`, holding one non-empty line. The leading class and \S are disjoint, so
# matching is linear.
ONE_LINE_SUGGESTION = re.compile(r"(?m)^(`{3,}|~{3,})suggestion[ \t]*\n([^\S\n\r]*\S[^\n\r]*)\n\1[ \t]*$")


class MalformedFindings(ValueError):
    pass


class GitHub:
    """The two calls this script makes, through the gh CLI."""

    def __init__(self, repository):
        self.repository = repository

    def line_count(self, path, ref):
        """How many lines the file has at ref, or None when it can't be read."""
        try:
            data = subprocess.run(
                ["gh", "api", "-H", "Accept: application/vnd.github.raw",
                 f"repos/{self.repository}/contents/{urllib.parse.quote(path)}?ref={ref}"],
                check=True,
                capture_output=True,
            ).stdout
        except (subprocess.CalledProcessError, OSError):
            return None
        # Line numbers count newlines only, as in diff_lines(); a last line
        # without one still counts. Counted in bytes, so a file that isn't
        # UTF-8 can't fail the step, and a lone \r isn't read as a newline.
        return data.count(b"\n") + (0 if data.endswith(b"\n") or not data else 1)

    def pull_files(self, number):
        output = subprocess.run(
            ["gh", "api", "--paginate", "--slurp", f"repos/{self.repository}/pulls/{number}/files?per_page=100"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        return [file for page in json.loads(output) for file in page]

    def create_review(self, number, review):
        subprocess.run(
            ["gh", "api", "--method", "POST", f"repos/{self.repository}/pulls/{number}/reviews", "--input", "-"],
            input=json.dumps(review),
            check=True,
            capture_output=True,
            text=True,
        )


def parse_findings(text):
    """The summary and findings from the review step's JSON, or MalformedFindings."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise MalformedFindings(f"not JSON ({error})") from error
    if not isinstance(data, dict) or not isinstance(data.get("summary"), str):
        raise MalformedFindings("no summary string")
    findings = data.get("findings")
    if not isinstance(findings, list):
        raise MalformedFindings("findings is not a list")
    for index, finding in enumerate(findings):
        if not (
            isinstance(finding, dict)
            and isinstance(finding.get("path"), str)
            and type(finding.get("line")) is int
            and isinstance(finding.get("body"), str)
        ):
            raise MalformedFindings(f"finding {index} needs a string path, an integer line and a string body")
    return data["summary"], findings


def diff_lines(files):
    """Each file's new-side line numbers in the diff: the lines a review comment can sit on."""
    lines = {}
    for file in files:
        commentable = lines.setdefault(file["filename"], set())
        line = None
        # GitHub's patches are newline-delimited; splitlines() would also split
        # on form feeds and other line breaks inside a line's content.
        for row in (file.get("patch") or "").split("\n"):
            hunk = HUNK.match(row)
            if hunk:
                line = int(hunk.group(1))
            elif line is not None and not row.startswith("-") and not row.startswith("\\"):
                commentable.add(line)
                line += 1
    return lines


def redact(summary, findings):
    """The summary and findings with credential-shaped text replaced, and how many were replaced."""
    count = 0
    def clean(text, scan=redact_credentials):
        nonlocal count
        text, n = scan(text)
        count += n
        return text
    summary = clean(summary)
    findings = [{**f, "path": clean(f["path"], redact_path), "body": clean(f["body"])} for f in findings]
    return summary, findings, count


def defuse_suggestions(body):
    """The body with each suggestion fence turned into a plain text fence, so no one-click suggestion applies."""
    return SUGGESTION_FENCE.sub(r"\1text", body)


# Characters that render blank but are letters or symbols (Hangul fillers, the blank Braille cell,
# Khmer inherent vowels), which \s does not match.
BLANK_FILLERS = "\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0"


def suggestion_line_is_safe(fence, line):
    """Whether `line` can be the one line of a suggestion that `fence` opened.

    Not when it would close the block (a suggestion with no content deletes the line), nor when
    it holds a character the reader can't see in the diff: a control or format character
    (zero-width, bidirectional) or a Unicode line or paragraph separator, or when nothing in it is
    visible (spaces, combining marks and the blank fillers only).
    """
    closes = re.fullmatch(" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + ",}[ \t]*", line)
    hidden = any(unicodedata.category(c) in ("Cf", "Zl", "Zp") or (unicodedata.category(c) == "Cc" and c != "\t") for c in line)
    blank = all(c in BLANK_FILLERS or unicodedata.category(c) in ("Zs", "Cc", "Mn") for c in line)
    return not closes and not hidden and not blank


def vet_suggestions(body):
    """The body as it is when it holds no suggestion, or exactly one well-formed single-line suggestion.

    Any other suggestion (several, several lines, the multi-line form, an empty or hidden one, text
    redacted from a credential) is defused: the prompt asks for one line only, but a suggestion is
    applied with one click and what the model writes comes from a PR it read, so the script holds
    the rule.
    """
    fences = SUGGESTION_FENCE.findall(body)
    if not fences:
        return body
    block = ONE_LINE_SUGGESTION.search(body)
    if len(fences) == 1 and block and REDACTED not in block.group(2) and suggestion_line_is_safe(block.group(1), block.group(2)):
        return body
    return defuse_suggestions(body)


def build_review(summary, findings, commentable, head, line_count=lambda path: None):
    """The review to post: inline comments for findings on the diff, the rest in the body.

    line_count(path) is the file's length at the head, or None if unknown.
    """
    comments = []
    off_diff = []
    for finding in findings:
        path, line, body = finding["path"], finding["line"], finding["body"]
        lines = commentable.get(path, ())
        if line in lines:
            comments.append({"path": path, "line": line, "side": "RIGHT", "body": vet_suggestions(body)})
        elif lines and (line < 1 or (length := line_count(path)) is not None and line > length):
            # Not a line of the file: Claude got the number wrong.
            nearest = min(lines, key=lambda n: (abs(n - line), n))
            note = f"_Claude cited line {line}, which isn't a line of this file, so this is on the nearest line in the diff._"
            # A suggestion would replace the nearest line, not the one Claude meant.
            comments.append({"path": path, "line": nearest, "side": "RIGHT", "body": f"{note}\n\n{defuse_suggestions(body)}"})
        else:
            # In the review body a suggestion can't be applied, and a body of several
            # paragraphs stays under its bullet when indented.
            indented = defuse_suggestions(body).replace("\n", "\n  ")
            off_diff.append(f"- `{path}:{line}`: {indented}")

    parts = ["**Claude Review**", summary.strip()]
    if not findings:
        parts.append("No findings.")
    if off_diff:
        parts.append("Findings outside the diff (no thread to resolve, so they hold the merge until the next "
                     "push gets a fresh review):\n\n" + "\n".join(off_diff))
    body = "\n\n".join(part for part in parts if part)
    markers = f"{MARKER}\n{OFF_DIFF_MARKER}" if off_diff else MARKER
    return {"commit_id": head, "event": "COMMENT", "body": f"{markers}\n{body}", "comments": comments}


def main(argv=None, gh=None, findings=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", help="owner/name")
    parser.add_argument("--pr", type=int, help="the PR to review")
    parser.add_argument("--head", help="the head commit Claude reviewed")
    args = parser.parse_args(argv)
    if not (args.repo and args.pr and args.head):
        parser.error("--repo, --pr and --head are required to post")

    text = os.environ.get("FINDINGS", "") if findings is None else findings
    if not text.strip():
        print("post_claude_review.py: Claude Review's findings are empty, though Claude answered: the answer "
              "quoted a secret of the review job and was withheld.", file=sys.stderr)
        print("::error::Claude's review reached the post job empty: it quoted a secret of the review job, so the "
              "review job's check (or GitHub's masking) withheld it. A prompt-injected diff may have got Claude to "
              "quote CLAUDE_CODE_OAUTH_TOKEN, the only long-lived secret in that job (its GITHUB_TOKEN expires with "
              "the job): check the PR and the review job's log, and rotate CLAUDE_CODE_OAUTH_TOKEN.")
        sys.exit(1)
    try:
        summary, parsed = parse_findings(text)
    except MalformedFindings as error:
        print(f"post_claude_review.py: Claude Review's findings are malformed: {error}", file=sys.stderr)
        sys.exit(1)

    summary, parsed, redacted = redact(summary, parsed)
    # The review job's check redacts first; this counts what it did too.
    redacted += int(os.environ.get("REDACTED") or 0)
    if redacted:
        summary += f"\n\n{redacted} credential-shaped string(s) were redacted from this review."

    gh = gh or GitHub(args.repo)
    review = build_review(summary, parsed, diff_lines(gh.pull_files(args.pr)), args.head,
                          lambda path: gh.line_count(path, args.head))
    gh.create_review(args.pr, review)
    in_body = len(parsed) - len(review["comments"])
    print(f"Posted Claude's review of {args.head} on PR #{args.pr}: {len(review['comments'])} inline, {in_body} in the body.")
    if in_body:
        print(
            f"::warning::{in_body} finding(s) outside the diff are in the review body; "
            "its off-diff marker holds the merge until the next push gets a fresh review."
        )
    if redacted:
        print(f"::warning::Redacted {redacted} credential-shaped string(s) from Claude's review. They aren't this "
              "job's secrets (an answer quoting those is withheld), so they are most likely sample or placeholder "
              "tokens from the PR.")
    return review


if __name__ == "__main__":
    main()
