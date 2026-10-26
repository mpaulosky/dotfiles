// ---------------------------------------------------------------------------
// Intake
//
// A run before the blocker gate judges every unjudged Sandcastle issue
// against the Definition of Ready (see Blazor-Server's docs/plans/sandcastle-workflow.md,
// "Phase 2: Intake"), so a human sees numbered questions on an unclear issue
// instead of Sandcastle guessing at it. Its verdicts are "ready"
// (sandcastle:ready), "needs-info" (hands the issue back with
// sandcastle:needs-info and one comment of numbered questions), and "split"
// (too big for one PR, so the host creates child issues from the
// verdict's children and turns the original into an umbrella). Every verdict
// can also carry bug: true, which adds the bug label so the issue's branch is
// fix/.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { z } from "zod";
import { runRole } from "./agents.mts";
import {
  BUILDING_LABEL,
  INTAKE_BATCH_SIZE,
  INTAKE_FAILED_RUNS_LIMIT,
  INTAKE_REFUSED_BATCHES_LIMIT,
  queueLabelOf,
  UMBRELLA_MARKER,
} from "./config.mts";
import { hooks } from "./repo-config.mts";
import { UncountedStopError } from "./errors.mts";
import { bodyBlockers, openPrReason } from "./gate.mts";
import { breakReferences, plainText } from "./plain-text.mts";
import {
  addBlockedBy,
  addIssueLabel,
  addSubIssue,
  commentOnIssue,
  createIssue,
  handBack,
  hasLabel,
  issueLabels,
  removeIssueLabel,
  repoName,
  sameRepoBlockers,
  type OpenPullRequest,
  type SandcastleIssue,
} from "./github.mts";
import { intakePromptArgs } from "./prompts.mts";
import { activeQueueScope } from "./queue.mts";
import { handBackReport, intakeStopReport, type HandBackReport, type IntakeStopReport } from "./report.mts";
import { agentSandbox } from "./skills.mts";

// Lenient where a slip is harmless, because one verdict that fails the schema
// costs every verdict in the block: the issue JSON gives `number` as a
// number, so a numeric id is taken as a string, and a missing bug means false.
const intakeSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      verdict: z.enum(["ready", "needs-info", "split"]),
      questions: z.array(z.string()).optional(),
      // Only for a split verdict: the drafted child issues, in build order.
      // Whether it's well-formed (at least one child, each carrying
      // acceptance criteria) is checked when the verdict is applied, not here.
      children: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
      bug: z.boolean().default(false),
      reason: z.string(),
    }),
  ),
});

export type IntakeVerdict = z.infer<typeof intakeSchema>["verdicts"][number];

// The GitHub writes applying a split verdict needs; tests pass a stub. Each
// child is created and linked before the original loses Sandcastle and gets
// the umbrella comment, so a failure partway through never leaves an umbrella
// with missing children (see applySplit for what it leaves instead).
export type SplitGitHub = {
  // Creates one child with `labels` already on it. Returns its number.
  createChild(title: string, body: string, labels: readonly string[]): number;
  // Adds `child` as a sub-issue of `parent` (the original issue being split).
  addSubIssue(parent: number, child: number): void;
  // Links `child` as blocked by the one before it in build order.
  addBlockedBy(child: number, blocker: number): void;
  // The original issue's native "blocked by" links in this repository.
  blockersOf(issue: number): number[];
  // Removes the queue label (see queueLabel) from the original issue, which
  // has become an umbrella.
  removeSandcastle(issue: number): void;
  comment(issue: number, body: string): void;
  // Adds and removes the mark (sandcastle:needs-human) that keeps the issue
  // out of intake while it's being split, so neither a concurrent run nor a
  // later round splits it a second time, and takes the same mark off each
  // child once the split has finished (see applySplit).
  markSplitting(issue: number): void;
  unmarkSplitting(issue: number): void;
  // The label this run's queue scope approves issues with (lib/config.mts),
  // so a split under a non-default scope (SANDCASTLE_LABEL) queues its
  // children in that scope rather than GitHub Actions'.
  queueLabel(): string;
};

