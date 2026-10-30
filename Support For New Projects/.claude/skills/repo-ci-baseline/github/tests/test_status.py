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


def review_node(review):
    """A reviews node from (login, oid[, body[, extras]]); extras: at (submittedAt), threads (inline comments), merge."""
    extras = review[3] if len(review) > 3 else {}
    commit = {"oid": review[1]}
    if "merge" in extras:
        commit["parents"] = {"totalCount": 2 if extras["merge"] else 1}
    node = {"author": {"login": review[0]}, "commit": commit, "body": review[2] if len(review) > 2 else ""}
    if "at" in extras:
        node["submittedAt"] = extras["at"]
    if "threads" in extras:
        node["comments"] = {"totalCount": extras["threads"]}
    return node


def pr_node(number=7, title="feat: Something", draft=False, merge_state="CLEAN", reviews=(), threads=(),
            contexts=(), armed=False, comments=comments_of(), events=()):
    return {
        "id": f"PR_{number}", "comments": comments,
        # The PR's review:claude label events, all of them oldest first, as gh_graphql reads them (EVENTS_QUERY, paged)
        # and resolves the actor's write access: [{createdAt, writer}]; None is a read that failed (mpaulosky/dotfiles#378).
        "labelEvents": None if events is None else list(events),
        "number": number, "title": title, "state": "OPEN", "isDraft": draft, "headRefOid": HEAD,
        "mergeStateStatus": merge_state,
        "autoMergeRequest": {"enabledAt": "2026-10-07T10:00:00Z"} if armed else None,
        "reviews": {"nodes": [review_node(review) for review in reviews]},
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
        if query == st.EVENTS_QUERY and st.EVENTS_QUERY:
            return {"node": {"timelineItems": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}}}
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
        if st.EVENTS_QUERY and query == st.EVENTS_QUERY:
            return {"node": {"timelineItems": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}}}
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


# ── The review loop: dirty rounds in a row (mpaulosky/dotfiles#375) ─────────

COPILOT_LOGIN = "copilot-pull-request-reviewer"
COPILOT_REQUESTED = {"nodes": [{"requestedReviewer": {"login": "Copilot"}}]}


def round_of(number, dirty=True, minute=None, merge=False, login=COPILOT_LOGIN, body=""):
    """A review of a commit of its own at minute (default: number) of 2026-01-02T00, with an inline thread when dirty."""
    extras = {"at": f"2026-01-02T00:{number if minute is None else minute:02d}:00Z", "threads": 1 if dirty else 0, "merge": merge}
    return (login, f"{number:040x}", body, extras)


DIRTY3 = [round_of(1), round_of(2), round_of(3)]
EXHAUSTED_BODY = "**PR Auto-Merge: the review loop is exhausted.**\n\nNothing is left open.\n\n<!-- pr-automerge:review-loop-exhausted " + HEAD + " -->"


def marker_comment(at="2026-01-02T01:00:00Z", login="github-actions", body=EXHAUSTED_BODY):
    """PR Auto-Merge's comment on an exhausted loop, as COMMENTS_QUERY reports it."""
    return {"author": {"login": login}, "body": body, "createdAt": at}


def relabel(at="2026-01-02T02:00:00Z", writer=True):
    """A review:claude label event as to_state reads it: when, and whether the login that added it has write access."""
    return {"createdAt": at, "writer": writer}


# The ask was recorded long ago and nothing is pending: Copilot is gone, so a review:claude add can restart the loop.
GONE = at(3600)


def state_of(node, **kwargs):
    return st.to_state(node, **FLAGS, owner="o", now=NOW, **kwargs)


def test_the_line_shows_an_exhausted_loop_as_ready_to_merge_with_the_threads_left_open():
    node = pr_node(reviews=DIRTY3, threads=[False, False, True], contexts=GREEN)
    _, out, _ = run(["owner/app"], {"owner/app": repo(node)})

    assert "threads:2" in out
    assert "-> leave to PR Auto-Merge (review loop exhausted" in out
    assert "ready to merge" in out and "2 thread(s) left open" in out


def test_the_line_asks_for_the_head_review_below_exhaustion():
    for reviews in (DIRTY3[:2], [round_of(1), round_of(2), round_of(3, dirty=False), round_of(4)], [*DIRTY3, round_of(5, dirty=False)]):
        node = pr_node(reviews=reviews, threads=[False], contexts=GREEN)
        _, out, _ = run(["owner/app"], {"owner/app": repo(node)})

        assert "review loop exhausted" not in out
        assert "-> request Copilot" in out, reviews


