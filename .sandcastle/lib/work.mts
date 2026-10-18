// Whether an unattended run has anything to do this round, checked before the
// Docker image is built or Claude is called (#147, "The round" in
// docs/plans/sandcastle-workflow.md): an in-scope open issue intake hasn't
// judged yet, a ready unblocked issue, or a settled pull request that needs a
// follow-up pass. With none of these, the run exits 0 rather than spend a
// round on housekeeping alone.

import { gateIssues } from "./gate.mts";
import { openPullRequests, type OpenPullRequest, type SandcastleIssue } from "./github.mts";
import { needsIntake } from "./intake.mts";
import { loadQueue } from "./queue.mts";

// What findWork needs from outside; tests pass a stub.
export type WorkSources = {
  // The run's queue scope (lib/queue.mts#loadQueue), cached per round.
  queue(): readonly SandcastleIssue[];
  openPullRequests(): readonly OpenPullRequest[];
  // The blocker gate's ready, unblocked issues (lib/gate.mts#gateIssues).
  gate(): { ready: SandcastleIssue[] };
};

export const liveWorkSources: WorkSources = {
  queue: () => loadQueue(),
  openPullRequests: () => openPullRequests(),
  gate: () => gateIssues(),
};

// A one-line description of the first kind of work found, such as "2 open
// PR(s) need a follow-up pass", "3 issue(s) for intake" or "1 ready,
// unblocked issue(s)", or undefined when there's none. Checks in that order
// and stops at the first hit, so the gate's blocker lookups run only when
// nothing else is pending.
export function findWork(needsPass: readonly number[], sources: WorkSources = liveWorkSources): string | undefined {
  if (needsPass.length > 0) {
    return `${needsPass.length} open PR(s) need a follow-up pass`;
  }
  // The same filter intake applies, so an issue intake would skip (being
  // built, or with a PR already open) doesn't keep the run going.
  const forIntake = needsIntake(sources.queue(), sources.openPullRequests());
  if (forIntake.length > 0) {
    return `${forIntake.length} issue(s) for intake`;
  }
  const { ready } = sources.gate();
  if (ready.length > 0) {
    return `${ready.length} ready, unblocked issue(s)`;
  }
  return undefined;
}
