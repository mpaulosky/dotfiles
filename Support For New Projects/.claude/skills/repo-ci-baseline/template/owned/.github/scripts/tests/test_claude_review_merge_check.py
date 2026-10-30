"""Tests for claude-review.yml's merge-from-main check, run against real git repos.

The check is inline in the workflow, so its heredoc is read out of the file and
run, as the answer check's is in test_post_claude_review.py. It must agree with
PR Auto-Merge's rule (pr-automerge.yml's reviewCovering), which
pr-automerge.test.mjs covers on the same shapes of history.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "claude-review.yml"

# No user or system config: a global hook or signing setting mustn't reach these repos.
GIT_ENV = {
    "PATH": os.environ["PATH"],
    "HOME": "/nonexistent",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def merge_check_script():
    """The Python the "Skip a stale head, or a clean merge of main into a reviewed commit" step runs."""
    lines = WORKFLOW.read_text().splitlines()
    step = next(i for i, line in enumerate(lines) if line.strip() == "id: check")
    start = next(i for i in range(step, len(lines)) if lines[i].strip() == "python3 -I - <<'PY'") + 1
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "PY")
    return textwrap.dedent("\n".join(lines[start:end])) + "\n"


def reviewed_filter():
    """The jq program of the step that lists the commits a reviewer reviewed (reviewed.txt)."""
    lines = WORKFLOW.read_text().splitlines()
    first = next(i for i, line in enumerate(lines) if line.strip() == "jq -r --arg head \"$CURRENT_HEAD\" '")
    last = next(i for i in range(first, len(lines)) if lines[i].rstrip().endswith("> \"${RUNNER_TEMP}/reviewed.txt\""))
    program = lines[first + 1:last + 1]
    program[-1] = program[-1].split("' \"${RUNNER_TEMP}/reviews.json\"", 1)[0]
    return textwrap.dedent("\n".join(program)) + "\n"


COPILOT = "copilot-pull-request-reviewer[bot]"
ACTIONS = "github-actions[bot]"
CLAUDE_MARKER = "<!-- claude-review -->"
QUOTA_NOTE = "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit."


def review(login, commit, body=""):
    return {"user": {"login": login}, "body": body, "commit_id": commit}


def reviewed_commits(reviews, head):
    """What the step's jq writes to reviewed.txt for these reviews (one page of them, as --slurp gives)."""
    jq = shutil.which("jq")
    if jq is None:
        pytest.skip("jq is not installed")
    done = subprocess.run([jq, "-r", "--arg", "head", head, reviewed_filter()], input=json.dumps([reviews]),
                          capture_output=True, text=True, check=True)
    return done.stdout.split()


class Repo:
    def __init__(self, path):
        self.path = path
        self.git("init", "-q", "-b", "main")
        self.git("config", "core.hooksPath", os.devnull)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.path, env=GIT_ENV, capture_output=True, text=True,
                              check=True).stdout.strip()

    def commit(self, files, message="change"):
        for name, content in files.items():
            path = self.path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if content is None:
                path.unlink()
            else:
                path.write_text(content)
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def merge(self, branch, edit=None):
        """Merge branch into the checked-out one, then fold edit into the merge commit."""
        self.git("merge", "-q", "--no-ff", "--no-edit", branch)
        if edit:
            for name, content in edit.items():
                (self.path / name).write_text(content)
            self.git("add", "-A")
            self.git("commit", "-q", "--amend", "--no-edit")
        return self.git("rev-parse", "HEAD")

    def check(self, head, reviewed, tmp_path, current=None, runs=(), outputs=None, noted=None):
        """Run the step: (exit code, its skip output, what it printed). current: the PR's head by then; runs: how
        the check job went in each run for current; outputs: a dict to fill with every output; noted: the commits
        carrying Copilot's quota note (the head when not given)."""
        self.git("update-ref", "refs/remotes/origin/main", "main")
        runner_temp = tmp_path / "runner"
        runner_temp.mkdir(exist_ok=True)
        (runner_temp / "reviewed.txt").write_text("".join(f"{sha}\n" for sha in reviewed))
        (runner_temp / "noted.txt").write_text("".join(f"{sha}\n" for sha in (noted if noted is not None else [head])))
        (runner_temp / "current-runs.txt").write_text("".join(f"{state}\n" for state in runs))
        output = runner_temp / "output"
        output.write_text("")
        env = {**GIT_ENV, "RUNNER_TEMP": str(runner_temp), "GITHUB_OUTPUT": str(output), "HEAD_SHA": head,
               "BASE_REF": "main", "CURRENT_HEAD": current or head}
        done = subprocess.run([sys.executable, "-I", "-"], input=merge_check_script(), cwd=self.path, env=env,
                              capture_output=True, text=True)
        found = dict(line.split("=", 1) for line in output.read_text().splitlines())
        if outputs is not None:
            outputs.update(found)
        outputs = found
        return done.returncode, outputs.get("skip"), done.stdout