def test_a_merge_of_main_is_never_a_round_in_the_status_line_either():
    merge = round_of(9, merge=True, minute=9)
    two = pr_node(reviews=[round_of(1), round_of(2), merge], contexts=GREEN)
    three = pr_node(reviews=[round_of(1), merge, round_of(2), round_of(3)], contexts=GREEN)
    state = state_of(two)
    assert [item.oid for item in state.rounds] == [f"{1:040x}", f"{2:040x}"]
    assert not state.loop_exhausted
    assert state_of(three).loop_exhausted
    assert [item.dirty for item in state_of(three).rounds] == [True, True, True]


def test_to_state_reads_the_rounds_with_their_time_and_whether_they_raised_threads():
    state = state_of(pr_node(reviews=[round_of(1), round_of(2, dirty=False), (COPILOT_LOGIN, "f" * 40, "")]))

    assert [(item.dirty, item.at) for item in state.rounds[:2]] == [(True, "2026-01-02T00:01:00Z"), (False, "2026-01-02T00:02:00Z")]
    # A review with no submission time or thread count, as older fixtures give, is a clean round with no time.
    assert (state.rounds[2].oid, state.rounds[2].dirty) == ("f" * 40, False)


def test_claudes_dirty_reviews_are_rounds_where_copilot_is_gone_or_noted_and_not_otherwise():
    claude = [round_of(n, login="github-actions", body="<!-- claude-review -->\nA finding.") for n in (1, 2, 3)]
    off_diff = round_of(4, login="github-actions", body="<!-- claude-review -->\n<!-- claude-review:off-diff -->\n**Claude Review**",
                        dirty=False)
    # Copilot may still review: Claude's reviews are no rounds.
    assert state_of(pr_node(reviews=claude)).rounds == ()
    # The ask was recorded long ago and nothing is pending: Copilot is gone, so every Claude review counts.
    gone = state_of(pr_node(reviews=claude, comments=comments_of(at(3600))))
    assert [item.dirty for item in gone.rounds] == [True, True, True] and gone.loop_exhausted
    # An off-diff finding makes a round dirty.
    assert [item.dirty for item in state_of(pr_node(reviews=[off_diff], comments=comments_of(at(3600)))).rounds] == [True]
    # A request still pending: Copilot isn't gone.
    pending = dict(pr_node(reviews=claude, comments=comments_of(at(3600))), reviewRequests=COPILOT_REQUESTED)
    assert state_of(pending).rounds == ()
    # A quota note on those commits backs them whatever the record says.
    notes = [(COPILOT_LOGIN, f"{n:040x}", "Copilot was unable to review this pull request because the quota is used up.") for n in (1, 2, 3)]
    assert state_of(pr_node(reviews=[*notes, *claude])).loop_exhausted


def test_an_exhaustion_comment_with_no_relabel_after_it_is_the_newest_word():
    node = pr_node(reviews=DIRTY3, comments=comments_of(marker_comment()))
    state = state_of(node)

    assert state.exhaustion_marker_newest
    # Nothing changes about the rounds or the merge: the loop is still exhausted.
    assert state.loop_exhausted and len(state.rounds) == 3
    assert not state_of(pr_node(reviews=DIRTY3)).exhaustion_marker_newest


def test_the_owner_re_adding_review_claude_after_the_comment_starts_a_new_loop():
    # Three dirty rounds before the label's event, and a fourth before it too: none of them counts any more.
    before = pr_node(reviews=[*DIRTY3, round_of(4, minute=30)], comments=comments_of(GONE, marker_comment()), events=[relabel()])
    state = state_of(before)
    assert not state.exhaustion_marker_newest
    assert state.rounds == () and not state.loop_exhausted
    # A round after the event is the new loop's first.
    fresh = (COPILOT_LOGIN, f"{5:040x}", "", {"at": "2026-01-02T03:00:00Z", "threads": 1, "merge": False})
    after = state_of(pr_node(reviews=[*DIRTY3, fresh], comments=comments_of(GONE, marker_comment()), events=[relabel()]))
    assert [item.oid for item in after.rounds] == [f"{5:040x}"] and not after.loop_exhausted


def test_a_label_event_before_the_exhausting_round_or_by_a_reader_is_no_restart():
    # DIRTY3's third round is at 00:02. An add before it is part of the loop; an add by a login without write access
    # (acceptance criterion 11) starts nothing.
    for events in ([relabel(at="2026-01-02T00:01:30Z")], [relabel(writer=False)], []):
        state = state_of(pr_node(reviews=DIRTY3, comments=comments_of(GONE, marker_comment()), events=events))
        assert state.exhaustion_marker_newest and state.loop_exhausted, events


