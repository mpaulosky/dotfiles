import json
import os
import random
import re
import string
import subprocess
import sys
import textwrap
import unicodedata
from pathlib import Path

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


@pytest.mark.parametrize("error", [subprocess.CalledProcessError(1, ["gh"]), FileNotFoundError("gh")])
def test_a_files_length_is_unknown_when_gh_fails(error, monkeypatch):
    # A 404 for a symlink or submodule, a rate limit, or no gh at all: the
    # finding stays in the body instead of failing the step.
    def fake_run(argv, **kwargs):
        raise error
    monkeypatch.setattr(pcr.subprocess, "run", fake_run)

    assert pcr.GitHub("octo/demo").line_count("docs/a.md", HEAD) is None


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


# The answer check, inline in claude-review.yml's review job

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows" / "claude-review.yml"


def answer_check_script():
    """The Python the "Check Claude's answer for secrets" step runs, from its heredoc."""
    lines = WORKFLOW.read_text().splitlines()
    step = next(i for i, line in enumerate(lines) if line.strip() == "id: answer")
    start = next(i for i in range(step, len(lines)) if lines[i].strip() == "python3 -I - <<'PY'") + 1
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "PY")
    return textwrap.dedent("\n".join(lines[start:end])) + "\n"


def check(tmp_path, answer=None, secrets=(), path=None, raw=None):
    """Run the step's check: its exit code, its step outputs and what it printed."""
    if path is None:
        path = tmp_path / "execution.json"
        if raw is not None:
            path.write_text(raw)
        else:
            path.write_text(json.dumps([{"type": "system"}, {"type": "assistant"},
                                        {"type": "result", "subtype": "success", "structured_output": answer}]))
    output = tmp_path / "output"
    output.write_text("")
    env = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(output), "EXECUTION_FILE": str(path),
           "OAUTH_TOKEN": secrets[0] if secrets else "", "JOB_TOKEN": secrets[1] if len(secrets) > 1 else ""}
    done = subprocess.run([sys.executable, "-I", "-"], input=answer_check_script(), env=env,
                          capture_output=True, text=True)
    return done.returncode, parse_outputs(output.read_text()), done.stdout


def parse_outputs(text):
    outputs, lines = {}, iter(text.splitlines())
    for line in lines:
        if "<<" in line:
            name, delimiter = line.split("<<", 1)
            outputs[name] = "\n".join(iter(lambda: next(lines), delimiter))
        else:
            name, value = line.split("=", 1)
            outputs[name] = value
    return outputs


# No character repeats in either secret part, so a 16-character window
# matches at one offset only, and a check that compared only some windows
# would fail these tests.
ALPHANUMERIC = string.ascii_letters + string.digits
SECRET = "sk-ant-" + "oat01-" + "".join(random.Random(7).sample(ALPHANUMERIC, 62))
JOB_TOKEN = ("ghs_" + "98765_" + "eyJ" + "hbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJ" + "pc3MiOiJnaXRodWIifQ" + "."
             + "".join(random.Random(11).sample(ALPHANUMERIC, 45)))


def withheld(tmp_path, answer, secrets):
    code, outputs, out = check(tmp_path, answer, secrets)
    assert code == 0
    if outputs["findings"] == "":
        assert out.startswith("::error::Claude's answer quotes")
        return True
    return False


def test_the_workflows_credential_pattern_matches_the_scripts():
    script = answer_check_script()
    start = script.index("CREDENTIAL = re.compile(")
    namespace = {"re": re}
    exec(script[start:script.index("\n)\n", start) + 3], namespace)

    assert namespace["CREDENTIAL"].pattern == pcr.CREDENTIAL.pattern


def test_an_answer_passes_on_with_credentials_redacted(tmp_path):
    answer = {"summary": "Uses " + TOKENS[1], "findings": [{"path": "a.py", "line": 1, "body": "See " + JWT}]}

    code, outputs, out = check(tmp_path, answer, [SECRET])

    assert code == 0 and outputs["redacted"] == "2" and "Redacted 2" in out
    assert json.loads(outputs["findings"])["findings"][0]["body"] == "See " + pcr.REDACTED
    assert TOKENS[1] not in outputs["findings"] and JWT not in outputs["findings"]


def test_only_the_schemas_fields_are_passed_on(tmp_path):
    answer = {"summary": "s", "debug": [115, 107], TOKENS[1]: "x",
              "findings": [{"path": "a.py", "line": 3, "body": "b", "extra": "e"}]}

    _, outputs, _ = check(tmp_path, answer, [SECRET])

    assert json.loads(outputs["findings"]) == {"summary": "s", "findings": [{"path": "a.py", "line": 3, "body": "b"}]}
    assert outputs["redacted"] == "0"


