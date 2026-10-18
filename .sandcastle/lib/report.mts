// The run's report: token usage per role, what became of each issue and PR it
// touched, its hand-backs and the PRs waiting on people — collected during the
// run and written at its end to .sandcastle/logs/ and the job summary (see
// "Observability" in docs/plans/sandcastle-workflow.md).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { IterationUsage } from "@ai-hero/sandcastle";

type Usage = { -readonly [K in keyof IterationUsage]: number };

const zero = (): Usage => ({ inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 });

export class UsageReport {
  private readonly byRole = new Map<string, Usage>();

  // An iteration without usage (capture off, or the agent didn't report it)
  // still marks the role as having run.
  record(role: string, iterations: readonly { readonly usage?: IterationUsage }[]): void {
    const total = this.byRole.get(role) ?? zero();
    for (const { usage } of iterations) {
      if (!usage) continue;
      total.inputTokens += usage.inputTokens;
      total.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      total.cacheReadInputTokens += usage.cacheReadInputTokens;
      total.outputTokens += usage.outputTokens;
    }
    this.byRole.set(role, total);
  }

  totals(): ReadonlyMap<string, IterationUsage> {
    return this.byRole;
  }

  lines(): string[] {
    return [...this.byRole].map(
      ([role, usage]) =>
        `  ${role}: input ${usage.inputTokens}, cache creation ${usage.cacheCreationInputTokens}, ` +
        `cache read ${usage.cacheReadInputTokens}, output ${usage.outputTokens}`,
    );
  }
}

// The one report every role run records into.
export const usageReport = new UsageReport();

// An issue or PR, as the report names and links it.
export type ReportTarget = { kind: "issue" | "pr"; number: number };

// https://github.com/<repo>/issues/<n> or /pull/<n>.
export function targetUrl(repo: string, target: ReportTarget): string {
  return `https://github.com/${repo}/${target.kind === "issue" ? "issues" : "pull"}/${target.number}`;
}

// What became of one issue or PR. "handed back" is never recorded here: the
// renderer adds that row from the hand-backs, so nothing is counted twice.
export type Outcome =
  | "published"
  | "deferred"
  | "role failed"
  | "timed out"
  | "gate failed"
  | "stopped"
  | "not published"
  | "updated"
  | "follow-up pass";

// `detail` is host-written text only, never raw error output (see the design
// note's Risks: the summary is public on a public repository).
export type OutcomeEntry = ReportTarget & { outcome: Outcome; detail: string };

export class OutcomeReport {
  private readonly entries: OutcomeEntry[] = [];

  record(entry: OutcomeEntry): void {
    this.entries.push(entry);
  }

  items(): readonly OutcomeEntry[] {
    return this.entries;
  }
}

// The one report every outcome this run reaches records into.
export const outcomeReport = new OutcomeReport();

// One hand-back this run made: an issue or PR that got `sandcastle:needs-info`
// or `sandcastle:needs-human`, and why.
export type HandBackEntry = ReportTarget & { label: string; reason: string; url: string };

// Every hand-back this run made, so a final workflow step can fail the job
// when the list isn't empty: the owner's PAT means GitHub never notifies
// anyone about Sandcastle's own labels or comments (see "Notification: the
// run ends red" in docs/plans/sandcastle-workflow.md).
export class HandBackReport {
  private readonly entries: HandBackEntry[] = [];

  record(entry: HandBackEntry): void {
    this.entries.push(entry);
  }

  items(): readonly HandBackEntry[] {
    return this.entries;
  }
}

// The one report every hand-back this run makes records into.
export const handBackReport = new HandBackReport();

// An open Sandcastle PR the latest sweep found with unresolved review threads
// opened by someone other than the repository owner or a bot (the same test
// lib/follow-up-pass.mts#threadsForRole uses for "leftForHuman"): an owner's
// own thread is the follow-up role's to answer, not a person's to wait on.
export type WaitingPrEntry = { pr: number; threads: number };

