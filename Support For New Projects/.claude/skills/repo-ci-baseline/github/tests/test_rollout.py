"""Tests for github/rollout.py: the rollout order, and the round it drives with reapply and gh faked. No GitHub."""

import io
import sys
from pathlib import Path

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
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(ok=True, open_pr=129))
    assert step.run == ()
    assert step.held == REST
    assert step.reason == "waiting for TicketManager#129 to merge"


def test_the_rest_are_held_when_ticketmanagers_reapply_failed():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(ok=False, open_pr=None))
    assert step.run == ()
    assert step.held == REST
    assert step.reason == "reapply failed on TicketManager"


def test_a_failed_push_holds_the_rest_even_with_an_open_pr():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(ok=False, open_pr=129))
    assert step.run == ()
    assert step.reason == "reapply failed on TicketManager"


def test_the_rest_run_in_order_once_ticketmanager_has_no_open_reapply_pr():
    step = rollout.next_step(rollout.rollout_order(LISTED), rollout.Lead(ok=True, open_pr=None))
    assert step.run == REST
    assert step.held == ()


# ── The round ───────────────────────────────────────────────────────────────

class Fake:
    """reapply.sh and the open re-Apply PR lookup as the tests set them."""

    def __init__(self, open_prs=None, fail=(), opens=None):
        self.open = dict(open_prs or {})  # {repo: open re-Apply PR number}
        self.fail = set(fail)  # repos whose reapply exits 1
        self.opens = opens or {}  # {repo: PR number its reapply opens}
        self.ran = []

    def reapply(self, brings, path):
        self.ran.append((brings, path))
        repo = "mpaulosky/" + Path(path).name
        if repo in self.fail:
            return 1
        if repo in self.opens:
            self.open[repo] = self.opens[repo]
        return 0

    def open_pr(self, repo):
        return self.open.get(repo)


def run(argv, fake, exists=lambda path: True):
    out, err = io.StringIO(), io.StringIO()
    code = rollout.main(argv, listed=LISTED, reapply=fake.reapply, open_pr=fake.open_pr, exists=exists,
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
    fake = Fake(open_prs={"mpaulosky/TicketManager": 129})
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
    assert "then, if that leaves TicketManager with no open re-Apply PR (its Apply is already on main):" in out
    assert out.index("/r/TicketManager") < out.index("then, if") < out.index("/r/IssueTracker")
