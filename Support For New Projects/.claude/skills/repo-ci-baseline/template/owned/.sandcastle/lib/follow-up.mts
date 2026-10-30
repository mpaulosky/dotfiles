// ---------------------------------------------------------------------------
// Follow-up sweep
//
// Nothing acted on a Sandcastle PR once it was open: it could fall behind
// main, miss its Copilot review, or close without merging while its issue
// stayed open. Each round, before intake, the host sweeps every open,
// non-draft, same-repo PR into main from a matching issue branch that it
// itself published (see isSandcastlePullRequest), and acts on the ones that
// need no agent: re-requesting a stale Copilot review, updating a branch
// that's only behind main, and handing an issue back when its latest PR
// closed without merging. A PR the repository owner handed off with the
// sandcastle:follow-up label is swept too, though Sandcastle didn't open it
// (see sweepSubject). A PR that needs more than that (DIRTY, a red
// check, an unresolved bot or owner thread the host hasn't answered) is
// logged here and returned as a PassTarget: the agent pass that fixes it
// lives in lib/follow-up-pass.mts.
// ---------------------------------------------------------------------------

import { discardClosedWork, isHandOffBranch, isIssueBranch, type BranchRefs } from "./branches.mts";
import {
  APPROVAL_LAPSED_MARKER,
  APPROVED_HEAD_MARKER,
  BUILDING_LABEL,
  COPILOT_REREQUEST_AFTER_MS,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_REPLY_MARKER,
  PR_MARKER,
  SESSION_REPLY_MARKER,
  isDefaultQueueScope,
  withoutOwnCheck,
} from "./config.mts";
import {
  addPullRequestLabel,
  closedPullRequests,
  commentOnPullRequest,
  handBack,
  hasLabel,
  isCopilot,
  issueComments,
  issueEvents,
  labelTimeline,
  mainMergeOf,
  openPullRequestsForSweep,
  pullRequestBodyEdits,
  pushAccess,
  repositoryOwnerLogin,
  requestCopilotReview,
  reviewThreadsOf,
  signedInHostLogin,
  timestamp,
  updatePullRequestBranch,
  type ClosedPullRequest,
  type ContentEdit,
  type IssueEvent,
  type PullRequestIdentity,
  type ReviewThread,
  type TimelineLabelEvent,
  type TimestampedComment,
  type MainMerge,
} from "./github.mts";
import { activeQueueScope, approval, labelOriginFixes, loadQueue, ownerCheck, type Approval, type IsOwner } from "./queue.mts";
import { outcomeReport, waitingPrReport, type OutcomeReport, type WaitingPrEntry, type WaitingPrReport } from "./report.mts";

// One check run or status on a PR's head commit, normalised from either
// GraphQL shape (CheckRun or StatusContext) by lib/github.mts#openPullRequestsForSweep.
// `workflow` is the name of the Actions workflow behind a check run; a status,
// or a check run another app made, has none.
export type CheckState = { name: string; completed: boolean; green: boolean; completedAt: string | null; workflow?: string };

// Re-exported so the sweep's callers keep importing it from here.
export { withoutOwnCheck };

// An open PR with everything the sweep decides from, normalised from one
// paginated GraphQL query (lib/github.mts#openPullRequestsForSweep).
export type SweepPullRequest = PullRequestIdentity & {
  id: string;
  title: string;
  headRefOid: string;
  isDraft: boolean;
  labels: string[];
  mergeStateStatus: string;
  // The logins GitHub still has pending a review request from.
  reviewRequests: string[];
  reviews: { author: string | null; commitOid: string | null }[];
  // byBot: whether the thread's first comment's author is a Bot. author: that
  // comment's login, for isOwner (null for a deleted account or no comment).
  threads: { resolved: boolean; byBot: boolean; author: string | null }[];
  checks: CheckState[];
  // review_requested timeline events naming Copilot, oldest first.
  copilotRequestedAt: string[];
  // Set when any nested list (reviews, threads, checks, ...) was truncated by
  // GraphQL's page size, so the sweep can't decide safely from partial data.
  truncated: boolean;
};

// Whether a login is Copilot's code-review account (see
// lib/github.mts#isCopilot, which openPullRequestsForSweep also reads with).
export { isCopilot };

const NEEDS_HUMAN = "sandcastle:needs-human";

// The PR-level counterpart of lib/queue.mts#ISSUE_LABEL_RULES: a PR's
// needs-human removal counts as a re-queue only when the repository owner
// made it. Nothing on a PR is trusted as an add.
const PR_LABEL_RULES = { trustAdds: [], trustRemovals: [NEEDS_HUMAN] } as const;

// The issue number a PR's head branch names, read from
// feature/{n}-..., fix/{n}-... or hotfix/{n}-..., but only when it's a branch
// name isIssueBranch (lib/branches.mts) actually accepts: a branch name
// reaches a shell elsewhere in the pipeline.
export function issueNumberOf(headRefName: string): number | undefined {
  const match = /^(?:feature|fix|hotfix)\/(\d+)-/.exec(headRefName);
  if (!match) return undefined;
  const number = Number(match[1]);
  return isIssueBranch(headRefName, number) ? number : undefined;
}

// Whether the host published `pr` itself: not a fork, into main, authored by
// the repository owner's own login (the account the host publishes with,
// never an organization's), carrying PR_MARKER, and on an issue
// branch. A collaborator's PR on a matching branch, or one of the host's own
// from before this marker existed, is never this.
export function isSandcastlePullRequest(pr: PullRequestIdentity, host: string): boolean {
  return (
    pr.isCrossRepository === false &&
    pr.baseRefName === "main" &&
    pr.author === host &&
    pr.body.includes(PR_MARKER) &&
    issueNumberOf(pr.headRefName) !== undefined
  );
}