// Every PR the latest follow-up sweep found waiting on a person, replaced
// whole each sweep (see WaitingPrReport.replace), so the report shows the
// last sweep's view, not every round's.
export class WaitingPrReport {
  private entries: readonly WaitingPrEntry[] = [];

  replace(entries: readonly WaitingPrEntry[]): void {
    this.entries = entries;
  }

  items(): readonly WaitingPrEntry[] {
    return this.entries;
  }
}

// The one report the latest follow-up sweep replaces.
export const waitingPrReport = new WaitingPrReport();

// One review thread a follow-up pass kept from the follow-up role because
// someone other than the repository owner or a bot opened it
// (lib/follow-up-pass.mts#threadsForRole): left for a person, never acted on.
export type HumanThreadEntry = { pr: number; author: string | null; url: string };

// Every such thread this run found, so the run report lists them next to the
// hand-backs.
export class HumanThreadReport {
  private readonly entries: HumanThreadEntry[] = [];

  record(entry: HumanThreadEntry): void {
    this.entries.push(entry);
  }

  items(): readonly HumanThreadEntry[] {
    return this.entries;
  }
}

// The one report every follow-up pass this run makes records into.
export const humanThreadReport = new HumanThreadReport();

// One round where intake (lib/intake.mts#intakeRound) stopped rather than
// judge every issue: it hit INTAKE_FAILED_RUNS_LIMIT failed runs or
// INTAKE_REFUSED_BATCHES_LIMIT refused batches in a row, so the issues it
// hadn't judged yet are left with no verdict and nothing told the owner
// (#320, the first automatic runs ending green on a missing Docker image).
// `unjudged` are the issue numbers intake never gave a verdict to this
// round; `firstError` is the message of the first error in the streak that
// stopped it.
export type IntakeStopEntry = { reason: string; unjudged: readonly number[]; firstError: string };

// Every intake stop this run recorded, so the run report and the exit code
// (see intakeStopExitCode) both see it.
export class IntakeStopReport {
  private readonly entries: IntakeStopEntry[] = [];

  record(entry: IntakeStopEntry): void {
    this.entries.push(entry);
  }

  items(): readonly IntakeStopEntry[] {
    return this.entries;
  }
}

// The one report every intake stop this run makes records into.
export const intakeStopReport = new IntakeStopReport();

// Whether main.mts must exit non-zero: any recorded intake stop means some
// issues were left silently unjudged (#320), so the run must end red even
// when nothing else failed, a hand-back included.
export function intakeStopExitCode(stops: readonly IntakeStopEntry[]): number {
  return stops.length > 0 ? 1 : 0;
}

// How the run ended, so the summary tells a hand-back from a crash
// ("Notification: the run ends red" in docs/plans/sandcastle-workflow.md).
export type RunEnding = { kind: "finished" } | { kind: "stopped"; reason: string } | { kind: "crashed" };

// Everything renderSummary needs to render the run's Markdown report.
export type SummaryInput = {
  queue: string;
  repo: string | undefined;
  ending: RunEnding;
  outcomes: readonly OutcomeEntry[];
  handBacks: readonly HandBackEntry[];
  waitingPrs: readonly WaitingPrEntry[];
  humanThreads: readonly HumanThreadEntry[];
  usage: ReadonlyMap<string, IterationUsage>;
  stops: readonly IntakeStopEntry[];
};