def test_only_the_first_relabel_after_the_exhausting_round_restarts_the_loop_and_a_later_add_inside_the_new_loop_keeps_its_rounds():
    # PR Auto-Merge's PAT adds the label as the owner, later in the loop (before its third dirty round): that must not
    # discard the loop's rounds.
    rounds = [(COPILOT_LOGIN, f"{n:040x}", "", {"at": f"2026-01-02T03:{n:02d}:00Z", "threads": 1}) for n in (1, 2, 3)]
    node = pr_node(reviews=[*DIRTY3, *rounds], comments=comments_of(GONE, marker_comment()),
                   events=[relabel("2026-01-02T02:00:00Z"), relabel("2026-01-02T03:02:30Z")])
    state = state_of(node)

    assert len(state.rounds) == 3 and state.loop_exhausted and not state.exhaustion_marker_newest


def test_only_github_actions_comments_count_as_the_exhaustion_record():
    for login in ("stranger", "o", None):
        comment = marker_comment(login=login) if login else dict(marker_comment(), author=None)
        assert not state_of(pr_node(reviews=DIRTY3, comments=comments_of(comment))).exhaustion_marker_newest, login
    assert state_of(pr_node(reviews=DIRTY3, comments=comments_of(marker_comment(login="github-actions[bot]")))).exhaustion_marker_newest


def test_the_latest_exhaustion_comment_of_the_new_loop_is_the_newest_word():
    first = marker_comment(at="2026-01-02T01:00:00Z")
    second = marker_comment(at="2026-01-02T05:00:00Z")
    new_loop = [(COPILOT_LOGIN, f"{n:040x}", "", {"at": f"2026-01-02T03:{n:02d}:00Z", "threads": 1}) for n in (1, 2, 3)]
    node = pr_node(reviews=[*DIRTY3, *new_loop], comments=comments_of(GONE, first, second), events=[relabel("2026-01-02T02:00:00Z")])
    # The second loop was exhausted too and the second comment documents it: nobody has added the label since.
    state = state_of(node)
    assert state.exhaustion_marker_newest and state.loop_exhausted
    # A comment older than the second loop's exhausting round doesn't: that loop isn't documented yet.
    assert not state_of(pr_node(reviews=[*DIRTY3, *new_loop], comments=comments_of(GONE, first), events=[relabel("2026-01-02T02:00:00Z")])).exhaustion_marker_newest


def test_a_loop_whose_comments_or_label_events_cant_be_read_is_never_exhausted():
    for comments in (None, comments_of(at(3600) | {"body": "LGTM"}, total=150)):
        state = state_of(pr_node(reviews=DIRTY3, comments=comments))
        assert state.loop_unread and not state.loop_exhausted, comments
    # A comment is there but the label events are not: no telling where the new loop starts.
    node = pr_node(reviews=DIRTY3, comments=comments_of(marker_comment()), events=None)
    assert state_of(node).loop_unread and not state_of(node).loop_exhausted
    # The page is partial but holds the comment: read.
    found = state_of(pr_node(reviews=DIRTY3, comments=comments_of(marker_comment(), total=150)))
    assert not found.loop_unread and found.loop_exhausted
    # Fewer than three dirty rounds can't be exhausted, so unread comments say nothing.
    assert not state_of(pr_node(reviews=DIRTY3[:2], comments=None)).loop_unread


def test_an_unread_loop_is_not_shown_as_ready_to_merge():
    node = pr_node(reviews=DIRTY3, comments=None)
    _, out, _ = run(["owner/app"], {"owner/app": repo(node)})

    assert "review loop exhausted" not in out and "-> leave to PR Auto-Merge" not in out


def test_the_repo_query_reads_each_reviews_time_and_thread_count():
    reviews = st.QUERY[st.QUERY.index("reviews(last: 100)"):]
    reviews = reviews[:reviews.index("reviewThreads")]
    assert "submittedAt" in reviews and "comments { totalCount }" in reviews
    # The existing fields stay.
    assert "author { login } commit { oid parents { totalCount } } body" in st.QUERY
    # The label events are not the repo query's any more (acceptance criterion 12): a "last 30" misses the add on a PR with many.
    assert "timelineItems(" not in st.QUERY