export const liveSplitGitHub: SplitGitHub = {
  createChild: createIssue,
  addSubIssue,
  addBlockedBy,
  blockersOf: (issue) => sameRepoBlockers(issue),
  // The scope's own queue label (see queueLabel), which a split moves from
  // the original to its children.
  removeSandcastle: (issue) => removeIssueLabel(issue, queueLabelOf(activeQueueScope())),
  comment: commentOnIssue,
  markSplitting: (issue) => addIssueLabel(issue, "sandcastle:needs-human"),
  unmarkSplitting: (issue) => removeIssueLabel(issue, "sandcastle:needs-human"),
  queueLabel: () => queueLabelOf(activeQueueScope()),
};

// The labels that mean intake has judged the issue, or a person has to act
// on it before anything else happens.
const JUDGED_LABELS = ["sandcastle:ready", "sandcastle:needs-info", "sandcastle:needs-human"];

// The open Sandcastle issues intake hasn't judged yet: carrying none of
// sandcastle:ready, sandcastle:needs-info and sandcastle:needs-human.
// Includes blocked issues, so a human sees intake's questions while a
// blocker is still in flight; the blocker gate runs after intake. Leaves out
// an issue another run is building (sandcastle:building) or whose PR is in
// `openPrs`: its work is already done or under way, so questions on it would
// only be noise for whoever reviews it.
export function needsIntake(issues: readonly SandcastleIssue[], openPrs: readonly OpenPullRequest[] = []): SandcastleIssue[] {
  return issues.filter(
    (issue) =>
      !JUDGED_LABELS.some((label) => hasLabel(issue, label)) &&
      !hasLabel(issue, BUILDING_LABEL) &&
      openPrReason(issue.number, [...openPrs]) === undefined,
  );
}

export type IntakeRun = (promptArgs: ReturnType<typeof intakePromptArgs>) => Promise<IntakeVerdict[]>;

// The live intake run: the intake role on intake-prompt.md, in a sandbox,
// asking for an <intake> block checked against intakeSchema. Sandcastle
// throws StructuredOutputError when the tag is missing, the JSON is malformed
// or it doesn't match the schema. `run` and `sandbox` are Sandcastle's,
// passed in so a test can stub them.
export function intakeRunner(run: typeof runRole = runRole, sandbox: typeof agentSandbox = agentSandbox): IntakeRun {
  return async (promptArgs) => {
    const intake = await run("intake", {
      hooks,
      sandbox: sandbox(),
      promptFile: "./.sandcastle/intake-prompt.md",
      promptArgs,
      output: sandcastle.Output.object({ tag: "intake", schema: intakeSchema }),
    });
    return intake.output.verdicts;
  };
}

const runIntake: IntakeRun = intakeRunner();

// Apply intake's verdicts to the issues sent to it. A ready verdict adds
// sandcastle:ready with one comment saying why. A needs-info verdict hands
// the issue back (lib/github.mts#handBack) with sandcastle:needs-info and one
// comment of numbered questions, recording the hand-back in `report` for the
// run's summary; the issue keeps Sandcastle either way. A split verdict
// creates the drafted children through `splitGithub` and turns the original
// into an umbrella (see applySplit). Any verdict can also add the bug label,
// when it carries bug: true. A verdict for an id that wasn't sent to intake
// is ignored and logged.
//
// Returns how many verdicts GitHub took and refused, the first refusal's
// error, and the issues settled (a verdict GitHub took, or one another run
// gave first), so intakeRound can record which issues a stop leaves behind
// and why.
export function applyVerdicts(
  issues: readonly SandcastleIssue[],
  verdicts: readonly IntakeVerdict[],
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  report: HandBackReport = handBackReport,
  log: (line: string) => void = console.log,
  splitGithub: SplitGitHub = liveSplitGitHub,
): { applied: number; failed: number; firstError: unknown; settled: number[] } {
  const sent = new Map(issues.map((issue) => [String(issue.number), issue]));
  const judged = new Set<string>();
  // Judged by this verdict or, since the queue was read, by another run.
  const settled = new Set<string>();
  const counts = { applied: 0, failed: 0 };
  let firstError: unknown;

  for (const verdict of verdicts) {
    const ref = `#${verdict.id}`;
    const issue = sent.get(verdict.id);
    if (!issue) {
      log(`  ⚠ Ignoring intake's verdict on ${ref}: it wasn't sent to intake.`);
      continue;
    }
    if (judged.has(verdict.id)) {
      log(`  ⚠ Ignoring another intake verdict on ${ref}: it already has a verdict.`);
      continue;
    }

    // Handing an issue back with no questions would leave its author nothing
    // to answer, so such a verdict counts as none: checked before the issue
    // counts as judged, so a valid verdict after it still applies.
    if (verdict.verdict === "needs-info" && questionsOf(verdict).length === 0) {
      log(`  ⚠ Ignoring intake's needs-info verdict on ${ref}: it has no questions.`);
      continue;
    }
    judged.add(verdict.id);

    // A failed gh call before the verdict's labels land leaves the issue
    // unjudged, so the gate holds it back and intake judges it again in a
    // later round, or on the next run when nothing else is ready and this run
    // ends after the gate.
    try {
      // Another Sandcastle run may have judged the issue since this round read
      // the queue: applying this verdict too would leave two comments,
      // possibly conflicting ones.
      if (JUDGED_LABELS.some((label) => hasLabel({ labels: issueLabels(issue.number, run, repo) }, label))) {
        log(`  ⚠ Skipping intake's verdict on ${ref}: another run has judged it since this round read the queue.`);
        settled.add(verdict.id);
        continue;
      }
      log(`  ${applyVerdict(issue, verdict, run, repo, report, log, splitGithub)}`);
    } catch (error) {
      log(`  ⚠ Couldn't apply intake's ${verdict.verdict} verdict on ${ref}, so it's judged again in a later round or run: ${error}`);
      counts.failed += 1;
      if (counts.failed === 1) firstError = error;
      continue;
    }
    counts.applied += 1;
    settled.add(verdict.id);
  }

  for (const id of sent.keys()) {
    if (!judged.has(id)) log(`  ⚠ Intake gave no verdict on #${id}, so it's judged again in a later round or run.`);
  }
  return {
    ...counts,
    firstError,
    settled: issues.filter((issue) => settled.has(String(issue.number))).map((issue) => issue.number),
  };
}

