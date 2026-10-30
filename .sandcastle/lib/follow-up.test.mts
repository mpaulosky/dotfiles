import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BranchRefs } from "./branches.mts";
import {
  APPROVAL_LAPSED_MARKER,
  APPROVED_HEAD_MARKER,
  COPILOT_REVIEWER,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_REPLY_MARKER,
  LOCAL_QUEUE_LABEL,
  PR_MARKER,
  QUEUE_LABEL,
  SESSION_REPLY_MARKER,
  type QueueScope,
} from "./config.mts";
import type { ClosedPullRequest, ContentEdit, IssueEvent, PullRequestIdentity, ReviewThread, TimelineLabelEvent, MainMerge, TimestampedComment } from "./github.mts";
import {
  admitToSweep,
  APPROVAL_LAPSED_GRACE_MS,
  approvalLapsedComment,
  closedPrHandBackComment,
  closedWithoutMerging,
  decide,
  followUpPhase,
  approvedHeadComment,
  approvedHeadOf,
  handOffApproval,
  isCopilot,
  labelOriginHold,
  liveFollowUpGitHub,
  liveMergeOfMain,
  MAX_MAIN_MERGES,
  recordApprovedHead,
  isSandcastlePullRequest,
  issueNumberOf,
  startFromMain,
  sweepContext as readSweepContext,
  sweepPullRequests,
  sweepSkipReason,
  sweepSubject,
  threadStanding,
  withoutAnsweredThreads,
  type AdmissionGitHub,
  type FollowUpGitHub,
  type SweepContext,
  type SweepPullRequest,
} from "./follow-up.mts";
import { activeQueueScope, useQueueScope, type Approval } from "./queue.mts";
import { OutcomeReport, WaitingPrReport } from "./report.mts";

const HOST = "sandcastle-bot";
const BRANCH = "feature/42-add-search";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const IN_SCOPE = new Set([42]);

// A settled, CLEAN, Sandcastle PR on issue 42's branch, reviewed by Copilot
// with every check green; tests override just the fields their scenario
// needs.
function pr(overrides: Partial<SweepPullRequest> = {}): SweepPullRequest {
  return {
    number: 101,
    title: "feat: Add search",
    author: HOST,
    body: `${PR_MARKER}\nCloses #42`,
    baseRefName: "main",
    headRefName: BRANCH,
    isCrossRepository: false,
    id: "PR_101",
    headRefOid: "a".repeat(40),
    isDraft: false,
    labels: [],
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    reviews: [{ author: COPILOT_REVIEWER, commitOid: "a".repeat(40) }],
    threads: [],
    checks: [{ name: "build", completed: true, green: true, completedAt: "2026-10-10T09:00:00Z" }],
    copilotRequestedAt: [],
    truncated: false,
    ...overrides,
  };
}

const identity = (overrides: Partial<PullRequestIdentity> = {}): PullRequestIdentity => ({
  number: 101,
  author: HOST,
  body: `${PR_MARKER}\nCloses #42`,
  baseRefName: "main",
  headRefName: BRANCH,
  isCrossRepository: false,
  ...overrides,
});

const closedPr = (overrides: Partial<ClosedPullRequest> = {}): ClosedPullRequest => ({
  number: 10,
  author: HOST,
  body: `${PR_MARKER}\nCloses #42`,
  baseRefName: "main",
  headRefName: BRANCH,
  isCrossRepository: false,
  headRefOid: "a".repeat(40),
  state: "CLOSED",
  closedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("isCopilot", () => {
  for (const login of ["copilot-pull-request-reviewer[bot]", "Copilot", "copilot", "copilot-pull-request-reviewer"]) {
    it(`accepts GitHub's "${login}" spelling of Copilot's review account`, () => {
      assert.equal(isCopilot(login), true);
    });
  }

  it("rejects another bot's login", () => {
    assert.equal(isCopilot("github-advanced-security[bot]"), false);
  });

  it("rejects null", () => {
    assert.equal(isCopilot(null), false);
  });
});

describe("issueNumberOf", () => {
  for (const prefix of ["feature", "fix", "hotfix"]) {
    it(`reads the issue number from a ${prefix}/ branch`, () => {
      assert.equal(issueNumberOf(`${prefix}/42-add-search`), 42);
    });
  }

  it("is undefined for a branch whose prefix isn't feature, fix or hotfix", () => {
    assert.equal(issueNumberOf("chore/42-add-search"), undefined);
  });

  // The branch name reaches a shell elsewhere in the pipeline, so only a name
  // isIssueBranch (lib/branches.mts) itself accepts counts.
  it("is undefined for a branch name isIssueBranch refuses", () => {
    assert.equal(issueNumberOf("feature/42-Add-Search"), undefined);
  });
});

describe("isSandcastlePullRequest", () => {
  it("is true for a same-repo PR into main, authored by the host, carrying the marker, on an issue branch", () => {
    assert.equal(isSandcastlePullRequest(identity(), HOST), true);
  });

  it("is false for a PR from a fork", () => {
    assert.equal(isSandcastlePullRequest(identity({ isCrossRepository: true }), HOST), false);
  });

  it("is false for a PR not into main", () => {
    assert.equal(isSandcastlePullRequest(identity({ baseRefName: "develop" }), HOST), false);
  });

  it("is false for a PR the host didn't author", () => {
    assert.equal(isSandcastlePullRequest(identity({ author: "a-collaborator" }), HOST), false);
  });

  it("is false for a PR without PR_MARKER in its body, even from the host", () => {
    assert.equal(isSandcastlePullRequest(identity({ body: "Closes #42" }), HOST), false);
  });

  it("is false for a PR not on an issue branch", () => {
    assert.equal(isSandcastlePullRequest(identity({ headRefName: "chore/42-add-search" }), HOST), false);
  });
});

describe("sweepSkipReason", () => {
  it("has no skip reason for a PR the sweep should act on", () => {
    assert.equal(sweepSkipReason(pr(), IN_SCOPE, HOST), undefined);
  });

  it("skips a fork's PR", () => {
    assert.ok(sweepSkipReason(pr({ isCrossRepository: true }), IN_SCOPE, HOST));
  });

  it("skips a PR not into main", () => {
    assert.ok(sweepSkipReason(pr({ baseRefName: "develop" }), IN_SCOPE, HOST));
  });

  it("skips a PR not on an issue branch", () => {
    assert.ok(sweepSkipReason(pr({ headRefName: "chore/42-add-search" }), IN_SCOPE, HOST));
  });

  it("skips a PR whose issue isn't open and in scope", () => {
    assert.ok(sweepSkipReason(pr(), new Set(), HOST));
  });

  it("skips a draft", () => {
    assert.ok(sweepSkipReason(pr({ isDraft: true }), IN_SCOPE, HOST));
  });

  for (const label of ["sandcastle:needs-human", "Sandcastle:Needs-Human"]) {
    it(`skips a PR labelled ${label}`, () => {
      assert.ok(sweepSkipReason(pr({ labels: [label] }), IN_SCOPE, HOST));
    });
  }

  it("skips a PR the host didn't open", () => {
    assert.ok(sweepSkipReason(pr({ author: "a-collaborator" }), IN_SCOPE, HOST));
  });

  it("skips a PR without PR_MARKER", () => {
    assert.ok(sweepSkipReason(pr({ body: "Closes #42" }), IN_SCOPE, HOST));
  });

  it("skips a PR whose data was truncated, rather than deciding from part of it", () => {
    assert.ok(sweepSkipReason(pr({ truncated: true }), IN_SCOPE, HOST));
  });

  // The overlap guard: a full run building the issue and a follow-up run must stay off each other's PR.
  it("skips a PR whose issue is sandcastle:building, saying so", () => {
    assert.match(sweepSkipReason(pr(), IN_SCOPE, HOST, new Set([42])) ?? "", /sandcastle:building/);
  });

  it("has no skip reason for a PR when only another issue is building", () => {
    assert.equal(sweepSkipReason(pr(), IN_SCOPE, HOST, new Set([7])), undefined);
  });

  it("has no skip reason for a PR when nothing is building", () => {
    assert.equal(sweepSkipReason(pr(), IN_SCOPE, HOST, new Set()), undefined);
  });
});

describe("decide", () => {
  it("waits while a check hasn't completed, saying checks are still running", () => {
    const result = decide(pr({ checks: [{ name: "build", completed: false, green: false, completedAt: null }] }), NOW);

    assert.deepEqual(result, { action: "wait", reason: "checks are still running" });
  });

  // The Sandcastle workflow's own run (a pull_request_review or unlabeled
  // event) reports a check named Sandcastle on the head it sweeps.
  it("doesn't wait for Sandcastle's own check run while it's in progress", () => {
    const result = decide(
      pr({
        checks: [
          { name: "build", completed: true, green: true, completedAt: "2026-10-10T09:00:00Z" },
          { name: "Sandcastle", workflow: "Sandcastle", completed: false, green: false, completedAt: null },
        ],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "leave", reason: "it's settled and CLEAN" });
  });

  it("still waits for another check that's running beside Sandcastle's own", () => {
    const result = decide(
      pr({
        checks: [
          { name: "build", completed: false, green: false, completedAt: null },
          { name: "Sandcastle", workflow: "Sandcastle", completed: false, green: false, completedAt: null },
        ],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "wait", reason: "checks are still running" });
  });

  it("doesn't flag a PR as needing a follow-up pass for Sandcastle's own red check", () => {
    const result = decide(
      pr({
        checks: [
          { name: "build", completed: true, green: true, completedAt: "2026-10-10T09:00:00Z" },
          { name: "Sandcastle", workflow: "Sandcastle", completed: true, green: false, completedAt: "2026-10-10T09:30:00Z" },
        ],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "leave", reason: "it's settled and CLEAN" });
  });

  it("flags only the other red checks, not Sandcastle's own, as needing a follow-up pass", () => {
    const result = decide(
      pr({
        checks: [
          { name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" },
          { name: "Sandcastle", workflow: "Sandcastle", completed: true, green: false, completedAt: "2026-10-10T09:30:00Z" },
        ],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["check lint is red"] });
  });

  it("doesn't name Sandcastle's own red check among a dirty PR's reasons", () => {
    const result = decide(
      pr({
        mergeStateStatus: "DIRTY",
        checks: [{ name: "Sandcastle", workflow: "Sandcastle", completed: true, green: false, completedAt: "2026-10-10T09:30:00Z" }],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  // The check is Sandcastle's own only when the Sandcastle workflow reported
  // it; another workflow's check of that name is a real one.
  it("still waits for, and flags, a check named Sandcastle that another workflow reported", () => {
    const running = decide(pr({ checks: [{ name: "Sandcastle", workflow: "CI", completed: false, green: false, completedAt: null }] }), NOW);
    const red = decide(pr({ checks: [{ name: "Sandcastle", workflow: "CI", completed: true, green: false, completedAt: "2026-10-10T09:30:00Z" }] }), NOW);
    const status = decide(pr({ checks: [{ name: "Sandcastle", completed: true, green: false, completedAt: "2026-10-10T09:30:00Z" }] }), NOW);

    assert.deepEqual(running, { action: "wait", reason: "checks are still running" });
    assert.deepEqual(red, { action: "needs-pass", reasons: ["check Sandcastle is red"] });
    assert.deepEqual(status, { action: "needs-pass", reasons: ["check Sandcastle is red"] });
  });

  it("waits with no checks reported at all", () => {
    const result = decide(pr({ checks: [] }), NOW);

    assert.deepEqual(result, { action: "wait", reason: "no checks have reported" });
  });

  it("waits when Copilot's review is of an older commit and a request is still pending", () => {
    const result = decide(
      pr({ reviews: [{ author: COPILOT_REVIEWER, commitOid: "0".repeat(40) }], reviewRequests: [COPILOT_REVIEWER] }),
      NOW,
    );

    assert.equal(result.action, "wait");
  });

  it("waits when Copilot has reviewed the head but is requested again", () => {
    const result = decide(
      pr({ reviews: [{ author: COPILOT_REVIEWER, commitOid: "a".repeat(40) }], reviewRequests: [COPILOT_REVIEWER] }),
      NOW,
    );

    assert.deepEqual(result, { action: "wait", reason: "Copilot's review is pending" });
  });

  it("asks Copilot again once CI has been done for over an hour with no review or pending request", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const result = decide(
      pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] }),
      NOW,
    );

    assert.deepEqual(result, { action: "request-review" });
  });

  it("keeps waiting at 59 minutes, short of the threshold", () => {
    const completedAt = new Date(NOW - 59 * 60 * 1000).toISOString();
    const result = decide(
      pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] }),
      NOW,
    );

    assert.equal(result.action, "wait");
  });

  it("doesn't ask again once a request already followed the last time CI finished", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        reviews: [],
        reviewRequests: [],
        checks: [{ name: "build", completed: true, green: true, completedAt }],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.deepEqual(result, {
      action: "wait",
      reason: "Copilot hasn't reviewed the head since the one re-request, so a person needs to ask it",
    });
  });

  // A rerun job, or the review check a label adds, completes after the
  // sweep's request on the same head; that mustn't make the head unasked.
  it("doesn't ask again when a check on the same head completes after the recorded request", () => {
    const firstDoneAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const rerunDoneAt = new Date(NOW - 90 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        reviews: [],
        checks: [
          { name: "build", completed: true, green: true, completedAt: firstDoneAt },
          { name: "claude-review", completed: true, green: true, completedAt: rerunDoneAt },
        ],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.equal(result.action, "wait");
  });

  // The request GitHub makes when the PR opens comes before any check on the
  // head completes, so it isn't the sweep's one re-request.
  it("asks again when the only request came before any check on the head completed", () => {
    const requestedAt = new Date(NOW - 4 * 60 * 60 * 1000).toISOString();
    const completedAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const result = decide(
      pr({ reviews: [], checks: [{ name: "build", completed: true, green: true, completedAt }], copilotRequestedAt: [requestedAt] }),
      NOW,
    );

    assert.deepEqual(result, { action: "request-review" });
  });

  // GitHub can drop the one re-request (Copilot's review budget, ADR 0004),
  // and a PR that waits on a review that never comes would otherwise hide a
  // conflict or a red check for good.
  it("flags a dirty PR as needing a follow-up pass even when Copilot never reviewed its head", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        mergeStateStatus: "DIRTY",
        reviews: [],
        checks: [{ name: "build", completed: true, green: true, completedAt }],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  // GitHub runs no pull_request workflows on a PR it can't merge, so a head
  // pushed while the PR conflicts gets no checks at all.
  it("flags a dirty PR with no checks reported as needing a follow-up pass, rather than waiting on checks", () => {
    const result = decide(pr({ mergeStateStatus: "DIRTY", checks: [] }), NOW);

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  it("flags a dirty PR whose checks are still running as needing a follow-up pass", () => {
    const result = decide(
      pr({ mergeStateStatus: "DIRTY", checks: [{ name: "build", completed: false, green: false, completedAt: null }] }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  // Every update-branch makes a new head, so Copilot's threads usually sit on
  // an earlier commit; they still need a pass whatever Copilot does next.
  it("flags an unresolved bot thread from a review of an earlier commit, without waiting on Copilot", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        reviews: [{ author: COPILOT_REVIEWER, commitOid: "0".repeat(40) }],
        threads: [{ resolved: false, byBot: true, author: null }],
        checks: [{ name: "build", completed: true, green: true, completedAt }],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["1 unresolved bot thread(s)"] });
  });

  it("flags a red check as needing a follow-up pass while Copilot's review is still pending", () => {
    const result = decide(
      pr({
        reviews: [],
        reviewRequests: [COPILOT_REVIEWER],
        checks: [{ name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" }],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["check lint is red"] });
  });

  it("updates a settled PR that's only behind main", () => {
    const result = decide(pr({ mergeStateStatus: "BEHIND" }), NOW);

    assert.deepEqual(result, { action: "update-branch" });
  });

  it("flags a settled, dirty PR as needing a follow-up pass, naming merge conflicts", () => {
    const result = decide(pr({ mergeStateStatus: "DIRTY" }), NOW);

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  it("flags a settled PR with a red check as needing a follow-up pass, naming it", () => {
    const result = decide(
      pr({ checks: [{ name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" }] }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["check lint is red"] });
  });

  it("flags a settled PR with an unresolved bot thread as needing a follow-up pass, counting it", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: true, author: null }] }), NOW);

    assert.deepEqual(result, { action: "needs-pass", reasons: ["1 unresolved bot thread(s)"] });
  });

  // threadsForRole answers a thread the repository owner opened, so `decide`
  // must flag it too: otherwise the PR never gets a pass to answer it.
  it("flags a settled PR with an unresolved owner thread as needing a follow-up pass, counting it", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] }), NOW, (login) => login === "owner");

    assert.deepEqual(result, { action: "needs-pass", reasons: ["1 unresolved owner thread(s)"] });
  });

  // Whether the thread's author is confirmed, not just non-bot, decides this:
  // an unresolved thread `isOwner` can't confirm is left alone here (it still
  // counts toward the sweep's waiting-on-a-person list, which errs the other
  // way on the same uncertainty).
  it("leaves a settled PR with an unresolved thread of unconfirmed ownership alone", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: false, author: "maybe-owner" }] }), NOW, () => undefined);

    assert.equal(result.action, "leave");
  });

  it("leaves a settled, clean PR with every thread resolved alone", () => {
    const result = decide(pr({ threads: [{ resolved: true, byBot: true, author: null }] }), NOW);

    assert.equal(result.action, "leave");
  });

  // Open human threads mean a human has joined the review; only they resolve
  // their own threads, so these never count toward a follow-up pass here.
  it("leaves a settled PR with only a human thread open alone, not needing a pass", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: false, author: null }] }), NOW);

    assert.equal(result.action, "leave");
  });

  it("leaves a BLOCKED PR alone, naming the state in the reason", () => {
    const result = decide(pr({ mergeStateStatus: "BLOCKED" }), NOW);

    assert.equal(result.action, "leave");
    assert.match((result as { reason: string }).reason, /BLOCKED/);
  });
});

