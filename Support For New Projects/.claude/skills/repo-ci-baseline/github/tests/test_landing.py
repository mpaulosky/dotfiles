"""Tests for github/landing.py: fixture PR states in, one action out. No GitHub."""

import re
import sys
from dataclasses import replace
from datetime import datetime, timezone
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


def test_a_claude_review_without_a_quota_note_doesnt_keep_the_label_waiting():
    # Claude reviewed the head but Copilot posted no note: that covers nothing and no more is coming (#270).
    labelled = replace(READY, copilot_reviewed=frozenset({OLD}), claude_requested=True,
                       claude_reviewed=frozenset({HEAD}))
    assert ld.decide(labelled).action == ld.REQUEST_COPILOT
    # Unless the request was dropped (#318): then Copilot can't review this head, so Claude's review counts.
    assert ld.decide(replace(labelled, copilot_dropped=True)).action == ld.ARM_AUTO_MERGE


def test_copilot_is_asked_first_for_a_head_copilot_reviewed_before():
    # Copilot reviewed an older head and nothing is requested now.
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset({OLD})))
    assert decision.action == ld.REQUEST_COPILOT
    assert decision.reason.endswith("Copilot not asked yet")


def test_claude_is_called_in_once_copilot_answered_the_head_with_its_quota_note_and_checks_are_green():
    declined = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_declined=frozenset({HEAD}))
    assert ld.decide(declined).action == ld.REQUEST_CLAUDE
    waiting = ld.decide(replace(declined, checks=(passed("Build Solution"), running("Test Suite"))))
    assert waiting.action == ld.WAIT
    assert waiting.reason.endswith("waiting for checks before calling in Claude: Test Suite")
    # A failed check is a blocker: no Claude review of a head that fails CI.
    assert ld.decide(replace(declined, checks=(failed("Test Suite"),))).action == ld.BLOCKER


def test_a_dropped_request_calls_in_claude_like_a_quota_note_does():
    # Copilot can't review a head whose request GitHub dropped, so Claude backs it up (#318).
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_dropped=True)
    decision = ld.decide(dropped)
    assert decision.action == ld.REQUEST_CLAUDE
    assert decision.reason.endswith("Copilot couldn't review (its request was dropped or its quota is used up), checks green")
    waiting = ld.decide(replace(dropped, checks=(passed("Build Solution"), running("Test Suite"))))
    assert waiting.action == ld.WAIT and waiting.reason.endswith("waiting for checks before calling in Claude: Test Suite")
    assert ld.decide(replace(dropped, checks=(failed("Test Suite"),))).action == ld.BLOCKER
    # Without a drop remembered for this head, Claude's review of it covers nothing: Copilot is asked again.
    assert ld.decide(replace(READY, copilot_reviewed=frozenset({OLD}), claude_reviewed=frozenset({HEAD}))).action == ld.REQUEST_COPILOT
    # Claude's earlier reviews stall nothing: the loop's end is dirty rounds in a row, not a count of reviewed commits (#375).
    used = replace(dropped, claude_reviewed=frozenset({"c" * 40, "d" * 40, "e" * 40, OLD}))
    assert ld.decide(used).action == ld.REQUEST_CLAUDE


def test_a_registered_copilot_request_waits_even_after_an_earlier_drop():
    decision = ld.decide(replace(READY, copilot_reviewed=frozenset({OLD}), copilot_requested=True, copilot_dropped=True))
    assert decision.action == ld.WAIT and decision.reason.endswith("Copilot is requested")


def test_no_checks_is_not_green_even_where_checks_arent_required():
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_declined=frozenset({HEAD}), checks=(), checks_required=False)
    assert ld.decide(dropped).action == ld.WAIT


def rounds(pattern):
    """Rounds, oldest first, one per token of the pattern: "d" a dirty round, "c" a clean one."""
    return tuple(ld.Round(f"{index + 1:040x}", token == "d", f"2026-01-02T00:{index:02d}:00Z")
                 for index, token in enumerate(pattern.split()))


# A repo whose workflow merges, the head unreviewed, three dirty rounds behind it: the loop is exhausted (mpaulosky/dotfiles#375).
EXHAUSTED = replace(READY, merged_by_workflow=True, copilot_reviewed=frozenset({OLD}), rounds=rounds("d d d"))


