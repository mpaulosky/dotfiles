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
instead. A body finding opens no review thread to hold the merge, so the
body's second line is OFF_DIFF_MARKER, which PR Auto-Merge holds on while
that review is the latest of the head, up to the review cap. The step
passes with a warning: a failed check would leave the PR UNSTABLE, which
PR Auto-Merge never merges, so it couldn't merge past the cap either. Only
malformed findings or a failed API call fail the step. The body always
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

# Accepted limit (repo-ci-baseline's ADR 0004): the marker proves the login,
# not that Claude wrote the review; see claude-review.yml.
MARKER = "<!-- claude-review -->"
# The second line of a review with findings outside the diff.
OFF_DIFF_MARKER = "<!-- claude-review:off-diff -->"

# The new-side start of a hunk: "@@ -a,b +c,d @@" (",d" is optional).
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


class MalformedFindings(ValueError):
    pass


class GitHub:
    """The two calls this script makes, through the gh CLI."""

    def __init__(self, repository):
        self.repository = repository

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


def build_review(summary, findings, commentable, head):
    """The review to post: inline comments for findings on the diff, the rest in the body."""
    comments = []
    off_diff = []
    for finding in findings:
        path, line, body = finding["path"], finding["line"], finding["body"]
        if line in commentable.get(path, ()):
            comments.append({"path": path, "line": line, "side": "RIGHT", "body": body})
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

    gh = gh or GitHub(args.repo)
    review = build_review(summary, parsed, diff_lines(gh.pull_files(args.pr)), args.head)
    gh.create_review(args.pr, review)
    in_body = len(parsed) - len(review["comments"])
    print(f"Posted Claude's review of {args.head} on PR #{args.pr}: {len(review['comments'])} inline, {in_body} in the body.")
    if in_body:
        print(
            f"::warning::{in_body} finding(s) outside the diff are in the review body; "
            "its off-diff marker holds the merge until the next push or the review cap."
        )
    return review


if __name__ == "__main__":
    main()
