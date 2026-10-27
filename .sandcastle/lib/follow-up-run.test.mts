import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UncountedStopError } from "./errors.mts";
import type { PassTarget, SweepResult } from "./follow-up.mts";
import { followUpOnlyRun, liveFollowUpRunSteps, type FollowUpRunSteps } from "./follow-up-run.mts";
import type { SandcastleIssue } from "./github.mts";

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
