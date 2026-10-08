#!/usr/bin/env python3
"""Score Claude Review against findings Copilot made on the same commits (#117).

    claude-review-bench.py [--effort high] [--model claude-opus-5-5] [--prompt-file p.txt]
                           [--tools Read,Glob,Grep,WebFetch] [--only 4b90c96] [--root ~/github]

Each case in claude-review-cases.json is a commit of a local clone under
--root. For each one this checks the commit out in a temporary worktree,
writes its diff against the case's base, and runs `claude -p` with the
prompt and claude_args of the Template's claude-review.yml, so it tests what
the workflow runs; the flags override one part at a time. The repo's own
settings and CLAUDE.md load, as in CI; user-level settings and plugins don't.

It is close to the workflow, not identical: it runs the `claude` on PATH,
not the Claude Code version the pinned claude-code-action installs. The
results file records the CLI version, so a rerun on another version is told
apart. It takes the case's root Claude Code config (`.claude/`, `.mcp.json`,
`CLAUDE.md`, `CLAUDE.local.md`) from the base, starts no MCP servers and runs
git with hooks off, so a head commit's settings, hooks and servers never run.
Nested `CLAUDE.md` files and `.claude/skills` in subdirectories still come
from the head, as the diff Claude reads does.

It runs Claude on your machine with an unscoped Read, against code from the
case's commits. Only add a case whose commits you trust, and read a results
file before committing it: a prompt-injected diff could put local files in
the findings. Needs PyYAML (for reading the workflow) and git.

It prints each case's findings and which expected findings they caught, and
writes the run to bench/results/<timestamp>.json. Matching is by keyword, so
read the findings too: a miss can be a finding worded another way.
"""

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
WORKFLOW = HERE.parent / "template/owned/.github/workflows/claude-review.yml"


def review_step(workflow):
    """The prompt and claude_args of the workflow's Review step."""
    import yaml  # PyYAML; imported here so the scoring code and its tests don't need it
    jobs = yaml.safe_load(workflow.read_text())["jobs"]
    step = next((s for s in jobs["review"]["steps"] if s.get("id") == "claude"), None)
    if step is None:
        sys.exit(f"claude-review-bench.py: no step with id: claude in {workflow}'s review job")
    return step["with"]["prompt"], step["with"]["claude_args"]


def render(text, pr, temp):
    """Fill in the workflow expressions the prompt and args use."""
    text = text.replace("${{ github.event.pull_request.number }}", str(pr))
    text = text.replace("${{ runner.temp }}", str(temp))
    left = re.findall(r"\$\{\{[^}]*\}\}", text)
    if left:
        sys.exit(f"claude-review-bench.py: unrendered expressions: {left}")
    return text


def override(args, effort, model, tools):
    """claude_args with one flag's value replaced, or the flag added."""
    def put(flag, value):
        if flag in args:
            args[args.index(flag) + 1] = value
        else:
            args.extend([flag, value])
    if effort:
        put("--effort", effort)
    if model:
        put("--model", model)
    if tools:
        put("--allowedTools", tools)
        if "--disallowedTools" in args:
            i = args.index("--disallowedTools") + 1
            allowed = set(tools.split(","))
            args[i] = ",".join(t for t in args[i].split(",") if t not in allowed)
    return args


def caught(finding, findings_found):
    """The found findings on one of the finding's paths that mention every word group of it.

    Words match whole: "tab" doesn't match "table", nor "cap" "escape".
    """
    def mentions(text, word):
        return re.search(r"(?<![a-z0-9])" + re.escape(word.lower()) + r"(?![a-z0-9])", text) is not None
    def matches(text):
        text = text.lower()
        return all(any(mentions(text, word) for word in group) for group in finding["match"])
    def on_path(found):
        return not finding.get("paths") or any(str(found.get("path", "")).endswith(p) for p in finding["paths"])
    return [f for f in findings_found if on_path(f) and matches(str(f.get("body", "")))]


# Git with hooks off: Baseline repos set a relative core.hooksPath, so a worktree's own
# hooks (a case head's post-checkout) would otherwise run here.
GIT = ["git", "-c", "core.hooksPath=/dev/null"]


