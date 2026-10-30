import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UncountedStopError } from "./errors.mts";
import { FOLLOW_UP_LABEL } from "./config.mts";
import { approvedHeadComment, type FollowUpGitHub, type PassTarget, type SweepPullRequest, type SweepResult } from "./follow-up.mts";
import { followUpOnlyRun, liveFollowUpRunSteps, liveSweep, type FollowUpRunSteps } from "./follow-up-run.mts";
import type { ClosedPullRequest, SandcastleIssue } from "./github.mts";

const target = (number: number): PassTarget => ({
  number,
  id: `PR_${number}`,
  headRefName: `feature/${number}-x`,
  headRefOid: "a".repeat(40),
  issueNumber: number,
  reasons: ["check build is red"],
  conflicted: false,
});

const issue = (number: number) => ({ number, title: `Issue ${number}` }) as unknown as SandcastleIssue;

// Steps that record every call in order, serving `sweep` and `queue`.
function stubSteps({
  sweep = { needsPass: [], passes: [] },
  queue = [],
  runPasses,
}: {
  sweep?: SweepResult;
  queue?: SandcastleIssue[];
  runPasses?: FollowUpRunSteps["runPasses"];
} = {}) {
  const calls: string[] = [];
  const passCalls: { targets: readonly PassTarget[]; issues: readonly SandcastleIssue[]; base: string }[] = [];
  const steps: FollowUpRunSteps = {
    startRound: () => void calls.push("startRound"),
    sweep: () => {
      calls.push("sweep");
      return sweep;
    },
    fetchMain: () => {
      calls.push("fetchMain");
      return "base-sha";
    },
    queue: () => {
      calls.push("queue");
      return queue;
    },
    runPasses:
      runPasses ??
      (async (targets, issues, base) => {
        calls.push("runPasses");
        passCalls.push({ targets, issues, base });
      }),
  };
  return { steps, calls, passCalls };
}

describe("followUpOnlyRun", () => {
  it("starts a fresh queue round, then sweeps, before anything else", async () => {
    const { steps, calls } = stubSteps();

    await followUpOnlyRun(steps, () => {});

    assert.deepEqual(calls.slice(0, 2), ["startRound", "sweep"]);
  });

  it("runs a follow-up pass on each PR the sweep flagged, with the queue and main's head", async () => {
    const passes = [target(1), target(2)];
    const queue = [issue(1), issue(2)];
    const { steps, calls, passCalls } = stubSteps({ sweep: { needsPass: [1, 2], passes }, queue });

    await followUpOnlyRun(steps, () => {});

    assert.deepEqual(calls, ["startRound", "sweep", "fetchMain", "queue", "runPasses"]);
    assert.deepEqual(passCalls, [{ targets: passes, issues: queue, base: "base-sha" }]);
  });

  it("starts no pass, and fetches nothing, when the sweep flagged no PR", async () => {
    const { steps, calls } = stubSteps();

    await followUpOnlyRun(steps, () => {});

    assert.deepEqual(calls, ["startRound", "sweep"]);
  });

  it("says so in the log when there was nothing to answer", async () => {
    const { steps } = stubSteps();
    const lines: string[] = [];

    await followUpOnlyRun(steps, (line) => lines.push(line));

    assert.ok(lines.some((line) => /nothing to do|no PR/i.test(line)), lines.join("\n"));
  });

  it("sweeps and passes once: it never loops back for another round", async () => {
    const { steps, calls } = stubSteps({ sweep: { needsPass: [1], passes: [target(1)] }, queue: [issue(1)] });

    await followUpOnlyRun(steps, () => {});

    assert.equal(calls.filter((call) => call === "sweep").length, 1);
    assert.equal(calls.filter((call) => call === "runPasses").length, 1);
  });

  it("returns the sweep's result", async () => {
    const sweep = { needsPass: [1], passes: [target(1)] };
    const { steps } = stubSteps({ sweep, queue: [issue(1)] });

    assert.deepEqual(await followUpOnlyRun(steps, () => {}), sweep);
  });

  // main.mts's catch ends the run cleanly on this one: the budget or Claude's usage limit.
  it("lets a stop from a pass reach the caller", async () => {
    const stop = new UncountedStopError("Claude's usage limit was hit");
    const { steps } = stubSteps({
      sweep: { needsPass: [1], passes: [target(1)] },
      queue: [issue(1)],
      runPasses: async () => {
        throw stop;
      },
    });

    await assert.rejects(followUpOnlyRun(steps, () => {}), stop);
  });
});