def test_an_exhausted_loop_is_left_to_pr_auto_merge_ready_to_merge_with_the_threads_left_open():
    decision = ld.decide(EXHAUSTED)
    assert decision.action == ld.HAND_OFF
    assert decision.reason.startswith("review loop exhausted")
    assert "ready to merge" in decision.reason and "0 thread(s) left open" in decision.reason
    # Neither reviewer is asked for, and the threads and off-diff findings that were open no longer hold it.
    open_threads = ld.decide(replace(EXHAUSTED, open_threads=2))
    assert open_threads.action == ld.HAND_OFF and "2 thread(s) left open" in open_threads.reason
    off_diff = ld.decide(replace(EXHAUSTED, claude_off_diff=frozenset({HEAD}), claude_reviewed=frozenset({HEAD})))
    assert off_diff.action == ld.HAND_OFF


def test_an_exhausted_loop_still_waits_for_checks_and_conflicts_and_updates_a_behind_branch():
    assert ld.decide(replace(EXHAUSTED, checks=(failed("Test Suite"),))).action == ld.BLOCKER
    assert ld.decide(replace(EXHAUSTED, merge_state="DIRTY")).action == ld.BLOCKER
    assert ld.decide(replace(EXHAUSTED, merge_state="BEHIND")).action == ld.UPDATE_BRANCH
    assert ld.decide(replace(EXHAUSTED, draft=True)).action == ld.WAIT
    running_checks = ld.decide(replace(EXHAUSTED, checks=(passed("Build Solution"), running("Test Suite"))))
    assert running_checks.action == ld.HAND_OFF and running_checks.reason.endswith(", required checks running")
    assert ld.decide(replace(EXHAUSTED, auto_merge_armed=True)).action == ld.NOTHING


def test_an_exhausted_loop_holds_a_repo_that_requires_no_checks_until_they_are_green():
    waiting = ld.decide(replace(EXHAUSTED, checks_required=False, checks=(passed("Build Solution"), running("Test Suite"))))
    assert waiting.action == ld.WAIT and "no required checks" in waiting.reason


@pytest.mark.parametrize("pattern, exhausted", [
    ("d d d", True), ("d d d d", True), ("c d d d", True),
    ("d d c d", False), ("d d", False), ("d d d c", False), ("c d d", False), ("", False),
])
def test_the_loop_is_exhausted_after_max_claude_rounds_dirty_rounds_in_a_row(pattern, exhausted):
    pr = replace(EXHAUSTED, rounds=rounds(pattern))
    assert pr.loop_exhausted is exhausted
    if exhausted:
        assert ld.decide(pr).action == ld.HAND_OFF
    else:
        # The head is still reviewed before it merges.
        assert ld.decide(pr).action == ld.REQUEST_COPILOT


def test_a_loop_is_only_exhausted_in_a_repo_whose_workflow_merges_and_whose_loop_was_read():
    assert not replace(EXHAUSTED, merged_by_workflow=False).loop_exhausted
    assert ld.decide(replace(EXHAUSTED, merged_by_workflow=False)).action == ld.REQUEST_COPILOT
    # Comments or label events that couldn't be read: never exhausted, so a thread still holds and a review is still wanted.
    unread = replace(EXHAUSTED, loop_unread=True)
    assert not unread.loop_exhausted
    assert ld.decide(unread).action == ld.REQUEST_COPILOT
    assert ld.decide(replace(READY, merged_by_workflow=True, rounds=rounds("d d d"), loop_unread=True, open_threads=1)).action == ld.WAIT


def test_a_reviewed_head_below_exhaustion_still_waits_on_an_open_thread_and_off_diff_findings():
    reviewed = replace(READY, merged_by_workflow=True, rounds=rounds("d d"))
    assert ld.decide(reviewed).action == ld.HAND_OFF
    assert ld.decide(replace(reviewed, open_threads=1)) == ld.Decision(ld.WAIT, "1 open thread(s)")
    off_diff = ld.decide(replace(reviewed, claude_off_diff=frozenset({HEAD})))
    assert off_diff.action == ld.WAIT and "findings outside the diff" in off_diff.reason
    # The same head at three dirty rounds in a row is no longer held by either.
    assert ld.decide(replace(reviewed, rounds=rounds("d d d"), open_threads=1)).action == ld.HAND_OFF
    assert ld.decide(replace(reviewed, rounds=rounds("d d d"), claude_off_diff=frozenset({HEAD}))).action == ld.HAND_OFF