// The first reason the sweep skips `pr`, checked in this order: a fork, not
// into main, not an issue branch, the issue isn't open and in scope, the
// issue is being built (`building`: a full run builds it and answers its PR
// itself, so a follow-up-only run beside it must not start a pass on the same
// branch), a draft, labelled sandcastle:needs-human, not the host's, no
// PR_MARKER, or truncated. Undefined when none applies, so the sweep decides
// from it.
export function sweepSkipReason(
  pr: SweepPullRequest,
  inScope: ReadonlySet<number>,
  host: string,
  building: ReadonlySet<number> = new Set(),
): string | undefined {
  if (pr.isCrossRepository !== false) return "it's from a fork";
  if (pr.baseRefName !== "main") return `it's into ${pr.baseRefName}, not main`;
  const issueNumber = issueNumberOf(pr.headRefName);
  if (issueNumber === undefined) return `${pr.headRefName} isn't an issue branch`;
  if (!inScope.has(issueNumber)) return `#${issueNumber} isn't an open Sandcastle issue`;
  if (building.has(issueNumber)) return `#${issueNumber} is labelled ${BUILDING_LABEL}, so a run is building it`;
  if (pr.isDraft) return "it's a draft";
  if (hasLabel(pr, NEEDS_HUMAN)) return `it's labelled ${NEEDS_HUMAN}`;
  if (pr.author !== host) return `${pr.author ?? "a deleted account"} opened it, not ${host}`;
  if (!pr.body.includes(PR_MARKER)) return "its body doesn't carry the Sandcastle PR marker";
  if (pr.truncated) return "it has more reviews, threads or checks than one read holds";
  return undefined;
}

// What a caller can switch off in sweepPullRequests. handBackClosed (default true): hand back an issue
// whose latest PR closed without merging. A follow-up-only run turns it off.
export type SweepOptions = { handBackClosed?: boolean };

// Why a pull request is swept: it is a Sandcastle issue's PR, or the repository owner handed it off with the
// sandcastle:follow-up label.
export type SweepSubject = { kind: "issue"; issueNumber: number } | { kind: "hand-off" };

// What the sweep decides whether `pr` is swept from, besides the pull request itself: the issues in this run's scope,
// the host's login, the issues labelled sandcastle:building, and whether this run follows hand-off pull requests (only
// the default queue scope does).
export type SweepContext = {
  inScope: ReadonlySet<number>;
  host: string;
  building: ReadonlySet<number>;
  followsHandOffs: boolean;
};

// Whether `pr` is swept, and why, or why it isn't (the reason for the log). Implements the checks of sweepSkipReason for
// a Sandcastle issue's PR, then, for a PR that is not one and carries the owner's sandcastle:follow-up label, the
// hand-off rules. `handOffApproval` is read only when everything else lets the PR through.
export function sweepSubject(
  pr: SweepPullRequest,
  context: SweepContext,
  handOffApproval: () => Approval,
): { subject: SweepSubject } | { skip: string } {
  const { inScope, host, building, followsHandOffs } = context;
  const reason = sweepSkipReason(pr, inScope, host, building);
  if (reason === undefined) {
    // sweepSkipReason let it through, so it is an issue branch.
    return { subject: { kind: "issue", issueNumber: issueNumberOf(pr.headRefName) as number } };
  }
  // A Sandcastle PR that is a draft, needs a human, is being built, is truncated or is on an issue outside this run's scope
  // stays skipped: the label doesn't turn it into a hand-off.
  const issueNumber = issueNumberOf(pr.headRefName);
  const isSandcastles = issueNumber !== undefined && isSandcastlePullRequest(pr, host);
  if (isSandcastles || !hasLabel(pr, FOLLOW_UP_LABEL)) return { skip: reason };

  if (pr.isCrossRepository !== false) return { skip: "it's from a fork" };
  if (pr.baseRefName !== "main") return { skip: `it's into ${pr.baseRefName}, not main` };
  if (!followsHandOffs) {
    return { skip: `it carries ${FOLLOW_UP_LABEL}, which only a run with the default queue scope follows` };
  }
  if (!isHandOffBranch(pr.headRefName)) return { skip: "its branch name isn't one scripts/check-branch-name.sh accepts" };
  if (issueNumber !== undefined && building.has(issueNumber)) {
    return { skip: `#${issueNumber} is labelled ${BUILDING_LABEL}, so a run is building it` };
  }
  if (hasLabel(pr, BUILDING_LABEL)) return { skip: `it's labelled ${BUILDING_LABEL}, so a run is passing on it` };
  if (pr.isDraft) return { skip: "it's a draft" };
  if (hasLabel(pr, NEEDS_HUMAN)) return { skip: `it's labelled ${NEEDS_HUMAN}` };
  if (pr.truncated) return { skip: "it has more reviews, threads or checks than one read holds" };
  const approved = handOffApproval();
  if (!approved.approved) return { skip: `its ${FOLLOW_UP_LABEL} label doesn't count: ${approved.reason}` };
  return { subject: { kind: "hand-off" } };
}

// Whether `login` is `other`: GitHub logins are case-insensitive.
const sameLogin = (login: string | null, other: string) => login !== null && login.toLowerCase() === other.toLowerCase();

// The comment that records `head` as a head of a hand-off PR the owner approved, or reached from one through merges of main (see handOffApproval).
export function approvedHeadComment(head: string): string {
  return `${APPROVED_HEAD_MARKER} ${head} -->\nSandcastle follows this pull request up from ${head.slice(0, 7)}: the head the owner approved, or a merge of main made on top of it.`;
}

// The comment the sweep posts once on a hand-off PR skipped because `head` isn't one the host recorded as approved, so the owner sees why
// it is no longer followed up and what to do.
export function approvalLapsedComment(head: string): string {
  return (
    `${APPROVAL_LAPSED_MARKER} ${head} -->\n` +
    `Sandcastle no longer follows this pull request up: its head ${head.slice(0, 7)} isn't one the host recorded as approved since the owner added ${FOLLOW_UP_LABEL}, ` +
    `most likely because a commit was pushed after the label. Once the owner has looked at the branch, remove and re-add ${FOLLOW_UP_LABEL}.`
  );
}

// Whether `comments` hold the host's own approvalLapsedComment for `head`. Only the host's counts, since anyone can post the same text.
export function approvalLapsedPosted(comments: readonly TimestampedComment[], head: string, host: string): boolean {
  return comments.some((comment) => sameLogin(comment.author, host) && comment.body.startsWith(`${APPROVAL_LAPSED_MARKER} ${head} -->`));
}

// The head a comment records as approved, or undefined when it doesn't open with the marker.
export function approvedHeadOf(body: string): string | undefined {
  return new RegExp(`^${APPROVED_HEAD_MARKER} ([0-9a-f]{40}) -->`).exec(body)?.[1];
}