@pytest.mark.parametrize("answer", [
    {"summary": "s", "findings": "none"},
    {"summary": "s", "findings": ["not a finding"]},
    {"summary": "s"},
    {"findings": []},
    {"summary": "s", "findings": [{"path": "a.py", "body": "no line"}]},
    {"summary": "s", "findings": [{"path": "a.py", "line": True, "body": "b"}]},
    {"summary": "s", "findings": [{"path": "a.py", "line": int.from_bytes(SECRET.encode(), "big"), "body": "b"}]},
    {"summary": "s", "findings": [{"path": "a.py", "line": -1, "body": "b"}]},
    {"summary": "s", "findings": [[115, 107, 45]]},
    {"summary": "s", "findings": [{"path": "a", "line": [115, 107], "body": "b"}]},
    {"summary": {TOKENS[1]: [115, 107]}, "findings": []},
    [{TOKENS[1]: "x"}],
])
def test_a_malformed_answer_becomes_a_placeholder_the_post_script_rejects(tmp_path, answer):
    _, outputs, _ = check(tmp_path, answer, [SECRET])

    placeholder = json.loads(outputs["findings"])
    assert list(placeholder) == ["malformed"] and placeholder["malformed"].startswith("Claude's answer was withheld: ")
    assert "115" not in outputs["findings"] and TOKENS[1] not in outputs["findings"] and outputs["redacted"] == "0"
    with pytest.raises(pcr.MalformedFindings):
        pcr.parse_findings(outputs["findings"])


def test_a_secret_spelled_out_in_line_numbers_is_withheld(tmp_path):
    findings = [{"path": "a.py", "line": ord(c), "body": "b"} for c in SECRET[13:33]]

    assert withheld(tmp_path, {"summary": "s", "findings": findings}, [SECRET])


# The whole secret, its body's first window, a middle one and its last one.
@pytest.mark.parametrize("quote", [SECRET, SECRET[13:29], "x" + SECRET[40:56] + "y", SECRET[-16:]])
def test_an_answer_quoting_a_secret_even_in_part_is_withheld(tmp_path, quote):
    answer = {"summary": "s", "findings": [{"path": "a.py", "line": 1, "body": f"The token is {quote}."}]}

    assert withheld(tmp_path, answer, [SECRET])


# Accented letters too, which NFKD would split into a base letter between the
# pieces and a mark; the NFKC comparison strips them whole.
@pytest.mark.parametrize("separator", ["`", "\n", "` `", "-", "\t", "é", "ạ"])
def test_a_secret_quoted_in_short_pieces_is_withheld(tmp_path, separator):
    body = SECRET[13:]
    pieces = separator.join(body[i:i + 15] for i in range(0, len(body), 15))

    assert withheld(tmp_path, {"summary": pieces, "findings": []}, [SECRET])


@pytest.mark.parametrize("offset", [0xFEE0, None])
def test_a_secret_in_look_alike_characters_is_withheld(tmp_path, offset):
    # Fullwidth, or mathematical bold: both normalise to ASCII under NFKC and NFKD.
    def look_alike(c):
        if offset:
            return chr(ord(c) + offset)
        return chr((0x1D400 + ord(c) - 65) if c.isupper() else (0x1D41A + ord(c) - 97) if c.islower()
                   else (0x1D7CE + ord(c) - 48))

    assert withheld(tmp_path, {"summary": "".join(map(look_alike, SECRET[13:33])), "findings": []}, [SECRET])


# Each letter followed by a dot below: as written, and composed into one
# character where Unicode has one. NFKC composes both into non-ASCII letters
# and strips them; the NFKD comparison strips only the marks.
@pytest.mark.parametrize("form", [None, "NFC"])
def test_a_secret_with_a_mark_on_each_letter_is_withheld(tmp_path, form):
    quote = "".join(c + "\u0323" for c in SECRET[13:33])
    if form:
        quote = unicodedata.normalize(form, quote)
        assert any(ord(c) > 127 and not unicodedata.combining(c) for c in quote)

    assert withheld(tmp_path, {"summary": quote, "findings": []}, [SECRET])


def test_a_secret_in_an_extra_field_is_withheld_too(tmp_path):
    assert withheld(tmp_path, {"summary": "s", "findings": [], SECRET[20:40]: 1}, [SECRET])


