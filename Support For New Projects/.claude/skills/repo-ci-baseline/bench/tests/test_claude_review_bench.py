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


def test_allowed_tools_are_dropped_from_the_disallowed_list():
    args = bench.override(list(ARGS), None, None, "Read,Glob,Grep,WebFetch")
    assert args[args.index("--allowedTools") + 1] == "Read,Glob,Grep,WebFetch"
    assert args[args.index("--disallowedTools") + 1] == "Bash,WebSearch"


# render()

def test_render_fills_in_the_workflow_expressions():
    text = "PR #${{ github.event.pull_request.number }}, diff in ${{ runner.temp }}/pr.diff"
    assert bench.render(text, 7, "/tmp/t") == "PR #7, diff in /tmp/t/pr.diff"


def test_render_refuses_an_expression_it_doesnt_know():
    with pytest.raises(SystemExit):
        bench.render("${{ secrets.TOKEN }}", 7, "/tmp/t")


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
    assert "#7" in bench.render(prompt, 7, "/tmp/t")
    for flag in ("--model", "--effort", "--json-schema", "--allowedTools"):
        assert flag in rendered, flag
    disallowed = rendered[rendered.index("--disallowedTools") + 1].split(",")
    assert "Read(//proc/**)" in disallowed
    assert {"Bash", "WebFetch", "WebSearch"} <= set(disallowed)
