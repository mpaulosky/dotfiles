"""Tests for github/landing.py: fixture PR states in, one action out. No GitHub."""

import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import landing as ld  # noqa: E402

HEAD = "a" * 40
OLD = "b" * 40


def passed(name, started="2026-10-07T10:00:00Z"):
    return ld.Check(name, "COMPLETED", "SUCCESS", started)


def running(name, started="2026-10-07T10:05:00Z"):
    return ld.Check(name, "IN_PROGRESS", None, started)


def failed(name, started="2026-10-07T10:00:00Z"):
    return ld.Check(name, "COMPLETED", "FAILURE", started)


def cancelled(name, started="2026-10-07T10:00:00Z"):
    return ld.Check(name, "COMPLETED", "CANCELLED", started)


# A PR ready to arm: Copilot reviewed the head, no open thread, checks green.
READY = ld.PrState(head=HEAD, copilot_reviewed=frozenset({OLD, HEAD}), merge_state="CLEAN",
                   checks=(passed("Build Solution"), passed("Test Suite")))


def test_a_reviewed_green_pr_is_armed():
    assert ld.decide(READY).action == ld.ARM_AUTO_MERGE


def test_a_draft_waits_unless_the_caller_wants_it_ready():
    draft = replace(READY, draft=True)
    assert ld.decide(draft) == ld.Decision(ld.WAIT, "draft")
    assert ld.decide(replace(draft, want_ready=True)).action == ld.MARK_READY


def test_a_head_copilot_has_not_reviewed_waits_while_copilot_is_requested():
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset({OLD}), copilot_requested=True))
    assert decision.action == ld.WAIT
    assert "no Copilot or Claude review of aaaaaaa" in decision.reason and "Copilot is requested" in decision.reason


def test_an_unreviewed_head_waits_while_review_claude_is_on():
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset({OLD}), claude_requested=True))
    assert decision == ld.Decision(ld.WAIT, "no Copilot or Claude review of aaaaaaa yet; review:claude is on")


def test_copilot_is_asked_first_for_a_head_copilot_reviewed_before():
    # Copilot reviewed an older head and nothing is requested now.
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset({OLD})))
    assert decision.action == ld.REQUEST_COPILOT
    assert decision.reason.endswith("Copilot not requested")


def test_claude_is_called_in_once_copilots_request_for_the_head_dropped_and_checks_are_green():
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_dropped=True)
    assert ld.decide(dropped).action == ld.REQUEST_CLAUDE
    waiting = ld.decide(replace(dropped, checks=(passed("Build Solution"), running("Test Suite"))))
    assert waiting.action == ld.WAIT
    assert waiting.reason.endswith("waiting for checks before calling in Claude: Test Suite")
    # A failed check is a blocker: no Claude review of a head that fails CI.
    assert ld.decide(replace(dropped, checks=(failed("Test Suite"),))).action == ld.BLOCKER


def test_a_registered_copilot_request_waits_even_after_an_earlier_drop():
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset({OLD}), copilot_requested=True, copilot_dropped=True))
    assert decision.action == ld.WAIT and decision.reason.endswith("Copilot is requested")


def test_no_checks_is_not_green_even_where_checks_arent_required():
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_dropped=True, checks=(), checks_required=False)
    assert ld.decide(dropped).action == ld.WAIT


def test_past_pr_auto_merges_review_cap_neither_reviewer_is_asked_for():
    capped = replace(READY, merged_by_workflow=True, copilot_reviewed=frozenset({OLD, "c" * 40}),
                     claude_reviewed=frozenset({"d" * 40}))
    decision = ld.decide(capped)
    assert decision == ld.Decision(ld.HAND_OFF, "review cap (3) reached, no open threads")
    # Past the cap the workflow still holds on threads and checks, and so does this.
    assert ld.decide(replace(capped, open_threads=1)).action == ld.WAIT
    assert ld.decide(replace(capped, checks=(failed("Test Suite"),))).action == ld.BLOCKER
    # A commit both reviewed counts once: two distinct commits aren't the cap.
    assert ld.decide(replace(capped, claude_reviewed=frozenset({OLD}))).action == ld.REQUEST_COPILOT
    # A repo whose workflow doesn't merge has no cap; a re-Apply PR has one (#174).
    assert ld.decide(replace(capped, merged_by_workflow=False)).action == ld.REQUEST_COPILOT
    assert ld.REVIEW_CAP == 3


