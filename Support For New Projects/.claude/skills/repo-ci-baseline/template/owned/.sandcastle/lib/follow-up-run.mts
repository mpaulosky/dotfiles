// ---------------------------------------------------------------------------
// The follow-up-only run (SANDCASTLE_MODE=follow-up)
//
// A full run that is busy building an issue answers a review or a red check
// on its PRs only after the build. A follow-up-only run does the sweep and the
// follow-up passes once, then exits: no intake, no builds, no rounds, so it
// answers a PR in minutes while a full run is still building. It runs in its
// own concurrency group, and the two stay off each other's PRs through
// sandcastle:building (lib/follow-up.mts#sweepSubject: the issue's label, or a hand-off PR's own).
// ---------------------------------------------------------------------------

import { fetchMain } from "./branches.mts";
import { followUpPassPhase } from "./follow-up-pass.mts";
import {
  followUpPhase,
  liveFollowUpGitHub,
  sweepPullRequests,
  type FollowUpGitHub,
  type PassTarget,
  type SweepResult,
} from "./follow-up.mts";
import type { SandcastleIssue } from "./github.mts";
import { loadQueue, startQueueRound } from "./queue.mts";

// What the follow-up-only run needs from the rest of Sandcastle; tests pass a stub.
export type FollowUpRunSteps = {
  startRound(): void;
  // The sweep, with the hand-back of closed PRs off. A failed sweep gives an empty result.
  sweep(): SweepResult;
  fetchMain(): string;
  queue(): SandcastleIssue[];
  runPasses(targets: readonly PassTarget[], issues: readonly SandcastleIssue[], base: string): Promise<unknown>;
};

// The follow-up-only run's sweep. It leaves the hand-back of a closed PR's issue to the full run beside this one:
// two runs doing it would comment twice, and this run has no build to start from the issue afterwards. Takes
// GitHub and the log as parameters so a test can pin that it never reads the closed PRs.
export function liveSweep(
  github: FollowUpGitHub = liveFollowUpGitHub,
  log: (line: string) => void = console.log,
): SweepResult {
  return followUpPhase(() => sweepPullRequests(github, log, undefined, undefined, undefined, { handBackClosed: false }));
}

// The live steps.
export const liveFollowUpRunSteps: FollowUpRunSteps = {
  startRound: startQueueRound,
  sweep: () => liveSweep(),
  fetchMain: () => fetchMain(),
  queue: loadQueue,
  runPasses: followUpPassPhase,
};

// Sweeps the open PRs once and runs a follow-up pass on each one that needs it, then returns. It never loops
// back for a second round: the next scheduled run sweeps again. An UncountedStopError from a pass (the time
// budget or Claude's usage limit) propagates, and main.mts's catch ends the run cleanly on it.
export async function followUpOnlyRun(
  steps: FollowUpRunSteps = liveFollowUpRunSteps,
  log: (line: string) => void = console.log,
): Promise<SweepResult> {
  steps.startRound();
  const result = steps.sweep();
  if (result.passes.length === 0) {
    log("Nothing to do: no PR needs a follow-up pass.");
    return result;
  }
  const base = steps.fetchMain();
  await steps.runPasses(result.passes, steps.queue(), base);
  return result;
}
