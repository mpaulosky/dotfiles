"""Tests for the hardening-review skill's mutation runner."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

# A command that runs and passes, so a malformed spec is refused for its own fault and not for a missing binary.
TEST = [sys.executable, "-c", "pass"]
SCRIPT = Path(__file__).resolve().parents[2] / "template/owned/.claude/skills/hardening-review/scripts/mutate.py"


def clean_env(**extra):
    """The developer's own git config and hook variables must not reach the throwaway repos."""
    # PYTHON* too: the runner sets the bytecode variables itself, and a test that inherited them could not tell.
    env = {key: value for key, value in os.environ.items() if not key.startswith(("GIT_", "PYTHON"))}
    env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    env.update(extra)
    return env


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True, env=clean_env())


CHECK = (
    "import sys\nsys.path.insert(0, '.')\nimport target as c\n"
    "sys.exit(0 if c.f(1) and not c.f(0) and not c.f(-1) else 1)\n"
)


def make_repo(tmp_path, source="def f(x):\n    return x > 0\n", check=CHECK):
    """A repo whose test passes while f(x) returns x > 0, and fails when it doesn't."""
    root = tmp_path / "r"
    root.mkdir()
    git(root, "init", "-q")
    (root / "target.py").write_bytes(source.encode("utf-8"))
    (root / "check.py").write_text(check, encoding="utf-8")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "x")
    return root


def spec(mutations, **extra):
    # Not -I: isolated mode ignores PYTHONDONTWRITEBYTECODE, which the runner sets so same-size mutations never load a stale .pyc.
    return {"test": [sys.executable, "check.py"], "mutations": mutations, **extra}


def mutation(old, new, **extra):
    return {"path": "target.py", "old": old, "new": new, "why": "w", **extra}


def write_spec(root, value):
    spec_file = root.parent / (root.name + "-spec.json")
    spec_file.write_text(value if isinstance(value, str) else json.dumps(value), encoding="utf-8")
    return spec_file


def run(root, value, *extra, env=None):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), str(write_spec(root, value)), "--root", str(root), *extra],
                          capture_output=True, text=True, env=env or clean_env())


def test_caught_mutation_exits_zero_and_restores_the_file(tmp_path):
    root = make_repo(tmp_path)
    before = (root / "target.py").read_bytes()
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CAUGHT" in result.stdout
    assert (root / "target.py").read_bytes() == before


def test_survivor_exits_one(tmp_path):
    root = make_repo(tmp_path, "def f(x):\n    return x > 0  # keep\n")
    result = run(root, spec([mutation("# keep", "# gone")]))
    assert result.returncode == 1
    assert "SURVIVED" in result.stdout


def test_survivor_marked_equivalent_is_reported_not_failed(tmp_path):
    root = make_repo(tmp_path, "def f(x):\n    return x > 0  # keep\n")
    result = run(root, spec([mutation("# keep", "# gone", equivalent="a comment")]))
    assert result.returncode == 0
    assert "EQUIVALENT" in result.stdout and "a comment" in result.stdout


def test_equivalent_mark_does_not_hide_a_caught_mutation(tmp_path):
    root = make_repo(tmp_path)
    result = run(root, spec([mutation("x > 0", "x >= 0", equivalent="because")]))
    assert result.returncode == 0
    assert "CAUGHT" in result.stdout and "EQUIVALENT" not in result.stdout


def test_equivalent_mark_does_not_hide_a_missing_mutation(tmp_path):
    root = make_repo(tmp_path)
    result = run(root, spec([mutation("nowhere", "x", equivalent="because")]))
    assert result.returncode == 1
    assert "NOT FOUND" in result.stdout


def test_old_string_missing_exits_one(tmp_path):
    root = make_repo(tmp_path)
    result = run(root, spec([mutation("nowhere", "x")]))
    assert result.returncode == 1
    assert "NOT FOUND" in result.stdout