describe("closedWithoutMerging", () => {
  it("gives the issue's latest Sandcastle PR when it closed without merging", () => {
    const prs = [closedPr({ number: 9, state: "MERGED" }), closedPr({ number: 10, state: "CLOSED" })];

    assert.deepEqual(closedWithoutMerging(prs, 42, HOST), prs[1]);
  });

  it("is undefined when the issue's latest PR merged", () => {
    const prs = [closedPr({ number: 10, state: "MERGED" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });

  it("is undefined when a newer merged PR follows the closed one", () => {
    const prs = [closedPr({ number: 10, state: "CLOSED" }), closedPr({ number: 11, state: "MERGED" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });

  it("is undefined when none of the closed PRs are the host's", () => {
    const prs = [closedPr({ number: 10, state: "CLOSED", author: "a-collaborator" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });

  it("is undefined when none of the closed PRs are on the issue's branch", () => {
    const prs = [closedPr({ number: 10, state: "CLOSED", headRefName: "feature/7-other-issue" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });
});

describe("closedPrHandBackComment", () => {
  it("gives the issue's exact wording, naming the PR and that the rebuild starts from main", () => {
    const comment = closedPrHandBackComment(closedPr({ number: 99 }));

    assert.match(comment, /^PR #99 was closed without merging; remove the label to rebuild\./);
    assert.match(comment, new RegExp(BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(comment, /main/);
  });
});

// A FollowUpGitHub stub serving `prs`, `closed` and `issues`, and recording
// every write the sweep makes.
function stubGithub({
  prs = [pr()],
  closed = [],
  issues = [{ number: 42, labels: [] }],
  host = HOST,
  timelines = {},
  isOwner = () => true,
  pullRequestEvents = () => [],
  reviewThreads,
  pullRequestBodyEdits = () => [],
  followsHandOffs = true,
  pullRequestComments,
  mergeOfMain = () => ({ problem: "not stubbed" }),
  recordApprovedHead = () => {},
  commentOnPullRequest,
}: {
  prs?: SweepPullRequest[];
  closed?: ClosedPullRequest[];
  issues?: { number: number; labels: string[] }[];
  host?: string;
  timelines?: Record<number, TimelineLabelEvent[]>;
  isOwner?: (login: string | null) => boolean | undefined;
  pullRequestEvents?: (number: number) => IssueEvent[];
  // By default each PR's full threads are built from its summaries, one
  // comment each, so a sweep test that doesn't care about replies sees the
  // threads it set up.
  reviewThreads?: (number: number) => ReviewThread[];
  // A PR's description edits, read for a hand-off PR's approval.
  pullRequestBodyEdits?: (number: number) => ContentEdit[];
  // Whether this run follows hand-off PRs; true unless a test says otherwise.
  followsHandOffs?: boolean;
  // A PR's comments, read for the heads the host recorded as approved; by default each PR has the host's record of its own head.
  pullRequestComments?: (number: number) => TimestampedComment[];
  // Whether a commit is a merge of main GitHub made for the host; by default none is.
  mergeOfMain?: (commit: string) => MainMerge;
  recordApprovedHead?: (number: number, head: string) => void;
  // Posts a comment as the host; by default it is recorded and goes nowhere else.
  commentOnPullRequest?: (number: number, body: string) => void;
} = {}) {
  const reviewThreadCalls: number[] = [];
  const requestedReviews: string[] = [];
  const updatedBranches: { number: number; expectedHeadSha: string }[] = [];
  const handBacks: { issueNumber: number; reason: string; body: string }[] = [];
  const closedCalls: string[] = [];
  const addedPrLabels: { number: number; label: string }[] = [];
  const postedComments: { number: number; body: string }[] = [];
  const github: FollowUpGitHub = {
    hostLogin: () => host,
    openPullRequests: () => prs,
    closedPullRequests: (author) => {
      closedCalls.push(author);
      return closed;
    },
    inScopeIssues: () => issues,
    labelTimeline: (issueNumber) => timelines[issueNumber] ?? [],
    requestCopilotReview: (pullRequestId) => void requestedReviews.push(pullRequestId),
    updateBranch: (number, expectedHeadSha) => void updatedBranches.push({ number, expectedHeadSha }),
    handBack: (issueNumber, reason, body) => void handBacks.push({ issueNumber, reason, body }),
    isOwner,
    pullRequestEvents,
    addPullRequestLabel: (number, label) => void addedPrLabels.push({ number, label }),
    pullRequestBodyEdits,
    followsHandOffs: () => followsHandOffs,
    repositoryOwner: () => OWNER,
    pullRequestComments: (number) =>
      pullRequestComments?.(number) ??
      prs.filter((candidate) => candidate.number === number).map((candidate) => headRecord(candidate.headRefOid, host)),
    mergeOfMain,
    recordApprovedHead,
    commentOnPullRequest: (number, body) => {
      postedComments.push({ number, body });
      commentOnPullRequest?.(number, body);
    },
    reviewThreads: (number) => {
      reviewThreadCalls.push(number);
      if (reviewThreads !== undefined) return reviewThreads(number);
      return (prs.find((candidate) => candidate.number === number)?.threads ?? []).map((thread, index) => ({
        id: `RT_${number}_${index}`,
        resolved: thread.resolved,
        outdated: false,
        path: null,
        line: null,
        comments: [{ author: thread.author ?? "", byBot: thread.byBot, body: "", url: "" }],
      }));
    },
  };
  return { github, requestedReviews, updatedBranches, handBacks, closedCalls, addedPrLabels, reviewThreadCalls, postedComments };
}

// A thread of review comments, the first by `author`. `byBot` marks a bot's
// comment.
function thread(author: string, byBot: boolean, more: { author: string; body: string }[] = [], resolved = false): ReviewThread {
  return {
    id: "RT_1",
    resolved,
    outdated: false,
    path: null,
    line: null,
    comments: [
      { author, byBot, body: "Please change this.", url: "" },
      ...more.map((comment) => ({ ...comment, byBot: false, url: "" })),
    ],
  };
}

const hostReply = { author: HOST, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined: it reads better as it is.` };
const ownerIs = (owner: string) => (login: string | null) => (login === null ? false : login === owner);

// The one rule the sweep and the pass share to decide whether a thread
// starts a pass.
describe("threadStanding", () => {
  it("is \"resolved\" for a resolved thread", () => {
    assert.equal(threadStanding(thread("owner", false, [], true), ownerIs("owner"), HOST), "resolved");
  });

  it("is \"bot\" for an unresolved thread a bot opened", () => {
    assert.equal(threadStanding(thread(COPILOT_REVIEWER, true), ownerIs("owner"), HOST), "bot");
  });

  it("is \"answered\" for a bot thread whose last word is the host's marker reply", () => {
    assert.equal(threadStanding(thread(COPILOT_REVIEWER, true, [hostReply]), ownerIs("owner"), HOST), "answered");
  });

  it("is \"owner\" for an unresolved thread the owner opened", () => {
    assert.equal(threadStanding(thread("owner", false), ownerIs("owner"), HOST), "owner");
  });

  it("is \"answered\" for an owner thread whose last word is the host's marker reply", () => {
    assert.equal(threadStanding(thread("owner", false, [hostReply]), ownerIs("owner"), HOST), "answered");
  });

  it("is \"owner\" again once the owner replies after the host's answer", () => {
    assert.equal(threadStanding(thread("owner", false, [hostReply, { author: "owner", body: "Still not convinced." }]), ownerIs("owner"), HOST), "owner");
  });

  it("is \"owner\" when a stranger quotes the marker after the owner", () => {
    const spoofed = { author: "stranger", body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` };
    assert.equal(threadStanding(thread("owner", false, [spoofed]), ownerIs("owner"), HOST), "owner");
  });

  it("is \"human\" for a thread a stranger opened", () => {
    assert.equal(threadStanding(thread("stranger", false), ownerIs("owner"), HOST), "human");
  });

  it("is \"unknown\" when the first author can't be confirmed as the owner or not", () => {
    assert.equal(threadStanding(thread("maybe-owner", false), () => undefined, HOST), "unknown");
  });
});

describe("sweepPullRequests", () => {
  it("skips a PR a collaborator opened from a matching branch, touching nothing", () => {
    const { requestedReviews, updatedBranches, handBacks, github } = stubGithub({
      prs: [pr({ author: "a-collaborator", mergeStateStatus: "BEHIND" })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, []);
    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(handBacks, []);
  });

  it("skips the host's own PR on a matching branch when it lacks PR_MARKER", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ body: "Closes #42", mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  for (const label of ["sandcastle:needs-human", "Sandcastle:Needs-Human"]) {
    it(`skips a PR labelled ${label}`, () => {
      const { updatedBranches, github } = stubGithub({ prs: [pr({ labels: [label], mergeStateStatus: "BEHIND" })] });

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(updatedBranches, []);
    });
  }

  it("skips a draft PR", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ isDraft: true, mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("skips a fork PR", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ isCrossRepository: true, mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("skips a truncated PR, rather than deciding from part of its data", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ truncated: true, mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("updates a settled PR that's only behind main, and logs its number", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
    assert.ok(lines.some((line) => line.includes("#101")), lines.join("\n"));
  });

  it("doesn't update a PR that's dirty, logging it as needing a follow-up pass instead", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ mergeStateStatus: "DIRTY" })] });
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, []);
    assert.ok(lines.some((line) => line.includes("#101") && line.includes("needs a follow-up pass")), lines.join("\n"));
  });

  it("doesn't update a PR with a red check", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND", checks: [{ name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("doesn't update a PR with an unresolved bot thread", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND", threads: [{ resolved: false, byBot: true, author: null }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("doesn't touch a PR whose checks are still running", () => {
    const { updatedBranches, requestedReviews, github } = stubGithub({
      prs: [pr({ checks: [{ name: "build", completed: false, green: false, completedAt: null }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(requestedReviews, []);
  });

  it("doesn't touch a PR with no Copilot review of its head yet, and no pending request", () => {
    const { requestedReviews, github } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt: "2026-10-10T11:58:00Z" }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, []);
  });

  it("asks Copilot again exactly once when CI has been done for over an hour with no review or request", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const { requestedReviews, github } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, ["PR_101"]);
  });

  it("doesn't ask again at 59 minutes", () => {
    const completedAt = new Date(NOW - 59 * 60 * 1000).toISOString();
    const { requestedReviews, github } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, []);
  });

  // The recorded event makes exactly one re-request happen across rounds and
  // runs, even once GitHub drops the request (Copilot's review budget used
  // up, ADR 0004).
  it("asks Copilot again only once across two sweeps in a row", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt: string[] = [];
    const requestedReviews: string[] = [];
    const github: FollowUpGitHub = {
      hostLogin: () => HOST,
      openPullRequests: () => [
        pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }], copilotRequestedAt: [...requestedAt] }),
      ],
      closedPullRequests: () => [],
      inScopeIssues: () => [{ number: 42, labels: [] }],
      labelTimeline: () => [],
      requestCopilotReview: (id) => {
        requestedReviews.push(id);
        requestedAt.push(new Date(NOW).toISOString());
      },
      updateBranch: () => {},
      handBack: () => {},
      isOwner: () => true,
      pullRequestEvents: () => [],
      addPullRequestLabel: () => {},
      reviewThreads: () => [],
      pullRequestBodyEdits: () => [],
      followsHandOffs: () => true,
      repositoryOwner: () => "owner",
      pullRequestComments: () => [],
      mergeOfMain: () => ({ problem: "not stubbed" }),
      recordApprovedHead: () => {},
      commentOnPullRequest: () => {},
    };

    sweepPullRequests(github, () => {}, NOW);
    sweepPullRequests(github, () => {}, NOW + 1000);

    assert.equal(requestedReviews.length, 1);
  });

  it("leaves a settled, clean PR with every thread resolved alone", () => {
    const { updatedBranches, requestedReviews, github } = stubGithub({ prs: [pr({ threads: [{ resolved: true, byBot: true, author: null }] })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(requestedReviews, []);
  });

  it("leaves a settled PR with only a human thread open alone", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: null }] })],
      isOwner: () => false,
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  // From a follow-up review: a settled PR whose only open thread is the
  // repository owner's must still get a follow-up pass, since that's the
  // only thing that ever answers an owner thread (threadsForRole). Before
  // this, `decide` classified threads by byBot alone and never saw the
  // owner, so the PR sat with the thread unanswered forever.
  it("flags a settled PR with only an unresolved owner thread as needing a follow-up pass", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: (login) => login === "owner",
    });

    const { needsPass, passes } = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(needsPass, [101]);
    assert.equal(passes.length, 1);
    assert.equal(passes[0]?.number, 101);
  });

  // The sweep read only each thread's first comment, so a thread the
  // host had answered still counted as open. Such a PR was flagged every
  // round, and `decide` returns needs-pass before its update-branch and
  // Copilot re-request branches, so it was never updated or re-reviewed.
  it("doesn't flag a PR whose only open owner thread the host has answered, and updates it from main", () => {
    const { github, updatedBranches } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND", threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: ownerIs("owner"),
      reviewThreads: () => [thread("owner", false, [hostReply])],
    });

    const { needsPass } = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(needsPass, []);
    assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
  });

  it("asks Copilot again for a PR whose only open owner thread the host has answered", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const { github, requestedReviews } = stubGithub({
      prs: [
        pr({
          reviews: [],
          reviewRequests: [],
          checks: [{ name: "build", completed: true, green: true, completedAt }],
          threads: [{ resolved: false, byBot: false, author: "owner" }],
        }),
      ],
      isOwner: ownerIs("owner"),
      reviewThreads: () => [thread("owner", false, [hostReply])],
    });

    const { needsPass } = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(needsPass, []);
    assert.deepEqual(requestedReviews, ["PR_101"]);
  });

  it("doesn't flag a PR for a bot thread the host answered but couldn't resolve", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: true, author: COPILOT_REVIEWER }] })],
      isOwner: ownerIs("owner"),
      reviewThreads: () => [thread(COPILOT_REVIEWER, true, [hostReply])],
    });

    const { needsPass, passes } = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(needsPass, []);
    assert.deepEqual(passes, []);
  });

  it("flags a PR again once the owner replies after the host's answer", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: ownerIs("owner"),
      reviewThreads: () => [thread("owner", false, [hostReply, { author: "owner", body: "Still not convinced." }])],
    });

    const { needsPass, passes } = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(needsPass, [101]);
    assert.match(passes[0]?.reasons.join("\n") ?? "", /1 unresolved owner thread\(s\)/);
  });

  it("reads no review threads for a PR with no unresolved bot or owner thread", () => {
    const { github, reviewThreadCalls } = stubGithub({
      prs: [
        pr({
          threads: [
            { resolved: false, byBot: false, author: "stranger" },
            { resolved: true, byBot: true, author: COPILOT_REVIEWER },
          ],
        }),
      ],
      isOwner: ownerIs("owner"),
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(reviewThreadCalls, []);
  });

  it("lists a conflicted PR waiting on the owner's answered thread, and flags it for the conflict", () => {
    const { github, reviewThreadCalls } = stubGithub({
      prs: [pr({ mergeStateStatus: "DIRTY", threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: ownerIs("owner"),
      reviewThreads: () => [thread("owner", false, [hostReply])],
    });
    const waiting = new WaitingPrReport();

    const { needsPass } = sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(needsPass, [101]);
    assert.deepEqual(reviewThreadCalls, [101]);
    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 0, answered: 1 }]);
  });

  // The PR's own update from main starts new checks, so the round after it
  // `decide` waits; the PR still has to show as waiting on the owner.
  it("lists a PR waiting on the owner's answered thread while its checks are still running", () => {
    const { github, reviewThreadCalls } = stubGithub({
      prs: [
        pr({
          checks: [{ name: "build", completed: false, green: false, completedAt: null }],
          threads: [{ resolved: false, byBot: false, author: "owner" }],
        }),
      ],
      isOwner: ownerIs("owner"),
      reviewThreads: () => [thread("owner", false, [hostReply])],
    });
    const waiting = new WaitingPrReport();

    const { needsPass } = sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(needsPass, []);
    assert.deepEqual(reviewThreadCalls, [101]);
    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 0, answered: 1 }]);
  });

  it("still flags a conflicted PR when its review threads can't be read", () => {
    const { github } = stubGithub({
      prs: [pr({ mergeStateStatus: "DIRTY", threads: [{ resolved: false, byBot: true, author: COPILOT_REVIEWER }] })],
      reviewThreads: () => {
        throw new Error("gh api failed: HTTP 502");
      },
    });

    const { needsPass } = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(needsPass, [101]);
  });

  it("lists a PR on the waiting list for an owner thread the host has answered", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: ownerIs("owner"),
      reviewThreads: () => [thread("owner", false, [hostReply])],
    });
    const waiting = new WaitingPrReport();

    const { needsPass } = sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(needsPass, []);
    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 0, answered: 1 }]);
  });

  it("leaves a PR alone this round when its review threads can't be read, and still sweeps the rest", () => {
    const unreadable = pr({
      number: 101,
      mergeStateStatus: "BEHIND",
      threads: [
        { resolved: false, byBot: false, author: "owner" },
        { resolved: false, byBot: false, author: "stranger" },
      ],
    });
    const other = pr({
      number: 102,
      id: "PR_102",
      headRefOid: "b".repeat(40),
      headRefName: "feature/43-add-sorting",
      mergeStateStatus: "BEHIND",
      reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }],
    });
    const { github, updatedBranches } = stubGithub({
      prs: [unreadable, other],
      issues: [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
      ],
      isOwner: ownerIs("owner"),
      reviewThreads: (number) => {
        if (number === 101) throw new Error("gh api failed: HTTP 502");
        return [];
      },
    });
    const lines: string[] = [];
    const waiting = new WaitingPrReport();

    const { needsPass } = sweepPullRequests(github, (line) => lines.push(line), NOW, undefined, waiting);

    assert.ok(lines.some((line) => line.includes("Couldn't follow up PR #101")), lines.join("\n"));
    assert.ok(!needsPass.includes(101));
    assert.deepEqual(updatedBranches, [{ number: 102, expectedHeadSha: "b".repeat(40) }]);
    // The stranger's thread still waits on a person, so the PR stays listed.
    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 1, answered: 0 }]);
  });

  it("keeps a PR on the waiting list, counted from the sweep's own threads, when its review threads can't be read", () => {
    const { github } = stubGithub({
      prs: [
        pr({
          threads: [
            { resolved: false, byBot: false, author: "stranger" },
            { resolved: false, byBot: true, author: COPILOT_REVIEWER },
            { resolved: true, byBot: false, author: "stranger" },
          ],
        }),
      ],
      isOwner: ownerIs("owner"),
      reviewThreads: () => {
        throw new Error("gh api failed: HTTP 502");
      },
    });
    const waiting = new WaitingPrReport();
    const lines: string[] = [];

    const { needsPass } = sweepPullRequests(github, (line) => lines.push(line), NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 1, answered: 0 }]);
    assert.ok(lines.some((line) => line.includes("Couldn't follow up PR #101") && line.includes("HTTP 502")), lines.join("\n"));
    assert.deepEqual(needsPass, []);
  });

  it("lists nothing for a PR whose review threads can't be read when no thread waits on a person", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: true, author: COPILOT_REVIEWER }] })],
      isOwner: ownerIs("owner"),
      reviewThreads: () => {
        throw new Error("gh api failed: HTTP 502");
      },
    });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), []);
  });

  it("still updates the next PR when one PR's update fails", () => {
    const failing = pr({ number: 101, mergeStateStatus: "BEHIND" });
    const ok = pr({
      number: 102,
      id: "PR_102",
      headRefOid: "b".repeat(40),
      headRefName: "feature/43-add-sorting",
      mergeStateStatus: "BEHIND",
      reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }],
    });
    const updated: { number: number; expectedHeadSha: string }[] = [];
    const github: FollowUpGitHub = {
      hostLogin: () => HOST,
      openPullRequests: () => [failing, ok],
      closedPullRequests: () => [],
      inScopeIssues: () => [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
      ],
      labelTimeline: () => [],
      requestCopilotReview: () => {},
      updateBranch: (number, expectedHeadSha) => {
        if (number === 101) throw new Error("gh api failed: HTTP 422");
        updated.push({ number, expectedHeadSha });
      },
      handBack: () => {},
      isOwner: () => true,
      pullRequestEvents: () => [],
      addPullRequestLabel: () => {},
      reviewThreads: () => [],
      pullRequestBodyEdits: () => [],
      followsHandOffs: () => true,
      repositoryOwner: () => "owner",
      pullRequestComments: () => [],
      mergeOfMain: () => ({ problem: "not stubbed" }),
      recordApprovedHead: () => {},
      commentOnPullRequest: () => {},
    };
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updated, [{ number: 102, expectedHeadSha: "b".repeat(40) }]);
    assert.ok(lines.some((line) => line.includes("#101") && line.includes("422")), lines.join("\n"));
  });

  it("hands an issue back when its only PR closed without merging", () => {
    const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr()] });

    sweepPullRequests(github, () => {}, NOW);

    assert.equal(handBacks.length, 1);
    assert.equal(handBacks[0]!.issueNumber, 42);
    assert.match(handBacks[0]!.body, /PR #10 was closed without merging; remove the label to rebuild\./);
  });

  it("doesn't hand back when the issue's latest PR merged", () => {
    const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr({ state: "MERGED" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back when a newer merged PR followed the closed one", () => {
    const closed = [closedPr({ number: 10, state: "CLOSED" }), closedPr({ number: 11, state: "MERGED" })];
    const { handBacks, github } = stubGithub({ prs: [], closed });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back when an open PR already exists for the issue", () => {
    const { handBacks, github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], closed: [closedPr()] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back an issue already labelled sandcastle:needs-human", () => {
    const { handBacks, github } = stubGithub({
      prs: [],
      closed: [closedPr()],
      issues: [{ number: 42, labels: ["sandcastle:needs-human"] }],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back again once a person removed sandcastle:needs-human after the closed PR, re-queueing the issue", () => {
    const { handBacks, github } = stubGithub({
      prs: [],
      closed: [closedPr()],
      timelines: { 42: [{ event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-02T00:00:00Z" }] },
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back when the closed PR isn't the host's", () => {
    const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr({ author: "a-collaborator" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("reads the closed pull requests only when an in-scope issue could need a hand-back", () => {
    const { closedCalls, github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], closed: [] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(closedCalls, []);
  });

  // Label origin applies to PR-level hand-backs too, not just issues
  // ("Label origin"): a stranger removing sandcastle:needs-human from a PR
  // mustn't let the sweep touch it as if a human had re-queued it.
  it("re-adds needs-human to a PR whose removal wasn't the owner's, taking no other action on it", () => {
    const strangerRemoved: IssueEvent[] = [
      { event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ];
    const { updatedBranches, requestedReviews, addedPrLabels, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      isOwner: (login) => login !== "stranger",
      pullRequestEvents: () => strangerRemoved,
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(addedPrLabels, [{ number: 101, label: "sandcastle:needs-human" }]);
    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(requestedReviews, []);
  });

  it("sweeps a PR as usual when the owner removed its needs-human", () => {
    const ownerRemoved: IssueEvent[] = [
      { event: "unlabeled", actor: "owner", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ];
    const { updatedBranches, addedPrLabels, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      isOwner: (login) => login === "owner",
      pullRequestEvents: () => ownerRemoved,
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(addedPrLabels, []);
    assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
  });

  it("leaves a PR alone, with no write, when it can't check who removed its needs-human", () => {
    const ghostRemoved: IssueEvent[] = [
      { event: "unlabeled", actor: "ghost", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ];
    const { updatedBranches, addedPrLabels, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      isOwner: () => undefined,
      pullRequestEvents: () => ghostRemoved,
    });
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(addedPrLabels, []);
    assert.deepEqual(updatedBranches, []);
    assert.ok(lines.some((line) => line.includes("#101") && line.includes("couldn't check")), lines.join("\n"));
  });

  // AC: an updated PR reaches the run report (lib/report.mts) as "updated".
  it("records 'updated' for a settled PR that's only behind main, once updateBranch has returned", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });
    const outcomes = new OutcomeReport();

    sweepPullRequests(github, () => {}, NOW, outcomes);

    assert.deepEqual(outcomes.items(), [{ kind: "pr", number: 101, outcome: "updated", detail: "was only behind main" }]);
  });

  it("doesn't record anything when updateBranch fails", () => {
    const failing: FollowUpGitHub = {
      hostLogin: () => HOST,
      openPullRequests: () => [pr({ mergeStateStatus: "BEHIND" })],
      closedPullRequests: () => [],
      inScopeIssues: () => [{ number: 42, labels: [] }],
      labelTimeline: () => [],
      requestCopilotReview: () => {},
      updateBranch: () => {
        throw new Error("gh api failed: HTTP 422");
      },
      handBack: () => {},
      isOwner: () => true,
      pullRequestEvents: () => [],
      addPullRequestLabel: () => {},
      reviewThreads: () => [],
      pullRequestBodyEdits: () => [],
      followsHandOffs: () => true,
      repositoryOwner: () => "owner",
      pullRequestComments: () => [],
      mergeOfMain: () => ({ problem: "not stubbed" }),
      recordApprovedHead: () => {},
      commentOnPullRequest: () => {},
    };
    const outcomes = new OutcomeReport();

    sweepPullRequests(failing, () => {}, NOW, outcomes);

    assert.deepEqual(outcomes.items(), []);
  });

  // AC: "open Sandcastle PRs left waiting on unresolved human review threads,
  // with links" — the waiting list the run report renders (lib/report.mts).
  it("adds a PR to the waiting list, counting only its unresolved, non-bot threads", () => {
    const { github } = stubGithub({
      prs: [
        pr({
          threads: [
            { resolved: false, byBot: false, author: "stranger" },
            { resolved: true, byBot: false, author: "stranger" },
            { resolved: false, byBot: true, author: null },
          ],
        }),
      ],
      isOwner: () => false,
    });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 1, answered: 0 }]);
  });

  // The waiting count must match lib/follow-up-pass.mts#threadsForRole's
  // classification: an owner-opened thread is the follow-up role's to
  // answer, never a person Sandcastle is waiting on.
  it("doesn't count an unresolved thread the repository owner opened", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: (login) => login === "owner",
    });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), []);
  });

  it("excludes a skipped PR from the waiting list", () => {
    const { github } = stubGithub({ prs: [pr({ isDraft: true, threads: [{ resolved: false, byBot: false, author: null }] })] });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), []);
  });

  it("replaces the waiting list each sweep, rather than accumulating across sweeps", () => {
    const waiting = new WaitingPrReport();
    const { github: first } = stubGithub({ prs: [pr({ threads: [{ resolved: false, byBot: false, author: null }] })] });
    const { github: second } = stubGithub({ prs: [pr({ threads: [] })] });

    sweepPullRequests(first, () => {}, NOW, undefined, waiting);
    sweepPullRequests(second, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), []);
  });
});

// The overlap guard of the follow-up-only run: a full run building an issue answers that issue's PR itself, and the
// follow-up run, which runs beside it, must not start a pass on the same branch.
describe("sweepPullRequests and sandcastle:building", () => {
  for (const label of ["sandcastle:building", "Sandcastle:Building"]) {
    it(`leaves alone a PR whose issue is labelled ${label}, whatever it needs`, () => {
      const { updatedBranches, requestedReviews, github } = stubGithub({
        prs: [pr({ mergeStateStatus: "BEHIND" })],
        issues: [{ number: 42, labels: [label] }],
      });
      const lines: string[] = [];

      const result = sweepPullRequests(github, (line) => lines.push(line), NOW);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(requestedReviews, []);
      assert.deepEqual(result, { needsPass: [], passes: [] });
      assert.ok(lines.some((line) => line.includes("#101") && line.includes("sandcastle:building")), lines.join("\n"));
    });
  }

  it("doesn't flag for a pass a conflicted PR whose issue is being built", () => {
    const { github } = stubGithub({
      prs: [pr({ mergeStateStatus: "DIRTY" })],
      issues: [{ number: 42, labels: ["sandcastle:building"] }],
    });

    assert.deepEqual(sweepPullRequests(github, () => {}, NOW), { needsPass: [], passes: [] });
  });

  it("still sweeps a PR whose issue isn't building while another issue is", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      issues: [
        { number: 42, labels: [] },
        { number: 7, labels: ["sandcastle:building"] },
      ],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.equal(updatedBranches.length, 1);
  });
});

