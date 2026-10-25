// The build pipeline's failed attempts: the comment each one posts, and
// giving up on an issue after BUILD_FAILURE_CAP of them through the hand-back
// that intake and PR follow-up share (lib/github.mts#handBack). See "Giving up
// and telling the human" in Blazor-Server's docs/plans/sandcastle-workflow.md.

import { execFileSync } from "node:child_process";
import { BUILD_FAILED_MARKER, BUILD_FAILURE_CAP, LOCAL_QUEUE_LABEL, QUEUE_LABEL } from "./config.mts";
import { commentOnIssue, handBack, replaceIssueLabel, repoName } from "./github.mts";
import { handBackReport, targetUrl, type HandBackReport } from "./report.mts";

// The comment for a failed build attempt under the cap: carries
// BUILD_FAILED_MARKER, so a restart can still count it (see
// lib/github.mts#markerCommentsSince), with the attempt number and `detail`
// (the tail of the gate output, or the role's error).
// `detail` is trimmed to fit GitHub's comment limit: a rejected comment saves
// no marker, so the attempt would never count and the issue never reach the cap.
export function buildFailedComment(attempt: number, branch: string, detail: string): string {
  const intro = [
    BUILD_FAILED_MARKER,
    `**Failed build attempt ${attempt} of ${BUILD_FAILURE_CAP}** on \`${branch}\`. The issue stays in the queue, and the next ` +
      `round builds it again; after ${BUILD_FAILURE_CAP} failed attempts it's handed back to a person.`,
    "",
  ].join("\n");
  return `${intro}\n${fit(detail, GITHUB_COMMENT_LIMIT - intro.length - 1)}`;
}

// GitHub rejects a comment body longer than this many characters.
const GITHUB_COMMENT_LIMIT = 65_536;

// The comment for the attempt that reaches BUILD_FAILURE_CAP: summarises
// every failed attempt since `sandcastle:needs-human` was last removed, by
// quoting each one's comment body, oldest first, ending with this attempt's.
// Each quote gets an equal share of GitHub's comment limit, so several long
// gate outputs can't make GitHub reject the comment; a longer one keeps its
// heading line and the end of its output, where the failure usually is.
export function needsHumanComment(branch: string, failures: readonly string[]): string {
  // No BUILD_FAILED_MARKER: the summary is posted before the label edit, and
  // if that edit fails the issue stays in the queue. Its next failure then
  // counts only the real attempts, and hands the issue back again.
  const intro = [
    `Sandcastle gave up on this issue after ${failures.length} failed build attempts, so it's handed back with ` +
      "`sandcastle:needs-human` and `sandcastle:ready` is removed. " +
      `\`${branch}\` keeps its commits. Once the cause is fixed, remove \`sandcastle:needs-human\` to put the issue back in ` +
      "the queue.",
  ].join("\n");
  // Room for each "### Attempt n" heading and the blank lines around it.
  const headingRoom = 32;
  const share = Math.floor((GITHUB_COMMENT_LIMIT - intro.length) / Math.max(failures.length, 1)) - headingRoom;
  return [
    intro,
    ...failures.flatMap((failure, i) => [
      "",
      `### Attempt ${i + 1}`,
      "",
      fit(quote(failure.replaceAll(BUILD_FAILED_MARKER, "").trim()), share, "> ", true),
    ]),
  ].join("\n");
}

// `text` cut to at most `max` characters: a note saying its start was
// trimmed, then as much of its end as fits. `prefix` begins every line ("> "
// for a block quote), and `keepHead` keeps the first line too, such as an
// attempt's heading.
function fit(text: string, max: number, prefix = "", keepHead = false): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const head = keepHead ? [lines.shift() ?? ""] : [];
  const blank = prefix.trimEnd();
  const note = `${prefix}_The start of this attempt's output is trimmed to fit GitHub's comment limit._`;
  const reopenLine = `${prefix}\`\`\`text`;
  const room = max - head.join("").length - note.length - reopenLine.length - 16;
  const tail = lines.join("\n").slice(-room);
  // Resume at a line start when one is near, so line prefixes line up.
  const lineStart = tail.indexOf("\n");
  const kept = lineStart !== -1 && lineStart < 200 ? tail.slice(lineStart + 1) : `${prefix}${tail}`;
  // A code fence opened in the trimmed part would leave its closing line
  // opening a new block instead, so open it again before what's kept.
  const dropped = lines.join("\n").slice(0, -kept.length);
  const fences = dropped.split("\n").filter((line) => line.startsWith(`${prefix}\`\`\``)).length;
  const reopen = fences % 2 === 1 ? [reopenLine] : [];
  return [...head, ...(keepHead ? [blank] : []), note, blank, ...reopen, kept].join("\n");
}

