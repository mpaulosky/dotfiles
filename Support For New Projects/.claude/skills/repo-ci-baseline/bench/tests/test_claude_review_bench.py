"""Tests for bench/claude-review-bench.py's scoring, argument handling and config swap. No Claude."""

import importlib.util
import json
import shlex
from pathlib import Path

import pytest

BENCH = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("claude_review_bench", BENCH / "claude-review-bench.py")
bench = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bench)


def finding(path, body):
    return {"path": path, "line": 1, "body": body}


# caught()

TAB = {"paths": ["release_post.py"], "match": [["tab", "tabs", "\\t"]]}


def test_a_word_matches_whole_not_inside_another():
    assert bench.caught(TAB, [finding(".github/scripts/release_post.py", "A leading tab survives.")])
    assert not bench.caught(TAB, [finding(".github/scripts/release_post.py", "The table is stable.")])


def test_every_group_must_match_and_any_word_in_a_group_does():
    spec = {"match": [["skip", "skipped"], ["label", "rerun"]]}
    assert bench.caught(spec, [finding("a.yml", "A skipped run after another label.")])
    assert not bench.caught(spec, [finding("a.yml", "A skipped run.")])


def test_a_phrase_matches_as_a_whole():
    spec = {"match": [["copilot"], ["without a [bot]"]]}
    assert bench.caught(spec, [finding("a.yml", "Copilot acts without a [bot] suffix.")])
    assert not bench.caught(spec, [finding("a.yml", "Copilot skips every [bot] actor.")])


def test_a_finding_on_another_file_never_counts():
    assert not bench.caught(TAB, [finding(".github/workflows/ci.yml", "A leading tab survives.")])


def test_a_path_matches_whole_components_only():
    assert bench.caught(TAB, [finding("release_post.py", "A leading tab survives.")])
    assert not bench.caught(TAB, [finding(".github/scripts/tests/test_release_post.py", "A leading tab survives.")])


def test_every_cases_file_finding_has_paths_and_match():
    spec = json.loads((BENCH / "claude-review-cases.json").read_text())
    for key, entry in spec["findings"].items():
        assert entry["paths"] and entry["match"], key
    for case in spec["cases"]:
        assert set(case["expect"]) <= set(spec["findings"]), case["head"]


# override()

ARGS = shlex.split('--model m --effort medium --allowedTools "Read,Glob,Grep" --disallowedTools "Bash,WebFetch,WebSearch"')


def test_an_override_replaces_the_flags_value():
    args = bench.override(list(ARGS), "high", "opus", None)
    assert args[args.index("--effort") + 1] == "high" and args[args.index("--model") + 1] == "opus"


def test_an_override_adds_a_flag_that_was_missing():
    args = bench.override(["--model", "m"], "high", None, None)
    assert args[-2:] == ["--effort", "high"]


def test_setting_sources_can_be_emptied():
    args = bench.override(["--setting-sources", "user"], None, None, None, setting_sources="")
    assert args == ["--setting-sources", ""]


def test_allowed_tools_are_dropped_from_the_disallowed_list():
    args = bench.override(list(ARGS), None, None, "Read,Glob,Grep,WebFetch")
    assert args[args.index("--allowedTools") + 1] == "Read,Glob,Grep,WebFetch"
    assert args[args.index("--disallowedTools") + 1] == "Bash,WebSearch"


# render()

def test_render_fills_in_the_workflow_expressions():
    text = "PR #${{ github.event.pull_request.number }}, diff in ${{ runner.temp }}/pr.diff, ${{ github.workspace }}/../../_actions"
    assert bench.render(text, 7, "/tmp/t") == "PR #7, diff in /tmp/t/pr.diff, /tmp/t/work/repo/repo/../../_actions"


def test_render_refuses_an_expression_it_doesnt_know():
    with pytest.raises(SystemExit):
        bench.render("${{ secrets.TOKEN }}", 7, "/tmp/t")


# pinned_actions()

