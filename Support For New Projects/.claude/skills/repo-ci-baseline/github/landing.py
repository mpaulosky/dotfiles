"""The landing decision: what a PR needs next to land, from its state alone.

Pure: no GitHub calls. `status.py` and `land.py` fetch a PR's state, build a
PrState and call decide(). The rules are the ones the
skill lands PRs by (references/automerge.md):

- a merged or closed PR, or one with auto-merge already armed, needs nothing;
- a failed check (or a cancelled one nothing newer replaced, other than
  Claude Review's own) is a blocker to report, never something to arm past;
  so is a merge conflict;
- a draft is marked ready only when the caller says it should be;
- a branch BEHIND main is updated, and Copilot asked to review the new head;
- a head no reviewer has reviewed waits for Copilot while it's requested, and
  for Claude while the PR carries review:claude. With neither on its way,
  Copilot is asked first. Only once that request for the head didn't register
  (copilot_dropped, which the caller remembers per head) is review:claude
  added, and only once the head has at least one check other than Claude
  Review's own and every such check is green: a Claude review costs money,
  and one of a head that fails CI is wasted. Never past MAX_CLAUDE_ROUNDS
  commits Claude reviewed on the PR: after those the owner decides;
- past PR Auto-Merge's review cap (REVIEW_CAP distinct reviewed commits, in a
  repo whose workflow merges; re-Apply PRs included, since #174) neither
  reviewer is asked for: the workflow no longer waits for a review of the
  head, so the PR goes on to its threads and checks like a reviewed one;
- auto-merge is armed only once a reviewer has reviewed the current head and
  no review thread is unresolved. The reviewer is Copilot (an author matching
  /copilot/i), or Claude as its backup: Claude Review posts as
  github-actions[bot] with CLAUDE_MARKER first in the body. When Claude's
  latest review of the head has findings outside the diff (OFF_DIFF_MARKER
  on its second line), they open no thread, so the PR waits for a new head;
- where the repo requires no checks (dotfiles), auto-merge wouldn't wait for
  CI, so the checks must finish green first;
- in a Baseline repo, its own PR Auto-Merge workflow merges a reviewed PR
  through the API once its checks pass (and past the review cap), and it
  never arms native auto-merge: so the PR is left to it, never armed around it;
- a release-blog PR (release.yml's or backfill-blog-posts.yml's branch) is
  armed as soon as it is open and not blocked, without Copilot's review, as
  those workflows arm it themselves; one they armed needs nothing.

A cancelled check run is superseded when a newer run of the same check name
on the same head exists: CI's concurrency cancels runs, and the newest counts.
"""

import re
from dataclasses import dataclass, field

WAIT = "wait"
MARK_READY = "mark ready"
UPDATE_BRANCH = "update branch and request Copilot"
REQUEST_COPILOT = "request Copilot"
REQUEST_CLAUDE = "add review:claude"
ARM_AUTO_MERGE = "arm auto-merge"
HAND_OFF = "leave to PR Auto-Merge"
BLOCKER = "report blocker"
NOTHING = "nothing"
ACTIONS = (WAIT, MARK_READY, UPDATE_BRANCH, REQUEST_COPILOT, REQUEST_CLAUDE, ARM_AUTO_MERGE, HAND_OFF, BLOCKER,
           NOTHING)

COPILOT = re.compile(r"copilot", re.IGNORECASE)
# Claude Review's login (GraphQL drops the "[bot]" suffix, REST keeps it) and
# the marker its review bodies start with; post_claude_review.py writes both.
GITHUB_ACTIONS = "github-actions"
CLAUDE_MARKER = "<!-- claude-review -->"
OFF_DIFF_MARKER = "<!-- claude-review:off-diff -->"
REVIEW_CLAUDE = "review:claude"
# Claude Review's own checks (claude-review.yml's job names). Removing the
# label cancels a run in progress and its next add starts a fresh one, so a
# cancelled run of these needs no rerun, and they don't gate calling it in.
CLAUDE_CHECKS = frozenset({"Check for a merge from main", "Review with Claude", "Post Claude's review"})
# The owner's cost rule: at most this many Claude review rounds on one PR.
MAX_CLAUDE_ROUNDS = 2
# PR Auto-Merge's shared review cap: must match COPILOT_REVIEW_CAP in the
# Template's pr-automerge.yml. Past it, the workflow stops waiting for a review
# of the head (it still holds on open threads). It counts distinct non-merge
# commits Copilot and Claude reviewed; this counts every reviewed commit, so it
# can reach the cap a little early, never late.
REVIEW_CAP = 3