// Adds the verdict's labels and posts its one comment, and returns the line
// to log saying what it did.
//
// A ready verdict adds bug, when it carries bug: true, and sandcastle:ready in
// one edit, so the issue never gets built on a feature/ branch, and the
// comment comes after: a failed edit posts nothing, so judging the issue again
// next round can't leave a second comment, and a rejected comment costs only
// the explanation of labels already on the issue, which is logged.
//
// A needs-info verdict adds bug first, so a failed bug edit leaves the issue
// unjudged rather than handed back without it. The hand-back then posts the
// questions before adding sandcastle:needs-info, as everywhere handBack is
// used: a label without its questions would leave the author nothing to
// answer, which is worse than the second comment a failed label edit can cost.
//
// A split verdict is applied by applySplit.
function applyVerdict(
  issue: SandcastleIssue,
  verdict: IntakeVerdict,
  run: typeof execFileSync,
  repo: string,
  report: HandBackReport,
  log: (line: string) => void,
  splitGithub: SplitGitHub,
): string {
  const number = issue.number;
  const bugNote = verdict.bug ? " (a bug)" : "";
  if (verdict.verdict === "needs-info") {
    if (verdict.bug) addIssueLabel(number, "bug", run, repo);
    handBack({ kind: "issue", number }, "sandcastle:needs-info", verdict.reason, needsInfoComment(verdict), run, repo, report);
    return `✋ Intake hands #${number} back with sandcastle:needs-info${bugNote}: ${verdict.reason}`;
  }
  if (verdict.verdict === "split") return applySplit(issue, verdict, run, repo, report, log, splitGithub);
  addIssueLabel(number, verdict.bug ? ["bug", "sandcastle:ready"] : "sandcastle:ready", run, repo);
  try {
    commentOnIssue(number, readyComment(verdict), run, repo);
  } catch (error) {
    log(`  ⚠ #${number} is marked sandcastle:ready, but posting intake's reason failed: ${error}`);
  }
  return `✓ Intake marks #${number} ready${bugNote}: ${verdict.reason}`;
}

