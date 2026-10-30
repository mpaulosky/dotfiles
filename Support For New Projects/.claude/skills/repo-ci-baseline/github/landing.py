"""The landing decision: what a PR needs next to land, from its state alone.

Pure: no GitHub calls. `status.py` and `land.py` fetch a PR's state, build a
PrState and call decide(). The rules are the ones the
skill lands PRs by (references/automerge.md):

- a merged or closed PR, or one with auto-merge already armed, needs nothing;
- a failed check (or a cancelled one nothing newer replaced, other than
  Claude Review's own) is a blocker to report, never something to arm past;
  so is a merge conflict;
- a draft is marked ready only when the caller says it should be;
- resolved Copilot and Claude Review threads nobody replied to are listed in
  PrState.unreplied_threads: a notice beside the decision, never a hold;
- a branch BEHIND main is updated (nobody is asked to review: Copilot is asked once per PR);
- a head no reviewer has reviewed waits for Copilot while it's requested, and
  for Claude while the PR carries review:claude. With neither on its way and
  Copilot never asked for the PR, Copilot is asked, once: a comment records the
  ask (COPILOT_ASKED_MARKER) and the request follows. Claude backs Copilot up
  only where Copilot can't review that head (copilot_gone): it answered with its
  quota note (copilot_declined), or it was asked, the ask settled (30 seconds)
  and no request is pending, or the caller read this head's request back and it
  didn't register (copilot_dropped). A Claude review of any other head covers
  nothing. Copilot isn't asked again for a later head: a settled record is
  enough to take it to Claude (mpaulosky/dotfiles#360).
  Only then is review:claude added, and only once the head has at least one check other than Claude
  Review's own and every such check is green: a Claude review costs money,
  and one of a head that fails CI is wasted. Never while PR Auto-Merge's
  exhaustion comment is the newest word on the PR (exhaustion_marker_newest):
  the owner adds the label again to start a new loop;
- the review loop (mpaulosky/dotfiles#375) is exhausted after MAX_CLAUDE_ROUNDS
  dirty rounds in a row, in a repo whose workflow merges (re-Apply PRs
  included, since #174). A round is a review of a non-merge commit (a merge of
  main is never one), dirty when it raised a thread or an off-diff finding.
  Neither reviewer is asked for then, and the workflow documents the loop in
  one comment and lets the PR merge: it no longer waits for a review of the
  head, nor holds on the threads and off-diff findings still open, so the PR
  goes on to its checks and is left to the workflow;
- auto-merge is armed only once a reviewer has reviewed the current head and
  no review thread is unresolved. The reviewer is Copilot (an author matching
  /copilot/i), or Claude as its backup on a head Copilot can't review (its quota note,
  or a dropped request): Claude Review posts as
  github-actions[bot] with CLAUDE_MARKER first in the body. When Claude's
  latest review of the head has findings outside the diff (OFF_DIFF_MARKER
  on its second line), they open no thread, so the PR waits for a new head;
- where the repo requires no checks (dotfiles), auto-merge wouldn't wait for
  CI, so the checks must finish green first;
- in a Baseline repo, its own PR Auto-Merge workflow merges a reviewed PR
  through the API once its checks pass (and at an exhausted review loop), and it
  never arms native auto-merge: so the PR is left to it, never armed around it;
- a release-blog PR (release.yml's or backfill-blog-posts.yml's branch) is
  armed as soon as it is open and not blocked, without Copilot's review, as
  those workflows arm it themselves; one they armed needs nothing.

A cancelled check run is superseded when a newer run of the same check name
on the same head exists: CI's concurrency cancels runs, and the newest counts.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime

WAIT = "wait"
MARK_READY = "mark ready"
UPDATE_BRANCH = "update branch"
REQUEST_COPILOT = "request Copilot"
REQUEST_CLAUDE = "add review:claude"
ARM_AUTO_MERGE = "arm auto-merge"
HAND_OFF = "leave to PR Auto-Merge"
BLOCKER = "report blocker"
NOTHING = "nothing"
ACTIONS = (WAIT, MARK_READY, UPDATE_BRANCH, REQUEST_COPILOT, REQUEST_CLAUDE, ARM_AUTO_MERGE, HAND_OFF, BLOCKER,
           NOTHING)

COPILOT = re.compile(r"copilot", re.IGNORECASE)
# Copilot's review of a head once the account's Copilot code review quota is
# used up: it reviewed nothing, so it isn't a review. PR Auto-Merge's
# COPILOT_NO_REVIEW and claude-review.yml skip it the same way.
# ASCII whitespace spelled out, not \s: gh's gojq (RE2) reads \s as ASCII only, JS and Python as Unicode.
COPILOT_NO_REVIEW = re.compile(r"[ \t\r\n]*Copilot was unable to review")  # used with match()
# Claude Review's login (GraphQL drops the "[bot]" suffix, REST keeps it) and
# the marker its review bodies start with; post_claude_review.py writes both.
GITHUB_ACTIONS = "github-actions"
CLAUDE_MARKER = "<!-- claude-review -->"
OFF_DIFF_MARKER = "<!-- claude-review:off-diff -->"
REVIEW_CLAUDE = "review:claude"
# The hidden marker PR Auto-Merge's comment on an exhausted review loop ends with, followed by the head and " -->"
# (mpaulosky/dotfiles#375). The Template's pr-automerge.yml has the same prefix (a test holds them equal).
EXHAUSTED_MARKER = "<!-- pr-automerge:review-loop-exhausted"
# The record that PR Auto-Merge or land.py asked Copilot to review the PR (mpaulosky/dotfiles#360): a comment
# containing the marker. The Template's pr-automerge.yml has the same marker and settle time.
COPILOT_ASKED_MARKER = "<!-- pr-automerge:copilot-asked -->"
COPILOT_ASK_SETTLE_SECONDS = 30
COPILOT_ASKED_COMMENT = ("Copilot's review was requested for this PR. It is asked once per PR; if GitHub drops the request, "
                         "review:claude calls in Claude instead. mpaulosky/dotfiles#360\n\n" + COPILOT_ASKED_MARKER)
# Claude Review's own checks (claude-review.yml's job names). Removing the
# label cancels a run in progress and its next add starts a fresh one, so a
# cancelled run of these needs no rerun, and they don't gate calling it in.
CLAUDE_CHECKS = frozenset({"Check for a merge from main", "Review with Claude", "Post Claude's review"})
# The owner's cost rule: the dirty rounds in a row, Copilot's and Claude's
# together, after which the PR's review loop is exhausted (mpaulosky/dotfiles#375).
# 3, so a fix for a second round's findings is reviewed too (#193): Claude
# reviews every push while review:claude is on, until a review comes back clean.
# PR Auto-Merge calls in Claude too, when Copilot's quota note is the head's only
# review (#190) or Copilot was asked and its request didn't register within 30
# seconds (mpaulosky/dotfiles#360), and takes review:claude off at an exhausted
# loop: its MAX_CLAUDE_ROUNDS and CLAUDE_CHECKS must match these.
MAX_CLAUDE_ROUNDS = 3
# The Template's pr-automerge.yml keeps this under its old name, COPILOT_REVIEW_CAP,
# because github-settings.sh reads it, and must match it. It equals
# MAX_CLAUDE_ROUNDS and bounds nothing here: loop_exhausted uses that.
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


COPILOT_REVIEWER = "copilot-pull-request-reviewer"


@dataclass(frozen=True)
class Thread:
    """One review thread, as much of it as the unreplied-thread notice reads.

    opener, opener_kind ("Bot", "User" or "") and opener_review (the review body)
    are the thread's opening comment's author and review; repliers are the
    logins of the later comments; partial: more comments than were read;
    name: the printable-safe path:line.
    """

    resolved: bool
    opener: str
    opener_kind: str
    opener_review: str
    repliers: tuple[str, ...]
    partial: bool
    name: str


def bot_thread(thread):
    """A Copilot or Claude Review thread, by the rule claude-review.yml reviews threads by.

    The opening comment's author is the Bot copilot-pull-request-reviewer, or
    github-actions with the Claude marker first in the opening review's body.
    """
    login = thread.opener.removesuffix("[bot]")
    if thread.opener_kind != "Bot":
        return False
    return login == COPILOT_REVIEWER or (login == GITHUB_ACTIONS and (thread.opener_review or "").startswith(CLAUDE_MARKER))


def unreplied_threads(threads):
    """The names of the resolved bot threads nobody but their opener commented on.

    A reply's text isn't read: Sandcastle's and a session's replies come from
    the owner's login and count as replies. A thread with more comments than
    were read counts as replied.
    """
    return tuple(thread.name for thread in threads
                 if thread.resolved and bot_thread(thread) and not thread.partial
                 and all(replier == thread.opener for replier in thread.repliers))


UNREPLIED_NAMED = 3


def unreplied_notice(pr):
    """The line's notice for the resolved bot threads nobody replied to; "" when there are none."""
    names = pr.unreplied_threads
    if not names:
        return ""
    shown = ", ".join(names[:UNREPLIED_NAMED])
    more = len(names) - UNREPLIED_NAMED
    return f"notice: resolved without a reply: {shown}" + (f" and {more} more" if more > 0 else "")