// Records `head` as a head of PR `number` the owner approved, as the host: handOffApproval trusts the comment because of who posted it.
export function recordApprovedHead(number: number, head: string, post: (number: number, body: string) => void = commentOnPullRequest): void {
  post(number, approvedHeadComment(head));
}

// How many merges of main handOffApproval looks through from a head to reach a recorded one. More than this is not followed up. It only
// binds when that many merges come between two records, since a head reached through merges is recorded as it is found (a sweep that
// skips the PR, or a record that fails to post, leaves the count growing).
export const MAX_MAIN_MERGES = 5;

// A refused approval whose label counts and whose only fault is a head the host never recorded: `unrecordedHead` is that head, and the
// sweep comments on the PR for it once (approvalLapsedComment). Any other refusal carries no such head, so nothing is posted for it.
// `labelledAt` is when the owner's label was added (ms since the epoch), so the sweep can wait out the window in which the record isn't posted yet.
export type LapsedApproval = { approved: false; reason: string; unrecordedHead: string; labelledAt: number };

// How long after the owner's label the sweep waits before it comments that the approval lapsed. The Sandcastle workflow's record-head job
// posts the head's record some time after the label (its own queueing, up to three post retries), and a head not yet recorded in that window
// is not a lapse: a notice then would tell the owner to re-add a label that is working, and would stay on the PR.
export const APPROVAL_LAPSED_GRACE_MS = 15 * 60 * 1000;

// Whether the owner's sandcastle:follow-up label stands on `pr`: the repository's owner or the host opened it, the latest
// labeled event is the owner's with no later edit of the title or description by anyone else (lib/queue.mts#approval),
// and the head is one the owner approved: recorded by the Sandcastle workflow or the host, or reached from such a head
// through at most MAX_MAIN_MERGES merges of main that GitHub made for the host (lib/github.mts#mainMergeOf; the sweep
// records the head it reached). The model, and why each check is there, is in references/sandcastle.md#hand-off-prs.
export function handOffApproval(
  pr: Pick<SweepPullRequest, "number" | "author" | "headRefOid">,
  github: Pick<FollowUpGitHub, "pullRequestEvents" | "pullRequestBodyEdits" | "pullRequestComments" | "mergeOfMain" | "recordApprovedHead" | "isOwner" | "repositoryOwner">,
  host: string,
): Approval | LapsedApproval {
  if (!sameLogin(pr.author, host) && !sameLogin(pr.author, github.repositoryOwner())) {
    return { approved: false, reason: `${pr.author ?? "a deleted account"} opened it, and is neither the repository's owner nor ${host}` };
  }
  const events = github.pullRequestEvents(pr.number);
  const labelled = approval(FOLLOW_UP_LABEL, events, github.pullRequestBodyEdits(pr.number), github.isOwner);
  if (!labelled.approved) return labelled;
  // The latest by time, as approval() picks it. A time that doesn't parse makes this NaN, which no comment is at or after.
  const since = Math.max(
    ...events.filter((event) => event.event === "labeled" && event.label?.toLowerCase() === FOLLOW_UP_LABEL.toLowerCase()).map((event) => Date.parse(event.createdAt)),
  );
  const recorded = new Set(
    github
      .pullRequestComments(pr.number)
      .filter((comment) => sameLogin(comment.author, host) && Date.parse(comment.createdAt) >= since && comment.updatedAt === comment.createdAt)
      .map((comment) => approvedHeadOf(comment.body)),
  );
  let head = pr.headRefOid.toLowerCase();
  let problem = "";
  for (let merges = 0; merges <= MAX_MAIN_MERGES; merges++) {
    if (recorded.has(head)) {
      // The head was reached through merges of main: record the one the PR has now, so the next walk starts there and the cap
      // counts merges since the last posted record rather than since the label. The sweep's recordApprovedHead logs a failed post
      // and doesn't throw: the approval stands either way, and the next sweep walks the same merges and tries again.
      if (merges > 0) github.recordApprovedHead(pr.number, pr.headRefOid.toLowerCase());
      return labelled;
    }
    if (merges === MAX_MAIN_MERGES) {
      problem = `more than ${MAX_MAIN_MERGES} merges of main on top of the last recorded head`;
      break;
    }
    const merge: MainMerge = github.mergeOfMain(head);
    if ("problem" in merge) {
      problem = merge.problem;
      break;
    }
    head = merge.firstParent.toLowerCase();
  }
  return {
    approved: false,
    unrecordedHead: pr.headRefOid.toLowerCase(),
    labelledAt: since,
    reason:
      `its head ${pr.headRefOid.slice(0, 7)} isn't one ${host} recorded as approved since the owner added the label${problem === "" ? "" : ` (${problem})`}: ` +
      `possible causes: a commit pushed after the label, the record edited after it was posted, more than ${MAX_MAIN_MERGES} merges of main since the last record, ` +
      `or the record not posted yet (the next sweep may find it). Once the owner has looked at the branch, remove and re-add ${FOLLOW_UP_LABEL}`,
  };
}

// What the sweep does about one PR, decided by `decide`.
export type SweepDecision =
  | { action: "wait"; reason: string }
  | { action: "request-review" }
  | { action: "update-branch" }
  | { action: "needs-pass"; reasons: string[] }
  | { action: "leave"; reason: string };

