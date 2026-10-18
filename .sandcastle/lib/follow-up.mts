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
// closed without merging. A PR that needs more than that (DIRTY, a red
// check, an unresolved bot or owner thread) is logged here and returned as a
// PassTarget: the agent pass that fixes it lives in lib/follow-up-pass.mts
// (#78).
// ---------------------------------------------------------------------------

import { discardClosedWork, isIssueBranch, type BranchRefs } from "./branches.mts";
import { COPILOT_REREQUEST_AFTER_MS, PR_MARKER } from "./config.mts";
import {
  addPullRequestLabel,
  closedPullRequests,
  handBack,
  hasLabel,
  isCopilot,
  issueEvents,
  labelTimeline,
  openPullRequestsForSweep,
  pushAccess,
  requestCopilotReview,
  signedInHostLogin,
  timestamp,
  updatePullRequestBranch,
  type ClosedPullRequest,
  type IssueEvent,
  type PullRequestIdentity,
  type TimelineLabelEvent,
} from "./github.mts";
import { labelOriginFixes, loadQueue, ownerCheck, type IsOwner } from "./queue.mts";
import { outcomeReport, waitingPrReport, type OutcomeReport, type WaitingPrEntry, type WaitingPrReport } from "./report.mts";

// One check run or status on a PR's head commit, normalised from either
// GraphQL shape (CheckRun or StatusContext) by lib/github.mts#openPullRequestsForSweep.
export type CheckState = { name: string; completed: boolean; green: boolean; completedAt: string | null };

