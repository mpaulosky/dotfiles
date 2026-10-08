#!/usr/bin/env python3
"""Post Claude Review's findings as one PR review on the head commit.

Called by .github/workflows/claude-review.yml twice. In the review job,
before Claude's answer becomes a job output:

    OAUTH_TOKEN=... JOB_TOKEN=... python3 .github/scripts/post_claude_review.py --check-answer <execution file>

and in the post job, once Claude has reviewed the PR:

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
malformed findings, a failed API call or empty findings fail the step: the
post job runs only once Claude has answered, so empty findings mean the
answer quoted a secret of the review job and was withheld.

--check-answer is what withholds it. It reads Claude's answer from the
action's execution file (a path, so no log prints the answer) and drops it
when it holds 16 characters in a row of CLAUDE_CODE_OAUTH_TOKEN or the job's
GITHUB_TOKEN: an exact test against the real secrets, so a quoted fixture
never trips it, and a near-miss quote that GitHub's masking would let
through still does. Otherwise it replaces anything shaped like a
credential (an Anthropic, GitHub or JWT token) with [redacted] before the
answer becomes the FINDINGS the post job's log prints. Those matches are
public text from the PR far more often than leaks, so they only warn. The body always
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
# How much of a secret, in a row, counts as quoting it.
LEAK_WINDOW = 16
# The part of a secret that is secret: an Anthropic key's or GitHub token's
# body after its public prefix, or a JWT's signature (its header and claims
# are shared by every token of a kind, so quoting them leaks nothing). A
# stored secret may hold more than the token, such as a NAME= in front, and
# Claude names CLAUDE_CODE_OAUTH_TOKEN in any review of this workflow.
SECRET_PART = re.compile(
    r"sk-ant-(?:[a-z]+[0-9]+-)?([A-Za-z0-9_-]{20,})"
    r"|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)"
    r"|gh[pousr]_([A-Za-z0-9]{36,})"
    r"|github_pat_([A-Za-z0-9_]{82})"
)


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


def structured_output(path):
    """Claude's answer from the action's execution file, as JSON text, or '' when there's none."""
    try:
        with open(path, encoding="utf-8") as file:
            messages = json.load(file)
    except (OSError, ValueError):
        return ""
    for message in reversed(messages if isinstance(messages, list) else []):
        if isinstance(message, dict) and message.get("type") == "result" and message.get("structured_output"):
            return json.dumps(message["structured_output"])
    return ""


def secret_parts(secret):
    """The secret parts of the tokens in secret, or the whole of it, stripped, when it holds none."""
    parts = [part for match in SECRET_PART.finditer(secret) for part in match.groups() if part]
    return parts or [secret.strip()]


def letters_and_digits(text):
    """Text with all but its letters and digits taken out."""
    return re.sub(r"[^A-Za-z0-9]", "", text)


def quotes_a_secret(text, secrets):
    """Whether text holds LEAK_WINDOW characters in a row of the secret part of any of the secrets.

    Compared as letters and digits only, so a secret quoted in short pieces
    split by backticks, newlines or dashes is still caught.
    """
    text = letters_and_digits(text)
    for secret in secrets:
        for part in map(letters_and_digits, secret_parts(secret)):
            for start in range(len(part) - LEAK_WINDOW + 1):
                if part[start:start + LEAK_WINDOW] in text:
                    return True
    return False


def strings_in(value):
    """Every string in a JSON value, keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings_in(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from strings_in(item)


def redact_all(value):
    """Every string in a JSON value with credential-shaped text replaced, and how many were replaced."""
    if isinstance(value, str):
        return CREDENTIAL.subn(REDACTED, value)
    if isinstance(value, list):
        pairs = [redact_all(item) for item in value]
        return [item for item, _ in pairs], sum(n for _, n in pairs)
    if isinstance(value, dict):
        # Keys too: the schema allows extra properties, and the job output
        # holds the whole answer.
        pairs = [(redact_all(key), redact_all(item)) for key, item in value.items()]
        return {key: item for (key, _), (item, _) in pairs}, sum(m + n for (_, m), (_, n) in pairs)
    return value, 0


def check_answer(path, secrets):
    """The answer to pass on as FINDINGS, how many strings were redacted, and whether it quoted a secret."""
    text = structured_output(path)
    if not text:
        return "", 0, False
    answer = json.loads(text)
    # The answer's strings as Claude wrote them, not JSON-escaped, so a \n
    # between pieces of a secret is a separator, not an n.
    if quotes_a_secret("\n".join(strings_in(answer)), [secret for secret in secrets if secret]):
        return "", 0, True
    answer, redacted = redact_all(answer)
    return json.dumps(answer), redacted, False


def write_outputs(outputs):
    """Write step outputs to GITHUB_OUTPUT: an empty value as name=, any other under its own heredoc delimiter."""
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as file:
        for name, value in outputs.items():
            if not value:
                file.write(f"{name}=\n")
                continue
            delimiter = f"EOF_{os.urandom(8).hex()}"
            file.write(f"{name}<<{delimiter}\n{value}\n{delimiter}\n")


def check_answer_main(path):
    findings, redacted, leaked = check_answer(path, [os.environ.get("OAUTH_TOKEN", ""), os.environ.get("JOB_TOKEN", "")])
    write_outputs({"findings": findings, "redacted": str(redacted)})
    if leaked:
        print("::error::Claude's answer quotes CLAUDE_CODE_OAUTH_TOKEN or the job's GITHUB_TOKEN, so it is withheld "
              "and the post job fails. A prompt-injected diff may have tried to leak it: check the PR, and rotate "
              "CLAUDE_CODE_OAUTH_TOKEN (the job's token expires with the job).")
    elif not findings:
        # This step runs only when Claude answered, so the file is unreadable
        # or laid out differently, not a leak: fail here, so the post job,
        # whose error is about a quoted secret, doesn't run.
        print(f"::error::Claude answered, but its answer isn't in the action's execution file ({path or 'not set'}), "
              "so there's nothing to post. A later action pin may have changed the file's layout.")
        sys.exit(1)
    elif redacted:
        print(f"Redacted {redacted} credential-shaped string(s) from Claude's answer.")


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
    parser.add_argument("--check-answer", metavar="EXECUTION_FILE",
                        help="in the review job: check Claude's answer and write it as step outputs")
    parser.add_argument("--repo", help="owner/name")
    parser.add_argument("--pr", type=int, help="the PR to review")
    parser.add_argument("--head", help="the head commit Claude reviewed")
    args = parser.parse_args(argv)
    if args.check_answer is not None:
        return check_answer_main(args.check_answer)
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
            "its off-diff marker holds the merge until the next push or the review cap."
        )
    if redacted:
        print(f"::warning::Redacted {redacted} credential-shaped string(s) from Claude's review. They aren't this "
              "job's secrets (an answer quoting those is withheld), so they are most likely sample or placeholder "
              "tokens from the PR.")
    return review


if __name__ == "__main__":
    main()
