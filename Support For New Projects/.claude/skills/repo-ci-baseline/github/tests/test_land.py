"""Tests for github/land.py: fixture polls in, gh calls and printed changes out. No GitHub."""

import io
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import land  # noqa: E402
import landing  # noqa: E402

HEAD = "1234567" + "0" * 33
NEW = "abcdef0" + "0" * 33
COPILOT = [("copilot-pull-request-reviewer", HEAD)]
NOTE = ("copilot-pull-request-reviewer", HEAD, "Copilot was unable to review this pull request because the user who "
        "requested the review has reached their quota limit.")
# Claude backs Copilot up on a head Copilot answered with its quota note, or whose request GitHub dropped.
CLAUDE = [NOTE, ("github-actions", HEAD, "<!-- claude-review -->\n**Claude Review**")]
GREEN = [{"__typename": "CheckRun", "name": "Template tests", "status": "COMPLETED", "conclusion": "SUCCESS",
          "startedAt": "2026-10-07T10:00:00Z"}]
RUNNING = [{"__typename": "CheckRun", "name": "Template tests", "status": "IN_PROGRESS", "conclusion": None,
            "startedAt": "2026-10-07T10:00:00Z"}]
SCOPES = {"o/app": "full", "o/dots": "repo-settings-only"}
# Copilot reviewed an older commit only: the head has no review, no note and (unless a test says) no request.
OLDER = [("copilot-pull-request-reviewer", NEW)]
# The two calls that ask Copilot once (mpaulosky/dotfiles#360): the record comment, then the request.
RECORD_CALL = "gh pr comment 7 -R o/app --body " + landing.COPILOT_ASKED_COMMENT
REQUEST_CALL = "gh pr edit 7 -R o/app --add-reviewer @copilot"
LABEL_CALL = "gh pr edit 7 -R o/app --add-label review:claude"