// An open PR with everything the sweep decides from, normalised from one
// paginated GraphQL query (lib/github.mts#openPullRequestsForSweep).
export type SweepPullRequest = PullRequestIdentity & {
  id: string;
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
// made it (#146). Nothing on a PR is trusted as an add.
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
// never an organization's, see #214), carrying PR_MARKER, and on an issue
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
// into main, not an issue branch, the issue isn't open and in scope, a draft,
// labelled sandcastle:needs-human, not the host's, no PR_MARKER, or
// truncated. Undefined when none applies, so the sweep decides from it.
export function sweepSkipReason(pr: SweepPullRequest, inScope: ReadonlySet<number>, host: string): string | undefined {
  if (pr.isCrossRepository !== false) return "it's from a fork";
  if (pr.baseRefName !== "main") return `it's into ${pr.baseRefName}, not main`;
  const issueNumber = issueNumberOf(pr.headRefName);
  if (issueNumber === undefined) return `${pr.headRefName} isn't an issue branch`;
  if (!inScope.has(issueNumber)) return `#${issueNumber} isn't an open Sandcastle issue`;
  if (pr.isDraft) return "it's a draft";
  if (hasLabel(pr, NEEDS_HUMAN)) return `it's labelled ${NEEDS_HUMAN}`;
  if (pr.author !== host) return `${pr.author ?? "a deleted account"} opened it, not ${host}`;
  if (!pr.body.includes(PR_MARKER)) return "its body doesn't carry the Sandcastle PR marker";
  if (pr.truncated) return "it has more reviews, threads or checks than one read holds";
  return undefined;
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
// a pass actually runs for an owner thread rather than leaving it stranded,
// #81), wait while Copilot's review is in flight, ask Copilot again once CI
// has been done for a while with no review or pending request, update a
// settled PR that's only behind main, or leave a clean or merge-blocked one
// alone. `isOwner` defaults to never-owner so a caller that doesn't pass it
// (most tests) sees every non-bot thread as a human's, as before this
// parameter existed.
export function decide(pr: SweepPullRequest, now: number, isOwner: IsOwner = () => false): SweepDecision {
  // GitHub runs no pull_request workflows on a PR it can't merge, so a head
  // pushed while it conflicts gets no checks: waiting on them would hide the
  // conflict for good.
  if (pr.mergeStateStatus === "DIRTY") {
    const red = pr.checks.filter((check) => check.completed && !check.green).map((check) => `check ${check.name} is red`);
    return { action: "needs-pass", reasons: ["it has merge conflicts", ...red] };
  }
  if (pr.checks.length === 0) return { action: "wait", reason: "no checks have reported" };
  if (pr.checks.some((check) => !check.completed)) return { action: "wait", reason: "checks are still running" };

  // Red checks and bot/owner threads don't depend on Copilot reviewing this
  // head, so they're flagged before waiting on it: GitHub can drop the one
  // re-request (Copilot's review budget, ADR 0004), and every update-branch
  // makes a head Copilot hasn't seen, so waiting would hide them for good.
  const reasons = pr.checks.filter((check) => !check.green).map((check) => `check ${check.name} is red`);
  const botThreads = pr.threads.filter((thread) => !thread.resolved && thread.byBot).length;
  if (botThreads > 0) reasons.push(`${botThreads} unresolved bot thread(s)`);
  // A thread the repository owner opened is the follow-up role's to answer
  // (threadsForRole), not left waiting on a person forever: without this, a
  // settled PR whose only open thread is the owner's never needs a pass, so
  // nothing ever answers it (#81's follow-up review).
  const ownerThreads = pr.threads.filter((thread) => !thread.resolved && !thread.byBot && isOwner(thread.author) === true).length;
  if (ownerThreads > 0) reasons.push(`${ownerThreads} unresolved owner thread(s)`);
  if (reasons.length > 0) return { action: "needs-pass", reasons };

  // A completed check with no time can't say when CI finished, so it leaves
  // ciDoneAt NaN and the PR is never re-requested on a guess.
  const doneAt = pr.checks.map((check) => (check.completedAt === null ? NaN : timestamp(check.completedAt)));
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
  // scope, approved by the owner (#146).
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
};

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
};

// What the sweep found that needs an agent: the numbers of the PRs it logged
// as needing a follow-up pass (#147's early exit reads this, so a round with
// one of these still has work), and those same PRs as PassTargets for
// lib/follow-up-pass.mts#followUpPassPhase to run a pass on. A failed sweep
// (see followUpPhase) returns both empty, never treated as work found.
export type SweepResult = { needsPass: number[]; passes: PassTarget[] };

// Reads the host's login, the in-scope issues and the open PRs once, then
// for each PR either skips it (sweepSkipReason) or applies `decide`, logging
// what happened. A PR whose sandcastle:needs-human someone other than the
// repository owner removed gets it back instead, and is left alone (#146).
// Each PR runs in its own try/catch, so one failure doesn't stop the rest.
// An updated PR reaches `outcomes` as "updated", and every PR that reached
// `decide` with unresolved threads opened by someone other than the
// repository owner or a bot (the same test lib/follow-up-pass.mts#threadsForRole
// uses) replaces `waiting`'s list, so the run report shows the latest sweep's
// view. Once that's done, hands
// back any in-scope issue, not labelled sandcastle:needs-human and with no
// open PR, whose latest Sandcastle PR closed without merging
// (closedWithoutMerging), each in its own try/catch too.
export function sweepPullRequests(
  github: FollowUpGitHub = liveFollowUpGitHub,
  log: (line: string) => void = console.log,
  now: number = Date.now(),
  outcomes: OutcomeReport = outcomeReport,
  waiting: WaitingPrReport = waitingPrReport,
): SweepResult {
  const host = github.hostLogin();
  const issues = github.inScopeIssues();
  const inScope = new Set(issues.map((issue) => issue.number));
  const openPrs = github.openPullRequests();
  const needsPass: number[] = [];
  const passes: PassTarget[] = [];
  const waitingPrs: WaitingPrEntry[] = [];

  for (const pr of openPrs) {
    try {
      const skip = sweepSkipReason(pr, inScope, host);
      if (skip !== undefined) {
        log(`  · PR #${pr.number} isn't swept: ${skip}.`);
        continue;
      }
      // A stranger's removal of the PR's hand-back label isn't a re-queue
      // (#146): put the label back and leave the PR alone this round.
      const origin = labelOriginFixes(pr.labels, github.pullRequestEvents(pr.number), github.isOwner, PR_LABEL_RULES);
      if (origin.unknown.length > 0) {
        log(`  · PR #${pr.number} isn't swept: couldn't check whether the repository owner removed ${NEEDS_HUMAN}.`);
        continue;
      }
      const restore = origin.fixes.find((fix) => fix.action === "restore");
      if (restore !== undefined) {
        github.addPullRequestLabel(pr.number, restore.label);
        log(`  ✋ PR #${pr.number}: ${restore.reason}, so it isn't swept.`);
        continue;
      }
      // Not a bot's and not confirmed as the repository owner's: an owner
      // thread is the follow-up role's to answer (threadsForRole, and now
      // `decide` below), not left waiting on a person the way this count and
      // the run report's "waiting on a person" section describe it.
      const humanThreads = pr.threads.filter((thread) => !thread.resolved && !thread.byBot && github.isOwner(thread.author) !== true).length;
      if (humanThreads > 0) waitingPrs.push({ pr: pr.number, threads: humanThreads });
      const decision = decide(pr, now, github.isOwner);
      followUp(pr, decision, github, log, outcomes);
      if (decision.action === "needs-pass") {
        needsPass.push(pr.number);
        passes.push(passTarget(pr, decision.reasons));
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
  issueNumber: number;
  reasons: string[];
  // GitHub said the PR conflicts with main (DIRTY), so a pass merges main
  // in. A PR that's only behind isn't merged by a pass: the sweep updates it
  // on GitHub once it's settled.
  conflicted: boolean;
};

// What lib/follow-up-pass.mts#runPass reads of a needs-pass PR. Only an
// issue branch gets this far (sweepSkipReason), so the issue number is there.
function passTarget(pr: SweepPullRequest, reasons: string[]): PassTarget {
  const issueNumber = issueNumberOf(pr.headRefName);
  if (issueNumber === undefined) throw new Error(`PR #${pr.number}'s branch ${pr.headRefName} names no issue`);
  return {
    number: pr.number,
    id: pr.id,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    issueNumber,
    reasons,
    conflicted: pr.mergeStateStatus === "DIRTY",
  };
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
// #147's early exit never treats a sweep failure as work found.
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
