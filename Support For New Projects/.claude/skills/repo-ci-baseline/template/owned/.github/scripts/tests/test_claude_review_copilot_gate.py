"""Tests for claude-review.yml's "Skip while Copilot can review" step (mpaulosky/dotfiles#378).

Claude reviews only where Copilot can't: its quota note is on the head, or it was asked, the ask settled and no
request is pending. While Copilot can review, review:claude means nothing and the workflow starts no paid review. The
step is inline in the workflow, so its script is read out of the file and run against a fake `gh` that serves canned
JSON by URL. It must agree with PR Auto-Merge's rule (pr-automerge.yml's copilotCannotReview), which
pr-automerge.test.mjs covers on the same shapes of state.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parents[2] / "workflows"
WORKFLOW = WORKFLOWS / "claude-review.yml"
AUTOMERGE = WORKFLOWS / "pr-automerge.yml"

REPOSITORY = "octo/demo"
PR = 7
HEAD = "a" * 40
OTHER = "b" * 40
ASK_MARKER = "<!-- pr-automerge:copilot-asked -->"
QUOTA_NOTE = "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit."

FAKE_GH = """#!/usr/bin/env python3
import json, os, shutil, subprocess, sys

routes = json.load(open(os.environ["FAKE_GH_ROUTES"]))
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if args[:1] != ["api"]:
    sys.stderr.write("unexpected gh call: %r\\n" % (args,))
    sys.exit(2)
path = args[1].split("?")[0].lstrip("/")
prefix = "repos/" + os.environ["REPOSITORY"] + "/"
route = routes.get(path[len(prefix):] if path.startswith(prefix) else path)
if route is None or "__error__" in route:
    sys.stderr.write((route or {}).get("__error__", "HTTP 404: Not Found") + "\\n")
    sys.exit(1)
if "__raw__" in route:
    print(route["__raw__"])
    sys.exit(0)
payload = route["payload"]
flags = args[2:]
if "--paginate" in flags and "--slurp" in flags:
    payload = [payload]
text = json.dumps(payload)
for flag in ("--jq", "-q"):
    if flag in flags:
        done = subprocess.run([shutil.which("jq"), "-r", flags[flags.index(flag) + 1]], input=text, capture_output=True, text=True)
        sys.stdout.write(done.stdout)
        sys.exit(done.returncode)
print(text)
"""


def copilot_gate_step():
    """(the Python the step runs, the step's lines) for the step with `id: copilot`."""
    lines = WORKFLOW.read_text().splitlines()
    marker = [i for i, line in enumerate(lines) if line.strip() == "id: copilot"]
    assert len(marker) == 1, "claude-review.yml needs exactly one step with `id: copilot`"
    step = marker[0]
    start = next(i for i in range(step, len(lines)) if re.fullmatch(r"python3 -I - <<'(\w+)'", lines[i].strip()))
    delimiter = re.fullmatch(r"python3 -I - <<'(\w+)'", lines[start].strip())[1]
    end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == delimiter)
    return textwrap.dedent("\n".join(lines[start + 1:end])) + "\n"


def ago(seconds):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds))


def ask_record(age=3600, login="github-actions[bot]"):
    return {"user": {"login": login}, "body": "PR Auto-Merge asked Copilot to review this PR.\n\n" + ASK_MARKER, "created_at": ago(age)}


def copilot_review(commit=HEAD, body="Looks good, two nits.", login="copilot-pull-request-reviewer[bot]"):
    return {"user": {"login": login}, "body": body, "commit_id": commit}


def quota_note(commit=HEAD):
    return copilot_review(commit, QUOTA_NOTE)


def requested(*logins):
    return {"users": [{"login": login} for login in logins], "teams": []}


def serve(*, current=HEAD, reviews=(), pending=(), comments=(), failing=(), raw=()):
    """The routes the fake gh serves, by path after repos/<owner>/<repo>/. failing: routes that error; raw: ones that print junk."""
    routes = {
        f"pulls/{PR}": {"payload": {"head": {"sha": current}}},
        f"pulls/{PR}/reviews": {"payload": list(reviews)},
        f"pulls/{PR}/requested_reviewers": {"payload": requested(*pending)},
        f"issues/{PR}/comments": {"payload": list(comments)},
    }
    for route in failing:
        routes[route] = {"__error__": "HTTP 502: Bad Gateway"}
    for route in raw:
        routes[route] = {"__raw__": "this is not json"}
    return routes