def test_a_pr_that_could_be_exhausted_gets_the_comments_query_even_when_copilot_is_requested(monkeypatch):
    # The ask's record isn't needed (a request is pending), but the exhaustion comment and the new loop's start are.
    exhausted = dict(pr_node(number=1, reviews=DIRTY3, comments=None), reviewRequests=COPILOT_REQUESTED)
    two = dict(pr_node(number=2, reviews=DIRTY3[:2], comments=None), reviewRequests=COPILOT_REQUESTED)
    clean_last = dict(pr_node(number=3, reviews=[*DIRTY3, round_of(4, dirty=False)], comments=None), reviewRequests=COPILOT_REQUESTED)
    asked_ids = comments_graphql(monkeypatch, repo(exhausted, two, clean_last), {"PR_1": comments_of(marker_comment())})
    data = st.gh_graphql("owner", "app")
    by_number = {node["number"]: node for node in data["repository"]["pullRequests"]["nodes"]}

    assert asked_ids == ["PR_1"]
    assert by_number[1]["comments"]["totalCount"] == 1
    assert by_number[2]["comments"] is None and by_number[3]["comments"] is None


def test_a_failed_comments_query_for_a_pr_that_could_be_exhausted_makes_its_loop_unread(monkeypatch, capsys):
    node = dict(pr_node(number=1, reviews=DIRTY3, comments=None, contexts=GREEN), reviewRequests=COPILOT_REQUESTED)
    comments_graphql(monkeypatch, repo(node), {"PR_1": RuntimeError("502 Bad Gateway")})
    monkeypatch.setattr(st, "COMMENTS_FAILED", set())
    out, err = io.StringIO(), io.StringIO()

    assert st.main(["owner/app"], out=out, err=err) == 0
    assert "review loop exhausted" not in out.getvalue()
    assert "502 Bad Gateway" in capsys.readouterr().err


# ── Claude reviews only where Copilot can't; a person's threads hold; every label event is read (mpaulosky/dotfiles#378) ──

COPILOT_REQUESTED_NODE = {"nodes": [{"requestedReviewer": {"login": "Copilot"}}]}
NOTE_TEXT = "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit."


def test_a_review_claude_add_by_a_writer_after_the_exhausting_round_starts_a_new_loop_with_no_comment_acceptance_criterion_4():
    node = pr_node(reviews=[*DIRTY3, round_of(4, minute=30)], comments=comments_of(GONE), events=[relabel()])
    state = state_of(node)

    assert state.rounds == () and not state.loop_exhausted and not state.exhaustion_marker_newest and not state.loop_unread


def test_the_add_is_ignored_while_copilot_can_review_acceptance_criteria_1_and_4():
    # Never asked, or a request pending even after a long-settled record: Copilot may still review, so the label means nothing.
    never_asked = pr_node(reviews=DIRTY3, events=[relabel()])
    pending = dict(pr_node(reviews=DIRTY3, comments=comments_of(GONE), events=[relabel()]), reviewRequests=COPILOT_REQUESTED_NODE)
    just_asked = pr_node(reviews=DIRTY3, comments=comments_of(at(5)), events=[relabel()])
    for node in (never_asked, pending, just_asked):
        state = state_of(node)
        assert state.loop_exhausted and len(state.rounds) == 3, node["reviewRequests"] if "reviewRequests" in node else node["comments"]


def test_the_add_counts_when_copilots_note_is_on_the_head_acceptance_criterion_4():
    note = (COPILOT_LOGIN, HEAD, NOTE_TEXT)
    state = state_of(pr_node(reviews=[*DIRTY3, note], events=[relabel()]))

    assert state.rounds == () and not state.loop_exhausted


def test_the_add_is_ignored_when_copilot_has_really_reviewed_the_head_acceptance_criterion_1():
    # A settled ask and no pending request is also what a finished Copilot review leaves behind (#270): not "gone".
    reviewed = (COPILOT_LOGIN, HEAD, "", {"at": "2026-01-02T00:03:00Z", "threads": 1})
    state = state_of(pr_node(reviews=[round_of(1), round_of(2), round_of(3), reviewed], comments=comments_of(GONE), events=[relabel("2026-01-02T00:04:00Z")]))

    assert state.loop_exhausted


def test_a_review_claude_add_by_a_login_without_write_access_starts_no_loop_acceptance_criterion_11():
    state = state_of(pr_node(reviews=DIRTY3, comments=comments_of(GONE), events=[relabel(writer=False)]))

    assert state.loop_exhausted and not state.loop_unread


def test_a_review_claude_add_whose_permission_couldnt_be_read_leaves_the_loop_unread_acceptance_criterion_11():
    state = state_of(pr_node(reviews=DIRTY3, comments=comments_of(GONE), events=[relabel(writer=None)]))

    assert state.loop_unread and not state.loop_exhausted


