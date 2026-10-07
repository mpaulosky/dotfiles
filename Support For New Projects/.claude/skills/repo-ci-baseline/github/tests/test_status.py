"""Tests for github/status.py with the GraphQL fetch replaced by fixtures. No GitHub."""

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import status as st  # noqa: E402

HEAD = "1234567" + "0" * 33


def pr_node(number=7, title="feat: Something", draft=False, merge_state="CLEAN", reviews=(), threads=(),
            contexts=(), armed=False):
    return {
        "number": number, "title": title, "state": "OPEN", "isDraft": draft, "headRefOid": HEAD,
        "mergeStateStatus": merge_state,
        "autoMergeRequest": {"enabledAt": "2026-10-07T10:00:00Z"} if armed else None,
        "reviews": {"nodes": [{"author": {"login": login}, "commit": {"oid": oid}} for login, oid in reviews]},
        "reviewThreads": {"nodes": [{"isResolved": resolved} for resolved in threads]},
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": list(contexts)}}
                                          if contexts else None}}]},
    }


def run(argv, data):
    out, err = io.StringIO(), io.StringIO()
    code = st.main(argv, fetch=lambda owner, name: data[f"{owner}/{name}"], out=out, err=err)
    return code, out.getvalue(), err.getvalue()


def repo(*nodes):
    return {"repository": {"pullRequests": {"nodes": list(nodes)}}}


def test_one_line_per_pr_with_the_next_action():
    node = pr_node(reviews=[("copilot-pull-request-reviewer", HEAD)], threads=[True, False],
                   contexts=[{"__typename": "CheckRun", "name": "Test Suite", "status": "COMPLETED",
                              "conclusion": "CANCELLED", "startedAt": "2026-10-07T10:00:00Z"},
                             {"__typename": "CheckRun", "name": "Test Suite", "status": "IN_PROGRESS",
                              "conclusion": None, "startedAt": "2026-10-07T10:02:00Z"},
                             {"__typename": "StatusContext", "context": "codecov", "state": "FAILURE",
                              "createdAt": "2026-10-07T10:01:00Z"}])
    code, out, err = run(["owner/app"], {"owner/app": repo(node)})
    assert code == 0 and err == ""
    assert out.count("\n") == 1
    assert out.startswith("app#7 feat: Something")
    for part in ("1234567", "ready", "CLEAN", "copilot:head", "threads:1", "automerge:off",
                 "running:1", "failed:1", "cancelled:0", "-> report blocker (failed: codecov)"):
        assert part in out


def test_a_long_title_is_shortened():
    code, out, _ = run(["owner/app"], {"owner/app": repo(pr_node(title="x" * 80))})
    assert "x" * (st.TITLE_WIDTH - 1) + "…" in out and "x" * st.TITLE_WIDTH not in out


def test_no_open_pr_is_one_clear_line():
    code, out, _ = run(["owner/app", "owner/lib"], {"owner/app": repo(), "owner/lib": repo()})
    assert code == 0 and out == "No open PRs in 2 repo(s).\n"


def test_an_unreadable_repo_is_reported_and_the_rest_still_print():
    def fetch(owner, name):
        if name == "gone":
            raise RuntimeError("Could not resolve to a Repository")
        return repo(pr_node(draft=True))

    out, err = io.StringIO(), io.StringIO()
    code = st.main(["owner/gone", "owner/app"], fetch=fetch, out=out, err=err)
    assert code == 1 and "owner/gone: Could not resolve" in err.getvalue()
    assert "app#7" in out.getvalue() and "-> wait (draft)" in out.getvalue()


def test_a_repo_settings_only_repo_waits_for_green_checks(monkeypatch):
    monkeypatch.setattr(st, "read_repo_list", lambda: {"owner/dots": "repo-settings-only"})
    node = pr_node(reviews=[("Copilot", HEAD)],
                   contexts=[{"__typename": "CheckRun", "name": "Template tests", "status": "IN_PROGRESS",
                              "conclusion": None, "startedAt": "2026-10-07T10:00:00Z"}])
    code, out, _ = run([], {"owner/dots": repo(node)})
    assert "-> wait (no required checks; waiting for: Template tests)" in out
