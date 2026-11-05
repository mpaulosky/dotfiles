// The run summary for one round, logged once every issue's build has settled.

import { UncountedStopError } from "./errors.mts";
import type { IntakeStopEntry, OutcomeEntry } from "./report.mts";

// What the summary needs from each build's result; see buildIssue.
type BuildResult = { prUrl: string | undefined; publishFailed: boolean };

// What the run report needs from each build's result; see buildIssue.
type BuildReportFields = Pick<OutcomeEntry, "outcome" | "detail">;

// The summary's lines: each pull request the round opened, then each branch
// that passed its checkpoints but couldn't be pushed or get a PR. That work is
// done but stranded, which a person needs to hear apart from a round that
// built nothing. `stop` is the line to stop the run on when no pull request
// opened, and undefined when one did. `settled` holds each `work` item's
// build, in the same order. A build that stopped with UncountedStopError (the
// time budget, Claude's usage limit or a stalled sandbox step) gets a ⏹ line, and stops the run
// whatever else the round published: nothing more can start.
export function roundSummary(
  work: readonly { issue: { number: number }; branch: string }[],
  settled: readonly PromiseSettledResult<BuildResult>[],
): { lines: string[]; stop: string | undefined } {
  const built = work.flatMap(({ issue, branch }, i) => {
    const outcome = settled[i];
    return outcome?.status === "fulfilled" ? [{ issue, branch, ...outcome.value }] : [];
  });
  const published = built.filter((build) => build.prUrl);
  const stranded = built.filter((build) => build.publishFailed);

  const lines = [
    `\nExecution complete. ${published.length} pull request(s):`,
    ...published.map(({ issue, branch, prUrl }) => `  #${issue.number} (${branch}) → ${prUrl}`),
  ];
  if (stranded.length > 0) {
    lines.push(
      `\n${stranded.length} gated branch(es) couldn't be published, so their work is stranded:`,
      ...stranded.map(({ issue, branch }) => `  #${issue.number} (${branch}): see the comment on the issue`),
    );
  }

  const stopped = work.flatMap(({ issue, branch }, i) => {
    const outcome = settled[i];
    return outcome?.status === "rejected" && outcome.reason instanceof UncountedStopError
      ? [{ issue, branch, message: outcome.reason.message }]
      : [];
  });
  lines.push(
    ...stopped.map(
      ({ issue, branch, message }) =>
        `  ⏹ #${issue.number} (${branch}) stopped: ${message}. This attempt's commits weren't pushed, so an ephemeral ` +
          "runner drops them with its checkout; the next run rebuilds the issue from what GitHub has.",
    ),
  );
  const [firstStop] = stopped;
  if (firstStop !== undefined) return { lines, stop: `Stopping the run: ${firstStop.message}.` };

  if (published.length > 0) return { lines, stop: undefined };
  const stop =
    stranded.length > 0
      ? "Publishing failed for every gated branch this round. Stopping."
      : "No pull requests opened this round. Stopping.";
  return { lines, stop };
}

// This round's outcomes, for the run report (lib/report.mts): a fulfilled
// build's own outcome and detail, a build that rejected with
// UncountedStopError (the time budget, Claude's usage limit or a stalled sandbox step) as
// "stopped" with its message, and any other rejection as "not published",
// since the build threw rather than return a result.
export function roundOutcomes(
  work: readonly { issue: { number: number }; branch: string }[],
  settled: readonly PromiseSettledResult<BuildResult & BuildReportFields>[],
): OutcomeEntry[] {
  return work.flatMap(({ issue }, i): OutcomeEntry[] => {
    const result = settled[i];
    if (result === undefined) return [];
    const target = { kind: "issue", number: issue.number } as const;
    if (result.status === "fulfilled") return [{ ...target, outcome: result.value.outcome, detail: result.value.detail }];
    return result.reason instanceof UncountedStopError
      ? [{ ...target, outcome: "stopped", detail: result.reason.message }]
      : [{ ...target, outcome: "not published", detail: "the build stopped on an error; see the run log" }];
  });
}

// The numbers of the issues whose build opened a PR, from the round's `work`
// and its `settled` builds, in the same order. lib/overlap.mts#lastingHolds
// keeps a hold behind a pick for the rest of the run only when that pick is
// here: a build that threw, stopped or opened no PR leaves nothing
// open for the held pick to conflict with.
export function publishedIssues(
  work: readonly { issue: { number: number } }[],
  settled: readonly PromiseSettledResult<BuildResult>[],
): Set<number> {
  return new Set(
    work.flatMap(({ issue }, i) => {
      const outcome = settled[i];
      return outcome?.status === "fulfilled" && outcome.value.prUrl ? [issue.number] : [];
    }),
  );
}

// The reason of the stop recorded for a build whose Advisory findings reached nowhere a person sees (see buildIssue's findingsLost and findingsUnlisted).
export const FINDINGS_LOST_STOP_REASON = "a pull request's Advisory findings weren't filed anywhere";

// One stop per fulfilled build whose Advisory findings reached nowhere a person sees, recorded with the intake stops so the run report names it and the run ends red
// (lib/report.mts#intakeStopExitCode): the follow-up issue and the fallback comment both failed (findingsLost), or none of the findings could be put in a public issue (findingsUnlisted).
// `firstError` is host-written text: the issue's number, never an error's own text, since the report is public on a public repository.
export function findingsLostStops(
  work: readonly { issue: { number: number } }[],
  settled: readonly PromiseSettledResult<{ findingsLost?: boolean; findingsUnlisted?: boolean }>[],
): IntakeStopEntry[] {
  return work.flatMap(({ issue }, i): IntakeStopEntry[] => {
    const outcome = settled[i];
    if (outcome?.status !== "fulfilled") return [];
    if (outcome.value.findingsLost === true) {
      return [{ reason: FINDINGS_LOST_STOP_REASON, unjudged: [], firstError: `filing the follow-up issue and commenting on #${issue.number} both failed; the findings are in the run log only` }];
    }
    if (outcome.value.findingsUnlisted === true) {
      return [{ reason: FINDINGS_LOST_STOP_REASON, unjudged: [], firstError: `no Advisory finding on #${issue.number} could be put in a public issue, so none was filed` }];
    }
    return [];
  });
}