# The head branches release.yml and backfill-blog-posts.yml open their blog PRs from.
RELEASE_BLOG_BRANCHES = frozenset({"docs/release-notes", "docs/backfill-blog-posts"})

PASSED = {"SUCCESS", "NEUTRAL", "SKIPPED"}
FAILED = {"FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR", "STALE"}
CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class Check:
    """One check run (or commit status) on the PR's head.

    status is GitHub's CheckStatusState (QUEUED, IN_PROGRESS, COMPLETED, ...);
    conclusion is set once COMPLETED. rank is a check run's databaseId, which
    orders runs of the same name by creation, as GitHub (and PR Auto-Merge)
    does; a commit status has none, so its started_at (an ISO-8601 timestamp)
    orders it instead.
    """

    name: str
    status: str
    conclusion: str | None = None
    started_at: str = ""
    rank: int = 0


@dataclass(frozen=True)
class Checks:
    """The head's checks after superseded runs are dropped, by name."""

    passed: tuple[str, ...] = ()
    running: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()
    cancelled: tuple[str, ...] = ()  # newest run of its name, so not superseded
    superseded: tuple[str, ...] = ()  # cancelled, with a newer run of the same name

    @property
    def green(self):
        return not (self.running or self.failed or self.cancelled)


@dataclass(frozen=True)
class PrState:
    """What decide() reads about one PR.

    copilot_reviewed: the commit oids Copilot reviewed (see copilot_reviews()).
    claude_reviewed: the commit oids Claude Review reviewed (see claude_reviews()).
    claude_off_diff: the commit oids whose latest Claude review has findings
    outside the diff (see claude_off_diff()).
    checks_required: whether the repo requires checks before a merge; without
    them native auto-merge merges at once, so green checks must come first.
    copilot_requested: Copilot is among the PR's pending review requests.
    claude_requested: the PR carries review:claude.
    copilot_dropped: Copilot's review was requested for this head and the
    request didn't register (dropped or refused). Only a caller that asked
    and read it back knows this (land.py); a one-shot read (status.py) never
    sets it, so it shows the Copilot step.
    want_ready: the caller's say that a draft should be marked ready.
    merged_by_workflow: the repo's own PR Auto-Merge workflow merges it (a
    Baseline repo), so it is left to that workflow rather than armed.
    release_blog: a release-blog PR (see RELEASE_BLOG_BRANCHES).
    """

    state: str = "OPEN"  # OPEN, MERGED or CLOSED
    draft: bool = False
    head: str = ""
    copilot_reviewed: frozenset[str] = field(default_factory=frozenset)
    claude_reviewed: frozenset[str] = field(default_factory=frozenset)
    claude_off_diff: frozenset[str] = field(default_factory=frozenset)
    copilot_requested: bool = False
    claude_requested: bool = False
    copilot_dropped: bool = False
    open_threads: int = 0
    merge_state: str = "UNKNOWN"  # GitHub's mergeStateStatus
    checks: tuple[Check, ...] = ()
    checks_required: bool = True
    auto_merge_armed: bool = False
    want_ready: bool = False
    merged_by_workflow: bool = False
    release_blog: bool = False

    @property
    def head_reviewer(self):
        """"copilot" or "claude", whichever reviewed the head (Copilot first), else ""."""
        if not self.head:
            return ""
        if self.head in self.copilot_reviewed:
            return "copilot"
        if self.head in self.claude_reviewed:
            return "claude"
        return ""

    @property
    def reviewer_on_head(self):
        return bool(self.head_reviewer)

    @property
    def past_review_cap(self):
        """PR Auto-Merge no longer waits for a review of the head (see REVIEW_CAP)."""
        return self.merged_by_workflow and len(self.copilot_reviewed | self.claude_reviewed) >= REVIEW_CAP


@dataclass(frozen=True)
class Decision:
    action: str  # one of ACTIONS
    reason: str


def copilot_reviews(reviews):
    """The commit oids reviewed by Copilot, from (author login, commit oid) pairs."""
    return frozenset(oid for login, oid in reviews if login and oid and COPILOT.search(login))


def is_claude_review(login, oid, body):
    return bool(login and oid and login.removesuffix("[bot]") == GITHUB_ACTIONS and (body or "").startswith(CLAUDE_MARKER))


def claude_reviews(reviews):
    """The commit oids reviewed by Claude Review, from (author login, commit oid, body) triples."""
    return frozenset(oid for login, oid, body in reviews if is_claude_review(login, oid, body))


def claude_off_diff(reviews):
    """The commit oids whose latest Claude review has findings outside the diff.

    reviews are (author login, commit oid, body) triples, oldest first, so a
    later review of the same commit replaces an earlier one.
    """
    latest = {oid: body for login, oid, body in reviews if is_claude_review(login, oid, body)}
    return frozenset(oid for oid, body in latest.items() if body.split("\n")[1:2] == [OFF_DIFF_MARKER])


