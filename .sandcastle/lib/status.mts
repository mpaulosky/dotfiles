// ---------------------------------------------------------------------------
// Sandcastle status
//
// The read-only status of the follow-up sweep: for each open Sandcastle pull
// request into main, how many follow-up passes it has used, why Sandcastle is
// holding it (the sweep's own answer), its unresolved threads split into bot,
// owner and other, and the Sandcastle workflow's recent runs. It owns the
// report's data and rendering, and writes nothing to GitHub or git.
// ---------------------------------------------------------------------------

import { inspect } from "node:util";
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

// What `decide` can't see: planPass (lib/follow-up-pass.mts) skips a flagged PR when there's no needed merge, no red check with an
// Actions run behind it and no thread for the role, or its head moved, or a thread author can't be checked. Status reads none of
// that, so a flag is the sweep's decision, not a promise that a pass runs.
export const PASS_MAY_SKIP = "a pass may still skip it: nothing it can re-run or fix, a thread author it can't identify, or a moved head";

// Where a PR stands with the sweep.
export type Held = {
  state: "skipped" | "waiting" | "flagged for a pass" | "flagged for a hand-back" | "act next sweep" | "settled";
  reason: string;
};

// A PR's unresolved threads by who opened them; `answered` are the ones the host replied to, which wait on the owner.
export type ThreadSplit = { bot: number; owner: number; other: number; answered: number };

// One PR's line in the report. A field that couldn't be read is `{ unreadable }` with the reason.
export type PrStatus = {
  number: number;
  title: string;
  headRefName: string;
  subject: "issue" | "hand-off" | "not swept" | "unknown";
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
// decision (made on the PR without the threads the host answered). `passesUsed` tells a flag for a pass from a flag for a hand-back, as
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
            state: "flagged for a hand-back",
            reason: `has had ${FOLLOW_UP_PASS_CAP} of ${FOLLOW_UP_PASS_CAP} passes and is flagged for another (${reasons}); a pass that has something to act on hands it back with sandcastle:needs-human (${PASS_MAY_SKIP})`,
          };
        }
        return { state: "flagged for a pass", reason: `${reasons} (${PASS_MAY_SKIP})` };
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

  // The full threads are read once, and a failed read matters even where the sweep carries on without them (a conflicting PR is
  // flagged whatever its threads say): the report shows those counts as unknown, never the unfiltered ones as if they were read.
  let thin = pr;
  let answered = 0;
  let threads: PrStatus["threads"];
  let threadsFailed: string | undefined;
  let threadsThrew = false;
  try {
    ({ pr: thin, answered } = withoutAnsweredThreads(
      pr,
      {
        isOwner: github.isOwner,
        reviewThreads: (number) => {
          try {
            return github.reviewThreads(number);
          } catch (error) {
            threadsFailed = causeOf(error);
            throw error;
          }
        },
      },
      context.host,
    ));
    threads = threadsFailed === undefined ? splitThreads(thin.threads, github.isOwner, answered) : { unreadable: threadsFailed };
  } catch (error) {
    // A throw from outside the reviewThreads read (the owner check, a thread's standing) has its cause here.
    threadsFailed ??= causeOf(error);
    threads = { unreadable: threadsFailed };
    threadsThrew = true;
  }

  const subject = "subject" in admitted ? admitted.subject : undefined;
  const split = "unreadable" in threads ? undefined : threads;
  const decidable = subject !== undefined && origin === undefined;
  let held: Held;
  if (unreadable !== undefined) {
    held = { state: "skipped", reason: unreadable };
  } else if (decidable && threadsThrew) {
    held = { state: "waiting", reason: `its threads couldn't be read (${threadsFailed}), so the sweep leaves it alone this round` };
  } else {
    // decide reads times GitHub returned and throws on one that doesn't parse, as it does in the sweep, which skips that PR for the
    // round: one PR's bad data shows as its own line and the others still print.
    try {
      held = heldReason({
        pr,
        admitted,
        origin,
        decision: decidable ? decide(thin, now, github.isOwner) : undefined,
        passesUsed,
        answered,
        human: split?.other ?? 0,
      });
    } catch (error) {
      held = { state: "skipped", reason: `couldn't decide: ${causeOf(error)}` };
    }
  }

  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    subject: unreadable !== undefined ? "unknown" : subject === undefined ? "not swept" : subject.kind,
    ...(subject?.kind === "issue" ? { issueNumber: subject.issueNumber } : {}),
    passes,
    held,
    threads,
    mergeState: pr.mergeStateStatus,
    draft: pr.isDraft,
    labels: pr.labels,
  };
}

// Reads everything the report shows. The host's login, the in-scope issues, the open PRs or the repository name failing to read throws: nothing can be said. Anything else that fails
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
    log(terminalLine(`  ⚠ Couldn't read the Sandcastle workflow's runs: ${runs.unreadable}`));
  }
  return { repo: github.repo(), scope: describeQueueScope(github.queueScope()), prs, unlisted: open.length - listed.length, runs };
}

