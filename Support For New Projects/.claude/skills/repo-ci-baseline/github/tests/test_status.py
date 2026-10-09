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
        "reviews": {"nodes": [{"author": {"login": review[0]}, "commit": {"oid": review[1]},
                               "body": review[2] if len(review) > 2 else ""} for review in reviews]},
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
    for part in ("1234567", "ready", "CLEAN", "review:copilot", "threads:1", "automerge:off",
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


def test_dotfiles_leaves_a_reviewed_pr_to_its_pr_auto_merge_like_a_baseline_repo(monkeypatch):
    monkeypatch.setattr(st, "read_repo_list", lambda: {"owner/app": "full", "owner/dots": "repo-settings-only"})
    reviewed = pr_node(reviews=[("Copilot", HEAD)])
    code, out, _ = run([], {"owner/app": repo(reviewed), "owner/dots": repo(reviewed)})
    app, dots = out.splitlines()
    assert "-> leave to PR Auto-Merge" in app and "-> leave to PR Auto-Merge" in dots


def test_copilot_requests_and_the_review_claude_label_are_read():
    node = dict(pr_node(), labels={"nodes": [{"name": "docs-only"}, {"name": "review:claude"}]},
                reviewRequests={"nodes": [{"requestedReviewer": {"login": "someone"}},
                                          {"requestedReviewer": {"login": "Copilot"}}]})
    pr = st.to_state(node, **st.repo_flags("full"))
    assert pr.copilot_requested and pr.claude_requested
    # A person or a team requested isn't Copilot; an empty requestedReviewer (a deleted account) is nothing.
    other = dict(pr_node(), labels={"nodes": []},
                 reviewRequests={"nodes": [{"requestedReviewer": {"name": "core-team"}}, {"requestedReviewer": None}]})
    pr = st.to_state(other, **st.repo_flags("full"))
    assert not pr.copilot_requested and not pr.claude_requested
    # A node without either field, as older fixtures have, reads as neither.
    assert not st.to_state(pr_node(), **st.repo_flags("full")).copilot_requested


def test_a_release_blog_pr_is_told_apart_by_its_branch():
    blog = st.to_state(dict(pr_node(), headRefName="docs/release-notes"), **st.repo_flags("full"))
    other = st.to_state(dict(pr_node(), headRefName="feat/x"), **st.repo_flags("full"))
    assert blog.release_blog and not other.release_blog
    assert blog.merged_by_workflow and blog.checks_required
    assert st.repo_flags("repo-settings-only") == {"checks_required": True, "merged_by_workflow": True}


def test_the_review_column_names_the_reviewer_of_the_head():
    claude = pr_node(reviews=[("github-actions", HEAD, "<!-- claude-review -->\n**Claude Review**")])
    unmarked = pr_node(number=8, reviews=[("github-actions", HEAD, "Something else.")])
    _, out, _ = run(["owner/app"], {"owner/app": repo(claude, unmarked)})
    first, second = out.splitlines()
    assert "review:claude" in first and "Claude reviewed the head" in first
    assert "review:no" in second


def test_the_query_fetches_review_bodies():
    assert "author { login } commit { oid } body" in st.QUERY


def test_claude_findings_outside_the_diff_hold_the_landing_decision():
    off = "<!-- claude-review -->\n<!-- claude-review:off-diff -->\n**Claude Review**"
    _, out, _ = run(["owner/app"], {"owner/app": repo(pr_node(reviews=[("github-actions", HEAD, off)]))})
    assert "review:claude" in out and "-> wait (Claude's review of 1234567 has findings outside the diff)" in out


def test_check_runs_carry_their_database_id_as_rank():
    check = st.to_check({"__typename": "CheckRun", "databaseId": 113578170924, "name": "Test Suite",
                         "status": "COMPLETED", "conclusion": "CANCELLED", "startedAt": None})
    assert check.rank == 113578170924 and check.started_at == ""
