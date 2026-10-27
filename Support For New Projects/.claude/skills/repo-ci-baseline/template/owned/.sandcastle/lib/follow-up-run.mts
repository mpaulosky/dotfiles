// ---------------------------------------------------------------------------
// The follow-up-only run (SANDCASTLE_MODE=follow-up)
//
// A full run that is busy building an issue answers a review or a red check
// on its PRs only after the build. A follow-up-only run does the sweep and the
// follow-up passes once, then exits: no intake, no builds, no rounds, so it
// answers a PR in minutes while a full run is still building. It runs in its
// own concurrency group, and the two stay off each other's PRs through
// sandcastle:building (lib/follow-up.mts#sweepSkipReason).
// ---------------------------------------------------------------------------

import type { SandcastleIssue } from "./github.mts";
import type { PassTarget, SweepResult } from "./follow-up.mts";

// What the follow-up-only run needs from the rest of Sandcastle; tests pass a stub.
export type FollowUpRunSteps = {
  startRound(): void;
  // The sweep, with the hand-back of closed PRs off. A failed sweep gives an empty result.
  sweep(): SweepResult;
  fetchMain(): string;
  queue(): SandcastleIssue[];
  runPasses(targets: readonly PassTarget[], issues: readonly SandcastleIssue[], base: string): Promise<unknown>;
};

export const liveFollowUpRunSteps: FollowUpRunSteps = {
  startRound: () => {
    throw new Error("Not implemented");
  },
  sweep: () => {
    throw new Error("Not implemented");
  },
  fetchMain: () => {
    throw new Error("Not implemented");
  },
  queue: () => {
    throw new Error("Not implemented");
  },
  runPasses: () => {
    throw new Error("Not implemented");
  },
};

// Sweeps the open PRs once and runs a follow-up pass on each one that needs it.
export async function followUpOnlyRun(
  _steps: FollowUpRunSteps = liveFollowUpRunSteps,
  _log: (line: string) => void = console.log,
): Promise<SweepResult> {
  throw new Error("Not implemented");
}