def test_old_string_occurring_twice_is_ambiguous(tmp_path):
    root = make_repo(tmp_path, "def f(x):\n    return x > 0 and x > 0\n")
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 1
    assert "AMBIGUOUS" in result.stdout


def test_identical_old_and_new_is_invalid(tmp_path):
    root = make_repo(tmp_path)
    result = run(root, spec([mutation("x > 0", "x > 0")]))
    assert result.returncode == 1
    assert "INVALID" in result.stdout


def test_refuses_a_dirty_target_and_leaves_it_alone(tmp_path):
    root = make_repo(tmp_path)
    (root / "target.py").write_text("def f(x):\n    return x > 0  # edited\n", encoding="utf-8")
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 2
    assert "uncommitted" in result.stderr
    assert "# edited" in (root / "target.py").read_text(encoding="utf-8")


def test_refuses_an_untracked_target(tmp_path):
    root = make_repo(tmp_path)
    (root / "new.py").write_text("y = 1\n", encoding="utf-8")
    result = run(root, spec([{"path": "new.py", "old": "1", "new": "2", "why": "w"}]))
    assert result.returncode == 2
    assert "not tracked" in result.stderr


def test_a_glob_in_the_path_does_not_match_a_tracked_sibling(tmp_path):
    # git reads a pathspec's `*` as a glob: the tracked ab.py would make an untracked a*.py look tracked and clean.
    root = make_repo(tmp_path)
    (root / "ab.py").write_text("y = 1\n", encoding="utf-8")
    git(root, "add", "ab.py")
    git(root, "commit", "-q", "-m", "ab")
    (root / "a*.py").write_text("y = 1\n", encoding="utf-8")
    result = run(root, spec([{"path": "a*.py", "old": "1", "new": "2", "why": "w"}]))
    assert result.returncode == 2
    assert "not tracked" in result.stderr


def test_refuses_a_path_outside_the_root(tmp_path):
    root = make_repo(tmp_path)
    (tmp_path / "outside.py").write_text("a = 1\n", encoding="utf-8")
    result = run(root, spec([{"path": "../outside.py", "old": "1", "new": "2", "why": "w"}]))
    assert result.returncode == 2
    assert "is outside" in result.stderr
    assert (tmp_path / "outside.py").read_text(encoding="utf-8") == "a = 1\n"


def test_refuses_an_absolute_path_outside_the_root(tmp_path):
    root = make_repo(tmp_path)
    outside = tmp_path / "outside.py"
    outside.write_text("a = 1\n", encoding="utf-8")
    result = run(root, spec([{"path": str(outside), "old": "1", "new": "2", "why": "w"}]))
    assert result.returncode == 2
    assert "is outside" in result.stderr
    assert outside.read_text(encoding="utf-8") == "a = 1\n"


@pytest.mark.parametrize("destination", ["outside.py", "inside-git"])
def test_refuses_a_tracked_symlink_that_leaves_the_root(tmp_path, destination):
    root = make_repo(tmp_path)
    outside = tmp_path / "outside.py"
    outside.write_text("a = 1\n", encoding="utf-8")
    link_to = outside if destination == "outside.py" else root / ".git" / "config"
    (root / "link.py").symlink_to(link_to)
    git(root, "add", "link.py")
    git(root, "commit", "-q", "-m", "link")
    before = link_to.read_bytes()
    old = "1" if destination == "outside.py" else "bare"
    result = run(root, spec([{"path": "link.py", "old": old, "new": "2", "why": "w"}]))
    assert result.returncode == 2
    # A link into .git stays inside the root, and is refused because git doesn't track .git's files.
    assert ("is outside" if destination == "outside.py" else "not tracked") in result.stderr
    assert link_to.read_bytes() == before


def test_refuses_a_missing_target_and_a_directory(tmp_path):
    root = make_repo(tmp_path)
    (root / "pkg").mkdir()
    for path in ("missing.py", "pkg"):
        result = run(root, spec([{"path": path, "old": "1", "new": "2", "why": "w"}]))
        assert result.returncode == 2, path
        assert "not a file" in result.stderr