def test_the_first_add_by_a_writer_counts_after_adds_by_readers_acceptance_criterion_11():
    events = [relabel("2026-01-02T01:00:00Z", writer=False), relabel("2026-01-02T01:30:00Z", writer=True), relabel("2026-01-02T02:00:00Z", writer=None)]
    state = state_of(pr_node(reviews=DIRTY3, comments=comments_of(GONE), events=events))

    assert state.rounds == () and not state.loop_unread


def test_label_events_that_were_not_read_leave_a_loop_that_could_be_exhausted_unread_acceptance_criterion_12():
    absent = pr_node(reviews=DIRTY3, comments=comments_of(GONE))
    del absent["labelEvents"]
    for node in (absent, pr_node(reviews=DIRTY3, comments=comments_of(GONE), events=None)):
        state = state_of(node)
        assert state.loop_unread and not state.loop_exhausted
    # Fewer than three dirty rounds can't be exhausted, so unread events say nothing.
    assert not state_of(pr_node(reviews=DIRTY3[:2], comments=comments_of(GONE), events=None)).loop_unread


def test_an_unread_label_events_loop_is_not_shown_as_ready_to_merge_acceptance_criterion_12():
    node = pr_node(reviews=DIRTY3, comments=comments_of(GONE), events=None, contexts=GREEN)
    _, out, _ = run(["owner/app"], {"owner/app": repo(node)})

    assert "review loop exhausted" not in out and "-> leave to PR Auto-Merge" not in out


# ── A person's open threads still hold the merge at an exhausted loop ──

def open_thread(login="copilot-pull-request-reviewer", kind="Bot", review="", **kwargs):
    return thread_node(login=login, kind=kind, review=review, resolved=False, **kwargs)


CLAUDE_THREAD = dict(login="github-actions", review="<!-- claude-review -->\n**Claude Review**")


def test_to_state_counts_the_open_threads_a_person_opened_acceptance_criterion_3():
    persons = state_of(pr_node(reviews=DIRTY3, threads=[open_thread(login="octo", kind="User")]))
    bots = state_of(pr_node(reviews=DIRTY3, threads=[open_thread(), open_thread(**CLAUDE_THREAD)]))
    both = state_of(pr_node(reviews=DIRTY3, threads=[open_thread(), open_thread(login="octo", kind="User"), open_thread(**CLAUDE_THREAD)]))

    assert (persons.open_threads, persons.open_person_threads) == (1, 1)
    assert (bots.open_threads, bots.open_person_threads) == (2, 0)
    assert (both.open_threads, both.open_person_threads) == (3, 1)


def test_a_thread_whose_author_cant_be_read_counts_as_a_persons_acceptance_criterion_3():
    unreadable = state_of(pr_node(reviews=DIRTY3, threads=[open_thread(login=None)]))
    # A thread node without its comments (the repo query reads none) has no opener either.
    uncommented = state_of(pr_node(reviews=DIRTY3, threads=[False]))

    assert unreadable.open_person_threads == 1 and uncommented.open_person_threads == 1


def test_a_resolved_thread_of_a_person_holds_nothing_acceptance_criterion_3():
    state = state_of(pr_node(reviews=DIRTY3, threads=[thread_node(login="octo", kind="User", resolved=True), open_thread()]))

    assert state.open_threads == 1 and state.open_person_threads == 0


def test_the_line_for_an_exhausted_loop_waits_on_a_persons_thread_and_hands_off_for_bot_threads_acceptance_criterion_3():
    person = pr_node(reviews=DIRTY3, threads=[open_thread(), open_thread(login="octo", kind="User")], contexts=GREEN)
    bots = pr_node(number=8, reviews=DIRTY3, threads=[open_thread(), open_thread(**CLAUDE_THREAD)], contexts=GREEN)
    _, out, _ = run(["owner/app"], {"owner/app": repo(person, bots)})
    held, handed = out.splitlines()

    assert "-> wait" in held and "person" in held and "-> leave to PR Auto-Merge" not in held
    assert "-> leave to PR Auto-Merge (review loop exhausted" in handed and "2 thread(s) left open" in handed


