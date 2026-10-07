"""Tests for github/landing.py: fixture PR states in, one action out. No GitHub."""

import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import landing as ld  # noqa: E402

HEAD = "a" * 40
OLD = "b" * 40


def passed(name, started="2026-10-07T10:00:00Z"):
    return ld.Check(name, "COMPLETED", "SUCCESS", started)


def running(name, started="2026-10-07T10:05:00Z"):
    return ld.Check(name, "IN_PROGRESS", None, started)


# A PR ready to arm: Copilot reviewed the head, no open thread, checks green.
READY = ld.PrState(head=HEAD, copilot_reviewed=frozenset({OLD, HEAD}), merge_state="CLEAN",
                   checks=(passed("Build Solution"), passed("Test Suite")))


def test_a_reviewed_green_pr_is_armed():
    assert ld.decide(READY).action == ld.ARM_AUTO_MERGE


def test_a_draft_waits_unless_the_caller_wants_it_ready():
    draft = replace(READY, draft=True)
    assert ld.decide(draft) == ld.Decision(ld.WAIT, "draft")
    assert ld.decide(replace(draft, want_ready=True)).action == ld.MARK_READY


def test_a_head_copilot_has_not_reviewed_waits():
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset({OLD})))
    assert decision.action == ld.WAIT
    assert "no Copilot review of aaaaaaa" in decision.reason


def test_an_open_thread_waits():
    decision = ld.decide(replace(READY, open_threads=2))
    assert decision == ld.Decision(ld.WAIT, "2 open thread(s)")


def test_a_behind_branch_is_updated_and_copilot_asked_again():
    assert ld.decide(replace(READY, merge_state="BEHIND")).action == ld.UPDATE_BRANCH
    # Behind wins over a missing review: the update makes a new head to review anyway.
    behind_unreviewed = replace(READY, merge_state="BEHIND", copilot_reviewed=frozenset())
    assert ld.decide(behind_unreviewed).action == ld.UPDATE_BRANCH


def test_a_cancelled_check_beside_a_newer_pass_is_not_a_failure():
    checks = (ld.Check("Test Suite", "COMPLETED", "CANCELLED", "2026-10-07T10:00:00Z"),
              passed("Test Suite", "2026-10-07T10:03:00Z"), passed("Build Solution"))
    summary = ld.summarize_checks(checks)
    assert summary.failed == () and summary.cancelled == ()
    assert summary.superseded == ("Test Suite",)
    assert summary.green
    assert ld.decide(replace(READY, checks=checks)).action == ld.ARM_AUTO_MERGE


def test_a_cancelled_check_with_nothing_newer_is_a_blocker_told_apart_from_failed():
    checks = (passed("Test Suite", "2026-10-07T10:00:00Z"),
              ld.Check("Test Suite", "COMPLETED", "CANCELLED", "2026-10-07T10:03:00Z"))
    summary = ld.summarize_checks(checks)
    assert summary.cancelled == ("Test Suite",) and summary.failed == ()
    decision = ld.decide(replace(READY, checks=checks))
    assert decision.action == ld.BLOCKER and decision.reason.startswith("cancelled")


def test_a_failed_check_is_a_blocker_not_armed():
    checks = (passed("Build Solution"), ld.Check("Test Suite", "COMPLETED", "FAILURE", "2026-10-07T10:00:00Z"))
    decision = ld.decide(replace(READY, checks=checks))
    assert decision == ld.Decision(ld.BLOCKER, "failed: Test Suite")
    # A newer failure replaces an older pass of the same check.
    newer_failure = (passed("Test Suite", "2026-10-07T09:00:00Z"),
                     ld.Check("Test Suite", "COMPLETED", "TIMED_OUT", "2026-10-07T10:00:00Z"))
    assert ld.decide(replace(READY, checks=newer_failure)).action == ld.BLOCKER


def test_a_merge_conflict_is_a_blocker():
    assert ld.decide(replace(READY, merge_state="DIRTY")).action == ld.BLOCKER


def test_running_required_checks_still_arm():
    pr = replace(READY, checks=(passed("Build Solution"), running("Test Suite")))
    assert ld.decide(pr).action == ld.ARM_AUTO_MERGE


def test_a_repo_with_no_required_checks_waits_for_green_before_arming():
    pr = replace(READY, checks_required=False, checks=(running("Template tests"),))
    decision = ld.decide(pr)
    assert decision.action == ld.WAIT and "Template tests" in decision.reason
    green = replace(pr, checks=(passed("Template tests"),))
    assert ld.decide(green).action == ld.ARM_AUTO_MERGE


def test_an_already_armed_pr_needs_nothing():
    armed = replace(READY, auto_merge_armed=True, copilot_reviewed=frozenset())
    assert ld.decide(armed) == ld.Decision(ld.NOTHING, "auto-merge armed")


def test_a_merged_or_closed_pr_needs_nothing():
    assert ld.decide(replace(READY, state="MERGED")) == ld.Decision(ld.NOTHING, "merged")
    assert ld.decide(replace(READY, state="CLOSED", draft=True)).action == ld.NOTHING


def test_copilot_reviews_match_any_copilot_login():
    reviews = [("copilot-pull-request-reviewer", HEAD), ("Copilot", OLD), ("mpaulosky", "c" * 40), (None, "d" * 40)]
    assert ld.copilot_reviews(reviews) == frozenset({HEAD, OLD})


def test_a_run_not_yet_started_counts_as_newest():
    checks = (ld.Check("Test Suite", "COMPLETED", "CANCELLED", "2026-10-07T10:00:00Z"),
              ld.Check("Test Suite", "QUEUED", None, ""))
    summary = ld.summarize_checks(checks)
    assert summary.running == ("Test Suite",) and summary.cancelled == ()