@dataclass(frozen=True)
class Round:
    """One review round: a counted review of a non-merge commit (see review_rounds()).

    at is the submission time of the commit's latest counted review, as GitHub
    reports it (an ISO-8601 timestamp).
    """

    oid: str
    dirty: bool
    at: str


def review_rounds(records, declined, gone):
    """The PR's review rounds, oldest first, as a tuple of Round.

    records are (author login, commit oid, body, submittedAt, inline thread
    count, is a merge) tuples, in the order GitHub lists reviews (oldest first).
    A review counts when it is Copilot's own (not its quota note), or Claude
    Review's as Copilot's backup: Claude's review counts when Copilot answered
    that commit with its quota note (declined holds its oid) or Copilot can't
    review the PR now (gone: its quota note is on the head, or its request
    didn't register). A round is one non-merge commit; a review of a merge
    commit, a merge of main included, is never a round. A round is dirty when
    any of its counted reviews raised an inline thread or, for Claude, findings
    outside the diff, and sits where its latest counted review does. PR
    Auto-Merge's reviewRounds() does the same.
    """
    by_commit = {}
    for login, oid, body, at, comments, merge in records:
        if not login or not oid or merge:
            continue
        if COPILOT.search(login):
            if COPILOT_NO_REVIEW.match(body or ""):
                continue
            off_diff = False
        elif is_claude_review(login, oid, body):
            if not (gone or oid in declined):
                continue
            off_diff = (body or "").split("\n")[1:2] == [OFF_DIFF_MARKER]
        else:
            continue
        earlier = by_commit.pop(oid, None)
        by_commit[oid] = Round(oid, bool(comments) or off_diff or bool(earlier and earlier.dirty), at or "")
    return tuple(by_commit.values())