def test_a_pr_that_could_be_exhausted_with_open_threads_gets_the_threads_query_for_their_authors_acceptance_criterion_3(monkeypatch):
    exhausted = dict(pr_node(number=1, reviews=DIRTY3, threads=[False, True], comments=comments_of(marker_comment())), id="PR_ex")
    below = dict(pr_node(number=2, reviews=DIRTY3[:2], threads=[False], comments=None), id="PR_below")
    resolved = dict(pr_node(number=3, reviews=DIRTY3, threads=[True], comments=comments_of(marker_comment())), id="PR_resolved")
    threads_asked = []

    def graphql(query, *fields, **raw):
        if st.EVENTS_QUERY and query == st.EVENTS_QUERY:
            return {"node": {"timelineItems": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}}}
        if query == st.COMMENTS_QUERY:
            return {"node": {"comments": comments_of(marker_comment())}}
        if query == st.THREADS_QUERY:
            threads_asked.append(raw["id"])
            return {"node": {"reviewThreads": {"nodes": [open_thread(login="octo", kind="User"), thread_node(resolved=True)]}}}
        return repo(exhausted, below, resolved)
    monkeypatch.setattr(st, "graphql", graphql)
    data = st.gh_graphql("owner", "app")
    by_number = {node["number"]: node for node in data["repository"]["pullRequests"]["nodes"]}

    assert "PR_ex" in threads_asked and "PR_below" not in threads_asked
    assert st.to_state(by_number[1], **FLAGS, owner="o", now=NOW).open_person_threads == 1


def test_a_failed_threads_read_leaves_every_open_thread_a_persons_acceptance_criterion_3(monkeypatch, capsys):
    exhausted = dict(pr_node(number=1, reviews=DIRTY3, threads=[False], comments=comments_of(marker_comment())), id="PR_ex")

    def graphql(query, *fields, **raw):
        if st.EVENTS_QUERY and query == st.EVENTS_QUERY:
            return {"node": {"timelineItems": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}}}
        if query == st.COMMENTS_QUERY:
            return {"node": {"comments": comments_of(marker_comment())}}
        if query == st.THREADS_QUERY:
            raise RuntimeError("502 Bad Gateway")
        return repo(exhausted)
    monkeypatch.setattr(st, "graphql", graphql)
    monkeypatch.setattr(st, "COMMENTS_FAILED", set())
    data = st.gh_graphql("owner", "app")
    node = data["repository"]["pullRequests"]["nodes"][0]

    assert st.to_state(node, **FLAGS, owner="o", now=NOW).open_person_threads == 1
    assert "502 Bad Gateway" in capsys.readouterr().err


# ── Every review:claude label event is read, a page at a time (acceptance criteria 11 and 12) ──

def event_node(at_time, login, kind="User", label="review:claude"):
    return {"createdAt": at_time, "label": {"name": label}, "actor": None if login is None else {"login": login, "__typename": kind}}


def events_page(nodes, next_cursor=None):
    return {"node": {"timelineItems": {"pageInfo": {"hasNextPage": next_cursor is not None, "endCursor": next_cursor}, "nodes": nodes}}}


class Served:
    """GitHub as gh_graphql reads it: repo data, then per PR id the pages of its comments (newest page first), its label
    events (oldest page first) and its threads, and the collaborator permission of each login."""

    def __init__(self, repo_data, comments=None, events=None, threads=None, permissions=None):
        self.repo_data, self.comments, self.events = repo_data, comments or {}, events or {}
        self.threads, self.permissions = threads or {}, permissions or {}
        self.calls = []  # (kind, id) per query, and ("permission", login) per REST lookup
        self.reads = {}

    def graphql(self, query, *fields, **raw):
        args = "|".join([*map(str, fields), *map(str, raw.values()), *map(str, raw.keys())])
        for kind, constant, pages in (("comments", st.COMMENTS_QUERY, self.comments), ("events", st.EVENTS_QUERY, self.events)):
            if constant and query == constant:
                key = (kind, raw.get("id") or next(f.split("=", 1)[1] for f in fields if f.startswith("id=")))
                self.calls.append(key)
                index = self.reads.get(key, 0)
                self.reads[key] = index + 1
                page = pages[key[1]][index]
                if isinstance(page, Exception):
                    raise page
                if index:
                    # A later page is asked for from the cursor the page before gave.
                    previous = pages[key[1]][index - 1]
                    info = previous["node"]["timelineItems" if kind == "events" else "comments"]["pageInfo"]
                    assert str(info.get("endCursor") or info.get("startCursor")) in args, (kind, args)
                return page
        if query == st.THREADS_QUERY:
            self.calls.append(("threads", raw["id"]))
            return {"node": {"reviewThreads": {"nodes": self.threads[raw["id"]]}}}
        return self.repo_data

    def rest(self, path):
        login = path.split("/collaborators/")[1].split("/")[0]
        self.calls.append(("permission", login))
        answer = self.permissions.get(login, "none")
        if isinstance(answer, Exception):
            raise answer
        return {"permission": answer}

    def install(self, monkeypatch):
        monkeypatch.setattr(st, "graphql", self.graphql)
        monkeypatch.setattr(st, "rest", self.rest)
        monkeypatch.setattr(st, "PERMISSIONS", {}, raising=False)
        monkeypatch.setattr(st, "COMMENTS_FAILED", set())
        return self


