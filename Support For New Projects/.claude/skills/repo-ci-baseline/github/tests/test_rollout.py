"""Tests for github/rollout.py: the rollout order, and the round it drives with reapply and gh faked. No GitHub."""

import io
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rollout  # noqa: E402

LISTED = {
    "mpaulosky/TicketManager": "full",
    "mpaulosky/IssueTracker": "full",
    "mpaulosky/atelier-store": "full",
    "mpaulosky/Blazor-Server": "full",
    "mpaulosky/IssueManager": "full",
    "mpaulosky/Articles": "full",
    "mpaulosky/dotfiles": "repo-settings-only",
}
REST = ("mpaulosky/IssueTracker", "mpaulosky/atelier-store", "mpaulosky/Blazor-Server",
        "mpaulosky/IssueManager", "mpaulosky/Articles")


# ── The order ───────────────────────────────────────────────────────────────

def test_order_is_ticketmanager_then_the_rest_in_the_skills_order_without_dotfiles():
    assert rollout.rollout_order(LISTED) == ("mpaulosky/TicketManager", *REST)


def test_order_puts_ticketmanager_first_wherever_it_is_listed():
    listed = {"mpaulosky/IssueTracker": "full", "mpaulosky/TicketManager": "full", "mpaulosky/Articles": "full"}
    assert rollout.rollout_order(listed) == ("mpaulosky/TicketManager", "mpaulosky/IssueTracker", "mpaulosky/Articles")


def test_a_round_starts_with_ticketmanager_alone():
    step = rollout.next_step(rollout.rollout_order(LISTED), None)
    assert step.run == ("mpaulosky/TicketManager",)
    assert step.held == REST


def test_the_rest_are_held_while_ticketmanagers_reapply_pr_is_open():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(True, 129, "OPEN"))
    assert step.run == ()
    assert step.held == REST
    assert step.reason == "waiting for TicketManager#129 to merge"


def test_the_rest_are_held_when_ticketmanagers_reapply_failed():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(False, 128, "MERGED"))
    assert step.run == ()
    assert step.held == REST
    assert step.reason == "reapply failed on TicketManager"


def test_the_rest_are_held_when_ticketmanagers_reapply_pr_was_closed_unmerged():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(True, 129, "CLOSED"))
    assert step.run == ()
    assert step.held == REST
    assert step.reason == "TicketManager#129 was closed without merging"


def test_the_rest_are_held_when_no_reapply_pr_of_ticketmanagers_is_found():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(True, None, None))
    assert step.run == ()
    assert step.reason == "no re-Apply PR of TicketManager's found to have merged"


def test_the_rest_run_in_order_once_ticketmanagers_reapply_pr_has_merged():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(True, 129, "MERGED"))
    assert step.run == REST
    assert step.held == ()


def test_an_order_without_ticketmanager_is_refused():
    with pytest.raises(ValueError, match="TicketManager"):
        rollout.rollout_order({"mpaulosky/IssueTracker": "full"})


# ── The round ───────────────────────────────────────────────────────────────

class Fake:
    """reapply.sh and the newest re-Apply PR lookup as the tests set them."""

    def __init__(self, latest=None, fail=(), opens=None, unreadable=()):
        # {repo: (number, state)}; every repo's last round merged unless set
        self.latest = {repo: (100, "MERGED") for repo in LISTED} | dict(latest or {})
        self.fail = set(fail)  # repos whose reapply exits 1
        self.opens = opens or {}  # {repo: PR number its reapply opens}
        self.unreadable = set(unreadable)  # repos whose lookup fails
        self.ran = []

    def reapply(self, brings, path):
        self.ran.append((brings, path))
        repo = "mpaulosky/" + Path(path).name
        if repo in self.fail:
            return 1
        if repo in self.opens:
            self.latest[repo] = (self.opens[repo], "OPEN")
        return 0

    def latest_pr(self, repo):
        if repo in self.unreadable:
            raise RuntimeError("HTTP 502")
        return self.latest.get(repo)


def run(argv, fake, exists=lambda path: True):
    out, err = io.StringIO(), io.StringIO()
    code = rollout.main(argv, listed=LISTED, reapply=fake.reapply, latest_pr=fake.latest_pr, exists=exists,
                        out=out, err=err)
    return code, out.getvalue(), err.getvalue()


def ran_repos(fake):
    return [Path(path).name for _, path in fake.ran]