// A follow-up-only run runs beside a full run, whose own sweep hands back a closed PR's issue; two runs doing it would
// comment twice, and the follow-up run has no build to start from the issue afterwards.
describe("sweepPullRequests without handing back closed PRs", () => {
  it("doesn't hand back an issue whose latest PR closed without merging", () => {
    const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr()] });

    sweepPullRequests(github, () => {}, NOW, undefined, undefined, { handBackClosed: false });

    assert.deepEqual(handBacks, []);
  });

  it("doesn't even read the closed pull requests", () => {
    const { closedCalls, github } = stubGithub({ prs: [], closed: [closedPr()] });

    sweepPullRequests(github, () => {}, NOW, undefined, undefined, { handBackClosed: false });

    assert.deepEqual(closedCalls, []);
  });

  it("still sweeps the open pull requests", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW, undefined, undefined, { handBackClosed: false });

    assert.equal(updatedBranches.length, 1);
  });

  it("still returns the PRs that need a pass", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "DIRTY" })] });

    const result = sweepPullRequests(github, () => {}, NOW, undefined, undefined, { handBackClosed: false });

    assert.deepEqual(result.needsPass, [101]);
  });

  it("hands back by default, and when handBackClosed is true", () => {
    for (const options of [undefined, {}, { handBackClosed: true }]) {
      const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr()] });

      sweepPullRequests(github, () => {}, NOW, undefined, undefined, options);

      assert.equal(handBacks.length, 1, JSON.stringify(options));
    }
  });
});