def test_a_documented_exhausted_loop_is_not_a_reason_to_call_claude_in_until_the_owner_re_adds_the_label():
    declined = replace(READY, merged_by_workflow=True, copilot_reviewed=frozenset({OLD}), copilot_declined=frozenset({HEAD}),
                       rounds=rounds("d d c"))
    assert ld.decide(declined).action == ld.REQUEST_CLAUDE
    newest = ld.decide(replace(declined, exhaustion_marker_newest=True))
    assert newest.action == ld.WAIT
    assert "review:claude" in newest.reason and "exhaust" in newest.reason.lower()
    # The same for a dropped request.
    dropped = replace(declined, copilot_declined=frozenset(), copilot_dropped=True)
    assert ld.decide(dropped).action == ld.REQUEST_CLAUDE
    assert ld.decide(replace(dropped, exhaustion_marker_newest=True)).action == ld.WAIT


def test_review_cap_matches_pr_auto_merges():
    workflow = (Path(__file__).resolve().parents[2] / "template" / "owned" / ".github" / "workflows" / "pr-automerge.yml")
    text = workflow.read_text(encoding="utf-8")
    assert f"const COPILOT_REVIEW_CAP = {ld.REVIEW_CAP};" in text


def test_the_exhaustion_marker_matches_pr_auto_merges():
    workflow = (Path(__file__).resolve().parents[2] / "template" / "owned" / ".github" / "workflows" / "pr-automerge.yml")
    text = workflow.read_text(encoding="utf-8")
    assert ld.EXHAUSTED_MARKER == "<!-- pr-automerge:review-loop-exhausted"
    assert f'const EXHAUSTED_MARKER = "{ld.EXHAUSTED_MARKER}";' in text
    assert ld.MAX_CLAUDE_ROUNDS == ld.REVIEW_CAP == 3


def test_pr_auto_merge_calls_in_claude_on_the_same_terms():
    # PR Auto-Merge adds review:claude itself when Copilot's quota note is the head's only review (#190).
    workflow = (Path(__file__).resolve().parents[2] / "template" / "owned" / ".github" / "workflows" / "pr-automerge.yml")
    text = workflow.read_text(encoding="utf-8")
    assert f"const MAX_CLAUDE_ROUNDS = {ld.MAX_CLAUDE_ROUNDS};" in text
    checks = ", ".join(f'"{name}"' for name in sorted(ld.CLAUDE_CHECKS))
    found = re.search(r"const CLAUDE_CHECKS = \[(.*)\];", text)
    assert found and ", ".join(sorted(n.strip() for n in found[1].split(","))) == checks


def test_no_checks_at_all_is_not_green():
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_declined=frozenset({HEAD}), checks=())
    decision = ld.decide(dropped)
    assert decision.action == ld.WAIT and decision.reason.endswith("no checks on the head yet, so Claude waits for CI")
    # Claude Review's own checks alone aren't CI either.
    assert ld.decide(replace(dropped, checks=(passed("Check for a merge from main"),))).action == ld.WAIT


@pytest.mark.parametrize("check", [
    ld.Check("Test Suite", "QUEUED"), ld.Check("Test Suite", "WAITING"), ld.Check("Test Suite", "PENDING"),
    ld.Check("Test Suite", "REQUESTED"),
])
def test_a_queued_pending_or_waiting_check_counts_as_running(check):
    dropped = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_declined=frozenset({HEAD}),
                      checks=(passed("Build Solution"), check))
    decision = ld.decide(dropped)
    assert decision.action == ld.WAIT and decision.reason.endswith("calling in Claude: Test Suite")


def test_claude_review_checks_dont_hold_calling_it_in():
    # Its run cancelled when the label came off early, or skipped without the label.
    unreviewed = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_declined=frozenset({HEAD}),
                         checks=(passed("Build Solution"), cancelled("Check for a merge from main"),
                                 cancelled("Review with Claude"), cancelled("Post Claude's review")))
    assert ld.decide(unreviewed).action == ld.REQUEST_CLAUDE
    assert ld.decide(replace(unreviewed, checks=(passed("Build Solution"), running("Review with Claude")))).action \
        == ld.REQUEST_CLAUDE
    # Any other cancelled check still needs a rerun.
    assert ld.decide(replace(unreviewed, checks=(cancelled("Build Solution"),))).action == ld.BLOCKER


