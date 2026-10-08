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


# Built at runtime, so this file holds nothing credential-shaped for a review
# of it to quote.
JWT = "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abcdefghijklmnop"
TOKENS = [
    "sk-ant-" + "oat01-" + "a" * 40,
    "ghp_" + "b" * 36,
    "github_pat_" + "c" * 22 + "_" + "d" * 59,
    JWT,
    # Today's installation token: digits, then a JWT after an underscore.
    "ghs_" + "12345_" + JWT,
]


# Text run up against a token doesn't hide it.
PREFIXED = ["x-access-token:" + TOKENS[-1] + "@github.com", "token_" + TOKENS[1], "token_" + TOKENS[2],
            "x" + JWT, "token-" + JWT, "docs/session-" + JWT, "\\n" + TOKENS[1], "risk-" + TOKENS[0]]


@pytest.mark.parametrize("token", TOKENS + PREFIXED)
def test_a_credential_is_redacted_everywhere_and_warns(token, capsys):
    gh = FakeGitHub()
    findings = findings_json(("src/app.py", 2, f"The token is {token}."), (f"docs/{token}.md", 1, "Path."),
                             summary=f"Found {token} in the environment.")

    pcr.main(["--repo", "octo/demo", "--pr", "7", "--head", HEAD], gh=gh, findings=findings)

    _, review = gh.posted[0]
    posted = json.dumps(review)
    assert token not in posted and not any(t in posted for t in TOKENS)
    assert pcr.REDACTED in review["comments"][0]["body"]
    assert "3 credential-shaped string(s) were redacted" in review["body"]
    assert "::warning::Redacted 3" in capsys.readouterr().out


def test_the_review_jobs_redactions_are_counted(monkeypatch, capsys):
    monkeypatch.setenv("REDACTED", "2")
    _, review = run(findings_json(("src/app.py", 2, "Was [redacted]."))).posted[0]

    assert "2 credential-shaped string(s) were redacted" in review["body"]
    assert "::warning::Redacted 2" in capsys.readouterr().out


@pytest.mark.parametrize("text", [
    "ghs_installation_token_value_for_the_runner_job",
    "github_pat_example_placeholder_value_goes_here_xx",
    "ghp_short",
])
def test_names_shaped_loosely_like_tokens_arent_redacted(text):
    _, review = run(findings_json(("src/app.py", 2, text))).posted[0]

    assert review["comments"][0]["body"] == text


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
def test_empty_findings_say_a_secret_was_withheld_and_post_nothing(findings, capsys):
    # The post job runs only once Claude has answered, so empty findings mean
    # the answer quoted a secret and was withheld.
    gh = FakeGitHub()

    with pytest.raises(SystemExit) as exit_info:
        pcr.main(["--repo", "octo/demo", "--pr", "7", "--head", HEAD], gh=gh, findings=findings)

    assert exit_info.value.code == 1
    out = capsys.readouterr().out
    assert out.startswith("::error::") and "quoted a secret" in out and "rotate CLAUDE_CODE_OAUTH_TOKEN" in out
    assert gh.posted == []


# --check-answer, in the review job

def execution_file(tmp_path, answer):
    path = tmp_path / "execution.json"
    path.write_text(json.dumps([{"type": "system"}, {"type": "assistant"},
                                {"type": "result", "subtype": "success", "structured_output": answer}]))
    return path


SECRET = "sk-ant-" + "oat01-" + "Zq9" * 20


def test_an_answer_passes_on_with_credentials_redacted(tmp_path):
    answer = {"summary": "Uses " + TOKENS[1], "findings": [{"path": "a.py", "line": 1, "body": "See " + JWT}]}

    findings, redacted, leaked = pcr.check_answer(execution_file(tmp_path, answer), [SECRET, ""])

    assert not leaked and redacted == 2
    assert json.loads(findings)["findings"][0]["body"] == "See " + pcr.REDACTED
    assert TOKENS[1] not in findings and JWT not in findings