# What Claude Code reads from a project: its settings and hooks, its MCP servers, and its instructions.
PROJECT_CONFIG = (".claude", ".mcp.json", "CLAUDE.md", "CLAUDE.local.md")


def use_base_settings(tree, base):
    """Replace the head's root Claude Code config with the base's, so a case's own settings, hooks and MCP servers
    never load. --strict-mcp-config (in run_case) also keeps any MCP server from starting."""
    for name in PROJECT_CONFIG:
        path = tree / name
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
        listed = subprocess.run([*GIT, "-C", str(tree), "ls-tree", base, "--", name],
                                check=True, capture_output=True, text=True).stdout
        if listed.strip():
            subprocess.run([*GIT, "-C", str(tree), "checkout", base, "--", name], check=True, capture_output=True, text=True)


def run_case(case, prompt, claude_args, overrides, root, timeout):
    """One case's review, or an error outcome: a failed case never ends the run."""
    repo = root / case["repo"]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="claude-review-bench-") as temp:
        temp = Path(temp)
        tree = temp / "tree"
        added = False
        try:
            subprocess.run([*GIT, "-C", str(repo), "worktree", "add", "-q", "--detach", str(tree), case["head"]],
                           check=True, capture_output=True, text=True)
            added = True
            use_base_settings(tree, case["base"])
            # The runner's plain git diff: no external diff tool or prefix settings from the global config, and
            # any file encoding read without failing.
            diff = subprocess.run([*GIT, "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-C", str(tree),
                                   "diff", "--no-color", "--no-ext-diff", f"{case['base']}...{case['head']}"],
                                  check=True, capture_output=True, encoding="utf-8", errors="replace").stdout
            (temp / "pr.diff").write_text(diff)
            argv = ["claude", "-p", render(prompt, case["pr"], temp),
                    *override(shlex.split(render(claude_args, case["pr"], temp)), *overrides),
                    "--output-format", "json", "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence"]
            done = subprocess.run(argv, cwd=tree, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"error": f"timed out after {timeout}s", "seconds": round(time.monotonic() - started)}
        except (subprocess.CalledProcessError, OSError) as error:
            # A missing clone or commit.
            detail = getattr(error, "stderr", None) or ""
            return {"error": f"{error} {detail}".strip(), "seconds": round(time.monotonic() - started)}
        finally:
            if added:
                subprocess.run([*GIT, "-C", str(repo), "worktree", "remove", "--force", str(tree)], check=False)
    seconds = round(time.monotonic() - started)
    if done.returncode != 0:
        return {"error": (done.stderr or done.stdout)[-2000:], "seconds": seconds}
    try:
        data = json.loads(done.stdout)
        review = data.get("structured_output")
        if review is None:
            review = json.loads(data.get("result") or "{}")
    except (json.JSONDecodeError, AttributeError) as error:
        return {"error": f"no structured review ({error}): {done.stdout[-2000:]}", "seconds": seconds}
    # The shape post_claude_review.py accepts; anything else is this case's error, not the run's.
    if not (isinstance(review, dict) and isinstance(review.get("findings"), list)
            and all(isinstance(f, dict) for f in review["findings"])):
        return {"error": f"review isn't an object with a list of findings: {str(review)[:2000]}", "seconds": seconds}
    return {"review": review, "seconds": seconds, "cost_usd": data.get("total_cost_usd"),
            "turns": data.get("num_turns")}


def score(spec, case, outcome):
    """{finding: caught} for the case's expected findings, and (required caught, required total)."""
    found = (outcome.get("review") or {}).get("findings", [])
    hits = {key: bool(caught(spec["findings"][key], found)) for key in case["expect"]}
    required = [key for key in case["expect"] if not spec["findings"][key].get("optional")]
    return hits, (sum(hits[key] for key in required), len(required))


