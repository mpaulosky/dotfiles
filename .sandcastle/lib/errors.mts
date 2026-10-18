// Errors more than one module needs to tell apart. Kept in a leaf module, with
// no imports of its own, so the role runner (lib/agents.mts) can throw one that
// lib/build.mts catches without the two importing each other.

// For a role run that stopped because of the Claude usage limit or the run's
// time budget, not because the role itself failed. The role runner
// (lib/agents.mts#runWithinLimits) throws it when the run's limits have
// stopped it or a role run hits Claude's usage limit (#147). buildIssue
// (lib/build.mts) rethrows it from any role, the reviewer's included, rather
// than treating it as a failed build attempt or publishing work a role didn't
// get to finish: a round
// that runs out of usage or time must not spend one of the issue's
// BUILD_FAILURE_CAP attempts (see "Giving up and telling the human" in
// docs/plans/sandcastle-workflow.md).
export class UncountedStopError extends Error {}