def test_review_cap_matches_pr_auto_merges():
    workflow = (Path(__file__).resolve().parents[2] / "template" / "owned" / ".github" / "workflows" / "pr-automerge.yml")
    text = workflow.read_text(encoding="utf-8")
    assert f"const COPILOT_REVIEW_CAP = {ld.REVIEW_CAP};" in text


def test_no_checks_at_all_is_not_green():
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_dropped=True, checks=())
    decision = ld.decide(dropped)
    assert decision.action == ld.WAIT and decision.reason.endswith("no checks on the head yet, so Claude waits for CI")
    # Claude Review's own checks alone aren't CI either.
    assert ld.decide(replace(dropped, checks=(passed("Check for a merge from main"),))).action == ld.WAIT


@pytest.mark.parametrize("check", [
    ld.Check("Test Suite", "QUEUED"), ld.Check("Test Suite", "WAITING"), ld.Check("Test Suite", "PENDING"),
    ld.Check("Test Suite", "REQUESTED"),
])
def test_a_queued_pending_or_waiting_check_counts_as_running(check):
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_dropped=True,
                      checks=(passed("Build Solution"), check))
    decision = ld.decide(dropped)
    assert decision.action == ld.WAIT and decision.reason.endswith("calling in Claude: Test Suite")


def test_claude_review_checks_dont_hold_calling_it_in():
    # Its run cancelled when the label came off early, or skipped without the label.
    unreviewed = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_dropped=True,
                         checks=(passed("Build Solution"), cancelled("Check for a merge from main"),
                                 cancelled("Review with Claude"), cancelled("Post Claude's review")))
    assert ld.decide(unreviewed).action == ld.REQUEST_CLAUDE
    assert ld.decide(replace(unreviewed, checks=(passed("Build Solution"), running("Review with Claude")))).action \
        == ld.REQUEST_CLAUDE
    # Any other cancelled check still needs a rerun.
    assert ld.decide(replace(unreviewed, checks=(cancelled("Build Solution"),))).action == ld.BLOCKER


def test_claude_is_never_called_in_for_a_third_round():
    two = replace(READY, copilot_reviewed=frozenset(), claude_reviewed=frozenset({OLD, "c" * 40}), copilot_dropped=True)
    decision = ld.decide(two)
    assert decision.action == ld.WAIT
    assert decision.reason.endswith("Claude's 2 review rounds are used, the owner decides")
    assert ld.decide(replace(two, claude_reviewed=frozenset({OLD}))).action == ld.REQUEST_CLAUDE


def test_a_claude_review_of_the_head_counts_as_reviewed():
    claude = replace(READY, copilot_reviewed=frozenset(), claude_reviewed=frozenset({HEAD}))
    assert claude.head_reviewer == "claude" and claude.reviewer_on_head
    decision = ld.decide(claude)
    assert decision.action == ld.ARM_AUTO_MERGE
    assert decision.reason.startswith("Claude reviewed the head")
    assert ld.decide(replace(claude, merged_by_workflow=True)).action == ld.HAND_OFF


def test_a_claude_review_of_an_older_head_doesnt_cover_the_head():
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset(), claude_reviewed=frozenset({OLD}),
                                 copilot_requested=True))
    assert decision.action == ld.WAIT
    assert "no Copilot or Claude review of aaaaaaa" in decision.reason


def test_copilot_is_named_when_both_reviewed_the_head():
    both = replace(READY, claude_reviewed=frozenset({HEAD}))
    assert both.head_reviewer == "copilot"
    assert ld.decide(both).reason.startswith("Copilot reviewed the head")
    assert replace(READY, copilot_reviewed=frozenset()).head_reviewer == ""


def test_an_open_thread_waits():
    decision = ld.decide(replace(READY, open_threads=2))
    assert decision == ld.Decision(ld.WAIT, "2 open thread(s)")


def test_there_is_no_review_cap_so_an_open_thread_waits_after_any_number_of_rounds():
    # Past PR Auto-Merge's cap open threads still hold the merge, so the
    # landing decision never arms past a thread either.
    rounds = replace(READY, copilot_reviewed=frozenset({"c" * 40, "d" * 40, OLD, HEAD}), open_threads=1)
    assert ld.decide(rounds) == ld.Decision(ld.WAIT, "1 open thread(s)")


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


