"""The three spellings of "Copilot's note isn't a review" agree.

PR Auto-Merge (JS), claude-review.yml (jq) and the landing scripts (Python)
each decide whether a Copilot review is its quota note. If they disagreed, one
would count a commit as reviewed that another doesn't: Claude Review would
skip a head the merge gate still waits on, or the merge gate would count a
note claude-review.yml re-reviews. This runs each real pattern on the same
bodies.
"""

import json
import pathlib
import re
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import landing  # noqa: E402

SKILL = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = SKILL / "template" / "owned" / ".github" / "workflows"
LOGIN = "copilot-pull-request-reviewer[bot]"

NOTE = ("Copilot was unable to review this pull request because the user who requested the review has reached "
        "their quota limit.")
BODIES = {
    "the quota note": (NOTE, True),
    "the note after leading whitespace": ("\n  " + NOTE, True),
    # Copilot's note when every changed file is one it excludes (a lockfile-only PR) still counts, as it did.
    "the no-reviewable-files note": ("Copilot wasn't able to review any files in this pull request.", False),
    "a real review": ("## Pull request overview\n\nThis PR fixes the cap.", False),
    "a real review that quotes the note on a later line": (
        "## Pull request overview\n\nCopilot was unable to review 2 files:\n- a.bin", False),
    "an empty body": ("", False),
    # Not ASCII whitespace, so every engine reads it the same way: not the note.
    "the note after a no-break space": ("\u00a0" + NOTE, False),
}


def js_pattern():
    """COPILOT_NO_REVIEW from pr-automerge.yml, as Python reads the same source."""
    source = (WORKFLOWS / "pr-automerge.yml").read_text(encoding="utf-8")
    match = re.search(r"const COPILOT_NO_REVIEW = /(.+)/;", source)
    assert match, "pr-automerge.yml defines COPILOT_NO_REVIEW as a regex literal"
    # Without the m flag, JS ^ is the start of the string, as Python's \A is.
    return re.compile(match.group(1).replace("^", r"\A", 1))


def jq_program():
    """The reviewed-list jq filter from claude-review.yml, unquoted from the shell."""
    source = (WORKFLOWS / "claude-review.yml").read_text(encoding="utf-8")
    match = re.search(r"/reviews\" --jq '(.+?)' > \"\$\{RUNNER_TEMP\}/reviewed\.txt\"", source, re.DOTALL)
    assert match, "claude-review.yml builds reviewed.txt with a --jq filter"
    return match.group(1).replace("'\"'\"'", "'")


@pytest.mark.parametrize("name", BODIES)
def test_landing_and_pr_automerge_agree(name):
    body, is_note = BODIES[name]
    assert bool(landing.COPILOT_NO_REVIEW.match(body)) is is_note
    assert bool(js_pattern().search(body)) is is_note


def test_claude_review_jq_agrees():
    # claude-review.yml runs the filter through gh api --jq, which embeds gojq (Go's RE2 regexes); prefer it, and
    # fall back to jq (Oniguruma), which reads these spelled-out patterns the same way.
    engine = shutil.which("gojq") or shutil.which("jq")
    if engine is None:
        pytest.fail("neither gojq nor jq is installed, so claude-review.yml's filter can't be checked")
    reviews = [{"user": {"login": LOGIN}, "body": body, "commit_id": name} for name, (body, _) in BODIES.items()]
    run = subprocess.run([engine, "-r", jq_program()], input=json.dumps(reviews), capture_output=True, text=True,
                         check=True)
    counted = set(run.stdout.split("\n")) - {""}
    assert counted == {name for name, (_, is_note) in BODIES.items() if not is_note}