describe("followUpPhase", () => {
  it("logs a thrown sweep through warn and doesn't throw", () => {
    const warnings: string[] = [];

    followUpPhase(
      () => {
        throw new Error("GitHub's API is unavailable");
      },
      (message) => warnings.push(message),
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /GitHub's API is unavailable/);
  });

  // The early exit reads followUpPhase's result, so a failed sweep
  // must never look like it found work.
  it("returns no PRs needing a pass when the sweep throws", () => {
    const result = followUpPhase(
      () => {
        throw new Error("GitHub's API is unavailable");
      },
      () => {},
    );

    assert.deepEqual(result, { needsPass: [], passes: [] });
  });

  it("returns the sweep's result when it succeeds", () => {
    const result = followUpPhase(() => ({ needsPass: [101, 102], passes: [] }));

    assert.deepEqual(result, { needsPass: [101, 102], passes: [] });
  });
});

// The early exit needs the PRs the sweep found needing a follow-up
// pass, and only those, so it doesn't start an agent for a PR the sweep
// already updated or is still waiting on. The pass pipeline
// (lib/follow-up-pass.mts#followUpPassPhase) needs those same PRs as
// PassTargets, so it never has to re-read what the sweep already read.
describe("sweepPullRequests' needsPass and passes result", () => {
  it("collects the PR numbers logged as needing a follow-up pass, and only those", () => {
    const needsPassPr = pr({ number: 101, mergeStateStatus: "DIRTY" });
    const updatedPr = pr({
      number: 102,
      id: "PR_102",
      headRefName: "feature/43-add-sorting",
      mergeStateStatus: "BEHIND",
      reviews: [{ author: COPILOT_REVIEWER, commitOid: "a".repeat(40) }],
    });
    const waitingPr = pr({
      number: 103,
      id: "PR_103",
      headRefName: "feature/44-add-paging",
      reviews: [],
      reviewRequests: [],
      checks: [{ name: "build", completed: false, green: false, completedAt: null }],
    });
    const { github } = stubGithub({
      prs: [needsPassPr, updatedPr, waitingPr],
      issues: [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
        { number: 44, labels: [] },
      ],
    });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.needsPass, [101]);
  });

  it("is empty when nothing needs a follow-up pass", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result, { needsPass: [], passes: [] });
  });

  // runPass reads PassTarget.id, headRefName, headRefOid and
  // issueNumber to start a sandbox on the PR's own head, and reasons to
  // explain a give-up; the pass pipeline must never have to read the PR
  // again from GitHub just to learn them.
  it("carries a PassTarget for each PR logged as needing a follow-up pass, with the sweep's reasons", () => {
    const needsPassPr = pr({ number: 101, id: "PR_101", headRefName: BRANCH, headRefOid: "b".repeat(40), mergeStateStatus: "DIRTY" });
    const { github } = stubGithub({ prs: [needsPassPr] });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.passes, [
      { number: 101, id: "PR_101", headRefName: BRANCH, headRefOid: "b".repeat(40), issueNumber: 42, reasons: ["it has merge conflicts"], conflicted: true },
    ]);
  });

  it("returns no passes when nothing needs a follow-up pass", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.passes, []);
  });
});

// A session's reply (lib/config.mts#SESSION_REPLY_MARKER) is posted under the owner's token, so it is the host login's
// or another owner's comment carrying the marker anywhere in its body. Like the host's own reply, it answers the thread it ends.
describe("threadStanding and a session's replies", () => {
  const sessionReply = (body = "Fixed in abc1234.") => ({ author: HOST, body: `${body}\n\n${SESSION_REPLY_MARKER}` });
  const hostIsOwner = ownerIs(HOST);

  it("is \"answered\" for a bot thread whose last bot, host or owner comment is a session's reply", () => {
    assert.equal(threadStanding(thread(COPILOT_REVIEWER, true, [sessionReply()]), hostIsOwner, HOST), "answered");
  });

  it("is \"answered\" for an owner thread whose last owner or host comment is a session's reply", () => {
    assert.equal(threadStanding(thread("owner", false, [sessionReply()]), ownerIs("owner"), HOST), "answered");
  });

  it("counts the marker anywhere in the body, not only at its start", () => {
    for (const body of [`${SESSION_REPLY_MARKER} Fixed.`, `Fixed.\n${SESSION_REPLY_MARKER}\nMore text.`]) {
      assert.equal(threadStanding(thread(COPILOT_REVIEWER, true, [{ author: HOST, body }]), hostIsOwner, HOST), "answered", body);
    }
  });

  it("is \"answered\" for a thread a session opened itself, with its marker in the first comment", () => {
    const opened: Pick<ReviewThread, "resolved" | "comments"> = {
      resolved: false,
      comments: [{ author: HOST, byBot: false, body: `Left for the owner.\n${SESSION_REPLY_MARKER}`, url: "" }],
    };

    assert.equal(threadStanding(opened, hostIsOwner, HOST), "answered");
  });

  it("is \"bot\" again once the bot comments after the session's reply", () => {
    const later = { author: COPILOT_REVIEWER, body: "Please reconsider." };
    const bot = thread(COPILOT_REVIEWER, true, [sessionReply(), later]);
    bot.comments[2]!.byBot = true;

    assert.equal(threadStanding(bot, hostIsOwner, HOST), "bot");
  });

  it("is \"owner\" again once the owner replies after the session's reply", () => {
    const owner = thread("owner", false, [sessionReply(), { author: "owner", body: "Still not convinced." }]);

    assert.equal(threadStanding(owner, ownerIs("owner"), HOST), "owner");
  });

  it("is \"answered\" when the session replied under an owner's login that isn't the host's", () => {
    const reply = { author: "owner", body: `Fixed.\n\n${SESSION_REPLY_MARKER}` };

    assert.equal(threadStanding(thread(COPILOT_REVIEWER, true, [reply]), ownerIs("owner"), "the-app[bot]"), "answered");
    assert.equal(threadStanding(thread("owner", false, [reply]), ownerIs("owner"), "the-app[bot]"), "answered");
  });

  it("ignores a marker quoted by a collaborator or a stranger, since only the host's and the owner's logins count", () => {
    const quoted = { author: "stranger", body: `Fixed.\n${SESSION_REPLY_MARKER}` };

    assert.equal(threadStanding(thread("owner", false, [quoted]), ownerIs("owner"), HOST), "owner");
    assert.equal(threadStanding(thread(COPILOT_REVIEWER, true, [quoted]), ownerIs("owner"), HOST), "bot");
  });

  it("ignores the marker in a comment by a login that is neither the host's nor a confirmed owner's", () => {
    assert.equal(threadStanding(thread("owner", false, [sessionReply()]), ownerIs("owner"), "someone-else"), "owner");
  });

  it("doesn't count a host comment without the marker as an answer", () => {
    assert.equal(threadStanding(thread(COPILOT_REVIEWER, true, [{ author: HOST, body: "I'll look at it." }]), hostIsOwner, HOST), "bot");
  });
});

// ---------------------------------------------------------------------------
// Hand-off PRs: a PR Sandcastle didn't open, carrying the repository owner's sandcastle:follow-up label
// ---------------------------------------------------------------------------

const OWNER = "owner";
const LABELLED_AT = "2026-10-09T10:00:00Z";
// The head of a hand-off PR when the owner labelled it, and one pushed after.
const HEAD_SHA = "a".repeat(40);
const PUSHED_SHA = "d".repeat(40);

// A PR the owner opened on a chore/ branch with no Sandcastle marker, labelled sandcastle:follow-up.
function handOffPr(overrides: Partial<SweepPullRequest> = {}): SweepPullRequest {
  return pr({
    number: 201,
    id: "PR_201",
    title: "chore: Tidy the build",
    author: OWNER,
    body: "Tidies the build scripts.",
    headRefName: "chore/tidy-the-build",
    labels: [FOLLOW_UP_LABEL],
    ...overrides,
  });
}

const labelledBy = (actor: string | null, createdAt = LABELLED_AT): IssueEvent => ({ event: "labeled", actor, label: FOLLOW_UP_LABEL, createdAt });
const ownerLabelled: IssueEvent[] = [labelledBy(OWNER)];

// Five minutes after LABELLED_AT, when the Sandcastle workflow has posted its record.
const RECORDED_AT = "2026-10-09T10:05:00Z";
// The comment that records `head` as approved, posted by `author` at `createdAt`.
const headRecord = (head: string, author: string, createdAt = RECORDED_AT, updatedAt = createdAt): TimestampedComment => ({
  author,
  createdAt,
  updatedAt,
  body: approvedHeadComment(head),
});

const sweepContext = (overrides: Partial<SweepContext> = {}): SweepContext => ({
  inScope: IN_SCOPE,
  host: HOST,
  building: new Set<number>(),
  followsHandOffs: true,
  ...overrides,
});
const approved = (): Approval => ({ approved: true });

// A sweepSubject call with an approval that records whether it was read.
function subjectOf(candidate: SweepPullRequest, context: SweepContext = sweepContext(), approval: () => Approval = approved) {
  let approvalReads = 0;
  const result = sweepSubject(candidate, context, () => {
    approvalReads++;
    return approval();
  });
  return { result, approvalReads: () => approvalReads };
}

describe("sweepSubject", () => {
  describe("a Sandcastle issue's PR", () => {
    it("is swept as the issue's, without reading the hand-off approval", () => {
      const { result, approvalReads } = subjectOf(pr());

      assert.deepEqual(result, { subject: { kind: "issue", issueNumber: 42 } });
      assert.equal(approvalReads(), 0);
    });

    it("is swept as the issue's even when it carries the follow-up label", () => {
      const { result, approvalReads } = subjectOf(pr({ labels: [FOLLOW_UP_LABEL] }));

      assert.deepEqual(result, { subject: { kind: "issue", issueNumber: 42 } });
      assert.equal(approvalReads(), 0);
    });
  });

  describe("a PR that isn't Sandcastle's and doesn't carry the label", () => {
    const strangerPr = (overrides: Partial<SweepPullRequest> = {}) => handOffPr({ labels: [], ...overrides });

    it("is skipped with the reason sweepSkipReason gives, reading no approval", () => {
      const candidate = strangerPr();
      const { result, approvalReads } = subjectOf(candidate);

      assert.deepEqual(result, { skip: sweepSkipReason(candidate, IN_SCOPE, HOST, new Set()) });
      assert.equal(approvalReads(), 0);
    });

    it("keeps today's reason for a branch that isn't an issue branch", () => {
      const { result } = subjectOf(strangerPr());

      assert.deepEqual(result, { skip: "chore/tidy-the-build isn't an issue branch" });
    });

    it("keeps today's reasons for a fork and for a base other than main", () => {
      assert.deepEqual(subjectOf(strangerPr({ isCrossRepository: true })).result, { skip: "it's from a fork" });
      assert.deepEqual(subjectOf(strangerPr({ baseRefName: "develop" })).result, { skip: "it's into develop, not main" });
    });

    it("keeps today's reason for a collaborator's PR on an issue branch, whose issue is in scope", () => {
      const candidate = strangerPr({ headRefName: BRANCH, author: "a-collaborator" });

      assert.deepEqual(subjectOf(candidate).result, { skip: "a-collaborator opened it, not sandcastle-bot" });
    });
  });

  describe("a Sandcastle-identity PR that also carries the label", () => {
    // It has an in-scope issue branch, the host's authorship and the marker, so the hand-off path is never taken for it.
    for (const [name, overrides] of [
      ["a draft", { isDraft: true }],
      ["labelled sandcastle:needs-human", { labels: [FOLLOW_UP_LABEL, "sandcastle:needs-human"] }],
      ["truncated", { truncated: true }],
    ] as [string, Partial<SweepPullRequest>][]) {
      it(`stays skipped when it is ${name}, with sweepSkipReason's reason`, () => {
        const candidate = pr({ labels: [FOLLOW_UP_LABEL], ...overrides });
        const { result, approvalReads } = subjectOf(candidate);

        assert.deepEqual(result, { skip: sweepSkipReason(candidate, IN_SCOPE, HOST, new Set()) });
        assert.ok("skip" in result && result.skip.length > 0);
        assert.equal(approvalReads(), 0);
      });
    }

    it("stays skipped when its issue is labelled sandcastle:building", () => {
      const candidate = pr({ labels: [FOLLOW_UP_LABEL] });
      const { result, approvalReads } = subjectOf(candidate, sweepContext({ building: new Set([42]) }));

      assert.match("skip" in result ? result.skip : "", /sandcastle:building/);
      assert.equal(approvalReads(), 0);
    });
  });

  describe("a labelled PR with no Sandcastle marker, issue branch or in-scope issue", () => {
    it("is followed as a hand-off when the owner's label stands", () => {
      const { result, approvalReads } = subjectOf(handOffPr());

      assert.deepEqual(result, { subject: { kind: "hand-off" } });
      assert.equal(approvalReads(), 1);
    });

    it("is followed on a feature/ branch whose issue isn't in scope", () => {
      assert.deepEqual(subjectOf(handOffPr({ headRefName: "feature/99-owner-change" })).result, { subject: { kind: "hand-off" } });
    });

    it("is followed on an issue branch the host didn't author", () => {
      assert.deepEqual(subjectOf(handOffPr({ headRefName: BRANCH })).result, { subject: { kind: "hand-off" } });
    });

    it("is followed when the host opened it but its body carries no marker", () => {
      assert.deepEqual(subjectOf(handOffPr({ author: HOST, headRefName: BRANCH, body: "Closes #42" })).result, { subject: { kind: "hand-off" } });
    });

    it("leaves a Sandcastle issue's PR to its own run when the issue is outside this run's scope, label or not", () => {
      const sandcastles = pr({ number: 77, headRefName: "feature/77-other-scope", labels: [FOLLOW_UP_LABEL] });
      const { result, approvalReads } = subjectOf(sandcastles);

      assert.ok("skip" in result);
      assert.equal(approvalReads(), 0);
    });

    it("takes the label in any case, as GitHub matches labels", () => {
      assert.deepEqual(subjectOf(handOffPr({ labels: ["Sandcastle:Follow-Up"] })).result, { subject: { kind: "hand-off" } });
    });
  });

  describe("a labelled PR that is not followed", () => {
    it("is skipped when it comes from a fork, saying so, before reading the approval", () => {
      const { result, approvalReads } = subjectOf(handOffPr({ isCrossRepository: true }));

      assert.deepEqual(result, { skip: "it's from a fork" });
      assert.equal(approvalReads(), 0);
    });

    it("is skipped when it targets a branch other than main, saying which", () => {
      const { result } = subjectOf(handOffPr({ baseRefName: "develop" }));

      assert.deepEqual(result, { skip: "it's into develop, not main" });
    });

    it("is skipped by a run without the default queue scope, saying only the default scope follows hand-offs", () => {
      const { result, approvalReads } = subjectOf(handOffPr(), sweepContext({ followsHandOffs: false }));

      assert.match("skip" in result ? result.skip : "", /sandcastle:follow-up/);
      assert.match("skip" in result ? result.skip : "", /default queue scope/);
      assert.equal(approvalReads(), 0);
    });

    for (const branch of ["docs/release-notes", "dependabot/npm_and_yarn/x", "claude/fix-it", "chore/1-x", "Feature/5-x", "fix/4-$(x)"]) {
      it(`is skipped on the branch ${branch}, which scripts/check-branch-name.sh refuses`, () => {
        const { result, approvalReads } = subjectOf(handOffPr({ headRefName: branch }));

        assert.match("skip" in result ? result.skip : "", /check-branch-name\.sh/);
        assert.equal(approvalReads(), 0);
      });
    }

    it("is skipped when the PR itself carries sandcastle:building, saying a run is passing on it", () => {
      const { result, approvalReads } = subjectOf(handOffPr({ labels: [FOLLOW_UP_LABEL, "Sandcastle:Building"] }));

      assert.match("skip" in result ? result.skip : "", /sandcastle:building/);
      assert.equal(approvalReads(), 0);
    });

    it("is skipped when the issue its branch names is labelled sandcastle:building", () => {
      const { result, approvalReads } = subjectOf(handOffPr({ headRefName: "feature/43-owner-change" }), sweepContext({ building: new Set([43]) }));

      assert.match("skip" in result ? result.skip : "", /sandcastle:building/);
      assert.equal(approvalReads(), 0);
    });

    it("is skipped as a draft", () => {
      const { result, approvalReads } = subjectOf(handOffPr({ isDraft: true }));

      assert.match("skip" in result ? result.skip : "", /draft/);
      assert.equal(approvalReads(), 0);
    });

    it("is skipped when labelled sandcastle:needs-human", () => {
      const { result, approvalReads } = subjectOf(handOffPr({ labels: [FOLLOW_UP_LABEL, "sandcastle:needs-human"] }));

      assert.match("skip" in result ? result.skip : "", /sandcastle:needs-human/);
      assert.equal(approvalReads(), 0);
    });

    it("is skipped when truncated, rather than decided from part of its data", () => {
      const { result, approvalReads } = subjectOf(handOffPr({ truncated: true }));

      assert.match("skip" in result ? result.skip : "", /more reviews, threads or checks/);
      assert.equal(approvalReads(), 0);
    });

    it("is skipped when the label doesn't count, saying why", () => {
      const { result, approvalReads } = subjectOf(handOffPr(), sweepContext(), () => ({ approved: false, reason: "a-stranger added sandcastle:follow-up, not the repository owner" }));

      assert.equal(approvalReads(), 1);
      assert.match("skip" in result ? result.skip : "", /its sandcastle:follow-up label doesn't count: a-stranger added sandcastle:follow-up, not the repository owner/);
    });

    it("lets a throw from the approval's reads reach the caller, which logs it and sweeps the PR again next round", () => {
      assert.throws(
        () =>
          subjectOf(handOffPr(), sweepContext(), () => {
            throw new Error("gh api failed: HTTP 502");
          }),
        /502/,
      );
    });
  });
});

describe("recordApprovedHead", () => {
  it("posts the record of the head on the PR it names, which approvedHeadOf reads back", () => {
    const posted: { number: number; body: string }[] = [];

    recordApprovedHead(201, "0123456789abcdef0123456789abcdef01234567", (number, body) => void posted.push({ number, body }));

    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.number, 201);
    assert.equal(approvedHeadOf(posted[0]!.body), "0123456789abcdef0123456789abcdef01234567");
  });

  it("lets a failure to post through", () => {
    assert.throws(() => recordApprovedHead(201, "a".repeat(40), () => { throw new Error("gh pr comment failed"); }), /gh pr comment failed/);
  });
});