// Applies a split verdict, and returns the line to log saying what it did.
//
// A well-formed split creates each drafted child in build order with
// Sandcastle (and bug, when the verdict carries bug: true), adds it as a
// sub-issue of the original, and links it as blocked by the child before it.
// Only then does the original lose Sandcastle and get the umbrella comment
// listing its children, which lib/umbrella.mts finds it by in later rounds.
// The children go through intake on their own in the next round. Their title
// and body are model text posted from the host's account, so mentions and
// cross-references in them are broken (see withoutReferences). Each title
// also gets the original's conventional prefix (see withParentPrefix).
//
// A split with no children, or a child without a title or acceptance
// criteria, is malformed: nothing is created, and the issue is handed back
// with sandcastle:needs-info and a question asking a human to split it.
//
// The first child also takes over the original's blockers, native and in its
// body, since the original stops being built once it loses Sandcastle. They're
// read before anything is created, and go in the child's body as a "Blocked
// by" line the gate reads (lib/gate.mts#bodyBlockers) rather than as native
// links: GitHub may refuse to link one (a typo, a pull request), which would
// fail the split partway. A failure reading them leaves the issue unjudged,
// with nothing created.
//
// Before the first child is created, the issue is marked with
// sandcastle:needs-human, which intake and the gate leave alone, so neither a
// concurrent run nor a later round splits it a second time. Each child is
// created with the same mark, so none is built before the split has finished.
// The marks come off, the children's first, once the umbrella comment is
// posted. A failure marking the issue leaves it unjudged, with nothing
// created, and the mark is taken back off in case GitHub added it anyway. Any
// failure after that hands it back with sandcastle:needs-human, even before
// the first child exists: a create that GitHub answered with an error may
// still have created the child. When the hand-back fails too, the marks still
// keep the issue and its children out of intake.
function applySplit(
  issue: SandcastleIssue,
  verdict: IntakeVerdict,
  run: typeof execFileSync,
  repo: string,
  report: HandBackReport,
  log: (line: string) => void,
  splitGithub: SplitGitHub,
): string {
  const number = issue.number;
  const drafted = verdict.children ?? [];
  const problem = splitProblem(drafted);
  if (problem !== undefined) {
    if (verdict.bug) addIssueLabel(number, "bug", run, repo);
    handBack(
      { kind: "issue", number },
      "sandcastle:needs-info",
      `intake couldn't split it: ${problem}`,
      malformedSplitComment(verdict, problem),
      run,
      repo,
      report,
    );
    return `✋ Intake hands #${number} back with sandcastle:needs-info: it couldn't split it, since ${problem}.`;
  }

  const blockers = new Set([...splitGithub.blockersOf(number), ...bodyBlockers(issue.body)]);
  blockers.delete(number);
  const blockedByLine = blockers.size > 0 ? `\n\nBlocked by ${[...blockers].map((blocker) => `#${blocker}`).join(", ")}` : "";
  try {
    splitGithub.markSplitting(number);
  } catch (error) {
    // GitHub may have added the label despite the error, and would then hold
    // the issue back with nothing saying why.
    try {
      splitGithub.unmarkSplitting(number);
    } catch (unmarkError) {
      log(`  ⚠ Marking #${number} for its split failed, and so did taking the mark back off: if it carries sandcastle:needs-human, remove it by hand: ${unmarkError}`);
    }
    throw error;
  }
  const queueLabel = splitGithub.queueLabel();
  const labels = [queueLabel, ...(verdict.bug ? ["bug"] : []), "sandcastle:needs-human"];
  const children: SplitChild[] = [];
  let sandcastleRemoved = false;
  // The title of the child being created, while its create call runs.
  let creating: string | undefined;
  try {
    for (const draft of drafted) {
      const title = withoutReferences(withParentPrefix(issue.title, draft.title.trim()));
      creating = title;
      // Added after withoutReferences, which would otherwise break its refs.
      const body = withoutReferences(draft.body) + (children.length === 0 ? blockedByLine : "");
      const child = { number: splitGithub.createChild(title, body, labels), title };
      creating = undefined;
      const previous = children.at(-1);
      children.push(child);
      splitGithub.addSubIssue(number, child.number);
      if (previous) splitGithub.addBlockedBy(child.number, previous.number);
    }
    splitGithub.removeSandcastle(number);
    sandcastleRemoved = true;
    splitGithub.comment(number, umbrellaComment(verdict, children));
  } catch (error) {
    const created = children.length > 0 ? `after creating ${issueRefs(children)}` : "before creating any child";
    log(`  ⚠ Splitting #${number} failed ${created}: ${error}`);
    try {
      handBack(
        { kind: "issue", number },
        "sandcastle:needs-human",
        "splitting it into child issues failed partway",
        partialSplitComment(children, creating, sandcastleRemoved),
        run,
        repo,
        report,
      );
    } catch (handBackError) {
      log(`  ⚠ Splitting #${number} failed, and handing it back failed too; it keeps sandcastle:needs-human, so intake leaves it alone: ${handBackError}`);
    }
    return `🛑 Intake's split of #${number} failed partway, so it's handed back with sandcastle:needs-human.`;
  }
  // Each child carries the mark from its creation, so none is built before the
  // split has finished; it comes off the children first, then the umbrella.
  for (const held of [...children.map((child) => child.number), number]) {
    try {
      splitGithub.unmarkSplitting(held);
    } catch (error) {
      log(`  ⚠ #${number}'s split finished, but removing sandcastle:needs-human from #${held} failed, so a person has to: ${error}`);
    }
  }
  const bugNote = verdict.bug ? " (a bug)" : "";
  return `✂ Intake splits #${number} into ${issueRefs(children)}${bugNote}: ${verdict.reason}`;
}