# Five of the accepted limits in repo-ci-baseline's ADR 0004, pinned so a
# change to them is deliberate. Pieces are joined by a character of the body
# that isn't next to them in it, so no window across a join is a window of
# the secret, whatever order the seed gives.
BODY = SECRET[13:]
SEPARATED = "".join(BODY[j:j + 15] + BODY[j + 20] for j in range(0, 45, 15))


@pytest.mark.parametrize("answer", [
    # Pieces split by letters or digits.
    {"summary": SEPARATED, "findings": []},
    # Pieces in separate fields, with the keys' letters between them.
    {"summary": BODY[:15], "findings": [{"path": "a.py", "line": 1, "body": BODY[15:30]}]},
    # Character codes written as digits.
    {"summary": " ".join(str(ord(c)) for c in BODY[:20]), "findings": []},
    # A reversed quote.
    {"summary": BODY[::-1], "findings": []},
    # Both Unicode tricks at once: a mark on each letter, pieces joined by é.
    {"summary": "é".join("".join(c + "\u0323" for c in BODY[j:j + 15]) for j in range(0, 45, 15)), "findings": []},
])
def test_the_accepted_limits_get_through(tmp_path, answer):
    # The keys between the separate fields start "findings" and end "body";
    # a seed where they'd continue the body would test nothing.
    assert BODY[15] != "f" and BODY[14] != "y", "pick another seed for SECRET"
    assert not withheld(tmp_path, answer, [SECRET])


def test_a_short_overlap_with_a_secret_isnt_a_leak(tmp_path):
    assert not withheld(tmp_path, {"summary": "Mentions " + SECRET[:15], "findings": []}, [SECRET])


def test_a_secret_stored_with_its_name_isnt_leaked_by_naming_it(tmp_path):
    stored = "CLAUDE_CODE_OAUTH_TOKEN=" + SECRET + "\n"
    answer = {"summary": "Rotate CLAUDE_CODE_OAUTH_TOKEN; it starts sk-ant-oat01-.", "findings": []}

    assert not withheld(tmp_path, answer, [stored])
    assert withheld(tmp_path, {"summary": SECRET[20:40], "findings": []}, [stored])


def test_a_job_tokens_jwt_header_and_claims_arent_a_leak_but_its_signature_is(tmp_path):
    header, claims, signature = JOB_TOKEN.split("_", 2)[2].split(".")
    example = header + "." + "eyJ" + "zdWIiOiJleGFtcGxlIn0" + "." + "Qw8" * 12

    assert not withheld(tmp_path, {"summary": f"A JWT starts {header}.{claims}, e.g. {example}", "findings": []},
                        [SECRET, JOB_TOKEN])
    assert withheld(tmp_path, {"summary": signature[:16], "findings": []}, [SECRET, JOB_TOKEN])


def test_a_secret_without_a_token_shape_is_checked_whole(tmp_path):
    assert withheld(tmp_path, {"summary": "x plain-secret-value y", "findings": []}, ["  plain-secret-value-1234 \n"])


def test_a_withheld_answer_writes_empty_findings_and_no_secret(tmp_path):
    code, outputs, out = check(tmp_path, {"summary": "Leaks " + SECRET, "findings": []}, [SECRET])

    assert code == 0 and outputs == {"findings": "", "redacted": "0"}
    assert SECRET not in out and "rotate CLAUDE_CODE_OAUTH_TOKEN" in out


@pytest.mark.parametrize("raw", ["not json", "[]", '[{"type": "result", "subtype": "error"}]'])
def test_no_answer_in_the_execution_file_fails_the_step(tmp_path, raw):
    code, outputs, out = check(tmp_path, raw=raw)

    assert code == 1 and outputs["findings"] == ""
    assert out.startswith("::error::Claude answered, but its answer isn't in the action's execution file")
    assert "rotate" not in out


def test_a_missing_execution_file_fails_the_step(tmp_path):
    code, _, out = check(tmp_path, path=tmp_path / "missing.json")

    assert code == 1 and "execution file" in out


def test_an_unset_execution_file_fails_the_step(tmp_path):
    # A later action pin that drops the execution_file output.
    code, outputs, out = check(tmp_path, path="")

    assert code == 1 and outputs["findings"] == "" and "(not set)" in out


def test_posting_needs_repo_pr_and_head():
    with pytest.raises(SystemExit) as exit_info:
        pcr.main(["--repo", "octo/demo"], gh=FakeGitHub(), findings=findings_json())

    assert exit_info.value.code == 2
