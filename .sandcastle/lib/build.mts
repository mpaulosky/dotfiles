// Build one planned issue: test, implement, gate, review, gate again and publish it
// from a single sandbox, so every role and the gate share the same worktree.
// Nothing is merged locally: every change reaches main through a reviewed PR.

import type { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as sandcastle from "@ai-hero/sandcastle";
import { isRoleTimeout, LEAD_DENIED_TOOLS, leadTools, LEDGER_DENIED_TOOLS, REVIEWER_TOOLS, roleAgent, runRoleInSandbox, uiEnabled } from "./agents.mts";
import { commitsAhead, fetchMain, headOfRef } from "./branches.mts";
import { changedFiles, gateFailureComment, headOf, runCheckpoint, runGate, sandboxDown, textBlock, withoutRunnerCommands, type Checkpoint } from "./checkpoint.mts";
import {
  BASE_BRANCH,
  BUILD_FAILED_MARKER,
  BUILDING_LABEL,
  DESIGN_MARKER,
  FIXED_ROLE_AGENTS,
  PR_MARKER,
  PUBLISH_RETRY_ATTEMPTS,
  type OptionalRole,
  reviewerMode,
  type ReviewerMode,
} from "./config.mts";
import { CHECK_PATHS, copyToWorktree, hooks } from "./repo-config.mts";
import { StalledStepError, TamperedWorktreeError, UncountedStopError } from "./errors.mts";
import { startFromMain as sweepStartFromMain } from "./follow-up.mts";
import { claimBuildingLabel, releaseBuildingLabel } from "./building.mts";
import { commentOnIssue, fileIssueOnce, holdExistingPullRequest, markerComments, openPullRequest, repoName, type SandcastleIssue } from "./github.mts";
import { subagentDefinition } from "./host-review-prompts.mts";
import { advisoryIssueBody, openFindingsNote, runHostReview, type HostReviewHost, type HostReviewResult, type SkillFiles, type TeamMember } from "./host-review.mts";
import { handBackWorkflowChange, moveToLocalQueue, recordFailedAttempt, type WorkflowChange } from "./handback.mts";
import { mainGitDir, repoGitDir, worktreeLinkProblems, worktreePathFor } from "./host-safety.mts";
import { runLimits, type RunLimits } from "./limits.mts";
import { architectPromptArgs, backendPromptArgs, gateFixerPromptArgs, issuePromptArgs, reviewerPromptArgs } from "./prompts.mts";
import type { Outcome } from "./report.mts";
import { isBlocking, mergeBase, pinLedgerGit, prepareRound, recordReview, renderAdvisories, takenIds } from "./review-ledger.mts";
import { containsSandboxSecret, containsSecret, sandboxSecrets } from "./sandbox-env.mts";
import { describeSecretMatch, firstSecretMatch, type SecretMatch } from "./scan.mts";
import { git, hostGitInvocation, runHostGit } from "./shell.mts";
import { visibleLetters } from "./plain-text.mts";
import { agentSandbox } from "./skills.mts";
import { logSandboxState } from "./diagnostics.mts";
import { buildLogs } from "./role-logs.mts";
import { closeAfterWork, hostExecFileSync, withinDockerLimit } from "./host-limit.mts";
import { PROBE_LIMIT_MINUTES, type StepLimitOptions, limitSandboxExec, stalledStepOf } from "./step-limit.mts";
import { terminalText } from "./status.mts";

// A conventional-commit prefix as scripts/check-pr-title.sh accepts it: a type,
// an optional scope, an optional breaking-change marker, a colon and a space.
const titlePrefix = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]+\))?!?: /;

// Whether scripts/check-pr-title.sh would accept `title`: a prefix, then a
// summary that doesn't start with a lowercase letter or end with a period.
function followsTitleFormat(title: string): boolean {
  const summary = new RegExp(`^${titlePrefix.source}(\\S(?:.*\\S)?)$`).exec(title)?.[1];
  return summary !== undefined && !/^[a-z]/.test(summary) && !summary.endsWith(".");
}

// The title of the PR built from `issue`. The title becomes the squash commit's
// subject, which scripts/check-pr-title.sh holds to `<type>(<scope>): <Summary>`
// with no lowercase first letter and no final period, and a PR that fails it
// never merges. An issue title that already follows it is used as written. One
// that doesn't gets `fix:` when the issue is labelled bug, else `feat:`, and its
// summary a capital and no final period. A title that still fails the check
// (nothing left of it, say) becomes `<prefix>Issue #n`.
export function prTitle(issue: Pick<SandcastleIssue, "number" | "title" | "labels">): string {
  const title = issue.title.trim().replace(/\s+/g, " ");
  const prefix = titlePrefix.exec(title)?.[0] ?? (issue.labels.includes("bug") ? "fix: " : "feat: ");
  const summary = (titlePrefix.test(title) ? title.slice(prefix.length) : title).replace(/\.+$/, "");
  const candidate = `${prefix}${summary.charAt(0).toUpperCase()}${summary.slice(1)}`;
  return followsTitleFormat(candidate) ? candidate : `${prefix}Issue #${issue.number}`;
}

// Re-exported for the callers and tests that already import it from here.
export { UncountedStopError };

// Push the commit the last checkpoint's gate passed on (2, or 3 after a review round's fixes) to the issue branch, and open
// (or reuse) the PR that closes the issue. Both run in the main checkout, with
// git hooks off. Pushing from the worktree would run its pre-push hook: the
// branch's own .github/hooks/pre-push, scripts/gate.sh and test code, files the
// agents wrote, on the host with its gh auth, Docker socket and home directory.
// The sandbox already ran the gate on this commit, and CI runs it again on the
// PR. The commit is pushed by its id, so nothing committed after the gate can
// ride along, and without force: a push that doesn't fast-forward origin's
// branch fails, and buildIssue reports it on the issue, rather than drop the
// work already there.
//
// A GitHub server error (a 5xx or "Internal Server Error" in git's or gh's
// output) is transient, so the hold of an existing PR, the push and the PR creation are each tried up to
// PUBLISH_RETRY_ATTEMPTS times in all, with backoff, before giving up. Any
// other failure, such as a push that doesn't fast-forward, isn't retried: a
// person needs to look at it regardless.
//
// `reviewNote` is the host-side review's note for the PR body, and `holdAsDraft` is true while a blocking finding is open, or when the review didn't finish: the PR is then created as a
// draft with DRAFT_NOTE in its body. When it is false, a rerun leaves an existing draft a draft but takes DRAFT_NOTE out of its body (openPullRequest). `holdExisting` is what first turns a PR already open for the branch into a draft: it runs before the push, and a
// failure throws HoldFailedError with nothing pushed.
//
// `docsFailed` is true when the planner picked the scribe for this issue and
// its run failed. Unlike an architect, tester, backend or UI failure, that
// doesn't stop the pipeline (see "When a role fails" in
// Blazor-Server's docs/plans/sandcastle-workflow.md): the PR still publishes, with a note
// that the documentation step failed.
//
// `checkChanges` are the files under CHECK_PATHS that the branch changes; the PR
// body lists them (see CHECK_PATHS in lib/repo-config.mts).
//
// `prBody` is the reviewer's `pr-body.md` (its Why, What changed and
// Verification sections), already read from the sandbox and validated by the
// caller, or undefined to fall back to the generic body. A
// review-failed or docs-failed warning is placed after the reviewer's
// sections rather than folded into them, since the reviewer wrote them before
// either was known.
export async function publish(
  issue: SandcastleIssue,
  branch: string,
  commit: string,
  reviewed: boolean,
  docsFailed: boolean,
  prBody: string | undefined = undefined,
  checkChanges: readonly string[] = [],
  push: (branch: string, commit: string) => void = (pushBranch, pushCommit) =>
    void git("push", "--quiet", "origin", `${pushCommit}:refs/heads/${pushBranch}`),
  createPullRequest: (branch: string, title: string, body: string, draft?: boolean) => string = (pushBranch, title, body, draft) =>
    openHeldPullRequest(pushBranch, title, body, draft),
  wait: (ms: number) => Promise<void> = (ms) => sleep(ms),
  reviewNote = "",
  holdAsDraft = false,
  holdExisting: (branch: string) => void = (heldBranch) => holdExistingPullRequest(heldBranch),
): Promise<string> {
  // A PR already open for the branch (an earlier build's, opened ready) is made a draft before the new commits reach it, so PR Auto-Merge never sees
  // a ready PR with commits the review hasn't cleared. A failure stops here, before the push.
  if (holdAsDraft) {
    try {
      await retryOnServerError(() => holdExisting(branch), wait);
    } catch (error) {
      throw new HoldFailedError(branch, error);
    }
  }
  await retryOnServerError(() => push(branch, commit), wait);
  const reviewFailedNote = "⚠️ The review step failed, so no agent has reviewed this PR.";
  let description: string;
  if (prBody !== undefined) {
    description = reviewed ? prBody : `${prBody}\n\n${reviewFailedNote}`;
  } else {
    description = reviewed ? "Implemented and reviewed by Sandcastle." : `Implemented by Sandcastle. ${reviewFailedNote}`;
  }
  const docsNote = docsFailed
    ? "\n\n⚠️ The documentation step failed, so this PR may leave `CONTEXT.md`, `README.md` or the guides out of date."
    : "";
  // PR_MARKER is how the follow-up sweep (lib/follow-up.mts) tells a PR the
  // host published from a collaborator's on a matching branch.
  const checkNote =
    checkChanges.length > 0
      ? "\n\n⚠️ This branch changes files the gate and CI run, so it could have weakened a check. Look at these before merging:\n\n" +
        // File names are the agents' to choose, so they go in a fence that nothing in them can close.
        textBlock(boundedCheckList(checkChanges))
      : "";
  // The host-side review's note (lib/host-review.mts): what it left open, or that it didn't finish.
  const reviewSection = reviewNote === "" ? "" : `\n\n${reviewNote}`;
  // Why the PR is a draft and what a person does about it: only a person accepts a finding, and only a person marks the PR ready.
  const draftSection = holdAsDraft ? `\n\n${DRAFT_NOTE}` : "";
  const head = `${PR_MARKER}\nCloses #${issue.number}\n\n`;
  const tail = `${docsNote}${checkNote}${reviewSection}${draftSection}`;
  // The marker, `Closes #n` and the notes are kept whole; the description gives way.
  const room = PR_BODY_TOTAL_LIMIT - head.length - tail.length;
  if (description.length > room) description = cutDescription(description, room);
  const body = `${head}${description}${tail}`;
  // A retry after a create that GitHub carried out but answered with an error
  // finds that PR rather than open a second one: openPullRequest looks for an
  // open PR from the branch first.
  return retryOnServerError(() => createPullRequest(branch, prTitle(issue), body, holdAsDraft), wait);
}

// The comment on the Sandcastle issue when the follow-up issue for the review's Advisory findings could not be filed: the findings (`advisories`, the body
// checked for the public issue) are listed here so they are not lost with the runner.
export function advisoryFilingFailedComment(prUrl: string, advisories: string): string {
  return `Sandcastle published ${prUrl}, but it couldn't file the follow-up issue for the review's open Advisory findings, so they are listed here instead:\n\n${advisories}`;
}

