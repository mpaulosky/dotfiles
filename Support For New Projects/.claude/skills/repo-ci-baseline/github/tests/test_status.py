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
        # A thread is True/False (resolved or not) or a full node from thread_node().
        "reviewThreads": {"nodes": [{"isResolved": thread} if isinstance(thread, bool) else thread
                                    for thread in threads]},
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": list(contexts)}}
                                          if contexts else None}}]},
    }


def thread_node(login="copilot-pull-request-reviewer", kind="Bot", review="", replies=(), resolved=True,
                path="src/a.py", line=12, total=None):
    """A reviewThreads node with comments: the opener, then one reply per login in replies."""
    comments = [{"url": "https://github.com/o/r/pull/7#discussion_r1",
                 "author": {"login": login, "__typename": kind} if login else None,
                 "pullRequestReview": {"body": review}}]
    comments += [{"url": "https://github.com/o/r/pull/7#discussion_r2", "author": {"login": reply, "__typename": "User"},
                  "pullRequestReview": None} for reply in replies]
    return {"isResolved": resolved, "path": path, "line": line, "originalLine": line,
            "comments": {"totalCount": len(comments) if total is None else total, "nodes": comments}}


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


def test_a_one_shot_read_shows_the_copilot_step_for_an_unreviewed_head(monkeypatch):
    # It can't know an earlier request for the head was dropped, so it never says Claude.
    monkeypatch.setattr(st, "read_repo_list", lambda: {"owner/app": "full"})
    green = [{"__typename": "CheckRun", "name": "Test Suite", "status": "COMPLETED", "conclusion": "SUCCESS",
              "startedAt": "2026-10-07T10:00:00Z"}]
    code, out, _ = run([], {"owner/app": repo(pr_node(contexts=green))})
    assert "-> request Copilot" in out


def test_a_reapply_pr_reaches_the_review_cap_like_any_other():
    # #174: a re-Apply PR is no longer exempt from PR Auto-Merge's cap.
    node = dict(pr_node(), headRefName="chore/reapply-baseline")
    assert st.to_state(node, **st.repo_flags("full")) == st.to_state(dict(node, headRefName="feat/x"), **st.repo_flags("full"))


def test_a_release_blog_pr_is_told_apart_by_its_branch():
    blog = st.to_state(dict(pr_node(), headRefName="docs/release-notes"), **st.repo_flags("full"))
    other = st.to_state(dict(pr_node(), headRefName="feat/x"), **st.repo_flags("full"))
    assert blog.release_blog and not other.release_blog
    assert blog.merged_by_workflow and blog.checks_required
    assert st.repo_flags("repo-settings-only") == {"checks_required": True, "merged_by_workflow": True}


def test_the_review_column_names_the_reviewer_of_the_head():
    claude = pr_node(reviews=[("copilot-pull-request-reviewer", HEAD, "Copilot was unable to review this pull request because the quota is used up."), ("github-actions", HEAD, "<!-- claude-review -->\n**Claude Review**")])
    unmarked = pr_node(number=8, reviews=[("github-actions", HEAD, "Something else.")])
    _, out, _ = run(["owner/app"], {"owner/app": repo(claude, unmarked)})
    first, second = out.splitlines()
    assert "review:claude" in first and "Claude reviewed the head" in first
    assert "review:no" in second
    # Without Copilot's quota note on the head, Claude's review covers nothing (#270).
    bare = pr_node(reviews=[("github-actions", HEAD, "<!-- claude-review -->\n**Claude Review**")])
    _, out, _ = run(["owner/app"], {"owner/app": repo(bare)})
    assert "review:no" in out


def test_the_query_fetches_review_bodies_and_whether_each_commit_is_a_merge():
    assert "author { login } commit { oid parents { totalCount } } body" in st.QUERY


def test_claude_findings_outside_the_diff_hold_the_landing_decision():
    off = "<!-- claude-review -->\n<!-- claude-review:off-diff -->\n**Claude Review**"
    _, out, _ = run(["owner/app"], {"owner/app": repo(pr_node(reviews=[("copilot-pull-request-reviewer", HEAD, "Copilot was unable to review this pull request because the quota is used up."), ("github-actions", HEAD, off)]))})
    assert "review:claude" in out and "-> wait (Claude's review of 1234567 has findings outside the diff)" in out


def test_check_runs_carry_their_database_id_as_rank():
    check = st.to_check({"__typename": "CheckRun", "databaseId": 113578170924, "name": "Test Suite",
                         "status": "COMPLETED", "conclusion": "CANCELLED", "startedAt": None})
    assert check.rank == 113578170924 and check.started_at == ""