describe("approvedHeadComment and approvedHeadOf", () => {
  it("round-trip a head", () => {
    assert.equal(approvedHeadOf(approvedHeadComment("0123456789abcdef0123456789abcdef01234567")), "0123456789abcdef0123456789abcdef01234567");
  });

  it("open with the marker the Sandcastle workflow also posts, which the Template's test.sh pins", () => {
    assert.ok(approvedHeadComment("a".repeat(40)).startsWith(`${APPROVED_HEAD_MARKER} `));
  });

  for (const [what, body] of [
    ["a short hash", `${APPROVED_HEAD_MARKER} ${"a".repeat(39)} -->`],
    ["an upper-case hash", `${APPROVED_HEAD_MARKER} ${"A".repeat(40)} -->`],
    ["a hash with more after it", `${APPROVED_HEAD_MARKER} ${"a".repeat(41)} -->`],
    ["no marker", "a".repeat(40)],
    ["a marker that isn't first", `Hello\n${approvedHeadComment("a".repeat(40))}`],
    ["an unclosed marker", `${APPROVED_HEAD_MARKER} ${"a".repeat(40)}`],
  ] as const) {
    it(`read no head from ${what}`, () => {
      assert.equal(approvedHeadOf(body), undefined);
    });
  }
});

describe("handOffApproval", () => {
  const HOST = "the-host";
  const PR = { number: 201, author: OWNER, headRefOid: HEAD_SHA };
  function github(
    overrides: { events?: IssueEvent[]; edits?: ContentEdit[]; comments?: TimestampedComment[]; mergeOfMain?: (commit: string) => MainMerge; isOwner?: (login: string | null) => boolean | undefined } = {},
  ) {
    const eventReads: number[] = [];
    const editReads: number[] = [];
    const commentReads: number[] = [];
    const mergeReads: string[] = [];
    const recordings: { number: number; head: string }[] = [];
    const stub = {
      pullRequestEvents: (number: number) => {
        eventReads.push(number);
        return overrides.events ?? ownerLabelled;
      },
      pullRequestBodyEdits: (number: number) => {
        editReads.push(number);
        return overrides.edits ?? [];
      },
      pullRequestComments: (number: number) => {
        commentReads.push(number);
        return overrides.comments ?? [headRecord(HEAD_SHA, HOST)];
      },
      mergeOfMain: (commit: string): MainMerge => {
        mergeReads.push(commit);
        return overrides.mergeOfMain?.(commit) ?? { problem: `${commit.slice(0, 7)} isn't a merge` };
      },
      recordApprovedHead: (number: number, head: string) => {
        recordings.push({ number, head });
      },
      isOwner: overrides.isOwner ?? ownerIs(OWNER),
      repositoryOwner: () => OWNER,
    };
    return { stub, eventReads, editReads, commentReads, mergeReads, recordings };
  }
  const reasonOf = (result: Approval) => (result.approved ? "" : result.reason);

  it("approves a label the repository owner added last", () => {
    assert.deepEqual(handOffApproval(PR, github().stub, HOST), { approved: true });
  });

  it("reads the PR's events and description edits for the PR's own number, once each", () => {
    const { stub, eventReads, editReads } = github();

    handOffApproval(PR, stub, HOST);

    assert.deepEqual(eventReads, [201]);
    assert.deepEqual(editReads, [201]);
  });

  it("approves a PR the host opened, whoever the owner check says it is", () => {
    assert.deepEqual(handOffApproval({ ...PR, author: HOST }, github().stub, HOST), { approved: true });
  });

  it("matches the author with the repository's owner or the host without regard to case", () => {
    assert.equal(handOffApproval({ ...PR, author: OWNER.toUpperCase() }, github().stub, HOST).approved, true);
    assert.equal(handOffApproval({ ...PR, author: HOST.toUpperCase() }, github().stub, HOST).approved, true);
  });

  it("doesn't approve a PR a collaborator with push access opened, even with the owner's label", () => {
    const stub = github({ isOwner: () => true }).stub;
    const result = handOffApproval({ ...PR, author: "a-collaborator" }, stub, HOST);

    assert.equal(result.approved, false);
    assert.match(reasonOf(result), /a-collaborator opened it/);
  });

  it("doesn't approve a PR whose author is gone", () => {
    const result = handOffApproval({ ...PR, author: null }, github().stub, HOST);

    assert.equal(result.approved, false);
    assert.match(reasonOf(result), /a deleted account opened it/);
  });

  it("doesn't approve a stranger's edit or rename made in the same second as the owner's label", () => {
    const edits: ContentEdit[] = [{ editor: "a-stranger", editedAt: LABELLED_AT }];
    const renamed: IssueEvent[] = [...ownerLabelled, { event: "renamed", actor: "a-stranger", label: null, createdAt: LABELLED_AT }];

    assert.equal(handOffApproval(PR, github({ edits }).stub, HOST).approved, false);
    assert.equal(handOffApproval(PR, github({ events: renamed }).stub, HOST).approved, false);
  });

  it("doesn't approve a stranger's edit whose time can't be read", () => {
    const edits: ContentEdit[] = [{ editor: "a-stranger", editedAt: "not a time" }];

    assert.equal(handOffApproval(PR, github({ edits }).stub, HOST).approved, false);
  });

  it("still approves the owner's own edit made in the same second as the label", () => {
    const edits: ContentEdit[] = [{ editor: OWNER, editedAt: LABELLED_AT }];

    assert.deepEqual(handOffApproval(PR, github({ edits }).stub, HOST), { approved: true });
  });

  it("doesn't read the PR's events when its author already rules it out", () => {
    const { stub, eventReads } = github();

    handOffApproval({ ...PR, author: "a-stranger" }, stub, HOST);

    assert.deepEqual(eventReads, []);
  });

  it("doesn't approve a label added by someone who isn't the owner", () => {
    const result = handOffApproval(PR, github({ events: [labelledBy("a-stranger")] }).stub, HOST);

    assert.equal(result.approved, false);
    assert.match(reasonOf(result), /a-stranger.*not the repository owner/);
  });

  it("doesn't approve a label added by an actor GitHub no longer knows", () => {
    assert.equal(handOffApproval(PR, github({ events: [labelledBy(null)] }).stub, HOST).approved, false);
  });

  it("doesn't approve a label when the owner check couldn't be made", () => {
    const result = handOffApproval(PR, github({ isOwner: () => undefined }).stub, HOST);

    assert.equal(result.approved, false);
    assert.match(reasonOf(result), /couldn't check/);
  });

  it("doesn't approve a PR with no labeled event for sandcastle:follow-up", () => {
    const other: IssueEvent = { event: "labeled", actor: OWNER, label: "sandcastle:ready", createdAt: LABELLED_AT };
    const result = handOffApproval(PR, github({ events: [other] }).stub, HOST);

    assert.equal(result.approved, false);
    assert.match(reasonOf(result), /sandcastle:follow-up/);
  });

  it("uses the latest labeled event: a stranger's label after the owner's doesn't count", () => {
    const events = [labelledBy(OWNER, "2026-10-09T10:00:00Z"), labelledBy("a-stranger", "2026-10-09T11:00:00Z")];

    assert.equal(handOffApproval(PR, github({ events }).stub, HOST).approved, false);
  });

  it("doesn't approve once a stranger renamed the PR after the owner's label", () => {
    const events: IssueEvent[] = [...ownerLabelled, { event: "renamed", actor: "a-stranger", label: null, createdAt: "2026-10-09T11:00:00Z" }];
    const result = handOffApproval(PR, github({ events }).stub, HOST);

    assert.equal(result.approved, false);
    assert.match(reasonOf(result), /title/);
  });

  it("doesn't approve once a stranger edited the PR's description after the owner's label", () => {
    const edits: ContentEdit[] = [{ editor: "a-stranger", editedAt: "2026-10-09T11:00:00Z" }];
    const result = handOffApproval(PR, github({ edits }).stub, HOST);

    assert.equal(result.approved, false);
    assert.match(reasonOf(result), /body/);
  });

  it("approves again when the owner re-adds the label after a stranger's edit", () => {
    const events = [labelledBy(OWNER, "2026-10-09T10:00:00Z"), labelledBy(OWNER, "2026-10-09T12:00:00Z")];
    const edits: ContentEdit[] = [{ editor: "a-stranger", editedAt: "2026-10-09T11:00:00Z" }];

    const comments = [headRecord(HEAD_SHA, HOST, "2026-10-09T12:00:05Z")];

    assert.deepEqual(handOffApproval(PR, github({ events, edits, comments }).stub, HOST), { approved: true });
  });

  it("ignores an edit by a stranger made before the label", () => {
    const edits: ContentEdit[] = [{ editor: "a-stranger", editedAt: "2026-10-08T11:00:00Z" }];

    assert.deepEqual(handOffApproval(PR, github({ edits }).stub, HOST), { approved: true });
  });

  it("doesn't approve when an edit's author can't be checked", () => {
    const edits: ContentEdit[] = [{ editor: "maybe-owner", editedAt: "2026-10-09T11:00:00Z" }];
    const isOwner = (login: string | null) => (login === OWNER ? true : undefined);

    assert.equal(handOffApproval(PR, github({ edits, isOwner }).stub, HOST).approved, false);
  });
  describe("the head", () => {
    const refused = (result: Approval) => {
      assert.equal(result.approved, false);
      return reasonOf(result);
    };

    it("approves the head the host recorded when the label was added", () => {
      assert.deepEqual(handOffApproval(PR, github({ comments: [headRecord(HEAD_SHA, HOST)] }).stub, HOST), { approved: true });
    });

    it("refuses a head pushed after the label, which no record covers", () => {
      const reason = refused(handOffApproval({ ...PR, headRefOid: PUSHED_SHA }, github({ comments: [headRecord(HEAD_SHA, HOST)] }).stub, HOST));

      assert.match(reason, /isn't one the-host recorded as approved/);
      assert.match(reason, /remove and re-add sandcastle:follow-up/);
    });

    it("refuses when nothing was recorded, such as before the workflow has posted its record", () => {
      refused(handOffApproval(PR, github({ comments: [] }).stub, HOST));
    });

    it("approves a head the host pushed and recorded after the label", () => {
      const comments = [headRecord(HEAD_SHA, HOST), headRecord(PUSHED_SHA, HOST, "2026-10-09T12:00:00Z")];

      assert.deepEqual(handOffApproval({ ...PR, headRefOid: PUSHED_SHA }, github({ comments }).stub, HOST), { approved: true });
    });

    it("refuses a head the host pushed but couldn't record", () => {
      refused(handOffApproval({ ...PR, headRefOid: PUSHED_SHA }, github({ comments: [headRecord(HEAD_SHA, HOST)] }).stub, HOST));
    });

    it("refuses a force-pushed head", () => {
      refused(handOffApproval({ ...PR, headRefOid: "c".repeat(40) }, github({ comments: [headRecord(HEAD_SHA, HOST), headRecord(PUSHED_SHA, HOST, "2026-10-09T12:00:00Z")] }).stub, HOST));
    });

    it("doesn't count a record anyone but the host posted", () => {
      refused(handOffApproval(PR, github({ comments: [headRecord(HEAD_SHA, "a-collaborator"), headRecord(HEAD_SHA, OWNER)] }).stub, HOST));
    });

    it("counts the host's login whatever its case", () => {
      assert.deepEqual(handOffApproval(PR, github({ comments: [headRecord(HEAD_SHA, HOST.toUpperCase())] }).stub, HOST), { approved: true });
    });

    it("doesn't count a record posted before the label was added", () => {
      refused(handOffApproval(PR, github({ comments: [headRecord(HEAD_SHA, HOST, "2026-10-09T09:59:59Z")] }).stub, HOST));
    });

    it("counts a record posted in the same second as the label", () => {
      assert.deepEqual(handOffApproval(PR, github({ comments: [headRecord(HEAD_SHA, HOST, LABELLED_AT)] }).stub, HOST), { approved: true });
    });

    it("doesn't count a record with a time that doesn't parse", () => {
      refused(handOffApproval(PR, github({ comments: [headRecord(HEAD_SHA, HOST, "garbage")] }).stub, HOST));
    });

    it("measures a record against the label added last, so a label added again drops the heads recorded before it", () => {
      const events = [labelledBy(OWNER), labelledBy(OWNER, "2026-10-09T13:00:00Z")];
      const before = [headRecord(HEAD_SHA, HOST), headRecord(PUSHED_SHA, HOST, "2026-10-09T12:00:00Z")];

      refused(handOffApproval({ ...PR, headRefOid: PUSHED_SHA }, github({ events, comments: before }).stub, HOST));
      assert.deepEqual(
        handOffApproval({ ...PR, headRefOid: PUSHED_SHA }, github({ events, comments: [...before, headRecord(PUSHED_SHA, HOST, "2026-10-09T13:00:05Z")] }).stub, HOST),
        { approved: true },
      );
    });

    it("counts a record only when the comment opens with the marker, not when it quotes one", () => {
      const quoted: TimestampedComment = { author: HOST, createdAt: RECORDED_AT, body: `> ${approvedHeadComment(HEAD_SHA)}` };
      const later: TimestampedComment = { author: HOST, createdAt: RECORDED_AT, body: `Done.\n${approvedHeadComment(HEAD_SHA)}` };

      refused(handOffApproval(PR, github({ comments: [quoted, later] }).stub, HOST));
    });

    it("compares the head whatever its case", () => {
      assert.deepEqual(handOffApproval({ ...PR, headRefOid: HEAD_SHA.toUpperCase() }, github().stub, HOST), { approved: true });
    });

    it("reads the comments only when the label itself counts", () => {
      const { stub, commentReads } = github({ events: [] });

      refused(handOffApproval(PR, stub, HOST));
      assert.deepEqual(commentReads, []);
    });

    it("doesn't count a record that was edited after it was posted, since a login with push access can edit a comment", () => {
      const edited = headRecord(HEAD_SHA, HOST, RECORDED_AT, "2026-10-09T11:00:00Z");

      refused(handOffApproval(PR, github({ comments: [edited] }).stub, HOST));
    });

    it("doesn't count a record whose edit time is missing or doesn't parse", () => {
      const noEditTime: TimestampedComment = { author: HOST, createdAt: RECORDED_AT, body: approvedHeadComment(HEAD_SHA) };

      refused(handOffApproval(PR, github({ comments: [noEditTime] }).stub, HOST));
      refused(handOffApproval(PR, github({ comments: [headRecord(HEAD_SHA, HOST, RECORDED_AT, "garbage")] }).stub, HOST));
    });

    it("doesn't count a record from a comment with no author", () => {
      refused(handOffApproval(PR, github({ comments: [{ ...headRecord(HEAD_SHA, HOST), author: null as unknown as string }] }).stub, HOST));
    });

    it("measures a record against the latest follow-up label by time, whatever order the events come in", () => {
      const events = [labelledBy(OWNER, "2026-10-09T13:00:00Z"), labelledBy(OWNER)];

      refused(handOffApproval(PR, github({ events }).stub, HOST));
    });

    it("measures a record against the follow-up label only, not a later label of another name", () => {
      const events: IssueEvent[] = [...ownerLabelled, { event: "labeled", actor: OWNER, label: "bug", createdAt: "2026-10-09T13:00:00Z" }];

      assert.deepEqual(handOffApproval(PR, github({ events }).stub, HOST), { approved: true });
    });

    it("measures a record against the follow-up label whatever its case", () => {
      const events: IssueEvent[] = [{ event: "labeled", actor: OWNER, label: "Sandcastle:Follow-Up", createdAt: LABELLED_AT }];

      assert.deepEqual(handOffApproval(PR, github({ events }).stub, HOST), { approved: true });
    });

    it("counts no record when a follow-up label event's time doesn't parse", () => {
      const events: IssueEvent[] = [...ownerLabelled, { event: "labeled", actor: OWNER, label: FOLLOW_UP_LABEL, createdAt: "garbage" }];

      refused(handOffApproval(PR, github({ events }).stub, HOST));
    });

    describe("a head that is a merge of main GitHub made for the host", () => {
      const MERGE_SHA = "e".repeat(40);
      const merges: Record<string, MainMerge> = { [MERGE_SHA]: { firstParent: HEAD_SHA }, [PUSHED_SHA]: { firstParent: MERGE_SHA } };
      const mergeOfMain = (commit: string): MainMerge => merges[commit] ?? { problem: `${commit.slice(0, 7)} isn't a commit GitHub made and signed itself` };

      it("counts on top of a recorded head", () => {
        assert.deepEqual(handOffApproval({ ...PR, headRefOid: MERGE_SHA }, github({ mergeOfMain }).stub, HOST), { approved: true });
      });

      it("counts through several merges", () => {
        assert.deepEqual(handOffApproval({ ...PR, headRefOid: PUSHED_SHA }, github({ mergeOfMain }).stub, HOST), { approved: true });
      });

      it("doesn't ask about a head that is recorded itself", () => {
        const { stub, mergeReads } = github({ mergeOfMain });

        handOffApproval(PR, stub, HOST);

        assert.deepEqual(mergeReads, []);
      });

      it("is refused, with GitHub's reason, when the head isn't such a merge", () => {
        const reason = refused(handOffApproval({ ...PR, headRefOid: "c".repeat(40) }, github({ mergeOfMain }).stub, HOST));

        assert.match(reason, /ccccccc isn't a commit GitHub made and signed itself/);
      });

      it("is refused when the merges lead to no recorded head", () => {
        const loop = (commit: string): MainMerge => ({ firstParent: commit === "1".repeat(40) ? "2".repeat(40) : "1".repeat(40) });

        refused(handOffApproval({ ...PR, headRefOid: "1".repeat(40) }, github({ mergeOfMain: loop }).stub, HOST));
      });

      it("looks through at most MAX_MAIN_MERGES merges", () => {
        const { stub, mergeReads } = github({ mergeOfMain: (commit) => ({ firstParent: `${commit.slice(1)}0` }) });

        refused(handOffApproval({ ...PR, headRefOid: "f".repeat(40) }, stub, HOST));
        assert.equal(mergeReads.length, MAX_MAIN_MERGES);
      });

      // A chain of `depth` merges whose last first parent is the recorded head.
      const chainOf = (depth: number) => {
        const shas = Array.from({ length: depth }, (_, i) => String(i + 1).repeat(40).slice(0, 40));
        const next: Record<string, string> = {};
        shas.forEach((sha, i) => (next[sha] = i === depth - 1 ? HEAD_SHA : shas[i + 1]!));
        return { head: shas[0]!, mergeOfMain: (commit: string): MainMerge => ({ firstParent: next[commit]! }) };
      };

      it("counts a recorded head exactly MAX_MAIN_MERGES merges down", () => {
        const { head, mergeOfMain: chain } = chainOf(MAX_MAIN_MERGES);
        const { stub, mergeReads } = github({ mergeOfMain: chain });

        assert.deepEqual(handOffApproval({ ...PR, headRefOid: head }, stub, HOST), { approved: true });
        assert.equal(mergeReads.length, MAX_MAIN_MERGES);
      });

      it("refuses a recorded head one merge further down, and says why", () => {
        const { head, mergeOfMain: chain } = chainOf(MAX_MAIN_MERGES + 1);
        const { stub, mergeReads } = github({ mergeOfMain: chain });

        const reason = refused(handOffApproval({ ...PR, headRefOid: head }, stub, HOST));

        assert.equal(mergeReads.length, MAX_MAIN_MERGES);
        assert.match(reason, new RegExp(`\\(more than ${MAX_MAIN_MERGES} merges of main on top of the last recorded head\\)`));
      });

      it("records the head it reached through merges, so the next walk starts there", () => {
        const { stub, recordings } = github({ mergeOfMain });

        handOffApproval({ ...PR, headRefOid: PUSHED_SHA.toUpperCase() }, stub, HOST);

        assert.deepEqual(recordings, [{ number: 201, head: PUSHED_SHA }]);
      });

      it("records nothing for a head that is recorded itself", () => {
        const { stub, recordings } = github({ mergeOfMain });

        handOffApproval(PR, stub, HOST);

        assert.deepEqual(recordings, []);
      });

      it("records nothing for a head that is refused", () => {
        const { stub, recordings } = github({ mergeOfMain });

        refused(handOffApproval({ ...PR, headRefOid: "c".repeat(40) }, stub, HOST));

        assert.deepEqual(recordings, []);
      });

      it("counts through a merge case-insensitively", () => {
        assert.deepEqual(handOffApproval({ ...PR, headRefOid: MERGE_SHA.toUpperCase() }, github({ mergeOfMain }).stub, HOST), { approved: true });
      });

      it("is not asked when the label itself doesn't count", () => {
        const { stub, mergeReads } = github({ events: [], mergeOfMain });

        refused(handOffApproval({ ...PR, headRefOid: MERGE_SHA }, stub, HOST));
        assert.deepEqual(mergeReads, []);
      });
    });

    it("reads the PR's comments for the PR's own number, once", () => {
      const { stub, commentReads } = github();

      handOffApproval(PR, stub, HOST);

      assert.deepEqual(commentReads, [201]);
    });
  });
});


describe("sweepPullRequests and hand-off PRs", () => {
  const behind = (overrides: Partial<SweepPullRequest> = {}) => handOffPr({ mergeStateStatus: "BEHIND", ...overrides });
  const owned = (extra: Parameters<typeof stubGithub>[0] = {}): Parameters<typeof stubGithub>[0] => ({
    isOwner: ownerIs(OWNER),
    pullRequestEvents: () => ownerLabelled,
    ...extra,
  });

  it("updates a settled, owner-labelled hand-off PR that's only behind main, and logs that it is followed up as a hand-off", () => {
    const { updatedBranches, github } = stubGithub(owned({ prs: [behind()] }));
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, [{ number: 201, expectedHeadSha: "a".repeat(40) }]);
    assert.ok(
      lines.some((line) => line.includes("PR #201 is followed up as a hand-off") && line.includes(FOLLOW_UP_LABEL)),
      lines.join("\n"),
    );
  });

  describe("following a hand-off PR across a branch update", () => {
    const merged = (commit: string): MainMerge => (commit === "b".repeat(40) ? { firstParent: "a".repeat(40) } : { problem: "not a merge" });

    it("updates a hand-off PR whose head is a merge of main on top of the recorded head, and keeps following it", () => {
      const { updatedBranches, github } = stubGithub(
        owned({ prs: [behind({ headRefOid: "b".repeat(40), reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }] })], pullRequestComments: () => [headRecord("a".repeat(40), HOST)], mergeOfMain: merged }),
      );

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(updatedBranches, [{ number: 201, expectedHeadSha: "b".repeat(40) }]);
    });

    it("records the head it reached through the merge, as the host", () => {
      const recorded: { number: number; head: string }[] = [];
      const { github } = stubGithub(
        owned({
          prs: [behind({ headRefOid: "b".repeat(40), reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }] })],
          pullRequestComments: () => [headRecord("a".repeat(40), HOST)],
          mergeOfMain: merged,
          recordApprovedHead: (number, head) => void recorded.push({ number, head }),
        }),
      );

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(recorded, [{ number: 201, head: "b".repeat(40) }]);
    });

    it("records nothing for a hand-off PR whose head is recorded itself", () => {
      const recorded: string[] = [];
      const { github } = stubGithub(owned({ prs: [behind()], recordApprovedHead: (_number, head) => void recorded.push(head) }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(recorded, []);
    });

    it("logs a record that can't be posted, and still sweeps the PR", () => {
      const lines: string[] = [];
      const { updatedBranches, github } = stubGithub(
        owned({
          prs: [behind({ headRefOid: "b".repeat(40), reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }] })],
          pullRequestComments: () => [headRecord("a".repeat(40), HOST)],
          mergeOfMain: merged,
          recordApprovedHead: () => {
            throw new Error("post failed");
          },
        }),
      );

      sweepPullRequests(github, (line) => lines.push(line), NOW);

      assert.ok(lines.some((line) => line.includes("Couldn't record PR #201's head bbbbbbb") && line.includes("post failed")), lines.join("\n"));
      assert.deepEqual(updatedBranches, [{ number: 201, expectedHeadSha: "b".repeat(40) }]);
    });

    describe("when a read of the approval throws", () => {
      // The first PR's head is a commit nobody recorded, so its approval reads the merge; the second PR is recorded and settled.
      const unrecorded = () => behind({ headRefOid: "b".repeat(40), reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }] });
      const second = () => behind({ number: 202, id: "PR_202", headRefName: "chore/another-tidy" });
      const comments = (_number: number) => [headRecord("a".repeat(40), HOST)];

      it("leaves the PR unapproved and unswept when the read of its head's merge fails, and still sweeps the others", () => {
        const lines: string[] = [];
        const recorded: number[] = [];
        const { updatedBranches, github } = stubGithub(
          owned({
            prs: [unrecorded(), second()],
            pullRequestComments: comments,
            mergeOfMain: () => {
              throw new Error("gh api failed: HTTP 502");
            },
            recordApprovedHead: (number) => void recorded.push(number),
          }),
        );

        const { needsPass } = sweepPullRequests(github, (line) => lines.push(line), NOW);

        assert.ok(lines.some((line) => line.includes("Couldn't follow up PR #201") && line.includes("HTTP 502")), lines.join("\n"));
        assert.deepEqual(updatedBranches, [{ number: 202, expectedHeadSha: "a".repeat(40) }]);
        assert.deepEqual(recorded, []);
        assert.ok(!needsPass.includes(201));
      });

      it("leaves the PR unapproved and unswept when the read of its comments fails, and still sweeps the others", () => {
        const lines: string[] = [];
        const { updatedBranches, github } = stubGithub(
          owned({
            prs: [unrecorded(), second()],
            pullRequestComments: (number) => {
              if (number === 201) throw new Error("gh api failed: HTTP 502");
              return comments(number);
            },
          }),
        );

        const { needsPass } = sweepPullRequests(github, (line) => lines.push(line), NOW);

        assert.ok(lines.some((line) => line.includes("Couldn't follow up PR #201") && line.includes("HTTP 502")), lines.join("\n"));
        assert.deepEqual(updatedBranches, [{ number: 202, expectedHeadSha: "a".repeat(40) }]);
        assert.ok(!needsPass.includes(201));
      });
    });

    it("restarts the merge count at a recorded head, so later merges are followed again", () => {
      // The first sweep walks MAX_MAIN_MERGES merges and records the head; MAX_MAIN_MERGES more merges then sit on top of that record.
      const shas = Array.from({ length: MAX_MAIN_MERGES * 2 }, (_, i) => (i + 16).toString(16).repeat(20));
      const chain = (commit: string): MainMerge => {
        const i = shas.indexOf(commit);
        return i === -1 ? { problem: "not a merge" } : { firstParent: i === shas.length - 1 ? "a".repeat(40) : shas[i + 1]! };
      };
      // shas[0] is the newest: five merges above shas[5], which the first sweep records; shas[5] sits five merges above the label's head.
      const comments = [headRecord("a".repeat(40), HOST)];
      const recordInto = (_number: number, head: string) => void comments.push(headRecord(head, HOST));
      const first = stubGithub(owned({ prs: [behind({ headRefOid: shas[5]! })], pullRequestComments: () => comments, mergeOfMain: chain, recordApprovedHead: recordInto }));
      const second = stubGithub(owned({ prs: [behind({ headRefOid: shas[0]! })], pullRequestComments: () => comments, mergeOfMain: chain, recordApprovedHead: recordInto }));
      const lines: string[] = [];

      sweepPullRequests(first.github, () => {}, NOW);
      sweepPullRequests(second.github, (line) => lines.push(line), NOW);

      assert.deepEqual(comments.map((comment) => approvedHeadOf(comment.body)), ["a".repeat(40), shas[5], shas[0]]);
      assert.ok(!lines.some((line) => line.includes("isn't swept")), lines.join("\n"));
    });

    it("sweeps nothing, and updates nothing, for a hand-off PR whose head isn't recorded and isn't such a merge", () => {
      const { updatedBranches, github } = stubGithub(owned({ prs: [behind()], pullRequestComments: () => [] }));
      const lines: string[] = [];

      sweepPullRequests(github, (line) => lines.push(line), NOW);

      assert.deepEqual(updatedBranches, []);
      assert.ok(lines.some((line) => line.includes("PR #201 isn't swept") && line.includes("recorded as approved")), lines.join("\n"));
    });
  });

  it("asks Copilot again for a hand-off PR that has no review, as it does for a Sandcastle PR", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const { requestedReviews, github } = stubGithub(
      owned({ prs: [handOffPr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] })] }),
    );

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, ["PR_201"]);
  });

  it("flags a conflicted hand-off PR for a pass, with a target carrying the PR's title and description and no issue number", () => {
    const { github } = stubGithub(owned({ prs: [handOffPr({ mergeStateStatus: "DIRTY", headRefOid: "b".repeat(40) })] }));

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.needsPass, [201]);
    assert.deepEqual(result.passes, [
      {
        number: 201,
        id: "PR_201",
        headRefName: "chore/tidy-the-build",
        headRefOid: "b".repeat(40),
        handOff: { title: "chore: Tidy the build", body: "Tidies the build scripts." },
        reasons: ["it has merge conflicts"],
        conflicted: true,
      },
    ]);
    assert.ok(!("issueNumber" in result.passes[0]!) || result.passes[0]!.issueNumber === undefined);
  });

  it("flags a hand-off PR with a red check for a pass", () => {
    const red = [{ name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" }];
    const { github } = stubGithub(owned({ prs: [handOffPr({ checks: red })] }));

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.needsPass, [201]);
    assert.deepEqual(result.passes[0]!.reasons, ["check lint is red"]);
  });

  it("flags a hand-off PR with an unresolved bot thread, and not when a session already answered it", () => {
    const botThreads = [{ resolved: false, byBot: true, author: COPILOT_REVIEWER }];
    const open = stubGithub(owned({ prs: [handOffPr({ threads: botThreads })] }));
    const answered = stubGithub(
      owned({
        prs: [handOffPr({ threads: botThreads })],
        reviewThreads: () => [thread(COPILOT_REVIEWER, true, [{ author: HOST, body: `Fixed.\n\n${SESSION_REPLY_MARKER}` }])],
      }),
    );

    assert.deepEqual(sweepPullRequests(open.github, () => {}, NOW).needsPass, [201]);
    assert.deepEqual(sweepPullRequests(answered.github, () => {}, NOW).needsPass, []);
  });

  it("doesn't flag a Sandcastle PR for a bot thread a session answered either", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: true, author: COPILOT_REVIEWER }] })],
      isOwner: ownerIs(HOST),
      reviewThreads: () => [thread(COPILOT_REVIEWER, true, [{ author: HOST, body: `Fixed.\n\n${SESSION_REPLY_MARKER}` }])],
    });

    assert.deepEqual(sweepPullRequests(github, () => {}, NOW).needsPass, []);
  });

  it("counts a thread a session answered as waiting on the owner in the run report", () => {
    const { github } = stubGithub(
      owned({
        prs: [handOffPr({ threads: [{ resolved: false, byBot: true, author: COPILOT_REVIEWER }] })],
        reviewThreads: () => [thread(COPILOT_REVIEWER, true, [{ author: HOST, body: `Fixed.\n\n${SESSION_REPLY_MARKER}` }])],
      }),
    );
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), [{ pr: 201, threads: 0, answered: 1 }]);
  });

  it("leaves an unlabelled PR that isn't Sandcastle's alone, reading neither its events nor its edits", () => {
    const eventReads: number[] = [];
    const editReads: number[] = [];
    const { updatedBranches, github } = stubGithub(
      owned({
        prs: [behind({ labels: [] })],
        pullRequestEvents: (number) => (eventReads.push(number), ownerLabelled),
        pullRequestBodyEdits: (number) => (editReads.push(number), []),
      }),
    );
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(eventReads, []);
    assert.deepEqual(editReads, []);
    assert.ok(lines.some((line) => line.includes("#201") && line.includes("isn't swept")), lines.join("\n"));
  });

  it("leaves a labelled PR alone in a run without the default queue scope, saying why", () => {
    const { updatedBranches, github } = stubGithub(owned({ prs: [behind()], followsHandOffs: false }));
    const lines: string[] = [];

    const result = sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(result, { needsPass: [], passes: [] });
    assert.ok(lines.some((line) => line.includes("#201") && line.includes("default queue scope")), lines.join("\n"));
  });

  it("leaves alone a PR labelled by someone who isn't the owner, saying the label doesn't count", () => {
    const { updatedBranches, github } = stubGithub(owned({ prs: [behind()], pullRequestEvents: () => [labelledBy("a-stranger")] }));
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, []);
    assert.ok(lines.some((line) => line.includes("#201") && line.includes("doesn't count")), lines.join("\n"));
  });

  it("leaves alone a PR labelled by an actor the owner check can't place (lookup undefined)", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [behind()],
      isOwner: (login) => (login === OWNER ? true : undefined),
      pullRequestEvents: () => [labelledBy("unknown-actor")],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("leaves alone a PR whose description a stranger edited after the owner's label", () => {
    const { updatedBranches, github } = stubGithub(
      owned({ prs: [behind()], pullRequestBodyEdits: () => [{ editor: "a-stranger", editedAt: "2026-10-09T11:00:00Z" }] }),
    );

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("leaves alone a PR a stranger renamed after the owner's label, and follows it again once the owner re-adds the label", () => {
    const renamed: IssueEvent = { event: "renamed", actor: "a-stranger", label: null, createdAt: "2026-10-09T11:00:00Z" };
    const before = stubGithub(owned({ prs: [behind()], pullRequestEvents: () => [...ownerLabelled, renamed] }));
    const after = stubGithub(
      owned({
        prs: [behind()],
        pullRequestEvents: () => [...ownerLabelled, renamed, labelledBy(OWNER, "2026-10-09T12:00:00Z")],
        pullRequestComments: () => [headRecord("a".repeat(40), HOST, "2026-10-09T12:00:05Z")],
      }),
    );

    sweepPullRequests(before.github, () => {}, NOW);
    sweepPullRequests(after.github, () => {}, NOW);

    assert.deepEqual(before.updatedBranches, []);
    assert.equal(after.updatedBranches.length, 1);
  });

  for (const [name, overrides] of [
    ["a fork", { isCrossRepository: true }],
    ["into a branch other than main", { baseRefName: "develop" }],
    ["a draft", { isDraft: true }],
    ["labelled sandcastle:needs-human", { labels: [FOLLOW_UP_LABEL, "sandcastle:needs-human"] }],
    ["labelled sandcastle:building", { labels: [FOLLOW_UP_LABEL, "sandcastle:building"] }],
    ["truncated", { truncated: true }],
    ["on a branch scripts/check-branch-name.sh refuses", { headRefName: "docs/release-notes" }],
  ] as [string, Partial<SweepPullRequest>][]) {
    it(`leaves a labelled PR alone when it is ${name}`, () => {
      const { updatedBranches, github } = stubGithub(owned({ prs: [behind(overrides)] }));

      const result = sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(result, { needsPass: [], passes: [] });
    });
  }

  it("leaves a labelled PR alone while the issue its branch names is being built", () => {
    const { updatedBranches, github } = stubGithub(
      owned({ prs: [behind({ headRefName: "feature/43-owner-change" })], issues: [{ number: 43, labels: ["sandcastle:building"] }] }),
    );

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("reads a hand-off PR's events once, the one read serving both the approval and the needs-human check", () => {
    const eventReads: number[] = [];
    const { github } = stubGithub(owned({ prs: [behind()], pullRequestEvents: (number) => (eventReads.push(number), ownerLabelled) }));

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(eventReads, [201]);
  });

  it("reads the events of a Sandcastle issue's PR once too", () => {
    const eventReads: number[] = [];
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], pullRequestEvents: (number) => (eventReads.push(number), []) });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(eventReads, [101]);
  });

  it("puts back sandcastle:needs-human a stranger removed from a hand-off PR, and leaves the PR alone", () => {
    const strangerUnlabelled: IssueEvent = { event: "unlabeled", actor: "a-stranger", label: "sandcastle:needs-human", createdAt: "2026-10-09T12:00:00Z" };
    const { addedPrLabels, updatedBranches, github } = stubGithub(owned({ prs: [behind()], pullRequestEvents: () => [...ownerLabelled, strangerUnlabelled] }));

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(addedPrLabels, [{ number: 201, label: "sandcastle:needs-human" }]);
    assert.deepEqual(updatedBranches, []);
  });

  it("logs a failed read of the approval and still sweeps the other PRs", () => {
    const failing = behind();
    const ok = pr({ number: 102, id: "PR_102", headRefName: "feature/43-add-sorting", mergeStateStatus: "BEHIND" });
    const { updatedBranches, github } = stubGithub(
      owned({
        prs: [failing, ok],
        issues: [{ number: 42, labels: [] }, { number: 43, labels: [] }],
        pullRequestEvents: (number) => {
          if (number === 201) throw new Error("gh api failed: HTTP 502");
          return [];
        },
      }),
    );
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches.map((update) => update.number), [102]);
    assert.ok(lines.some((line) => line.includes("#201") && line.includes("502") && line.includes("swept again next round")), lines.join("\n"));
  });

  it("still sweeps a Sandcastle PR as before beside a hand-off PR", () => {
    const sandcastlePr = pr({ number: 102, id: "PR_102", mergeStateStatus: "BEHIND" });
    const { updatedBranches, github } = stubGithub(owned({ prs: [behind(), sandcastlePr] }));

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches.map((update) => update.number).toSorted(), [102, 201]);
  });

  it("passes a Sandcastle PR's target with its issue number and no hand-off", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "DIRTY" })] });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.equal(result.passes[0]!.issueNumber, 42);
    assert.equal(result.passes[0]!.handOff, undefined);
  });
});