def test_first_run_applies_ticketmanager_only_and_holds_the_rest():
    fake = Fake(opens={"mpaulosky/TicketManager": 130})
    code, out, _ = run(["--brings", "#82", "--root", "/r"], fake)
    assert code == 0
    assert fake.ran == [("#82", "/r/TicketManager")]
    assert "waiting for TicketManager#130 to merge" in out
    assert "held: IssueTracker, atelier-store, Blazor-Server, IssueManager, Articles" in out
    assert "land.sh mpaulosky/TicketManager#130" in out


def test_once_ticketmanager_merged_the_rest_follow_one_at_a_time_in_order():
    fake = Fake(opens={repo: n for n, repo in enumerate(REST, start=200)})
    code, out, _ = run(["--brings", "#82", "--root", "/r"], fake)
    assert code == 0
    assert ran_repos(fake) == ["TicketManager", "IssueTracker", "atelier-store", "Blazor-Server", "IssueManager",
                               "Articles"]
    assert ("land.sh mpaulosky/IssueTracker#200 mpaulosky/atelier-store#201 mpaulosky/Blazor-Server#202 "
            "mpaulosky/IssueManager#203 mpaulosky/Articles#204") in out


def test_a_failed_repo_is_reported_and_the_rest_still_run():
    fake = Fake(fail={"mpaulosky/atelier-store"})
    code, out, err = run(["--brings", "#82", "--root", "/r"], fake)
    assert code == 1
    assert ran_repos(fake)[-3:] == ["Blazor-Server", "IssueManager", "Articles"]
    assert "failed: atelier-store" in out
    assert "atelier-store" in err


def test_a_failed_ticketmanager_holds_the_round_and_exits_1():
    fake = Fake(fail={"mpaulosky/TicketManager"})
    code, out, _ = run(["--brings", "#82", "--root", "/r"], fake)
    assert code == 1
    assert ran_repos(fake) == ["TicketManager"]
    assert "reapply failed on TicketManager" in out


def test_a_missing_checkout_fails_that_repo_only():
    fake = Fake()
    code, out, err = run(["--brings", "#82", "--root", "/r"], fake, exists=lambda path: path != "/r/IssueManager")
    assert code == 1
    assert "IssueManager" not in ran_repos(fake)
    assert ran_repos(fake)[-1] == "Articles"
    assert "failed: IssueManager" in out
    assert "no checkout at /r/IssueManager" in err


def test_dry_run_runs_nothing_and_shows_the_plan_from_the_open_pr():
    fake = Fake(latest={"mpaulosky/TicketManager": (129, "OPEN")})
    code, out, _ = run(["--brings", "#82", "--root", "/r", "--dry-run"], fake)
    assert code == 0
    assert fake.ran == []
    assert "would run: reapply.sh --brings '#82' /r/TicketManager" in out
    assert "waiting for TicketManager#129 to merge" in out


def test_dry_run_with_ticketmanager_landed_shows_every_repo():
    fake = Fake()
    code, out, _ = run(["--brings", "#82", "--root", "/r", "--dry-run"], fake)
    assert code == 0
    assert fake.ran == []
    assert out.count("would run: reapply.sh") == 6
    assert "then, if that leaves TicketManager with no new re-Apply PR (its Apply is already on main):" in out
    assert out.index("/r/TicketManager") < out.index("then, if") < out.index("/r/IssueTracker")


def test_a_failed_lookup_on_ticketmanager_is_reported_as_one_and_holds_the_round():
    fake = Fake(unreadable={"mpaulosky/TicketManager"})
    code, out, err = run(["--brings", "#82", "--root", "/r"], fake)
    assert code == 1
    assert ran_repos(fake) == ["TicketManager"]
    assert "can't read mpaulosky/TicketManager's re-Apply PR: HTTP 502" in err
    assert "reapply failed" not in out + err


def test_a_closed_unmerged_reapply_pr_holds_the_round_on_rerun():
    fake = Fake(latest={"mpaulosky/TicketManager": (129, "CLOSED")})
    code, out, _ = run(["--brings", "#82", "--root", "/r"], fake)
    assert code == 1
    assert ran_repos(fake) == ["TicketManager"]
    assert "TicketManager#129 was closed without merging" in out


def test_a_merged_reapply_pr_on_the_rest_is_not_offered_to_land():
    fake = Fake(opens={"mpaulosky/Articles": 300})
    code, out, _ = run(["--brings", "#82", "--root", "/r"], fake)
    assert code == 0
    assert "land them with: land.sh mpaulosky/Articles#300\n" in out