def run_step(tmp_path, routes, head=HEAD):
    """(the step's can_review output, what it printed, the gh calls it made)."""
    if shutil.which("jq") is None:
        pytest.skip("jq is not installed")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    gh = bin_dir / "gh"
    gh.write_text(FAKE_GH)
    gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
    routes_file = tmp_path / "routes.json"
    routes_file.write_text(json.dumps(routes))
    log = tmp_path / "gh.log"
    log.write_text("")
    output = tmp_path / "output"
    output.write_text("")
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "GH_TOKEN": "token",
        "REPOSITORY": REPOSITORY,
        "PR_NUMBER": str(PR),
        "HEAD_SHA": head,
        "GITHUB_OUTPUT": str(output),
        "RUNNER_TEMP": str(tmp_path),
        "FAKE_GH_ROUTES": str(routes_file),
        "FAKE_GH_LOG": str(log),
    }
    done = subprocess.run([sys.executable, "-I", "-"], input=copilot_gate_step(), env=env, capture_output=True, text=True, cwd=tmp_path)
    assert done.returncode == 0, done.stderr
    found = dict(line.split("=", 1) for line in output.read_text().splitlines())
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    return found.get("can_review"), done.stdout, calls


# ── Acceptance criterion 1: with Copilot available, no review starts ──

def test_a_pr_never_asked_for_copilots_review_is_one_copilot_can_review(tmp_path):
    # A person's add of review:claude on such a PR changes nothing.
    can_review, out, _ = run_step(tmp_path, serve())
    assert can_review == "true"
    assert out.startswith("::notice::") and f"#{PR}" in out


def test_a_pending_copilot_request_means_copilot_can_review(tmp_path):
    for pending in (["Copilot"], ["copilot-pull-request-reviewer"], ["copilot-pull-request-reviewer[bot]"]):
        can_review, _, _ = run_step(tmp_path, serve(comments=[ask_record(3600)], pending=pending))
        assert can_review == "true", pending


def test_a_pending_request_of_someone_else_is_not_copilots(tmp_path):
    assert run_step(tmp_path, serve(comments=[ask_record(3600)], pending=["octocat"]))[0] == "false"


def test_an_ask_less_than_30_seconds_old_means_copilot_can_review(tmp_path):
    assert run_step(tmp_path, serve(comments=[ask_record(10)]))[0] == "true"


def test_a_real_copilot_review_of_the_head_means_copilot_can_review_even_after_a_settled_ask(tmp_path):
    # A settled ask with no request pending is also what a finished Copilot review leaves behind (mpaulosky/dotfiles#270).
    assert run_step(tmp_path, serve(comments=[ask_record(3600)], reviews=[copilot_review()]))[0] == "true"


def test_an_ask_record_by_someone_else_is_no_record(tmp_path):
    assert run_step(tmp_path, serve(comments=[ask_record(3600, login="mallory")]))[0] == "true"


# ── Acceptance criterion 2: where Copilot can't review, Claude does ──

def test_a_settled_ask_with_no_request_pending_means_copilot_cant_review(tmp_path):
    can_review, _, _ = run_step(tmp_path, serve(comments=[ask_record(3600)]))
    assert can_review == "false"


def test_an_ask_record_by_the_repository_owner_counts(tmp_path):
    # land.sh writes the same record as the owner.
    assert run_step(tmp_path, serve(comments=[ask_record(3600, login="octo")]))[0] == "false"


def test_the_first_record_decides_when_there_are_several(tmp_path):
    assert run_step(tmp_path, serve(comments=[ask_record(3600), ask_record(5)]))[0] == "false"


def test_copilots_quota_note_on_the_head_means_copilot_cant_review_with_no_ask_at_all(tmp_path):
    assert run_step(tmp_path, serve(reviews=[quota_note()]))[0] == "false"


def test_copilots_quota_note_on_the_event_head_counts_after_the_pr_moved_on(tmp_path):
    # A stale run: the PR's head is another commit now, but the note is on the commit this run was started for.
    assert run_step(tmp_path, serve(current=OTHER, reviews=[quota_note(HEAD)]))[0] == "false"


def test_a_quota_note_on_an_older_commit_is_not_copilots_answer_for_the_head(tmp_path):
    assert run_step(tmp_path, serve(reviews=[quota_note("c" * 40)]))[0] == "true"


def test_a_pending_request_beats_the_settled_record(tmp_path):
    assert run_step(tmp_path, serve(comments=[ask_record(3600)], pending=["Copilot"]))[0] == "true"


def test_a_note_on_the_head_stands_whatever_is_pending(tmp_path):
    assert run_step(tmp_path, serve(reviews=[quota_note()], pending=["Copilot"]))[0] == "false"


# ── Unreadable state: no paid review is bought on a guess, and the person is told ──

@pytest.mark.parametrize("route", [f"pulls/{PR}", f"pulls/{PR}/reviews", f"pulls/{PR}/requested_reviewers", f"issues/{PR}/comments"])
def test_a_read_that_fails_gives_unknown_and_a_warning_naming_the_pr(tmp_path, route):
    can_review, out, _ = run_step(tmp_path, serve(comments=[ask_record(3600)], failing=[route]))
    assert can_review == "unknown"
    assert "::warning::" in out and f"#{PR}" in out