// What the sweep does about a PR that isn't skipped (see sweepSkipReason):
// flag one with conflicts for a later pass at once, wait while CI is still
// running, flag one with a red check or an unresolved bot or confirmed-owner
// thread (the same threads the follow-up role answers via threadsForRole, so
// a pass actually runs for an owner thread rather than leaving it stranded),
// wait while Copilot's review is in flight, ask Copilot again once CI
// has been done for a while with no review or pending request, update a
// settled PR that's only behind main, or leave a clean or merge-blocked one
// alone. Sandcastle's own check run counts for none of these
// (withoutOwnCheck). `isOwner` defaults to never-owner so a caller that
// doesn't pass it (most tests) sees every non-bot thread as a human's, as
// before this parameter existed. `pr.threads` is the sweep's view, without
// the threads the host has already answered (threadStanding), so a PR
// waiting on the owner's reply moves on to the Copilot and update-branch
// branches instead of being flagged every round.
export function decide(pr: SweepPullRequest, now: number, isOwner: IsOwner = () => false): SweepDecision {
  const checks = withoutOwnCheck(pr.checks);
  // GitHub runs no pull_request workflows on a PR it can't merge, so a head
  // pushed while it conflicts gets no checks: waiting on them would hide the
  // conflict for good.
  if (pr.mergeStateStatus === "DIRTY") {
    const red = checks.filter((check) => check.completed && !check.green).map((check) => `check ${check.name} is red`);
    return { action: "needs-pass", reasons: ["it has merge conflicts", ...red] };
  }
  if (checks.length === 0) return { action: "wait", reason: "no checks have reported" };
  if (checks.some((check) => !check.completed)) return { action: "wait", reason: "checks are still running" };

  // Red checks and bot/owner threads don't depend on Copilot reviewing this
  // head, so they're flagged before waiting on it: GitHub can drop the one
  // re-request (Copilot's review budget, ADR 0004), and every update-branch
  // makes a head Copilot hasn't seen, so waiting would hide them for good.
  const reasons = checks.filter((check) => !check.green).map((check) => `check ${check.name} is red`);
  const botThreads = pr.threads.filter((thread) => !thread.resolved && thread.byBot).length;
  if (botThreads > 0) reasons.push(`${botThreads} unresolved bot thread(s)`);
  // A thread the repository owner opened is the follow-up role's to answer
  // (threadsForRole), not left waiting on a person forever: without this, a
  // settled PR whose only open thread is the owner's never needs a pass, so
  // nothing ever answers it (a follow-up review).
  const ownerThreads = pr.threads.filter((thread) => !thread.resolved && !thread.byBot && isOwner(thread.author) === true).length;
  if (ownerThreads > 0) reasons.push(`${ownerThreads} unresolved owner thread(s)`);
  if (reasons.length > 0) return { action: "needs-pass", reasons };

  // A completed check with no time can't say when CI finished, so it leaves
  // ciDoneAt NaN and the PR is never re-requested on a guess.
  const doneAt = checks.map((check) => (check.completedAt === null ? NaN : timestamp(check.completedAt)));
  const ciDoneAt = Math.max(...doneAt);
  const reviewed = pr.reviews.some((review) => isCopilot(review.author) && review.commitOid === pr.headRefOid);
  if (pr.reviewRequests.some(isCopilot)) return { action: "wait", reason: "Copilot's review is pending" };

  if (!reviewed) {
    // A request recorded after the head's first check completed means this
    // head was already asked about, whether or not GitHub kept the request:
    // that's what makes it once per head, and why the log then says a person
    // has to step in. The first completion, not the last, because a rerun
    // job or a label's review check can complete after the request on the
    // same head; the request GitHub makes when the PR opens comes before any.
    const firstDoneAt = Math.min(...doneAt);
    const askedSince = pr.copilotRequestedAt.some((requestedAt) => timestamp(requestedAt) >= firstDoneAt);
    if (askedSince) {
      return { action: "wait", reason: "Copilot hasn't reviewed the head since the one re-request, so a person needs to ask it" };
    }
    if (now - ciDoneAt > COPILOT_REREQUEST_AFTER_MS) return { action: "request-review" };
    return { action: "wait", reason: "Copilot hasn't reviewed the head yet" };
  }

  if (pr.mergeStateStatus === "BEHIND") return { action: "update-branch" };
  return { action: "leave", reason: `it's settled and ${pr.mergeStateStatus}` };
}

// The issue's latest Sandcastle PR among `prs` (the highest number among
// those isSandcastlePullRequest accepts on one of the issue's branches),
// returned only when it closed without merging (state "CLOSED"). Undefined
// when the latest such PR merged, or none exists.
export function closedWithoutMerging(
  prs: readonly ClosedPullRequest[],
  issueNumber: number,
  host: string,
): ClosedPullRequest | undefined {
  const latest = prs
    .filter((pr) => isSandcastlePullRequest(pr, host) && isIssueBranch(pr.headRefName, issueNumber))
    .reduce<ClosedPullRequest | undefined>((newest, pr) => (newest === undefined || pr.number > newest.number ? pr : newest), undefined);
  return latest?.state === "CLOSED" ? latest : undefined;
}

// The hand-back comment for an issue whose latest PR closed without merging.
// Its first sentence is the issue's own wording, word for word (see the
// "Closed without merging" acceptance criterion).
export function closedPrHandBackComment(pr: ClosedPullRequest): string {
  return (
    `PR #${pr.number} was closed without merging; remove the label to rebuild. ` +
    `Its branch \`${pr.headRefName}\` is deleted when the issue is next built, so the rebuild starts from \`main\`.`
  );
}

// Whether a person removed sandcastle:needs-human after `pr` closed, which
// is how they re-queue an issue the closed PR handed back, agreeing to
// rebuild it from main.
function requeuedSince(pr: ClosedPullRequest, timeline: readonly TimelineLabelEvent[]): boolean {
  const requeuedAt = Math.max(
    -Infinity,
    ...timeline
      .filter((event) => event.event === "unlabeled" && event.label.toLowerCase() === NEEDS_HUMAN)
      .map((event) => timestamp(event.createdAt)),
  );
  return timestamp(pr.closedAt) <= requeuedAt;
}

function closedPrReason(pr: ClosedPullRequest): string {
  return `PR #${pr.number} was closed without merging`;
}