type SplitChild = { number: number; title: string };

// A conventional-commit prefix as scripts/check-pr-title.sh accepts it: a
// type, an optional scope, an optional breaking-change marker, a colon and a
// space.
const conventionalPrefix = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]+\))?!?: /;

// A split child's drafted title with the parent title's conventional prefix in
// front, so the PR built from the child passes the PR title check, which wants
// that prefix since the title becomes the squash commit's subject. The model
// drafts child titles without one (one split's children came back bare,
// and the PR built from the first failed the check). A drafted title that already
// has a prefix, or a parent title with none, leaves the draft as it is.
function withParentPrefix(parentTitle: string, drafted: string): string {
  const prefix = conventionalPrefix.exec(parentTitle.trim())?.[0];
  if (prefix === undefined || conventionalPrefix.test(drafted)) return drafted;
  return prefix + drafted;
}

function issueRefs(children: readonly SplitChild[]): string {
  return children.map((child) => `#${child.number}`).join(", ");
}

// Why a split verdict's drafted children can't be applied, or undefined when
// they can. Each child must carry acceptance criteria, since a child without
// any would only be handed back by intake next round.
function splitProblem(drafted: readonly { title: string; body: string }[]): string | undefined {
  if (drafted.length === 0) return "it drafted no child issues";
  const untitled = drafted.findIndex((draft) => draft.title.trim() === "");
  if (untitled !== -1) return `its drafted child ${untitled + 1} has no title`;
  const withoutCriteria = drafted.find((draft) => !hasAcceptanceCriteria(draft.body));
  if (withoutCriteria) return `its drafted child "${plainText(withoutCriteria.title)}" has no acceptance criteria`;
  return undefined;
}

// Whether `body` has an "Acceptance criteria" heading with something under
// it before the next heading, as intake-prompt.md asks each child to have.
function hasAcceptanceCriteria(body: string): boolean {
  const lines = body.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteri(a|on)\b/i.test(line));
  if (start === -1) return false;
  const section = lines.slice(start + 1);
  const end = section.findIndex((line) => /^#{1,6}\s/.test(line));
  return section.slice(0, end === -1 ? undefined : end).some((line) => line !== "");
}

// The umbrella comment on a split issue: UMBRELLA_MARKER, which
// lib/umbrella.mts finds it by, the children in build order, and why.
export function umbrellaComment(verdict: IntakeVerdict, children: readonly SplitChild[]): string {
  const bugNote = verdict.bug ? ", each labelled `bug` (so its branch is `fix/`)" : "";
  return [
    UMBRELLA_MARKER,
    "Sandcastle's intake found this issue meets the Definition of Ready but is too big for one pull request, " +
      `so it split it into these sub-issues${bugNote}. They're built in this order, each blocked by the one before it:`,
    children.map((child, i) => `${i + 1}. #${child.number} ${plainText(child.title)}`).join("\n"),
    `**Reason:** ${plainText(verdict.reason)}`,
    "This issue no longer carries `Sandcastle`, so it isn't built itself. Sandcastle closes it as completed once every sub-issue has closed as completed.",
  ].join("\n\n");
}

// The one comment on an issue intake meant to split but couldn't: why, and
// the question asking a human to split it, with how to re-queue it.
function malformedSplitComment(verdict: IntakeVerdict, problem: string): string {
  const bugNote = verdict.bug ? " and labelled `bug` (so its branch is `fix/`)" : "";
  return handBackComment(
    `Sandcastle's intake found this issue too big for one pull request, but couldn't split it: ${problem}. ` +
      `So it's handed back with \`sandcastle:needs-info\`${bugNote}. Sandcastle won't build it while it carries that label.`,
    verdict.reason,
    [
      "Can you split this issue into smaller issues that each fit one pull request, each with a Summary and its own share of these acceptance criteria, " +
        "or narrow this issue so it fits one?",
    ],
  );
}