# Enough of pr-automerge.yml for the check to see that it honours the skip: it has reviewCovering and the review
# loop (reviewLoopState), which counts a Claude review of an earlier commit as cover for a merge from main on top of it
# (mpaulosky/dotfiles#375).
PR_AUTO_MERGE = (
    "name: PR Auto-Merge\n"
    "# async function reviewCovering(sha, reviewedCommits, base, depth = 0) {\n"
    "# async function reviewLoopState(pullNumber, pr) {\n"
)


@pytest.fixture
def repo(tmp_path):
    """main: base (with PR Auto-Merge), then main1 changing lib. The PR branch: rev changing app, checked out."""
    path = tmp_path / "repo"
    path.mkdir()
    repo = Repo(path)
    repo.base = repo.commit({"app": "app 0\n", "lib": "lib 0\n", "shared": "one\ntwo\nthree\nfour\nfive\n",
                             ".github/workflows/pr-automerge.yml": PR_AUTO_MERGE}, "base")
    repo.git("checkout", "-q", "-b", "feature")
    repo.rev = repo.commit({"app": "app 1\n"}, "rev")
    repo.git("checkout", "-q", "main")
    repo.main1 = repo.commit({"lib": "lib 1\n", "docs": "docs\n"}, "main1")
    repo.git("checkout", "-q", "feature")
    return repo


def test_skips_a_clean_merge_of_main_into_a_reviewed_commit(repo, tmp_path):
    head = repo.merge("main")
    code, skip, out = repo.check(head, [repo.rev], tmp_path)
    assert (code, skip) == (0, "true")
    assert out.startswith("::notice::") and repo.rev in out


def test_skips_a_chain_of_clean_merges(repo, tmp_path):
    repo.merge("main")
    repo.git("checkout", "-q", "main")
    repo.commit({"lib": "lib 2\n"}, "main2")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("main")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "true")


def test_skips_a_merge_that_takes_mains_deletion(repo, tmp_path):
    repo.git("checkout", "-q", "main")
    repo.commit({"lib": None}, "drop lib")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("main")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "true")


def test_skips_a_head_that_was_reviewed(repo, tmp_path):
    assert repo.check(repo.rev, [repo.rev], tmp_path)[:2] == (0, "true")


def test_reviews_a_merge_that_also_changes_a_file(repo, tmp_path):
    head = repo.merge("main", edit={"app": "app 2\n"})
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")


def test_reviews_a_merge_that_adds_a_file(repo, tmp_path):
    head = repo.merge("main", edit={"extra": "x\n"})
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")


def test_reviews_a_merge_where_both_sides_changed_a_file(repo, tmp_path):
    # Different lines, so git merges it cleanly; the rule can't tell that from an edit.
    repo.commit({"shared": "ONE\ntwo\nthree\nfour\nfive\n"}, "rev2")
    rev2 = repo.git("rev-parse", "HEAD")
    repo.git("checkout", "-q", "main")
    repo.commit({"shared": "one\ntwo\nthree\nfour\nFIVE\n"}, "main2")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("main")
    assert repo.check(head, [rev2], tmp_path)[:2] == (0, "false")


