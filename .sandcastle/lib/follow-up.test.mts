import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BranchRefs } from "./branches.mts";
import { COPILOT_REVIEWER, PR_MARKER } from "./config.mts";
import type { ClosedPullRequest, IssueEvent, PullRequestIdentity, TimelineLabelEvent } from "./github.mts";
import {
  closedPrHandBackComment,
  closedWithoutMerging,
  decide,
  followUpPhase,
  isCopilot,
  isSandcastlePullRequest,
  issueNumberOf,
  startFromMain,
  sweepPullRequests,
  sweepSkipReason,
  type FollowUpGitHub,
  type SweepPullRequest,
} from "./follow-up.mts";
import { OutcomeReport, WaitingPrReport } from "./report.mts";

const HOST = "sandcastle-bot";
const BRANCH = "feature/42-add-search";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const IN_SCOPE = new Set([42]);

// A settled, CLEAN, Sandcastle PR on issue #42's branch, reviewed by Copilot
// with every check green; tests override just the fields their scenario
// needs.
function pr(overrides: Partial<SweepPullRequest> = {}): SweepPullRequest {
  return {
    number: 101,
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
});

describe("decide", () => {
  it("waits while a check hasn't completed, saying checks are still running", () => {
    const result = decide(pr({ checks: [{ name: "build", completed: false, green: false, completedAt: null }] }), NOW);

    assert.deepEqual(result, { action: "wait", reason: "checks are still running" });
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
  // must flag it too: otherwise the PR never gets a pass to answer it (#81).
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
}: {
  prs?: SweepPullRequest[];
  closed?: ClosedPullRequest[];
  issues?: { number: number; labels: string[] }[];
  host?: string;
  timelines?: Record<number, TimelineLabelEvent[]>;
  isOwner?: (login: string | null) => boolean | undefined;
  pullRequestEvents?: (number: number) => IssueEvent[];
} = {}) {
  const requestedReviews: string[] = [];
  const updatedBranches: { number: number; expectedHeadSha: string }[] = [];
  const handBacks: { issueNumber: number; reason: string; body: string }[] = [];
  const closedCalls: string[] = [];
  const addedPrLabels: { number: number; label: string }[] = [];
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
  };
  return { github, requestedReviews, updatedBranches, handBacks, closedCalls, addedPrLabels };
}

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

  // #81's follow-up review: a settled PR whose only open thread is the
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

  // Label origin applies to PR-level hand-backs too, not just issues (#146,
  // "Label origin"): a stranger removing sandcastle:needs-human from a PR
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

    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 1 }]);
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

  // #147: the early exit reads followUpPhase's result, so a failed sweep
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

// #147: the early exit needs the PRs the sweep found needing a follow-up
// pass, and only those, so it doesn't start an agent for a PR the sweep
// already updated or is still waiting on. #78: the pass pipeline
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

  // #78: runPass reads PassTarget.id, headRefName, headRefOid and
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