// The comment on an issue whose split failed partway: which children exist,
// which one may exist without the host knowing (`unconfirmed`, the title of
// the child whose create call failed, if one did), and how a person recovers,
// which depends on whether the split had already removed Sandcastle. Every
// child carries sandcastle:needs-human, so none is built meanwhile. Closing a
// child as completed would let closeFinishedUmbrellas close this issue too,
// so the steps say not planned. The error itself is only logged, since this
// is a public issue.
function partialSplitComment(children: readonly SplitChild[], unconfirmed: string | undefined, sandcastleRemoved: boolean): string {
  const created = children.length > 0
    ? `These sub-issues were created, and carry \`sandcastle:needs-human\` so Sandcastle doesn't build them meanwhile:\n\n${children.map((child) => `- #${child.number} ${plainText(child.title)}`).join("\n")}`
    : "No sub-issue was confirmed created.";
  const requeue = sandcastleRemoved
    ? "close each sub-issue as not planned and remove it from this issue's sub-issues, add `Sandcastle` back (the split had already removed it), and remove `sandcastle:needs-human`"
    : "close each sub-issue as not planned and remove it from this issue's sub-issues, then remove `sandcastle:needs-human`";
  return [
    "Sandcastle's intake started splitting this issue into sub-issues, but a GitHub call failed partway, so it's handed back with `sandcastle:needs-human` " +
      "rather than split a second time. The run log has the error.",
    created +
      (unconfirmed === undefined ? "" : ` The call that failed may still have created one titled "${plainText(unconfirmed)}", so check the issue list for it too.`),
    `To have intake judge this issue again, ${requeue}.`,
    "Or finish the split by hand: link each sub-issue to this one, each blocked by the one before it, and remove `sandcastle:needs-human` from each" +
      `${sandcastleRemoved ? "" : ", and remove `Sandcastle` from this issue"}. Sandcastle doesn't close an umbrella that carries \`sandcastle:needs-human\`, ` +
      "so close this issue yourself once every sub-issue is done.",
  ].join("\n\n");
}

// The comment on an issue intake judged ready: what the host did, and why.
export function readyComment(verdict: IntakeVerdict): string {
  const labels = verdict.bug ? "`sandcastle:ready` and `bug` (so its branch is `fix/`)" : "`sandcastle:ready`";
  return [
    `Sandcastle's intake found this issue meets the Definition of Ready, so it added ${labels}. It's built once its blockers, if any, have landed.`,
    `**Reason:** ${plainText(verdict.reason)}`,
    "To have intake judge it again, remove `sandcastle:ready`.",
  ].join("\n\n");
}

// The verdict's questions as one line each, ready to number: trimmed, with
// internal line breaks collapsed (a blank line would end the Markdown list
// and restart its numbering), any numbering intake added itself (a number,
// then . or ), then a space) removed, blank ones dropped, and the rest made
// plain text (see plainText).
function questionsOf(verdict: IntakeVerdict): string[] {
  return (verdict.questions ?? [])
    .map((question) => question.replace(/\s+/g, " ").trim().replace(/^\d+[.)]\s+/, ""))
    .filter((question) => question !== "")
    .map(plainText);
}