// What the follow-up sweep needs from GitHub; tests pass a stub.
export type FollowUpGitHub = {
  hostLogin(): string;
  openPullRequests(): SweepPullRequest[];
  closedPullRequests(author: string): ClosedPullRequest[];
  // live: lib/queue.mts#loadQueue(), so the sweep sees only this run's
  // scope, approved by the owner.
  inScopeIssues(): { number: number; labels: string[] }[];
  labelTimeline(issueNumber: number): TimelineLabelEvent[];
  requestCopilotReview(pullRequestId: string): void;
  updateBranch(number: number, expectedHeadSha: string): void;
  // live: handBack({ kind: "issue", number: issueNumber }, NEEDS_HUMAN, reason, body).
  handBack(issueNumber: number, reason: string, body: string): void;
  // Tri-state owner check for a PR's label origin (lib/queue.mts#labelOriginFixes). live: pushAccess(login).
  isOwner: IsOwner;
  // The PR's labeled/unlabeled/renamed events, for labelOriginFixes. live:
  // issueEvents(number) (PRs share the issue events endpoint).
  pullRequestEvents(number: number): IssueEvent[];
  // Puts back a PR's hand-back label someone else removed. live: gh pr edit.
  addPullRequestLabel(number: number, label: string): void;
  // A PR's review threads in full, comments included, so the sweep can tell a
  // thread the host has answered from one it hasn't.
  reviewThreads(number: number): ReviewThread[];
  // Every edit to a PR's description, for the approval of a hand-off PR's label. live: pullRequestBodyEdits.
  pullRequestBodyEdits(number: number): ContentEdit[];
  // Whether this run follows hand-off PRs: only one with the default queue scope does. live:
  // isDefaultQueueScope(activeQueueScope()).
  followsHandOffs(): boolean;
  // The login of the account the repository belongs to, whom a hand-off PR's author must be (or the host). live:
  // repositoryOwnerLogin().
  repositoryOwner(): string;
  // Every comment on a PR, with when it was posted and last edited, for the heads the host recorded as approved. live: issueComments.
  pullRequestComments(number: number): TimestampedComment[];
  // Whether `commit` is a merge of main GitHub made for the host, and its first parent if so. live: mainMergeOf.
  mergeOfMain(commit: string): MainMerge;
  // Records a head that handOffApproval verified through merges of main, as the host. live: recordApprovedHead.
  recordApprovedHead(number: number, head: string): void;
  // Posts a comment on a PR, as the host. live: commentOnPullRequest.
  commentOnPullRequest(number: number, body: string): void;
};

// mainMergeOf for the signed-in host: the merge must be authored by that login. `host` and `merge` are injectable for the test.
export function liveMergeOfMain(commit: string, host: () => string = signedInHostLogin, merge: typeof mainMergeOf = mainMergeOf): MainMerge {
  return merge(commit, host());
}

export const liveFollowUpGitHub: FollowUpGitHub = {
  hostLogin: () => signedInHostLogin(),
  openPullRequests: () => openPullRequestsForSweep(),
  closedPullRequests: (author) => closedPullRequests(author),
  inScopeIssues: () => loadQueue().map((issue) => ({ number: issue.number, labels: issue.labels })),
  labelTimeline: (issueNumber) => labelTimeline(issueNumber),
  requestCopilotReview: (pullRequestId) => requestCopilotReview(pullRequestId),
  updateBranch: (number, expectedHeadSha) => updatePullRequestBranch(number, expectedHeadSha),
  handBack: (issueNumber, reason, body) => handBack({ kind: "issue", number: issueNumber }, NEEDS_HUMAN, reason, body),
  isOwner: ownerCheck(() => signedInHostLogin(), (login) => pushAccess(login)),
  pullRequestEvents: (number) => issueEvents(number),
  addPullRequestLabel: (number, label) => addPullRequestLabel(number, label),
  // The head that comes with the threads is ignored: they don't depend on
  // it, and the pass checks the head itself.
  reviewThreads: (number) => reviewThreadsOf(number).threads,
  pullRequestBodyEdits: (number) => pullRequestBodyEdits(number),
  followsHandOffs: () => isDefaultQueueScope(activeQueueScope()),
  repositoryOwner: () => repositoryOwnerLogin(),
  pullRequestComments: (number) => issueComments(number),
  mergeOfMain: (commit) => liveMergeOfMain(commit),
  recordApprovedHead: (number, head) => recordApprovedHead(number, head),
  commentOnPullRequest: (number, body) => commentOnPullRequest(number, body),
};

// How a review thread stands with the follow-up pass (threadStanding): the
// one rule the sweep and the pass share to decide whether a thread starts a
// pass, so the sweep never flags a PR for a thread the pass won't take up.
export type ThreadStanding = "resolved" | "answered" | "bot" | "owner" | "human" | "unknown";

// How `thread` stands, checked in this order. A resolved thread is
// "resolved". A thread whose first comment's author is a bot is "bot",
// unless the last comment by a bot, the owner or `hostLogin` is the host's
// own reply (by `hostLogin`, opening with FOLLOW_UP_REPLY_MARKER, or a Claude Code
// session's, which carries SESSION_REPLY_MARKER anywhere in its body, posted by
// `hostLogin` or by a login `isOwner` confirms: a session posts under the owner's
// token, which need not be the host's): then it's
// "answered", open again only because resolving it failed (the pass summary
// says so) or the owner unresolved it, and either way a person's now, not the
// role's to answer twice. A thread the repository owner opened is "owner",
// or "answered" when the last comment by the owner or the host is the host's
// reply, so the host waits on the owner rather than answering again; so is a
// thread a session opened itself. Comments
// by anyone else don't count either way, so a stranger can neither hide an
// owner thread by quoting the marker nor reopen one by replying after the
// host. Any other thread, including one with no author at all, is "human",
// and one whose first author `isOwner` can't answer for is "unknown", so
// nothing decides from partial information.
export function threadStanding(
  thread: Pick<ReviewThread, "resolved" | "comments">,
  isOwner: IsOwner,
  hostLogin: string,
): ThreadStanding {
  if (thread.resolved) return "resolved";
  // The host's own reply, or a session's: the owner's token is the owner's login, which needn't be the host's.
  // The marker counts anywhere in the body, by design: a host or owner comment that quotes it is taken for a session's
  // reply too. That is the trade for a rule that needs no parsing of the body.
  const hostReply = (comment: ReviewThread["comments"][number] | undefined) =>
    comment !== undefined &&
    ((comment.author === hostLogin && comment.body.startsWith(FOLLOW_UP_REPLY_MARKER)) ||
      (comment.body.includes(SESSION_REPLY_MARKER) && (comment.author === hostLogin || isOwner(comment.author) === true)));
  const first = thread.comments[0];
  if (first?.byBot === true) {
    const last = thread.comments.findLast(
      (comment) => comment.byBot || comment.author === hostLogin || isOwner(comment.author) === true,
    );
    return hostReply(last) ? "answered" : "bot";
  }
  const owner = first === undefined ? false : isOwner(first.author);
  if (owner === undefined) return "unknown";
  if (!owner) return "human";
  const last = thread.comments.findLast((comment) => comment.author === hostLogin || isOwner(comment.author) === true);
  return hostReply(last) ? "answered" : "owner";
}

