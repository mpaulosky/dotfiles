import io

import pytest

import draft_release as dr
import release_post as rp

NOTES = "Source PR: #15\nSource PR URL: https://example.test/pull/15"


def test_a_draft_without_a_marker_gets_the_notes_appended():
    body = dr.publish_body("Hand-written notes.", 15, NOTES)

    assert body == f"Hand-written notes.\n\n{NOTES}\n"


def test_an_empty_draft_gets_just_the_notes():
    assert dr.publish_body("", 15, NOTES) == f"{NOTES}\n"
    assert dr.publish_body(None, 15, NOTES) == f"{NOTES}\n"


def test_a_draft_naming_this_pr_on_its_own_line_is_published_unchanged():
    body = "Notes.\n\n  Source PR: #15  \nMerge commit: abc"

    assert dr.publish_body(body, 15, NOTES) == body


def test_a_draft_with_crlf_endings_naming_this_pr_is_published_unchanged():
    body = "Notes.\r\nSource PR: #15\r\nMerge commit: abc\r\n"

    assert dr.publish_body(body, 15, NOTES) == body


def test_a_draft_naming_this_pr_only_inside_a_longer_line_gets_its_own_line():
    body = "- Source PR: #15"

    result = dr.publish_body(body, 15, NOTES)

    assert result == f"{body}\n\n{NOTES}\n"
    assert rp.source_pr_of({"body": result}) == 15


@pytest.mark.parametrize(
    "body",
    [
        "Source PR: #5",
        "- Source PR: #5",
        "Notes.\nSource PR: #15\nSource PR: #5",
        "Source PR: #150",
        "Source PR: #1",
    ],
)
def test_a_draft_naming_another_pr_fails(body):
    with pytest.raises(dr.OtherPrError):
        dr.publish_body(body, 15, NOTES)


def test_numbers_match_exactly():
    # PR 5 against a draft naming #15 and #50, and the reverse.
    with pytest.raises(dr.OtherPrError, match="#15"):
        dr.publish_body("Source PR: #15", 5, NOTES)
    with pytest.raises(dr.OtherPrError, match="#5,"):
        dr.publish_body("Source PR: #5", 50, NOTES)


@pytest.mark.parametrize(
    "body",
    ["Source PR: #7", "- Source PR: #7 (manual)", "x\n  Source PR: #7\n", "**Source PR:** [#7](url)"],
)
def test_markers_match_the_planner(body):
    first = dr.named_prs(body)[0] if dr.named_prs(body) else None

    assert first == rp.source_pr_of({"body": body})


def test_main_prints_the_body(tmp_path, monkeypatch, capsys):
    notes = tmp_path / "notes.txt"
    notes.write_text(f"{NOTES}\n", encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("Draft."))

    code = dr.main(["--pr", "15", "--notes-file", str(notes)])

    assert code == 0
    assert capsys.readouterr().out == f"Draft.\n\n{NOTES}\n"


def test_main_fails_on_another_pr_with_the_error_on_stderr(tmp_path, monkeypatch, capsys):
    notes = tmp_path / "notes.txt"
    notes.write_text(NOTES, encoding="utf-8")
    monkeypatch.setattr("sys.stdin", io.StringIO("Source PR: #5"))

    code = dr.main(["--pr", "15", "--tag", "v1.2.3", "--notes-file", str(notes)])

    captured = capsys.readouterr()
    assert code == 1
    assert captured.out == ""
    assert "::error::The draft Release v1.2.3 names PR #5, not #15." in captured.err
