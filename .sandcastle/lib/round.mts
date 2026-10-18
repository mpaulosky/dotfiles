// The run summary for one round, logged once every issue's build has settled.

import { UncountedStopError } from "./errors.mts";
import type { OutcomeEntry } from "./report.mts";

// What the summary needs from each build's result; see buildIssue.
type BuildResult = { prUrl: string | undefined; publishFailed: boolean };

// What the run report needs from each build's result; see buildIssue.
type BuildReportFields = Pick<OutcomeEntry, "outcome" | "detail">;

// The summary's lines: each pull request the round opened, then each branch
// that passed both checkpoints but couldn't be pushed or get a PR. That work is
// done but stranded, which a person needs to hear apart from a round that
// built nothing. `stop` is the line to stop the run on when no pull request
// opened, and undefined when one did. `settled` holds each `work` item's
// build, in the same order. A build that stopped with UncountedStopError (the
// time budget or Claude's usage limit, #147) gets a ⏹ line, and stops the run
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
// UncountedStopError (the time budget or Claude's usage limit, #147) as
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