def test_reviews_a_merge_of_a_branch_not_on_main(repo, tmp_path):
    repo.git("checkout", "-q", "-b", "side", repo.base)
    repo.commit({"lib": "side\n"}, "side")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("side")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")


def test_reviews_a_merge_into_a_commit_nobody_reviewed(repo, tmp_path):
    head = repo.merge("main")
    assert repo.check(head, ["0" * 40], tmp_path)[:2] == (0, "false")


def test_reviews_a_merge_of_the_pr_into_mains_side(repo, tmp_path):
    repo.git("checkout", "-q", "-b", "backwards", repo.main1)
    head = repo.merge("feature")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")


def test_reviews_a_new_commit(repo, tmp_path):
    head = repo.commit({"app": "app 3\n"}, "fix")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")


def test_stops_past_the_chain_limit(repo, tmp_path):
    heads = []
    for n in range(6):
        repo.git("checkout", "-q", "main")
        repo.commit({"lib": f"lib {n + 2}\n"}, f"main{n + 2}")
        repo.git("checkout", "-q", "feature")
        heads.append(repo.merge("main"))
    assert repo.check(heads[4], [repo.rev], tmp_path)[:2] == (0, "true")
    assert repo.check(heads[5], [repo.rev], tmp_path)[:2] == (0, "false")


def test_fails_without_a_skip_when_git_errors(repo, tmp_path):
    code, skip, _ = repo.check("f" * 40, [repo.rev], tmp_path)
    assert code != 0 and skip is None


def test_reviews_a_clean_merge_where_main_has_no_pr_auto_merge(repo, tmp_path):
    # dotfiles carries this workflow without PR Auto-Merge, which alone honours the skip.
    repo.git("checkout", "-q", "main")
    repo.commit({".github/workflows/pr-automerge.yml": None}, "no PR Auto-Merge")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("main")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")
    assert repo.check(repo.rev, [repo.rev], tmp_path)[:2] == (0, "false")


def test_reviews_a_clean_merge_where_mains_pr_auto_merge_predates_the_rule(repo, tmp_path):
    # The re-Apply PR that brings the rule: main's PR Auto-Merge still wants a review of the exact head.
    repo.git("checkout", "-q", "main")
    repo.commit({".github/workflows/pr-automerge.yml": "name: PR Auto-Merge\n"}, "old PR Auto-Merge")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("main")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")


def test_reviews_a_clean_merge_where_mains_pr_auto_merge_has_the_old_gate(repo, tmp_path):
    # reviewCovering without the review loop: the old gate counts a Claude review of an earlier commit only with
    # Copilot's note on it, so the merge needs a review of its own (mpaulosky/dotfiles#375).
    repo.git("checkout", "-q", "main")
    repo.commit({".github/workflows/pr-automerge.yml":
                 "name: PR Auto-Merge\n# async function reviewCovering(sha, reviewedCommits, base, depth = 0) {\n"}, "old gate")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("main")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "false")


def test_skips_a_clean_merge_where_mains_pr_auto_merge_has_the_review_loop(repo, tmp_path):
    head = repo.merge("main")
    assert repo.check(head, [repo.rev], tmp_path)[:2] == (0, "true")


# The commits the step lists as reviewed (mpaulosky/dotfiles#375): a clean merge of main into any of them is skipped, so
# no paid review is spent on a merge head and no round is made of it.


def test_lists_a_claude_review_of_any_commit_not_only_the_head_or_a_noted_one():
    reviews = [
        review(ACTIONS, "older", CLAUDE_MARKER + "\nNo findings."),
        review(ACTIONS, "current", CLAUDE_MARKER + "\n<!-- claude-review:off-diff -->\n**Claude Review**"),
        review(COPILOT, "noted", QUOTA_NOTE),
        review(ACTIONS, "noted", CLAUDE_MARKER + "\nNo findings."),
    ]
    assert sorted(reviewed_commits(reviews, "current")) == ["current", "noted", "older"]