// `text` from intake with every mention and cross-reference broken (see
// plainText), but its Markdown kept: for a split's child issues, which need
// their headings and checkboxes. A character reference is escaped, since
// &#64; would otherwise render as an @ these rules never saw. Code spans and
// fenced blocks are left as written: mentions and references don't fire
// there, and a child is a build spec, whose Razor directives (@page, @inject)
// an agent must be able to copy as they are.
export function withoutReferences(text: string): string {
  const prose = (part: string) => breakReferences(part.replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;"));
  // As CommonMark reads them: a fenced block, to its closing fence or the end
  // of the text, whose opener, if backticks, has no backtick in its info
  // string; or a code span, from a run of backticks with no unescaped
  // backslash before it to the next run of the same length, without crossing
  // a blank line or the start of a block (a heading, list item or quote).
  const code =
    /^ {0,3}(`{3,}(?=[^`\n]*$)|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[^\S\n]*$|(?![\s\S]))|(?<!(?<!\\)(?:\\\\)*\\)(`+)(?!`)(?:(?!\n[ \t]*(?:\n|#|[-*+>] |\d+[.)] ))[\s\S])*?(?<!`)\2(?!`)/gm;
  let result = "";
  let last = 0;
  for (const match of text.matchAll(code)) {
    result += prose(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + prose(text.slice(last));
}

// The one comment on an issue intake handed back: why, the numbered
// questions a person must answer, and how to put it back in the queue.
export function needsInfoComment(verdict: IntakeVerdict): string {
  const bugNote = verdict.bug ? " and labelled `bug` (so its branch is `fix/`)" : "";
  return handBackComment(
    `Sandcastle's intake found this issue doesn't meet the Definition of Ready yet, so it's handed back with \`sandcastle:needs-info\`${bugNote}. ` +
      "Sandcastle won't build it while it carries that label.",
    verdict.reason,
    questionsOf(verdict),
  );
}

// A sandcastle:needs-info comment: what the host did, why, the numbered
// questions, and how to put the issue back in the queue.
function handBackComment(lead: string, reason: string, questions: readonly string[]): string {
  return [
    lead,
    `**Reason:** ${plainText(reason)}`,
    ...(questions.length > 0
      ? ["Please answer these questions by editing the issue:", questions.map((question, i) => `${i + 1}. ${question}`).join("\n")]
      : []),
    "Once the issue is edited, remove `sandcastle:needs-info` to put it back in the queue, and intake judges it again. " +
      "Removing a label takes triage access: if you can't, ask a maintainer to remove it. A reply alone doesn't re-queue it.",
  ].join("\n\n");
}

// Judge every issue intake hasn't judged yet against the Definition of Ready,
// and apply the verdicts. Skipped, without running intake, when there's
// nothing left to judge. `openPrs` are the open pull requests, whose issues
// intake leaves alone (see needsIntake).
//
// Intake runs once per batch of INTAKE_BATCH_SIZE issues, so a malformed or
// truncated answer costs only its batch, and the next batch is still
// judged. A batch whose run fails is tried again in halves, and each
// half that fails again in halves, so an issue that always breaks intake's
// answer is left unjudged on its own rather than with its batch-mates: they'd
// otherwise re-form the same batch every round. Whatever is left
// unjudged is logged and judged again in a later round or run.
//
// Intake stops for the round after INTAKE_FAILED_RUNS_LIMIT failed runs in a
// row, since a failure every run hits (a sandbox that won't start, say) would
// otherwise cost a run for every split of every batch, and once GitHub has
// refused every verdict in INTAKE_REFUSED_BATCHES_LIMIT batches in a row,
// since each later batch would then cost a run for nothing. An UncountedStopError (a usage limit or time budget) still
// ends the run.
//
// Either stop is recorded in `stops` (lib/report.mts#IntakeStopReport) with
// its reason, the issue numbers intake never judged this round, and the
// first error's message in the streak that stopped it, so a run that can't
// do its work ends red instead of silently exiting 0.
export async function intakeRound(
  issues: readonly SandcastleIssue[],
  openPrs: readonly OpenPullRequest[],
  run: IntakeRun = runIntake,
  gh: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  report: HandBackReport = handBackReport,
  log: (line: string) => void = console.log,
  warn: (message: string) => void = console.error,
  stops: IntakeStopReport = intakeStopReport,
): Promise<void> {
  const refs = (batch: readonly SandcastleIssue[]) => batch.map((issue) => `#${issue.number}`).join(", ");
  let failedInARow = 0;
  let refusedInARow = 0;
  // The first error of each streak, for the stop's record.
  let firstFailure: unknown;
  let firstRefusal: unknown;
  // Issues a verdict settled this round; the rest are left unjudged.
  const settled = new Set<number>();
  // Why intake stopped for the round, once it has, and the error that began
  // the streak that stopped it.
  let stopped: { reason: string; firstError: unknown } | undefined;

  // Runs intake over `batch` and applies its verdicts. Returns the run's
  // error when it failed, or undefined.
  async function judge(batch: SandcastleIssue[]): Promise<unknown> {
    log(`Intake is judging ${batch.length} issue(s) against the Definition of Ready: ${refs(batch)}`);
    let verdicts: IntakeVerdict[];
    try {
      verdicts = await run(intakePromptArgs(batch));
    } catch (error) {
      if (error instanceof UncountedStopError) throw error;
      const failure = error ?? new Error("intake failed");
      failedInARow += 1;
      if (failedInARow === 1) firstFailure = failure;
      if (failedInARow >= INTAKE_FAILED_RUNS_LIMIT) {
        stopped = { reason: `${INTAKE_FAILED_RUNS_LIMIT} intake runs in a row failed`, firstError: firstFailure };
      }
      return failure;
    }
    failedInARow = 0;
    const { applied, failed, firstError, settled: settledInBatch } = applyVerdicts(batch, verdicts, gh, repo, report, log);
    for (const number of settledInBatch) settled.add(number);
    // A batch counts only when GitHub refused more than one verdict in it: one
    // refused edit can be that issue's own, and narrowing makes single-issue
    // batches back to back. Any other run that answered resets the count.
    refusedInARow = applied === 0 && failed > 1 ? refusedInARow + 1 : 0;
    if (refusedInARow === 1) firstRefusal = firstError;
    if (refusedInARow >= INTAKE_REFUSED_BATCHES_LIMIT) {
      stopped = {
        reason: `GitHub refused every verdict in ${INTAKE_REFUSED_BATCHES_LIMIT} batches in a row`,
        firstError: firstRefusal,
      };
    }
    return undefined;
  }

  // Narrows a batch whose run failed with `error` down to the issues that
  // break it (see above), until intake stops for the round.
  async function narrow(batch: SandcastleIssue[], error: unknown): Promise<void> {
    if (stopped) return;
    if (batch.length === 1) {
      warn(`  ✗ Intake failed on ${refs(batch)}, so it's judged again in a later round or run: ${error}`);
      return;
    }
    log(`  Intake failed on ${refs(batch)}, so it's trying them in halves: ${error}`);
    const middle = Math.ceil(batch.length / 2);
    for (const half of [batch.slice(0, middle), batch.slice(middle)]) {
      if (stopped) return;
      const halfError = await judge(half);
      if (halfError !== undefined) await narrow(half, halfError);
    }
  }

  const unjudged = needsIntake(issues, openPrs);
  for (let start = 0; start < unjudged.length && !stopped; start += INTAKE_BATCH_SIZE) {
    const batch = unjudged.slice(start, start + INTAKE_BATCH_SIZE);
    const error = await judge(batch);
    if (error !== undefined) await narrow(batch, error);
  }
  if (stopped) {
    warn(`  ✗ ${stopped.reason}, so intake stops for this round; the issues it hadn't judged are judged again in a later round or run.`);
    stops.record({
      reason: stopped.reason,
      unjudged: unjudged.filter((issue) => !settled.has(issue.number)).map((issue) => issue.number),
      firstError: rootMessage(stopped.firstError),
    });
  }
}

// The message of the innermost error in `error`'s cause chain. The host's gh
// wrapper (lib/github.mts#ghWithStderr) names only the command when gh wrote
// nothing to stderr, so the cause is what says why it failed.
function rootMessage(error: unknown): string {
  let root = error;
  while (root instanceof Error && root.cause !== undefined) root = root.cause;
  return root instanceof Error ? root.message : String(root);
}

// Phase 0a as main.mts runs it: load the queue and the open PRs, then run
// intake over them. Intake runs before the gate, over blocked issues too, so a
// human sees its questions while a blocker is still in flight. A failure,
// whether loading or judging, is logged and costs only the issues intake was
// judging this round: without sandcastle:ready the gate holds them back, and
// the issues already ready can still be built. They're judged again in a
// later round, or on the next run when nothing else is ready, since the run
// then ends after the gate. An UncountedStopError (a usage
// limit or time budget) still ends the run.
export async function intakePhase(
  load: () => { issues: readonly SandcastleIssue[]; openPrs: readonly OpenPullRequest[] },
  round: (issues: readonly SandcastleIssue[], openPrs: readonly OpenPullRequest[]) => Promise<void> = intakeRound,
  warn: (message: string) => void = console.error,
): Promise<void> {
  try {
    const { issues, openPrs } = load();
    await round(issues, openPrs);
  } catch (error) {
    if (error instanceof UncountedStopError) throw error;
    warn(`  ✗ Intake failed, so the issues it was judging wait for a later round or run: ${error}`);
  }
}