def comments_page(nodes, total, previous=None):
    return {"node": {"comments": {"totalCount": total, "pageInfo": {"hasPreviousPage": previous is not None, "startCursor": previous},
                                  "nodes": nodes}}}


def exhausted_node(**kwargs):
    return dict(pr_node(number=1, reviews=DIRTY3, **kwargs), id="PR_1")


def test_the_events_query_pages_through_the_review_claude_events_acceptance_criterion_12():
    assert "timelineItems" in st.EVENTS_QUERY and "LABELED_EVENT" in st.EVENTS_QUERY
    for field in ("$id: ID!", "first: 100", "after:", "pageInfo", "hasNextPage", "endCursor", "createdAt", "label { name }", "actor", "login", "__typename"):
        assert field in st.EVENTS_QUERY, field


def test_the_comments_query_pages_backwards_acceptance_criterion_9():
    for field in ("comments(last: 100", "before", "pageInfo", "hasPreviousPage", "startCursor"):
        assert field in st.COMMENTS_QUERY, field


def test_more_than_30_label_events_after_the_exhausting_round_are_all_read_acceptance_criterion_12(monkeypatch):
    strangers = [event_node(f"2026-01-02T01:{minute:02d}:00Z", "stranger") for minute in range(30)]
    later = [event_node("2026-01-02T02:00:00Z", "owner"), *[event_node(f"2026-01-02T02:{minute:02d}:00Z", "stranger") for minute in range(1, 10)]]
    # The 35th event is the owner's; the repo's owner has write access without a lookup.
    pages = [events_page(strangers, "c1"), events_page(later)]
    served = Served(repo(exhausted_node(comments=None)), comments={"PR_1": [comments_page([GONE], 1)]},
                    events={"PR_1": pages}, permissions={"stranger": "read"}).install(monkeypatch)
    data = st.gh_graphql("owner", "app")
    node = data["repository"]["pullRequests"]["nodes"][0]

    assert len(node["labelEvents"]) == 40
    assert [event["writer"] for event in node["labelEvents"][:30]] == [False] * 30
    assert node["labelEvents"][30] == {"createdAt": "2026-01-02T02:00:00Z", "writer": True}
    assert served.calls.count(("events", "PR_1")) == 2
    state = st.to_state(node, **FLAGS, owner="owner", now=NOW)
    assert state.rounds == () and not state.loop_exhausted and not state.loop_unread


def test_a_page_of_label_events_that_cant_be_read_marks_the_loop_unread_acceptance_criterion_12(monkeypatch, capsys):
    pages = [events_page([event_node("2026-01-02T01:00:00Z", "stranger")], "c1"), RuntimeError("502 Bad Gateway")]
    Served(repo(exhausted_node(comments=None)), comments={"PR_1": [comments_page([GONE], 1)]}, events={"PR_1": pages},
           permissions={"stranger": "read"}).install(monkeypatch)
    data = st.gh_graphql("owner", "app")
    node = data["repository"]["pullRequests"]["nodes"][0]

    assert node["labelEvents"] is None
    assert "502 Bad Gateway" in capsys.readouterr().err
    state = st.to_state(node, **FLAGS, owner="owner", now=NOW)
    assert state.loop_unread and not state.loop_exhausted


def test_only_review_claude_events_are_kept_and_each_login_is_asked_about_once_acceptance_criterion_11(monkeypatch):
    events = [
        event_node("2026-01-02T01:00:00Z", "stranger"),
        event_node("2026-01-02T01:01:00Z", "stranger"),
        event_node("2026-01-02T01:02:00Z", "colleague"),
        event_node("2026-01-02T01:03:00Z", "enhancer", label="enhancement"),
        event_node("2026-01-02T01:04:00Z", "github-actions", kind="Bot"),
        event_node("2026-01-02T01:05:00Z", None),
        event_node("2026-01-02T01:06:00Z", "flaky"),
        event_node("2026-01-02T01:07:00Z", "owner"),
    ]
    served = Served(repo(exhausted_node(comments=None)), comments={"PR_1": [comments_page([GONE], 1)]}, events={"PR_1": [events_page(events)]},
                    permissions={"stranger": "read", "colleague": "write", "flaky": RuntimeError("502")}).install(monkeypatch)
    node = st.gh_graphql("owner", "app")["repository"]["pullRequests"]["nodes"][0]

    assert [(event["createdAt"][-9:-1], event["writer"]) for event in node["labelEvents"]] == [
        ("01:00:00", False), ("01:01:00", False), ("01:02:00", True),
        # A bot, and an actor that can't be read (a deleted account), never have write access; a failed lookup is unread.
        ("01:04:00", False), ("01:05:00", False), ("01:06:00", None), ("01:07:00", True),
    ]
    lookups = [login for kind, login in served.calls if kind == "permission"]
    assert sorted(set(lookups)) == sorted(lookups), lookups
    assert "owner" not in lookups and "github-actions" not in lookups and "enhancer" not in lookups
    assert {"stranger", "colleague", "flaky"} <= set(lookups)