def test_claude_is_called_in_whatever_it_reviewed_before_so_long_as_the_loop_is_not_exhausted():
    # A fix for the findings of any number of Claude's reviews is reviewed too: only dirty rounds in a row end the loop (#375).
    # The old rule stopped at three reviewed commits and left it to the owner.
    three = replace(READY, copilot_reviewed=frozenset(), claude_reviewed=frozenset({OLD, "c" * 40, "d" * 40}),
                    copilot_declined=frozenset({HEAD}), merged_by_workflow=False)
    assert ld.decide(three).action == ld.REQUEST_CLAUDE
    assert ld.decide(replace(three, merged_by_workflow=True, rounds=rounds("d d c"))).action == ld.REQUEST_CLAUDE
    assert ld.decide(replace(three, merged_by_workflow=True, rounds=rounds("d d d"))).action == ld.HAND_OFF
    assert "the owner decides" not in ld.decide(three).reason


def test_a_claude_review_of_the_head_counts_only_with_copilots_quota_note_on_it():
    bare = replace(READY, copilot_reviewed=frozenset(), claude_reviewed=frozenset({HEAD}), copilot_requested=True)
    assert bare.head_reviewer == "" and ld.decide(bare).action == ld.WAIT
    assert replace(bare, copilot_declined=frozenset({OLD})).head_reviewer == ""
    claude = replace(READY, copilot_reviewed=frozenset(), claude_reviewed=frozenset({HEAD}),
                     copilot_declined=frozenset({HEAD}))
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
    both = replace(READY, claude_reviewed=frozenset({HEAD}), copilot_declined=frozenset({HEAD}))
    assert both.head_reviewer == "copilot"
    assert ld.decide(both).reason.startswith("Copilot reviewed the head")
    assert replace(READY, copilot_reviewed=frozenset()).head_reviewer == ""


def test_an_open_thread_waits():
    decision = ld.decide(replace(READY, open_threads=2))
    assert decision == ld.Decision(ld.WAIT, "2 open thread(s)")


def test_below_exhaustion_an_open_thread_waits_after_any_number_of_clean_rounds():
    # Until the loop is exhausted the landing decision never arms past a thread (#375).
    rounds_so_far = replace(READY, copilot_reviewed=frozenset({"c" * 40, "d" * 40, OLD, HEAD}), open_threads=1)
    assert ld.decide(rounds_so_far) == ld.Decision(ld.WAIT, "1 open thread(s)")


def test_a_behind_branch_is_updated_and_nobody_is_asked():
    assert ld.UPDATE_BRANCH == "update branch"
    assert ld.UPDATE_BRANCH in ld.ACTIONS
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
    reviews = [("copilot-pull-request-reviewer", HEAD, ""), ("Copilot", OLD, None), ("mpaulosky", "c" * 40, ""),
               (None, "d" * 40, "")]
    assert ld.copilot_reviews(reviews) == frozenset({HEAD, OLD})


def test_copilot_reviews_skip_the_quota_note():
    note = ("Copilot was unable to review this pull request because the user who requested the review has reached "
            "their quota limit.")
    reviews = [("copilot-pull-request-reviewer", HEAD, note), ("copilot-pull-request-reviewer", OLD, "## Overview")]
    assert ld.copilot_reviews(reviews) == frozenset({OLD})


def test_copilot_declined_lists_the_heads_copilot_answered_with_its_quota_note():
    note = "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit."
    reviews = [("copilot-pull-request-reviewer", HEAD, note), ("copilot-pull-request-reviewer", OLD, "## Overview"),
               ("mpaulosky", "c" * 40, note)]
    assert ld.copilot_declined(reviews) == frozenset({HEAD})


def test_a_head_copilot_declined_calls_in_claude_rather_than_copilot_again():
    declined = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_declined=frozenset({HEAD}))
    decision = ld.decide(declined)
    assert decision.action == ld.REQUEST_CLAUDE
    assert "Copilot couldn't review" in decision.reason
    # A request that still shows after the note doesn't hold it.
    assert ld.decide(replace(declined, copilot_requested=True)).action == ld.REQUEST_CLAUDE
    # Copilot's note on an older head doesn't stop it being asked about this one.
    older = replace(declined, copilot_declined=frozenset({OLD}))
    assert ld.decide(older).action == ld.REQUEST_COPILOT


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


# ── Resolved bot threads nobody replied to (a notice, not a hold) ───────────

