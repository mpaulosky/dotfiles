#!/usr/bin/env python3
"""Post Claude Review's findings as one PR review on the head commit.

Called by .github/workflows/claude-review.yml once Claude has reviewed the PR:

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
that review is the latest of the head, up to the review cap. The step
passes with a warning: a failed check would leave the PR UNSTABLE, which
PR Auto-Merge never merges, so it couldn't merge past the cap either. Only
malformed findings, a failed API call or a redacted credential fail the
step. Anything shaped like a credential (an Anthropic, GitHub or JWT token)
is replaced with [redacted] before posting, and the step then fails, so a
person looks at what a prompt-injected diff may have tried. The body always
starts with MARKER: the review is posted as github-actions[bot], and the
marker is how PR Auto-Merge and the skill's landing decision tell it apart
from anything else posted under that login.

Standard library only, like release_post.py; the gh CLI does the rest.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse

# Accepted limit (repo-ci-baseline's ADR 0004): the marker proves the login,
# not that Claude wrote the review; see claude-review.yml.
MARKER = "<!-- claude-review -->"
# The second line of a review with findings outside the diff.
OFF_DIFF_MARKER = "<!-- claude-review:off-diff -->"

# The new-side start of a hunk: "@@ -a,b +c,d @@" (",d" is optional).
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")

# Text shaped like a credential: Anthropic keys and OAuth tokens, GitHub
# tokens, and JWTs.
CREDENTIAL = re.compile(
    r"sk-ant-[A-Za-z0-9_-]{8,}"
    r"|\bgh[pousr]_[A-Za-z0-9]{20,}"
    r"|\bgithub_pat_[A-Za-z0-9_]{20,}"
    r"|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
)
REDACTED = "[redacted]"


class MalformedFindings(ValueError):
    pass


class GitHub:
    """The two calls this script makes, through the gh CLI."""

    def __init__(self, repository):
        self.repository = repository

    def line_count(self, path, ref):
        """How many lines the file has at ref, or None when it can't be read."""
        try:
            text = subprocess.run(
                ["gh", "api", "-H", "Accept: application/vnd.github.raw",
                 f"repos/{self.repository}/contents/{urllib.parse.quote(path)}?ref={ref}"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        except subprocess.CalledProcessError:
            return None
        return len(text.splitlines())

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
    def clean(text):
        nonlocal count
        text, n = CREDENTIAL.subn(REDACTED, text)
        count += n
        return text
    summary = clean(summary)
    findings = [{**f, "path": clean(f["path"]), "body": clean(f["body"])} for f in findings]
    return summary, findings, count


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
            comments.append({"path": path, "line": line, "side": "RIGHT", "body": body})
        elif lines and (line < 1 or (length := line_count(path)) is not None and line > length):
            # Not a line of the file: Claude got the number wrong.
            nearest = min(lines, key=lambda n: (abs(n - line), n))
            note = f"_Claude cited line {line}, which isn't a line of this file, so this is on the nearest line in the diff._"
            comments.append({"path": path, "line": nearest, "side": "RIGHT", "body": f"{note}\n\n{body}"})
        else:
            off_diff.append(f"- `{path}:{line}`: {body}")

    parts = ["**Claude Review**", summary.strip()]
    if not findings:
        parts.append("No findings.")
    if off_diff:
        parts.append("Findings outside the diff (no thread to resolve, so they hold the merge until the next "
                     "push gets a fresh review or the review cap is reached):\n\n" + "\n".join(off_diff))
    body = "\n\n".join(part for part in parts if part)
    markers = f"{MARKER}\n{OFF_DIFF_MARKER}" if off_diff else MARKER
    return {"commit_id": head, "event": "COMMENT", "body": f"{markers}\n{body}", "comments": comments}


def main(argv=None, gh=None, findings=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--pr", type=int, required=True, help="the PR to review")
    parser.add_argument("--head", required=True, help="the head commit Claude reviewed")
    args = parser.parse_args(argv)

    text = os.environ.get("FINDINGS", "") if findings is None else findings
    try:
        summary, parsed = parse_findings(text)
    except MalformedFindings as error:
        print(f"post_claude_review.py: Claude Review's findings are malformed: {error}", file=sys.stderr)
        sys.exit(1)

    summary, parsed, redacted = redact(summary, parsed)
    if redacted:
        summary += (f"\n\n{redacted} credential-shaped string(s) were redacted from this review; "
                    "the post step fails so a person checks why.")

    gh = gh or GitHub(args.repo)
    review = build_review(summary, parsed, diff_lines(gh.pull_files(args.pr)), args.head,
                          lambda path: gh.line_count(path, args.head))
    gh.create_review(args.pr, review)
    in_body = len(parsed) - len(review["comments"])
    print(f"Posted Claude's review of {args.head} on PR #{args.pr}: {len(review['comments'])} inline, {in_body} in the body.")
    if in_body:
        print(
            f"::warning::{in_body} finding(s) outside the diff are in the review body; "
            "its off-diff marker holds the merge until the next push or the review cap."
        )
    if redacted:
        print(f"::error::Redacted {redacted} credential-shaped string(s) from Claude's review. A prompt-injected diff "
              "may have tried to leak a secret: check the PR, and rotate CLAUDE_CODE_OAUTH_TOKEN if it was exposed.")
        sys.exit(1)
    return review


if __name__ == "__main__":
    main()
