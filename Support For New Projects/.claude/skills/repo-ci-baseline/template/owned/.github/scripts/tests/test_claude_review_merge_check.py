"""Tests for claude-review.yml's merge-from-main check, run against real git repos.

The check is inline in the workflow, so its heredoc is read out of the file and
run, as the answer check's is in test_post_claude_review.py. It must agree with
PR Auto-Merge's rule (pr-automerge.yml's reviewCovering), which
pr-automerge.test.mjs covers on the same shapes of history.
"""

import os
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
    """The Python the "Skip a clean merge of main into a reviewed commit" step runs."""
    lines = WORKFLOW.read_text().splitlines()
    step = next(i for i, line in enumerate(lines) if line.strip() == "id: check")
    start = next(i for i in range(step, len(lines)) if lines[i].strip() == "python3 -I - <<'PY'") + 1
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "PY")
    return textwrap.dedent("\n".join(lines[start:end])) + "\n"


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

    def check(self, head, reviewed, tmp_path):
        """Run the step: (exit code, its skip output, what it printed)."""
        self.git("update-ref", "refs/remotes/origin/main", "main")
        runner_temp = tmp_path / "runner"
        runner_temp.mkdir(exist_ok=True)
        (runner_temp / "reviewed.txt").write_text("".join(f"{sha}\n" for sha in reviewed))
        output = runner_temp / "output"
        output.write_text("")
        env = {**GIT_ENV, "RUNNER_TEMP": str(runner_temp), "GITHUB_OUTPUT": str(output), "HEAD_SHA": head,
               "BASE_REF": "main"}
        done = subprocess.run([sys.executable, "-I", "-"], input=merge_check_script(), cwd=self.path, env=env,
                              capture_output=True, text=True)
        outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
        return done.returncode, outputs.get("skip"), done.stdout


# Enough of pr-automerge.yml for the check to see that it honours the skip.
PR_AUTO_MERGE = "name: PR Auto-Merge\n# async function reviewCovering(sha, reviewedCommits, base, depth = 0) {\n"


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