def test_refuses_a_target_that_is_not_utf8(tmp_path):
    root = make_repo(tmp_path)
    (root / "blob.bin").write_bytes(b"\xff\xfe\x00 abc")
    git(root, "add", "blob.bin")
    git(root, "commit", "-q", "-m", "blob")
    result = run(root, spec([{"path": "blob.bin", "old": "abc", "new": "xyz", "why": "w"}]))
    assert result.returncode == 2
    assert "not UTF-8" in result.stderr


def test_refuses_a_root_that_is_not_a_repository(tmp_path):
    folder = tmp_path / "plain"
    folder.mkdir()
    (folder / "target.py").write_text("a = 1\n", encoding="utf-8")
    result = run(folder, spec([mutation("1", "2")]))
    assert result.returncode == 2
    assert "not in a git repository" in result.stderr


def test_refuses_when_the_tests_already_fail(tmp_path):
    root = make_repo(tmp_path, "def f(x):\n    return x >= 0\n")
    result = run(root, spec([mutation("x >= 0", "x > 0")]))
    assert result.returncode == 2
    assert "fail before" in result.stderr


def test_a_baseline_that_times_out_is_said_so(tmp_path):
    root = make_repo(tmp_path, check="import time\ntime.sleep(60)\n")
    result = run(root, spec([mutation("x > 0", "x >= 0")], timeout=1))
    assert result.returncode == 2
    assert "did not finish" in result.stderr


def test_a_missing_test_command_is_refused(tmp_path):
    root = make_repo(tmp_path)
    result = run(root, {"test": ["no-such-binary-hardening"], "mutations": [mutation("x > 0", "x >= 0")]})
    assert result.returncode == 2
    assert "cannot run the test command" in result.stderr


def test_the_test_command_runs_without_a_shell(tmp_path):
    root = make_repo(tmp_path, check=(
        "import pathlib, sys\nsys.path.insert(0, '.')\nimport target as c\n"
        "pathlib.Path('argv.txt').write_text(repr(sys.argv[1:]))\n"
        "sys.exit(0 if c.f(1) and not c.f(0) else 1)\n"))
    marker = tmp_path / "pwned"
    argument = f"$(touch {marker}); touch {marker}"
    result = run(root, {"test": [sys.executable, "-I", "check.py", argument], "mutations": [mutation("x > 0", "x >= 0")]})
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / "argv.txt").read_text(encoding="utf-8") == repr([argument])
    assert not marker.exists()
    marker2 = tmp_path / "pwned2"
    result = run(root, {"test": [f"; touch {marker2}"], "mutations": [mutation("x > 0", "x >= 0")]})
    assert result.returncode == 2
    assert not marker2.exists()


def test_timeout_counts_as_caught_and_restores(tmp_path):
    root = make_repo(tmp_path, check=(
        "import sys, time\nsys.path.insert(0, '.')\nimport target as c\n"
        "if not c.f(0):\n    sys.exit(0)\ntime.sleep(60)\n"))
    before = (root / "target.py").read_bytes()
    result = run(root, spec([mutation("x > 0", "x >= 0")], timeout=3))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CAUGHT" in result.stdout and "timed out" in result.stdout
    assert (root / "target.py").read_bytes() == before


def test_a_grandchild_does_not_outlive_a_timeout_or_a_passing_run(tmp_path):
    # `pnpm run test` is a process tree: killing only the direct child leaves the rest running against the next file.
    grandchild = (
        "import subprocess, sys\n"
        "subprocess.Popen([sys.executable, '-c', 'import time, pathlib; time.sleep(4); pathlib.Path(\"marker-\" + __import__(\"os\").environ[\"WHO\"]).write_text(\"x\")'],"
        " env={**__import__('os').environ, 'WHO': WHO})\n")
    root = make_repo(tmp_path, check=(
        "import sys, time\nsys.path.insert(0, '.')\nimport target as c\n"
        "WHO = 'baseline' if c.f(0) is False else 'mutated'\n" + grandchild
        + "if c.f(0):\n    time.sleep(60)\nsys.exit(0)\n"))
    result = run(root, spec([mutation("x > 0", "x >= 0")], timeout=2))
    assert result.returncode == 0, result.stdout + result.stderr
    time.sleep(5)
    assert not list(root.glob("marker-*")), "a grandchild outlived the run"