// The labels the report shows on a PR: the ones that say who is working on it, why it is held or who reviews it.
const SHOWN_LABEL_NAMES = [BUILDING_LABEL, "sandcastle:needs-human", FOLLOW_UP_LABEL, "review:claude", QUEUE_LABEL, LOCAL_QUEUE_LABEL];
const SHOWN_LABELS = SHOWN_LABEL_NAMES.map((label) => label.toLowerCase());

// GitHub's and gh's text (a title, a branch, a reason, an error) made safe for a terminal: whitespace, including a line break, is one
// space, and every control character (ESC and the C1 set, so no CSI sequence), format character (bidi marks, zero-width characters,
// the soft hyphen, the Unicode tag block a model reads as hidden text), default-ignorable character, surrogate, noncharacter, filler that
// draws as a blank, and code point of the supplementary private-use planes is dropped. Nothing in it can overwrite a line of the report
// or fake one. Three joiners keep their place where they do the work they are for: a zero-width joiner between two assigned pictographs (an emoji
// sequence, with a skin tone or an emoji's variation selector in it), that variation selector right after an assigned pictograph, and a zero-width
// non-joiner between two letters of a script that uses it (Arabic, for Persian, and the Indic scripts; a zero-width joiner between two
// letters is dropped, so a conjunct such as Sinhala's "Sri" loses it). Anywhere else they are dropped, and at most MAX_KEPT_JOINERS
// survive in one text. What may still draw as nothing is capped too: at most MAX_KEPT_ODD private-use (an icon-font glyph) or unassigned
// code points, and no more than MAX_MARKS combining marks in a row, so a few invisible bits are all that can ride on one text. The cost: text
// that stacks more marks than that (Tibetan, Hebrew with niqqud and cantillation, some Indic clusters) loses the extras. Keycap and
// flag-tag emoji sequences fall apart.
export function terminalText(text: string): string {
  let kept = 0;
  let odd = 0;
  return (
    text
      // Not \s, which also takes U+FEFF, a byte order mark that is dropped like the other format characters.
      .replace(/[\t\n\v\f\r \u00a0\u0085\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, " ")
      .replace(HIDDEN_CHARACTERS, (character, offset: number, whole: string) => {
        const keep = kept < MAX_KEPT_JOINERS && keptJoiner(character, whole.slice(Math.max(0, offset - JOINER_LOOKBEHIND), offset), whole.slice(offset + character.length, offset + 3));
        if (keep) kept += 1;
        return keep ? character : "";
      })
      .replace(/[\p{Co}\p{Cn}]/gu, (character) => ((odd += 1) <= MAX_KEPT_ODD ? character : ""))
      .replace(new RegExp(`(\\p{M}{${MAX_MARKS}})\\p{M}+`, "gu"), "$1")
      // Dropping a character can leave the spaces on either side of it side by side.
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

// The most private-use or unassigned code points, and the most combining marks in a row, one text keeps.
const MAX_KEPT_ODD = 8;
const MAX_MARKS = 8;

const HIDDEN_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u034f\u115f\u1160\u2800\u3164\uffa0\u{F0000}-\u{10FFFF}]/gu;

// How much text before a joiner is read to decide whether it stays (a letter and its combining marks).
const JOINER_LOOKBEHIND = 16;

// The most joiners one text keeps.
const MAX_KEPT_JOINERS = 8;

// The scripts whose words need a zero-width non-joiner: Arabic (Persian too), Syriac, Thaana and the Indic scripts.
const ZWNJ_SCRIPTS = ["Arabic", "Syriac", "Thaana", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala"];
const ZWNJ_LETTER = `(?=\\p{L})[${ZWNJ_SCRIPTS.map((script) => `\\p{scx=${script}}`).join("")}]`;
const ZWNJ_AFTER_LETTER = new RegExp(`^${ZWNJ_LETTER}`, "u");
const ZWNJ_BEFORE_LETTER = new RegExp(`${ZWNJ_LETTER}\\p{M}*$`, "u");

// A pictograph that has been assigned: the reserved code points of the emoji blocks are Extended_Pictographic too, and the cap on unassigned
// code points could drop one after a joiner was kept for it.
const ASSIGNED_PICTOGRAPH = "(?!\\p{Cn})\\p{Extended_Pictographic}";
const ZWJ_AFTER_PICTOGRAPH = new RegExp(`${ASSIGNED_PICTOGRAPH}\\p{Emoji_Modifier}?\\ufe0f?$`, "u");
const PICTOGRAPH_AT_START = new RegExp(`^${ASSIGNED_PICTOGRAPH}`, "u");
const PICTOGRAPH_AT_END = new RegExp(`${ASSIGNED_PICTOGRAPH}$`, "u");

// Whether a joiner stays: `before` and `after` are the text on either side of it.
function keptJoiner(character: string, before: string, after: string): boolean {
  if (character === "\u200d") return ZWJ_AFTER_PICTOGRAPH.test(before) && PICTOGRAPH_AT_START.test(after);
  if (character === "\ufe0f") return PICTOGRAPH_AT_END.test(before);
  if (character === "\u200c") return ZWNJ_BEFORE_LETTER.test(before) && ZWNJ_AFTER_LETTER.test(after);
  return false;
}

// The most indent a log line keeps: more would let text GitHub supplied pad a line to look like a different one.
const MAX_INDENT = 8;

// A line a log writes, as plain text: terminalText, with the indent the line starts with kept (up to MAX_INDENT).
export function terminalLine(line: string): string {
  return (/^ */.exec(line)?.[0] ?? "").slice(0, MAX_INDENT) + terminalText(line);
}

// One PR's lines.
function renderPr(status: PrStatus): string[] {
  // A label is printed as the report's own spelling of it, never GitHub's string, so what a label is named can't reach the terminal.
  const shown = status.labels.flatMap((label) => {
    const known = SHOWN_LABELS.indexOf(label.toLowerCase());
    return known < 0 ? [] : [SHOWN_LABEL_NAMES[known] as string];
  });
  const state = terminalText(status.draft ? `${status.mergeState}, draft` : status.mergeState);
  const subject = status.subject === "issue" && status.issueNumber !== undefined ? `issue #${status.issueNumber}` : status.subject;
  const passes = "unreadable" in status.passes ? `unknown (${terminalText(status.passes.unreadable)})` : `${status.passes.used} of ${status.passes.cap}`;
  const threads =
    "unreadable" in status.threads
      ? `unknown (${terminalText(status.threads.unreadable)})`
      : `bot ${status.threads.bot}, owner ${status.threads.owner}, other ${status.threads.other}` +
        (status.threads.answered > 0 ? `, answered ${status.threads.answered}` : "");
  return [
    `#${status.number} ${terminalText(status.title)}`,
    `  branch:   ${terminalText(status.headRefName)} (${state})${shown.length > 0 ? `, labels: ${shown.join(", ")}` : ""}`,
    `  for:      ${subject}`,
    `  passes:   ${passes}`,
    `  held:     ${status.held.state}: ${terminalText(status.held.reason)}`,
    `  threads:  ${threads}`,
  ];
}

// One workflow run's line: how it ended (or where it is), what started it, on which branch, when, and where to read it.
function renderRun(run: WorkflowRun): string {
  const icon = run.status !== "completed" ? "…" : run.conclusion === "success" ? "✓" : "✗";
  const result = run.status === "completed" ? (run.conclusion ?? run.status) : run.status;
  return `  ${icon} ${terminalText(`${result} ${run.event} ${run.branch} ${run.createdAt} ${run.url}`)}`;
}

// The report as plain text lines: no markdown and no colour, so it reads the same in a terminal, a log and a pipe.
export function renderStatus(report: StatusReport): string[] {
  const others = report.unlisted > 0 ? `${report.unlisted} other open PR(s) not listed` : "";
  const lines = [`Sandcastle status for ${terminalText(report.repo)} (queue: ${terminalText(report.scope)})`];
  if (report.prs.length === 0) {
    lines.push(`No open Sandcastle pull requests into main.${others === "" ? "" : ` ${others}.`}`);
  } else {
    lines.push(`${report.prs.length} open Sandcastle pull request(s) into main${others === "" ? "" : `, ${others}`}`);
    for (const status of report.prs) lines.push("", ...renderPr(status));
  }
  lines.push("");
  if ("unreadable" in report.runs) {
    lines.push("Sandcastle workflow runs:", `  unknown (${terminalText(report.runs.unreadable)})`);
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
  const named = (value: string | undefined) => (value ?? "").trim() !== "";
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
  return loadQueue(scope, readOnly, (line) => log(terminalLine(`${line}${QUEUE_LOG_SUFFIX}`)), new Set(), new Map()).map((issue) => ({
    number: issue.number,
    labels: issue.labels,
  }));
}

// Collects and prints the report; returns it. Prints nothing when the host's login, the in-scope issues, the open PRs or the repository name can't be read.
export function statusCommand(
  github: StatusGitHub = liveStatusGitHub,
  print: (line: string) => void = console.log,
  now: number = Date.now(),
): StatusReport {
  const report = collectStatus(github, now);
  for (const line of renderStatus(report)) print(line);
  return report;
}

// Makes console.error print plain text, so a warning a read prints (a login, gh's own message) can't carry a control or hidden
// character to the terminal. Takes the console to change, for a test. The arguments are joined as data, never as a format string: a %
// in GitHub's text takes nothing from the arguments after it.
export function plainStderr(target: { error: (...data: unknown[]) => void } = console): void {
  const print = target.error.bind(target);
  target.error = (...data: unknown[]) => {
    const items = data.map((item) => (typeof item === "string" ? item : item instanceof Error ? item.message : inspect(item)));
    print(terminalLine(items.join(" ")));
  };
}

// The live reads. Only the sweep's reads are taken from liveFollowUpGitHub, none of its writes, and the queue is read with
// its label fixes off (statusQueue).
export const liveStatusGitHub: StatusGitHub = {
  hostLogin: () => liveFollowUpGitHub.hostLogin(),
  openPullRequests: () => liveFollowUpGitHub.openPullRequests(),
  inScopeIssues: () => statusQueue(activeQueueScope(), liveQueueGitHub(), (line) => console.error(terminalLine(line))),
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
