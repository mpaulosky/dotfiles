import json
import subprocess

import pytest

import post_claude_review as pcr

HEAD = "abc123"

PATCH = "\n".join(
    [
        "@@ -1,3 +1,4 @@",
        " unchanged",
        "-removed",
        "+added one",
        "+added two",
        " context",
        "@@ -20,2 +21,2 @@",
        " later context",
        "+later added",
    ]
)


def findings_json(*findings, summary="Looked at the diff."):
    return json.dumps(
        {"summary": summary, "findings": [{"path": p, "line": n, "body": b} for p, n, b in findings]}
    )


class FakeGitHub:
    def __init__(self, files=None, lengths=None):
        self.files = files if files is not None else [{"filename": "src/app.py", "patch": PATCH}]
        # src/app.py runs to line 30: lines 5-20 and 23-30 are real but outside the diff.
        self.lengths = lengths if lengths is not None else {"src/app.py": 30}
        self.posted = []

    def line_count(self, path, ref):
        assert ref == HEAD
        return self.lengths.get(path)

    def pull_files(self, number):
        return self.files

    def create_review(self, number, review):
        self.posted.append((number, review))


def run(findings, gh=None):
    gh = gh or FakeGitHub()
    pcr.main(["--repo", "octo/demo", "--pr", "7", "--head", HEAD], gh=gh, findings=findings)
    return gh


# diff_lines()


def test_diff_lines_are_the_new_side_lines_a_comment_can_sit_on():
    lines = pcr.diff_lines([{"filename": "src/app.py", "patch": PATCH}])

    assert lines == {"src/app.py": {1, 2, 3, 4, 21, 22}}


def test_line_breaks_other_than_newline_inside_a_line_dont_shift_the_count():
    patch = "\n".join(["@@ -1,2 +1,3 @@", " page one\x0cpage two", "+added\x85text\u2028more", " context"])

    assert pcr.diff_lines([{"filename": "doc.txt", "patch": patch}]) == {"doc.txt": {1, 2, 3}}


def test_a_file_without_a_patch_has_no_commentable_lines():
    assert pcr.diff_lines([{"filename": "logo.png"}]) == {"logo.png": set()}


# main()


def test_findings_become_one_review_on_the_head_commit():
    gh = run(findings_json(("src/app.py", 2, "Off by one."), ("src/app.py", 22, "Unused.")))

    assert len(gh.posted) == 1
    number, review = gh.posted[0]
    assert number == 7
    assert review["commit_id"] == HEAD
    assert review["event"] == "COMMENT"
    assert review["comments"] == [
        {"path": "src/app.py", "line": 2, "side": "RIGHT", "body": "Off by one."},
        {"path": "src/app.py", "line": 22, "side": "RIGHT", "body": "Unused."},
    ]
    assert "Looked at the diff." in review["body"]


def test_the_marker_is_always_first():
    for findings in (findings_json(), findings_json(("src/app.py", 2, "x")), findings_json(("other.py", 1, "y"))):
        _, review = run(findings).posted[0]
        assert review["body"].startswith(pcr.MARKER + "\n")


def test_a_finding_off_the_diff_moves_to_the_body():
    findings = findings_json(("src/app.py", 2, "On the diff."), ("src/app.py", 10, "Off the diff."),
                             ("README.md", 1, "Not changed."))
    gh = run(findings)

    _, review = gh.posted[0]
    assert [c["line"] for c in review["comments"]] == [2]
    assert "`src/app.py:10`" in review["body"] and "Off the diff." in review["body"]
    assert "`README.md:1`" in review["body"] and "Not changed." in review["body"]


def test_a_finding_off_the_diff_passes_the_step_with_a_warning(capsys):
    # The marker, not the check, holds the merge: a failed check would leave
    # the PR UNSTABLE, which PR Auto-Merge never merges, even at the review cap.
    gh = run(findings_json(("src/app.py", 2, "On."), ("README.md", 1, "Off.")))

    assert len(gh.posted) == 1
    assert "::warning::1 finding(s) outside the diff" in capsys.readouterr().out
    assert "hold the merge" in gh.posted[0][1]["body"]
    # PR Auto-Merge reads this: it's the only thing holding the merge.
    assert gh.posted[0][1]["body"].startswith(pcr.MARKER + "\n" + pcr.OFF_DIFF_MARKER + "\n")


def test_a_line_past_the_end_of_a_changed_file_goes_on_its_nearest_diff_line(capsys):
    # A wrong line number on changed code, not a finding about unchanged code:
    # a thread to resolve, not a hold on the merge.
    gh = run(findings_json(("src/app.py", 598, "Wrong number."), ("src/app.py", 0, "Zero.")))

    _, review = gh.posted[0]
    assert [(c["line"], c["side"]) for c in review["comments"]] == [(22, "RIGHT"), (1, "RIGHT")]
    assert "cited line 598, which isn't a line of this file" in review["comments"][0]["body"]
    assert review["comments"][0]["body"].endswith("Wrong number.")
    assert pcr.OFF_DIFF_MARKER not in review["body"]
    assert "::warning::" not in capsys.readouterr().out


def test_a_real_line_outside_the_hunks_still_holds_the_merge():
    _, review = run(findings_json(("src/app.py", 10, "Unchanged code."))).posted[0]

    assert review["comments"] == []
    assert review["body"].startswith(pcr.MARKER + "\n" + pcr.OFF_DIFF_MARKER + "\n")


