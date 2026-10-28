"""Tests for the Owned ci.yml's job that runs the base branch's check_gh_repo.py against a PR's tree
(mpaulosky/dotfiles#344, R46/R61 and R58). No GitHub: the job's `run:` steps are read out of the YAML and run in bash
against scratch git repos, with a bare repo as `origin`, as the workflow runs them.

The job is found by the step that runs check_gh_repo.py. A step's `if:` may use only github.head_ref, github.base_ref,
github.event_name, string literals, ==, !=, &&, ||, ! and parentheses; anything else can't be evaluated here, so keep the
condition that simple, or test it in the script.
"""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
TEMPLATE_OWNED = HERE.parents[1] / "template" / "owned"
CI = TEMPLATE_OWNED / ".github" / "workflows" / "ci.yml"
CHECKER = TEMPLATE_OWNED / ".github" / "scripts" / "check_gh_repo.py"
CHECKER_PATH = ".github/scripts/check_gh_repo.py"

UNTOLD = "gh pr view 1\n"
TOLD = "export GH_REPO=o/r\ngh pr view 1\n"
GATE = "#!/usr/bin/env bash\necho gate\n"
EDITED_GATE = "#!/usr/bin/env bash\necho gate\nexit 0\n"
APPLY_BRANCHES = ["chore/standardize-baseline", "chore/reapply-baseline"]


def load_workflow():
    try:
        import yaml
    except ImportError:
        # test.sh may run pytest through uvx, which has no PyYAML: read the file with it in a one-off environment.
        script = "import json, sys, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))"
        done = subprocess.run(["uvx", "--with", "pyyaml", "python", "-I", "-c", script, str(CI)],
                              check=True, capture_output=True, text=True)
        return json.loads(done.stdout)
    return yaml.safe_load(CI.read_text())


WORKFLOW = load_workflow()


def checker_jobs():
    return {name: job for name, job in WORKFLOW["jobs"].items()
            if any("check_gh_repo.py" in str(step.get("run", "")) for step in job.get("steps", []))}


def the_job():
    jobs = checker_jobs()
    assert len(jobs) == 1, f"ci.yml must have exactly one job that runs check_gh_repo.py, not {sorted(jobs)}"
    return next(iter(jobs.values()))


def job_text(job):
    return json.dumps(job, sort_keys=True)


# The job and its trigger.

def test_ci_yml_has_a_job_that_runs_check_gh_repo_py():
    # Arrange, Act, Assert
    assert the_job()["steps"]


def test_the_job_runs_on_pull_requests_only():
    # Arrange
    job = the_job()

    # Act, Assert: ci.yml also runs on push to main and as a called workflow, where there is no base branch.
    assert re.search(r"github\.event_name\s*==\s*'pull_request'", str(job.get("if", ""))), \
        "the job needs an if: on github.event_name == 'pull_request'"


def test_the_pull_request_trigger_has_no_paths_filter():
    # Arrange
    trigger = WORKFLOW.get("on", WORKFLOW.get(True))["pull_request"] or {}

    # Act, Assert
    assert "paths-ignore" not in trigger
    assert "paths" not in trigger


def test_the_job_takes_its_checker_from_the_base_branch_not_the_pr():
    # Arrange
    job = the_job()
    text = "\n".join(str(step.get("run", "")) for step in job["steps"])

    # Act, Assert
    assert re.search(r"git show[^\n]*origin/[^\n]*:\.github/scripts/check_gh_repo\.py", text), \
        "the checker must come from `git show origin/<base ref>:.github/scripts/check_gh_repo.py`"
    assert "github.base_ref" in job_text(job) or "GITHUB_BASE_REF" in text
    assert "mktemp -d" in text, "the base checker goes to a temp directory outside the checkout"


def test_the_job_runs_the_checker_isolated_against_the_workspace():
    # Arrange
    text = "\n".join(str(step.get("run", "")) for step in the_job()["steps"])

    # Act, Assert
    assert re.search(r'python3 -I "?\$\{?\w+\}?/check_gh_repo\.py"? --repo "?\$\{?GITHUB_WORKSPACE\}?"?', text)
    assert not re.search(r"python3?[^\n]*\s\.?/?\.github/scripts/check_gh_repo\.py", text), \
        "the PR's own copy of the checker must not be run"