// Markdown block quote of `text`, every line prefixed, so a fenced code block
// inside it stays inside the quote.
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

// Records a failed build attempt on the issue `issueNumber`. `priorFailures`
// are the bodies of the attempts already counted since `sandcastle:needs-human`
// was last removed (see lib/github.mts#markerCommentsSince), oldest first.
// Under the cap it posts `buildFailedComment`; the attempt that reaches
// BUILD_FAILURE_CAP hands the issue back instead, with `needsHumanComment`
// quoting every failure.
export function recordFailedAttempt(
  issueNumber: number,
  branch: string,
  detail: string,
  priorFailures: readonly string[],
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  report: HandBackReport = handBackReport,
): void {
  const attempt = priorFailures.length + 1;
  if (attempt < BUILD_FAILURE_CAP) {
    commentOnIssue(issueNumber, buildFailedComment(attempt, branch, detail), run, repo);
    return;
  }
  // The last attempt is quoted without buildFailedComment's "the issue stays
  // in the queue": this is the comment that takes it out.
  const lastAttempt = `**Failed build attempt ${attempt} of ${BUILD_FAILURE_CAP}** on \`${branch}\`.\n\n${detail}`;
  handBack(
    { kind: "issue", number: issueNumber },
    "sandcastle:needs-human",
    `${attempt} failed build attempts on ${branch}`,
    needsHumanComment(branch, [...priorFailures, lastAttempt]),
    run,
    repo,
    report,
  );
}

// The comment for a push GitHub refused because it touches
// .github/workflows/**. GitHub refused the push, so origin's `branch`
// doesn't hold this attempt's commits, and an ephemeral runner's checkout is
// gone once the job ends: the comment says so, rather than send a person to
// edit a branch that lacks them, and names what they need to redo by hand,
// the workflow files (`change.files`, those the refused commits touch) and
// the head commit. Says Sandcastle's token has no Workflows permission, so a
// person must make the change, and how to re-queue the issue: land the
// workflow change in its own PR, then remove sandcastle:needs-human. Ends
// with `detail` in a fence longer than any backtick run in it, as the
// publish-failure comment does. No BUILD_FAILED_MARKER: this isn't a failed
// attempt.
export function workflowHandBackComment(branch: string, detail: string, change: WorkflowChange): string {
  const fence = fenceFor(detail);
  const what =
    change.files.length > 0
      ? `its commits touch ${change.files.map(codeSpan).join(", ")}`
      : "it changes a file under `.github/workflows/`";
  return (
    `Sandcastle couldn't push \`${branch}\`: ${what}, and GitHub refuses that change without the Workflows ` +
    "permission, which Sandcastle's token doesn't have. A person must make the workflow change, so the issue is " +
    "handed back with `sandcastle:needs-human`.\n\n" +
    `GitHub doesn't have this attempt's commits (head \`${change.head}\`): the push was refused, so \`${branch}\` ` +
    "on GitHub doesn't hold them, and they're gone once this run's checkout is.\n\n" +
    "To put the issue back in the queue: make the workflow change in its own pull request, and once it has merged, " +
    `remove \`sandcastle:needs-human\`. The next build no longer needs to touch the workflow.\n\n${fence}\n${fit(detail, GITHUB_COMMENT_LIMIT - 2_000)}\n${fence}`
  );
}

// A code fence longer than any backtick run in `text`, so `text` can't close it.
function fenceFor(text: string): string {
  return "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
}

