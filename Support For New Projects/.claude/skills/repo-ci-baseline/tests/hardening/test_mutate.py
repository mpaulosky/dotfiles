"""Tests for the hardening-review skill's mutation runner."""
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "template/owned/.claude/skills/hardening-review/scripts/mutate.py"


def git(root, *args):
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True,
                   env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin"})


def make_repo(tmp_path, source="def f(x):\n    return x > 0\n"):
    """A repo whose test passes while f(x) returns x > 0, and fails when it doesn't."""
    git(tmp_path, "init", "-q")
    (tmp_path / "target.py").write_text(source, encoding="utf-8")
    (tmp_path / "check.py").write_text(
        "import sys\nsys.path.insert(0, '.')\nimport target as c\n"
        "sys.exit(0 if c.f(1) and not c.f(0) and not c.f(-1) else 1)\n", encoding="utf-8")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "x")
    return tmp_path


def run(root, spec, *extra):
    spec_file = root / ".." / (root.name + "-spec.json")
    spec_file.write_text(json.dumps(spec), encoding="utf-8")
    return subprocess.run([sys.executable, "-I", str(SCRIPT), str(spec_file), "--root", str(root), *extra],
                          capture_output=True, text=True)


def spec(mutations, **extra):
    return {"test": [sys.executable, "-I", "check.py"], "mutations": mutations, **extra}


def mutation(old, new, **extra):
    return {"path": "target.py", "old": old, "new": new, "why": "w", **extra}


def test_caught_mutation_exits_zero_and_restores_the_file(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    before = (root / "target.py").read_bytes()
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CAUGHT" in result.stdout
    assert (root / "target.py").read_bytes() == before


def test_survivor_exits_one(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r", "def f(x):\n    return x > 0  # keep\n")
    result = run(root, spec([mutation("# keep", "# gone")]))
    assert result.returncode == 1
    assert "SURVIVED" in result.stdout


def test_survivor_marked_equivalent_is_reported_not_failed(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r", "def f(x):\n    return x > 0  # keep\n")
    result = run(root, spec([mutation("# keep", "# gone", equivalent="a comment")]))
    assert result.returncode == 0
    assert "EQUIVALENT" in result.stdout and "a comment" in result.stdout


def test_equivalent_mark_does_not_hide_a_caught_or_missing_mutation(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    result = run(root, spec([mutation("nowhere", "x", equivalent="because")]))
    assert result.returncode == 1
    assert "NOT FOUND" in result.stdout


def test_old_string_missing_exits_one(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    result = run(root, spec([mutation("nowhere", "x")]))
    assert result.returncode == 1
    assert "NOT FOUND" in result.stdout


def test_old_string_occurring_twice_is_ambiguous(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r", "def f(x):\n    return x > 0 and x > 0\n")
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 1
    assert "AMBIGUOUS" in result.stdout


def test_identical_old_and_new_is_invalid(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    result = run(root, spec([mutation("x > 0", "x > 0")]))
    assert result.returncode == 1
    assert "INVALID" in result.stdout


def test_refuses_a_dirty_target_and_leaves_it_alone(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    (root / "target.py").write_text("def f(x):\n    return x > 0  # edited\n", encoding="utf-8")
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 2
    assert "uncommitted" in result.stderr
    assert "# edited" in (root / "target.py").read_text(encoding="utf-8")


def test_refuses_an_untracked_target(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    (root / "new.py").write_text("y = 1\n", encoding="utf-8")
    result = run(root, spec([{"path": "new.py", "old": "1", "new": "2", "why": "w"}]))
    assert result.returncode == 2


def test_refuses_a_path_outside_the_root(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    (tmp_path / "outside.py").write_text("a = 1\n", encoding="utf-8")
    result = run(root, spec([{"path": "../outside.py", "old": "1", "new": "2", "why": "w"}]))
    assert result.returncode == 2
    assert (tmp_path / "outside.py").read_text(encoding="utf-8") == "a = 1\n"


def test_refuses_when_the_tests_already_fail(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r", "def f(x):\n    return x >= 0\n")
    result = run(root, spec([mutation("x >= 0", "x > 0")]))
    assert result.returncode == 2
    assert "fail before" in result.stderr


def test_test_command_runs_without_a_shell(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    marker = tmp_path / "pwned"
    bad = {"test": [sys.executable, "-I", "check.py", f"; touch {marker}"], "mutations": [mutation("x > 0", "x >= 0")]}
    run(root, bad)
    assert not marker.exists()


def test_timeout_counts_as_caught_and_restores(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    (root / "check.py").write_text(
        "import sys, time\nsys.path.insert(0, '.')\nimport target as c\n"
        "if not c.f(0):\n    sys.exit(0)\ntime.sleep(30)\n", encoding="utf-8")
    git(root, "commit", "-q", "-am", "slow")
    before = (root / "target.py").read_bytes()
    result = run(root, spec([mutation("x > 0", "x >= 0")], timeout=1))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CAUGHT" in result.stdout and "timed out" in result.stdout
    assert (root / "target.py").read_bytes() == before


def test_preserves_crlf_and_non_ascii_bytes(tmp_path):
    (tmp_path / "r").mkdir()
    source = "def f(x):\r\n    return x > 0  # café\r\n"
    root = make_repo(tmp_path / "r")
    (root / "target.py").write_bytes(source.encode("utf-8"))
    git(root, "commit", "-q", "-am", "crlf")
    before = (root / "target.py").read_bytes()
    result = run(root, spec([mutation("x > 0", "x >= 0")]))
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / "target.py").read_bytes() == before


def test_malformed_spec_exits_two(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    for bad in ({}, {"test": "check.py", "mutations": []}, {"test": [], "mutations": [mutation("a", "b")]},
                {"test": ["x"], "mutations": []}, {"test": ["x"], "mutations": [{"path": "target.py"}]}):
        assert run(root, bad).returncode == 2, bad


def test_restores_every_file_when_interrupted(tmp_path):
    (tmp_path / "r").mkdir()
    root = make_repo(tmp_path / "r")
    (root / "check.py").write_text(
        "import sys, time, pathlib\nsys.path.insert(0, '.')\nimport target as c\n"
        "if not c.f(0):\n    pathlib.Path('started').write_text('1'); time.sleep(30)\nsys.exit(0 if c.f(1) else 1)\n",
        encoding="utf-8")
    git(root, "commit", "-q", "-am", "slow")
    spec_file = tmp_path / "spec.json"
    spec_file.write_text(json.dumps(spec([mutation("x > 0", "x >= 0")])), encoding="utf-8")
    before = (root / "target.py").read_bytes()
    proc = subprocess.Popen([sys.executable, "-I", str(SCRIPT), str(spec_file), "--root", str(root)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    import time
    for _ in range(100):
        if (root / "started").exists():
            break
        time.sleep(0.1)
    proc.send_signal(2)
    proc.communicate(timeout=20)
    assert proc.returncode != 0
    assert (root / "target.py").read_bytes() == before