def test_the_tests_run_without_writing_bytecode(tmp_path):
    # A same-size mutation inside the same second as the last run can load the stale .pyc.
    root = make_repo(tmp_path, check=(
        "import os, pathlib, sys\nsys.path.insert(0, '.')\nimport target as c\n"
        "pathlib.Path('env.txt').write_text(os.environ.get('PYTHONDONTWRITEBYTECODE', '') + '|' + os.environ.get('PYTHONPYCACHEPREFIX', ''))\n"
        "sys.exit(0 if c.f(1) and not c.f(0) else 1)\n"))
    result = run(root, spec([mutation("x > 0", "x < 0")]))
    assert result.returncode == 0, result.stdout + result.stderr
    flag, prefix = (root / "env.txt").read_text(encoding="utf-8").split("|")
    assert flag == "1" and prefix
    assert not list(root.rglob("__pycache__"))


def test_git_hook_variables_do_not_redirect_the_runner(tmp_path):
    root = make_repo(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    git(other, "init", "-q")
    env = clean_env(GIT_DIR=str(other / ".git"), GIT_WORK_TREE=str(other), GIT_INDEX_FILE=str(other / ".git" / "index"))
    result = run(root, spec([mutation("x > 0", "x >= 0")]), env=env)
    assert result.returncode == 0, result.stdout + result.stderr


def test_preserves_crlf_and_non_ascii_bytes_in_the_mutated_file_and_the_restored_one(tmp_path):
    source = "def f(x):\r\n    return x > 0  # café\r\n"
    root = make_repo(tmp_path, source, check=(
        "import pathlib, sys\nsys.path.insert(0, '.')\nimport target as c\n"
        "pathlib.Path('seen.bin').write_bytes(pathlib.Path('target.py').read_bytes())\n"
        "sys.exit(0 if c.f(1) and not c.f(0) else 1)\n"))
    before = (root / "target.py").read_bytes()
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / "seen.bin").read_bytes() == before.replace(b"x > 0", b"x >= 0")
    assert (root / "target.py").read_bytes() == before


def test_each_mutation_is_undone_before_the_next_runs(tmp_path):
    # A stale mutation in one file would make a harmless one in another look caught.
    root = make_repo(tmp_path)
    (root / "other.py").write_text("value = 1  # keep\n", encoding="utf-8")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "other")
    result = run(root, spec([mutation("x > 0", "x >= 0"),
                             {"path": "other.py", "old": "# keep", "new": "# gone", "why": "w"}]))
    assert result.returncode == 1, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    assert lines[0].startswith("CAUGHT") and lines[1].startswith("SURVIVED"), result.stdout