// `pr` as `decide` should see it: without the threads the host has already
// answered (threadStanding), which the sweep's batch query can't tell apart
// since it reads only each thread's first comment. Also counts them,
// since a PR blocked on them waits on the owner and the run report says so.
// Only a PR with an unresolved bot or owner thread costs a read of its threads
// in full, whatever `decide` would say of it unfiltered: a PR whose checks are
// still running (as after its own update from main) has to show as waiting on
// the owner too, so the count can't depend on the decision. A DIRTY PR is
// read the same way, for the count only: `decide` flags it whatever its
// threads are, so a failed read there leaves it flagged with nothing counted.
// For any other PR a failed read throws, and the sweep leaves it alone this
// round, still listing it as waiting on its people's threads.
export function withoutAnsweredThreads(
  pr: SweepPullRequest,
  github: Pick<FollowUpGitHub, "isOwner" | "reviewThreads">,
  host: string,
): { pr: SweepPullRequest; answered: number } {
  const mayFlag = pr.threads.some((thread) => !thread.resolved && (thread.byBot || github.isOwner(thread.author) === true));
  if (!mayFlag) {
    return { pr, answered: 0 };
  }
  let full: ReviewThread[];
  try {
    full = github.reviewThreads(pr.number);
  } catch (error) {
    if (pr.mergeStateStatus === "DIRTY") return { pr, answered: 0 };
    throw error;
  }
  const open = full.filter((thread) => threadStanding(thread, github.isOwner, host) !== "answered");
  const threads = open.map((thread) => ({
    resolved: thread.resolved,
    byBot: thread.comments[0]?.byBot === true,
    author: thread.comments[0]?.author ?? null,
  }));
  return { pr: { ...pr, threads }, answered: full.length - open.length };
}

// What the sweep decides each PR from, read once per sweep: the SweepContext, and the in-scope issues it came from.
export function sweepContext(
  github: Pick<FollowUpGitHub, "hostLogin" | "inScopeIssues" | "followsHandOffs">,
): { context: SweepContext; issues: { number: number; labels: string[] }[] } {
  const host = github.hostLogin();
  const issues = github.inScopeIssues();
  const inScope = new Set(issues.map((issue) => issue.number));
  const building = new Set(issues.filter((issue) => hasLabel(issue, BUILDING_LABEL)).map((issue) => issue.number));
  return { context: { inScope, host, building, followsHandOffs: github.followsHandOffs() }, issues };
}

// Tells the owner on PR `number` that its follow-up approval lapsed for `head`, once per head: the host's earlier comment for that head,
// read back from the PR, stops a repeat. Nothing is posted until the owner's label (added at `labelledAt`) is APPROVAL_LAPSED_GRACE_MS
// old, since the head may only be waiting for its record; the next sweep looks again. A failed read or post is logged and swallowed, so
// the sweep goes on to the other PRs and the next sweep tries again.
function commentApprovalLapsed(
  number: number,
  head: string,
  labelledAt: number,
  now: number,
  github: Pick<FollowUpGitHub, "pullRequestComments" | "commentOnPullRequest">,
  host: string,
  log: (line: string) => void,
): void {
  // A label time that doesn't parse (NaN) is not known to be old enough.
  if (!(now - labelledAt >= APPROVAL_LAPSED_GRACE_MS)) return;
  try {
    if (approvalLapsedPosted(github.pullRequestComments(number), head, host)) return;
    github.commentOnPullRequest(number, approvalLapsedComment(head));
    log(`  ✉ Commented on PR #${number} that its head ${head.slice(0, 7)} isn't one ${host} recorded as approved.`);
  } catch (error) {
    log(`  ⚠ Couldn't comment on PR #${number} that its head ${head.slice(0, 7)} isn't approved, so the next sweep tries again: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// What admitToSweep reads of GitHub besides the PR's events.
export type AdmissionGitHub = Pick<
  FollowUpGitHub,
  "pullRequestBodyEdits" | "pullRequestComments" | "mergeOfMain" | "recordApprovedHead" | "isOwner" | "repositoryOwner"
>;

// Whether the sweep admits `pr`, and why not: sweepSubject with the hand-off approval wired to `github`. `events` is the
// caller's memoised read of the PR's events, so the approval and the label-origin check share one read. A failed
// recordApprovedHead is logged and swallowed: the approval stands, and the next sweep walks the same merges again.
// `onUnrecordedHead` is told the head, and when the label was added, when the owner's label counts but the head isn't one the host recorded: the sweep comments on
// the PR then. It is a callback so that admitToSweep itself never writes, and the status report that shares it stays read-only.
export function admitToSweep(
  pr: SweepPullRequest,
  context: SweepContext,
  github: AdmissionGitHub,
  events: () => IssueEvent[],
  log: (line: string) => void,
  onUnrecordedHead: (head: string, labelledAt: number) => void = () => {},
): { subject: SweepSubject } | { skip: string } {
  return sweepSubject(pr, context, () => {
    const approval = handOffApproval(pr, {
      pullRequestEvents: events,
      pullRequestBodyEdits: (number) => github.pullRequestBodyEdits(number),
      pullRequestComments: (number) => github.pullRequestComments(number),
      mergeOfMain: (commit) => github.mergeOfMain(commit),
      recordApprovedHead: (number, head) => {
        try {
          github.recordApprovedHead(number, head);
        } catch (error) {
          log(`  ⚠ Couldn't record PR #${number}'s head ${head.slice(0, 7)}, so the next sweep walks the same merges again: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      isOwner: github.isOwner,
      repositoryOwner: () => github.repositoryOwner(),
    }, context.host);
    if (!approval.approved && "unrecordedHead" in approval) onUnrecordedHead(approval.unrecordedHead, approval.labelledAt);
    return approval;
  });
}

// What to do about a stranger's change of the PR's hand-back label.
export type LabelOriginHold = { kind: "unknown" } | { kind: "restore"; label: string; reason: string };