def ago(seconds):
    """An ISO-8601 time `seconds` ago, as GraphQL reports createdAt."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds))


def record(age=3600, login="github-actions"):
    """The comment that records Copilot was asked, posted `age` seconds ago: (login, body, createdAt)."""
    return (login, landing.COPILOT_ASKED_COMMENT, ago(age))


def node(number=7, title="feat: Something", branch="feat/x", head=HEAD, draft=False, merge_state="CLEAN",
         reviews=(), threads=(), contexts=(), armed=False, labels=(), requested=(), comments=(), events=()):
    return {
        "number": number, "title": title, "state": "OPEN", "isDraft": draft, "headRefName": branch,
        "headRefOid": head, "mergeStateStatus": merge_state,
        "autoMergeRequest": {"enabledAt": "2026-10-07T10:00:00Z"} if armed else None,
        "labels": {"nodes": [{"name": label} for label in labels]},
        "reviewRequests": {"nodes": [{"requestedReviewer": {"login": login}} for login in requested]},
        # A review is (login, oid[, body[, flags...]]); the flag "merge" makes its commit a merge commit and "dirty" gives the
        # review an inline thread. Each is submitted a minute after the one before it.
        "reviews": {"nodes": [{"author": {"login": review[0]},
                               "commit": {"oid": review[1], "parents": {"totalCount": 2 if "merge" in review[3:] else 1}},
                               "submittedAt": f"2026-01-02T00:{index:02d}:00Z",
                               "comments": {"totalCount": 1 if "dirty" in review[3:] else 0},
                               "body": review[2] if len(review) > 2 else ""} for index, review in enumerate(reviews)]},
        # The PR's review:claude label events as (createdAt, whether the login that added it has write access); None is a read
        # that failed (mpaulosky/dotfiles#378).
        "labelEvents": None if events is None else [{"createdAt": created, "writer": writer} for created, writer in events],
        # A thread is True/False (resolved or not) or a full reviewThreads node.
        "reviewThreads": {"nodes": [{"isResolved": thread} if isinstance(thread, bool) else thread for thread in threads]},
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": list(contexts)}}
                                          if contexts else None}}]},
        # The PR's comments as (login, body, createdAt); None is a read that failed.
        "comments": None if comments is None else {
            "totalCount": len(comments),
            "nodes": [{"author": {"login": login}, "body": body, "createdAt": created} for login, body, created in comments]},
    }


class Fake:
    """GitHub as the tests set it: open PRs per repo, final states, and a log of gh calls."""

    def __init__(self, open_prs, final=None, fail=(), dropped=(), fail_calls=()):
        self.open = open_prs  # {repo: [node, ...]}
        self.final = final or {}  # {(repo, number): "MERGED" | "CLOSED"}
        self.fail = set(fail)  # gh subcommands that fail
        self.fail_calls = set(fail_calls)  # whole gh calls that fail
        self.dropped = set(dropped)  # {(repo, number)} whose Copilot request GitHub drops
        self.calls = []
        self.read_back = []
        self.now = 0.0

    def fetch(self, owner, name):
        repo = f"{owner}/{name}"
        if isinstance(self.open[repo], Exception):
            raise self.open[repo]
        return {"repository": {"pullRequests": {"nodes": self.open[repo]}}}

    def pr_state(self, repo, number):
        return self.final.get((repo, number), "OPEN")

    def run(self, argv):
        call = " ".join(argv)
        self.calls.append(call)
        failed = argv[2] in self.fail or call in self.fail_calls
        return not failed, ("boom" if failed else "")

    def copilot_requested(self, repo, number):
        self.read_back.append((repo, number))
        return (repo, number) not in self.dropped

    def lander(self, targets, out, err):
        return land.Lander(targets, SCOPES, fetch=self.fetch, pr_state=self.pr_state, run=self.run,
                           copilot_requested=self.copilot_requested,
                           clock=lambda: self.now, out=out, err=err)


def start(fake, targets):
    out, err = io.StringIO(), io.StringIO()
    return fake.lander(targets, out, err), out, err


def printed(out):
    text = out.getvalue()
    out.seek(0)
    out.truncate()
    return text


# ── The action dispatch ─────────────────────────────────────────────────────

def test_a_baseline_repos_reviewed_pr_is_left_to_its_pr_auto_merge():
    fake = Fake({"o/app": [node(reviews=COPILOT)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "-> leave to PR Auto-Merge" in printed(out)
    assert fake.calls == []


def test_dotfiles_leaves_a_reviewed_pr_to_its_pr_auto_merge():
    fake = Fake({"o/dots": [node(reviews=COPILOT, contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/dots": None})
    lander.poll()
    assert "-> leave to PR Auto-Merge" in printed(out)
    assert fake.calls == []


def test_a_behind_branch_is_updated_once_per_head_and_copilot_isnt_asked():
    fake = Fake({"o/app": [node(merge_state="BEHIND", reviews=COPILOT)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == ["gh pr update-branch 7 -R o/app"]
    assert fake.read_back == []
    text = printed(out)
    assert "  ran: gh pr update-branch 7 -R o/app" in text and "  failed:" not in text
    # Still BEHIND on the same head (the API lags) with a new thread: printed, not redone.
    fake.open["o/app"] = [node(merge_state="BEHIND", reviews=COPILOT, threads=[False])]
    lander.poll()
    assert "-> update branch" in printed(out) and len(fake.calls) == 1


def test_update_branch_is_just_update_branch_now_that_it_asks_nobody():
    assert landing.UPDATE_BRANCH == "update branch"
    assert landing.UPDATE_BRANCH in landing.ACTIONS
    assert land.commands(landing.UPDATE_BRANCH, "o/app", 7, HEAD) == [["gh", "pr", "update-branch", "7", "-R", "o/app"]]


def test_requesting_copilot_records_the_ask_in_a_comment_first_and_then_requests_the_review():
    assert land.commands(landing.REQUEST_COPILOT, "o/app", 7, HEAD) == [
        ["gh", "pr", "comment", "7", "-R", "o/app", "--body", landing.COPILOT_ASKED_COMMENT],
        ["gh", "pr", "edit", "7", "-R", "o/app", "--add-reviewer", "@copilot"]]
    assert landing.COPILOT_ASKED_MARKER in landing.COPILOT_ASKED_COMMENT


def test_a_copilot_request_github_dropped_is_warned_about_and_backed_up_by_claude():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN)]}, dropped={("o/app", 7)})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == [RECORD_CALL, REQUEST_CALL]
    assert fake.read_back == [("o/app", 7)]
    text = printed(out)
    assert "-> request Copilot" in text
    assert "  warning: Copilot's review request didn't register on #7 (GitHub drops it once the Copilot code review budget " \
           "is used up); review:claude backs Copilot up for this PR" in text
    assert "  failed:" not in text
    # The same run polls again: the record is on the PR now, 2 s old, and the drop it read back is remembered for this
    # head, so review:claude is added as soon as the checks are green, without waiting out the 30 seconds.
    fake.open["o/app"] = [node(reviews=OLDER, contexts=GREEN, comments=[record(2)])]
    lander.poll()
    assert "-> add review:claude" in printed(out) and fake.calls[2:] == [LABEL_CALL]
    # A later head: the record is old, so Copilot is not asked again and Claude is called in.
    fake.open["o/app"] = [node(head=NEW, reviews=OLDER[:0], contexts=GREEN, comments=[record(3600)])]
    lander.poll()
    assert "-> add review:claude" in printed(out) and fake.calls[3:] == [LABEL_CALL]


def test_claude_is_called_in_once_copilot_posted_its_quota_note_and_checks_are_green():
    note = [("copilot-pull-request-reviewer", HEAD, NOTE[2])]
    fake = Fake({"o/app": [node(reviews=note, contexts=RUNNING)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "waiting for checks before calling in Claude: Template tests" in printed(out) and fake.calls == []
    fake.open["o/app"] = [node(reviews=note, contexts=GREEN)]
    lander.poll()
    assert fake.calls == ["gh pr edit 7 -R o/app --add-label review:claude"]
    assert "-> add review:claude" in printed(out)
    lander.poll()
    assert len(fake.calls) == 1


def test_copilot_is_asked_first_for_a_head_copilot_reviewed_before_and_only_once():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == [RECORD_CALL, REQUEST_CALL]
    assert "-> request Copilot" in printed(out)
    # It registered: Copilot is requested, so nothing more, and never Claude.
    fake.open["o/app"] = [node(reviews=OLDER, contexts=GREEN, requested=["Copilot"], comments=[record(5)])]
    lander.poll()
    assert "Copilot is requested" in printed(out) and len(fake.calls) == 2
    # Long after, with the request gone (answered by nothing): no second ask, Claude is called in.
    fake.open["o/app"] = [node(reviews=OLDER, contexts=GREEN, comments=[record(3600)])]
    lander.poll()
    assert fake.calls[2:] == [LABEL_CALL]


def test_a_copilot_request_github_refused_outright_is_warned_about():
    # TicketManager#141: "Could not add requested reviewers". No request is
    # left to read back, so it's handled like a dropped one.
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN)]}, dropped={("o/app", 7)}, fail_calls={REQUEST_CALL})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == [RECORD_CALL, REQUEST_CALL]
    assert fake.read_back == [("o/app", 7)]
    text = printed(out)
    assert f"  warning: {REQUEST_CALL} failed (boom)" in text
    assert "review:claude backs Copilot up for this PR" in text


def test_no_request_is_made_when_the_record_comment_fails():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN)]}, fail={"comment"})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert len(fake.calls) == 1 and fake.calls[0].startswith("gh pr comment 7 -R o/app --body ")
    assert fake.read_back == []
    assert "  failed: gh pr comment 7 -R o/app" in printed(out)


def test_claude_isnt_called_in_while_copilot_is_requested_or_the_label_is_on():
    fake = Fake({"o/app": [node(contexts=GREEN, requested=["copilot-pull-request-reviewer"])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "Copilot is requested" in printed(out) and fake.calls == []
    # Copilot asked long ago and nothing pending: it can't review, so the label stands and Claude is waited for.
    fake.open["o/app"] = [node(contexts=GREEN, labels=["review:claude"], comments=[record(3600)])]
    lander.poll()
    assert "review:claude is on" in printed(out) and fake.calls == []


def test_claude_is_called_in_for_a_third_round_to_review_a_fix():
    # Two rounds aren't MAX_CLAUDE_ROUNDS (3): a fix for the second's findings is reviewed too (#193).
    rounds = [("github-actions", sha, "<!-- claude-review -->\n**Claude Review**") for sha in ("1" * 40, "2" * 40)]
    fake = Fake({"o/app": [node(reviews=[NOTE, *rounds], contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    lander.poll()
    assert fake.calls == ["gh pr edit 7 -R o/app --add-label review:claude"]


def test_claudes_reviews_of_two_commits_and_a_merge_from_main_are_no_reason_to_stop_calling_it_in():
    # Claude reviewed two commits and a merge from main: the merge is no round, and clean rounds never end the loop,
    # so the head gets the label (mpaulosky/dotfiles#375, which replaces #193's "the owner decides").
    body = "<!-- claude-review -->\n**Claude Review**"
    rounds = [("github-actions", "1" * 40, body), ("github-actions", "2" * 40, body, "merge"), ("github-actions", "3" * 40, body)]
    fake = Fake({"o/app": [node(reviews=[NOTE, *rounds], contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    text = printed(out)  # printed() empties the buffer, so read it once
    assert "the owner decides" not in text
    assert fake.calls == [LABEL_CALL]


def test_a_loop_of_three_dirty_rounds_is_left_to_pr_auto_merge_with_the_threads_left_open():
    body = "<!-- claude-review -->\n**Claude Review**"
    reviews = [NOTE, *[("github-actions", sha * 40, body, "dirty") for sha in "123"]]
    # Copilot's threads: a person's would hold the merge (mpaulosky/dotfiles#378).
    threads = [thread_by("copilot-pull-request-reviewer", "Bot")] * 2
    fake = Fake({"o/app": [node(reviews=reviews, contexts=GREEN, threads=threads)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    text = printed(out)
    assert "-> leave to PR Auto-Merge (review loop exhausted" in text and "2 thread(s) left open" in text
    assert fake.calls == []


def test_a_dirty_round_after_a_clean_one_doesnt_exhaust_the_loop_and_gets_the_label():
    body = "<!-- claude-review -->\n**Claude Review**"
    reviews = [NOTE, ("github-actions", "1" * 40, body, "dirty"), ("github-actions", "2" * 40, body, "dirty"),
               ("github-actions", "3" * 40, body), ("github-actions", "4" * 40, body, "dirty")]
    fake = Fake({"o/app": [node(reviews=reviews, contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "review loop exhausted" not in printed(out)
    assert fake.calls == [LABEL_CALL]


def test_claude_isnt_called_in_while_the_exhaustion_comment_is_the_newest_word_but_is_once_the_owner_re_adds_the_label():
    marker = ("github-actions", "Review loop exhausted.\n\n" + landing.EXHAUSTED_MARKER + " " + HEAD + " -->", ago(3600))
    # Copilot's quota note is on the head and the checks are green, but the label is the owner's to add after the comment.
    body = "<!-- claude-review -->\n**Claude Review**"
    dirty3 = [("github-actions", sha * 40, body, "dirty") for sha in "123"]
    clean_after = [NOTE, *dirty3, ("github-actions", "9" * 40, "<!-- claude-review -->\nNo findings.")]
    fake = Fake({"o/app": [node(reviews=clean_after, contexts=GREEN, comments=[marker])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    text = printed(out)
    assert "-> wait" in text and "review:claude" in text
    assert fake.calls == []
    # The owner adds review:claude after the exhausting round (and the loop's rounds start over).
    fake.open["o/app"] = [node(reviews=clean_after, contexts=GREEN, comments=[marker], events=[(ago(1800), True)])]
    lander.poll()
    assert fake.calls == [LABEL_CALL]


def test_a_failed_review_claude_label_is_reported_as_failed():
    fake = Fake({"o/app": [node(reviews=[NOTE], contexts=GREEN)]},
                fail_calls={"gh pr edit 7 -R o/app --add-label review:claude"})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    lander.poll()
    assert "  failed: gh pr edit 7 -R o/app --add-label review:claude (boom)" in printed(out)


def test_a_copilot_request_whose_read_back_fails_is_not_asked_again_next_poll():
    # Copilot is asked once per PR (mpaulosky/dotfiles#360): the record now on the PR, not a retry here, decides what's next.
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN)]})
    fake.copilot_requested = lambda repo, number: (_ for _ in ()).throw(RuntimeError("HTTP 502"))
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "couldn't be read back on #7 (HTTP 502)" in printed(out)
    lander.poll()
    lander.poll()
    assert fake.calls == [RECORD_CALL, REQUEST_CALL]


def test_a_copilot_request_that_cant_be_read_back_is_reported_as_failed():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN)]})
    fake.copilot_requested = lambda repo, number: (_ for _ in ()).throw(RuntimeError("HTTP 502"))
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert len(fake.calls) == 2
    assert ("  failed: Copilot's review request couldn't be read back on #7 (HTTP 502); request it at "
            "https://github.com/o/app/pull/7" in printed(out))


# ── --once asks once and falls back without remembering anything between runs (mpaulosky/dotfiles#360) ──

def once(fake, text="o/app#7"):
    lander, out, err = start(fake, {"o/app": {7}})
    code = land.main(["--once", text], lander=lander, out=out, err=err)
    return code, printed(out)


def test_once_adds_review_claude_after_a_dropped_request_with_nothing_remembered_from_the_run_that_asked():
    # Run 1 asks: the record comment, then the request, read back as dropped.
    first = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN)]}, dropped={("o/app", 7)})
    assert once(first)[0] == 0
    assert first.calls == [RECORD_CALL, REQUEST_CALL]
    # Run 2 is a new process: all it has is the PR, which now carries the record (31 s old) and no request.
    second = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, comments=[record(31)])]})
    code, text = once(second)
    assert code == 0
    assert second.calls == [LABEL_CALL]
    assert "-> add review:claude" in text
    assert second.read_back == []


def test_once_waits_while_the_record_is_under_30_seconds_old_and_asks_nothing():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, comments=[record(10)])]})
    code, text = once(fake)
    assert code == 0 and fake.calls == []
    assert "-> wait" in text and "Copilot was asked" in text


def test_once_never_asks_a_second_time_whoever_ran_before():
    for age in (5, 31, 3600):
        fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, comments=[record(age)])]})
        once(fake)
        assert RECORD_CALL not in fake.calls and REQUEST_CALL not in fake.calls, age


def test_once_waits_while_copilots_request_is_pending_whatever_the_age_of_the_record():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, requested=["Copilot"], comments=[record(3600)])]})
    code, text = once(fake)
    assert fake.calls == [] and "Copilot is requested" in text


def test_once_does_not_ask_or_add_the_label_when_the_comments_could_not_be_read():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, comments=None)]})
    once(fake)
    assert fake.calls == []


def test_once_ignores_a_record_from_a_stranger_and_asks():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, comments=[record(3600, login="stranger")])]})
    once(fake)
    assert fake.calls == [RECORD_CALL, REQUEST_CALL]


def test_once_trusts_a_record_from_the_repo_owner():
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, comments=[record(3600, login="o")])]})
    once(fake)
    assert fake.calls == [LABEL_CALL]


def test_a_new_head_after_an_update_isnt_asked_for_either():
    # Behind main with a record on the PR: the update makes a new head; Copilot is not asked about it.
    fake = Fake({"o/app": [node(merge_state="BEHIND", reviews=OLDER, comments=[record(3600)])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == ["gh pr update-branch 7 -R o/app"]
    fake.open["o/app"] = [node(head=NEW, reviews=[], contexts=GREEN, comments=[record(3600)])]
    lander.poll()
    assert fake.calls[1:] == [LABEL_CALL]


def test_dotfiles_leaves_a_claude_reviewed_pr_to_its_pr_auto_merge():
    fake = Fake({"o/dots": [node(reviews=CLAUDE, contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/dots": None})
    lander.poll()
    assert "-> leave to PR Auto-Merge" in printed(out)
    assert fake.calls == []


def test_a_draft_is_marked_ready_only_when_asked():
    fake = Fake({"o/app": [node(draft=True)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "-> wait (draft)" in printed(out) and fake.calls == []

    fake = Fake({"o/app": [node(draft=True)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.want_ready = True
    lander.poll()
    assert fake.calls == ["gh pr ready 7 -R o/app"]


def test_a_release_blog_pr_that_opens_is_watched_and_armed_unless_its_workflow_armed_it():
    fake = Fake({"o/app": [node(reviews=COPILOT)]})
    lander, out, _ = start(fake, {"o/app": {7}})
    lander.poll()
    printed(out)

    blog = node(number=8, title="docs: Add release blog for PR #7 [skip-release]", branch="docs/release-notes",
                head=NEW, contexts=RUNNING)
    fake.open["o/app"] = [blog]
    fake.final[("o/app", 7)] = "MERGED"
    lander.poll()
    text = printed(out)
    assert "app#7 merged" in text and "app#8 docs: Add release blog" in text and "-> arm auto-merge" in text
    assert fake.calls == [f"gh pr merge 8 -R o/app --auto --squash --match-head-commit {NEW}"]

    armed = node(number=9, title="docs: Backfill blog posts [skip-release]", branch="docs/backfill-blog-posts",
                 armed=True)
    fake.open["o/app"] = [armed]
    fake.final[("o/app", 8)] = "MERGED"
    lander.poll()
    assert "-> nothing (auto-merge armed)" in printed(out) and len(fake.calls) == 1


def test_a_failed_call_is_reported_and_stops_the_rest_of_that_action():
    fake = Fake({"o/app": [node(merge_state="BEHIND")]}, fail={"update-branch"})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "  failed: gh pr update-branch 7 -R o/app (boom)" in printed(out)
    assert fake.calls == ["gh pr update-branch 7 -R o/app"]


def test_dry_run_prints_the_calls_and_makes_none():
    blog = node(number=8, title="docs: Release notes [skip-release]", branch="docs/release-notes", contexts=GREEN)
    fake = Fake({"o/app": [node(merge_state="BEHIND"), blog]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.dry_run = True
    lander.poll()
    text = printed(out)
    assert "  would run: gh pr update-branch 7 -R o/app" in text
    assert "--add-reviewer" not in text
    assert f"  would run: gh pr merge 8 -R o/app --auto --squash --match-head-commit {HEAD}" in text
    assert fake.calls == [] and fake.read_back == []
    lander.poll()
    assert printed(out) == ""


# ── Resolved bot threads nobody replied to ──────────────────────────────────

def bot_thread(replies=()):
    """A resolved Copilot thread at src/a.py:12, then one reply per login."""
    comments = [{"url": "u1", "author": {"login": "copilot-pull-request-reviewer", "__typename": "Bot"},
                 "pullRequestReview": {"body": ""}}]
    comments += [{"url": "u2", "author": {"login": login, "__typename": "User"}, "pullRequestReview": None}
                 for login in replies]
    return {"isResolved": True, "path": "src/a.py", "line": 12, "originalLine": 12,
            "comments": {"totalCount": len(comments), "nodes": comments}}


def test_the_line_lists_a_resolved_bot_thread_with_no_reply():
    fake = Fake({"o/app": [node(reviews=COPILOT, threads=[bot_thread()])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    text = printed(out)
    assert text.count("\n") == 1 and text.rstrip("\n").endswith("notice: resolved without a reply: src/a.py:12")
    assert "-> leave to PR Auto-Merge" in text


def test_a_poll_reprints_the_line_when_only_the_unreplied_threads_change_and_makes_no_call():
    fake = Fake({"o/app": [node(reviews=COPILOT, threads=[bot_thread()])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    printed(out)
    lander.poll()
    assert printed(out) == ""
    # Someone replies: the notice goes, and that is a change worth a line.
    fake.open["o/app"] = [node(reviews=COPILOT, threads=[bot_thread(replies=["octo"])])]
    lander.poll()
    text = printed(out)
    assert text.count("\n") == 1 and "notice" not in text and "-> leave to PR Auto-Merge" in text
    # A thread resolved without a reply appears: another line, with the same action and no gh call.
    fake.open["o/app"] = [node(reviews=COPILOT, threads=[bot_thread(replies=["octo"]), bot_thread()])]
    lander.poll()
    text = printed(out)
    assert text.count("\n") == 1 and "notice: resolved without a reply: src/a.py:12" in text
    assert fake.calls == []


# ── Change-only output ──────────────────────────────────────────────────────

def test_nothing_is_printed_when_nothing_changed():
    fake = Fake({"o/app": [node(contexts=RUNNING, requested=["Copilot"])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert printed(out).count("\n") == 1
    for _ in range(3):
        lander.poll()
        assert printed(out) == ""


def test_only_the_pr_that_changed_is_printed():
    fake = Fake({"o/app": [node(number=7), node(number=8)]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    printed(out)
    fake.open["o/app"] = [node(number=7), node(number=8, reviews=COPILOT)]
    lander.poll()
    text = printed(out)
    assert text.count("\n") == 1 and text.startswith("app#8")


def test_no_open_pr_is_one_line_and_exits_instead_of_repeating(monkeypatch):
    monkeypatch.setattr(land, "read_repo_list", lambda: SCOPES)
    fake = Fake({"o/app": [], "o/dots": []})
    out, err = io.StringIO(), io.StringIO()
    sleeps = []
    code = land.main([], lander=fake.lander(dict.fromkeys(SCOPES), out, err), sleep=sleeps.append)
    assert code == 0 and out.getvalue() == "No open PRs to land in 2 repo(s).\n" and sleeps == []


def test_an_unreadable_repo_is_reported_once_until_it_changes():
    fake = Fake({"o/app": RuntimeError("Could not resolve to a Repository")})
    lander, out, err = start(fake, {"o/app": None})
    assert lander.poll() == (False, True)
    lander.poll()
    assert err.getvalue() == "o/app: Could not resolve to a Repository\n" and printed(out) == ""
    # A repo never read doesn't count as done, so the watch goes on.
    fake.open["o/app"] = [node()]
    assert lander.poll() == (False, False)


# ── The loop ────────────────────────────────────────────────────────────────

def run_main(fake, argv, polls, monkeypatch):
    """main() with each sleep advancing the clock and applying the next change to fake."""
    monkeypatch.setattr(land, "read_repo_list", lambda: SCOPES)
    out, err = io.StringIO(), io.StringIO()
    changes = iter(polls)

    def sleep(seconds):
        fake.now += seconds
        next(changes, lambda: None)()

    targets = land.parse_targets([a for a in argv if not a.startswith("--") and not a[0].isdigit()]) \
        or dict.fromkeys(SCOPES)
    code = land.main(argv, lander=fake.lander(targets, out, err), sleep=sleep)
    return code, out.getvalue()


def test_it_exits_once_every_watched_pr_and_its_release_blog_pr_has_landed(monkeypatch):
    fake = Fake({"o/app": [node(reviews=COPILOT)]})
    blog = node(number=8, title="docs: Add release blog for PR #7 [skip-release]", branch="docs/release-notes",
                armed=True)

    def merge_seven():
        fake.open["o/app"] = []
        fake.final[("o/app", 7)] = "MERGED"

    def blog_opens():
        fake.open["o/app"] = [blog]

    def blog_merges():
        fake.open["o/app"] = []
        fake.final[("o/app", 8)] = "MERGED"

    code, out = run_main(fake, ["o/app#7", "--interval", "60"], [merge_seven, blog_opens, blog_merges],
                         monkeypatch)
    assert code == 0
    assert out.splitlines()[-1] == "All 2 watched PR(s) merged or closed."
    assert "app#7 merged" in out and "app#8 merged" in out


def test_a_release_blog_pr_seen_with_the_merge_and_landed_before_the_next_poll_ends_the_wait(monkeypatch):
    # TicketManager#131/#132: the blog PR shows up in the same poll as the merge, then lands within 86 s.
    fake = Fake({"o/app": [node(reviews=COPILOT)]})
    blog = node(number=8, title="docs: Add release blog for PR #7 [skip-release]", branch="docs/release-notes",
                armed=True)

    def merge_seven_and_blog_opens():
        fake.open["o/app"] = [blog]
        fake.final[("o/app", 7)] = "MERGED"

    def blog_merges():
        fake.open["o/app"] = []
        fake.final[("o/app", 8)] = "MERGED"

    code, out = run_main(fake, ["o/app#7", "--interval", "60"], [merge_seven_and_blog_opens, blog_merges],
                         monkeypatch)
    assert code == 0
    assert "no release-blog PR" not in out
    assert out.splitlines()[-1] == "All 2 watched PR(s) merged or closed."
    assert fake.now == 120  # the poll after the blog PR merged, not --blog-wait later


def test_without_a_release_blog_pr_it_gives_up_waiting_after_blog_wait(monkeypatch):
    fake = Fake({"o/app": [node(reviews=COPILOT)]})

    def merge_seven():
        fake.open["o/app"] = []
        fake.final[("o/app", 7)] = "MERGED"

    code, out = run_main(fake, ["o/app#7", "--blog-wait", "2"], [merge_seven], monkeypatch)
    assert code == 0 and "o/app: no release-blog PR within 2 min" in out


def test_dotfiles_merging_expects_no_release_blog_pr(monkeypatch):
    fake = Fake({"o/dots": [node(contexts=RUNNING)]})

    def merge_seven():
        fake.open["o/dots"] = []
        fake.final[("o/dots", 7)] = "MERGED"

    code, out = run_main(fake, ["o/dots#7"], [merge_seven], monkeypatch)
    assert code == 0 and "release-blog" not in out and out.splitlines()[-1].startswith("All 1")


def test_it_stops_at_the_time_limit(monkeypatch):
    fake = Fake({"o/app": [node(contexts=RUNNING, requested=["Copilot"])]})
    code, out = run_main(fake, ["o/app", "--timeout", "3", "--interval", "60"], [], monkeypatch)
    assert code == 1 and out.splitlines()[-1] == "Time limit reached; still open: app#7"
    assert out.count("-> wait") == 1


def test_once_is_a_single_pass(monkeypatch):
    fake = Fake({"o/app": [node(contexts=RUNNING, requested=["Copilot"])]})
    code, out = run_main(fake, ["--once", "o/app"], [lambda: pytest.fail("slept")], monkeypatch)
    assert code == 0 and out.count("\n") == 1


def test_targets_parse_prs_urls_and_repos():
    assert land.parse_targets(["o/app#7", "https://github.com/o/app/pull/8", "o/dots"]) == \
        {"o/app": {7, 8}, "o/dots": None}
    with pytest.raises(ValueError):
        land.parse_targets(["app"])


# ── Claude reviews only where Copilot can't; a person's threads hold (mpaulosky/dotfiles#378) ──

def thread_by(login, kind="User", review=None):
    """An unresolved reviewThreads node opened by login."""
    return {"isResolved": False, "path": "src/a.py", "line": 3, "originalLine": 3,
            "comments": {"totalCount": 1, "nodes": [{"url": "https://github.com/o/app/pull/7#discussion_r1",
                                                     "author": {"login": login, "__typename": kind},
                                                     "pullRequestReview": {"body": review or ""}}]}}


EXHAUSTED_REVIEWS = [("copilot-pull-request-reviewer", sha * 40, "", "dirty") for sha in "123"]


def test_review_claude_is_ignored_while_copilot_can_review_it_acceptance_criterion_2():
    # Never asked: Copilot is asked, the label notwithstanding.
    fake = Fake({"o/app": [node(reviews=OLDER, contexts=GREEN, labels=["review:claude"])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == [RECORD_CALL, REQUEST_CALL]
    assert "review:claude is on" not in printed(out)
    # Asked and a request pending: Copilot is waited for, not Claude.
    fake.open["o/app"] = [node(reviews=OLDER, contexts=GREEN, labels=["review:claude"], requested=["Copilot"], comments=[record(3600)])]
    lander.poll()
    assert "Copilot is requested" in printed(out) and len(fake.calls) == 2


def test_an_exhausted_loop_waits_for_a_thread_opened_by_a_person_but_not_for_bots_acceptance_criterion_3():
    person = Fake({"o/app": [node(reviews=EXHAUSTED_REVIEWS, contexts=GREEN, threads=[thread_by("octo")])]})
    lander, out, _ = start(person, {"o/app": None})
    lander.poll()
    held = printed(out)
    assert "-> wait" in held and "person" in held and "leave to PR Auto-Merge" not in held

    bots = Fake({"o/app": [node(reviews=EXHAUSTED_REVIEWS, contexts=GREEN,
                                threads=[thread_by("copilot-pull-request-reviewer", "Bot"),
                                         thread_by("github-actions", "Bot", "<!-- claude-review -->\n**Claude Review**")])]})
    lander, out, _ = start(bots, {"o/app": None})
    lander.poll()
    assert "-> leave to PR Auto-Merge (review loop exhausted" in printed(out)

    both = Fake({"o/app": [node(reviews=EXHAUSTED_REVIEWS, contexts=GREEN,
                                threads=[thread_by("copilot-pull-request-reviewer", "Bot"), thread_by("octo")])]})
    lander, out, _ = start(both, {"o/app": None})
    lander.poll()
    assert "-> wait" in printed(out)


def test_a_thread_whose_author_cant_be_read_holds_an_exhausted_loop_acceptance_criterion_3():
    unreadable = thread_by("x")
    unreadable["comments"]["nodes"][0]["author"] = None
    fake = Fake({"o/app": [node(reviews=EXHAUSTED_REVIEWS, contexts=GREEN, threads=[unreadable])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "-> wait" in printed(out)


def test_a_label_event_whose_permission_couldnt_be_read_leaves_land_waiting_acceptance_criterion_11():
    # Copilot answered the head with its note, so an add could count; its permission is unreadable, so the loop is unread.
    reviews = [NOTE, *[("github-actions", sha * 40, "<!-- claude-review -->\n**Claude Review**", "dirty") for sha in "123"]]
    fake = Fake({"o/app": [node(reviews=reviews, contexts=GREEN, events=[(ago(1800), None)])]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert "leave to PR Auto-Merge" not in printed(out) and "review loop exhausted" not in printed(out)
    assert fake.calls == []