def summarize_checks(checks):
    """Sort the head's checks into passed, running, failed and cancelled.

    Runs are grouped by name and the newest (the last created, by rank; else
    the latest started_at, a run not yet started counting as newest) is the
    check's result. Older runs are ignored,
    and an older cancelled run is listed as superseded.
    """
    by_name = {}
    for check in checks:
        by_name.setdefault(check.name, []).append(check)
    buckets = {"passed": [], "running": [], "failed": [], "cancelled": [], "superseded": []}
    for name, runs in sorted(by_name.items()):
        runs.sort(key=lambda run: (run.rank, run.started_at == "", run.started_at))
        newest = runs[-1]
        if any(run.conclusion == CANCELLED for run in runs[:-1]):
            buckets["superseded"].append(name)
        if newest.status != "COMPLETED":
            buckets["running"].append(name)
        elif newest.conclusion == CANCELLED:
            buckets["cancelled"].append(name)
        elif newest.conclusion in PASSED:
            buckets["passed"].append(name)
        else:
            buckets["failed"].append(name)
    return Checks(**{key: tuple(value) for key, value in buckets.items()})


def decide(pr):
    """The one next action for pr, as a Decision(action, reason)."""
    if pr.state != "OPEN":
        return Decision(NOTHING, pr.state.lower())
    if pr.auto_merge_armed:
        return Decision(NOTHING, "auto-merge armed")

    checks = summarize_checks(pr.checks)
    if checks.failed:
        return Decision(BLOCKER, "failed: " + ", ".join(checks.failed))
    cancelled = [name for name in checks.cancelled if name not in CLAUDE_CHECKS]
    if cancelled:
        return Decision(BLOCKER, "cancelled, needs a rerun: " + ", ".join(cancelled))
    if pr.merge_state == "DIRTY":
        return Decision(BLOCKER, "merge conflict with main")

    if pr.draft:
        if pr.want_ready:
            return Decision(MARK_READY, "draft")
        return Decision(WAIT, "draft")
    if pr.release_blog:
        return Decision(ARM_AUTO_MERGE, "release-blog PR, not armed by its workflow")
    if pr.merge_state == "BEHIND":
        return Decision(UPDATE_BRANCH, "behind main")
    if not pr.reviewer_on_head and not pr.past_review_cap:
        return review_needed(pr, checks)
    if pr.open_threads:
        return Decision(WAIT, f"{pr.open_threads} open thread(s)")
    if pr.head in pr.claude_off_diff:
        return Decision(WAIT, f"Claude's review of {pr.head[:7]} has findings outside the diff")
    if checks.running and not pr.checks_required:
        return Decision(WAIT, "no required checks; waiting for: " + ", ".join(checks.running))
    reviewed = (f"{pr.head_reviewer.capitalize()} reviewed the head" if pr.reviewer_on_head
                else f"review cap ({REVIEW_CAP}) reached")
    reason = f"{reviewed}, no open threads" + ("" if checks.green else ", required checks running")
    if pr.merged_by_workflow:
        return Decision(HAND_OFF, reason)
    return Decision(ARM_AUTO_MERGE, reason)


def review_needed(pr, checks):
    """The decision for an open, current PR whose head no reviewer has reviewed."""
    waiting = f"no Copilot or Claude review of {pr.head[:7]} yet"
    if pr.copilot_requested:
        return Decision(WAIT, waiting + "; Copilot is requested")
    if pr.claude_requested:
        return Decision(WAIT, waiting + f"; {REVIEW_CLAUDE} is on")
    if not pr.copilot_dropped:
        return Decision(REQUEST_COPILOT, waiting + "; Copilot not requested")
    if len(pr.claude_reviewed) >= MAX_CLAUDE_ROUNDS:
        return Decision(WAIT, waiting + f"; Claude's {MAX_CLAUDE_ROUNDS} review rounds are used, the owner decides")
    running = [name for name in checks.running if name not in CLAUDE_CHECKS]
    if running:
        return Decision(WAIT, waiting + "; waiting for checks before calling in Claude: " + ", ".join(running))
    # No checks yet (CI hasn't created them) isn't green.
    reported = [name for name in checks.passed + checks.running + checks.failed + checks.cancelled
                if name not in CLAUDE_CHECKS]
    if not reported:  # every listed repo has CI, dotfiles included
        return Decision(WAIT, waiting + "; no checks on the head yet, so Claude waits for CI")
    return Decision(REQUEST_CLAUDE, waiting + "; Copilot's request didn't register, checks green")
