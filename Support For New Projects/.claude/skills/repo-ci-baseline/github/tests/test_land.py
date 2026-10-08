"""Tests for github/land.py: fixture polls in, gh calls and printed changes out. No GitHub."""

import io
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import land  # noqa: E402

HEAD = "1234567" + "0" * 33
NEW = "abcdef0" + "0" * 33
COPILOT = [("copilot-pull-request-reviewer", HEAD)]
CLAUDE = [("github-actions", HEAD, "<!-- claude-review -->\n**Claude Review**")]
GREEN = [{"__typename": "CheckRun", "name": "Template tests", "status": "COMPLETED", "conclusion": "SUCCESS",
          "startedAt": "2026-10-07T10:00:00Z"}]
RUNNING = [{"__typename": "CheckRun", "name": "Template tests", "status": "IN_PROGRESS", "conclusion": None,
            "startedAt": "2026-10-07T10:00:00Z"}]
SCOPES = {"o/app": "full", "o/dots": "repo-settings-only"}


def node(number=7, title="feat: Something", branch="feat/x", head=HEAD, draft=False, merge_state="CLEAN",
         reviews=(), threads=(), contexts=(), armed=False):
    return {
        "number": number, "title": title, "state": "OPEN", "isDraft": draft, "headRefName": branch,
        "headRefOid": head, "mergeStateStatus": merge_state,
        "autoMergeRequest": {"enabledAt": "2026-10-07T10:00:00Z"} if armed else None,
        "reviews": {"nodes": [{"author": {"login": review[0]}, "commit": {"oid": review[1]},
                               "body": review[2] if len(review) > 2 else ""} for review in reviews]},
        "reviewThreads": {"nodes": [{"isResolved": resolved} for resolved in threads]},
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": list(contexts)}}
                                          if contexts else None}}]},
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


def test_dotfiles_is_armed_only_once_reviewed_threadless_and_green():
    fake = Fake({"o/dots": [node(contexts=RUNNING)]})
    lander, out, _ = start(fake, {"o/dots": None})
    lander.poll()
    assert "-> wait (no Copilot or Claude review" in printed(out) and fake.calls == []

    fake.open["o/dots"] = [node(reviews=COPILOT, threads=[False], contexts=RUNNING)]
    lander.poll()
    assert "-> wait (1 open thread(s))" in printed(out) and fake.calls == []

    fake.open["o/dots"] = [node(reviews=COPILOT, threads=[True], contexts=RUNNING)]
    lander.poll()
    assert "waiting for: Template tests" in printed(out) and fake.calls == []

    fake.open["o/dots"] = [node(reviews=COPILOT, threads=[True], contexts=GREEN)]
    lander.poll()
    assert "-> arm auto-merge" in printed(out)
    assert fake.calls == [f"gh pr merge 7 -R o/dots --auto --squash --match-head-commit {HEAD}"]


def test_a_behind_branch_is_updated_and_copilot_asked_again_once_per_head():
    fake = Fake({"o/app": [node(merge_state="BEHIND")]})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == ["gh pr update-branch 7 -R o/app", "gh pr edit 7 -R o/app --add-reviewer @copilot"]
    assert fake.read_back == [("o/app", 7)]
    text = printed(out)
    assert "  ran: gh pr update-branch 7 -R o/app" in text and "  failed:" not in text
    # Still BEHIND on the same head (the API lags) with a new thread: printed, not redone.
    fake.open["o/app"] = [node(merge_state="BEHIND", threads=[False])]
    lander.poll()
    assert "-> update branch" in printed(out) and len(fake.calls) == 2


def test_a_copilot_request_github_dropped_calls_in_claude():
    fake = Fake({"o/app": [node(merge_state="BEHIND")]}, dropped={("o/app", 7)})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert fake.calls == ["gh pr update-branch 7 -R o/app", "gh pr edit 7 -R o/app --add-reviewer @copilot",
                          "gh pr edit 7 -R o/app --add-label review:claude"]
    text = printed(out)
    assert ("  warning: Copilot's review request didn't register on #7 (GitHub drops it once the Copilot code review "
            "budget is used up); added review:claude, so Claude Review reviews it instead" in text)
    assert "  ran: gh pr edit 7 -R o/app --add-label review:claude" in text
    assert "  failed:" not in text


def test_a_failed_review_claude_label_is_reported_as_failed():
    fake = Fake({"o/app": [node(merge_state="BEHIND")]}, dropped={("o/app", 7)},
                fail_calls={"gh pr edit 7 -R o/app --add-label review:claude"})
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    text = printed(out)
    assert "  failed: gh pr edit 7 -R o/app --add-label review:claude (boom)" in text
    assert "request it at https://github.com/o/app/pull/7" in text


def test_a_copilot_request_that_cant_be_read_back_is_reported_as_failed():
    fake = Fake({"o/app": [node(merge_state="BEHIND")]})
    fake.copilot_requested = lambda repo, number: (_ for _ in ()).throw(RuntimeError("HTTP 502"))
    lander, out, _ = start(fake, {"o/app": None})
    lander.poll()
    assert len(fake.calls) == 2
    assert ("  failed: Copilot's review request couldn't be read back on #7 (HTTP 502); request it at "
            "https://github.com/o/app/pull/7" in printed(out))


def test_dotfiles_is_armed_on_a_claude_review_of_the_head():
    fake = Fake({"o/dots": [node(reviews=CLAUDE, contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/dots": None})
    lander.poll()
    text = printed(out)
    assert "review:claude" in text and "-> arm auto-merge (Claude reviewed the head" in text
    assert fake.calls == [f"gh pr merge 7 -R o/dots --auto --squash --match-head-commit {HEAD}"]


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
    fake = Fake({"o/app": [node(merge_state="BEHIND")], "o/dots": [node(reviews=COPILOT, contexts=GREEN)]})
    lander, out, _ = start(fake, {"o/app": None, "o/dots": None})
    lander.dry_run = True
    lander.poll()
    text = printed(out)
    assert "  would run: gh pr update-branch 7 -R o/app" in text
    assert "  would run: gh pr edit 7 -R o/app --add-reviewer @copilot" in text
    assert f"  would run: gh pr merge 7 -R o/dots --auto --squash --match-head-commit {HEAD}" in text
    assert fake.calls == [] and fake.read_back == []
    lander.poll()
    assert printed(out) == ""


# ── Change-only output ──────────────────────────────────────────────────────

def test_nothing_is_printed_when_nothing_changed():
    fake = Fake({"o/app": [node(contexts=RUNNING)]})
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
    fake = Fake({"o/app": [node()]})
    code, out = run_main(fake, ["o/app", "--timeout", "3", "--interval", "60"], [], monkeypatch)
    assert code == 1 and out.splitlines()[-1] == "Time limit reached; still open: app#7"
    assert out.count("-> wait") == 1


def test_once_is_a_single_pass(monkeypatch):
    fake = Fake({"o/app": [node()]})
    code, out = run_main(fake, ["--once", "o/app"], [lambda: pytest.fail("slept")], monkeypatch)
    assert code == 0 and out.count("\n") == 1


def test_targets_parse_prs_urls_and_repos():
    assert land.parse_targets(["o/app#7", "https://github.com/o/app/pull/8", "o/dots"]) == \
        {"o/app": {7, 8}, "o/dots": None}
    with pytest.raises(ValueError):
        land.parse_targets(["app"])