def trailing_dirty(rounds):
    """How many of the newest rounds in a row were dirty."""
    count = 0
    for round_ in reversed(rounds):
        if not round_.dirty:
            break
        count += 1
    return count


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
    sets it.
    copilot_asked: the PR carries the record that Copilot was asked (see
    copilot_ask()), or the record couldn't be read, which counts as asked so
    nothing asks twice.
    copilot_ask_settled: the record is at least COPILOT_ASK_SETTLE_SECONDS old,
    long enough for GitHub to have registered the request.
    unreplied_threads: names of the resolved bot threads nobody replied to; a
    notice, not a hold: decide() ignores it.
    copilot_declined: the commit oids Copilot answered with its quota note
    (see copilot_declined()); on the head it calls in Claude. Claude's review
    of a commit counts when that commit is in copilot_declined, or Copilot is
    gone (see claude_backed).
    rounds: the PR's review rounds since its loop began, oldest first (see
    review_rounds()); status.py cuts them at the owner's re-add of review:claude
    after an exhaustion comment.
    exhaustion_marker_newest: PR Auto-Merge's exhaustion comment is on the PR
    and review:claude hasn't been added since: no review is asked for.
    loop_unread: the comments or label events that tell the loop's state
    couldn't be read, so it is never called exhausted.
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
    copilot_asked: bool = False
    copilot_ask_settled: bool = False
    copilot_declined: frozenset[str] = field(default_factory=frozenset)
    rounds: tuple[Round, ...] = ()
    exhaustion_marker_newest: bool = False
    loop_unread: bool = False
    open_threads: int = 0
    unreplied_threads: tuple[str, ...] = ()
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
        if self.head in self.claude_backed:
            return "claude"
        return ""

    @property
    def claude_backed(self):
        """The commit oids whose Claude review counts: Copilot couldn't review that commit.

        It posted its quota note on it, or Copilot can't review the PR now: its
        quota note is on the head, or it is gone from it (see copilot_gone).
        Then Claude's review of any commit counts: the head moves on (a merge
        of main, a fix) and its earlier reviews stay rounds.
        """
        if self.copilot_gone or (self.head and self.head in self.copilot_declined):
            return self.claude_reviewed
        return self.claude_reviewed & self.copilot_declined

    @property
    def copilot_gone(self):
        """Copilot won't review the head: its request didn't register.

        Either the caller read the request back and it was dropped, or Copilot
        was asked for the PR, the ask settled and no request is pending (a
        pending one is waited for, as a request GitHub keeps is not a drop).
        """
        return self.copilot_dropped or (self.copilot_asked and self.copilot_ask_settled and not self.copilot_requested)

    @property
    def reviewer_on_head(self):
        return bool(self.head_reviewer)

    @property
    def loop_exhausted(self):
        """The review loop is exhausted: MAX_CLAUDE_ROUNDS dirty rounds in a row.

        PR Auto-Merge then documents the loop in a comment and merges the PR
        without a review of the head and with threads open. Only a repo whose
        workflow merges has one, and a loop whose comments or label events
        couldn't be read is never called exhausted.
        """
        return self.merged_by_workflow and not self.loop_unread and trailing_dirty(self.rounds) >= MAX_CLAUDE_ROUNDS