def thread(**overrides):
    """A resolved Copilot thread at src/a.py:12 with no reply, unless overridden."""
    fields = dict(resolved=True, opener=ld.COPILOT_REVIEWER, opener_kind="Bot", opener_review="", repliers=(),
                  partial=False, name="src/a.py:12")
    return ld.Thread(**{**fields, **overrides})


def claude_thread(**overrides):
    return thread(opener=ld.GITHUB_ACTIONS, opener_review=ld.CLAUDE_MARKER + "\n**Claude Review**", **overrides)


def test_a_resolved_copilot_thread_with_no_reply_is_listed():
    assert ld.unreplied_threads([thread()]) == ("src/a.py:12",)


def test_a_resolved_copilot_thread_with_a_reply_naming_a_commit_is_not_listed():
    assert ld.unreplied_threads([thread(repliers=("octo",))]) == ()


def test_a_reply_is_enough_whatever_it_says_so_sandcastles_and_a_sessions_replies_count():
    # Sandcastle's marker reply and a session's reply come from the owner's login; their text isn't read.
    assert ld.unreplied_threads([thread(repliers=("octo",)), thread(repliers=("someone-else",), name="b.py:1")]) == ()


def test_a_resolved_claude_review_thread_with_no_reply_is_listed():
    assert ld.unreplied_threads([claude_thread()]) == ("src/a.py:12",)
    assert ld.unreplied_threads([claude_thread(repliers=("octo",))]) == ()


def test_a_github_actions_thread_without_the_claude_marker_is_not_a_bot_thread():
    other = thread(opener=ld.GITHUB_ACTIONS, opener_review="Some other workflow's review.")
    assert not ld.bot_thread(other)
    assert ld.unreplied_threads([other]) == ()


def test_a_persons_own_resolved_thread_is_not_listed():
    assert ld.unreplied_threads([thread(opener="octo", opener_kind="User")]) == ()


def test_a_user_named_like_copilot_is_not_a_bot_thread():
    assert ld.unreplied_threads([thread(opener_kind="User")]) == ()


def test_a_thread_with_no_author_or_another_bots_is_not_a_bot_thread():
    assert ld.unreplied_threads([thread(opener="", opener_kind=""), thread(opener="dependabot", opener_kind="Bot")]) == ()


def test_an_unresolved_bot_thread_is_not_listed():
    assert ld.unreplied_threads([thread(resolved=False)]) == ()


def test_a_reply_by_the_opener_itself_is_no_reply():
    assert ld.unreplied_threads([thread(repliers=(ld.COPILOT_REVIEWER,))]) == ("src/a.py:12",)


def test_a_thread_with_more_comments_than_were_read_counts_as_replied():
    assert ld.unreplied_threads([thread(partial=True)]) == ()


def test_unreplied_threads_keep_the_order_given():
    threads = [thread(name="b.py:2"), thread(name="a.py:1", repliers=("octo",)), claude_thread(name="c.py:3")]
    assert ld.unreplied_threads(threads) == ("b.py:2", "c.py:3")


def test_the_unreplied_threads_are_a_notice_decide_ignores_them():
    assert ld.decide(replace(READY, unreplied_threads=("src/a.py:12",))) == ld.decide(READY)
    waiting = replace(READY, copilot_reviewed=frozenset({OLD}), copilot_requested=True)
    assert ld.decide(replace(waiting, unreplied_threads=("src/a.py:12",))) == ld.decide(waiting)
    assert ld.decide(replace(READY, unreplied_threads=("src/a.py:12",))).action == ld.ARM_AUTO_MERGE


def test_the_notice_names_the_threads_and_is_empty_when_there_are_none():
    assert ld.unreplied_notice(READY) == ""
    one = replace(READY, unreplied_threads=("src/a.py:12",))
    assert ld.unreplied_notice(one) == "notice: resolved without a reply: src/a.py:12"
    two = replace(READY, unreplied_threads=("src/a.py:12", "b.py:3"))
    assert ld.unreplied_notice(two) == "notice: resolved without a reply: src/a.py:12, b.py:3"


def test_the_notice_names_at_most_three_threads_and_counts_the_rest():
    names = ("a.py:1", "b.py:2", "c.py:3", "d.py:4", "e.py:5")
    notice = ld.unreplied_notice(replace(READY, unreplied_threads=names))
    assert notice == "notice: resolved without a reply: a.py:1, b.py:2, c.py:3 and 2 more"
    exactly = ld.unreplied_notice(replace(READY, unreplied_threads=names[:3]))
    assert exactly == "notice: resolved without a reply: a.py:1, b.py:2, c.py:3"