def report(spec, case, outcome, hits):
    found = (outcome.get("review") or {}).get("findings", [])
    print(f"== {case['repo']}#{case['pr']} {case['head']}", flush=True)
    if "error" in outcome:
        print(f"   error: {outcome['error']}")
    copilot = f" (Copilot opened {case['copilot_threads']} thread(s))" if "copilot_threads" in case else ""
    print(f"   {outcome.get('seconds')}s, {outcome.get('turns')} turns, ${outcome.get('cost_usd')}; "
          f"{len(found)} finding(s){copilot}")
    for key, hit in hits.items():
        optional = " (optional)" if spec["findings"][key].get("optional") else ""
        print(f"   {'caught' if hit else 'missed'} {key}{optional}: {spec['findings'][key]['about']}")
    for f in found:
        print(f"   - {f.get('path')}:{f.get('line')}: {' '.join(str(f.get('body', '')).split())[:300]}")


def rescore(spec, path):
    """Score a saved run again with the current cases file, and write the new score back into it."""
    saved = json.loads(path.read_text())
    cases = {c["head"]: c for c in spec["cases"]}
    total = [0, 0]
    for result in saved["cases"]:
        case = {**result, **cases.get(result["head"], {})}
        hits, (got, out_of) = score(spec, case, result)
        report(spec, case, result, hits)
        result["caught"] = hits
        total[0] += got
        total[1] += out_of
    saved["score"] = total
    path.write_text(json.dumps(saved, indent=2) + "\n")
    print(f"\nscore: {total[0]}/{total[1]} required findings caught (written back to {path.name})")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--effort", help="replace --effort (low, medium, high, xhigh, max)")
    parser.add_argument("--model", help="replace --model")
    parser.add_argument("--prompt-file", type=Path, help="replace the prompt")
    parser.add_argument("--tools", help="replace --allowedTools, and drop these from --disallowedTools")
    parser.add_argument("--only", help="run only the case with this head (in either set)")
    parser.add_argument("--set", default="recall", help="which cases: recall (findings to catch) or noise (ordinary PRs)")
    parser.add_argument("--root", type=Path, default=Path.home() / "github", help="where the cases' clones live")
    parser.add_argument("--timeout", type=int, default=1800, help="seconds per case")
    parser.add_argument("--label", default="", help="a name for this run in its results file")
    parser.add_argument("--rescore", type=Path, nargs="+",
                        help="score saved results files again with the current cases file, without running Claude, "
                             "and write the new scores back")
    args = parser.parse_args()

    spec = json.loads((HERE / "claude-review-cases.json").read_text())
    if args.rescore:
        for path in args.rescore:
            print(f"#### {path.name}")
            rescore(spec, path)
        return

    if shutil.which("claude") is None:
        sys.exit("claude-review-bench.py: claude isn't on PATH")
    prompt, claude_args = review_step(WORKFLOW)
    if args.prompt_file:
        prompt = args.prompt_file.read_text()
    overrides = (args.effort, args.model, args.tools)
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    path = out / f"{time.strftime('%Y%m%dT%H%M%S')}{'-' + args.label if args.label else ''}.json"
    run = {"label": args.label,
           "claude_version": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(),
           "claude_args": claude_args, "overrides": overrides, "prompt": prompt, "score": [0, 0], "cases": []}

    # --only names one case, whichever set it's in.
    selected = [c for c in spec["cases"]
                if (c["head"].startswith(args.only) if args.only else c.get("set", "recall") == args.set)]
    if not selected:
        sys.exit(f"claude-review-bench.py: no case matches {'--only ' + args.only if args.only else '--set ' + args.set}")
    for case in selected:
        outcome = run_case(case, prompt, claude_args, overrides, args.root, args.timeout)
        hits, (got, out_of) = score(spec, case, outcome)
        report(spec, case, outcome, hits)
        run["cases"].append({**case, **outcome, "caught": hits})
        run["score"] = [run["score"][0] + got, run["score"][1] + out_of]
        # Written after every case, so a long run that stops part way keeps what it has.
        path.write_text(json.dumps(run, indent=2) + "\n")

    print(f"\nscore: {run['score'][0]}/{run['score'][1]} required findings caught")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