@dataclass(frozen=True)
class Decision:
    action: str  # one of ACTIONS
    reason: str


def copilot_reviews(reviews):
    """The commit oids reviewed by Copilot, from (author login, commit oid, body) triples."""
    return frozenset(oid for login, oid, body in reviews
                     if login and oid and COPILOT.search(login) and not COPILOT_NO_REVIEW.match(body or ""))


def copilot_declined(reviews):
    """The commit oids Copilot answered with its quota note, from (author login, commit oid, body) triples.

    Copilot was asked about these heads and can't review them, so asking again
    only brings another note: decide() calls in Claude instead.
    """
    return frozenset(oid for login, oid, body in reviews
                     if login and oid and COPILOT.search(login) and COPILOT_NO_REVIEW.match(body or ""))


def copilot_ask(comments, owner, now):
    """(asked, settled): whether the PR carries the record that Copilot was asked, and whether it has settled.

    comments are (author login, body, created_at ISO-8601) triples, oldest first,
    or None when they couldn't be read, which counts as asked but not settled:
    nothing asks, and nothing is called dropped, on a record nobody can see.
    Only github-actions (PR Auto-Merge) or the repository owner (land.py) can
    write the record: anyone can comment the marker. The first record decides;
    it settles COPILOT_ASK_SETTLE_SECONDS after it was written, and one with an
    unreadable time never settles. now is epoch seconds.
    """
    if comments is None:
        return True, False
    for login, body, created_at in comments:
        who = (login or "").removesuffix("[bot]")
        if COPILOT_ASKED_MARKER not in (body or "") or not who or who not in (GITHUB_ACTIONS, owner):
            continue
        try:
            written = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
        except (AttributeError, ValueError):
            return True, False
        return True, now - written >= COPILOT_ASK_SETTLE_SECONDS
    return False, False


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
    exhausted = pr.loop_exhausted
    if not pr.reviewer_on_head and not exhausted:
        return review_needed(pr, checks)
    # An exhausted loop is documented in a comment and merges with its threads
    # and off-diff findings open: neither holds it (mpaulosky/dotfiles#375).
    if not exhausted:
        if pr.open_threads:
            return Decision(WAIT, f"{pr.open_threads} open thread(s)")
        if pr.head in pr.claude_off_diff:
            return Decision(WAIT, f"Claude's review of {pr.head[:7]} has findings outside the diff")
    if checks.running and not pr.checks_required:
        return Decision(WAIT, "no required checks; waiting for: " + ", ".join(checks.running))
    if exhausted:
        reviewed = (f"review loop exhausted ({MAX_CLAUDE_ROUNDS} rounds with findings in a row), ready to merge, "
                    f"{pr.open_threads} thread(s) left open")
    else:
        reviewed = f"{pr.head_reviewer.capitalize()} reviewed the head, no open threads"
    reason = reviewed + ("" if checks.green else ", required checks running")
    if pr.merged_by_workflow:
        return Decision(HAND_OFF, reason)
    return Decision(ARM_AUTO_MERGE, reason)