describe("startFromMain", () => {
  const issueNumber = 42;
  const base = "m".repeat(40);
  const closedHead = "c".repeat(40);
  // A person removed sandcastle:needs-human after the closed PR's closedAt
  // (closedPr's default), re-queueing the issue to rebuild.
  const requeued: TimelineLabelEvent[] = [{ event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-02T00:00:00Z" }];

  function stubFollowUpGithub(closed: ClosedPullRequest[], timeline: TimelineLabelEvent[] = requeued, failHandBack?: Error) {
    const handBacks: { issueNumber: number; reason: string; body: string }[] = [];
    const github: Pick<FollowUpGitHub, "hostLogin" | "closedPullRequests" | "labelTimeline" | "handBack"> = {
      hostLogin: () => HOST,
      closedPullRequests: () => closed,
      labelTimeline: () => timeline,
      handBack: (number, reason, body) => {
        handBacks.push({ issueNumber: number, reason, body });
        if (failHandBack) throw failHandBack;
      },
    };
    return { github, handBacks };
  }

  // Every ref holds the closed head and base has none of it, so a call that
  // reaches the deletes deletes all three.
  function recordingRefs() {
    const calls: string[] = [];
    const refs: BranchRefs = {
      remoteHead: (b) => {
        calls.push(`remoteHead ${b}`);
        return "r".repeat(40);
      },
      localHead: (ref) => {
        calls.push(`localHead ${ref}`);
        return "l".repeat(40);
      },
      contains: (commit, ancestor) => {
        calls.push(`contains ${commit} ${ancestor}`);
        return false;
      },
      hasCommit: () => true,
      fetchPullHead: (number) => void calls.push(`fetchPullHead ${number}`),
      mergeBase: (commit, other) => {
        calls.push(`mergeBase ${commit} ${other}`);
        return other;
      },
      deleteLocalBranch: (b) => void calls.push(`deleteLocalBranch ${b}`),
      deleteRef: (ref) => void calls.push(`deleteRef ${ref}`),
      deleteRemote: (b, sha) => void calls.push(`deleteRemote ${b} ${sha}`),
    };
    return { refs, calls };
  }

  it("returns undefined when the issue has no PR closed without merging", () => {
    const { refs } = recordingRefs();

    const result = startFromMain(issueNumber, BRANCH, base, stubFollowUpGithub([]).github, refs);

    assert.equal(result, undefined);
  });

  it("returns undefined when the closed PR's branch isn't the one being built", () => {
    const { refs } = recordingRefs();
    const { github } = stubFollowUpGithub([closedPr({ headRefName: "feature/42-another-attempt" })]);

    const result = startFromMain(issueNumber, BRANCH, base, github, refs);

    assert.equal(result, undefined);
  });

  it("discards the closed PR's work, judged against its head, once a person re-queued the issue", () => {
    const { refs, calls } = recordingRefs();
    const { github, handBacks } = stubFollowUpGithub([closedPr({ number: 99, headRefOid: closedHead })]);

    const result = startFromMain(issueNumber, BRANCH, base, github, refs);

    assert.deepEqual(result, { pr: 99, deleted: [`refs/heads/${BRANCH}`, `refs/remotes/origin/${BRANCH}`, `origin/${BRANCH}`] });
    assert.ok(calls.includes(`contains ${base} ${closedHead}`), calls.join("\n"));
    assert.ok(calls.includes(`mergeBase ${"l".repeat(40)} ${closedHead}`), calls.join("\n"));
    assert.deepEqual(handBacks, []);
  });

  // The PR closed after this round's sweep, or the sweep's hand-back failed:
  // nobody agreed to a rebuild, so the work stays and the issue goes back.
  it("hands the issue back and stops the build, deleting nothing, when nobody re-queued it since the PR closed", () => {
    const { refs, calls } = recordingRefs();
    const { github, handBacks } = stubFollowUpGithub([closedPr({ number: 99, closedAt: "2026-10-03T00:00:00Z" })]);

    assert.throws(() => startFromMain(issueNumber, BRANCH, base, github, refs), /PR #99 was closed without merging/);
    assert.deepEqual(handBacks, [
      { issueNumber, reason: "PR #99 was closed without merging", body: closedPrHandBackComment(closedPr({ number: 99 })) },
    ]);
    assert.ok(!calls.some((call) => call.startsWith("delete")), calls.join("\n"));
  });

  it("still stops the build, deleting nothing, when that hand-back fails", () => {
    const { refs, calls } = recordingRefs();
    const { github } = stubFollowUpGithub([closedPr({ number: 99 })], [], new Error("gh: HTTP 502"));

    assert.throws(() => startFromMain(issueNumber, BRANCH, base, github, refs), /HTTP 502/);
    assert.ok(!calls.some((call) => call.startsWith("delete")), calls.join("\n"));
  });
});

describe("liveMergeOfMain", () => {
  it("asks mainMergeOf about the commit for the signed-in host's login", () => {
    const asked: string[][] = [];
    const merge = (commit: string, host: string): MainMerge => {
      asked.push([commit, host]);
      return { firstParent: "a".repeat(40) };
    };

    assert.deepEqual(liveMergeOfMain("b".repeat(40), () => "the-host", merge), { firstParent: "a".repeat(40) });
    assert.deepEqual(asked, [["b".repeat(40), "the-host"]]);
  });
});

describe("liveFollowUpGitHub.followsHandOffs", () => {
  // The gate that keeps a SANDCASTLE_ISSUE run or a Sandcastle:local run off hand-off PRs: wired to the active queue scope.
  // queue.mts has no way to unset the scope, so one that was unset before stays at the last scope applied here.
  function withScope<T>(scope: QueueScope, read: () => T): T {
    let before: QueueScope | undefined;
    try {
      before = activeQueueScope();
    } catch {
      before = undefined;
    }
    useQueueScope(scope);
    try {
      return read();
    } finally {
      if (before !== undefined) useQueueScope(before);
    }
  }

  it("follows hand-offs on the default queue", () => {
    assert.equal(withScope({ kind: "label", label: QUEUE_LABEL }, () => liveFollowUpGitHub.followsHandOffs()), true);
  });

  it("doesn't on the local queue's label or an issue scope", () => {
    assert.equal(withScope({ kind: "label", label: LOCAL_QUEUE_LABEL }, () => liveFollowUpGitHub.followsHandOffs()), false);
    assert.equal(withScope({ kind: "issue", number: 7 }, () => liveFollowUpGitHub.followsHandOffs()), false);
  });
});

// ---------------------------------------------------------------------------
// The sweep's per-PR steps, shared with `pnpm run sandcastle:status` (lib/status.mts), which must give the sweep's own answer
// ---------------------------------------------------------------------------

describe("sweepContext", () => {
  it("is what the sweep decides each PR from: the in-scope issues, the host, the issues being built and whether hand-offs are followed", () => {
    const { github } = stubGithub({
      host: "the-host",
      issues: [
        { number: 42, labels: [] },
        { number: 43, labels: ["Sandcastle:Building"] },
        { number: 44, labels: ["sandcastle:needs-human"] },
      ],
      followsHandOffs: false,
    });

    const { context, issues } = readSweepContext(github);

    assert.deepEqual([...context.inScope].sort(), [42, 43, 44]);
    assert.deepEqual([...context.building], [43]);
    assert.equal(context.host, "the-host");
    assert.equal(context.followsHandOffs, false);
    assert.deepEqual(issues, [
      { number: 42, labels: [] },
      { number: 43, labels: ["Sandcastle:Building"] },
      { number: 44, labels: ["sandcastle:needs-human"] },
    ]);
  });

  it("reads only the host's login, the in-scope issues and whether hand-offs are followed", () => {
    const calls: string[] = [];

    readSweepContext({
      hostLogin: () => (calls.push("hostLogin"), HOST),
      inScopeIssues: () => (calls.push("inScopeIssues"), []),
      followsHandOffs: () => (calls.push("followsHandOffs"), true),
    });

    assert.deepEqual([...calls].sort(), ["followsHandOffs", "hostLogin", "inScopeIssues"]);
  });

  it("gives sweepPullRequests' own reading: a PR its issue is being built for is skipped by sweepSkipReason with the context's sets", () => {
    const { github } = stubGithub({ issues: [{ number: 42, labels: ["sandcastle:building"] }] });
    const { context } = readSweepContext(github);

    assert.match(sweepSkipReason(pr(), context.inScope, context.host, context.building) ?? "", /sandcastle:building/);
  });
});

describe("admitToSweep", () => {
  const owned = (extra: Parameters<typeof stubGithub>[0] = {}) => stubGithub({ isOwner: ownerIs(OWNER), ...extra });
  const context = (overrides: Partial<SweepContext> = {}) => ({ inScope: IN_SCOPE, host: HOST, building: new Set<number>(), followsHandOffs: true, ...overrides });
  // An events thunk that counts its reads.
  const eventsRead = (events: IssueEvent[] = []) => {
    let reads = 0;
    return { events: () => (reads++, events), reads: () => reads };
  };

  it("admits a Sandcastle issue's PR as the issue's, without reading its events", () => {
    const { github } = owned();
    const { events, reads } = eventsRead();

    assert.deepEqual(admitToSweep(pr(), context(), github, events, () => {}), { subject: { kind: "issue", issueNumber: 42 } });
    assert.equal(reads(), 0);
  });

  it("answers with the sweep's own reason for a PR it skips", () => {
    const { github } = owned();
    const { events } = eventsRead();

    assert.deepEqual(admitToSweep(pr({ isDraft: true }), context(), github, events, () => {}), { skip: sweepSkipReason(pr({ isDraft: true }), IN_SCOPE, HOST) });
  });

  it("admits an owner-labelled hand-off PR, reading its events through the caller's thunk", () => {
    const { github } = owned({ prs: [handOffPr()], pullRequestComments: () => [headRecord(HEAD_SHA, HOST)] });
    const { events, reads } = eventsRead(ownerLabelled);

    assert.deepEqual(admitToSweep(handOffPr(), context(), github, events, () => {}), { subject: { kind: "hand-off" } });
    assert.ok(reads() >= 1);
  });

  it("skips a hand-off PR whose label doesn't count, saying why", () => {
    const { github } = owned({ prs: [handOffPr()], pullRequestComments: () => [headRecord(PUSHED_SHA, HOST)] });
    const { events } = eventsRead(ownerLabelled);

    const result = admitToSweep(handOffPr(), context(), github, events, () => {});

    assert.match("skip" in result ? result.skip : "", new RegExp(`its ${FOLLOW_UP_LABEL} label doesn't count`));
  });

  it("records the head it reached through a merge of main, as the sweep does", () => {
    const recorded: { number: number; head: string }[] = [];
    const head = "b".repeat(40);
    const { github } = owned({
      pullRequestComments: () => [headRecord(HEAD_SHA, HOST)],
      mergeOfMain: (commit) => (commit === head ? { firstParent: HEAD_SHA } : { problem: "not a merge" }),
      recordApprovedHead: (number, recordedHead) => void recorded.push({ number, head: recordedHead }),
    });
    const { events } = eventsRead(ownerLabelled);

    const result = admitToSweep(handOffPr({ headRefOid: head }), context(), github, events, () => {});

    assert.deepEqual(result, { subject: { kind: "hand-off" } });
    assert.deepEqual(recorded, [{ number: 201, head }]);
  });

  it("logs a record that can't be posted, and still admits the PR", () => {
    const head = "b".repeat(40);
    const lines: string[] = [];
    const { github } = owned({
      pullRequestComments: () => [headRecord(HEAD_SHA, HOST)],
      mergeOfMain: (commit) => (commit === head ? { firstParent: HEAD_SHA } : { problem: "not a merge" }),
      recordApprovedHead: () => {
        throw new Error("post failed");
      },
    });
    const { events } = eventsRead(ownerLabelled);

    const result = admitToSweep(handOffPr({ headRefOid: head }), context(), github, events, (line) => lines.push(line));

    assert.deepEqual(result, { subject: { kind: "hand-off" } });
    assert.ok(lines.some((line) => line.includes("Couldn't record PR #201's head bbbbbbb") && line.includes("post failed")), lines.join("\n"));
  });

  it("takes only the reads the approval needs from GitHub", () => {
    const github: AdmissionGitHub = {
      pullRequestBodyEdits: () => [],
      pullRequestComments: () => [headRecord(HEAD_SHA, HOST)],
      mergeOfMain: () => ({ problem: "not a merge" }),
      recordApprovedHead: () => {},
      isOwner: ownerIs(OWNER),
      repositoryOwner: () => OWNER,
    };

    assert.deepEqual(admitToSweep(handOffPr(), context(), github, () => ownerLabelled, () => {}), { subject: { kind: "hand-off" } });
  });
});

describe("approvalLapsedComment", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";

  it("opens with the marker and the full head, so a later sweep can tell which head it was posted for", () => {
    assert.ok(approvalLapsedComment(head).startsWith(`${APPROVAL_LAPSED_MARKER} ${head} -->`), approvalLapsedComment(head));
  });

  it("is not the comment that records a head as approved", () => {
    assert.equal(approvedHeadOf(approvalLapsedComment(head)), undefined);
    assert.ok(!approvalLapsedComment(head).includes(APPROVED_HEAD_MARKER));
  });

  it("tells the owner the PR is no longer followed up, from which head, and to remove and re-add the label once they have looked at the branch", () => {
    const body = approvalLapsedComment(head);

    assert.match(body, /no longer/i);
    assert.ok(body.includes(head.slice(0, 7)), body);
    assert.ok(body.includes(FOLLOW_UP_LABEL), body);
    assert.match(body, /remove and re-add/i);
  });

  it("differs for another head", () => {
    assert.notEqual(approvalLapsedComment(head), approvalLapsedComment("b".repeat(40)));
  });
});

describe("sweepPullRequests comments on a hand-off PR whose follow-up approval lapsed", () => {
  const behind = (overrides: Partial<SweepPullRequest> = {}) => handOffPr({ mergeStateStatus: "BEHIND", ...overrides });
  const owned = (extra: Parameters<typeof stubGithub>[0] = {}): Parameters<typeof stubGithub>[0] => ({
    isOwner: ownerIs(OWNER),
    pullRequestEvents: () => ownerLabelled,
    ...extra,
  });
  // The comments of a PR as GitHub keeps them: what the host posts is read back by the next sweep.
  const thread201 = (initial: TimestampedComment[] = []) => {
    const comments = [...initial];
    return {
      comments,
      options: {
        pullRequestComments: () => comments,
        commentOnPullRequest: (_number: number, body: string) =>
          void comments.push({ author: HOST, body, createdAt: "2026-10-10T11:00:00Z", updatedAt: "2026-10-10T11:00:00Z" }),
      },
    };
  };

  it("comments once on the PR when its head isn't one the host recorded", () => {
    const { github, postedComments } = stubGithub(owned({ prs: [behind()], pullRequestComments: () => [] }));

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(postedComments, [{ number: 201, body: approvalLapsedComment(HEAD_SHA) }]);
  });

  it("comments only once across sweeps of the same head", () => {
    const { comments, options } = thread201();
    const { github, postedComments } = stubGithub(owned({ prs: [behind()], ...options }));

    sweepPullRequests(github, () => {}, NOW);
    sweepPullRequests(github, () => {}, NOW);
    sweepPullRequests(github, () => {}, NOW);

    assert.equal(postedComments.length, 1);
    assert.equal(comments.length, 1);
  });

  it("still logs that the PR isn't swept on the sweeps after the comment", () => {
    const { options } = thread201();
    const { github } = stubGithub(owned({ prs: [behind()], ...options }));
    const lines: string[] = [];

    sweepPullRequests(github, () => {}, NOW);
    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.ok(lines.some((line) => line.includes("PR #201 isn't swept") && line.includes("recorded as approved")), lines.join("\n"));
  });

  it("does not follow the PR up on the sweep that comments", () => {
    const { github, updatedBranches } = stubGithub(owned({ prs: [behind()], pullRequestComments: () => [] }));

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(result, { needsPass: [], passes: [] });
  });

  it("comments again when a later push leaves another unrecorded head", () => {
    const { options } = thread201();
    const first = stubGithub(owned({ prs: [behind()], ...options }));
    const second = stubGithub(owned({ prs: [behind({ headRefOid: PUSHED_SHA })], ...options }));

    sweepPullRequests(first.github, () => {}, NOW);
    sweepPullRequests(second.github, () => {}, NOW);

    assert.deepEqual(first.postedComments, [{ number: 201, body: approvalLapsedComment(HEAD_SHA) }]);
    assert.deepEqual(second.postedComments, [{ number: 201, body: approvalLapsedComment(PUSHED_SHA) }]);
  });

  it("comments despite the same notice from someone who isn't the host, which anyone can post", () => {
    const forged: TimestampedComment = { author: "a-stranger", body: approvalLapsedComment(HEAD_SHA), createdAt: RECORDED_AT, updatedAt: RECORDED_AT };
    const { github, postedComments } = stubGithub(owned({ prs: [behind()], pullRequestComments: () => [forged] }));

    sweepPullRequests(github, () => {}, NOW);

    assert.equal(postedComments.length, 1);
  });

  it("comments on every such PR, each on its own head", () => {
    const other = behind({ number: 202, id: "PR_202", headRefName: "chore/another-tidy", headRefOid: PUSHED_SHA });
    const { github, postedComments } = stubGithub(owned({ prs: [behind(), other], pullRequestComments: () => [] }));

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(postedComments, [
      { number: 201, body: approvalLapsedComment(HEAD_SHA) },
      { number: 202, body: approvalLapsedComment(PUSHED_SHA) },
    ]);
  });

  it("logs a comment that can't be posted, still sweeps the other PRs, and tries again on the next sweep", () => {
    const other = behind({ number: 202, id: "PR_202", headRefName: "chore/another-tidy" });
    let failing = true;
    const { github, updatedBranches, postedComments } = stubGithub(
      owned({
        prs: [behind({ headRefOid: "b".repeat(40), reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }] }), other],
        pullRequestComments: (number) => (number === 202 ? [headRecord(HEAD_SHA, HOST)] : []),
        commentOnPullRequest: () => {
          if (failing) throw new Error("gh pr comment failed: HTTP 502");
        },
      }),
    );
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);
    failing = false;
    sweepPullRequests(github, () => {}, NOW);

    assert.ok(lines.some((line) => line.includes("PR #201") && line.includes("HTTP 502")), lines.join("\n"));
    assert.deepEqual(updatedBranches, [{ number: 202, expectedHeadSha: HEAD_SHA }, { number: 202, expectedHeadSha: HEAD_SHA }]);
    assert.deepEqual(postedComments.map((comment) => comment.number), [201, 201]);
  });

  describe("posts nothing", () => {
    it("on a hand-off PR whose head is recorded", () => {
      const { github, postedComments } = stubGithub(owned({ prs: [behind()] }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("on a hand-off PR whose head is reached through a merge of main from a recorded one", () => {
      const head = "b".repeat(40);
      const { github, postedComments } = stubGithub(
        owned({
          prs: [behind({ headRefOid: head, reviews: [{ author: COPILOT_REVIEWER, commitOid: head }] })],
          mergeOfMain: (commit) => (commit === head ? { firstParent: HEAD_SHA } : { problem: "not a merge" }),
        }),
      );

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("when the owner added the label moments ago, since the record may not be posted yet", () => {
      const justNow = new Date(NOW - 60 * 1000).toISOString();
      const { github, postedComments } = stubGithub(owned({ prs: [behind()], pullRequestEvents: () => [labelledBy(OWNER, justNow)], pullRequestComments: () => [] }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("until the label is as old as the grace period, then comments once on a later sweep", () => {
      const labelledAt = NOW - APPROVAL_LAPSED_GRACE_MS + 1000;
      const events = [labelledBy(OWNER, new Date(labelledAt).toISOString())];
      const { options } = thread201();
      const { github, postedComments } = stubGithub(owned({ prs: [behind()], pullRequestEvents: () => events, ...options }));

      sweepPullRequests(github, () => {}, NOW);
      assert.deepEqual(postedComments, []);
      sweepPullRequests(github, () => {}, NOW + 1000);
      sweepPullRequests(github, () => {}, NOW + 2000);

      assert.deepEqual(postedComments, [{ number: 201, body: approvalLapsedComment(HEAD_SHA) }]);
    });

    it("when the record arrives after a sweep inside the grace period", () => {
      const justNow = new Date(NOW - 60 * 1000).toISOString();
      let recorded = false;
      const { github, postedComments } = stubGithub(
        owned({
          prs: [behind()],
          pullRequestEvents: () => [labelledBy(OWNER, justNow)],
          pullRequestComments: () => (recorded ? [headRecord(HEAD_SHA, HOST, new Date(NOW).toISOString())] : []),
        }),
      );

      sweepPullRequests(github, () => {}, NOW);
      recorded = true;
      sweepPullRequests(github, () => {}, NOW + APPROVAL_LAPSED_GRACE_MS);

      assert.deepEqual(postedComments, []);
    });

    it("when the label doesn't count because someone who isn't the owner added it", () => {
      const { github, postedComments } = stubGithub(owned({ prs: [behind()], pullRequestEvents: () => [labelledBy("a-stranger")], pullRequestComments: () => [] }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("when a stranger edited the description after the owner's label", () => {
      const { github, postedComments } = stubGithub(
        owned({
          prs: [behind()],
          pullRequestBodyEdits: () => [{ editor: "a-stranger", editedAt: "2026-10-09T11:00:00Z" }],
          pullRequestComments: () => [],
        }),
      );

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("when someone who is neither the owner nor the host opened the PR", () => {
      const { github, postedComments } = stubGithub(owned({ prs: [behind({ author: "a-stranger" })], pullRequestComments: () => [] }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("when the read of the merge that would reach a recorded head fails, since the head isn't known to be unrecorded", () => {
      const { github, postedComments } = stubGithub(
        owned({
          prs: [behind()],
          pullRequestComments: () => [],
          mergeOfMain: () => {
            throw new Error("gh api failed: HTTP 502");
          },
        }),
      );

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("on a draft hand-off PR with an unrecorded head, which the sweep skips before it reads the approval", () => {
      const { github, postedComments } = stubGithub(owned({ prs: [behind({ isDraft: true })], pullRequestComments: () => [] }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("in a run without the default queue scope, which doesn't follow hand-off PRs", () => {
      const { github, postedComments } = stubGithub(owned({ prs: [behind()], followsHandOffs: false, pullRequestComments: () => [] }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("on a PR without the hand-off label", () => {
      const { github, postedComments } = stubGithub(owned({ prs: [behind({ labels: [] })], pullRequestComments: () => [] }));

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });

    it("on a Sandcastle issue's PR", () => {
      const { github, postedComments } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], pullRequestComments: () => [] });

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(postedComments, []);
    });
  });
});

describe("admitToSweep and the lapsed approval's comment", () => {
  it("posts nothing itself, so the read-only status report that shares it never writes to a PR", () => {
    const github: AdmissionGitHub = {
      pullRequestBodyEdits: () => [],
      pullRequestComments: () => [],
      mergeOfMain: () => ({ problem: "not a merge" }),
      recordApprovedHead: () => {},
      isOwner: ownerIs(OWNER),
      repositoryOwner: () => OWNER,
    };
    const context = { inScope: IN_SCOPE, host: HOST, building: new Set<number>(), followsHandOffs: true };

    const result = admitToSweep(handOffPr(), context, github, () => ownerLabelled, () => {});

    assert.match("skip" in result ? result.skip : "", /recorded as approved/);
  });
});

describe("labelOriginHold", () => {
  const removed = (actor: string | null): IssueEvent => ({ event: "unlabeled", actor, label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" });

  it("is undefined for a PR whose hand-back label nobody removed", () => {
    assert.equal(labelOriginHold({ labels: [] }, [], ownerIs(OWNER)), undefined);
  });

  it("is undefined when the repository owner removed the label", () => {
    assert.equal(labelOriginHold({ labels: [] }, [removed(OWNER)], ownerIs(OWNER)), undefined);
  });

  it("restores a label a stranger removed, with the sweep's reason", () => {
    assert.deepEqual(labelOriginHold({ labels: [] }, [removed("stranger")], ownerIs(OWNER)), {
      kind: "restore",
      label: "sandcastle:needs-human",
      reason: "put back sandcastle:needs-human, which @stranger removed, not the repository owner",
    });
  });

  it("is unknown when the remover can't be checked", () => {
    assert.deepEqual(labelOriginHold({ labels: [] }, [removed("ghost")], () => undefined), { kind: "unknown" });
  });

  it("is undefined while the PR still carries the label", () => {
    assert.equal(labelOriginHold({ labels: ["sandcastle:needs-human"] }, [removed("stranger")], ownerIs(OWNER)), undefined);
  });

  it("puts an unknown check before a restore, as the sweep does", () => {
    const events = [removed("stranger")];
    const isOwner = (login: string | null) => (login === "stranger" ? undefined : login === OWNER);

    assert.deepEqual(labelOriginHold({ labels: [] }, events, isOwner), { kind: "unknown" });
  });
});

describe("withoutAnsweredThreads", () => {
  it("is exported for status: takes out the threads the host answered and counts them", () => {
    const answered = thread("copilot-pull-request-reviewer[bot]", true, [hostReply]);
    const open = { ...thread("copilot-pull-request-reviewer[bot]", true), id: "RT_2" };
    const { github } = stubGithub({ reviewThreads: () => [answered, open] });
    const candidate = pr({ threads: [{ resolved: false, byBot: true, author: "copilot-pull-request-reviewer[bot]" }, { resolved: false, byBot: true, author: "copilot-pull-request-reviewer[bot]" }] });

    const result = withoutAnsweredThreads(candidate, github, HOST);

    assert.equal(result.answered, 1);
    assert.equal(result.pr.threads.length, 1);
  });

  it("reads no threads for a PR with no unresolved bot or owner thread", () => {
    const { github, reviewThreadCalls } = stubGithub();

    assert.equal(withoutAnsweredThreads(pr(), github, HOST).answered, 0);
    assert.deepEqual(reviewThreadCalls, []);
  });

  it("throws when the threads can't be read, for a PR that isn't DIRTY", () => {
    const { github } = stubGithub({
      reviewThreads: () => {
        throw new Error("gh: HTTP 502");
      },
    });

    assert.throws(() => withoutAnsweredThreads(pr({ threads: [{ resolved: false, byBot: true, author: "bot" }] }), github, HOST), /HTTP 502/);
  });
});