# ── Copilot is asked once per PR, then Claude backs it up (mpaulosky/dotfiles#360) ──

NOW = 1_800_000_000.0
MARKER = ld.COPILOT_ASKED_MARKER


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def comment(login="github-actions", age=3600, body=None):
    """A comment as copilot_ask reads it: (login, body, created_at)."""
    return (login, f"Asked Copilot.\n\n{MARKER}" if body is None else body, iso(NOW - age))


def test_the_record_is_a_comment_with_the_marker_and_the_settle_time_is_30_seconds():
    assert MARKER == "<!-- pr-automerge:copilot-asked -->"
    assert ld.COPILOT_ASK_SETTLE_SECONDS == 30
    assert MARKER in ld.COPILOT_ASKED_COMMENT


def test_pr_auto_merge_uses_the_same_marker_and_settle_time():
    workflow = (Path(__file__).resolve().parents[2] / "template" / "owned" / ".github" / "workflows" / "pr-automerge.yml")
    text = workflow.read_text(encoding="utf-8")
    assert f'const COPILOT_ASKED_MARKER = "{MARKER}";' in text
    assert f"const COPILOT_ASK_SETTLE_MS = {ld.COPILOT_ASK_SETTLE_SECONDS} * 1000;" in text


def test_no_record_means_copilot_was_not_asked():
    assert ld.copilot_ask([], "o", NOW) == (False, False)
    assert ld.copilot_ask([comment(body="Looks good to me."), comment(login="o", body="thanks")], "o", NOW) == (False, False)


def test_a_record_by_github_actions_or_the_owner_counts():
    assert ld.copilot_ask([comment("github-actions")], "o", NOW) == (True, True)
    assert ld.copilot_ask([comment("github-actions[bot]")], "o", NOW) == (True, True)
    assert ld.copilot_ask([comment("o")], "o", NOW) == (True, True)


def test_a_record_by_anyone_else_is_ignored():
    for login in ("stranger", "copilot-pull-request-reviewer", "o-other", "", "github-actions-fake"):
        assert ld.copilot_ask([comment(login)], "o", NOW) == (False, False), login
    assert ld.copilot_ask([comment("o")], "", NOW) == (False, False)


def test_the_record_settles_after_30_seconds():
    assert ld.copilot_ask([comment(age=29)], "o", NOW) == (True, False)
    assert ld.copilot_ask([comment(age=30)], "o", NOW) == (True, True)
    assert ld.copilot_ask([comment(age=31)], "o", NOW) == (True, True)
    assert ld.copilot_ask([comment(age=0)], "o", NOW) == (True, False)


def test_the_first_record_decides_when_there_are_several():
    # Oldest first: the first record is the ask, a later one (a second asker's) changes nothing.
    assert ld.copilot_ask([comment(age=3600), comment(age=5)], "o", NOW) == (True, True)
    assert ld.copilot_ask([comment(age=5), comment(age=3600)], "o", NOW) == (True, False)
    assert ld.copilot_ask([comment("stranger", age=3600), comment(age=5)], "o", NOW) == (True, False)


def test_a_record_after_other_comments_is_found():
    assert ld.copilot_ask([comment(body="LGTM"), comment("o", body="thanks"), comment(age=100)], "o", NOW) == (True, True)


def test_comments_that_could_not_be_read_count_as_asked_but_not_settled():
    assert ld.copilot_ask(None, "o", NOW) == (True, False)


def test_a_record_with_an_unreadable_time_is_asked_but_not_settled():
    for created in ("not a date", "", None):
        assert ld.copilot_ask([("github-actions", MARKER, created)], "o", NOW) == (True, False), created


UNASKED = replace(READY, copilot_reviewed=frozenset({OLD}))
ASKED = replace(UNASKED, copilot_asked=True)
SETTLED = replace(ASKED, copilot_ask_settled=True)


def test_copilot_is_gone_when_asked_and_settled_with_nothing_pending_or_dropped_or_declined():
    assert not UNASKED.copilot_gone
    assert not ASKED.copilot_gone
    assert SETTLED.copilot_gone
    assert not replace(SETTLED, copilot_requested=True).copilot_gone
    assert replace(UNASKED, copilot_dropped=True).copilot_gone
    assert replace(ASKED, copilot_dropped=True).copilot_gone
    assert not replace(UNASKED, copilot_ask_settled=True).copilot_gone