def test_an_unreadable_file_length_keeps_the_hold():
    # Unknown length: it may be a real line, so it's treated as one.
    gh = run(findings_json(("src/app.py", 598, "Maybe real.")), FakeGitHub(lengths={}))

    assert gh.posted[0][1]["comments"] == []
    assert pcr.OFF_DIFF_MARKER in gh.posted[0][1]["body"]


def test_a_file_the_diff_doesnt_touch_still_holds_the_merge():
    _, review = run(findings_json(("README.md", 999, "Not changed."))).posted[0]

    assert review["comments"] == []
    assert "`README.md:999`" in review["body"]


@pytest.mark.parametrize(
    "text, lines",
    [(b"", 0), (b"one\n", 1), (b"one\ntwo", 2), ("one\x0cstill one\x85and\u2028one\n".encode(), 1), (b"a\nb\n", 2),
     (b"caf\xe9\nna\xefve\n", 2), (b"one\rstill one\n", 1)],
)
def test_a_files_length_counts_newlines_only(text, lines, monkeypatch):
    # Bytes, as gh returns them: a file that isn't UTF-8 (the Latin-1 case)
    # still counts, and a lone \r isn't a newline.
    def fake_run(argv, **kwargs):
        assert argv[-1] == "repos/octo/demo/contents/docs/a%20b.md?ref=abc123"
        assert "text" not in kwargs
        return subprocess.CompletedProcess(argv, 0, stdout=text)
    monkeypatch.setattr(pcr.subprocess, "run", fake_run)

    assert pcr.GitHub("octo/demo").line_count("docs/a b.md", HEAD) == lines


TOKENS = [
    "sk-ant-oat01-" + "a" * 40,
    "ghp_" + "b" * 36,
    "github_pat_" + "c" * 40,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    # Today's installation token: digits, then a JWT after an underscore.
    "ghs_12345_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRodWIifQ.c2lnbmF0dXJlLXBhcnQ",
    "x-access-token:ghs_67890_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRodWIifQ.c2lnbmF0dXJlLXBhcnQ@github.com",
]


@pytest.mark.parametrize("token", TOKENS)
def test_a_credential_is_redacted_everywhere_and_fails_the_step(token, capsys):
    gh = FakeGitHub()
    findings = findings_json(("src/app.py", 2, f"The token is {token}."), (f"docs/{token}.md", 1, "Path."),
                             summary=f"Found {token} in the environment.")

    with pytest.raises(SystemExit) as exit_info:
        pcr.main(["--repo", "octo/demo", "--pr", "7", "--head", HEAD], gh=gh, findings=findings)

    assert exit_info.value.code == 1
    _, review = gh.posted[0]
    posted = json.dumps(review)
    assert token not in posted
    assert pcr.REDACTED in review["comments"][0]["body"]
    assert "3 credential-shaped string(s) were redacted" in review["body"]
    assert "::error::Redacted 3" in capsys.readouterr().out


def test_ordinary_text_isnt_redacted():
    text = "The ghp_ prefix, sk-ant- keys and a JWT header like eyJ are named here, not quoted."
    _, review = run(findings_json(("src/app.py", 2, text))).posted[0]

    assert review["comments"][0]["body"] == text


def test_a_failed_post_fails_the_step():
    class FailingGitHub(FakeGitHub):
        def create_review(self, number, review):
            raise subprocess.CalledProcessError(1, ["gh", "api"])

    with pytest.raises(subprocess.CalledProcessError):
        run(findings_json(("README.md", 1, "Off.")), FailingGitHub())


def test_findings_on_the_diff_only_pass():
    gh = run(findings_json(("src/app.py", 2, "On.")))

    assert "hold the merge" not in gh.posted[0][1]["body"]
    assert pcr.OFF_DIFF_MARKER not in gh.posted[0][1]["body"]


def test_no_findings_says_so():
    _, review = run(findings_json()).posted[0]

    assert review["comments"] == []
    assert "No findings." in review["body"]


@pytest.mark.parametrize(
    "findings",
    [
        "",
        "not json",
        json.dumps({"findings": []}),
        json.dumps({"summary": "s", "findings": [{"path": "a.py", "body": "no line"}]}),
        json.dumps({"summary": "s", "findings": [{"path": "a.py", "line": "2", "body": "b"}]}),
        json.dumps({"summary": "s", "findings": "none"}),
    ],
)
def test_malformed_findings_fail_with_a_clear_message_and_post_nothing(findings, capsys):
    gh = FakeGitHub()

    with pytest.raises(SystemExit) as exit_info:
        pcr.main(["--repo", "octo/demo", "--pr", "7", "--head", HEAD], gh=gh, findings=findings)

    assert exit_info.value.code == 1
    assert "Claude Review's findings" in capsys.readouterr().err
    assert gh.posted == []


@pytest.mark.parametrize("findings", ["", "  \n"])
def test_empty_findings_say_github_withheld_a_secret_and_post_nothing(findings, capsys):
    # The post job runs only once Claude has answered, so empty findings mean
    # GitHub dropped the output for holding a masked secret.
    gh = FakeGitHub()

    with pytest.raises(SystemExit) as exit_info:
        pcr.main(["--repo", "octo/demo", "--pr", "7", "--head", HEAD], gh=gh, findings=findings)

    assert exit_info.value.code == 1
    out = capsys.readouterr().out
    assert out.startswith("::error::") and "masked secret" in out and "rotate CLAUDE_CODE_OAUTH_TOKEN" in out
    assert gh.posted == []
