// ---------------------------------------------------------------------------
// Sandcastle status
//
// The read-only status of the follow-up sweep: for each open Sandcastle pull
// request into main, how many follow-up passes it has used, why Sandcastle is
// holding it (the sweep's own answer), its unresolved threads split into bot,
// owner and other, and the Sandcastle workflow's recent runs. It owns the
// report's data and rendering, and writes nothing to GitHub or git.
// ---------------------------------------------------------------------------

import {
  BUILDING_LABEL,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_PASS_CAP,
  LOCAL_QUEUE_LABEL,
  QUEUE_LABEL,
  describeQueueScope,
  queueScopeFrom,
  type QueueScope,
} from "./config.mts";
import {
  followUpPassCount,
  hasLabel,
  repoName,
  sandcastleWorkflowRuns,
  type IssueEvent,
  type WorkflowRun,
} from "./github.mts";
import {
  admitToSweep,
  decide,
  isSandcastlePullRequest,
  labelOriginHold,
  liveFollowUpGitHub,
  sweepContext,
  withoutAnsweredThreads,
  type FollowUpGitHub,
  type LabelOriginHold,
  type SweepContext,
  type SweepDecision,
  type SweepPullRequest,
  type SweepSubject,
} from "./follow-up.mts";
import { activeQueueScope, liveQueueGitHub, loadQueue, type QueueGitHub } from "./queue.mts";

// The reads status needs. Only reads, so the type itself keeps the command read-only. `repo` and `queueScope` name what the
// report is about.
export type StatusGitHub = Pick<
  FollowUpGitHub,
  | "hostLogin"
  | "openPullRequests"
  | "inScopeIssues"
  | "followsHandOffs"
  | "pullRequestEvents"
  | "pullRequestBodyEdits"
  | "pullRequestComments"
  | "mergeOfMain"
  | "isOwner"
  | "repositoryOwner"
  | "reviewThreads"
> & {
  passesUsed(pr: number): number;
  workflowRuns(limit: number): WorkflowRun[];
  repo(): string;
  queueScope(): QueueScope;
};

// Where a PR stands with the sweep.
export type Held = {
  state: "skipped" | "waiting" | "pass due" | "hand-back due" | "act next sweep" | "settled";
  reason: string;
};

// A PR's unresolved threads by who opened them; `answered` are the ones the host replied to, which wait on the owner.
export type ThreadSplit = { bot: number; owner: number; other: number; answered: number };

// One PR's line in the report. A field that couldn't be read is `{ unreadable }` with the reason.
export type PrStatus = {
  number: number;
  title: string;
  headRefName: string;
  subject: "issue" | "hand-off" | "not swept";
  issueNumber?: number;
  passes: { used: number; cap: number } | { unreadable: string };
  held: Held;
  threads: ThreadSplit | { unreadable: string };
  mergeState: string;
  draft: boolean;
  labels: string[];
};

// What the report shows: `scope` is the queue scope in words, `unlisted` counts the open PRs that aren't listed, and `runs` are
// the Sandcastle workflow's latest.
export type StatusReport = {
  repo: string;
  scope: string;
  prs: PrStatus[];
  unlisted: number;
  runs: WorkflowRun[] | { unreadable: string };
};

// How many of the Sandcastle workflow's runs the report lists.
const RUNS_SHOWN = 10;

// Appended to every line the read-only queue load logs, so a reader of the status can tell a fix the sweep would make from one
// the status made.
const QUEUE_LOG_SUFFIX = " (status only: nothing changed)";

// Why a read failed, in one line.
const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).trim().split("\n").join(" ");

// Which open PRs are listed: Sandcastle's own, and any same-repo PR into main carrying the owner's hand-off label, so the
// owner sees why a label that doesn't count leaves a PR alone.
export function isListed(pr: SweepPullRequest, host: string): boolean {
  if (isSandcastlePullRequest(pr, host)) return true;
  return pr.isCrossRepository === false && pr.baseRefName === "main" && hasLabel(pr, FOLLOW_UP_LABEL);
}