def test_the_permission_of_a_login_is_asked_through_the_collaborators_permission_endpoint_acceptance_criterion_11(monkeypatch):
    paths = []
    served = Served(repo(exhausted_node(comments=None)), comments={"PR_1": [comments_page([GONE], 1)]},
                    events={"PR_1": [events_page([event_node("2026-01-02T01:00:00Z", "colleague")])]}, permissions={"colleague": "admin"})
    served.install(monkeypatch)
    monkeypatch.setattr(st, "rest", lambda path: paths.append(path) or served.rest(path))
    node = st.gh_graphql("owner", "app")["repository"]["pullRequests"]["nodes"][0]

    assert paths == ["repos/owner/app/collaborators/colleague/permission"]
    assert node["labelEvents"][0]["writer"] is True


def test_a_pr_that_cant_be_exhausted_reads_no_label_events(monkeypatch):
    served = Served(repo(dict(pr_node(number=1, reviews=DIRTY3[:2], comments=None), id="PR_1")), comments={"PR_1": [comments_page([GONE], 1)]}).install(monkeypatch)
    st.gh_graphql("owner", "app")

    assert not any(kind == "events" for kind, _ in served.calls)


def test_a_pr_with_more_than_100_comments_and_no_marker_on_the_last_page_reads_the_earlier_pages_acceptance_criterion_9(monkeypatch):
    filler = [{"author": {"login": "someone"}, "body": "Looks good.", "createdAt": "2026-01-02T05:00:00Z"}] * 100
    comments = [comments_page(filler, 150, previous="p1"), comments_page([GONE, marker_comment()], 150)]
    served = Served(repo(exhausted_node(comments=None)), comments={"PR_1": comments}, events={"PR_1": [events_page([])]}).install(monkeypatch)
    node = st.gh_graphql("owner", "app")["repository"]["pullRequests"]["nodes"][0]

    assert served.calls.count(("comments", "PR_1")) == 2
    state = st.to_state(node, **FLAGS, owner="o", now=NOW)
    assert state.exhaustion_marker_newest and state.loop_exhausted and not state.loop_unread


def test_comments_that_cant_be_paged_in_full_leave_the_loop_unread_acceptance_criterion_9(monkeypatch, capsys):
    filler = [{"author": {"login": "someone"}, "body": "Looks good.", "createdAt": "2026-01-02T05:00:00Z"}] * 100
    comments = [comments_page(filler, 150, previous="p1"), RuntimeError("502 Bad Gateway")]
    Served(repo(exhausted_node(comments=None)), comments={"PR_1": comments}, events={"PR_1": [events_page([])]}).install(monkeypatch)
    node = st.gh_graphql("owner", "app")["repository"]["pullRequests"]["nodes"][0]
    state = st.to_state(node, **FLAGS, owner="o", now=NOW)

    assert state.loop_unread and not state.loop_exhausted
    assert "502 Bad Gateway" in capsys.readouterr().err


def test_a_marker_on_the_last_page_needs_no_earlier_page_acceptance_criterion_9(monkeypatch):
    comments = [comments_page([GONE, marker_comment()], 150, previous="p1")]
    served = Served(repo(exhausted_node(comments=None)), comments={"PR_1": comments}, events={"PR_1": [events_page([])]}).install(monkeypatch)
    st.gh_graphql("owner", "app")

    assert served.calls.count(("comments", "PR_1")) == 1


def test_a_pr_that_cant_be_exhausted_reads_one_page_of_comments_acceptance_criterion_9(monkeypatch):
    filler = [{"author": {"login": "someone"}, "body": "Looks good.", "createdAt": "2026-01-02T05:00:00Z"}] * 100
    node = dict(pr_node(number=1, reviews=OLDER, comments=None), id="PR_1")
    served = Served(repo(node), comments={"PR_1": [comments_page(filler, 150, previous="p1")]}).install(monkeypatch)
    st.gh_graphql("owner", "app")

    assert served.calls.count(("comments", "PR_1")) == 1