def test_the_job_has_no_secrets_and_no_write_permission():
    # Arrange
    job = the_job()

    # Act, Assert
    assert "secrets." not in job_text(job)
    assert job.get("permissions", {"contents": "read"}) in ({}, {"contents": "read"})


def test_the_jobs_checkouts_keep_no_credentials():
    # Arrange
    checkouts = [step for step in the_job()["steps"] if str(step.get("uses", "")).startswith("actions/checkout@")]

    # Act, Assert
    assert checkouts
    assert all(step.get("with", {}).get("persist-credentials") is False for step in checkouts)


# The job's steps, run.

class Job:
    """A PR to run the job on: a bare origin with the base branch, and a clone on the PR's head branch."""

    def __init__(self, tmp_path, base_files, head_files, head_ref="feature/344-x", base_ref="main"):
        self.tmp_path = tmp_path
        self.base_ref, self.head_ref = base_ref, head_ref
        self.origin, self.work = tmp_path / "origin.git", tmp_path / "work"
        self.git(tmp_path, "init", "-q", "--bare", "-b", base_ref, str(self.origin))
        self.work.mkdir()
        self.git(self.work, "init", "-q", "-b", base_ref)
        self.write(base_files)
        self.commit("base")
        self.git(self.work, "remote", "add", "origin", str(self.origin))
        self.git(self.work, "push", "-q", "origin", base_ref)
        self.git(self.work, "checkout", "-q", "-b", head_ref)
        self.write(head_files)
        self.commit("head")

    @staticmethod
    def git(cwd, *args):
        subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "protocol.file.allow=always",
                        *args], cwd=cwd, check=True, capture_output=True)

    def write(self, files):
        for name, content in files.items():
            path = self.work / name
            if content is None:
                path.unlink()
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)

    def commit(self, message):
        self.git(self.work, "add", "-A")
        self.git(self.work, "commit", "-q", "--allow-empty", "-m", message)

    def expression(self, text):
        values = {"github.base_ref": self.base_ref, "github.head_ref": self.head_ref,
                  "github.workspace": str(self.work), "github.event_name": "pull_request",
                  "github.event.pull_request.base.ref": self.base_ref,
                  "github.event.pull_request.head.ref": self.head_ref}

        def value(match):
            name = match.group(1)
            if name not in values:
                pytest.fail(f"the job uses ${{{{ {name} }}}}, which this test can't give: use one of {sorted(values)}")
            return values[name]

        return re.sub(r"\$\{\{\s*([\w.]+)\s*\}\}", value, text)

    def runs(self, step, failed):
        condition = step.get("if")
        always = condition is not None and re.search(r"always\(\)|failure\(\)", str(condition)) is not None
        if failed and not always:
            return False
        if condition is None:
            return True
        text = re.sub(r"^\$\{\{(.*)\}\}$", r"\1", str(condition).strip(), flags=re.S).strip()
        text = re.sub(r"always\(\)|failure\(\)|success\(\)", "true", text)
        text = re.sub(r"github\.(head_ref|base_ref|event_name)",
                      lambda match: repr(self.expression("${{ github." + match.group(1) + " }}")), text)
        residue = re.sub(r"'[^']*'|==|!=|&&|\|\||[!() ]|\btrue\b|\bfalse\b", "", text)
        if residue:
            pytest.fail(f"can't evaluate the step's if: {condition!r}; see this file's docstring")
        python = text.replace("&&", " and ").replace("||", " or ").replace("true", "True").replace("false", "False")
        python = re.sub(r"!(?!=)", " not ", python)
        return bool(eval(python, {"__builtins__": {}}))  # noqa: S307 - the expression was checked above

    def run(self):
        """Runs the job's run: steps in order; returns (exit code of the first failing step or 0, all output)."""
        runner = self.tmp_path / "runner"
        runner.mkdir()
        output, code = [], 0
        for index, step in enumerate(the_job()["steps"]):
            if "run" not in step or not self.runs(step, code != 0):
                continue
            script = self.tmp_path / f"step{index}.sh"
            script.write_text(self.expression(str(step["run"])))
            env = {"PATH": os.environ["PATH"], "HOME": str(self.tmp_path / "home"), "GITHUB_WORKSPACE": str(self.work),
                   "RUNNER_TEMP": str(runner), "GITHUB_BASE_REF": self.base_ref, "GITHUB_HEAD_REF": self.head_ref,
                   "GITHUB_EVENT_NAME": "pull_request", "GITHUB_OUTPUT": str(self.tmp_path / "out"),
                   "GITHUB_STEP_SUMMARY": str(self.tmp_path / "summary"), "GITHUB_ENV": str(self.tmp_path / "env")}
            env.update({name: self.expression(str(value)) for name, value in step.get("env", {}).items()})
            options = "-eo pipefail" if step.get("shell") == "bash" else "-e"
            done = subprocess.run(["bash", "--noprofile", "--norc", *options.split(), str(script)], cwd=self.work,
                                  env=env, capture_output=True, text=True)
            output.append(done.stdout + done.stderr)
            if done.returncode != 0 and code == 0:
                code = done.returncode
        return code, "".join(output)