// The sweep's own answer for one PR, in the sweep's order: not admitted, then the label-origin hold, then `decide`'s
// decision (made on the PR without the threads the host answered). `passesUsed` tells a pass due from a hand-back due, as
// the pass's cap check does. Notes on the threads that wait on a person are appended to the reason. No writes.
export function heldReason(args: {
  pr: SweepPullRequest;
  admitted: { subject: SweepSubject } | { skip: string };
  origin: LabelOriginHold | undefined;
  decision?: SweepDecision;
  passesUsed?: number;
  answered: number;
  human: number;
}): Held {
  const { admitted, origin, decision, passesUsed, answered, human } = args;
  if ("skip" in admitted) return { state: "skipped", reason: `isn't swept: ${admitted.skip}` };
  if (origin?.kind === "unknown") {
    return { state: "skipped", reason: "couldn't check whether the repository owner removed sandcastle:needs-human" };
  }
  if (origin?.kind === "restore") return { state: "skipped", reason: `${origin.reason}; the sweep puts the label back` };
  if (decision === undefined) return { state: "waiting", reason: "the sweep has no decision for it yet" };
  const notes =
    (answered > 0 ? `; ${answered} answered thread(s) wait on the owner` : "") +
    (human > 0 ? `; ${human} thread(s) from others wait on a person` : "");
  const held = ((): Held => {
    switch (decision.action) {
      case "wait":
        return { state: "waiting", reason: decision.reason };
      case "needs-pass": {
        const reasons = decision.reasons.join("; ");
        if (passesUsed !== undefined && passesUsed >= FOLLOW_UP_PASS_CAP) {
          return {
            state: "hand-back due",
            reason: `has had ${FOLLOW_UP_PASS_CAP} of ${FOLLOW_UP_PASS_CAP} passes and still needs another (${reasons}); the next pass hands it back with sandcastle:needs-human`,
          };
        }
        return { state: "pass due", reason: reasons };
      }
      case "request-review":
        return { state: "act next sweep", reason: "Copilot will be asked to review the head" };
      case "update-branch":
        return { state: "act next sweep", reason: "it will be updated from main" };
      case "leave":
        return { state: "settled", reason: decision.reason };
    }
  })();
  return { ...held, reason: held.reason + notes };
}

// The unresolved threads of `pr` (the sweep's view, without the ones the host answered) by who opened them, with the same
// tests as `decide` and the sweep's count of threads waiting on a person: an owner check that can't answer counts as other.
function splitThreads(threads: SweepPullRequest["threads"], isOwner: StatusGitHub["isOwner"], answered: number): ThreadSplit {
  const open = threads.filter((thread) => !thread.resolved);
  const bot = open.filter((thread) => thread.byBot).length;
  const owner = open.filter((thread) => !thread.byBot && isOwner(thread.author) === true).length;
  return { bot, owner, other: open.length - bot - owner, answered };
}

// One PR's status. It reads only; the approval of a hand-off PR is read with a record of the head that does nothing, since the
// sweep's would post a comment. A read that fails for this PR is shown as unreadable on its own line, and the other PRs still print.
export function statusOf(
  pr: SweepPullRequest,
  ctx: { context: SweepContext; now: number },
  github: StatusGitHub,
  log: (line: string) => void,
): PrStatus {
  const { context, now } = ctx;
  let events: IssueEvent[] | undefined;
  const eventsOfPr = () => (events ??= github.pullRequestEvents(pr.number));

  let passes: PrStatus["passes"];
  let passesUsed: number | undefined;
  try {
    passesUsed = github.passesUsed(pr.number);
    passes = { used: passesUsed, cap: FOLLOW_UP_PASS_CAP };
  } catch (error) {
    passes = { unreadable: causeOf(error) };
  }

  // What decides whether the sweep takes the PR up. A read that fails here leaves the PR held, as the sweep leaves it alone for a round.
  let admitted: { subject: SweepSubject } | { skip: string };
  let origin: LabelOriginHold | undefined;
  let unreadable: string | undefined;
  try {
    admitted = admitToSweep(
      pr,
      context,
      {
        pullRequestBodyEdits: (number) => github.pullRequestBodyEdits(number),
        pullRequestComments: (number) => github.pullRequestComments(number),
        mergeOfMain: (commit) => github.mergeOfMain(commit),
        recordApprovedHead: () => {},
        isOwner: github.isOwner,
        repositoryOwner: () => github.repositoryOwner(),
      },
      eventsOfPr,
      log,
    );
    origin = "skip" in admitted ? undefined : labelOriginHold(pr, eventsOfPr(), github.isOwner);
  } catch (error) {
    admitted = { skip: "" };
    unreadable = `couldn't read what decides whether it is swept: ${causeOf(error)}`;
  }

  let thin = pr;
  let answered = 0;
  let threads: PrStatus["threads"];
  try {
    ({ pr: thin, answered } = withoutAnsweredThreads(pr, github, context.host));
    threads = splitThreads(thin.threads, github.isOwner, answered);
  } catch (error) {
    threads = { unreadable: causeOf(error) };
  }

  const subject = "subject" in admitted ? admitted.subject : undefined;
  let held: Held;
  if (unreadable !== undefined) {
    held = { state: "skipped", reason: unreadable };
  } else if ("unreadable" in threads && subject !== undefined && origin === undefined) {
    held = { state: "waiting", reason: `its threads couldn't be read (${threads.unreadable}), so the sweep leaves it alone this round` };
  } else {
    held = heldReason({
      pr,
      admitted,
      origin,
      decision: subject !== undefined && origin === undefined && !("unreadable" in threads) ? decide(thin, now, github.isOwner) : undefined,
      passesUsed,
      answered,
      human: "unreadable" in threads ? 0 : threads.other,
    });
  }

  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    subject: subject === undefined ? "not swept" : subject.kind,
    ...(subject?.kind === "issue" ? { issueNumber: subject.issueNumber } : {}),
    passes,
    held,
    threads,
    mergeState: pr.mergeStateStatus,
    draft: pr.isDraft,
    labels: pr.labels,
  };
}