def test_an_unasked_head_asks_copilot():
    decision = ld.decide(UNASKED)
    assert decision.action == ld.REQUEST_COPILOT
    assert decision.reason.endswith("Copilot not asked yet")


def test_an_asked_head_waits_for_the_request_to_show_until_the_record_settles():
    decision = ld.decide(ASKED)
    assert decision.action == ld.WAIT
    assert "Copilot was asked" in decision.reason and "no Copilot or Claude review of aaaaaaa" in decision.reason


def test_a_settled_record_with_nothing_pending_calls_in_claude_once_checks_are_green():
    assert ld.decide(SETTLED).action == ld.REQUEST_CLAUDE
    waiting = ld.decide(replace(SETTLED, checks=(passed("Build Solution"), running("Test Suite"))))
    assert waiting.action == ld.WAIT and waiting.reason.endswith("waiting for checks before calling in Claude: Test Suite")
    assert ld.decide(replace(SETTLED, checks=(failed("Test Suite"),))).action == ld.BLOCKER
    assert ld.decide(replace(SETTLED, checks=())).action == ld.WAIT


def test_a_settled_record_with_a_pending_request_waits():
    decision = ld.decide(replace(SETTLED, copilot_requested=True))
    assert decision.action == ld.WAIT and decision.reason.endswith("Copilot is requested")


def test_a_dropped_request_read_back_in_this_process_calls_in_claude_before_the_record_settles():
    assert ld.decide(replace(ASKED, copilot_dropped=True)).action == ld.REQUEST_CLAUDE


def test_claudes_earlier_reviews_stall_nothing_for_a_settled_record_either():
    used = replace(SETTLED, claude_reviewed=frozenset({"c" * 40, "d" * 40, "e" * 40, OLD}))
    assert ld.decide(used).action == ld.REQUEST_CLAUDE


def test_the_label_waits_for_claude_whatever_the_record_says():
    assert ld.decide(replace(SETTLED, claude_requested=True)).action == ld.WAIT
    assert "review:claude is on" in ld.decide(replace(SETTLED, claude_requested=True)).reason


def test_claudes_review_of_the_head_counts_only_where_copilot_is_gone():
    reviewed = replace(UNASKED, claude_reviewed=frozenset({HEAD}), claude_requested=True)
    assert reviewed.head_reviewer == "" and ld.decide(reviewed).action == ld.REQUEST_COPILOT
    assert replace(reviewed, copilot_asked=True).head_reviewer == ""
    gone = replace(reviewed, copilot_asked=True, copilot_ask_settled=True)
    assert gone.head_reviewer == "claude"
    assert ld.decide(gone).action == ld.ARM_AUTO_MERGE
    assert replace(gone, copilot_requested=True).head_reviewer == ""
    # Copilot's own review comes first.
    assert replace(gone, copilot_reviewed=frozenset({HEAD})).head_reviewer == "copilot"


def test_claudes_review_of_an_older_commit_is_backed_by_a_settled_record_but_covers_no_head():
    older = replace(SETTLED, claude_reviewed=frozenset({OLD}))
    # It counts as a round (Copilot is gone from the PR), but it is not a review of the head.
    assert older.claude_backed == frozenset({OLD})
    assert older.head_reviewer == ""
    assert ld.decide(older).action == ld.REQUEST_CLAUDE
    # Still not backed while Copilot may review: the ask is unsettled, or a request is pending.
    assert replace(ASKED, claude_reviewed=frozenset({OLD})).claude_backed == frozenset()
    assert replace(SETTLED, claude_reviewed=frozenset({OLD}), copilot_requested=True).claude_backed == frozenset()
    # A quota note on that commit backs it whatever the record says.
    assert replace(UNASKED, claude_reviewed=frozenset({OLD}), copilot_declined=frozenset({OLD})).claude_backed == frozenset({OLD})


def record(login, oid, body, at, comments=0, merge=False):
    """A review as review_rounds() reads it: (author login, commit oid, body, submittedAt, inline thread count, is a merge)."""
    return (login, oid, body, at, comments, merge)


CLAUDE_CLEAN = "<!-- claude-review -->\nNo findings."
CLAUDE_OFF_DIFF = "<!-- claude-review -->\n<!-- claude-review:off-diff -->\n**Claude Review**"
QUOTA_NOTE = "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit."