def test_the_review_jobs_remote_actions_are_found_once_each():
    pytest.importorskip("yaml")
    workflow = """
jobs:
  review:
    steps:
      - uses: actions/checkout@abc123
      - run: echo hi
      - uses: anthropics/claude-code-action@def456
      - uses: actions/checkout@abc123
      - uses: ./.github/actions/local
      - uses: owner/repo/sub/path@v1
  post:
    steps:
      - uses: actions/setup-python@v6
"""
    assert bench.pinned_actions(workflow) == [("actions", "checkout", "abc123"),
                                              ("anthropics", "claude-code-action", "def456"),
                                              ("owner", "repo", "v1")]


def test_a_head_without_a_review_job_pins_nothing():
    pytest.importorskip("yaml")
    assert bench.pinned_actions("") == []
    assert bench.pinned_actions("jobs: {build: {steps: []}}") == []


# use_base_settings()

def test_the_heads_claude_config_is_replaced_by_the_bases(tmp_path):
    import subprocess

    def git(*args):
        # Hooks and signing off, as the skill's other test repos: the maintainer's global config may set them.
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", str(tmp_path), *args],
                       check=True, capture_output=True)
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    (tmp_path / "CLAUDE.md").write_text("base instructions\n")
    git("add", "-A")
    git("commit", "-q", "-m", "base")
    base = subprocess.run(["git", "-C", str(tmp_path), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    (tmp_path / "CLAUDE.md").write_text("head instructions\n")
    (tmp_path / ".mcp.json").write_text('{"mcpServers": {"x": {"command": "evil"}}}\n')
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text('{"hooks": {}}\n')

    bench.use_base_settings(tmp_path, base)

    assert (tmp_path / "CLAUDE.md").read_text() == "base instructions\n"
    assert not (tmp_path / ".mcp.json").exists()
    assert not (tmp_path / ".claude").exists()


# review_step(), against the real Template workflow

def test_the_benchmark_can_read_the_template_workflows_review_step():
    pytest.importorskip("yaml")
    prompt, claude_args = bench.review_step(bench.WORKFLOW)
    rendered = shlex.split(bench.render(claude_args, 7, "/tmp/t"))
    assert "#7" in bench.render(prompt, 7, "/tmp/t", pieces="- /tmp/t/claude-review/diff/001.diff (3 lines: source)")
    with pytest.raises(SystemExit):
        bench.render(prompt, 7, "/tmp/t")  # the diff step's pieces must be filled in
    for flag in ("--model", "--effort", "--json-schema"):
        assert flag in rendered, flag
    # The token's guards (#121): no tool granted outright, so reads stay in the
    # checkout and the --add-dir directories; no repo settings; /proc denied.
    assert "--allowedTools" not in rendered and "--allowed-tools" not in rendered
    assert rendered[rendered.index("--setting-sources") + 1] == "user"
    added = [rendered[i + 1] for i, arg in enumerate(rendered) if arg == "--add-dir"]
    assert added == ["/tmp/t/claude-review", "/tmp/t/work/repo/repo/../../_actions"]
    disallowed = rendered[rendered.index("--disallowedTools") + 1].split(",")
    assert "Read(//proc/**)" in disallowed
    # The action writes the job's GITHUB_TOKEN into the checkout's .git/config.
    assert "Read(**/.git/**)" in disallowed
    assert {"Bash", "Edit", "Write", "WebFetch", "WebSearch"} <= set(disallowed)


def test_a_failed_or_timed_out_review_doesnt_fail_the_check():
    # #123: a failed check leaves the PR UNSTABLE, which PR Auto-Merge never merges.
    yaml = pytest.importorskip("yaml")
    jobs = yaml.safe_load(bench.WORKFLOW.read_text())["jobs"]
    step = next(s for s in jobs["review"]["steps"] if s.get("id") == "claude")
    assert step["continue-on-error"] is True
    assert step["timeout-minutes"] < jobs["review"]["timeout-minutes"]
    # Gated on a flag that can't hold a secret, not on findings, which GitHub
    # empties when they quote one: the post step then fails on them.
    assert "needs.review.outputs.reviewed == 'true'" in jobs["post"]["if"]
    assert "findings" not in jobs["post"]["if"]
    assert jobs["review"]["outputs"]["reviewed"] == "${{ steps.claude.outputs.structured_output != '' }}"
    # Findings come from the answer check, never straight from Claude's step,
    # whose value the post job's log would print.
    assert jobs["review"]["outputs"]["findings"] == "${{ steps.answer.outputs.findings }}"
    answer = next(s for s in jobs["review"]["steps"] if s.get("id") == "answer")
    # Nothing publishes Claude's transcript before that check runs.
    review = next(s for s in jobs["review"]["steps"] if s.get("id") == "claude")
    assert review["with"]["display_report"] is False and review["with"]["show_full_output"] is False
    # Nor does a debug run, where the action shows the full output anyway.
    assert "runner.debug != '1'" in review["if"] and review["env"]["ACTIONS_STEP_DEBUG"] == "false"
    assert "structured_output" not in str(answer.get("env"))
    # The check holds the OAuth token, so it runs inline from the workflow,
    # never from a script the PR could change.
    assert "python3 -I - <<'PY'" in answer["run"] and ".github/scripts" not in answer["run"]
    # The post job, which can post under the marker, runs the base's script.
    post = next(s for s in jobs["post"]["steps"] if s.get("name") == "Post the review on the head commit")
    assert 'git show "HEAD^1:.github/scripts/post_claude_review.py"' in post["run"]
    assert "python3 -I \"$script\"" in post["run"] and "python3 .github" not in post["run"]
    checkout = next(s for s in jobs["post"]["steps"] if "checkout" in s.get("uses", ""))
    assert checkout["with"]["fetch-depth"] == 2 and "ref" not in checkout["with"]
    # And Claude may answer only in the fields that get posted.
    claude_args = review["with"]["claude_args"]
    assert claude_args.count('"additionalProperties": false') == 2


# bad_lines() (#122)

def test_a_line_past_the_end_or_a_missing_file_is_bad(tmp_path):
    import subprocess
    # Hooks and signing off, as above.
    git = lambda *a: subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                                     "-C", str(tmp_path), *a], check=True, capture_output=True)
    git("init", "-q")
    (tmp_path / "three.md").write_text("a\nb\nc\n")
    (tmp_path / "no-newline.md").write_text("a\nb")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c")
    findings = [{"path": "three.md", "line": 3}, {"path": "three.md", "line": 4}, {"path": "three.md", "line": 0},
                {"path": "no-newline.md", "line": 2}, {"path": "gone.md", "line": 1}]

    assert bench.bad_lines(tmp_path, "HEAD", findings) == ["three.md:4", "three.md:0", "gone.md:1"]