describe("liveFollowUpRunSteps", () => {
  it("names every step the run takes", () => {
    for (const name of ["startRound", "sweep", "fetchMain", "queue", "runPasses"] as const) {
      assert.equal(typeof liveFollowUpRunSteps[name], "function", name);
    }
  });
});

describe("liveSweep", () => {
  const closedPr: ClosedPullRequest = {
    number: 10,
    author: "host",
    body: "Closes #42",
    baseRefName: "main",
    headRefName: "feature/42-x",
    isCrossRepository: false,
    headRefOid: "a".repeat(40),
    state: "CLOSED",
    closedAt: "2026-10-01T00:00:00Z",
  };

  // A GitHub with no open PR and an in-scope issue whose latest PR closed without merging, recording what the sweep reads.
  function stubGithub() {
    const closedCalls: string[] = [];
    const handBacks: number[] = [];
    const github: FollowUpGitHub = {
      hostLogin: () => "host",
      openPullRequests: () => [],
      closedPullRequests: (author) => {
        closedCalls.push(author);
        return [closedPr];
      },
      inScopeIssues: () => [{ number: 42, labels: [] }],
      labelTimeline: () => [],
      requestCopilotReview: () => {},
      updateBranch: () => {},
      handBack: (issueNumber) => void handBacks.push(issueNumber),
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
    return { github, closedCalls, handBacks };
  }

  it("never reads the closed pull requests, and hands nothing back", () => {
    const { github, closedCalls, handBacks } = stubGithub();

    liveSweep(github, () => {});

    assert.deepEqual(closedCalls, []);
    assert.deepEqual(handBacks, []);
  });

  // A PR the owner handed off has no issue in the queue, so the follow-up-only run must still pass on it.
  it("returns a labelled hand-off PR's pass target, which has no issue in the queue, with the closed PRs still unread", () => {
    const handOffPr: SweepPullRequest = {
      number: 201,
      id: "PR_201",
      title: "chore: Tidy the build",
      author: "owner",
      body: "Tidies the build scripts.",
      baseRefName: "main",
      headRefName: "chore/tidy-the-build",
      headRefOid: "b".repeat(40),
      isCrossRepository: false,
      isDraft: false,
      labels: [FOLLOW_UP_LABEL],
      mergeStateStatus: "DIRTY",
      reviewRequests: [],
      reviews: [],
      threads: [],
      checks: [],
      copilotRequestedAt: [],
      truncated: false,
    };
    const { github, closedCalls } = stubGithub();
    github.openPullRequests = () => [handOffPr];
    github.pullRequestEvents = () => [{ event: "labeled", actor: "owner", label: FOLLOW_UP_LABEL, createdAt: "2026-10-09T10:00:00Z" }];
    github.isOwner = (login) => login === "owner";
    github.pullRequestComments = () => [{ author: "host", body: approvedHeadComment("b".repeat(40)), createdAt: "2026-10-09T10:05:00Z", updatedAt: "2026-10-09T10:05:00Z" }];

    const result = liveSweep(github, () => {});

    assert.deepEqual(result.needsPass, [201]);
    assert.deepEqual(result.passes[0]?.handOff, { title: "chore: Tidy the build", body: "Tidies the build scripts." });
    assert.deepEqual(closedCalls, []);
  });
});

describe("followUpOnlyRun and a hand-off PR", () => {
  const handOffTarget: PassTarget = {
    number: 201,
    id: "PR_201",
    headRefName: "chore/tidy-the-build",
    headRefOid: "b".repeat(40),
    handOff: { title: "chore: Tidy the build", body: "Tidies the build scripts." },
    reasons: ["it has merge conflicts"],
    conflicted: true,
  };

  it("runs the passes for a sweep that flagged only a hand-off PR, though the queue is empty", async () => {
    const { steps, calls, passCalls } = stubSteps({ sweep: { needsPass: [201], passes: [handOffTarget] }, queue: [] });

    await followUpOnlyRun(steps, () => {});

    assert.deepEqual(calls, ["startRound", "sweep", "fetchMain", "queue", "runPasses"]);
    assert.deepEqual(passCalls, [{ targets: [handOffTarget], issues: [], base: "base-sha" }]);
  });
});