def test_lists_a_copilot_review_but_not_its_quota_note_or_anyone_elses_review():
    reviews = [
        review(COPILOT, "copilot-reviewed", "Copilot reviewed 3 files."),
        review(COPILOT, "note-only", QUOTA_NOTE),
        review(ACTIONS, "unmarked", "Some other workflow's review."),
        review("octo", "person", CLAUDE_MARKER + "\nQuoting the marker."),
    ]
    assert reviewed_commits(reviews, "current") == ["copilot-reviewed"]


def test_skips_a_clean_merge_into_a_commit_claude_reviewed_that_is_neither_the_head_nor_noted(repo, tmp_path):
    # The shape of mpaulosky/dotfiles#371: Claude reviewed the real commit, main was merged in.
    head = repo.merge("main")
    reviewed = reviewed_commits([review(ACTIONS, repo.rev, CLAUDE_MARKER + "\nNo findings.")], head)
    assert repo.check(head, reviewed, tmp_path, noted=[])[:2] == (0, "true")


def test_skips_a_chain_of_clean_merges_into_a_commit_claude_reviewed(repo, tmp_path):
    repo.merge("main")
    repo.git("checkout", "-q", "main")
    repo.commit({"lib": "lib 2\n"}, "main2")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("main")
    reviewed = reviewed_commits([review(ACTIONS, repo.rev, CLAUDE_MARKER + "\nA finding.")], head)
    assert repo.check(head, reviewed, tmp_path, noted=[])[:2] == (0, "true")


def test_still_reviews_a_merge_that_also_changes_a_file_whatever_claude_reviewed(repo, tmp_path):
    head = repo.merge("main", edit={"app": "app 2\n"})
    reviewed = reviewed_commits([review(ACTIONS, repo.rev, CLAUDE_MARKER + "\nNo findings.")], head)
    assert repo.check(head, reviewed, tmp_path, noted=[])[:2] == (0, "false")


def test_still_reviews_a_merge_of_a_branch_not_on_main_whatever_claude_reviewed(repo, tmp_path):
    repo.git("checkout", "-q", "-b", "side", repo.base)
    repo.commit({"lib": "side\n"}, "side")
    repo.git("checkout", "-q", "feature")
    head = repo.merge("side")
    reviewed = reviewed_commits([review(ACTIONS, repo.rev, CLAUDE_MARKER + "\nNo findings.")], head)
    assert repo.check(head, reviewed, tmp_path, noted=[])[:2] == (0, "false")


def test_still_reviews_a_merge_into_a_commit_nobody_reviewed(repo, tmp_path):
    head = repo.merge("main")
    reviewed = reviewed_commits([review(ACTIONS, "0" * 40, CLAUDE_MARKER + "\nNo findings."),
                                 review(ACTIONS, repo.rev, "Some other workflow's review.")], head)
    assert repo.check(head, reviewed, tmp_path, noted=[])[:2] == (0, "false")


def test_still_reviews_a_new_commit_on_top_of_a_reviewed_one(repo, tmp_path):
    head = repo.commit({"app": "app 3\n"}, "fix")
    reviewed = reviewed_commits([review(ACTIONS, repo.rev, CLAUDE_MARKER + "\nNo findings.")], head)
    assert repo.check(head, reviewed, tmp_path, noted=[])[:2] == (0, "false")


def test_a_label_added_to_a_clean_merge_head_still_asks_for_its_review():
    # Only a push can be a merge from main; the owner adding the label asks for a review of the current head, and the
    # step's shell says so before it reads a single review.
    step = WORKFLOW.read_text().split("id: check", 1)[1].split("python3 -I - <<'PY'", 1)[0]
    early = step.split("reviews.json", 1)[0]
    assert '[ "$ACTION" != "synchronize" ]' in early and 'echo "skip=false" >> "$GITHUB_OUTPUT"' in early


def test_the_workflow_says_the_label_comes_off_when_the_review_loop_is_exhausted_and_lists_every_claude_review():
    # mpaulosky/dotfiles#375: not "at the review cap and at MAX_CLAUDE_ROUNDS", and no Claude review "isn't listed".
    text = WORKFLOW.read_text()
    header = text.split('\n"on":', 1)[0]
    assert re.search(r"exhaust", header, re.IGNORECASE)
    assert "at the review cap" not in header
    assert "Claude's review of an earlier commit with no note isn't listed" not in text