def test_bad_lines_is_none_without_the_clone(tmp_path):
    assert bench.bad_lines(tmp_path / "missing", "HEAD", [{"path": "a", "line": 1}]) is None


# The post step takes the script from the merge commit's first parent (#134)

def run_post_step(tmp_path, base_script, findings='{"summary": "s", "findings": []}', merge=True):
    import subprocess
    yaml = pytest.importorskip("yaml")
    jobs = yaml.safe_load(bench.WORKFLOW.read_text())["jobs"]
    run = next(s for s in jobs["post"]["steps"] if s.get("name") == "Post the review on the head commit")["run"]
    repo, temp = tmp_path / "repo", tmp_path / "temp"
    repo.mkdir(), temp.mkdir()
    # Hooks and signing off, as above.
    git = lambda *a: subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                                     "-c", "user.name=t", "-c", "user.email=t@t", "-C", str(repo), *a],
                                    check=True, capture_output=True)
    git("init", "-q", "-b", "main")
    scripts = repo / ".github" / "scripts"
    scripts.mkdir(parents=True)
    (repo / "README.md").write_text("base\n")
    if base_script is not None:
        (scripts / "post_claude_review.py").write_text(base_script)
    git("add", "-A")
    git("commit", "-q", "-m", "base")
    git("checkout", "-q", "-b", "pr")
    # The PR's own copy, which the step must never run.
    (scripts / "post_claude_review.py").write_text("import sys\nprint('the PR script')\nsys.exit(3)\n")
    git("add", "-A")
    git("commit", "-q", "-m", "pr")
    if merge:
        git("checkout", "-q", "main")
        git("merge", "-q", "--no-ff", "-m", "merge", "pr")
    env = {"PATH": __import__("os").environ["PATH"], "RUNNER_TEMP": str(temp), "REPOSITORY": "o/r",
           "PR_NUMBER": "7", "HEAD_SHA": "abc", "FINDINGS": findings}
    return subprocess.run(["bash", "-e", "-c", run], cwd=repo, env=env, capture_output=True, text=True)