BASE = {CHECKER_PATH: CHECKER.read_text(), "scripts/gate.sh": GATE, "scripts/ok.sh": TOLD}


def run_job(tmp_path, head_files=None, base_files=None, **kwargs):
    return Job(tmp_path, BASE if base_files is None else base_files, head_files or {}, **kwargs).run()


def differs_lines(output):
    return [line for line in output.splitlines() if "differs from" in line]


# R46/R61: the base branch's checker judges the PR's tree.

def test_the_job_fails_a_pr_with_an_untold_gh_line(tmp_path):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/new.sh": "echo hi\n" + UNTOLD})

    # Assert
    assert code != 0
    assert "scripts/new.sh:2: gh pr view 1" in output


def test_the_job_fails_a_pr_that_edits_the_checker_to_accept_everything_on_the_same_line(tmp_path):
    # Arrange
    files = {CHECKER_PATH: "import sys\nsys.exit(0)\n", "scripts/new.sh": UNTOLD}

    # Act
    code, output = run_job(tmp_path, files)

    # Assert
    assert code != 0
    assert "scripts/new.sh:1: gh pr view 1" in output


def test_the_job_fails_a_pr_that_deletes_the_checker_and_adds_an_untold_gh_line(tmp_path):
    # Arrange
    files = {CHECKER_PATH: None, "scripts/new.sh": UNTOLD}

    # Act
    code, output = run_job(tmp_path, files)

    # Assert
    assert code != 0
    assert "scripts/new.sh:1: gh pr view 1" in output


def test_the_job_passes_a_pr_with_only_told_gh_lines(tmp_path):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/new.sh": TOLD, ".claude/skills/mine/SKILL.md": "`gh pr view 1 --repo o/r`\n"})

    # Assert
    assert code == 0, output


def test_the_job_judges_a_pr_that_changes_the_checker_by_the_old_one(tmp_path):
    # Arrange: the PR's checker would refuse everything, the base's refuses only what it should.
    files = {CHECKER_PATH: "import sys\nsys.exit(1)\n", "scripts/new.sh": TOLD}

    # Act
    code, output = run_job(tmp_path, files)

    # Assert
    assert code == 0, output


def test_the_job_leaves_the_checkout_as_it_found_it(tmp_path):
    # Arrange
    job = Job(tmp_path, BASE, {"scripts/new.sh": TOLD})

    # Act
    code, output = job.run()
    status = subprocess.run(["git", "status", "--porcelain", "--ignored"], cwd=job.work, check=True,
                            capture_output=True, text=True).stdout

    # Assert: the base checker was written outside the checkout, not beside the PR's files.
    assert code == 0, output
    assert status == ""


def test_the_job_names_the_base_branch_it_takes_the_checker_from(tmp_path):
    # Arrange: develop's checker refuses an untold line, and the head branch's own checker accepts it.
    files = {CHECKER_PATH: "import sys\nsys.exit(0)\n", "scripts/new.sh": UNTOLD}

    # Act
    code, output = run_job(tmp_path, files, base_ref="develop")

    # Assert
    assert code != 0
    assert "scripts/new.sh:1: gh pr view 1" in output