@pytest.mark.parametrize("route", [f"pulls/{PR}", f"pulls/{PR}/reviews", f"pulls/{PR}/requested_reviewers", f"issues/{PR}/comments"])
def test_a_read_that_prints_junk_gives_unknown_too(tmp_path, route):
    can_review, out, _ = run_step(tmp_path, serve(comments=[ask_record(3600)], raw=[route]))
    assert can_review == "unknown"
    assert "::warning::" in out


def test_the_warning_says_what_to_do_once_the_api_works(tmp_path):
    _, out, _ = run_step(tmp_path, serve(failing=[f"issues/{PR}/comments"]))
    assert re.search(r"push|re-?add|label", out, re.IGNORECASE)


def test_every_read_is_a_get_through_gh_api_for_this_pr(tmp_path):
    _, _, calls = run_step(tmp_path, serve(comments=[ask_record(3600)]))
    assert calls and all(call[0] == "api" for call in calls)
    paths = {call[1].split("?")[0].lstrip("/") for call in calls}
    for needed in (f"pulls/{PR}/reviews", f"pulls/{PR}/requested_reviewers", f"issues/{PR}/comments"):
        assert f"repos/{REPOSITORY}/{needed}" in paths, paths
    assert all(not any(arg in call for arg in ("-X", "--method", "POST", "PATCH", "DELETE")) for call in calls)


# ── The step's wiring in the workflow ──

def jobs_text():
    return WORKFLOW.read_text()


def merge_from_main_steps():
    """The steps of the merge-from-main job as {id or name: step lines}, in order."""
    lines = WORKFLOW.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line == "  merge-from-main:")
    end = next(i for i in range(start + 1, len(lines)) if re.fullmatch(r"  [a-z-]+:", lines[i]))
    job = lines[start:end]
    first = next(i for i, line in enumerate(job) if line.strip() == "steps:")
    steps, current = [], None
    for line in job[first + 1:]:
        if re.match(r"      - ", line):
            current = [line]
            steps.append(current)
        elif current is not None:
            current.append(line)
    return steps


def step_named(fragment):
    found = [step for step in merge_from_main_steps() if any(fragment in line for line in step)]
    assert len(found) == 1, f"{fragment!r}: {len(found)} steps"
    return found[0]


def test_the_copilot_step_runs_before_the_checkout_and_the_merge_check():
    steps = merge_from_main_steps()
    ids = [next((line.strip()[4:] for line in step if line.strip().startswith("id: ")), None) for step in steps]
    assert ids.index("copilot") == 0
    assert ids.count("check") == 1 and ids.index("copilot") < ids.index("check")
    assert any("actions/checkout" in line for line in steps[1]), "the checkout follows the Copilot step"


def test_the_copilot_step_fails_open_and_has_a_timeout():
    step = "\n".join(step_named("id: copilot"))
    assert "continue-on-error: true" in step and re.search(r"timeout-minutes: \d+", step)
    assert "GH_TOKEN: ${{ github.token }}" in step
    assert "python3 -I -" in step


@pytest.mark.parametrize("fragment", ["actions/checkout", "id: check"])
def test_the_checkout_and_the_merge_check_run_only_where_copilot_cant_review(fragment):
    step = "\n".join(step_named(fragment))
    assert "if: steps.copilot.outputs.can_review == 'false'" in step.replace('"', "'") or \
        re.search(r"if: \$\{\{\s*steps\.copilot\.outputs\.can_review == 'false'\s*\}\}", step), step


def test_the_jobs_skip_output_also_skips_while_copilot_can_review_or_the_state_is_unknown():
    text = jobs_text()
    skip = re.search(r"^      skip: (.*)$", text, re.MULTILINE)
    assert skip, "merge-from-main has no skip output"
    assert "steps.copilot.outputs.can_review != 'false'" in skip[1]
    assert "steps.check.outputs.skip == 'true'" in skip[1]


def test_the_quota_note_and_the_ask_marker_are_the_ones_pr_auto_merge_uses():
    script = copilot_gate_step()
    assert ASK_MARKER in script
    assert "Copilot was unable to review" in script
    source = AUTOMERGE.read_text()
    assert f'const COPILOT_ASKED_MARKER = "{ASK_MARKER}";' in source
    assert "COPILOT_NO_REVIEW" in source
    assert re.search(r"settle|30", script, re.IGNORECASE)


def test_the_header_says_claude_reviews_only_where_copilot_cant_and_the_label_is_ignored_otherwise():
    header = WORKFLOW.read_text().split('\n"on":', 1)[0]
    assert re.search(r"ignored while Copilot", header), "claude-review.yml's header must say the label is ignored while Copilot can review"
    assert re.search(r"never (gets|reviews)|only where Copilot can't|no exception", header, re.IGNORECASE)