# A stale head: the PR moved on to a newer head before this run's check.


def test_skips_a_stale_head_when_the_newer_push_adds_a_commit(repo, tmp_path):
    newer = repo.commit({"app": "app 3\n"}, "fix")
    code, skip, out = repo.check(repo.rev, [], tmp_path, current=newer)
    assert (code, skip) == (0, "true")
    assert "that push's run reviews it instead" in out


def test_reviews_a_stale_head_that_a_clean_merge_from_main_covers(repo, tmp_path):
    # An app's or Copilot's push of the merge starts no review, so this run reviews rev.
    newer = repo.merge("main")
    code, skip, out = repo.check(repo.rev, [], tmp_path, current=newer)
    assert (code, skip) == (0, "false")
    assert f"Claude reviews {repo.rev}" in out


def test_reviews_a_stale_head_under_a_chain_of_clean_merges(repo, tmp_path):
    repo.merge("main")
    repo.git("checkout", "-q", "main")
    repo.commit({"lib": "lib 2\n"}, "main2")
    repo.git("checkout", "-q", "feature")
    newer = repo.merge("main")
    assert repo.check(repo.rev, [], tmp_path, current=newer)[:2] == (0, "false")


def test_skips_a_stale_head_that_was_reviewed_under_a_clean_merge(repo, tmp_path):
    newer = repo.merge("main")
    assert repo.check(repo.rev, [repo.rev], tmp_path, current=newer)[:2] == (0, "true")


def test_skips_a_stale_head_under_a_merge_that_changes_a_file(repo, tmp_path):
    newer = repo.merge("main", edit={"app": "app 2\n"})
    assert repo.check(repo.rev, [], tmp_path, current=newer)[:2] == (0, "true")


def test_skips_a_stale_head_when_the_newer_head_isnt_fetched(repo, tmp_path):
    code, skip, out = repo.check(repo.rev, [], tmp_path, current="f" * 40)
    assert (code, skip) == (0, "true")
    assert "that push's run reviews it instead" in out


def test_skips_a_stale_head_where_main_has_no_pr_auto_merge(repo, tmp_path):
    # Without reviewCovering on main a review of rev wouldn't cover the merge.
    repo.git("checkout", "-q", "main")
    repo.commit({".github/workflows/pr-automerge.yml": None}, "no PR Auto-Merge")
    repo.git("checkout", "-q", "feature")
    newer = repo.merge("main")
    assert repo.check(repo.rev, [], tmp_path, current=newer)[:2] == (0, "true")


def test_marks_a_stale_heads_review_for_its_own_concurrency_group(repo, tmp_path):
    newer = repo.merge("main")
    outputs = {}
    assert repo.check(repo.rev, [], tmp_path, current=newer, runs=["skipped"], outputs=outputs)[:2] == (0, "false")
    assert outputs["stale"] == "true"
    outputs = {}
    repo.check(newer, [repo.rev], tmp_path, outputs=outputs)
    assert outputs["stale"] == "false"


def test_skips_a_stale_head_when_a_run_for_the_newer_head_reviews(repo, tmp_path):
    # A person pushed the merge: that run's check job ran, so it reviews, and two reviews would race.
    newer = repo.merge("main")
    for state in ("in_progress", "queued", "success"):
        code, skip, out = repo.check(repo.rev, [], tmp_path, current=newer, runs=["skipped", state])
        assert (code, skip) == (0, "true"), state
        assert f"a run for {newer} handles its review" in out


