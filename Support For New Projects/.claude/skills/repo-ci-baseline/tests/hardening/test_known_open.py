"""Tests for the hardening-review skill's known-open list."""
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "template/owned/.claude/skills/hardening-review/scripts/known_open.py"


def cli(*args):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True)


def setup(tmp_path, text="a\nb\nc\nd\n"):
    (tmp_path / "src").mkdir()
    (tmp_path / "src/f.sh").write_text(text, encoding="utf-8")
    return tmp_path / "known-open.json"


def add(tmp_path, listing, ident="R3", lens="Security", start="2", end="3", reason="accepted"):
    return cli("add", str(listing), "--root", str(tmp_path), "--id", ident, "--lens", lens, "--path", "src/f.sh",
               "--start", start, "--end", end, "--reason", reason)


def check(tmp_path, listing):
    result = cli("check", str(listing), "--root", str(tmp_path))
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_unchanged_lines_stay_suppressed(tmp_path):
    listing = setup(tmp_path)
    assert add(tmp_path, listing).returncode == 0
    entries = check(tmp_path, listing)
    assert [(e["id"], e["changed"]) for e in entries] == [("R3", False)]


def test_a_change_inside_the_range_raises_it_again(tmp_path):
    listing = setup(tmp_path)
    add(tmp_path, listing)
    (tmp_path / "src/f.sh").write_text("a\nB\nc\nd\n", encoding="utf-8")
    assert check(tmp_path, listing)[0]["changed"] is True


def test_a_change_outside_the_range_does_not(tmp_path):
    listing = setup(tmp_path)
    add(tmp_path, listing)
    (tmp_path / "src/f.sh").write_text("A\nb\nc\nD\n", encoding="utf-8")
    assert check(tmp_path, listing)[0]["changed"] is False


def test_lines_shifted_by_an_insert_above_raise_it_again(tmp_path):
    # The hash is of the lines at the recorded range: a shift moves other code into it.
    listing = setup(tmp_path)
    add(tmp_path, listing)
    (tmp_path / "src/f.sh").write_text("new\na\nb\nc\nd\n", encoding="utf-8")
    assert check(tmp_path, listing)[0]["changed"] is True


def test_missing_file_or_range_past_the_end_raises_it_again(tmp_path):
    listing = setup(tmp_path)
    add(tmp_path, listing)
    (tmp_path / "src/f.sh").write_text("a\n", encoding="utf-8")
    assert check(tmp_path, listing)[0]["changed"] is True
    (tmp_path / "src/f.sh").unlink()
    assert check(tmp_path, listing)[0]["changed"] is True


def test_a_finding_with_no_line_hashes_the_whole_file(tmp_path):
    listing = setup(tmp_path)
    assert add(tmp_path, listing, start="0", end="0").returncode == 0
    assert check(tmp_path, listing)[0]["changed"] is False
    (tmp_path / "src/f.sh").write_text("a\nb\nc\nD\n", encoding="utf-8")
    assert check(tmp_path, listing)[0]["changed"] is True


def test_refuses_a_duplicate_id_a_bad_range_and_an_outside_path(tmp_path):
    listing = setup(tmp_path)
    assert add(tmp_path, listing).returncode == 0
    assert add(tmp_path, listing).returncode == 2
    assert add(tmp_path, listing, ident="R4", start="3", end="2").returncode == 2
    assert add(tmp_path, listing, ident="R5", start="-1", end="2").returncode == 2
    # The file has 4 lines: a range ending just past them is refused, not hashed short.
    assert add(tmp_path, listing, ident="R7", start="3", end="5").returncode == 2
    outside = cli("add", str(listing), "--root", str(tmp_path), "--id", "R6", "--lens", "L", "--path", "../x",
                  "--start", "1", "--end", "1", "--reason", "r")
    assert outside.returncode == 2


def test_the_output_of_check_never_carries_the_reason_of_a_security_entry(tmp_path):
    # Reviewers see an open security finding by id, lens and path only.
    listing = setup(tmp_path)
    add(tmp_path, listing, reason="the token leaks in the log line")
    result = cli("check", str(listing), "--root", str(tmp_path), "--for-reviewers")
    assert result.returncode == 0
    assert "token leaks" not in result.stdout
    assert set(json.loads(result.stdout)[0]) == {"id", "lens", "path", "changed"}


def test_empty_or_missing_list_is_an_empty_check(tmp_path):
    assert check(tmp_path, tmp_path / "none.json") == []


def test_corrupt_list_exits_two(tmp_path):
    listing = tmp_path / "k.json"
    listing.write_text("{not json", encoding="utf-8")
    assert cli("check", str(listing), "--root", str(tmp_path)).returncode == 2