# R58: an Owned file is the base's, unless the PR is an Apply PR.

def test_the_job_fails_a_feature_pr_that_edits_an_owned_file(tmp_path):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": EDITED_GATE})

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from main" in output


def test_the_job_names_the_base_branch_in_the_owned_file_message(tmp_path):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": EDITED_GATE}, base_ref="develop")

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from develop" in output


@pytest.mark.parametrize("head_ref", ["feature/344-x", "fix/1-y", "hotfix/2-z", "chore/other", "chore/reapply-baseline-2",
                                      "feature/chore/reapply-baseline", "chore/standardize"])
def test_the_job_checks_owned_files_for_every_head_branch_but_the_two_apply_branches(tmp_path, head_ref):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": EDITED_GATE}, head_ref=head_ref)

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from main" in output


@pytest.mark.parametrize("head_ref", APPLY_BRANCHES)
def test_the_job_passes_the_same_owned_file_edit_from_an_apply_branch(tmp_path, head_ref):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": EDITED_GATE}, head_ref=head_ref)

    # Assert
    assert code == 0, output
    assert differs_lines(output) == []


@pytest.mark.parametrize("head_ref", APPLY_BRANCHES)
def test_the_job_still_runs_the_checker_on_an_apply_branch(tmp_path, head_ref):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": EDITED_GATE, "scripts/new.sh": UNTOLD}, head_ref=head_ref)

    # Assert
    assert code != 0
    assert "scripts/new.sh:1: gh pr view 1" in output


def test_the_job_passes_a_pr_that_leaves_every_owned_file_alone(tmp_path):
    # Arrange, Act
    code, output = run_job(tmp_path, {"README.md": "# hi\n", "scripts/ok.sh": TOLD + "echo more\n"})

    # Assert
    assert code == 0, output
    assert differs_lines(output) == []


def test_the_job_passes_a_pr_that_adds_an_owned_file_the_base_lacks(tmp_path):
    # Arrange: the first Apply has no base copy to differ from.
    base = {CHECKER_PATH: CHECKER.read_text(), "scripts/ok.sh": TOLD}

    # Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": GATE, "scripts/review.sh": GATE}, base_files=base)

    # Assert
    assert code == 0, output


def test_the_job_names_each_edited_owned_file_once(tmp_path):
    # Arrange
    base = {**BASE, "scripts/review.sh": GATE}

    # Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": EDITED_GATE, "scripts/review.sh": EDITED_GATE}, base_files=base)

    # Assert
    assert code != 0
    assert len(differs_lines(output)) == 2
    assert sum("scripts/gate.sh" in line for line in differs_lines(output)) == 1
    assert sum("scripts/review.sh" in line for line in differs_lines(output)) == 1


def test_the_job_compares_a_file_in_an_owned_folder(tmp_path):
    # Arrange
    skill = ".claude/skills/pre-push-review/SKILL.md"
    base = {**BASE, skill: "# Review\n"}

    # Act
    code, output = run_job(tmp_path, {skill: "# Review\nSkip it.\n"}, base_files=base)

    # Assert
    assert code != 0
    assert f"Owned file {skill} differs from main" in output


def test_the_job_compares_owned_files_byte_for_byte(tmp_path):
    # Arrange: only a trailing newline differs.
    code, output = run_job(tmp_path, {"scripts/gate.sh": GATE.rstrip("\n")})

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from main" in output


def test_the_job_fails_a_pr_that_deletes_an_owned_file(tmp_path):
    # Arrange, Act
    code, output = run_job(tmp_path, {"scripts/gate.sh": None})

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from main" in output


def test_the_job_fails_a_pr_that_deletes_a_file_in_an_owned_folder(tmp_path):
    # Arrange
    skill = ".claude/skills/pre-push-review/SKILL.md"
    base = {**BASE, skill: "# Review\n"}

    # Act
    code, output = run_job(tmp_path, {skill: None}, base_files=base)

    # Assert
    assert code != 0
    assert f"Owned file {skill} differs from main" in output