// The label-origin step of the sweep, without the write: a stranger's removal of the PR's hand-back label isn't a
// re-queue. Undefined when nothing holds the PR; an unknown check comes before a restore.
export function labelOriginHold(
  pr: Pick<SweepPullRequest, "labels">,
  events: readonly IssueEvent[],
  isOwner: IsOwner,
): LabelOriginHold | undefined {
  const origin = labelOriginFixes(pr.labels, events, isOwner, PR_LABEL_RULES);
  if (origin.unknown.length > 0) return { kind: "unknown" };
  const restore = origin.fixes.find((fix) => fix.action === "restore");
  return restore === undefined ? undefined : { kind: "restore", label: restore.label, reason: restore.reason };
}

// What the sweep found that needs an agent: the numbers of the PRs it logged
// as needing a follow-up pass (the early exit reads this, so a round with
// one of these still has work), and those same PRs as PassTargets for
// lib/follow-up-pass.mts#followUpPassPhase to run a pass on. A failed sweep
// (see followUpPhase) returns both empty, never treated as work found.
export type SweepResult = { needsPass: number[]; passes: PassTarget[] };

// Reads the host's login, the in-scope issues and the open PRs once, then
// for each PR either skips it (sweepSubject: sweepSkipReason for an issue's PR, the hand-off rules for another) or applies `decide`, logging
// what happened. A PR with an unresolved bot or owner thread has its threads
// read in full first, and the ones the host has answered are left out and
// counted for `waiting` (withoutAnsweredThreads). A PR whose
// sandcastle:needs-human someone other than the repository owner removed gets
// it back instead, and is left alone.
// Each PR runs in its own try/catch, so one failure doesn't stop the rest.
// An updated PR reaches `outcomes` as "updated", and every PR that reached
// `decide` with unresolved threads opened by someone other than the
// repository owner or a bot (the same test lib/follow-up-pass.mts#threadsForRole
// uses), or that is left alone because its threads couldn't be read in full
// while such a thread is open, replaces `waiting`'s list, so the run
// report shows the latest sweep's view. Once that's done, hands
// back any in-scope issue, not labelled sandcastle:needs-human and with no
// open PR, whose latest Sandcastle PR closed without merging
// (closedWithoutMerging), each in its own try/catch too, unless
// `options.handBackClosed` is false (a follow-up-only run, which leaves that
// to the full run beside it and doesn't even read the closed PRs). A PR whose
// issue (or, for a hand-off PR, the PR itself) is labelled sandcastle:building is skipped (sweepSubject).
export function sweepPullRequests(
  github: FollowUpGitHub = liveFollowUpGitHub,
  log: (line: string) => void = console.log,
  now: number = Date.now(),
  outcomes: OutcomeReport = outcomeReport,
  waiting: WaitingPrReport = waitingPrReport,
  options: SweepOptions = {},
): SweepResult {
  const { context, issues } = sweepContext(github);
  const { host } = context;
  const openPrs = github.openPullRequests();
  const needsPass: number[] = [];
  const passes: PassTarget[] = [];
  const waitingPrs: WaitingPrEntry[] = [];
  // Not a bot's and not confirmed as the repository owner's: an owner thread
  // is the follow-up role's to answer (threadsForRole, and now `decide`
  // below), not left waiting on a person the way this count and the run
  // report's "waiting on a person" section describe it.
  const countHumanThreads = (threads: SweepPullRequest["threads"]) =>
    threads.filter((thread) => !thread.resolved && !thread.byBot && github.isOwner(thread.author) !== true).length;

  for (const pr of openPrs) {
    try {
      // One read of the PR's events serves both the hand-off approval and the needs-human check below.
      let events: IssueEvent[] | undefined;
      const eventsOfPr = () => (events ??= github.pullRequestEvents(pr.number));
      let lapsed: { head: string; labelledAt: number } | undefined;
      const swept = admitToSweep(pr, context, github, eventsOfPr, log, (head, labelledAt) => {
        lapsed = { head, labelledAt };
      });
      if ("skip" in swept) {
        log(`  · PR #${pr.number} isn't swept: ${swept.skip}.`);
        if (lapsed !== undefined) commentApprovalLapsed(pr.number, lapsed.head, lapsed.labelledAt, now, github, host, log);
        continue;
      }
      const { subject } = swept;
      if (subject.kind === "hand-off") {
        log(`  ⤷ PR #${pr.number} is followed up as a hand-off: the owner labelled it ${FOLLOW_UP_LABEL}.`);
      }
      // A stranger's removal of the PR's hand-back label isn't a re-queue:
      // put the label back and leave the PR alone this round.
      const hold = labelOriginHold(pr, eventsOfPr(), github.isOwner);
      if (hold?.kind === "unknown") {
        log(`  · PR #${pr.number} isn't swept: couldn't check whether the repository owner removed ${NEEDS_HUMAN}.`);
        continue;
      }
      if (hold?.kind === "restore") {
        github.addPullRequestLabel(pr.number, hold.label);
        log(`  ✋ PR #${pr.number}: ${hold.reason}, so it isn't swept.`);
        continue;
      }
      let thinned: ReturnType<typeof withoutAnsweredThreads>;
      try {
        thinned = withoutAnsweredThreads(pr, github, host);
      } catch (error) {
        // The PR is left alone this round, but its people's threads still
        // wait on them, so it stays listed, counted from the sweep's own
        // threads.
        const waitingThreads = countHumanThreads(pr.threads);
        if (waitingThreads > 0) waitingPrs.push({ pr: pr.number, threads: waitingThreads, answered: 0 });
        throw error;
      }
      const { pr: thin, answered } = thinned;
      const waitingThreads = countHumanThreads(thin.threads);
      if (waitingThreads > 0 || answered > 0) waitingPrs.push({ pr: pr.number, threads: waitingThreads, answered });
      const decision = decide(thin, now, github.isOwner);
      followUp(thin, decision, github, log, outcomes);
      if (decision.action === "needs-pass") {
        needsPass.push(pr.number);
        passes.push(passTarget(thin, subject, decision.reasons));
      }
    } catch (error) {
      log(`  ⚠ Couldn't follow up PR #${pr.number}, so it's swept again next round: ${error}`);
    }
  }
  waiting.replace(waitingPrs);

  // Any same-repo open PR on an issue's branch, the host's or not, means the
  // issue isn't waiting on a closed one.
  const withOpenPr = new Set(
    openPrs.filter((pr) => pr.isCrossRepository === false).flatMap((pr) => issueNumberOf(pr.headRefName) ?? []),
  );
  if (options.handBackClosed === false) return { needsPass, passes };
  const candidates = issues.filter((issue) => !hasLabel(issue, NEEDS_HUMAN) && !withOpenPr.has(issue.number));
  if (candidates.length === 0) return { needsPass, passes };
  const closed = github.closedPullRequests(host);
  for (const issue of candidates) {
    try {
      const pr = closedWithoutMerging(closed, issue.number, host);
      if (pr === undefined) continue;
      // The same closed PR mustn't hand back an issue a person re-queued.
      if (requeuedSince(pr, github.labelTimeline(issue.number))) continue;
      github.handBack(issue.number, closedPrReason(pr), closedPrHandBackComment(pr));
      log(`  ✋ #${issue.number}: PR #${pr.number} was closed without merging, so the issue is handed back.`);
    } catch (error) {
      log(`  ⚠ Couldn't check whether #${issue.number}'s last PR closed without merging, so it's checked again next round: ${error}`);
    }
  }
  return { needsPass, passes };
}