@pytest.mark.parametrize("quote", [SECRET, SECRET[13:29], "x" + SECRET[30:50] + "y"])
def test_an_answer_quoting_a_secret_even_in_part_is_withheld(tmp_path, quote):
    answer = {"summary": "s", "findings": [{"path": "a.py", "line": 1, "body": f"The token is {quote}."}]}

    assert pcr.check_answer(execution_file(tmp_path, answer), [SECRET]) == ("", 0, True)


def test_a_short_overlap_with_a_secret_isnt_a_leak(tmp_path):
    answer = {"summary": "Mentions " + SECRET[:15], "findings": []}

    _, _, leaked = pcr.check_answer(execution_file(tmp_path, answer), [SECRET])

    assert not leaked


def test_a_secret_stored_with_its_name_isnt_leaked_by_naming_it(tmp_path):
    stored = "CLAUDE_CODE_OAUTH_TOKEN=" + SECRET + "\n"
    answer = {"summary": "Rotate CLAUDE_CODE_OAUTH_TOKEN; it starts sk-ant-oat01-.", "findings": []}

    _, _, leaked = pcr.check_answer(execution_file(tmp_path, answer), [stored])

    assert not leaked
    assert pcr.check_answer(execution_file(tmp_path, {"summary": SECRET[20:40]}), [stored])[2]


JOB_TOKEN = "ghs_" + "98765_" + "eyJ" + "hbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJ" + "pc3MiOiJnaXRodWIifQ" + "." + "Xy7" * 15


def test_a_job_tokens_jwt_header_and_claims_arent_a_leak_but_its_signature_is(tmp_path):
    header, claims, signature = JOB_TOKEN.split("_", 2)[2].split(".")
    answer = {"summary": f"A JWT starts {header}.{claims}.", "findings": []}

    assert not pcr.check_answer(execution_file(tmp_path, answer), [JOB_TOKEN])[2]
    assert pcr.check_answer(execution_file(tmp_path, {"summary": signature[:16]}), [JOB_TOKEN])[2]


def test_a_secret_without_a_token_shape_is_checked_whole():
    assert pcr.secret_parts("  plain-secret-value-1234  \n") == ["plain-secret-value-1234"]
    assert pcr.quotes_a_secret("x plain-secret-value y", ["plain-secret-value-1234"])


@pytest.mark.parametrize("content", [None, "not json", "[]", '[{"type": "result", "subtype": "error"}]'])
def test_no_answer_in_the_execution_file_passes_on_nothing(tmp_path, content):
    path = tmp_path / "execution.json"
    if content is not None:
        path.write_text(content)

    assert pcr.check_answer(path, [SECRET]) == ("", 0, False)


def test_check_answer_writes_step_outputs_and_errors_on_a_leak(tmp_path, monkeypatch, capsys):
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("OAUTH_TOKEN", SECRET)
    monkeypatch.delenv("JOB_TOKEN", raising=False)
    answer = {"summary": "Leaks " + SECRET, "findings": []}

    pcr.main(["--check-answer", str(execution_file(tmp_path, answer))])

    written, out = output.read_text(), capsys.readouterr().out
    assert SECRET not in written and SECRET not in out
    assert out.startswith("::error::Claude's answer quotes")
    lines = written.splitlines()
    assert lines[0] == "findings="
    assert lines[1].startswith("redacted<<EOF_") and lines[2] == "0" and lines[3] == lines[1].split("<<")[1]


def test_check_answer_writes_the_redacted_answer(tmp_path, monkeypatch):
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("OAUTH_TOKEN", SECRET)
    answer = {"summary": "Quotes " + TOKENS[1], "findings": []}

    pcr.main(["--check-answer", str(execution_file(tmp_path, answer))])

    lines = output.read_text().splitlines()
    assert json.loads(lines[1]) == {"summary": "Quotes " + pcr.REDACTED, "findings": []}
    assert lines[4] == "1"


def test_posting_needs_repo_pr_and_head():
    with pytest.raises(SystemExit) as exit_info:
        pcr.main(["--repo", "octo/demo"], gh=FakeGitHub(), findings=findings_json())

    assert exit_info.value.code == 2