def test_the_job_fails_a_pr_that_renames_an_owned_file(tmp_path):
    # Arrange
    job = Job(tmp_path, BASE, {})
    job.git(job.work, "mv", "scripts/gate.sh", "scripts/gate2.sh")
    job.commit("rename")

    # Act
    code, output = job.run()

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from main" in output


def test_the_job_fails_a_pr_that_chmods_an_owned_file(tmp_path):
    # Arrange: the content is the base's, only the mode changes.
    job = Job(tmp_path, BASE, {})
    (job.work / "scripts" / "gate.sh").chmod(0o755)
    job.commit("chmod +x")

    # Act
    code, output = job.run()

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from main" in output


def test_the_job_fails_a_pr_that_swaps_an_owned_file_for_a_symlink_with_the_same_content(tmp_path):
    # Arrange
    job = Job(tmp_path, BASE, {})
    (job.work / "scripts" / "gate.sh").unlink()
    (job.work / "scripts" / "gate.sh").symlink_to("../scripts/gate.sh.real")
    (job.work / "scripts" / "gate.sh.real").write_text(GATE)
    job.commit("symlink")

    # Act
    code, output = job.run()

    # Assert
    assert code != 0
    assert "Owned file scripts/gate.sh differs from main" in output


def test_the_job_fails_a_pr_that_adds_a_file_to_an_owned_folder(tmp_path):
    # Arrange: the checker skips the folder and the base's tree has no such file to differ from.
    added = ".claude/skills/pre-push-review/helper.sh"
    base = {**BASE, ".claude/skills/pre-push-review/SKILL.md": "# Review\n"}

    # Act
    code, output = run_job(tmp_path, {added: UNTOLD}, base_files=base)

    # Assert
    assert code != 0
    assert f"Owned file {added} differs from main" in output


def test_the_job_fails_a_pr_that_adds_a_file_to_the_other_owned_folder(tmp_path):
    # Arrange
    added = ".claude/skills/hardening-review/references/new.md"

    # Act
    code, output = run_job(tmp_path, {added: "`gh pr view 1`\n"})

    # Assert
    assert code != 0
    assert f"Owned file {added} differs from main" in output


def test_the_job_passes_an_apply_branch_that_adds_a_file_to_an_owned_folder(tmp_path):
    # Arrange, Act
    code, output = run_job(tmp_path, {".claude/skills/pre-push-review/new.md": "# New\n"},
                           head_ref="chore/reapply-baseline")

    # Assert
    assert code == 0, output


def test_the_job_names_an_added_owned_folder_file_once_among_the_edited(tmp_path):
    # Arrange
    skill = ".claude/skills/pre-push-review/SKILL.md"
    added = ".claude/skills/pre-push-review/new.md"
    base = {**BASE, skill: "# Review\n"}

    # Act
    code, output = run_job(tmp_path, {skill: "# Changed\n", added: "# New\n"}, base_files=base)

    # Assert
    assert code != 0
    assert sorted(differs_lines(output)) == sorted([f"Owned file {skill} differs from main",
                                                    f"Owned file {added} differs from main"])


def test_the_job_escapes_line_breaks_in_an_owned_file_name_it_reports(tmp_path):
    # Arrange: a name that would start a workflow command on its own log line.
    name = ".claude/skills/pre-push-review/x\n::error::spoofed.sh"

    # Act
    code, output = run_job(tmp_path, {name: "# x\n"})

    # Assert
    assert code != 0
    assert "Owned file .claude/skills/pre-push-review/x\\n::error::spoofed.sh differs from main" in output
    assert not any(line.startswith("::") for line in output.splitlines())


def test_the_job_escapes_a_carriage_return_in_a_reported_line_and_file_name(tmp_path):
    # Arrange
    files = {"scripts/new.sh": "gh pr view 1\r::error::spoofed\n", "scripts/a\r::error::b.sh": UNTOLD}

    # Act
    code, output = run_job(tmp_path, files)

    # Assert
    assert code != 0
    assert "\r" not in output
    assert not any(line.startswith("::") for line in output.splitlines())
    assert "scripts/new.sh:1: gh pr view 1\\r::error::spoofed" in output
    assert "scripts/a\\r::error::b.sh:1: gh pr view 1" in output