def test_the_post_step_runs_the_bases_script_not_the_prs(tmp_path):
    done = run_post_step(tmp_path, "import sys\nprint('the base script', *sys.argv[1:])\n")

    assert done.returncode == 0
    assert done.stdout.strip() == "the base script --repo o/r --pr 7 --head abc"


def test_a_base_without_the_script_warns_and_posts_nothing(tmp_path):
    done = run_post_step(tmp_path, None)

    assert done.returncode == 0
    assert done.stdout.startswith("::warning::The base has no .github/scripts/post_claude_review.py yet")
    assert "the PR script" not in done.stdout


def test_a_base_without_the_script_still_fails_a_withheld_answer(tmp_path):
    done = run_post_step(tmp_path, None, findings="")

    assert done.returncode == 1 and "rotate CLAUDE_CODE_OAUTH_TOKEN" in done.stdout


def test_a_checkout_that_isnt_a_merge_commit_fails(tmp_path):
    done = run_post_step(tmp_path, "print('the base script')\n", merge=False)

    assert done.returncode == 1 and done.stdout.startswith("::error::The checkout isn't the PR's merge commit")


# diff_step() and split_diff(), against the real Template workflow

def test_the_benchmark_splits_the_diff_with_the_workflows_own_step(tmp_path):
    pytest.importorskip("yaml")
    (tmp_path / "claude-review").mkdir()
    diff = "".join(f"diff --git a/f{i}.py b/f{i}.py\n--- a/f{i}.py\n+++ b/f{i}.py\n@@ -1 +1 @@\n-old\n+new\n"
                   for i in range(3))
    (tmp_path / "claude-review" / "pr.diff").write_text(diff)
    for name in ("attr.numstat", "plain.numstat"):
        (tmp_path / "claude-review" / name).write_bytes(b"")
    pieces = bench.split_diff(bench.diff_step(bench.WORKFLOW), tmp_path)
    folder = tmp_path / "claude-review" / "diff"
    assert pieces == f"- {folder}/001.diff (18 lines: source)"
    assert (folder / "001.diff").read_text() == diff
    assert (folder / "INDEX").exists()


# transcript()

def test_the_transcript_gives_the_result_and_each_turns_reads():
    lines = [
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"id": "m1", "content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "/t/diff/INDEX"}}]}},
        {"type": "assistant", "message": {"id": "m1", "content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "/t/diff/0001.diff"}}]}},
        {"type": "user", "message": {"content": []}},
        {"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": "done"}]}},
        {"type": "result", "num_turns": 6, "structured_output": {"summary": "s", "findings": []}},
    ]
    result, reads = bench.transcript("\n".join(json.dumps(line) for line in lines) + "\n")
    assert result["num_turns"] == 6
    assert reads == [["/t/diff/INDEX", "/t/diff/0001.diff"]]


def test_a_transcript_without_a_result_is_an_error():
    with pytest.raises(json.JSONDecodeError):
        bench.transcript(json.dumps({"type": "system"}) + "\n")