def test_review_rounds_counts_copilots_reviews_of_non_merge_commits_oldest_first_and_marks_the_dirty_ones():
    reviews = [
        record("copilot-pull-request-reviewer", "c1", "", "2026-01-02T00:01:00Z", comments=2),
        record("copilot-pull-request-reviewer", "c2", "", "2026-01-02T00:02:00Z"),
        record("copilot-pull-request-reviewer", "m1", "", "2026-01-02T00:03:00Z", comments=1, merge=True),
        record("copilot-pull-request-reviewer", "c3", QUOTA_NOTE, "2026-01-02T00:04:00Z"),
    ]
    rounds_found = ld.review_rounds(reviews, declined=frozenset(), gone=False)
    assert [(item.oid, item.dirty) for item in rounds_found] == [("c1", True), ("c2", False)]
    assert [item.at for item in rounds_found] == ["2026-01-02T00:01:00Z", "2026-01-02T00:02:00Z"]


def test_review_rounds_makes_one_round_of_a_commit_reviewed_twice_dirty_if_either_review_was():
    reviews = [
        record("Copilot", "c1", "", "2026-01-02T00:01:00Z", comments=1),
        record("Copilot", "c2", "", "2026-01-02T00:02:00Z"),
        record("Copilot", "c1", "", "2026-01-02T00:03:00Z"),
    ]
    found = ld.review_rounds(reviews, frozenset(), False)
    # Ordered by each commit's latest review.
    assert [(item.oid, item.dirty) for item in found] == [("c2", False), ("c1", True)]
    assert found[1].at == "2026-01-02T00:03:00Z"


def test_review_rounds_counts_claudes_reviews_only_where_copilot_cant_review_that_commit():
    reviews = [
        record("github-actions", "c1", CLAUDE_CLEAN, "2026-01-02T00:01:00Z"),
        record("github-actions", "c2", CLAUDE_OFF_DIFF, "2026-01-02T00:02:00Z"),
        record("github-actions", "c3", "Some other workflow's review.", "2026-01-02T00:03:00Z", comments=3),
        record("github-actions", "m1", CLAUDE_OFF_DIFF, "2026-01-02T00:04:00Z", merge=True),
    ]
    # Copilot may still review: none of Claude's reviews is a round.
    assert ld.review_rounds(reviews, frozenset(), False) == ()
    # Copilot answered c2 with its quota note: that review counts, and an off-diff review is dirty.
    only_noted = ld.review_rounds(reviews, frozenset({"c2"}), False)
    assert [(item.oid, item.dirty) for item in only_noted] == [("c2", True)]
    # Copilot is gone: every marked Claude review of a non-merge commit counts, whatever its commit.
    gone = ld.review_rounds(reviews, frozenset(), True)
    assert [(item.oid, item.dirty) for item in gone] == [("c1", False), ("c2", True)]


def test_review_rounds_makes_a_dirty_round_of_a_claude_review_with_inline_threads_too():
    reviews = [record("github-actions", "c1", CLAUDE_CLEAN, "2026-01-02T00:01:00Z", comments=2)]
    assert [(item.oid, item.dirty) for item in ld.review_rounds(reviews, frozenset({"c1"}), False)] == [("c1", True)]


def test_a_merge_of_main_is_never_a_round():
    reviews = [
        record("Copilot", "c1", "", "2026-01-02T00:01:00Z", comments=1),
        record("Copilot", "m1", "", "2026-01-02T00:02:00Z", comments=1, merge=True),
        record("Copilot", "c2", "", "2026-01-02T00:03:00Z", comments=1),
        record("github-actions", "m2", CLAUDE_OFF_DIFF, "2026-01-02T00:04:00Z", comments=1, merge=True),
        record("Copilot", "c3", "", "2026-01-02T00:05:00Z", comments=1),
    ]
    found = ld.review_rounds(reviews, frozenset({"m2"}), True)
    assert [item.oid for item in found] == ["c1", "c2", "c3"]
    assert ld.trailing_dirty(found) == 3


def test_trailing_dirty_counts_the_dirty_rounds_back_from_the_newest():
    assert ld.trailing_dirty(()) == 0
    assert ld.trailing_dirty(rounds("d")) == 1
    assert ld.trailing_dirty(rounds("d d c d")) == 1
    assert ld.trailing_dirty(rounds("d d d c")) == 0
    assert ld.trailing_dirty(rounds("c d d d")) == 3
    assert ld.trailing_dirty(rounds("d d d d d")) == 5
