"""Tests for github/status.py with the GraphQL fetch replaced by fixtures. No GitHub."""

import io
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import status as st  # noqa: E402

HEAD = "1234567" + "0" * 33


def ago(seconds):
    """An ISO-8601 time `seconds` ago, as GraphQL reports createdAt."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds))


def asked(age=3600, login="github-actions"):
    """The comment that records Copilot was asked (mpaulosky/dotfiles#360), as COMMENTS_QUERY reports it."""
    return {"author": {"login": login}, "body": "Asked Copilot.\n\n<!-- pr-automerge:copilot-asked -->", "createdAt": ago(age)}


def comments_of(*nodes, total=None):
    return {"totalCount": len(nodes) if total is None else total, "nodes": list(nodes)}


def pr_node(number=7, title="feat: Something", draft=False, merge_state="CLEAN", reviews=(), threads=(),
            contexts=(), armed=False, comments=comments_of()):
    return {
        "id": f"PR_{number}", "comments": comments,
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


def test_the_threads_query_fetches_the_threads_comments_their_authors_and_reviews():
    for field in ("isResolved", "path", "line", "originalLine", "comments(", "totalCount", "url", "author { login __typename }",
                  "pullRequestReview { body }"):
        assert field in st.THREADS_QUERY, field


def test_the_repo_query_reads_no_thread_comments_so_it_stays_at_about_three_points():
    threads = st.QUERY[st.QUERY.index("reviewThreads"):]
    threads = threads[:threads.index("commits(")]
    assert "comments" not in threads and "isResolved" in threads
    assert "id number" in st.QUERY


def fake_graphql(monkeypatch, repo_data, threads_by_id):
    """Replace st.graphql: the repo query answers repo_data, the threads query a PR's nodes by id; returns the calls."""
    calls = []

    def graphql(query, *fields, **raw):
        if query == st.COMMENTS_QUERY:
            return {"node": {"comments": comments_of()}}
        calls.append(raw.get("id"))
        if query == st.THREADS_QUERY:
            return {"node": {"reviewThreads": {"nodes": threads_by_id[raw["id"]]}}}
        return repo_data
    monkeypatch.setattr(st, "graphql", graphql)
    return calls


def test_only_a_pr_with_every_thread_resolved_and_a_bot_review_gets_the_comments_query(monkeypatch):
    reviewed = [("copilot-pull-request-reviewer", HEAD)]
    done = dict(pr_node(number=1, reviews=reviewed, threads=[True, True]), id="PR_done")
    open_thread = dict(pr_node(number=2, reviews=reviewed, threads=[True, False]), id="PR_open")
    unreviewed = dict(pr_node(number=3, threads=[True]), id="PR_unreviewed")
    no_threads = dict(pr_node(number=4, reviews=reviewed), id="PR_none")
    claude = dict(pr_node(number=5, reviews=[("github-actions", HEAD, "<!-- claude-review -->\nOK")], threads=[True]), id="PR_claude")
    someone = dict(pr_node(number=6, reviews=[("github-actions", HEAD, "another workflow")], threads=[True]), id="PR_other")
    calls = fake_graphql(monkeypatch, repo(done, open_thread, unreviewed, no_threads, claude, someone),
                         {"PR_done": [thread_node()], "PR_claude": [thread_node(replies=["octo"])]})
    data = st.gh_graphql("owner", "app")
    assert calls == [None, "PR_done", "PR_claude"]
    by_number = {node["number"]: node for node in data["repository"]["pullRequests"]["nodes"]}
    assert by_number[1]["reviewThreads"]["nodes"][0]["comments"]["totalCount"] == 1
    assert by_number[2]["reviewThreads"]["nodes"] == [{"isResolved": True}, {"isResolved": False}]
    state = st.to_state(by_number[1], **st.repo_flags("full"))
    assert state.unreplied_threads == ("src/a.py:12",)
    assert st.to_state(by_number[5], **st.repo_flags("full")).unreplied_threads == ()


def test_a_failed_or_empty_comments_query_keeps_the_repo_readable_and_gives_no_notice(monkeypatch, capsys):
    reviewed = [("copilot-pull-request-reviewer", HEAD)]
    boom = dict(pr_node(number=1, reviews=reviewed, threads=[True]), id="PR_boom")
    gone = dict(pr_node(number=2, reviews=reviewed, threads=[True]), id="PR_gone")
    fine = dict(pr_node(number=3, reviews=reviewed, threads=[True]), id="PR_fine")
    data = repo(boom, gone, fine)
    monkeypatch.setattr(st, "COMMENTS_FAILED", set())

    def graphql(query, *fields, **raw):
        if query != st.THREADS_QUERY:
            return data
        if raw["id"] == "PR_boom":
            raise RuntimeError("502 Bad Gateway")
        if raw["id"] == "PR_gone":
            return {"node": None}
        return {"node": {"reviewThreads": {"nodes": [thread_node()]}}}
    monkeypatch.setattr(st, "graphql", graphql)
    out, err = io.StringIO(), io.StringIO()
    assert st.main(["owner/app"], out=out, err=err) == 0
    lines = out.getvalue().splitlines()
    assert len(lines) == 3
    assert "notice" not in lines[0] and "notice" not in lines[1]
    assert lines[2].endswith("notice: resolved without a reply: src/a.py:12")
    assert "502 Bad Gateway" in capsys.readouterr().err
    st.gh_graphql("owner", "app")
    assert capsys.readouterr().err.count("502 Bad Gateway") == 0


# ── The record that Copilot was asked (mpaulosky/dotfiles#360) ──────────────

GREEN = [{"__typename": "CheckRun", "name": "Test Suite", "status": "COMPLETED", "conclusion": "SUCCESS",
          "startedAt": "2026-10-07T10:00:00Z"}]
OLDER = [("copilot-pull-request-reviewer", "f" * 40)]
FLAGS = st.repo_flags("full")
NOW = 1_800_000_000.0


def at(age):
    """asked(), as of NOW: a record `age` seconds old."""
    node = asked(0)
    node["createdAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - age))
    return node


def test_to_state_reads_the_record_and_when_it_settles():
    state = st.to_state(pr_node(comments=comments_of(at(31))), **FLAGS, owner="o", now=NOW)
    assert state.copilot_asked and state.copilot_ask_settled
    state = st.to_state(pr_node(comments=comments_of(at(29))), **FLAGS, owner="o", now=NOW)
    assert state.copilot_asked and not state.copilot_ask_settled
    state = st.to_state(pr_node(comments=comments_of()), **FLAGS, owner="o", now=NOW)
    assert not state.copilot_asked and not state.copilot_ask_settled


def test_to_state_trusts_a_record_only_from_github_actions_or_the_owner():
    for login, owner, counts in (("github-actions", "o", True), ("o", "o", True), ("stranger", "o", False), ("o", "p", False)):
        state = st.to_state(pr_node(comments=comments_of(at(3600) | {"author": {"login": login}})), **FLAGS, owner=owner, now=NOW)
        assert state.copilot_asked is counts, (login, owner)
    nobody = at(3600) | {"author": None}
    assert not st.to_state(pr_node(comments=comments_of(nobody)), **FLAGS, owner="o", now=NOW).copilot_asked


def test_comments_that_were_not_read_count_as_asked_but_not_settled():
    failed = pr_node(comments=None)
    absent = pr_node()
    del absent["comments"]
    # 150 comments with 1 read and no record among them: the record may be on a page that wasn't read.
    partial = pr_node(comments=comments_of(at(3600) | {"body": "LGTM"}, total=150))
    for node in (failed, absent, partial):
        state = st.to_state(node, **FLAGS, owner="o", now=NOW)
        assert state.copilot_asked and not state.copilot_ask_settled


def test_a_record_on_the_page_counts_even_when_there_are_more_comments():
    state = st.to_state(pr_node(comments=comments_of(at(3600), total=150)), **FLAGS, owner="o", now=NOW)
    assert state.copilot_asked and state.copilot_ask_settled


def test_the_line_asks_copilot_for_an_unasked_head_and_calls_in_claude_for_a_settled_record(monkeypatch):
    monkeypatch.setattr(st, "read_repo_list", lambda: {"octo/app": "full"})
    unasked = pr_node(reviews=OLDER, contexts=GREEN)
    settled = pr_node(number=8, reviews=OLDER, contexts=GREEN, comments=comments_of(asked(3600, login="octo")))
    fresh = pr_node(number=9, reviews=OLDER, contexts=GREEN, comments=comments_of(asked(5)))
    unread = pr_node(number=10, reviews=OLDER, contexts=GREEN)
    unread["comments"] = None
    code, out, _ = run([], {"octo/app": repo(unasked, settled, fresh, unread)})
    lines = out.splitlines()
    assert "-> request Copilot" in lines[0]
    # The owner is the repo's owner, taken from its name.
    assert "-> add review:claude" in lines[1]
    assert "-> wait" in lines[2] and "Copilot was asked" in lines[2]
    assert "-> wait" in lines[3] and "-> request Copilot" not in lines[3] and "-> add review:claude" not in lines[3]


def test_the_comments_query_reads_the_last_100_comments_with_their_author_body_and_time():
    for field in ("$id: ID!", "comments(last: 100)", "totalCount", "author { login }", "body", "createdAt"):
        assert field in st.COMMENTS_QUERY, field
    assert "comments(" not in st.QUERY


def comments_graphql(monkeypatch, repo_data, comments_by_id):
    """Replace st.graphql: the repo query answers repo_data, the comments query a PR's comments by id; returns the ids asked."""
    asked_ids = []

    def graphql(query, *fields, **raw):
        if query == st.COMMENTS_QUERY:
            asked_ids.append(raw["id"])
            answer = comments_by_id[raw["id"]]
            if isinstance(answer, Exception):
                raise answer
            return {"node": {"comments": answer}}
        if query == st.THREADS_QUERY:
            raise AssertionError("no thread comments wanted here")
        return repo_data
    monkeypatch.setattr(st, "graphql", graphql)
    return asked_ids


def test_only_an_open_ready_pr_whose_head_copilot_hasnt_reviewed_or_been_asked_for_gets_the_comments_query(monkeypatch):
    on_head = [("copilot-pull-request-reviewer", HEAD)]
    wanted = pr_node(number=1, reviews=OLDER, comments=None)
    never_reviewed = pr_node(number=2, comments=None)
    draft = pr_node(number=3, draft=True, reviews=OLDER, comments=None)
    reviewed = pr_node(number=4, reviews=on_head, comments=None)
    requested = dict(pr_node(number=5, reviews=OLDER, comments=None),
                     reviewRequests={"nodes": [{"requestedReviewer": {"login": "Copilot"}}]})
    asked_ids = comments_graphql(monkeypatch, repo(wanted, never_reviewed, draft, reviewed, requested),
                                 {"PR_1": comments_of(asked(3600)), "PR_2": comments_of(asked(3600), asked(5))})
    data = st.gh_graphql("owner", "app")
    assert asked_ids == ["PR_1", "PR_2"]
    by_number = {node["number"]: node for node in data["repository"]["pullRequests"]["nodes"]}
    assert by_number[1]["comments"]["totalCount"] == 1 and by_number[2]["comments"]["totalCount"] == 2
    assert [by_number[number]["comments"] for number in (3, 4, 5)] == [None, None, None]


def test_a_failed_comments_query_keeps_the_repo_readable_and_makes_the_record_unread(monkeypatch, capsys):
    boom = pr_node(number=1, reviews=OLDER, contexts=GREEN)
    fine = pr_node(number=2, reviews=OLDER, contexts=GREEN)
    asked_ids = comments_graphql(monkeypatch, repo(boom, fine), {"PR_1": RuntimeError("502 Bad Gateway"), "PR_2": comments_of(asked(3600))})
    monkeypatch.setattr(st, "COMMENTS_FAILED", set())
    out, err = io.StringIO(), io.StringIO()
    assert st.main(["owner/app"], out=out, err=err) == 0
    lines = out.getvalue().splitlines()
    assert asked_ids == ["PR_1", "PR_2"]
    # PR 1's record is unread: neither a Copilot request nor Claude is called for.
    assert "-> request Copilot" not in lines[0] and "-> add review:claude" not in lines[0] and "-> wait" in lines[0]
    assert "-> add review:claude" in lines[1]
    assert "502 Bad Gateway" in capsys.readouterr().err