// Thrown by publish when it could not turn the branch's open PR into a draft, so it pushed nothing. buildIssue tells a person so: the generic
// "pushing failed" comment would send them to push the branch's commits onto a PR that is still ready.
export class HoldFailedError extends Error {
  constructor(branch: string, cause: unknown) {
    super(`holding the open pull request for ${branch} as a draft failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "HoldFailedError";
  }
}

// publish's live way to open the PR: openPullRequest with DRAFT_NOTE as the note to add when a held PR's body is a person's and is kept. It is a named function so a
// test can pin that the note is passed: without it, a rerun that holds a PR with edited Review notes would make the PR a draft with nothing in the body saying why.
export function openHeldPullRequest(
  branch: string,
  title: string,
  body: string,
  draft: boolean = false,
  run?: typeof execFileSync,
  repo?: string,
): string {
  return openPullRequest(branch, title, body, run, repo, draft, DRAFT_NOTE);
}

// The PR body's reason for a draft: open Critical or Warning findings, or security findings of any grade, the host's review left, or a review that didn't finish. It names the steps only a person
// takes, and says any ledger the review recorded stayed on the runner, so a person records one with /pre-push-review before accepting (acceptFinding refuses with no ledger for the diff).
export const DRAFT_NOTE =
  "🚧 This PR is a draft because the local review left Critical or Warning findings (or a security finding of any grade) open, or didn't finish. A person decides each finding. " +
  "Any ledger the review recorded stayed on the runner that built this branch (it can hold security details, so it isn't published), so `scripts/review.sh accept` has nothing to act on yet: " +
  "check the branch out and run `/pre-push-review` on it, which records a ledger. Then fix each finding it leaves open, or accept it with `scripts/review.sh accept <id> <reason>`, " +
  "using the ids that review prints (they may differ from the ones listed here). Once nothing is open, mark the PR ready with `gh pr ready`.";

// Whether a git or gh failure is GitHub's own server error, which a later
// attempt may not hit. Matches what git and gh print for one ("remote: Internal
// Server Error", "returned error: 502", "HTTP 503: Service Unavailable", and
// GraphQL's "Something went wrong while executing your query", which GitHub
// sends with HTTP 200 on a timeout), not a bare 5xx, since a branch name can
// hold one (fix/500-...). Only the command's
// output after "failed:" is read: the command line before it quotes branch
// names, and could quote an issue title that mentions a server error.
export function isGitHubServerError(error: unknown): boolean {
  const output = commandOutput(error);
  return /\bHTTP(?:\/[\d.]+)? 5\d\d\b|returned error: 5\d\d\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Something went wrong while executing your query/i.test(
    output,
  );
}

// The first backoff before a retried publish step; each later one doubles it.
const PUBLISH_RETRY_DELAY_MS = 5_000;

// Run a publish step, retrying it with backoff while it fails with a GitHub
// server error, up to PUBLISH_RETRY_ATTEMPTS attempts in all. Any other
// failure, or the last attempt's, is rethrown. A follow-up pass's push
// (lib/follow-up-pass.mts) retries the same way.
export async function retryOnServerError<T>(step: () => T, wait: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return step();
    } catch (error) {
      if (attempt >= PUBLISH_RETRY_ATTEMPTS || !isGitHubServerError(error)) throw error;
      const delay = PUBLISH_RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.error(`  ⚠ GitHub server error, retrying in ${delay / 1000}s (attempt ${attempt + 1} of ${PUBLISH_RETRY_ATTEMPTS}): ${terminalText(String(error))}`);
      await wait(delay);
    }
  }
}

// The issue comment for an architect, tester, backend or UI run that stopped
// the build. `error` is the run's error, already made safe to post (see
// publicErrorText): it carries claude-code's stderr or last output lines, so
// it's quoted in a text block, which no mention or reference fires in, with
// its <!-- broken (see BROKEN_COMMENT_OPEN).
function developerFailureComment(failure: string, branch: string, error?: string): string {
  const comment = `Sandcastle stopped building this issue: ${failure}, so \`${branch}\` wasn't pushed. The branch keeps its commits.`;
  if (error === undefined) return comment;
  return [comment, "", "The error:", "", textBlock(error.replaceAll("<!--", BROKEN_COMMENT_OPEN))].join("\n");
}

// GitHub refuses a comment over 65,536 characters; this leaves room for the
// design comment's own lines around the note.
const DESIGN_NOTE_LIMIT = 60_000;

// GitHub refuses a PR body over 65,536 characters too; this leaves room for
// the marker, `Closes #n` and the warnings publish() adds around the
// reviewer's sections.
export const PR_BODY_LIMIT = 60_000;

// The most a whole PR body may hold, leaving a margin under GitHub's 65,536. publish() cuts the reviewer's description to fit under it, and bounds the
// check-file list, so the review's note and the warnings (none of which PR_BODY_LIMIT counts) can't push the body over and strand a pushed branch.
export const PR_BODY_TOTAL_LIMIT = 65_000;
const DESCRIPTION_CUT_NOTE = "\n\n… (the description was cut to fit a PR body)";
// The check-file list in a PR body shows at most this many paths and characters, so it can't take the whole body.
const CHECK_LIST_MAX_FILES = 100;
const CHECK_LIST_MAX_CHARS = 20_000;

export function boundedCheckList(files: readonly string[]): string {
  const shown: string[] = [];
  let chars = 0;
  for (const file of files) {
    if (shown.length >= CHECK_LIST_MAX_FILES || chars + file.length + 1 > CHECK_LIST_MAX_CHARS) break;
    shown.push(file);
    chars += file.length + 1;
  }
  const more = files.length - shown.length;
  return more > 0 ? `${shown.join("\n")}\n… and ${more} more` : shown.join("\n");
}

// The fence (``` or ~~~, as long as it was opened) a cut text leaves open, or "" when it closes every fence it opens.
function openFenceIn(text: string): string {
  let open = "";
  for (const line of text.split(/\r\n|\r|\n/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    const marks = fence[1]!;
    if (open === "") {
      if (marks[0] === "`" && fence[2]!.includes("`")) continue;
      open = marks;
    } else if (marks[0] === open[0] && marks.length >= open.length && fence[2]!.trim() === "") open = "";
  }
  return open;
}

// `description` cut to fit `room` characters, with the cut noted: on a character boundary, and with any code fence the cut left open closed (the closer is
// counted in the room), so the notes after it don't render inside the block.
export function cutDescription(description: string, room: number): string {
  let reserve = 0;
  for (let pass = 0; pass < 3; pass++) {
    const kept = cutAtCharacter(description, Math.max(0, room - DESCRIPTION_CUT_NOTE.length - reserve));
    const fence = openFenceIn(kept);
    const closer = fence === "" ? "" : `\n${fence}`;
    if (closer.length <= reserve || pass === 2) {
      return `${kept}${closer.length <= reserve ? closer : ""}${DESCRIPTION_CUT_NOTE}`.slice(0, Math.max(room, DESCRIPTION_CUT_NOTE.length));
    }
    reserve = closer.length;
  }
  return DESCRIPTION_CUT_NOTE;
}

// A closing keyword and the issue it names, as GitHub reads one in a PR body:
// #N, owner/repo#N or an issue URL. GitHub closes that issue when the PR
// merges, which PR Auto-Merge may do unattended, so only publish()'s own
// `Closes #n` may name one.
const PR_BODY_CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:[\w.-]+\/[\w.-]+#\d+|#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;

// An @mention of a user or team, which GitHub notifies when the PR opens. An
// email address or a word right after a backtick doesn't count, so
// `@copilot` in a code span doesn't hold the body back.
const PR_BODY_MENTION = /(?<![\w`/.])@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\b/;

// The headings the reviewer's pr-body.md must hold, the ones docs/PROCESS.md
// ("The PR description") asks every PR description for.
const PR_BODY_HEADINGS = ["Why", "What changed", "Verification"] as const;

// What stands in for <!-- in a posted design note. Every host marker starts
// with <!--, and markerComments finds the host's comments by substring, so a
// note quoting one (as a design for a change to Sandcastle itself would)
// would otherwise pass for that host comment: a design comment counted as a
// failed build attempt, for one. A follow-up pass's thread replies
// (lib/follow-up-pass.mts) break them the same way.
export const BROKEN_COMMENT_OPEN = "<!\u200B--";

// The issue comment that carries the architect's design note `note` (already
// made safe to post, see publicErrorText) for `branch`. The note sits in a
// code fence longer than any backtick run in it, so it renders as written and
// can't mention anyone or cross-reference another issue, and its <!-- are
// broken (see BROKEN_COMMENT_OPEN). A note too long for a comment is cut,
// saying where the whole of it is (`path`, in the sandbox). designNoteIn
// reads the note back.
export function designComment(note: string, branch: string, path: string): string {
  // Broken before it's measured, since each break adds a character.
  const broken = note.replaceAll("<!--", BROKEN_COMMENT_OPEN);
  const cut = broken.length > DESIGN_NOTE_LIMIT;
  const kept = cut ? cutAtCharacter(broken, DESIGN_NOTE_LIMIT) : broken;
  const longestRun = Math.max(0, ...(kept.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [
    `${DESIGN_MARKER}\nSandcastle's architect wrote this design note for \`${branch}\`. The tester and developers build from it, and ` +
      "the reviewer checks it was followed.",
    `${fence}markdown\n${kept}\n${fence}`,
    ...(cut ? [`(Cut short to fit in a comment. The whole note is in the sandbox's \`${path}\`.)`] : []),
  ].join("\n\n");
}

// `text` cut to at most `limit` UTF-16 code units, without splitting a
// surrogate pair: GitHub refuses a comment holding a lone surrogate. A
// follow-up pass's comments (lib/follow-up-pass.mts) are cut the same way.
export function cutAtCharacter(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// The architect's design note in a comment designComment wrote, as the
// architect wrote it, for a re-run's prompt. A comment with no fence gives
// its body without the marker. Line endings are normalised first: GitHub
// stores a comment edited on github.com with CRLF.
export function designNoteIn(body: string): string {
  body = body.replace(/\r\n?/g, "\n");
  const fenced = /^(`{3,})markdown\n([\s\S]*?)\n\1$/m.exec(body);
  if (!fenced) return body.replace(DESIGN_MARKER, "").trim();
  return fenced[2]!.replaceAll(BROKEN_COMMENT_OPEN, "<!--");
}

// The architect's latest design note on issue `issueNumber`, as it wrote it
// (see designNoteIn), or undefined when it hasn't posted one. Only the host's
// own comments count (markerComments): anyone can comment on a public issue,
// and this goes straight into the architect's prompt. Scoped like the
// failed-attempt count: a person who re-queues a handed-back issue may have
// rewritten it, so the architect starts that issue afresh rather than build on
// a design that went with the failed attempts.
export function latestDesignNote(
  issueNumber: number,
  repo: string = repoName(),
  run: typeof execFileSync = hostExecFileSync,
  poster?: string,
): string | undefined {
  const latest = markerComments(issueNumber, "sandcastle:needs-human", DESIGN_MARKER, repo, run, poster).at(-1);
  return latest && designNoteIn(latest.body);
}

// An issue with the optional roles the planner picked for it (see
// resolveRoles in lib/plan.mts): the architect, the UI developer and/or the scribe, each
// run only when listed, alongside the tester, developer and reviewer, which always run (see "Phase 6: Build" in
// Blazor-Server's docs/plans/sandcastle-workflow.md).
export type RoledIssue = SandcastleIssue & { roles: readonly OptionalRole[] };

// The roles that write the design, the tests or the code. When one fails, the
// issue stops for the round, unlike the scribe or the reviewer.
type DeveloperRole = "architect" | "tester" | "backend" | "ui";

// What buildIssue needs from outside the pipeline; tests pass stubs.
export type BuildHost = {
  // How long the close of the build's sandbox may take, in minutes (host-limit.mts#DOCKER_CALL_LIMIT_MINUTES by default); for tests.
  dockerCallMinutes?: number;
  createSandbox(branch: string): Promise<sandcastle.Sandbox>;
  // The commits on the branch that `base` doesn't have, counted by ref.
  commitsAhead(branch: string, base: string): number;
  commentOnIssue(issueNumber: number, body: string): void;
  // Records a failed build attempt (anything that stops the issue's
  // pipeline, see "When a role fails" in Blazor-Server's docs/plans/sandcastle-workflow.md):
  // posts the issue's `sandcastle:build-failed` comment with this attempt's
  // number and `detail` (the tail of the last gate output and of the first red run's when it differs, or the role's error; see sameGateOutput in lib/checkpoint.mts),
  // and once that's the BUILD_FAILURE_CAPth attempt since
  // `sandcastle:needs-human` was last removed, hands the issue back instead
  // (see lib/handback.mts#recordFailedAttempt). Never called for a role run
  // that threw UncountedStopError.
  recordBuildFailure(issueNumber: number, branch: string, detail: string): void;
  // Adds sandcastle:building to the issue, so the gate (lib/gate.mts) holds it
  // back for a second Sandcastle run while this one builds it. Returns
  // false, without adding it, when the issue already carries the label:
  // another run marked it after this round's gate read the labels.
  markBuilding(issueNumber: number): boolean;
  // Removes sandcastle:building, however the build stopped: called from
  // buildIssue's finally, only when markBuilding added it, so a failed,
  // red-gated or thrown-out build doesn't leave the issue held back forever,
  // and a build that stood aside never removes another run's label.
  unmarkBuilding(issueNumber: number): void;
  // The body of the architect's latest design note comment on this issue
  // (see DESIGN_MARKER in lib/config.mts), so a re-run's architect builds on
  // its own earlier decisions instead of starting blind. .sandcastle/work/ is
  // gitignored, so a fresh sandbox may not have the earlier run's file.
  // Undefined when the architect hasn't posted one yet.
  latestDesignNote(issueNumber: number): string | undefined;
  // The first match (see lib/scan.mts#firstSecretMatch) in what the commits
  // from `base` to `commit` publish, against one of the sandbox's secrets or
  // a token shape, or undefined when nothing matches. Carries only where the
  // match sits and what kind it is, never the matched text, so logging or
  // reporting it never risks the secret itself. `mergedMain` is the
  // main commit syncWithMain merged in, whose history isn't scanned.
  leaksSecret(base: string, commit: string, mergedMain?: string): SecretMatch | undefined;
  // Deletes the refs of `branch` that still hold the work of the issue's
  // latest Sandcastle PR, when that PR was closed without merging and a
  // person has since re-queued the issue, so the build starts from main.
  // Returns that PR's number and the refs it deleted, or undefined when
  // there was nothing to do. Throws when nobody re-queued the issue
  // (handing it back first) or a ref can't be deleted.
  startFromMain(issueNumber: number, branch: string, base: string): { pr: number; deleted: string[] } | undefined;
  publish: typeof publish;
  // Files the follow-up issue for the review's open Advisory findings (its title and body), or reuses the host's own open one with that title and
  // adds the body to it as a comment when neither its body nor a comment holds it yet (lib/github.mts#fileIssueOnce); a body a person edited is never replaced.
  fileAdvisoryIssue(title: string, body: string): void;
  // The backoff between retries of the filing above; tests replace it so they don't wait.
  wait?(ms: number): Promise<void>;
  // Fetches origin/main and returns the commit it now names (see
  // lib/branches.mts#fetchMain), so a build can merge in what landed on main
  // while it ran. Throws when the fetch fails.
  latestMain(): string;
  // Whether `commit` is the commit GitHub's main names right now, asked of
  // the remote itself (git ls-remote against origin, whose URL is in the
  // read-only .git/config) rather than read from refs/remotes/origin/main,
  // which agents can write. buildIssue leaves a merged main's history out of
  // the secret scan only when this holds. Throws when it can't ask.
  isRemoteMain(commit: string): boolean;
  // What's wrong with how the worktree finds its repository (see
  // lib/host-safety.mts); empty when nothing is.
  worktreeProblems(worktreePath: string): string[];
  // Text from the sandbox (a failed publish's error, the architect's design
  // note), made safe to post on the public issue.
  publicError(error: unknown): string;
  log(line: string): void;
  // The run's limits: buildIssue runs every role through
  // runRoleInSandbox(..., host.limits), and checks it before publishing.
  limits: RunLimits;
  // The .github/workflows/ files the commits from `base` to `commit` touch,
  // for the hand-back comment of a push GitHub refused for them, and to tell
  // whether merging main in would bring in a workflow change, leaving
  // out the history of `mergedMain`, the main commit syncWithMain merged in.
  workflowFiles(base: string, commit: string, mergedMain?: string): string[];
  // Whether the token that pushes the branch lacks the Workflows permission,
  // so GitHub refuses a push carrying a workflow change. True in GitHub
  // Actions; a local `Sandcastle:local` run pushes with the owner's own `gh`
  // login, which can push one.
  pushRefusesWorkflowChanges: boolean;
  // Hands the issue back with sandcastle:needs-human after a push GitHub
  // refused for a .github/workflows/** change (lib/handback.mts#handBackWorkflowChange).
  // `detail` is the publicError text of the push's error; `change` names the
  // refused head and its workflow files.
  handBackWorkflowChange(issueNumber: number, branch: string, detail: string, change: WorkflowChange): void;
  // Whether origin already has `branch`, asked of the remote itself.
  // A branch that exists is pushed to as an update, which GitHub judges
  // against the branch's own tip.
  remoteBranchExists(branch: string): boolean;
  // Creates `branch` on origin at `commit`, a commit GitHub already has, so
  // the build's commits can then be pushed as an update to it.
  createBranchAt(branch: string, commit: string): void;
  // Moves the issue from the Sandcastle queue to `Sandcastle:local` with a
  // comment saying why, after a push GitHub refused for a workflow change
  // even as an update to a branch created at `base`. A local run
  // pushes with the owner's own `gh` login, which can push it.
  // `createdAtBase` is whether creating the branch at `base` worked, so the
  // comment says how the push was made.
  moveToLocal(issueNumber: number, branch: string, detail: string, change: WorkflowChange, createdAtBase: boolean): void;
  // Deletes `branch` from origin if it's still at `commit`, the stray branch
  // createBranchAt left when the push of the build's commits was then
  // refused. A branch that moved is left alone.
  deleteBranchAt(branch: string, commit: string): void;
  // Runs the pre-push review's rounds on the host (lib/host-review.mts) once checkpoint 2's gate has passed on `startHead`, against
  // `main`, and records them. Rejects with UncountedStopError for a usage-limit stop or a stalled sandbox; a time-budget stop or the review's time cap ends it as failed. Only the host records: the sandbox's agents
  // get no shell on the ledger, no token and no scripts/review.sh.
  localReview(args: LocalReviewArgs): Promise<HostReviewResult>;
};

// What localReview is given: the build's sandbox and the commit and main to review, plus what the review needs of the build.
export type LocalReviewArgs = {
  sandbox: sandcastle.Sandbox;
  issue: Pick<SandcastleIssue, "number" | "title" | "body">;
  branch: string;
  main: string;
  startHead: string;
  // Checkpoint 3: the gate, with the gate-fixer while it is red, after a round's fixes. The commit it passed on, or undefined when it
  // stayed red (nothing is recorded for it: the review ends as failed and the last gated commit is published).
  gate(): Promise<string | undefined>;
  // Hands the build the commits the review's roles made, for its report.
  addCommits(commits: { sha: string }[]): void;
  limits: RunLimits;
  // How long the host waits for one reviewer or backend run before it gives up on it, in milliseconds; for tests. The default is the role's
  // timeoutMinutes plus ROLE_RUN_GRACE_MINUTES (lib/agents.mts#roleBackstopMs).
  backstopMs?: number;
  // How a round's reviewers start; SANDCASTLE_REVIEWERS (lib/config.mts#reviewerMode) when absent. For tests.
  reviewerMode?: ReviewerMode;
};

// An error's text as it can go on a public issue: no colour codes, no
// credentials in a URL, and nothing at all if it holds a secret.
export function publicErrorText(text: string, holdsSecret: (text: string) => boolean = (t) => containsSecret(t, [])): string {
  const cleaned = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .trim();
  return holdsSecret(cleaned) ? "(This text isn't shown: it looked like it held a secret. It was withheld.)" : cleaned;
}

// The git arguments listing the .github/workflows/ files each commit from
// `from` to `to` touches. GitHub refuses a push when any pushed commit
// creates or updates a workflow file, even one a later commit reverts, so the
// files come from the commits (a two-dot range: the branch side only), not
// from the net diff, which would list nothing for an edit and its revert.
// With `mergedMain`, the main commit merged into the branch after `from`, its
// history is left out too: main's workflow changes aren't the branch's.
export function workflowLogArgs(from: string, to: string, mergedMain?: string): string[] {
  const exclude = mergedMain === undefined ? [] : [`^${mergedMain}`];
  return ["log", "--name-only", "--format=", `${from}..${to}`, ...exclude, "--", ".github/workflows/"];
}

// The files in workflowLogArgs' output, each once, in first-seen order.
export function workflowFilesFrom(output: string): string[] {
  return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))];
}

// Whether a failed push was GitHub refusing a change to a workflow file
// because the token lacks the Workflows permission. Like isGitHubServerError,
// it reads only the output after "failed:\n". Matches "a Personal Access
// Token", "an OAuth App" and "a GitHub App", and both the singular
// "permission" and plural "permissions" GitHub uses.
export function isWorkflowPushRejection(error: unknown): boolean {
  return /refusing to allow an? [^\n]{0,40}?to create or update workflow/i.test(commandOutput(error));
}

// A failed git or gh command's output: the text after "failed:\n", or the
// whole message when there's no such line. The command line before it quotes
// branch names and could quote an issue title, so matching it could misread
// a failure.
function commandOutput(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const outputStart = message.indexOf("failed:\n");
  return outputStart === -1 ? message : message.slice(outputStart + "failed:\n".length);
}

// The committer identity the host's git has configured: git's user.name and
// user.email, each undefined when the host has none.
export type HostIdentity = { name?: string; email?: string };

// The host's git identity, read in the main checkout as Sandcastle reads it
// when a role starts. git exits non-zero for a key that isn't set, which
// leaves that half undefined.
export function liveHostIdentity(read: (...args: string[]) => string = git): HostIdentity {
  const value = (key: string) => {
    try {
      return read("config", key) || undefined;
    } catch {
      return undefined;
    }
  };
  return { name: value("user.name"), email: value("user.email") };
}

// Set the host's identity as the sandbox's global git config. Sandcastle does
// this only when a role starts, so a git command the host runs in a new
// sandbox before any role, such as the follow-up pass's merge of main, had no
// committer and failed with "Committer identity unknown". Each half is
// set only when the host has it.
async function setGitIdentity(sandbox: sandcastle.Sandbox, identity: HostIdentity): Promise<void> {
  const settings: [string, string | undefined][] = [
    ["user.name", identity.name],
    ["user.email", identity.email],
  ];
  for (const [key, value] of settings) {
    if (!value) continue;
    const result = await sandbox.exec(`git config --global ${key} ${shellWord(value)}`);
    if (result.exitCode !== 0) {
      throw new Error(`setting the sandbox's git ${key} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }
}

const tamperedWorktreeComment = (branch: string) =>
  `Sandcastle stopped: the worktree for \`${branch}\` no longer points at this repository, so it was left for a ` +
  "person to look at. Don't run git in it.";

// Whether nothing exists at the path: lstat says ENOENT. A dangling symlink exists, and any other lstat error (ENOTDIR, EACCES) is not "gone"
// either, so the worktree check still sees them.
export const worktreeIsGone = (worktreePath: string): boolean => {
  try {
    lstatSync(worktreePath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

const worktreeProblems = (worktreePath: string) => worktreeLinkProblems(worktreePath, repoGitDir());

// The live sandbox for `branch`, for a build and a follow-up pass
// (lib/follow-up-pass.mts) alike. Sandcastle reuses a branch's worktree
// that's still there, running git in it first, so that one is checked before
// it's handed over. The sandbox is handed over with the host's git identity
// already set (see setGitIdentity); if setting it fails, the sandbox is closed
// and the error thrown, so the caller doesn't run git in a sandbox that can't
// commit. Creating the sandbox runs hooks over the worktree, which on a
// follow-up pass holds an agent-written branch, so the worktree is checked
// again before that close: Sandcastle's close() runs git in it, and one that
// no longer points at this repository is left in place, with its sandbox, and
// its problems added to the error, a TamperedWorktreeError for the caller to
// report. A check that itself fails counts as a tampered worktree. The sandbox
// it returns runs every exec under a limit (lib/step-limit.mts), so a stalled
// gate ends as exit code 124 with its name in the output (a red gate), and any other command that runs over throws
// StalledStepError, as does every exec after it. The two git config commands that set the identity run first, on the
// sandbox itself, and have none. The image needs `timeout` (GNU
// coreutils), which the probe checks once, in the form every command takes, through its own one-minute limited
// sandbox (so a Docker exec that never answers is a StalledStepError, not a hang): an
// image without it is refused with a message that says so, rather than failing
// every later command. The probe, and a limit the repo set badly, fail like
// the identity step: a rejection or a refusal goes through the same worktree
// check and close. `stepLimits` is for tests.
//
// The create runs under withinDockerLimit (stepLimits.dockerCallMinutes): a create Docker never answers is a StalledStepError, and a
// sandbox it makes too late is closed once its worktree passes the check (a worktree that is gone from the path the host expects counts as
// passing; one that fails it, whose check throws, or that is at any other path, is left in place with a warning). The close after a refusal is bounded the same way, and one the host gave up on ends the run red (closeAfterWork) while the setup error is still the one thrown.
//
// `create` (what makes the sandbox, once the worktree is checked),
// `hostIdentity` (the host's git identity) and `checkWorktree` (the worktree
// link check) are injected so tests can stand in for Sandcastle, Docker, the
// host's git config and the main checkout.
export async function createCheckedSandbox(
  branch: string,
  create: (branch: string) => Promise<sandcastle.Sandbox> = (name) =>
    sandcastle.createSandbox({ branch: name, sandbox: agentSandbox(), hooks, copyToWorktree }),
  hostIdentity: () => HostIdentity = liveHostIdentity,
  checkWorktree: (worktreePath: string) => string[] = worktreeProblems,
  stepLimits: StepLimitOptions = {},
): Promise<sandcastle.Sandbox> {
  const existing = worktreePathFor(process.cwd(), branch);
  const problems = existsSync(existing) ? checkWorktree(existing) : [];
  if (problems.length > 0) {
    throw new Error(`the worktree left at ${existing} was tampered with: ${problems.join("; ")}`);
  }
  // Docker has no timeout of its own: a create that never answers stalls the step, and a sandbox it makes too late is closed if its worktree is
  // sound (see below).
  const sandbox = await withinDockerLimit("creating the sandbox", create(branch), stepLimits.dockerCallMinutes, (late) => {
    // Closing runs git in the worktree, which the create's hooks may have redirected, so it gets the check a normal cleanup gets. One that
    // fails the check, or the check itself failing, leaves the sandbox and its worktree in place. A worktree that is gone from the
    // path the host expects has nothing to redirect, so its sandbox is closed: leaving it would only leak its container. Any other path (an
    // empty one, one elsewhere) gets the check, which fails closed.
    let tampered: string[];
    try {
      tampered = late.worktreePath === existing && worktreeIsGone(existing) ? [] : checkWorktree(late.worktreePath);
    } catch (checkError) {
      tampered = [`checking the worktree failed: ${checkError instanceof Error ? checkError.message : String(checkError)}`];
    }
    if (tampered.length > 0) {
      console.error(`  ⚠ left the late sandbox at ${terminalText(late.worktreePath)} in place, as its worktree was tampered with: ${terminalText(tampered.join("; "))}`);
      return;
    }
    void late.close().catch(() => undefined);
  });
  let limited: sandcastle.Sandbox;
  try {
    await setGitIdentity(sandbox, hostIdentity());
    // The probe runs the form every later command takes (`timeout -k … sh -c …`), so an image whose `timeout` lacks
    // an option, or has no `sh`, is refused here and not by every command after it. It goes through its own limited
    // sandbox with a short limit, so a Docker exec that never answers stalls it on the host's backstop (a
    // StalledStepError, which this catch rethrows) and doesn't hold sandbox creation for good.
    const stepPrefix = `  ${terminalText(branch)}: `;
    const probe = await limitSandboxExec(sandbox, { prefix: stepPrefix, commandMinutes: PROBE_LIMIT_MINUTES, ...stepLimits }).exec("true");
    if (probe.exitCode !== 0) {
      throw new Error("the sandbox image has no `timeout` command (GNU coreutils), which the step limits in lib/step-limit.mts need");
    }
    // Every later exec (the gate, the merge of main, the reads of git state) runs under a limit, so a stalled one ends the step.
    // It throws on a limit the repo set badly, so it sits in the try: a throw there closes the sandbox like any other.
    limited = limitSandboxExec(sandbox, { prefix: stepPrefix, ...stepLimits });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The check itself can fail (the worktree gone, git failing). Then the
    // worktree can't be vouched for, so it's treated as tampered with and the
    // sandbox is left in place, with the check's failure added to the error.
    let tampered: string[];
    try {
      tampered = checkWorktree(sandbox.worktreePath);
    } catch (checkError) {
      tampered = [`checking the worktree failed: ${checkError instanceof Error ? checkError.message : String(checkError)}`];
    }
    if (tampered.length > 0) {
      throw new TamperedWorktreeError(
        `${reason}; left ${sandbox.worktreePath} and its sandbox in place, as the worktree was tampered with: ${tampered.join("; ")}`,
        sandbox.worktreePath,
      );
    }
    // A close the host gave up on makes the run end red (closeAfterWork), as for any other close after work; any other close failure is
    // only logged, and the setup error is the one thrown.
    await closeAfterWork(sandbox, {
      stalled: false,
      minutes: stepLimits.dockerCallMinutes,
      log: (line) => console.error(`  ⚠ closing the refused sandbox: ${terminalText(line)}`),
    }).catch((closeError) => console.error(`  ⚠ closing the refused sandbox failed: ${terminalText(String(closeError))}`));
    throw error;
  }
  return limited;
}

// Whether origin's main is `commit` now, by its answer to git ls-remote. Only
// equality with that tip is trusted: whether a commit is an ancestor of it
// would be read from the shared .git (commit-graph, loose objects), which
// agents can write. ls-remote matches refs by their tail, so the line is
// picked by its exact ref name: a branch like a/refs/heads/main also matches
// and can sort first.
export function remoteMainIs(commit: string, run: (...args: string[]) => string = git): boolean {
  const tip = headOfRef(run("ls-remote", "origin", "refs/heads/main"), "main");
  return tip !== undefined && tip === commit;
}

// Whether origin has `branch` now, by its answer to git ls-remote, picking the
// line by its exact ref name with headOfRef: ls-remote matches refs by their
// tail, so a branch like a/refs/heads/<branch> matches too.
export function remoteBranchIsOnOrigin(branch: string, run: (...args: string[]) => string = git): boolean {
  return headOfRef(run("ls-remote", "origin", `refs/heads/${branch}`), branch) !== undefined;
}

const liveHost: BuildHost = {
  createSandbox: createCheckedSandbox,
  commitsAhead,
  commentOnIssue,
  recordBuildFailure: (issueNumber, branch, detail) =>
    recordFailedAttempt(
      issueNumber,
      branch,
      detail,
      markerComments(issueNumber, "sandcastle:needs-human", BUILD_FAILED_MARKER).map((comment) => comment.body),
    ),
  latestDesignNote: (issueNumber) => latestDesignNote(issueNumber),
  markBuilding: (issueNumber) => claimBuildingLabel(issueNumber),
  unmarkBuilding: (issueNumber) => releaseBuildingLabel(issueNumber),
  leaksSecret: (base, commit, mergedMain) => firstSecretMatch(base, commit, sandboxSecrets(), git, mergedMain),
  startFromMain: (issueNumber, branch, base) => sweepStartFromMain(issueNumber, branch, base),
  publicError: (error) => publicErrorText(String(error instanceof Error ? error.message : error), containsSandboxSecret),
  publish,
  fileAdvisoryIssue: (title, body) => void fileIssueOnce(title, body),
  latestMain: fetchMain,
  isRemoteMain: (commit) => remoteMainIs(commit),
  worktreeProblems,
  log: console.log,
  limits: runLimits,
  workflowFiles: (from, to, mergedMain) => workflowFilesFrom(git(...workflowLogArgs(from, to, mergedMain))),
  pushRefusesWorkflowChanges: process.env.GITHUB_ACTIONS === "true",
  handBackWorkflowChange: (issueNumber, branch, detail, change) => handBackWorkflowChange(issueNumber, branch, detail, change),
  remoteBranchExists: (branch) => remoteBranchIsOnOrigin(branch),
  createBranchAt: (branch, commit) => void git("push", "--quiet", "origin", `${commit}:refs/heads/${branch}`),
  moveToLocal: (issueNumber, branch, detail, change, createdAtBase) =>
    moveToLocalQueue(issueNumber, branch, detail, change, createdAtBase),
  deleteBranchAt: (branch, commit) =>
    void git("push", "--quiet", `--force-with-lease=refs/heads/${branch}:${commit}`, "origin", `:refs/heads/${branch}`),
  localReview: (args) => runLocalReview(args),
};

// The skill files the host-side review reads, from the main checkout and never the worktree: the worktree is the branch's, so a
// branch could edit the Bar, a lens or the reviewer's instructions to go easy on itself.
export function readSkillFiles(checkout: string = process.cwd()): SkillFiles {
  const read = (path: string) => readFileSync(join(checkout, path), "utf8");
  const skill = ".claude/skills/pre-push-review";
  const severities = /^## Severities\n[\s\S]*?(?=^## |(?![\s\S]))/m.exec(read(`${skill}/SKILL.md`))?.[0];
  if (severities === undefined) throw new Error(`${skill}/SKILL.md has no Severities section`);
  let repoLenses: string | undefined;
  try {
    const own = read(".claude/skills/code-review/SKILL.md");
    // Only a file that holds a lens table of the skill's shape: the repository's code-review skill may hold nothing of the kind.
    if (/^\|\s*Lens\s*\|\s*Applies to\s*\|/im.test(own)) repoLenses = own;
  } catch (error) {
    // Only a missing file is "no code-review skill of its own", which is allowed: a file that can't be read would drop the repository's
    // own lenses without a word, so that ends the review as failed instead.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    lenses: read(`${skill}/lenses.md`),
    bar: read(`${skill}/review-bar.md`),
    severities,
    agentBody: read(".claude/agents/pre-push-reviewer.md").replace(/^---\n[\s\S]*?\n---\n/, ""),
    ...(repoLenses === undefined ? {} : { repoLenses }),
  };
}

// The host-side review's world for one build: the skill's files and the ledger from the main checkout, the reviewers and the backend
// role in the build's sandbox. The host never runs the worktree's scripts/review.sh or its git: prepareRound and recordReview run in
// the main checkout, on commits the sandbox made (the objects are shared), so no agent-written code runs on the host and no agent
// reaches the ledger. The sandbox mounts an empty folder over .git/review and has no GitHub token.
//
// With the "subagents" reviewer mode (SANDCASTLE_REVIEWERS, lib/config.mts#reviewerMode) the host also has `runReviewerTeam`: one lead run in
// the sandbox starts a round's reviewers as parallel subagents, defined on its command line (`--agents`, named lens-<id>, Read/Grep/Glob only).
// The lead is itself defined in `--agents` and started with `--agent`; it holds Read, Grep and Glob and an `Agent` tool limited to the round's lens-<id> agents (leadTools): no shell, no network and no write tool by its definition's tools and the denials (in a local probe it held no Bash tool with and without the deny list; what the probes left open is in references/pre-push-review.md). In the "sequential" mode `runReviewerTeam` is absent.
export function liveReviewHost(args: LocalReviewArgs, checkout: string = process.cwd()): HostReviewHost {
  const { sandbox, issue, main, limits } = args;
  const subagents = (args.reviewerMode ?? reviewerMode()) === "subagents";
  const backstop = args.backstopMs === undefined ? {} : { backstopMs: args.backstopMs };
  const runRel = `.sandcastle/work/${issue.number}/review`;
  // A shell test that fails, naming the link, when the run folder or any folder above it is a symlink: a write or a removal there would reach whatever the link
  // points at. It runs before any mkdir, which only makes real folders, so a link can only be one that was there already.
  const runParts = runRel.split("/");
  const runFolderUnlinked = runParts
    .map((_, at) => {
      const folder = shellWord(runParts.slice(0, at + 1).join("/"));
      return `{ test ! -L ${folder} || { echo "${runParts.slice(0, at + 1).join("/")} is a link" >&2; false; }; }`;
    })
    .join(" && ");
  const outcomesFile = `${runRel}/outcomes.json`;
  // The ledger's git commands run in the main checkout, whose .git agents can write: pinned to its own shared directory, whatever a
  // commondir file says (lib/host-safety.mts).
  const pin = () => pinLedgerGit(checkout, mainGitDir(checkout));
  const baseOf = (head: string) => {
    pin();
    return mergeBase(checkout, main, head);
  };
  return {
    readSkillFiles: () => readSkillFiles(checkout),
    worktree: async () => {
      const result = await sandbox.exec("git rev-parse --show-toplevel");
      const path = result.stdout.trim();
      if (result.exitCode !== 0 || !path.startsWith("/")) throw new Error("the sandbox's worktree path can't be read");
      return path;
    },
    prepare: (opts) => {
      pin();
      return prepareRound(checkout, opts);
    },
    takenIds: (head) => takenIds(checkout, baseOf(head), head),
    removeRunFile: async (path) => {
      if (!path.startsWith(`${runRel}/`) || path.includes("..")) throw new Error(`the review may only remove under ${runRel}/, not ${path}`);
      const removed = await sandbox.exec(`${runFolderUnlinked} && rm -f -- ${shellWord(path)}`);
      if (removed.exitCode !== 0) throw new Error(`removing ${path} in the sandbox failed: ${removed.stderr.trim()}`);
    },
    writeRunFile: async (path, content) => {
      // Only the run's own folder, which the sandbox git-ignores (.sandcastle/work/).
      if (!path.startsWith(`${runRel}/`) || path.includes("..")) throw new Error(`the review may only write under ${runRel}/, not ${path}`);
      // Base64, so the bytes git printed arrive as they are: a patch of a file that isn't UTF-8 would otherwise be rewritten in transit.
      // An empty file is made without stdin: a command waiting on an empty stdin could hold the build until its limit.
      // The path is removed first: a symlink or hard link left there by an earlier step would otherwise be written through,
      // aliasing two run files (two lenses' prompts) to one.
      const encoded = Buffer.from(content).toString("base64");
      const clear = `rm -f -- ${shellWord(path)}`;
      // Nor may the run folder, or a folder above it, be a link (runFolderUnlinked): the write, and the mkdir before it, would land wherever the link points.
      const written =
        encoded === ""
          ? await sandbox.exec(`${runFolderUnlinked} && mkdir -p ${shellWord(runRel)} && ${clear} && : > ${shellWord(path)}`)
          : await sandbox.exec(`${runFolderUnlinked} && mkdir -p ${shellWord(runRel)} && ${clear} && base64 -d > ${shellWord(path)}`, { stdin: encoded });
      if (written.exitCode !== 0) throw new Error(`writing ${path} in the sandbox failed: ${written.stderr.trim()}`);
    },
    runReviewer: async (_reviewer, prompt) => {
      const run = await runRoleInSandbox(sandbox, "pre-push-reviewer", { prompt }, limits, {
        tools: REVIEWER_TOOLS,
        denied: LEDGER_DENIED_TOOLS,
        strictMcp: true,
        // Not the branch's .claude/settings.json: its hooks would run shell commands, with the sandbox's environment, in a run meant to hold no shell.
        userSettingsOnly: true,
      }, backstop);
      return run.stdout;
    },
    ...(subagents
      ? {
          runReviewerTeam: async (members: TeamMember[], prompt: string) => {
            const model = FIXED_ROLE_AGENTS["pre-push-reviewer"].model;
            const run = await runRoleInSandbox(
              sandbox,
              "pre-push-review-lead",
              // Sandcastle's idle timeout is ten minutes of silence by default; a lead waiting on its subagents may print nothing for longer, so
              // it is the role's whole timeout, which the run's AbortSignal and the host's backstop enforce.
              { prompt, idleTimeoutSeconds: roleAgent("pre-push-review-lead").timeoutMinutes * 60 },
              limits,
              {
                // Only the round's lens-<id> agents may start, not a user-level, plugin or later built-in subagent.
                tools: leadTools(members.map((member) => member.agent)),
                denied: LEAD_DENIED_TOOLS,
                strictMcp: true,
                // Not the branch's .claude/settings.json (see runReviewer). The subagents are defined on the command line, so they don't need its .claude/agents.
                userSettingsOnly: true,
                agents: Object.fromEntries(members.map((member) => [member.agent, subagentDefinition(model, member.file, member.reviewer)])),
              },
              backstop,
            );
            return run.stdout;
          },
        }
      : {}),
    runFixer: async (prompt) => {
      // An earlier round's outcomes must not be read as this one's.
      const cleared = await sandbox.exec(`${runFolderUnlinked} && rm -f -- ${shellWord(outcomesFile)}`);
      if (cleared.exitCode !== 0) throw new Error(`clearing ${outcomesFile} in the sandbox failed: ${cleared.stderr.trim()}`);
      const run = await runRoleInSandbox(sandbox, "backend", { prompt }, limits, { denied: LEDGER_DENIED_TOOLS }, backstop);
      args.addCommits(run.commits);
    },
    readOutcomes: async () => {
      const read = await sandbox.exec(`cat ${shellWord(outcomesFile)} 2>/dev/null`);
      return read.exitCode === 0 ? read.stdout : undefined;
    },
    head: () => headOf(sandbox),
    changedFiles: (from, to) =>
      runHostGit(checkout, hostGitInvocation(checkout, mainGitDir(checkout), ["diff", "--name-only", "-z", "--no-renames", from, to]))
        .split("\0")
        .filter((file) => file !== ""),
    gate: () => args.gate(),
    record: (input, at) =>
      recordReview(checkout, baseOf(at.head), input, undefined, undefined, {
        at,
        onSecurity: (outcome) => {
          for (const warning of outcome.warnings) console.error(`  ⚠ .security: ${terminalText(warning)}`);
        },
      }),
    // The reviewers' and the backend role's words can reach a log line: made safe for the operator's terminal.
    log: (line) => console.log(`  #${issue.number} ${terminalText(line)}`),
  };
}

// The live local review of a built branch: the pre-push-review skill's rounds, run by the host over the build's sandbox.
export function runLocalReview(args: LocalReviewArgs): Promise<HostReviewResult> {
  return runHostReview(liveReviewHost(args), { issue: args.issue, branch: args.branch, main: args.main, startHead: args.startHead });
}

// `value` as one single-quoted shell word, for the commit and branch names
// buildIssue puts in a sandbox command and the git identity setGitIdentity
// does.
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// The branch comes from prepareBranches, which has already fetched it when it
// exists on origin. `base` is the commit fetchMain() resolved origin/main to
// before any sandbox of the round started: the ref itself is in the shared .git,
// which agents can write, so moving it mustn't be able to shrink the range the
// secret scan reads. The tester commits failing tests for the acceptance
// criteria, then the backend developer makes them pass. If the branch is then
// ahead of main, the gate runs (checkpoint 1), the reviewer runs, the latest
// main is merged in when the branch doesn't contain it, and the gate runs again
// (checkpoint 2, on the reviewed commit when the merge conflicts or the merged
// tree is red) before the branch is pushed and gets a pull request
// that closes its issue. Returns the PR's URL, or undefined when a developer
// run failed, the branch holds nothing to publish or checkpoint 1's or 2's
// gate stayed red. Between checkpoint 2 and the push the host runs the pre-push
// review's rounds; a round that fixes something is followed by checkpoint 3,
// and the last commit a checkpoint passed on is the one pushed (a red
// checkpoint 3 doesn't stop the build: the review ends as failed and that
// commit is published). `publishFailed` is true only when the branch passed its
// checkpoints but publishing it still failed, so the caller's round summary can
// tell that apart from a round that built nothing.
//
// The issue carries sandcastle:building from before its sandbox is created
// until after it closes, so a second Sandcastle run's gate holds it
// back, and a run that finds another already marked it never creates or
// closes a sandbox on the worktree that run is using (worktreePathFor names
// it after the branch alone).
export async function buildIssue(
  issue: RoledIssue,
  branch: string,
  base: string,
  host: BuildHost = liveHost,
): Promise<BuildResult> {
  // A label that can't be added stops the build: building unmarked is how two
  // runs end up on one issue. The throw reaches main.mts's allSettled, so it
  // skips this issue for the round without counting an attempt.
  if (!host.markBuilding(issue.number)) {
    console.error(`  ⏸ #${issue.number}: another run marked it ${BUILDING_LABEL} after this round's gate, so this run leaves it alone.`);
    return { commits: [], prUrl: undefined, publishFailed: false, outcome: "not published", detail: "another run is building it" };
  }
  try {
    return await buildMarkedIssue(issue, branch, base, host);
  } finally {
    // A label that can't be removed mustn't replace the build's own outcome.
    // The issue stays remembered, so this run's exit tries again (see
    // main.mts), and failing that a later startup clears the label as stale
    // (lib/building.mts).
    try {
      host.unmarkBuilding(issue.number);
    } catch (error) {
      console.error(
        `  ⚠ #${issue.number}: removing ${BUILDING_LABEL} failed, so it's tried again when this run exits: ${terminalText(String(error))}`,
      );
    }
  }
}

// What became of a build, for the run report (lib/report.mts).
export type BuildOutcome = Extract<Outcome, "published" | "role failed" | "timed out" | "gate failed" | "not published">;

// The most characters of one gate output line the host's log shows.
const LOGGED_LINE_LIMIT = 500;

// The first red gate run's output as lines safe for the host's log. The gate's
// output is written by the branch's agents and the log is a terminal, and in
// GitHub Actions a line that starts with `::` is a workflow command, so every
// line is cleaned by terminalText first (before the secret check, so hidden
// characters can't hide a token that is rebuilt afterwards), and the whole text
// goes through `publicError`. Each line is then cleaned again, any `##[` in it is
// changed (after the cleaning, so a hidden character can't split one that is
// rebuilt, and before the cut, so the extra space is counted), and it is cut to
// LOGGED_LINE_LIMIT characters (after the secret check, so the cut can't split a
// token it has passed) and given a prefix no workflow command can start with.
//
// A final newline is dropped even when `publicError` doesn't trim, so the
// caller's line count isn't spent on a blank line. terminalText folds runs of
// whitespace into one space and trims each line, so the log is not byte for byte
// what the gate printed.
export function logSafeGateOutput(text: string, publicError: (text: string) => string): string {
  const cleaned = text.replace(/\n$/, "").split("\n").map((line) => terminalText(line)).join("\n");
  return publicError(cleaned)
    .split("\n")
    .map((line) => `    | ${[...withoutRunnerCommands(terminalText(line))].slice(0, LOGGED_LINE_LIMIT).join("")}`)
    .join("\n");
}

// The detail of a build that ended because the branch holds no work to
// publish.
const NOTHING_AHEAD = "the branch holds nothing main doesn't";

// `detail` is host-written text only, never a role's or gh's error output: the
// run report is public on a public repository.
type BuildResult = {
  commits: { sha: string }[];
  prUrl: string | undefined;
  publishFailed: boolean;
  outcome: BuildOutcome;
  detail: string;
  // True when the PR was published but its Advisory findings were filed nowhere a person sees: the follow-up issue and the fallback comment on the issue both
  // failed, so they are only in the run log. lib/round.mts#findingsLostStops turns it into a recorded stop, which ends the run red (so does findingsUnlisted below).
  findingsLost?: true;
  // True when the PR was published but the review's open Advisory findings were all left out of the public follow-up issue (none passed the checks on what goes
  // in a public issue, or the whole body failed them) and so were never filed. Ends the run red the same way as findingsLost.
  findingsUnlisted?: true;
};

// buildIssue's work once the issue is marked: everything from creating the
// sandbox to closing it.
async function buildMarkedIssue(
  issue: RoledIssue,
  branch: string,
  base: string,
  host: BuildHost,
): Promise<BuildResult> {
  // Only once the issue is marked, so two runs never delete the same refs,
  // and before the sandbox, so a closed PR's work is never built on. A throw
  // stops the build uncounted (see buildIssue): building on the old work is
  // what the hand-back's comment promised wouldn't happen.
  const fresh = host.startFromMain(issue.number, branch, base);
  if (fresh !== undefined && fresh.deleted.length > 0) {
    host.log(`  #${issue.number} PR #${fresh.pr} was closed without merging, so the build starts from main: deleted ${fresh.deleted.join(", ")}`);
  }

  let sandbox: sandcastle.Sandbox;
  try {
    sandbox = await host.createSandbox(branch);
  } catch (error) {
    // The sandbox was left in place for a person, as the finally below does
    // for a worktree it finds tampered with, so the issue says so too.
    if (error instanceof TamperedWorktreeError) {
      console.error(`  ✗ #${issue.number}: ${terminalText(error.message)}`);
      host.commentOnIssue(issue.number, tamperedWorktreeComment(branch));
    }
    throw error;
  }

  const promptArgs = issuePromptArgs(issue, branch);
  const commits: { sha: string }[] = [];
  const unpublished = (outcome: BuildOutcome, detail: string): BuildResult =>
    ({ commits, prUrl: undefined, publishFailed: false, outcome, detail });
  const log = (line: string) => host.log(`  #${issue.number} ${line}`);
  // The sandbox's disk, memory and process state in the log, after a role fails and before each gate. It never throws, and
  // it runs under a limit of its own far below the sandbox's command limit (lib/diagnostics.mts), so a sandbox too broken to
  // answer is a logged line and not a stalled sandbox. File and process names in it are written by agents, so it is cleaned
  // like the gate's output.
  const probeSandbox = (reason: string) => logSandboxState(sandbox, reason, log, (text) => logSafeGateOutput(text, host.publicError));
  // The reviewer's log for this branch, so the run report's index of reviewer logs can say it belongs to this issue (lib/role-logs.mts).
  buildLogs.add(issue.number, branch);
  const designNotePath = `.sandcastle/work/${issue.number}/design.md`;
  const prBodyPath = `.sandcastle/work/${issue.number}/pr-body.md`;

  // The UI developer runs only for an issue whose plan picked it in a repo that
  // opted in. resolveRoles already keeps `ui` out of an opted-out repo's plan;
  // this keeps a RoledIssue built another way from running a role the repo has
  // no agent or prompt for, after a tester and backend run it can't use.
  const uiRuns = issue.roles.includes("ui") && uiEnabled();

  function developerPromptArgs(role: DeveloperRole): sandcastle.PromptArgs {
    switch (role) {
      case "architect":
        return architectPromptArgs(issue, branch, host.latestDesignNote(issue.number));
      case "backend":
        return backendPromptArgs(issue, branch, uiRuns);
      default:
        return promptArgs;
    }
  }

  // Run the architect, the tester, the developer (the backend role) or the UI developer.
  // Returns undefined when the run finished. When it threw, timed out or used
  // up its iterations without signalling completion, the design, the tests or
  // the code aren't done, so it returns the build's result and the issue stops
  // for this round. Whatever the run committed stays on the branch for the
  // next round, and the failure counts as one of the issue's build attempts,
  // as a checkpoint that stays red does. An UncountedStopError is rethrown
  // instead.
  async function developerFails(role: DeveloperRole): Promise<BuildResult | undefined> {
    // Built outside the try: a gh failure reading the earlier design note is
    // the host's, not the architect's, so it mustn't count as a failed attempt.
    const roleArgs = developerPromptArgs(role);
    let failure: string;
    let error: string | undefined;
    let logged: string | undefined;
    let result: BuildResult;
    try {
      const run = await runRoleInSandbox(
        sandbox,
        role,
        {
          promptFile: `./.sandcastle/roles/${role}.md`,
          promptArgs: roleArgs,
        },
        host.limits,
      );
      commits.push(...run.commits);
      if (run.completionSignal !== undefined) {
        log(`${role} finished`);
        return undefined;
      }
      failure = `the ${role} ran out of iterations unfinished`;
      result = unpublished("role failed", failure);
    } catch (thrown) {
      if (thrown instanceof UncountedStopError) throw thrown;
      failure = `the ${role} failed`;
      // The raw error stays in the run log; the issue gets the public text.
      logged = `${failure}: ${thrown}`;
      error = host.publicError(thrown);
      result = isRoleTimeout(thrown)
        ? unpublished("timed out", `the ${role} timed out`)
        : unpublished("role failed", `the ${role} failed`);
    }
    console.error(`  ✗ #${issue.number}: ${terminalText(logged ?? failure)}, so ${branch} isn't published.`);
    await probeSandbox(failure);
    host.recordBuildFailure(issue.number, branch, developerFailureComment(failure, branch, error));
    return result;
  }

  // Run a gate checkpoint, with the gate-fixer while the gate is red. Returns
  // the commit the gate passed on. When it's still red past the fixer's
  // attempts at checkpoint 1 or 2, nothing is published: the branch keeps its
  // commits, and the issue's failed build attempt is recorded with the tail of
  // the last gate output, and of the first red run's when it differs (see sameGateOutput in lib/checkpoint.mts). Checkpoint 3 (the review's) records nothing: the earlier
  // checkpoints' commit is published, so no comment may say it wasn't pushed
  // and no attempt is spent on a build that published.
  // A gate-fixer run that stopped with UncountedStopError is rethrown.
  async function gatePasses(checkpoint: Checkpoint, mergedMain?: string): Promise<string | undefined> {
    await probeSandbox(`before checkpoint ${checkpoint}`);
    const result = await runCheckpoint(
      checkpoint,
      {
        gate: () => runGate(sandbox, { base, ...(mergedMain === undefined ? {} : { mergedMain }) }),
        fix: async (at, gateOutput) => {
          let fixer: sandcastle.SandboxRunResult;
          try {
            fixer = await runRoleInSandbox(
              sandbox,
              "gate-fixer",
              {
                promptFile: "./.sandcastle/roles/gate-fixer.md",
                promptArgs: gateFixerPromptArgs(issue, branch, at, gateOutput),
              },
              host.limits,
            );
          } catch (error) {
            // The state of the sandbox the failed gate-fixer leaves, as after any other role; runCheckpoint logs the error itself.
            // Not for the run's own stop (usage or time), which says nothing about the sandbox.
            if (!(error instanceof UncountedStopError)) await probeSandbox("the gate-fixer failed");
            throw error;
          }
          commits.push(...fixer.commits);
        },
        uncounted: (error) => error instanceof UncountedStopError,
        alive: () => sandboxDown(sandbox, host.publicError),
        scrub: (text) => logSafeGateOutput(text, host.publicError),
        scrubLine: host.publicError,
      },
      log,
    );
    if (!result.passed || result.head === undefined) {
      if (checkpoint === 3) {
        console.error(`  ✗ #${issue.number}: the gate is still red at checkpoint 3, after the review's fixes: the last commit that passed is published.`);
        return undefined;
      }
      console.error(`  ✗ #${issue.number}: the gate is still red at checkpoint ${checkpoint}, so ${branch} isn't published.`);
      // The gate runs the branch's own scripts, which agents write, in the
      // sandbox that holds the Claude token, so its output is made safe to
      // post and its <!-- broken, like a role's error.
      const safe = (text: string) => host.publicError(text).replaceAll("<!--", BROKEN_COMMENT_OPEN);
      const first = result.firstOutput === undefined ? undefined : safe(result.firstOutput);
      host.recordBuildFailure(issue.number, branch, gateFailureComment(checkpoint, branch, safe(result.output), { firstOutput: first, fixersRun: result.fixersRun }));
      return undefined;
    }
    return result.head;
  }

  // Post the architect's design note on the issue, so it outlives the
  // sandbox: .sandcastle/work/ is gitignored, and a re-run's architect reads
  // it back through host.latestDesignNote. The file is read inside the
  // sandbox, not from the host, since an agent wrote it (it could be a
  // symlink to a host file). A missing note or a failed comment is logged,
  // not a failed build: this build's roles still read the file itself.
  async function postDesignNote(): Promise<void> {
    const path = designNotePath;
    const read = await sandbox.exec(`cat ${path} 2>/dev/null`);
    const note = read.exitCode === 0 ? read.stdout.trim() : "";
    if (note === "") {
      console.error(`  ⚠ #${issue.number}: the architect wrote no design note at ${path}, so none is posted.`);
      return;
    }
    const body = designComment(host.publicError(note), branch, path);
    try {
      host.commentOnIssue(issue.number, body);
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: posting the design note failed: ${terminalText(String(error))}`);
    }
  }

  // The reviewer's PR description: its Why, What changed and
  // Verification sections, for publish() to put under the marker and
  // `Closes #n`. Read inside the sandbox, as postDesignNote reads the design
  // note, since an agent wrote it. It's published word for word (the squash
  // commit, the Release's notes, the release blog), so anything it can't be
  // trusted with as it is returns undefined, for publish()'s generic body,
  // and the log says why: a missing description never blocks publishing.
  // Keep PR_BODY_RULES in lib/prompts.mts in step: it tells the reviewer each
  // of these refusals.
  async function reviewerPrBody(): Promise<string | undefined> {
    let read: { stdout: string; exitCode: number };
    try {
      read = await sandbox.exec(`cat ${prBodyPath} 2>/dev/null`);
    } catch (error) {
      log(`reading the reviewer's PR body failed, so the PR gets the generic body: ${terminalText(String(error))}`);
      return undefined;
    }
    const prBody = read.exitCode === 0 ? read.stdout.replace(/\r\n?/g, "\n").trim() : "";
    const missing = PR_BODY_HEADINGS.filter((heading) => !new RegExp(`^## ${heading}[ \t]*$`, "m").test(prBody));
    let problem: string | undefined;
    if (prBody === "") {
      problem = `is missing or empty at ${prBodyPath}`;
    } else if (missing.length > 0) {
      problem = `lacks the ${missing.map((heading) => `"## ${heading}"`).join(", ")} heading${missing.length > 1 ? "s" : ""}`;
    } else if (prBody.length > PR_BODY_LIMIT) {
      problem = `is ${prBody.length} characters, more than the ${PR_BODY_LIMIT} a PR body can hold`;
    } else if (host.publicError(prBody) !== prBody) {
      // publicError also strips colour codes and URL credentials. Any change
      // means the file isn't safe to publish as written, so it isn't.
      problem = "holds a secret, a token shape or other text that isn't safe to publish";
    } else if (visibleLetters(prBody).includes("reviewnotes")) {
      // The local review's `## Review notes` are a person's acceptances
      // (scripts/review.sh notes), which a reader such as Claude Review may take
      // as decisions: text an agent wrote mustn't pass for them in any form, even
      // quoted in code or run together in a name. A false refusal only costs the
      // generic body.
      problem = "holds the words Review notes, which only a person's local review writes";
    } else if (PR_BODY_CLOSING_REFERENCE.test(prBody) || PR_BODY_MENTION.test(prBody) || prBody.includes("<!--")) {
      problem = "closes an issue, mentions someone or quotes a host marker, which GitHub or the host would act on";
    }
    if (problem !== undefined) {
      log(`the reviewer's PR body ${problem}, so the PR gets the generic body`);
      return undefined;
    }
    return prBody;
  }

  // Run the scribe. Returns false when the run threw or used up its
  // iterations without signalling completion. Unlike a developer run, that
  // isn't a failed build attempt: the code is gated, so the PR still
  // publishes, with a note that the documentation step failed. Out of usage
  // or time, the UncountedStopError is rethrown to leave the branch for a
  // later round, as the reviewer's is.
  async function scribeFinishes(): Promise<boolean> {
    try {
      const scribe = await runRoleInSandbox(
        sandbox,
        "scribe",
        {
          promptFile: "./.sandcastle/roles/scribe.md",
          promptArgs,
        },
        host.limits,
      );
      commits.push(...scribe.commits);
      if (scribe.completionSignal !== undefined) {
        log("scribe finished");
        return true;
      }
      console.error(`  ⚠ #${issue.number}: the scribe ran out of iterations unfinished, publishing with a note.`);
    } catch (error) {
      if (error instanceof UncountedStopError) throw error;
      console.error(`  ⚠ #${issue.number}: scribe failed, publishing with a note: ${terminalText(String(error))}`);
      await probeSandbox("the scribe failed");
    }
    return false;
  }

  // Put the worktree back on `commit` with nothing uncommitted, by `undo`
  // and, when that leaves it anywhere else, by a hard reset. Returns whether
  // it got there: a tree left mid-merge would be gated with conflict markers
  // in it, and the gate-fixer might commit them.
  async function restoredTo(commit: string, undo: string): Promise<boolean> {
    const cleanAt = async () => {
      const status = await sandbox.exec("git status --porcelain 2>&1");
      return (await headOf(sandbox)) === commit && status.exitCode === 0 && status.stdout.trim() === "";
    };
    const undone = await sandbox.exec(undo);
    if (undone.exitCode === 0 && (await cleanAt())) return true;
    await sandbox.exec(`git reset --hard ${shellWord(commit)}`);
    return cleanAt();
  }

  // The merged main commit, kept only when GitHub's main is that commit right
  // now, asked of the remote rather than read from the origin/main ref in the
  // shared .git, which agents can write: a ref they moved onto a commit of
  // their own would otherwise hide a leak in it from the scan, and the
  // pinned `base` can't protect a range the exclusion shrinks. When
  // main has moved on (PR Auto-Merge landing another PR during the gate), or
  // the remote can't be asked, nothing is left out and the scan reads
  // everything past `base`, as it did before.
  function trustedMergedMain(mergedMain: string | undefined): string | undefined {
    if (mergedMain === undefined) return undefined;
    try {
      if (host.isRemoteMain(mergedMain)) return mergedMain;
      log("the merged main commit is no longer GitHub's main, so the scan reads main's commits too");
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: asking GitHub for main failed, so the scan reads main's commits too: ${terminalText(String(error))}`);
    }
    return undefined;
  }

  // Merge in what landed on main while the roles ran, so the PR doesn't open
  // already behind it: a build can take an hour, and Sandcastle pushes with
  // hooks off, so the pre-push hook's behind-main check never runs on it.
  // Returns the reviewed commit the merge went onto, so checkpoint 2 can fall
  // back to it, and the main commit it merged, so the secret scan and the
  // workflow listing can leave main's own commits out, or undefined
  // when nothing was merged. A merge that conflicts is aborted and the branch
  // published as it is: the follow-up pass (lib/follow-up-pass.mts) merges
  // main into a conflicted PR with a role to resolve it. A failed fetch
  // publishes without the merge too, since the work is already reviewed and
  // the follow-up pass updates a PR behind main. So does a main that changed
  // a workflow file since the branch's head, but there nothing in Actions can
  // bring main in afterwards (see below).
  // Throws when an aborted merge can't be undone.
  async function syncWithMain(): Promise<{ reviewedHead: string; mergedMain: string } | undefined> {
    let main: string;
    try {
      main = host.latestMain();
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: fetching main failed, so ${branch} is published without merging it in: ${terminalText(String(error))}`);
      log("fetching main failed, so main isn't merged in");
      return undefined;
    }
    const contains = await sandbox.exec(`git merge-base --is-ancestor ${shellWord(main)} HEAD`);
    if (contains.exitCode === 0) return undefined;
    const reviewedHead = await headOf(sandbox);
    if (reviewedHead === undefined) {
      log("HEAD can't be read, so main isn't merged in");
      return undefined;
    }
    // In Actions, the merge commit would carry main's own workflow change,
    // and GitHub refuses Sandcastle's push of it for lack of the Workflows
    // permission, handing the issue back for a change it never made.
    // The merge is left undone, not promised to anyone: the follow-up pass
    // runs in Actions with the same token, so its own push of main's workflow
    // change is refused the same way and it hands the PR to a person, as does
    // an update-branch call made with that token. A person, or a local
    // `Sandcastle:local` run, has to bring main's workflow change in. A local
    // run pushes with the owner's login, so it merges main as usual. When the
    // files can't be listed, the merge is skipped too: publishing without
    // main is safe.
    if (host.pushRefusesWorkflowChanges) {
      let mainWorkflowFiles: string[];
      try {
        mainWorkflowFiles = host.workflowFiles(reviewedHead, main);
      } catch (error) {
        console.error(`  ⚠ #${issue.number}: listing the workflow files main changes failed: ${terminalText(String(error))}`);
        log("main's workflow changes can't be listed, so main isn't merged in");
        return undefined;
      }
      if (mainWorkflowFiles.length > 0) {
        log(`main changed ${mainWorkflowFiles.join(", ")}, so it isn't merged in and the branch is published as it is`);
        return undefined;
      }
    }
    const merge = await sandbox.exec(`git merge --no-edit -m ${shellWord(`Merge main into ${branch}`)} ${shellWord(main)}`);
    if (merge.exitCode === 0) {
      log("merged main in before checkpoint 2");
      return { reviewedHead, mergedMain: main };
    }
    if (!(await restoredTo(reviewedHead, "git merge --abort"))) {
      throw new Error(`the conflicting merge of main couldn't be undone, so ${branch} isn't back at ${reviewedHead}`);
    }
    log("merging main conflicted, so it's left for the follow-up pass and the branch is published as it is");
    return undefined;
  }

  // Checkpoint 2. With main merged in, the gate runs once on the merged
  // tree, without the gate-fixer: the reviewer has already run, so the fixer
  // would publish unreviewed edits to repair what main broke, and a red main
  // would fail every build that ends while it's red. When that run is red,
  // the branch goes back to the reviewed commit and is gated as it would have
  // been without the merge, leaving main to the follow-up pass. Returns the
  // commit the gate passed on, with the main commit merged into it when the
  // merge stayed, or undefined when the gate failed.
  async function checkpoint2Passes(): Promise<{ gated: string; mergedMain?: string } | undefined> {
    const synced = await syncWithMain();
    if (synced !== undefined) {
      const { reviewedHead, mergedMain } = synced;
      const merged = await runGate(sandbox, { base, mergedMain: trustedMergedMain(mergedMain) });
      log(`checkpoint 2: gate ${merged.passed ? "passed" : "failed"} with main merged in`);
      if (merged.passed) return merged.head === undefined ? undefined : { gated: merged.head, mergedMain };
      if (!(await restoredTo(reviewedHead, `git reset --hard ${shellWord(reviewedHead)}`))) {
        throw new Error(`the merge of main couldn't be undone, so ${branch} isn't back at ${reviewedHead}`);
      }
      log("main broke the gate once merged in, so it's left for the follow-up pass and the branch is gated without it");
    }
    const gated = await gatePasses(2);
    return gated === undefined ? undefined : { gated };
  }

  // The files under CHECK_PATHS that the branch changes (see changedFiles), for
  // the PR body to list. Empty when git can't say: the note is a courtesy to the
  // reviewer, and the gate and CI still run.
  async function changedCheckFiles(gated: string, mergedMain: string | undefined): Promise<string[]> {
    try {
      const changed = await changedFiles(sandbox, { base, mergedMain }, CHECK_PATHS, gated);
      if (changed !== undefined) return changed;
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: listing the files ${branch} changes under the gate's and CI's folders failed: ${terminalText(String(error))}`);
    }
    log("the files the branch changes under the gate's and CI's folders can't be listed, so the PR body won't name them");
    return [];
  }

  // GitHub judges the push of a branch it doesn't have yet against main's
  // current tip, not the commit the branch was cut from: once main has
  // changed a workflow since `base`, a new branch "changes" it back, and
  // Actions' token, without the Workflows permission, can't push it. So the
  // branch is first created at `base`, which GitHub already has, and the
  // build's commits are then pushed as an update to it, judged against
  // `base`. Returns undefined when this path wasn't taken, else whether the
  // creation worked; the path counts as taken even when it failed, so a push
  // GitHub still refuses moves the issue to Sandcastle:local instead of
  // handing it back. A local run's push can
  // carry a workflow change, and an existing branch is already judged
  // against its own tip, so neither needs it. When main or its workflow
  // files can't be read, or origin can't be asked for the branch, the build
  // publishes as it did before this check. `gated` must descend from `base`:
  // an issue whose earlier round failed the gate keeps its branch, built on
  // an older main than this round's `base`, and a branch created at `base`
  // would then reject the push of `gated` as a non-fast-forward, leaving a
  // stray branch with no PR on origin.
  async function triedCreatingBranchAtBase(gated: string): Promise<{ created: boolean } | undefined> {
    if (!host.pushRefusesWorkflowChanges) return undefined;
    let mainWorkflowFiles: string[];
    try {
      const main = host.latestMain();
      if (main === base) return undefined;
      mainWorkflowFiles = host.workflowFiles(base, main);
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: listing the workflow files main changed since ${base} failed: ${terminalText(String(error))}`);
      log("main's workflow changes since the build started can't be listed, so the branch is published as usual");
      return undefined;
    }
    if (mainWorkflowFiles.length === 0) return undefined;
    try {
      if (host.remoteBranchExists(branch)) return undefined;
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: asking GitHub whether ${branch} exists failed: ${terminalText(String(error))}`);
      log(`GitHub can't be asked whether ${branch} exists, so it's published as usual`);
      return undefined;
    }
    let descends: { exitCode: number };
    try {
      descends = await sandbox.exec(`git merge-base --is-ancestor ${shellWord(base)} ${shellWord(gated)}`);
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: checking that ${base} is an ancestor of ${gated} failed: ${terminalText(String(error))}`);
      log(`${base} can't be checked as an ancestor of the commit the gate passed on, so ${branch} is published as usual`);
      return undefined;
    }
    if (descends.exitCode !== 0) {
      log(`${base} isn't an ancestor of the commit the gate passed on (or can't be checked), so ${branch} is published as usual`);
      return undefined;
    }
    // A failed creation still pushes: GitHub may take it, and if it refuses
    // the push for main's workflow change, the issue moves to Sandcastle:local
    // as it would after a creation that worked.
    try {
      host.createBranchAt(branch, base);
      log(`main changed ${mainWorkflowFiles.join(", ")} since the build started, so ${branch} was created at ${base} before the push`);
      return { created: true };
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: creating ${branch} at ${base} failed, so it's pushed as a new branch: ${terminalText(String(error))}`);
      log(`creating ${branch} at the build's base failed, so it's pushed as a new branch`);
      return { created: false };
    }
  }

  try {
    // The worktree is named after the branch, so it may still hold an earlier
    // round's design note, and every role follows the note when it exists:
    // only this build's architect may have written it. The PR body
    // likewise, so an earlier round's description never goes out with this
    // round's change.
    await sandbox.exec(`rm -f ${designNotePath}`);
    await sandbox.exec(`rm -f ${prBodyPath}`);
    const developers: DeveloperRole[] = [
      ...(issue.roles.includes("architect") ? ["architect" as const] : []),
      "tester",
      "backend",
      ...(uiRuns ? ["ui" as const] : []),
    ];
    for (const role of developers) {
      const failed = await developerFails(role);
      if (failed !== undefined) return failed;
      if (role === "architect") await postDesignNote();
    }

    // Gate, review and publish whenever the branch holds work that main
    // doesn't, not only when this run added commits: a re-run of a finished
    // issue makes none, and its earlier work still needs a PR.
    if (host.commitsAhead(branch, base) === 0) {
      const status = await sandbox.exec("git status --porcelain 2>&1");
      if (status.exitCode === 0 && status.stdout.trim() === "") {
        return unpublished("not published", NOTHING_AHEAD);
      }
    }

    if ((await gatePasses(1)) === undefined) return unpublished("gate failed", "checkpoint 1");
    if (host.commitsAhead(branch, base) === 0) {
      return unpublished("not published", NOTHING_AHEAD);
    }

    const docsFailed = issue.roles.includes("scribe") && !(await scribeFinishes());

    let reviewed = true;
    try {
      const review = await runRoleInSandbox(
        sandbox,
        "reviewer",
        {
          promptFile: "./.sandcastle/review-prompt.md",
          promptArgs: reviewerPromptArgs(issue, branch),
        },
        host.limits,
      );
      commits.push(...review.commits);
      log("reviewer finished");
    } catch (error) {
      // Out of usage or time, the review didn't fail: leave the branch for a
      // later round to review rather than publish it unreviewed.
      if (error instanceof UncountedStopError) throw error;
      // A failed review shouldn't strand finished work: publish anyway and
      // say so in the PR, which gets a human review regardless.
      console.error(`  ⚠ #${issue.number}: reviewer failed, publishing unreviewed: ${terminalText(String(error))}`);
      reviewed = false;
      await probeSandbox("the reviewer failed");
    }

    const checkpoint2 = await checkpoint2Passes();
    if (checkpoint2 === undefined) return unpublished("gate failed", "checkpoint 2");
    let gated = checkpoint2.gated;
    const mergedMain = trustedMergedMain(checkpoint2.mergedMain);

    // The pre-push review's rounds, on the host (lib/host-review.mts), on the commit checkpoint 2 passed on. A round that fixes
    // something moves the branch on to a commit checkpoint 3 passes, and that commit is what is scanned and published. A usage-limit stop
    // or a stalled sandbox (any UncountedStopError but the time budget's) leaves the branch for a later round; a review that can't finish, or that the time budget or its own cap ends, or whose fixes leave checkpoint 3 red, publishes the last gated commit with a note, as a draft.
    let reviewNote = "";
    let holdAsDraft = false;
    // True when the hold is because the review didn't finish, not because it left findings: the hand-back comments then say the review didn't finish, and the one after a failed publish says to run it again.
    let reviewUnfinished = false;
    let advisories = "";
    // True when open Advisory findings existed and no follow-up issue could hold any of them, so they reach nowhere a person sees (see findingsUnlisted).
    let advisoriesUnlisted = false;
    const review = await host.localReview({
      sandbox,
      issue: { number: issue.number, title: issue.title, body: issue.body },
      branch,
      main: checkpoint2.mergedMain ?? base,
      startHead: gated,
      gate: () => gatePasses(3, mergedMain),
      addCommits: (made) => void commits.push(...made),
      limits: host.limits,
    });
    if (review.status === "failed") {
      console.error(`  ⚠ #${issue.number}: the local review failed (${terminalText(review.reason)}), publishing without a recorded review.`);
      // The unfinished review's gated commit is published, not checkpoint 2's: earlier rounds' fixes passed checkpoint 3.
      gated = review.head;
      reviewNote = `⚠️ The local review didn't finish (${review.reason}), so this branch has no recorded review.`;
      // It has not cleared the code, and PR Auto-Merge only merges ready PRs: the PR is held, and a person marks it ready after looking.
      holdAsDraft = true;
      reviewUnfinished = true;
    } else {
      gated = review.head;
      // A line the host's public-text check would change, or that reads like a Review notes section, is left out on its own.
      reviewNote = openFindingsNote(review.ledger, review.readPaths, (line) => host.publicError(line) === line && !visibleLetters(line).includes("reviewnotes"));
      // The note holds only ids, severities and file paths, but a path comes from the branch: it goes out only if the host's public-text check leaves it
      // as it is, a backstop behind the ledger's path shape and the note's length bounds.
      if (reviewNote !== "" && host.publicError(reviewNote) !== reviewNote) {
        log("the local review's open findings hold a path that isn't safe to publish, so the PR gets no note on them");
        reviewNote = "";
      }
      // Only a person accepts a finding (scripts/review.sh accept) and marks the PR ready, so a blocking finding left open holds it as a draft.
      holdAsDraft = review.ledger.findings.some(isBlocking);
      // The open Advisory findings go to a follow-up issue, as the skill's step 9 files them, but only once the branch is published (below):
      // the issue is public, so a branch the secret scan refuses or whose push fails gets none. Its text is a reviewer's, so it is held to the PR note's rules.
      // Each finding's own line and its fields are checked (a branch named for review notes must not hide them all), and the whole body once more for what the header
      // quotes, the branch name.
      advisories = advisoryIssueBody(
        review.ledger,
        review.readPaths,
        (line) => host.publicError(line) === line && !visibleLetters(line).includes("reviewnotes"),
      );
      // An empty body is also what a review with no open Advisory finding gives, so say when findings were open and none could be listed: none passed
      // the checks on what goes in a public issue (hidden text, a link, a secret, a length bound, a path the review didn't read or that isn't plain file-name
      // characters, a line that reads like a Review notes section), or the branch name failed them. Nothing else tells a person the follow-up issue was dropped.
      if (advisories === "" && renderAdvisories(review.ledger) !== "") {
        log("the local review's Advisory findings can't be listed (none passed the checks on what goes in a public issue), so no follow-up issue is filed for them");
        advisoriesUnlisted = true;
      }
      if (advisories !== "" && host.publicError(advisories) !== advisories.trim()) {
        log("the local review's Advisory findings hold text that isn't safe to publish, so no follow-up issue is filed for them");
        advisories = "";
        advisoriesUnlisted = true;
      }
    }
    // Claude Review reads a "Review notes" section as the owner's accepted findings, so no note may pass for one, in any form.
    if (visibleLetters(reviewNote).includes("reviewnotes")) {
      log("the local review's note reads like a Review notes section, so the PR gets no note on it");
      reviewNote = "";
    }

    // The push is public, and the sandbox holds the Claude token or API key.
    // The comment doesn't say where the secret is, since the issue is public
    // too. The log and the run report do: the location names no part
    // of the secret, and without it nobody can tell a leak from a false
    // positive once the runner, the only holder of the commit, is gone.
    const leak = host.leaksSecret(base, gated, mergedMain);
    if (leak !== undefined) {
      const where = describeSecretMatch(leak);
      log(`✗ a commit holds a secret (${where}), so ${branch} isn't published.`);
      host.commentOnIssue(
        issue.number,
        `Sandcastle didn't publish this issue: a commit on \`${branch}\` holds one of the sandbox's secrets, or something ` +
          `shaped like a Claude or GitHub token, so \`${branch}\` wasn't pushed. Find it with ` +
          `\`git log -p ${BASE_BRANCH}..${branch}\` before anything pushes the branch, and rotate the secret if it has ` +
          "left this machine.",
      );
      return unpublished("not published", `a commit holds a secret: ${where}`);
    }

    // A publish already reached goes ahead even once the run has hit the time
    // budget or Claude's usage limit: every role has finished, pushing
    // and opening the PR cost no usage, and an ephemeral runner throws away
    // whatever isn't pushed. The limits stop roles from starting, not this.

    // host.publish retries a GitHub server error, but not a push that doesn't
    // fast-forward origin's branch (an agent rewrote a commit an earlier round
    // pushed) or any other git or gh failure. Whatever still fails needs a
    // person, so the issue gets git's or gh's error rather than only the run log.
    const prBody = await reviewerPrBody();
    const checkChanges = await changedCheckFiles(gated, mergedMain);
    const branchAtBase = await triedCreatingBranchAtBase(gated);

    // A step that stalled the sandbox during a read this build tolerates (the PR body, the changed files) still ends the
    // build red, with the step named, rather than publishing past it.
    const stalled = stalledStepOf(sandbox);
    if (stalled !== undefined) throw new StalledStepError(`the step "${stalled}" didn't end at its limit, so ${branch} isn't published`);
    try {
      const prUrl = await host.publish(
        issue,
        branch,
        gated,
        reviewed,
        docsFailed,
        prBody,
        checkChanges,
        undefined,
        undefined,
        undefined,
        reviewNote,
        holdAsDraft,
      );
      // A failed filing never undoes the published PR.
      let findingsLost = false;
      if (advisories !== "") {
        try {
          await retryOnServerError(
            () => host.fileAdvisoryIssue(`chore(review): Advisory review findings: ${branch}`, advisories),
            host.wait ?? ((ms) => sleep(ms)),
          );
        } catch (error) {
          console.error(`  ⚠ #${issue.number}: filing the follow-up issue for the Advisory findings failed: ${terminalText(String(error))}`);
          // The ledger lives in the main checkout, which an Actions runner discards, so a findings list that isn't filed would be lost with it. The same
          // text, already checked for the public issue, goes on the Sandcastle issue instead.
          try {
            host.commentOnIssue(issue.number, advisoryFilingFailedComment(prUrl, advisories));
          } catch (commentError) {
            console.error(`  ⚠ #${issue.number}: posting the Advisory findings on the issue failed too: ${terminalText(String(commentError))}`);
            findingsLost = true;
          }
        }
      }
      return {
        commits,
        prUrl,
        publishFailed: false,
        outcome: "published",
        detail: prUrl,
        ...(findingsLost ? { findingsLost: true as const } : {}),
        ...(advisoriesUnlisted ? { findingsUnlisted: true as const } : {}),
      };
    } catch (error) {
      console.error(`  ✗ #${issue.number}: publishing ${branch} failed: ${terminalText(String(error))}`);
      const detail = host.publicError(error);
      // Sandcastle's token can't push a .github/workflows/** change, so no
      // retry or rebuild will get it through: a person has to make it, or,
      // once the branch was created at base, a local run can push it.
      if (isWorkflowPushRejection(error)) {
        // A failed listing still hands back: the comment then names the
        // directory rather than each file.
        let files: string[] = [];
        try {
          files = host.workflowFiles(base, gated, mergedMain);
        } catch (listError) {
          console.error(`  ⚠ #${issue.number}: listing the workflow files ${branch} changes failed: ${terminalText(String(listError))}`);
        }
        const change = { head: gated, files };
        if (branchAtBase !== undefined) {
          // The refused push left the branch at base with no commits and no
          // PR; a stray one would send the next round down the existing-branch
          // path and start CI on it.
          if (branchAtBase.created) {
            try {
              host.deleteBranchAt(branch, base);
            } catch (deleteError) {
              console.error(`  ⚠ #${issue.number}: deleting the stray ${branch} at ${base} failed: ${terminalText(String(deleteError))}`);
            }
          }
          let moved = false;
          try {
            host.moveToLocal(issue.number, branch, detail, change, branchAtBase.created);
            moved = true;
            log(`GitHub refused the push even as an update from ${base}, so the issue moved to Sandcastle:local`);
          } catch (moveError) {
            console.error(
              `  ⚠ #${issue.number}: moving it to Sandcastle:local failed, so the next round tries again: ${terminalText(String(moveError))}`,
            );
          }
          return {
            commits,
            prUrl: undefined,
            publishFailed: true,
            outcome: "not published",
            detail: moved
              ? "GitHub refused its push for a .github/workflows change, so it moved to Sandcastle:local"
              : "GitHub refused its push for a .github/workflows change; moving it to Sandcastle:local failed",
          };
        }
        try {
          host.handBackWorkflowChange(issue.number, branch, detail, change);
        } catch (handBackError) {
          console.error(
            `  ⚠ #${issue.number}: handing it back for its workflow change failed, so the next round tries again: ${terminalText(String(handBackError))}`,
          );
        }
        return {
          commits,
          prUrl: undefined,
          publishFailed: true,
          outcome: "not published",
          detail: "GitHub refused its .github/workflows change",
        };
      }
      const fence = "`".repeat(Math.max(3, ...[...detail.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      if (error instanceof HoldFailedError) {
        host.commentOnIssue(
          issue.number,
          `Sandcastle couldn't publish \`${branch}\`: ${reviewUnfinished ? "the review didn't finish" : "the review left findings open"}, so its open pull request has to be a draft, and turning it into one ` +
            "failed. Nothing was pushed, and that pull request may still be ready. A person needs to look at it: make it a draft " +
            `with \`gh pr ready ${branch} --undo\` before pushing anything to \`${branch}\`, so PR Auto-Merge can't merge it.\n\n${fence}text\n${detail}\n${fence}`,
        );
        return {
          commits,
          prUrl: undefined,
          publishFailed: true,
          outcome: "not published",
          detail: "turning its open pull request into a draft failed, so nothing was pushed",
        };
      }
      if (holdAsDraft) {
        // The hold ran before the push, so a pull request the branch already had is a draft now, with the body it had before; the failure came after.
        host.commentOnIssue(
          issue.number,
          `Sandcastle couldn't publish \`${branch}\`: it passed the gate, but pushing it or opening or updating its pull request failed after the ` +
            `${reviewUnfinished ? "review didn't finish" : "review left findings open"} and the pull request was held as a draft. The branch keeps its commits. A person needs to look at it. A pull ` +
            `request from it may already be open as a draft, without the note saying why: find it with \`gh pr list --head ${branch}\` before opening ` +
            `one, and do not mark it ready until ${reviewUnfinished ? "the review has been run again and nothing is open" : "each open finding is fixed or accepted (the review's ledger is on the runner: run `/pre-push-review` on the branch first, then `scripts/review.sh accept <id> <reason>`)"}. If origin's ` +
            `\`${branch}\` isn't at \`${gated}\`, the commit the gate passed, it still has to be pushed from its worktree, and if origin's branch has ` +
            `commits the local one doesn't, the two need reconciling.\n\n${fence}text\n${detail}\n${fence}`,
        );
        return {
          commits,
          prUrl: undefined,
          publishFailed: true,
          outcome: "not published",
          detail: "pushing it or opening its pull request failed after the pull request was held as a draft",
        };
      }
      host.commentOnIssue(
        issue.number,
        `Sandcastle couldn't publish \`${branch}\`: it passed the gate, but pushing it or opening its pull request ` +
          "failed. The branch keeps its commits. A person needs to look at it. First check whether a pull request " +
          "from it is already open: GitHub can create one and still answer with an error. Once GitHub recovers from " +
          `a server error: if origin's \`${branch}\` isn't at \`${gated}\`, the commit the gate passed, push it ` +
          "from its worktree; if it is, the push succeeded and opening the pull request failed, so open one by hand " +
          `with \`Closes #${issue.number}\` in ` +
          "its body. If origin's branch has commits the local one doesn't (an agent rewrote one an earlier round " +
          `pushed), the two need reconciling before Sandcastle can push it.\n\n${fence}text\n${detail}\n${fence}`,
      );
      return {
        commits,
        prUrl: undefined,
        publishFailed: true,
        outcome: "not published",
        detail: "pushing it or opening its pull request failed",
      };
    }
  } finally {
    // Sandcastle's close() runs git in the worktree; leave one that no longer
    // points at this repository, with its sandbox, for a person to look at.
    const problems = host.worktreeProblems(sandbox.worktreePath);
    if (problems.length > 0) {
      console.error(`  ✗ #${issue.number}: left ${sandbox.worktreePath} and its sandbox in place: ${terminalText(problems.join("; "))}`);
      host.commentOnIssue(issue.number, tamperedWorktreeComment(branch));
    } else {
      // A close the host gave up on is logged and ends the run red (closeAfterWork, exitAfterStall), and any close failure on a stalled
      // sandbox (which may have a command still running) is only logged: the pull request or the StalledStepError that ended the work is
      // what to report.
      await closeAfterWork(sandbox, {
        stalled: stalledStepOf(sandbox) !== undefined,
        minutes: host.dockerCallMinutes,
        log: (line) => console.error(`  ⚠ ${terminalText(line)}`),
      });
    }
  }
}