// `text` as a Markdown code span it can't break out of: on one line, inside a
// backtick run longer than any in it, padded with spaces when it holds one.
// A workflow file's name comes from the sandboxed agent's commits, and the
// comment is public, so a backtick in it mustn't end the span and let the rest
// render as Markdown, a link or an @mention.
function codeSpan(text: string): string {
  const line = text.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...[...line.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return longest === 0 ? `${ticks}${line}${ticks}` : `${ticks} ${line} ${ticks}`;
}

// What a refused workflow push carried, for its hand-back comment: the head
// commit, and the .github/workflows/ files its commits touch (empty when they
// couldn't be listed).
export type WorkflowChange = { head: string; files: string[] };

// handBack({ kind: "issue", number }, "sandcastle:needs-human", `a push to
// ${branch} touched .github/workflows/**`, workflowHandBackComment(branch,
// detail, change), run, repo, report).
export function handBackWorkflowChange(
  issueNumber: number,
  branch: string,
  detail: string,
  change: WorkflowChange,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  report: HandBackReport = handBackReport,
): void {
  handBack(
    { kind: "issue", number: issueNumber },
    "sandcastle:needs-human",
    `a push to ${branch} touched .github/workflows/**`,
    workflowHandBackComment(branch, detail, change),
    run,
    repo,
    report,
  );
}

// The comment for a push GitHub refused for a .github/workflows/** change
// after main changed a workflow since the build's base. `createdAtBase`
// is whether the branch was created at the base first, so the push was an
// update to it; when that creation failed, the push was of a new branch, and
// the comment says so. Says the issue
// moved from the `Sandcastle` queue to `Sandcastle:local`, why, and how to run it
// there; names the branch, the workflow files and the head commit like
// workflowHandBackComment. Not a hand-back, so no `sandcastle:needs-human`, and no
// BUILD_FAILED_MARKER. `change.files` are the build's own (base..head), so they're
// empty when the refusal came from main's workflow change alone.
export function workflowLocalComment(branch: string, detail: string, change: WorkflowChange, createdAtBase: boolean): string {
  const fence = fenceFor(detail);
  const what =
    change.files.length > 0
      ? `its commits touch ${change.files.map(codeSpan).join(", ")}`
      : "GitHub counts it as changing a file under `.github/workflows/`";
  const how = createdAtBase
    ? `the push was refused even as an update to \`${branch}\` created at the commit the build started from`
    : `the push of \`${branch}\` as a new branch was refused, and creating it at the commit the build started from ` +
      "first had failed";
  return (
    `Sandcastle couldn't push \`${branch}\` from GitHub Actions: ${what}, and GitHub refuses that change without ` +
    "the Workflows permission, which Sandcastle's token in Actions doesn't have. Main changed a workflow after this " +
    `build started, and ${how}. A local run pushes with the owner's own \`gh\` login, which can push it, so the issue moved from ` +
    `the \`${QUEUE_LABEL}\` queue to \`${LOCAL_QUEUE_LABEL}\`.\n\n` +
    `GitHub doesn't have this attempt's commits (head \`${change.head}\`): the push was refused, so \`${branch}\` ` +
    "on GitHub doesn't hold them, and they're gone once this run's checkout is. The local run builds the issue again.\n\n" +
    `To build it, run \`SANDCASTLE_LABEL=${LOCAL_QUEUE_LABEL} pnpm run sandcastle\` from the main checkout. Its pull ` +
    `request's follow-up passes run locally too.\n\n${fence}\n${fit(detail, GITHUB_COMMENT_LIMIT - 2_000)}\n${fence}`
  );
}

// Moves the issue `issueNumber` from the `Sandcastle` queue to
// `Sandcastle:local` with workflowLocalComment, instead of handing it back:
// nothing about the issue needs a person, only a push token with the
// Workflows permission. The comment goes first, so a comment GitHub
// rejects leaves the issue in the queue rather than moved without a word; the
// labels change in one edit, so the issue is never in both queues or neither.
// Records the move in `report`, so the run ends red and Actions emails the
// owner: GitHub doesn't notify anyone about the PAT's own labels and comments,
// and the issue now waits for a local run nothing in Actions starts.
// The repository must already have `Sandcastle:local`: the host creates it at
// startup (LOCAL_QUEUE_LABEL_DEFINITION). `sandcastle:ready` stays, so the
// local run builds it without intake.
export function moveToLocalQueue(
  issueNumber: number,
  branch: string,
  detail: string,
  change: WorkflowChange,
  createdAtBase: boolean,
  run: typeof execFileSync = execFileSync,
  repo: string = repoName(),
  report: HandBackReport = handBackReport,
): void {
  commentOnIssue(issueNumber, workflowLocalComment(branch, detail, change, createdAtBase), run, repo);
  replaceIssueLabel(issueNumber, QUEUE_LABEL, LOCAL_QUEUE_LABEL, run, repo);
  report.record({
    kind: "issue",
    number: issueNumber,
    label: LOCAL_QUEUE_LABEL,
    reason: `a push to ${branch} touched .github/workflows/**, so a local run has to build it`,
    url: targetUrl(repo, { kind: "issue", number: issueNumber }),
  });
}