def test_claude_reviews_are_marked_github_actions_reviews():
    marker = ld.CLAUDE_MARKER + "\n**Claude Review**"
    reviews = [("github-actions", HEAD, marker), ("github-actions[bot]", OLD, marker),
               ("github-actions", "c" * 40, "Some other workflow's review."), ("mpaulosky", "d" * 40, marker),
               ("github-actions", "e" * 40, None), (None, "f" * 40, marker), ("github-actions", None, marker)]
    assert ld.claude_reviews(reviews) == frozenset({HEAD, OLD})


def test_a_run_not_yet_started_counts_as_newest():
    checks = (ld.Check("Test Suite", "COMPLETED", "CANCELLED", "2026-10-07T10:00:00Z"),
              ld.Check("Test Suite", "QUEUED", None, ""))
    summary = ld.summarize_checks(checks)
    assert summary.running == ("Test Suite",) and summary.cancelled == ()


def test_a_baseline_repo_leaves_a_reviewed_pr_to_its_pr_auto_merge():
    baseline = replace(READY, merged_by_workflow=True)
    assert ld.decide(baseline).action == ld.HAND_OFF
    # Its gates still come first: nothing is handed off before Copilot reviewed the head.
    assert ld.decide(replace(baseline, copilot_reviewed=frozenset({OLD}), copilot_requested=True)).action == ld.WAIT
    assert ld.decide(replace(baseline, open_threads=1)).action == ld.WAIT
    assert ld.decide(replace(baseline, merge_state="BEHIND")).action == ld.UPDATE_BRANCH


def test_a_release_blog_pr_is_armed_without_copilot_unless_blocked_or_armed():
    blog = replace(READY, release_blog=True, merged_by_workflow=True, copilot_reviewed=frozenset(),
                   checks=(running("Lint Markdown"),))
    assert ld.decide(blog).action == ld.ARM_AUTO_MERGE
    assert ld.decide(replace(blog, auto_merge_armed=True)) == ld.Decision(ld.NOTHING, "auto-merge armed")
    failing = replace(blog, checks=(ld.Check("Lint Markdown", "COMPLETED", "FAILURE", "2026-10-07T10:00:00Z"),))
    assert ld.decide(failing).action == ld.BLOCKER
    assert ld.decide(replace(blog, merge_state="DIRTY")).action == ld.BLOCKER


def test_a_claude_review_of_the_head_with_findings_outside_the_diff_waits():
    blocked = replace(READY, claude_reviewed=frozenset({HEAD}), claude_off_diff=frozenset({HEAD}))
    decision = ld.decide(blocked)
    assert decision == ld.Decision(ld.WAIT, "Claude's review of aaaaaaa has findings outside the diff")
    assert ld.decide(replace(blocked, claude_off_diff=frozenset({OLD}))).action == ld.ARM_AUTO_MERGE


def test_off_diff_findings_are_judged_by_the_latest_claude_review_of_each_commit():
    clean = ld.CLAUDE_MARKER + "\n**Claude Review**"
    off = ld.CLAUDE_MARKER + "\n" + ld.OFF_DIFF_MARKER + "\n**Claude Review**"
    reviews = [("github-actions", HEAD, clean), ("github-actions", HEAD, off),
               ("github-actions", OLD, off), ("github-actions", OLD, clean),
               ("github-actions", "c" * 40, "Not Claude's.\n" + ld.OFF_DIFF_MARKER),
               ("copilot-pull-request-reviewer", "d" * 40, off)]
    assert ld.claude_off_diff(reviews) == frozenset({HEAD})


def test_a_run_cancelled_before_it_started_is_superseded_by_a_later_run():
    # No started_at, so only the creation order (rank) says the green run is newer.
    checks = (ld.Check("Test Suite", "COMPLETED", "CANCELLED", "", rank=1),
              ld.Check("Test Suite", "COMPLETED", "SUCCESS", "2026-10-07T10:00:00Z", rank=2))
    summary = ld.summarize_checks(checks)
    assert summary.passed == ("Test Suite",) and summary.cancelled == ()


def test_a_queued_rerun_outranks_an_older_green_run():
    checks = (ld.Check("Test Suite", "COMPLETED", "SUCCESS", "2026-10-07T10:00:00Z", rank=1),
              ld.Check("Test Suite", "QUEUED", None, "", rank=2))
    assert ld.summarize_checks(checks).running == ("Test Suite",)