// One PR the sweep marked as needing a follow-up pass, with what
// lib/follow-up-pass.mts#runPass needs to start one: tests pin this directly,
// since the sweep's full SweepPullRequest carries far more than a pass reads.
export type PassTarget = {
  number: number;
  id: string;
  headRefName: string;
  headRefOid: string;
  reasons: string[];
  // GitHub said the PR conflicts with main (DIRTY), so a pass merges main
  // in. A PR that's only behind isn't merged by a pass: the sweep updates it
  // on GitHub once it's settled.
  conflicted: boolean;
} & ({ issueNumber: number; handOff?: undefined } | { handOff: HandOffTarget; issueNumber?: undefined });

// A hand-off PR's own title and description, which stand in for an issue's in the pass's prompt.
export type HandOffTarget = { title: string; body: string };

// What lib/follow-up-pass.mts#runPass reads of a needs-pass PR: for an issue's PR the issue number, which its branch
// names (sweepSubject), and for a hand-off PR its own title and description.
function passTarget(pr: SweepPullRequest, subject: SweepSubject, reasons: string[]): PassTarget {
  const common = {
    number: pr.number,
    id: pr.id,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    reasons,
    conflicted: pr.mergeStateStatus === "DIRTY",
  };
  if (subject.kind === "hand-off") return { ...common, handOff: { title: pr.title, body: pr.body } };
  return { ...common, issueNumber: subject.issueNumber };
}

// Carries out one PR's decision and logs it, recording an updated branch in
// the run report once GitHub has accepted the update.
function followUp(
  pr: SweepPullRequest,
  decision: SweepDecision,
  github: FollowUpGitHub,
  log: (line: string) => void,
  outcomes: OutcomeReport,
): void {
  switch (decision.action) {
    case "request-review":
      github.requestCopilotReview(pr.id);
      log(`  ↻ PR #${pr.number}: asked Copilot again to review ${pr.headRefOid.slice(0, 7)}`);
      return;
    case "update-branch":
      github.updateBranch(pr.number, pr.headRefOid);
      outcomes.record({ kind: "pr", number: pr.number, outcome: "updated", detail: "was only behind main" });
      log(`  ⤴ PR #${pr.number} (${pr.headRefName}) was only behind main: updated it on GitHub`);
      return;
    case "needs-pass":
      log(`  ⚑ PR #${pr.number} needs a follow-up pass: ${decision.reasons.join("; ")}`);
      return;
    case "wait":
      log(`  ⏳ PR #${pr.number} waits: ${decision.reason}`);
      return;
    case "leave":
      log(`  ✓ PR #${pr.number} is left alone: ${decision.reason}`);
      return;
  }
}

// The follow-up sweep as main.mts runs it at the start of each round, before
// intake. A failure, such as GitHub's API being unavailable, is logged and
// the sweep runs again next round: it's housekeeping, never a reason to stop
// building. Returns { needsPass: [], passes: [] } for a failed sweep, so
// the early exit never treats a sweep failure as work found.
export function followUpPhase(
  sweep: () => SweepResult = () => sweepPullRequests(),
  warn: (message: string) => void = console.error,
): SweepResult {
  try {
    return sweep();
  } catch (error) {
    warn(`  ✗ Couldn't sweep the open pull requests, so they're swept again next round: ${error}`);
    return { needsPass: [], passes: [] };
  }
}

// Deletes the refs of `branch` that still hold the work of `issueNumber`'s
// latest Sandcastle PR, when that PR was closed without merging and a person
// has since re-queued the issue, so the build starts from main. Returns
// undefined when there's no such PR, or when its branch isn't the one being
// built (the build's branch never held that work). When nobody re-queued the
// issue since the PR closed (it closed after this round's sweep, or the
// sweep's hand-back failed), hands it back instead and throws, deleting
// nothing: the hand-back's comment is the only consent to discarding the
// work. Called from lib/build.mts#buildMarkedIssue, before createSandbox(),
// so a throw stops the build, uncounted, before any sandbox exists.
export function startFromMain(
  issueNumber: number,
  branch: string,
  base: string,
  github: Pick<FollowUpGitHub, "hostLogin" | "closedPullRequests" | "labelTimeline" | "handBack"> = liveFollowUpGitHub,
  refs?: BranchRefs,
): { pr: number; deleted: string[] } | undefined {
  const host = github.hostLogin();
  const pr = closedWithoutMerging(github.closedPullRequests(host), issueNumber, host);
  if (pr === undefined || pr.headRefName !== branch) return undefined;
  if (!requeuedSince(pr, github.labelTimeline(issueNumber))) {
    github.handBack(issueNumber, closedPrReason(pr), closedPrHandBackComment(pr));
    throw new Error(`${closedPrReason(pr)} and nobody has re-queued #${issueNumber} since, so it's handed back rather than rebuilt`);
  }
  return { pr: pr.number, deleted: discardClosedWork(branch, pr, base, refs) };
}
