"""Tests for the hardening-review skill's known-open list."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "template/owned/.claude/skills/hardening-review/scripts/known_open.py"


def cli(*args):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True)


def setup(tmp_path, text="a\nb\nc\nd\n"):
    root = tmp_path / "root"
    (root / "src").mkdir(parents=True)
    (root / "src/f.sh").write_bytes(text.encode("utf-8"))
    return root, tmp_path / "state" / "known-open.json"


def add(root, listing, ident="R3", lens="Security", start="2", end="3", reason="accepted", path="src/f.sh"):
    return cli("add", str(listing), "--root", str(root), "--id", ident, "--lens", lens, "--path", path,
               "--start", start, "--end", end, "--reason", reason)


def check(root, listing, *extra):
    result = cli("check", str(listing), "--root", str(root), *extra)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def match(root, listing, lens="Security", path="src/f.sh", line="2"):
    result = cli("match", str(listing), "--root", str(root), "--lens", lens, "--path", path, "--line", line)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_unchanged_lines_stay_suppressed_and_add_makes_the_folder(tmp_path):
    root, listing = setup(tmp_path)
    assert add(root, listing).returncode == 0
    assert [(e["id"], e["changed"]) for e in check(root, listing)] == [("R3", False)]


def test_a_change_inside_the_range_raises_it_again(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing)
    (root / "src/f.sh").write_text("a\nB\nc\nd\n", encoding="utf-8")
    assert check(root, listing)[0]["changed"] is True


def test_a_change_outside_the_range_does_not(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing)
    (root / "src/f.sh").write_text("A\nb\nc\nD\n", encoding="utf-8")
    assert check(root, listing)[0]["changed"] is False


def test_lines_shifted_by_an_insert_above_raise_it_again(tmp_path):
    # The hash is of the lines at the recorded range: a shift moves other code into it.
    root, listing = setup(tmp_path)
    add(root, listing)
    (root / "src/f.sh").write_text("new\na\nb\nc\nd\n", encoding="utf-8")
    assert check(root, listing)[0]["changed"] is True


def test_missing_file_or_range_past_the_end_raises_it_again(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing)
    (root / "src/f.sh").write_text("a\n", encoding="utf-8")
    assert check(root, listing)[0]["changed"] is True
    (root / "src/f.sh").unlink()
    assert check(root, listing)[0]["changed"] is True


def test_a_finding_with_no_line_hashes_the_whole_file(tmp_path):
    root, listing = setup(tmp_path)
    assert add(root, listing, start="0", end="0").returncode == 0
    assert check(root, listing)[0]["changed"] is False
    (root / "src/f.sh").write_text("a\nb\nc\nD\n", encoding="utf-8")
    assert check(root, listing)[0]["changed"] is True


def test_lines_are_split_on_newlines_only(tmp_path):
    # A lone CR, a form feed or a vertical tab are not line ends for the Read tool or a diff.
    root, listing = setup(tmp_path, "a\rb\nc\x0cd\ne\n")
    assert add(root, listing, start="2", end="2").returncode == 0
    (root / "src/f.sh").write_bytes(b"a\rb\nC\x0cd\ne\n")
    assert check(root, listing)[0]["changed"] is True
    (root / "src/f.sh").write_bytes(b"a\rb\nc\x0cd\nE\n")
    assert check(root, listing)[0]["changed"] is False
    # And a range is validated against those lines: the file has 3.
    assert add(root, listing, ident="R4", start="2", end="4").returncode == 2


def test_crlf_and_non_utf8_files_are_hashed_as_bytes(tmp_path):
    root, listing = setup(tmp_path)
    (root / "src/f.sh").write_bytes(b"a\r\n\xff\xfe\r\nc\r\n")
    assert add(root, listing, start="2", end="2").returncode == 0
    assert check(root, listing)[0]["changed"] is False
    (root / "src/f.sh").write_bytes(b"a\r\n\xff\xfd\r\nc\r\n")
    assert check(root, listing)[0]["changed"] is True


@pytest.mark.parametrize("kwargs, message", [
    ({"start": "3", "end": "2"}, "1-based"),
    ({"start": "-1", "end": "2"}, "1-based"),
    ({"start": "0", "end": "2"}, "1-based"),
    ({"start": "2", "end": "0"}, "1-based"),
    ({"start": "3", "end": "5"}, "lacks lines"),
    ({"ident": " "}, "must not be blank"),
    ({"lens": ""}, "must not be blank"),
    ({"reason": "  "}, "must not be blank"),
    ({"path": "../x"}, "is outside"),
    ({"path": "missing.sh"}, "lacks lines"),
])
def test_add_refuses_each_bad_input_for_its_own_reason(tmp_path, kwargs, message):
    root, listing = setup(tmp_path)
    (tmp_path / "x").write_text("1\n2\n3\n", encoding="utf-8")
    result = add(root, listing, **kwargs)
    assert result.returncode == 2, result.stdout
    assert message in result.stderr
    assert not listing.exists()


def test_add_refuses_a_duplicate_id(tmp_path):
    root, listing = setup(tmp_path)
    assert add(root, listing).returncode == 0
    again = add(root, listing)
    assert again.returncode == 2 and "already in the list" in again.stderr


def test_add_keeps_the_path_relative_to_the_root(tmp_path):
    root, listing = setup(tmp_path)
    assert add(root, listing, path=str(root / "src" / ".." / "src" / "f.sh")).returncode == 0
    assert add(root, listing, ident="R4", path="./src//f.sh").returncode == 0
    assert [entry["path"] for entry in check(root, listing)] == ["src/f.sh", "src/f.sh"]


def test_a_path_outside_the_root_is_refused_even_for_a_file_that_exists(tmp_path):
    root, listing = setup(tmp_path)
    (tmp_path / "outside.txt").write_text("1\n2\n3\n4\n", encoding="utf-8")
    for path in ("../outside.txt", str(tmp_path / "outside.txt")):
        result = add(root, listing, path=path, start="1", end="1")
        assert result.returncode == 2 and "is outside" in result.stderr, path


def test_a_symlink_out_of_the_root_is_refused_and_checks_as_changed(tmp_path):
    root, listing = setup(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("1\n2\n3\n4\n", encoding="utf-8")
    (root / "src/link.sh").symlink_to(outside)
    result = add(root, listing, path="src/link.sh", start="1", end="1")
    assert result.returncode == 2 and "is outside" in result.stderr
    # A hand-written entry with the right hash for the outside file must not read it.
    import hashlib
    listing.parent.mkdir(parents=True)
    listing.write_text(json.dumps([{"id": "R9", "lens": "L", "path": "../outside.txt", "start": 1, "end": 1,
                                    "hash": hashlib.sha256(b"1\n").hexdigest(), "reason": "r"}]), encoding="utf-8")
    assert check(root, listing)[0]["changed"] is True


def test_for_reviewers_never_carries_the_reason(tmp_path):
    # Reviewers see an open security finding by id, lens and path only (and the range, which says where to look).
    root, listing = setup(tmp_path)
    add(root, listing, reason="the token leaks in the log line")
    result = cli("check", str(listing), "--root", str(root), "--for-reviewers")
    assert result.returncode == 0
    assert "token leaks" not in result.stdout
    assert set(json.loads(result.stdout)[0]) == {"id", "lens", "path", "start", "end", "changed"}


def test_an_empty_or_missing_list_is_an_empty_check(tmp_path):
    root, listing = setup(tmp_path)
    assert check(root, listing) == []


@pytest.mark.parametrize("content", [
    "{not json", "{}", '"text"', "[1]", '[{"id": "R1"}]',
    json.dumps([{"id": "R1", "lens": "L", "path": "src/f.sh", "start": "2", "end": 3, "hash": "h", "reason": "r"}]),
    json.dumps([{"id": "R1", "lens": "L", "path": "src/f.sh", "start": 2, "end": None, "hash": "h", "reason": "r"}]),
    json.dumps([{"id": "R1", "lens": "L", "path": None, "start": 2, "end": 3, "hash": "h", "reason": "r"}]),
    json.dumps([{"id": "R1", "lens": "L", "path": "src/f.sh", "start": 2.5, "end": 3, "hash": "h", "reason": "r"}]),
    json.dumps([{"id": "R1", "lens": "L", "path": "src/f.sh", "start": True, "end": 3, "hash": "h", "reason": "r"}]),
    json.dumps([{"id": "R1", "lens": "L", "path": "src/f.sh", "start": 3, "end": 2, "hash": "h", "reason": "r"}]),
    json.dumps([{"id": "R1", "lens": "L", "path": "src/f.sh", "start": -1, "end": 2, "hash": "h", "reason": "r"}]),
])
def test_a_corrupt_list_exits_two_not_a_traceback(tmp_path, content):
    root, listing = setup(tmp_path)
    listing.parent.mkdir(parents=True)
    listing.write_text(content, encoding="utf-8")
    for command in (["check", str(listing), "--root", str(root)],
                    ["match", str(listing), "--root", str(root), "--lens", "L", "--path", "src/f.sh", "--line", "2"]):
        result = cli(*command)
        assert result.returncode == 2, (command[0], result.stderr)
        assert "Traceback" not in result.stderr


def test_match_suppresses_only_a_finding_inside_an_unchanged_range(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing)  # Security, lines 2-3
    assert match(root, listing, line="2") == {"suppressed": True, "entries": [{"id": "R3", "changed": False}]}
    assert match(root, listing, line="3")["suppressed"] is True
    for line in ("1", "4", "200"):
        assert match(root, listing, line=line) == {"suppressed": False, "entries": []}, line


def test_match_is_not_fooled_by_the_same_file_in_another_lens_or_path(tmp_path):
    root, listing = setup(tmp_path)
    (root / "src/g.sh").write_text("a\nb\nc\n", encoding="utf-8")
    add(root, listing)
    assert match(root, listing, lens="Edge cases")["suppressed"] is False
    assert match(root, listing, path="src/g.sh")["suppressed"] is False


def test_match_takes_any_lens_of_a_merged_finding_and_of_a_merged_entry(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing, lens="Bar/Security")
    assert match(root, listing, lens="Security")["suppressed"] is True
    assert match(root, listing, lens="Shell/Bar")["suppressed"] is True
    assert match(root, listing, lens="Shell/Tests")["suppressed"] is False


def test_match_sees_a_changed_entry_but_does_not_suppress(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing)
    (root / "src/f.sh").write_text("a\nB\nc\nd\n", encoding="utf-8")
    assert match(root, listing) == {"suppressed": False, "entries": [{"id": "R3", "changed": True}]}


def test_match_a_finding_with_no_line_only_matches_a_whole_file_entry(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing)
    assert match(root, listing, line="0")["suppressed"] is False
    add(root, listing, ident="R4", start="0", end="0")
    assert match(root, listing, line="0") == {"suppressed": True, "entries": [{"id": "R4", "changed": False}]}
    # A whole-file entry covers a finding on any line.
    assert match(root, listing, line="4")["suppressed"] is True


def test_match_refuses_a_bad_line_and_a_path_outside_the_root(tmp_path):
    root, listing = setup(tmp_path)
    for line in ("-1", "x"):
        assert cli("match", str(listing), "--root", str(root), "--lens", "L", "--path", "src/f.sh", "--line", line).returncode == 2
    result = cli("match", str(listing), "--root", str(root), "--lens", "L", "--path", "../x", "--line", "1")
    assert result.returncode == 2 and "is outside" in result.stderr


def test_match_suppresses_when_any_covering_entry_is_unchanged(tmp_path):
    # Two entries cover line 3; a fix changed only one's range. The settled one still holds, and both are listed.
    root, listing = setup(tmp_path, "a\nb\nc\nd\n")
    add(root, listing, ident="R3", start="2", end="3")
    add(root, listing, ident="R4", start="3", end="4")
    (root / "src/f.sh").write_text("a\nB\nc\nd\n", encoding="utf-8")
    found = match(root, listing, line="3")
    assert found["suppressed"] is True
    assert sorted((e["id"], e["changed"]) for e in found["entries"]) == [("R3", True), ("R4", False)]


def test_match_skips_a_hand_edited_entry_outside_the_root_instead_of_failing(tmp_path):
    root, listing = setup(tmp_path)
    add(root, listing)
    entries = json.loads(listing.read_text(encoding="utf-8"))
    listing.write_text(json.dumps([{**entries[0], "id": "R9", "path": "../outside.txt"}, *entries]), encoding="utf-8")
    result = cli("match", str(listing), "--root", str(root), "--lens", "Security", "--path", "src/f.sh", "--line", "2")
    assert result.returncode == 0, result.stderr
    assert [e["id"] for e in json.loads(result.stdout)["entries"]] == ["R3"]


def test_add_makes_every_folder_it_creates_private(tmp_path):
    # The reasons can describe a weakness: no other local user reads them while the review runs.
    root, _ = setup(tmp_path)
    listing = tmp_path / "gone" / "hardening" / "known-open.json"
    assert add(root, listing).returncode == 0
    assert (listing.parent.stat().st_mode & 0o777, listing.parent.parent.stat().st_mode & 0o777) == (0o700, 0o700)
    assert listing.stat().st_mode & 0o077 == 0