def test_stale_reviews_cant_cancel_the_newer_heads(repo):
    """The review and post jobs' concurrency groups for a stale head are keyed by it."""
    import re
    workflow = WORKFLOW.read_text()
    for job, needs in (("claude-review", "merge-from-main"), ("claude-review-post", "review")):
        pattern = (r"group: " + re.escape(job) + r"-\$\{\{ github\.event\.pull_request\.number \}\}\$\{\{ needs\."
                   + re.escape(needs) + r"\.outputs\.stale == 'true' && format\('-\{0\}', github\.event\.pull_request\.head\.sha\)")
        assert re.search(pattern, workflow), job
    assert "stale: ${{ steps.check.outputs.stale == 'true' }}" in workflow
    assert "stale: ${{ needs.merge-from-main.outputs.stale }}" in workflow


def test_reviews_a_bot_pushed_clean_merge_itself_when_the_stale_head_has_no_copilot_note(repo, tmp_path):
    # PR Auto-Merge counts a Claude review of an earlier commit only with Copilot's note on it (mpaulosky/dotfiles#318),
    # so a review of rev can't cover the newer clean merge. This run reviews the merge itself (mpaulosky/dotfiles#331).
    newer = repo.merge("main")
    outputs = {}
    code, skip, out = repo.check(repo.rev, [], tmp_path, current=newer, runs=["skipped"], noted=[], outputs=outputs)
    assert (code, skip) == (0, "false")
    assert "has no Copilot note" in out and f"Claude reviews {newer} itself" in out
    assert outputs["sha"] == newer
    assert outputs["base"] == repo.git("rev-parse", "main")
    assert outputs["stale"] == "true"


def test_reviews_the_merge_against_the_current_main_tip_not_the_stale_heads_base(repo, tmp_path):
    # The merge contains a newer main than the base the stale head's event carried, so the diff must start at main's tip.
    newer = repo.merge("main")
    repo.git("checkout", "-q", "main")
    repo.commit({"lib": "lib 2\n"}, "main2")
    repo.git("checkout", "-q", "feature")
    outputs = {}
    assert repo.check(repo.rev, [], tmp_path, current=newer, runs=["skipped"], noted=[], outputs=outputs)[:2] == (0, "false")
    assert outputs["base"] == repo.git("rev-parse", "main")
    assert outputs["base"] != repo.main1


def test_reviews_a_bot_pushed_clean_merge_under_a_chain_of_clean_merges_when_the_stale_head_has_no_note(repo, tmp_path):
    repo.merge("main")
    repo.git("checkout", "-q", "main")
    repo.commit({"lib": "lib 2\n"}, "main2")
    repo.git("checkout", "-q", "feature")
    newer = repo.merge("main")
    outputs = {}
    assert repo.check(repo.rev, [], tmp_path, current=newer, runs=["skipped"], noted=[], outputs=outputs)[:2] == (0, "false")
    assert outputs["sha"] == newer


def test_still_reviews_the_stale_head_that_carries_copilots_note(repo, tmp_path):
    newer = repo.merge("main")
    outputs = {}
    code, skip, out = repo.check(repo.rev, [], tmp_path, current=newer, runs=["skipped"], noted=[repo.rev], outputs=outputs)
    assert (code, skip) == (0, "false")
    assert f"Claude reviews {repo.rev}" in out
    assert outputs["sha"] == repo.rev
    assert outputs["base"] == ""


def test_reviews_the_event_head_when_it_is_the_pull_requests_head(repo, tmp_path):
    outputs = {}
    assert repo.check(repo.rev, [], tmp_path, outputs=outputs)[:2] == (0, "false")
    assert outputs["sha"] == repo.rev
    assert outputs["base"] == ""
    assert outputs["stale"] == "false"


@pytest.mark.parametrize("shape", ["merge that edits a file", "added commit", "run that reviews", "reviewed under", "no PR Auto-Merge on main"])
def test_still_skips_a_stale_head_without_naming_the_newer_head_to_review(repo, tmp_path, shape):
    kwargs = {"runs": ["skipped"], "noted": []}
    reviewed = []
    if shape == "merge that edits a file":
        newer = repo.merge("main", edit={"app": "app 2\n"})
    elif shape == "added commit":
        newer = repo.commit({"app": "app 3\n"}, "fix")
    elif shape == "run that reviews":
        newer = repo.merge("main")
        kwargs["runs"] = ["skipped", "success"]
    elif shape == "reviewed under":
        newer = repo.merge("main")
        reviewed = [repo.rev]
    else:
        repo.git("checkout", "-q", "main")
        repo.commit({".github/workflows/pr-automerge.yml": None}, "no PR Auto-Merge")
        repo.git("checkout", "-q", "feature")
        newer = repo.merge("main")
    outputs = {}
    code, skip, _ = repo.check(repo.rev, reviewed, tmp_path, current=newer, outputs=outputs, **kwargs)
    assert (code, skip) == (0, "true"), shape
    assert outputs.get("sha") != newer, shape