# ── Resolved bot threads nobody replied to ──────────────────────────────────

NOTICE = "notice: resolved without a reply: "
CLAUDE_REVIEW = "<!-- claude-review -->\n**Claude Review**"


def line_of(*threads):
    _, out, _ = run(["owner/app"], {"owner/app": repo(pr_node(threads=threads))})
    return out


def test_a_resolved_bot_thread_with_no_reply_ends_the_line_with_a_notice():
    out = line_of(thread_node())
    assert out.count("\n") == 1 and out.rstrip("\n").endswith(NOTICE + "src/a.py:12")
    assert "threads:0" in out


def test_a_resolved_claude_review_thread_with_no_reply_is_noticed_too():
    assert line_of(thread_node(login="github-actions", review=CLAUDE_REVIEW)).rstrip("\n").endswith(NOTICE + "src/a.py:12")


def test_a_thread_with_a_reply_has_no_notice():
    assert "notice" not in line_of(thread_node(replies=["octo"]))


def test_a_persons_thread_and_a_sandcastle_replied_thread_have_no_notice():
    assert "notice" not in line_of(thread_node(login="octo", kind="User"))
    # Sandcastle's reply is posted under the owner's login, so it is just a reply.
    assert "notice" not in line_of(thread_node(replies=["octo"]), thread_node(login="octo", kind="User"))


def test_another_workflows_github_actions_thread_and_an_unresolved_bot_thread_have_no_notice():
    assert "notice" not in line_of(thread_node(login="github-actions", review="Some other workflow's review."))
    out = line_of(thread_node(resolved=False))
    assert "notice" not in out and "threads:1" in out


def test_a_thread_with_more_comments_than_were_read_has_no_notice():
    assert "notice" not in line_of(thread_node(total=11))


def test_a_thread_without_a_path_or_a_line_is_named_by_what_it_has():
    assert line_of(thread_node(path="src/a.py", line=None)).rstrip("\n").endswith(NOTICE + "src/a.py")
    assert line_of(thread_node(path=None, line=None)).rstrip("\n").endswith(NOTICE + "thread")
    original = dict(thread_node(line=None), originalLine=4)
    assert line_of(original).rstrip("\n").endswith(NOTICE + "src/a.py:4")


def test_the_notice_names_at_most_three_threads():
    out = line_of(*[thread_node(path=f"f{n}.py", line=n) for n in range(1, 6)])
    assert out.rstrip("\n").endswith(NOTICE + "f1.py:1, f2.py:2, f3.py:3 and 2 more")


def test_a_path_with_a_newline_or_an_escape_is_printed_escaped():
    out = line_of(thread_node(path="a\nb\x1b[31m.py"))
    assert out.count("\n") == 1
    assert "\x1b" not in out and "\\n" in out and "\\x1b" in out


def test_the_notice_leaves_the_landing_decision_alone():
    reviewed = [("copilot-pull-request-reviewer", HEAD)]
    plain = run(["owner/app"], {"owner/app": repo(pr_node(reviews=reviewed, threads=[True]))})[1]
    noticed = run(["owner/app"], {"owner/app": repo(pr_node(reviews=reviewed, threads=[thread_node()]))})[1]
    assert noticed.startswith(plain.rstrip("\n")) and noticed.rstrip("\n").endswith(NOTICE + "src/a.py:12")
    assert noticed.split(" -> ")[1].split(" notice:")[0] == plain.split(" -> ")[1].rstrip("\n")


def test_threads_with_no_comments_key_print_as_before():
    out = line_of(True, False)
    assert "notice" not in out and "threads:1" in out
    assert "notice" not in line_of({"isResolved": True, "comments": None})


def test_to_state_lists_the_unreplied_threads():
    node = pr_node(threads=[thread_node(), thread_node(replies=["octo"], path="b.py"), thread_node(login="octo", kind="User")])
    assert st.to_state(node, **st.repo_flags("full")).unreplied_threads == ("src/a.py:12",)


def test_the_query_fetches_the_threads_comments_their_authors_and_reviews():
    threads = st.QUERY[st.QUERY.index("reviewThreads"):]
    threads = threads[:threads.index("commits(")]
    for field in ("isResolved", "path", "line", "originalLine", "comments(", "totalCount", "url", "author { login __typename }",
                  "pullRequestReview { body }"):
        assert field in threads, field