// Reads everything the report shows. The open PRs failing to read throws: nothing can be said. Anything else that fails
// shows as unreadable in its place.
export function collectStatus(github: StatusGitHub, now: number = Date.now(), log: (line: string) => void = console.error): StatusReport {
  const { context } = sweepContext(github);
  const open = github.openPullRequests();
  const listed = open.filter((pr) => isListed(pr, context.host));
  const prs = [...listed].sort((a, b) => a.number - b.number).map((pr) => statusOf(pr, { context, now }, github, log));
  let runs: StatusReport["runs"];
  try {
    runs = github.workflowRuns(RUNS_SHOWN);
  } catch (error) {
    runs = { unreadable: causeOf(error) };
    log(`  ⚠ Couldn't read the Sandcastle workflow's runs: ${runs.unreadable}`);
  }
  return { repo: github.repo(), scope: describeQueueScope(github.queueScope()), prs, unlisted: open.length - listed.length, runs };
}

// The labels the report shows on a PR: the ones that say who is working on it, why it is held or who reviews it.
const SHOWN_LABELS = [BUILDING_LABEL, "sandcastle:needs-human", FOLLOW_UP_LABEL, "review:claude", QUEUE_LABEL, LOCAL_QUEUE_LABEL].map((label) =>
  label.toLowerCase(),
);

// One PR's lines.
function renderPr(status: PrStatus): string[] {
  const shown = status.labels.filter((label) => SHOWN_LABELS.includes(label.toLowerCase()));
  const state = status.draft ? `${status.mergeState}, draft` : status.mergeState;
  const subject =
    status.subject === "issue" && status.issueNumber !== undefined ? `issue #${status.issueNumber}` : status.subject === "issue" ? "issue" : status.subject;
  const passes = "unreadable" in status.passes ? `unknown (${status.passes.unreadable})` : `${status.passes.used} of ${status.passes.cap}`;
  const threads =
    "unreadable" in status.threads
      ? `unknown (${status.threads.unreadable})`
      : `bot ${status.threads.bot}, owner ${status.threads.owner}, other ${status.threads.other}` +
        (status.threads.answered > 0 ? `, answered ${status.threads.answered}` : "");
  return [
    `#${status.number} ${status.title}`,
    `  branch:   ${status.headRefName} (${state})${shown.length > 0 ? `, labels: ${shown.join(", ")}` : ""}`,
    `  for:      ${subject}`,
    `  passes:   ${passes}`,
    `  held:     ${status.held.state}: ${status.held.reason}`,
    `  threads:  ${threads}`,
  ];
}

// One workflow run's line: how it ended (or where it is), what started it, on which branch, when, and where to read it.
function renderRun(run: WorkflowRun): string {
  const icon = run.status !== "completed" ? "…" : run.conclusion === "success" ? "✓" : "✗";
  const result = run.status === "completed" ? (run.conclusion ?? run.status) : run.status;
  return `  ${icon} ${result} ${run.event} ${run.branch} ${run.createdAt} ${run.url}`;
}