// The run's report as Markdown, for .sandcastle/logs/summary.md and (when set)
// $GITHUB_STEP_SUMMARY. See the design note at .sandcastle/work/81/design.md
// for the exact shape: queue and ending sentence, a table of every touched
// issue and PR with its outcome (plus one row per hand-back), the hand-backs
// themselves with links, the PRs waiting on a person, any round where intake
// stopped (#320), and a token-usage table by role with a total row.
export function renderSummary(input: SummaryInput): string {
  const { repo } = input;
  const link = (target: ReportTarget): string =>
    repo === undefined ? targetName(target) : `[${targetName(target)}](${targetUrl(repo, target)})`;
  return [
    "## Sandcastle run",
    "",
    `Queue: ${cell(input.queue)}. ${endingSentence(input.ending)}`,
    "",
    "### Issues and pull requests",
    "",
    ...outcomeLines(input, link),
    "",
    "### Hand-backs",
    "",
    ...handBackLines(input.handBacks),
    "",
    "### Pull requests waiting on a person",
    "",
    ...waitingLines(input.waitingPrs, input.humanThreads, link),
    "",
    ...intakeStopLines(input.stops, link),
    "### Token usage by role",
    "",
    ...usageLines(input.usage),
    "",
  ].join("\n");
}

function targetName(target: ReportTarget): string {
  return `${target.kind === "issue" ? "issue" : "PR"} #${target.number}`;
}

function endingSentence(ending: RunEnding): string {
  switch (ending.kind) {
    case "finished":
      return "The run finished.";
    case "stopped":
      return `The run stopped cleanly: ${cell(ending.reason.replace(/\.$/, ""))}.`;
    case "crashed":
      return "The run ended on an error; see the run log.";
  }
}

// Each touched target's rows sit together, issues before PRs, in the order
// they were recorded; a hand-back adds its own "handed back" row.
function outcomeLines(input: SummaryInput, link: (target: ReportTarget) => string): string[] {
  const rows: (ReportTarget & { outcome: Outcome | "handed back"; detail: string })[] = [
    ...input.outcomes,
    ...input.handBacks.map(({ kind, number, label, reason }) => ({
      kind,
      number,
      outcome: "handed back" as const,
      detail: `\`${label}\`: ${reason}`,
    })),
  ];
  if (rows.length === 0) return ["Nothing was touched."];
  const order = (kind: ReportTarget["kind"]): number => (kind === "issue" ? 0 : 1);
  rows.sort((a, b) => order(a.kind) - order(b.kind) || a.number - b.number);
  return [
    "| Issue or PR | Outcome | Detail |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${link(row)} | ${row.outcome} | ${cell(row.detail)} |`),
  ];
}

// Each hand-back carries its own link, so this section stays linked even when
// the repository name couldn't be read for the rest of the report.
function handBackLines(handBacks: readonly HandBackEntry[]): string[] {
  if (handBacks.length === 0) return ["None."];
  return handBacks.map((entry) => `- [${targetName(entry)}](${entry.url}): \`${cell(entry.label)}\`, ${cell(entry.reason)}`);
}

// The latest sweep's waiting PRs plus any PR a follow-up pass found a
// person's thread on; a PR only the passes saw has no count to show.
function waitingLines(
  waitingPrs: readonly WaitingPrEntry[],
  humanThreads: readonly HumanThreadEntry[],
  link: (target: ReportTarget) => string,
): string[] {
  const counts = new Map(waitingPrs.map(({ pr, threads }) => [pr, threads]));
  const prs = [...new Set([...waitingPrs.map(({ pr }) => pr), ...humanThreads.map(({ pr }) => pr)])];
  if (prs.length === 0) return ["None."];
  return prs.flatMap((pr) => {
    const threads = counts.get(pr);
    let count = "";
    if (threads !== undefined) {
      count = `: ${threads} unresolved review ${threads === 1 ? "thread" : "threads"} opened by people`;
    }
    return [
      `- ${link({ kind: "pr", number: pr })}${count}`,
      ...humanThreads
        .filter((thread) => thread.pr === pr)
        .map((thread) => `  - [thread by ${cell(thread.author ?? "a deleted account")}](${thread.url})`),
    ];
  });
}