@pytest.mark.parametrize("bad", [
    {}, [], "text",
    {"test": "check.py", "mutations": []},
    {"test": [], "mutations": [{"path": "target.py", "old": "a", "new": "b"}]},
    {"test": TEST, "mutations": []},
    {"test": TEST, "mutations": [{"path": "target.py"}]},
    {"test": TEST, "mutations": [{"path": "", "old": "a", "new": "b"}]},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "", "new": "b"}]},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a", "new": "b", "equivalent": "  "}]},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a", "new": "b"}], "timeout": 0},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a", "new": "b"}], "timeout": -1},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a", "new": "b"}], "timeout": True},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a", "new": "b"}], "timeout": "5"},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a", "new": "b"}], "timeout": 10 ** 9},
    {"test": ["x\u0000y"], "mutations": [{"path": "target.py", "old": "a", "new": "b"}]},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a\u0000", "new": "b"}]},
    {"test": TEST, "mutations": [{"path": "target.py", "old": "a", "new": "b\ud800"}]},
])
def test_a_malformed_spec_exits_two_not_one(tmp_path, bad):
    root = make_repo(tmp_path)
    result = run(root, json.dumps(bad))
    assert result.returncode == 2, result.stdout + result.stderr
    assert "refused" in result.stderr
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize("timeout", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_a_non_finite_timeout_exits_two(tmp_path, timeout):
    root = make_repo(tmp_path)
    text = '{"test": %s, "timeout": %s, "mutations": [{"path": "target.py", "old": "a", "new": "b"}]}' % (json.dumps(TEST), timeout)
    result = run(root, text)
    assert result.returncode == 2
    assert "Traceback" not in result.stderr


def test_an_unreadable_or_non_json_spec_exits_two(tmp_path):
    root = make_repo(tmp_path)
    assert run(root, "{not json").returncode == 2
    missing = subprocess.run([sys.executable, "-I", str(SCRIPT), str(tmp_path / "none.json"), "--root", str(root)],
                             capture_output=True, text=True, env=clean_env())
    assert missing.returncode == 2


def slow_check(root):
    (root / "check.py").write_text(
        "import sys, time, pathlib\nsys.path.insert(0, '.')\nimport target as c\n"
        "if c.f(0):\n    pathlib.Path('started').write_text('1'); time.sleep(20)\nsys.exit(0 if c.f(1) else 1)\n",
        encoding="utf-8")
    git(root, "commit", "-q", "-am", "slow")


def start_and_wait(root, tmp_path):
    spec_file = write_spec(root, spec([mutation("x > 0", "x >= 0")]))
    proc = subprocess.Popen([sys.executable, "-I", str(SCRIPT), str(spec_file), "--root", str(root)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=clean_env())
    for _ in range(300):
        if (root / "started").exists():
            return proc
        time.sleep(0.1)
    proc.kill()
    raise AssertionError("the mutated test run never started")


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM, signal.SIGHUP])
def test_restores_every_file_when_interrupted(tmp_path, sig):
    root = make_repo(tmp_path)
    slow_check(root)
    before = (root / "target.py").read_bytes()
    proc = start_and_wait(root, tmp_path)
    assert (root / "target.py").read_bytes() != before, "the mutation was not on disk when the signal came"
    proc.send_signal(sig)
    _, err = proc.communicate(timeout=20)
    assert proc.returncode == 130, err
    assert "interrupted" in err
    assert (root / "target.py").read_bytes() == before


def test_a_killed_runner_leaves_a_journal_that_the_next_run_names(tmp_path):
    root = make_repo(tmp_path)
    slow_check(root)
    before = (root / "target.py").read_bytes()
    proc = start_and_wait(root, tmp_path)
    proc.kill()
    proc.communicate(timeout=20)
    assert (root / "target.py").read_bytes() != before, "SIGKILL leaves the mutation on disk; the journal is what finds it"
    again = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert again.returncode == 2
    assert "killed" in again.stderr and "target.py" in again.stderr and "git checkout" in again.stderr
    # Restoring as the message says, and removing the journal it names, lets the next run start.
    git(root, "checkout", "--", "target.py")
    journal = [word for word in again.stderr.split() if word.endswith("mutate-journal.json")]
    assert journal, again.stderr
    Path(journal[0].strip("`'\".,")).unlink()
    # A mutation this check catches at once, since the slow one would sit out its sleep.
    assert run(root, spec([mutation("x > 0", "x > 5")])).returncode == 0


def test_a_clean_run_leaves_no_journal(tmp_path):
    root = make_repo(tmp_path)
    assert run(root, spec([mutation("x > 0", "x >= 0")])).returncode == 0
    assert not list((root / ".git").glob("mutate-journal*"))