// The report as plain text lines: no markdown and no colour, so it reads the same in a terminal, a log and a pipe.
export function renderStatus(report: StatusReport): string[] {
  const others = report.unlisted > 0 ? `${report.unlisted} other open PR(s) not listed` : "";
  const lines = [`Sandcastle status for ${report.repo} (queue: ${report.scope})`];
  if (report.prs.length === 0) {
    lines.push(`No open Sandcastle pull requests into main.${others === "" ? "" : ` ${others}.`}`);
  } else {
    lines.push(`${report.prs.length} open Sandcastle pull request(s) into main${others === "" ? "" : `, ${others}`}`);
    for (const status of report.prs) lines.push("", ...renderPr(status));
  }
  lines.push("");
  if ("unreadable" in report.runs) {
    lines.push("Sandcastle workflow runs:", `  unknown (${report.runs.unreadable})`);
  } else if (report.runs.length === 0) {
    lines.push("No Sandcastle workflow runs.");
  } else {
    lines.push(`Sandcastle workflow runs (latest ${report.runs.length}):`, ...report.runs.map(renderRun));
  }
  return lines;
}

// The queue scope status reports on: the default queue when the environment names none, so a bare `pnpm run sandcastle:status`
// shows what GitHub Actions' scope would do, hand-offs included. A variable that is set is read as the run does, with its errors.
export function statusScopeFrom(env: Record<string, string | undefined>): QueueScope {
  const named = (value: string | undefined) => value?.trim() !== undefined && value.trim() !== "";
  if (!named(env.SANDCASTLE_ISSUE) && !named(env.SANDCASTLE_LABEL) && env.GITHUB_ACTIONS !== "true") {
    return { kind: "label", label: QUEUE_LABEL };
  }
  return queueScopeFrom(env);
}

// The in-scope issues, read through loadQueue with its label fixes switched off, so reading the queue changes nothing. Each
// line it logs says so.
export function statusQueue(
  scope: QueueScope,
  queue: QueueGitHub,
  log: (line: string) => void,
): { number: number; labels: string[] }[] {
  const readOnly: QueueGitHub = { ...queue, removeLabel: () => {}, addLabel: () => {} };
  return loadQueue(scope, readOnly, (line) => log(`${line}${QUEUE_LOG_SUFFIX}`), new Set(), new Map()).map((issue) => ({
    number: issue.number,
    labels: issue.labels,
  }));
}

// Collects and prints the report; returns it. Prints nothing when the open PRs can't be read.
export function statusCommand(
  github: StatusGitHub = liveStatusGitHub,
  print: (line: string) => void = console.log,
  now: number = Date.now(),
): StatusReport {
  const report = collectStatus(github, now);
  for (const line of renderStatus(report)) print(line);
  return report;
}

// The live reads. Only the sweep's reads are taken from liveFollowUpGitHub, none of its writes, and the queue is read with
// its label fixes off (statusQueue).
export const liveStatusGitHub: StatusGitHub = {
  hostLogin: () => liveFollowUpGitHub.hostLogin(),
  openPullRequests: () => liveFollowUpGitHub.openPullRequests(),
  inScopeIssues: () => statusQueue(activeQueueScope(), liveQueueGitHub(), (line) => console.error(line)),
  followsHandOffs: () => liveFollowUpGitHub.followsHandOffs(),
  pullRequestEvents: (number) => liveFollowUpGitHub.pullRequestEvents(number),
  pullRequestBodyEdits: (number) => liveFollowUpGitHub.pullRequestBodyEdits(number),
  pullRequestComments: (number) => liveFollowUpGitHub.pullRequestComments(number),
  mergeOfMain: (commit) => liveFollowUpGitHub.mergeOfMain(commit),
  isOwner: liveFollowUpGitHub.isOwner,
  repositoryOwner: () => liveFollowUpGitHub.repositoryOwner(),
  reviewThreads: (number) => liveFollowUpGitHub.reviewThreads(number),
  passesUsed: (number) => followUpPassCount(number),
  workflowRuns: (limit) => sandcastleWorkflowRuns(limit),
  repo: () => repoName(),
  queueScope: () => activeQueueScope(),
};