// Only a run whose intake stopped gets the section, since it's the reason the
// run ends red (#320); a run with no stop has nothing to say here.
function intakeStopLines(stops: readonly IntakeStopEntry[], link: (target: ReportTarget) => string): string[] {
  if (stops.length === 0) return [];
  return [
    "### Intake stops",
    "",
    ...stops.flatMap(({ reason, unjudged, firstError }) => [
      `- ${cell(reason)}. First error: ${cell(firstError)}`,
      `  - Left unjudged: ${unjudged.length > 0 ? unjudged.map((number) => link({ kind: "issue", number })).join(", ") : "none"}`,
    ]),
    "",
  ];
}

function usageLines(usage: ReadonlyMap<string, IterationUsage>): string[] {
  if (usage.size === 0) return ["No role ran."];
  const total = zero();
  for (const u of usage.values()) {
    total.inputTokens += u.inputTokens;
    total.cacheCreationInputTokens += u.cacheCreationInputTokens;
    total.cacheReadInputTokens += u.cacheReadInputTokens;
    total.outputTokens += u.outputTokens;
  }
  const row = (role: string, u: IterationUsage): string =>
    `| ${role} | ${u.inputTokens} | ${u.cacheCreationInputTokens} | ${u.cacheReadInputTokens} | ${u.outputTokens} |`;
  return [
    "| Role | Input | Cache creation | Cache read | Output |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...[...usage].map(([role, u]) => row(cell(role), u)),
    row("**Total**", total),
  ];
}

const CELL_LIMIT = 300;

// Text for a table cell or list line. A hand-back reason can come from an
// agent (intake's needs-info reason), so nothing in it may break the table or
// inject HTML into the job summary.
function cell(text: string): string {
  const flat = text.replace(/\r\n?|\n/g, " ");
  const cut = flat.length > CELL_LIMIT ? `${flat.slice(0, CELL_LIMIT - 1)}…` : flat;
  // Backslashes first: CommonMark reads "\\|" as an escaped backslash followed
  // by a real "|", so a reason already containing "\|" would otherwise still
  // split the row once its own backslash was doubled.
  return cut.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;");
}

// handbacks.json: an array of `{ kind, number, label, reason, url }`, one per
// hand-back this run made; "[]\n" when there were none.
export function handBacksJson(handBacks: readonly HandBackEntry[]): string {
  return `${JSON.stringify(handBacks, null, 2)}\n`;
}

// Where writeRunReport writes summary.md and handbacks.json.
export const REPORT_DIR = ".sandcastle/logs";

// The filesystem writeRunReport needs; tests pass a stub that records calls.
export type ReportFs = {
  mkdir(path: string): void;
  writeFile(path: string, text: string): void;
  appendFile(path: string, text: string): void;
};

export const liveReportFs: ReportFs = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, text) => writeFileSync(path, text),
  appendFile: (path, text) => appendFileSync(path, text),
};

// Writes handbacks.json first, then summary.md, then appends `summary` to
// env.GITHUB_STEP_SUMMARY when it's set and non-empty. Each write has its own
// try/catch and failures go to `warn`: it runs in main.mts's finally, so it
// must never throw over the run's own error. A missing handbacks.json then
// fails the workflow step that reads it, which is the fail-closed outcome.
export function writeRunReport(
  summary: string,
  handBacks: readonly HandBackEntry[],
  env: NodeJS.ProcessEnv = process.env,
  fs: ReportFs = liveReportFs,
  warn: (line: string) => void = console.error,
): void {
  const attempt = (what: string, write: () => void): void => {
    try {
      write();
    } catch (error) {
      warn(`Couldn't ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  attempt(`create ${REPORT_DIR}`, () => fs.mkdir(REPORT_DIR));
  attempt(`write ${REPORT_DIR}/handbacks.json`, () => fs.writeFile(`${REPORT_DIR}/handbacks.json`, handBacksJson(handBacks)));
  attempt(`write ${REPORT_DIR}/summary.md`, () => fs.writeFile(`${REPORT_DIR}/summary.md`, summary));
  const stepSummary = env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    attempt("append to GITHUB_STEP_SUMMARY", () => fs.appendFile(stepSummary, summary));
  }
}