def review_needed(pr, checks):
    """The decision for an open, current PR whose head no reviewer has reviewed."""
    waiting = f"no Copilot or Claude review of {pr.head[:7]} yet"
    # Copilot answered this head with its quota note, so its request (if it
    # still shows) brings no review: go on to Claude.
    declined = pr.head in pr.copilot_declined
    if pr.copilot_requested and not declined:
        return Decision(WAIT, waiting + "; Copilot is requested")
    # The label means Claude is on its way only until it has reviewed the head: a review
    # of a head Copilot neither declined nor dropped covers nothing, and none further is coming.
    if pr.claude_requested and pr.head not in pr.claude_reviewed:
        return Decision(WAIT, waiting + f"; {REVIEW_CLAUDE} is on")
    if not (declined or pr.copilot_gone):
        if pr.copilot_asked:
            return Decision(WAIT, waiting + "; Copilot was asked, waiting for the request to show")
        return Decision(REQUEST_COPILOT, waiting + "; Copilot not asked yet")
    # PR Auto-Merge documented an exhausted loop and nobody has added the label
    # since: automation never adds it then (mpaulosky/dotfiles#375).
    if pr.exhaustion_marker_newest:
        return Decision(WAIT, waiting + f"; the review loop was exhausted and documented, add {REVIEW_CLAUDE} to start a new loop")
    running = [name for name in checks.running if name not in CLAUDE_CHECKS]
    if running:
        return Decision(WAIT, waiting + "; waiting for checks before calling in Claude: " + ", ".join(running))
    # No checks yet (CI hasn't created them) isn't green.
    reported = [name for name in checks.passed + checks.running + checks.failed + checks.cancelled
                if name not in CLAUDE_CHECKS]
    if not reported:  # every listed repo has CI, dotfiles included
        return Decision(WAIT, waiting + "; no checks on the head yet, so Claude waits for CI")
    return Decision(REQUEST_CLAUDE, waiting + "; Copilot couldn't review (its request was dropped or its quota is used up), checks green")