def test_merge_from_main_job_hands_the_commit_and_base_to_the_review_and_post_jobs():
    """The review checks out and diffs the commit the check names, and the post lands on it, each with the event's values as the fallback."""
    workflow = WORKFLOW.read_text()
    check_job = workflow.split("  merge-from-main:", 1)[1].split("\n  review:", 1)[0]
    review_job = workflow.split("\n  review:", 1)[1].split("\n  post:", 1)[0]
    post_job = workflow.split("\n  post:", 1)[1]
    assert "sha: ${{ steps.check.outputs.sha }}" in check_job
    assert "base: ${{ steps.check.outputs.base }}" in check_job
    assert "ref: ${{ needs.merge-from-main.outputs.sha || github.event.pull_request.head.sha }}" in review_job
    assert "HEAD_SHA: ${{ needs.merge-from-main.outputs.sha || github.event.pull_request.head.sha }}" in review_job
    assert "BASE_SHA: ${{ needs.merge-from-main.outputs.base || github.event.pull_request.base.sha }}" in review_job
    assert "sha: ${{ needs.merge-from-main.outputs.sha }}" in review_job
    assert "HEAD_SHA: ${{ needs.review.outputs.sha || github.event.pull_request.head.sha }}" in post_job


def test_concurrency_groups_stay_keyed_by_the_events_head():
    import re
    workflow = WORKFLOW.read_text()
    groups = re.findall(r"group: claude-review[^\n]*", workflow)
    assert groups and all("github.event.pull_request.head.sha" in group for group in groups)
    assert not any("outputs.sha" in group for group in groups)


def test_reviews_a_stale_head_that_carries_copilots_note(repo, tmp_path):
    newer = repo.merge("main")
    code, skip, out = repo.check(repo.rev, [], tmp_path, current=newer, runs=["skipped"], noted=[repo.rev])
    assert (code, skip) == (0, "false")
    assert f"Claude reviews {repo.rev}" in out


def test_skips_a_stale_head_a_review_under_its_own_clean_merge_covers(repo, tmp_path):
    # rev reviewed; head1 merges main into rev; head2 (an app's push) merges main into head1.
    head1 = repo.merge("main")
    repo.git("checkout", "-q", "main")
    repo.commit({"lib": "lib 2\n"}, "main2")
    repo.git("checkout", "-q", "feature")
    head2 = repo.merge("main")
    outputs = {}
    code, skip, out = repo.check(head1, [repo.rev], tmp_path, current=head2, runs=["skipped"], outputs=outputs)
    assert (code, skip) == (0, "true")
    assert f"the review of {repo.rev} covers it" in out
    assert outputs["stale"] == "false"
    # Unreviewed, head1 is reviewed instead.
    assert repo.check(head1, [], tmp_path, current=head2, runs=["skipped"])[:2] == (0, "false")


def test_marks_a_stale_head_before_any_other_api_call(repo):
    """stale=true is written as soon as the head is seen to be stale, so a later failure keeps the stale group."""
    step = WORKFLOW.read_text().split("id: check", 1)[1]
    stale_at = step.index('echo "stale=true" >> "$GITHUB_OUTPUT"')
    assert stale_at < step.index("actions/runs?head_sha=") < step.index("/reviews")


def test_check_job_can_read_actions_runs():
    workflow = WORKFLOW.read_text()
    job = workflow.split("  merge-from-main:", 1)[1].split("\n  review:", 1)[0]
    assert "      actions: read\n" in job
