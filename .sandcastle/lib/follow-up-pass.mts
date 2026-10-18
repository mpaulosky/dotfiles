// ---------------------------------------------------------------------------
// Follow-up pass
//
// The sweep (lib/follow-up.mts) decides which PRs need a pass; this module is
// the pass itself. One pass resets the PR's worktree to its head, gates the
// head when a check is red to tell a real failure from a flaky one (#79),
// merges main in when the PR needs it, runs the follow-up role to resolve the
// merge, the PR's bot and owner review threads and any red check the gate
// doesn't cover, gates and pushes the result, re-runs a flaky check the gate
// passes, then replies to and resolves the role's verdicts and posts a
// pass-summary comment. See docs/plans/sandcastle-workflow.md, "Phase 1:
// Follow-up sweep", and #78's design note (.sandcastle/work/78/design.md) for
// the step-by-step this module follows.
// ---------------------------------------------------------------------------

import { setTimeout as sleep } from "node:timers/promises";
import * as sandcastle from "@ai-hero/sandcastle";
import { z } from "zod";
import { runRoleInSandbox } from "./agents.mts";
import { originGit, originRefs } from "./branches.mts";
import {
  BROKEN_COMMENT_OPEN,
  createCheckedSandbox,
  cutAtCharacter,
  isWorkflowPushRejection,
  publicErrorText,
  retryOnServerError,
} from "./build.mts";
import { claimBuildingLabel, releaseBuildingLabel } from "./building.mts";
import { runCheckpoint, runGate, tail, type GateRun } from "./checkpoint.mts";
import {
  BUILDING_LABEL,
  FOLLOW_UP_MARKER,
  FOLLOW_UP_PASS_CAP,
  FOLLOW_UP_REPLY_MARKER,
  GATE_COMMENT_LINES,
  GATE_FIXER_ATTEMPTS,
} from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import type { CheckState, PassTarget } from "./follow-up.mts";
import {
  commentOnPullRequest,
  failedCheckLogs,
  handBack,
  headChecksOf,
  markerComments,
  pushAccess,
  replyToReviewThread,
  rerunFailedChecksOnce,
  resolveReviewThread,
  reviewThreadsOf,
  signedInHostLogin,
  type HeadCheck,
  type ReviewThread,
  type SandcastleIssue,
} from "./github.mts";
import { repoGitDir, worktreeLinkProblems } from "./host-safety.mts";
import { plainText, withoutReferences } from "./intake.mts";
import { runLimits, type RunLimits } from "./limits.mts";
import { followUpPromptArgs, gateFixerPromptArgs } from "./prompts.mts";
import { ownerCheck, type IsOwner } from "./queue.mts";
import { humanThreadReport, outcomeReport, type HumanThreadEntry, type OutcomeEntry, type OutcomeReport } from "./report.mts";
import { containsSandboxSecret, sandboxSecrets } from "./sandbox-env.mts";
import { describeSecretMatch, firstSecretMatch, type SecretMatch } from "./scan.mts";
import { git } from "./shell.mts";

// Where the follow-up role writes its verdicts, relative to the worktree.
// Gitignored (.sandcastle/.gitignore), so the gate's clean-worktree check
// doesn't trip on it.
const VERDICTS_FILE = ".sandcastle/follow-up.json";

// GitHub refuses a comment over 65,536 characters; this leaves room to spare.
const COMMENT_LIMIT = 65_000;

// How much of the red checks' failed-job logs the follow-up role gets, split
// evenly across the runs behind them (lib/github.mts#failedCheckLogs keeps
// each run's own end, where its error is, rather than the end of the whole
// joined text): a whole CodeQL log can run to megabytes, far past what a
// prompt should carry, and without the split one run's log could crowd out
// another's entirely (#79).
const CI_LOG_LIMIT = 60_000;

// One review thread given to the follow-up role, trimmed to only what it
// needs (see threadsForRole): never a stranger's comment, and never more
// than a bot's or the repository owner's. Also the shape of each entry in
// lib/prompts.mts#followUpPromptArgs's THREADS_JSON.
export type PromptThread = {
  threadId: string;
  from: "bot" | "owner";
  path: string | null;
  line: number | null;
  outdated: boolean;
  comments: { author: string | null; body: string }[];
};

// Sorts a PR's open review threads for the follow-up role (runPass's step
// 2). A resolved thread is dropped outright. A thread whose first comment's
// author is a bot goes to the role as "bot". A thread the repository owner
// opened goes to the role as "owner", unless the last comment by the owner or
// `hostLogin` is the host's own reply (by `hostLogin`, opening with
// FOLLOW_UP_REPLY_MARKER, lib/config.mts): that means the host already
// answered it and is waiting on the owner, so it's dropped from every list
// rather than handed to the role again. Comments by anyone else don't count
// either way, so a stranger can neither hide an owner thread by quoting the
// marker nor reopen one by replying after the host. A bot thread whose last
// comment by a bot, the owner or the host is the host's own reply is dropped
// too: it's open again only because resolving it failed (the pass summary
// says so) or the owner unresolved it, and either way it's a person's now,
// not the role's to answer twice. Any other thread,
// including one with no author at all, goes to `leftForHuman`
// (lib/report.mts#recordHumanThread records each one). A thread whose first
// author `isOwner` can't answer for goes to `unknown`, so a pass never
// decides from partial information: runPass skips the round when `unknown`
// isn't empty. Inside a kept thread, a comment by neither a bot nor the
// owner is dropped before the thread reaches the role.
export function threadsForRole(
  threads: readonly ReviewThread[],
  isOwner: IsOwner,
  hostLogin: string,
): { forRole: PromptThread[]; leftForHuman: ReviewThread[]; unknown: ReviewThread[] } {
  const forRole: PromptThread[] = [];
  const leftForHuman: ReviewThread[] = [];
  const unknown: ReviewThread[] = [];
  const hostReply = (comment: ReviewThread["comments"][number] | undefined) =>
    comment?.author === hostLogin && comment.body.startsWith(FOLLOW_UP_REPLY_MARKER);
  for (const thread of threads) {
    if (thread.resolved) continue;
    const first = thread.comments[0];
    let from: PromptThread["from"];
    if (first?.byBot === true) {
      const last = thread.comments.findLast(
        (comment) => comment.byBot || comment.author === hostLogin || isOwner(comment.author) === true,
      );
      if (hostReply(last)) continue;
      from = "bot";
    } else {
      const owner = first === undefined ? false : isOwner(first.author);
      if (owner === undefined) {
        unknown.push(thread);
        continue;
      }
      if (!owner) {
        leftForHuman.push(thread);
        continue;
      }
      const last = thread.comments.findLast((comment) => comment.author === hostLogin || isOwner(comment.author) === true);
      if (hostReply(last)) continue;
      from = "owner";
    }
    forRole.push({
      threadId: thread.id,
      from,
      path: thread.path,
      line: thread.line,
      outdated: thread.outdated,
      // A comment whose author's ownership can't be confirmed is dropped too:
      // only what's known to be a bot's or the owner's reaches the role.
      comments: thread.comments
        .filter((comment) => comment.byBot || isOwner(comment.author) === true)
        .map((comment) => ({ author: comment.author, body: comment.body })),
    });
  }
  return { forRole, leftForHuman, unknown };
}

// One entry of the follow-up role's .sandcastle/follow-up.json, one per
// thread it was given (see parseVerdicts). `commit` names the fix when
// `verdict` is "fixed". `invalid` (meaningful only when `verdict` is
// "declined") marks a factually wrong bot suggestion, so the host resolves
// the thread INVALID rather than WONT_FIX.
export type ThreadVerdict = {
  threadId: string;
  verdict: "fixed" | "declined" | "outdated";
  reason: string;
  commit?: string;
  invalid?: boolean;
};

// One entry of follow-up.json as parseVerdicts accepts it. A commit must look
// like a commit id, since replyBody names it on GitHub.
const verdictSchema = z.object({
  threadId: z.string().min(1),
  verdict: z.enum(["fixed", "declined", "outdated"]),
  reason: z.string().min(1),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  invalid: z.boolean().optional(),
});

// Parses the follow-up role's .sandcastle/follow-up.json (runPass's step 8),
// read from inside the sandbox, never from the host. Throws unless the whole
// file is a JSON array: that's the follow-up run having failed outright, not
// a single bad verdict. Each entry is checked against ThreadVerdict's shape
// on its own; one that doesn't fit goes in `rejected` rather than failing
// every other entry in the file.
export function parseVerdicts(text: string): { verdicts: ThreadVerdict[]; rejected: unknown[] } {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${VERDICTS_FILE} isn't a JSON array`);
  const verdicts: ThreadVerdict[] = [];
  const rejected: unknown[] = [];
  for (const entry of parsed) {
    const result = verdictSchema.safeParse(entry);
    if (result.success) verdicts.push(result.data);
    else rejected.push(entry);
  }
  return { verdicts, rejected };
}

// How the host resolves a bot thread on GitHub (lib/github.mts#resolveReviewThread
// takes no resolution of its own, so this only ever reaches a reply and the
// pass summary): ADDRESSED for a fix or an outdated concern, WONT_FIX or
// INVALID for one declined.
export type Resolution = "ADDRESSED" | "WONT_FIX" | "INVALID";

// One verdict matched to the thread it answers (see threadActions), and how
// the host resolves it on GitHub: undefined for an owner thread, which the
// host replies to but never resolves.
export type ThreadAction = { thread: PromptThread; verdict: ThreadVerdict; resolve: Resolution | undefined };

// Matches each of `verdicts` to the thread in `given` (the threads the
// follow-up role was actually given) it answers. A verdict naming a thread
// not in `given` — an unknown id, a stranger's thread, or one already
// resolved — goes in `ignored` by its threadId rather than acted on, and so
// does a second verdict for a thread that already has one (runPass's step
// 12 relies on `actions` holding at most one entry per thread). `resolve` is
// ADDRESSED for "fixed" or "outdated", WONT_FIX for "declined" (INVALID
// instead when the verdict's `invalid` is set), and always undefined for an
// owner thread.
export function threadActions(
  verdicts: readonly ThreadVerdict[],
  given: readonly PromptThread[],
): { actions: ThreadAction[]; ignored: string[] } {
  const byId = new Map(given.map((thread) => [thread.threadId, thread]));
  const answered = new Set<string>();
  const actions: ThreadAction[] = [];
  const ignored: string[] = [];
  for (const verdict of verdicts) {
    const thread = byId.get(verdict.threadId);
    if (thread === undefined || answered.has(verdict.threadId)) {
      ignored.push(verdict.threadId);
      continue;
    }
    answered.add(verdict.threadId);
    actions.push({ thread, verdict, resolve: thread.from === "owner" ? undefined : resolutionOf(verdict) });
  }
  return { actions, ignored };
}

// How a verdict on a bot thread resolves it (see threadActions).
function resolutionOf(verdict: ThreadVerdict): Resolution {
  if (verdict.verdict !== "declined") return "ADDRESSED";
  return verdict.invalid === true ? "INVALID" : "WONT_FIX";
}

// How each verdict and resolution reads in a reply.
const VERDICT_WORDS: Record<ThreadVerdict["verdict"], string> = { fixed: "Fixed", declined: "Declined", outdated: "Outdated" };
const RESOLUTION_WORDS: Record<Resolution, string> = { ADDRESSED: "addressed", WONT_FIX: "won't fix", INVALID: "invalid" };

// Model text the host posts with its <!-- broken, so a reason quoting a host
// marker can't pass for the host's own comment (as lib/build.mts's
// designComment does, #228).
function withoutCommentOpeners(text: string): string {
  return text.replaceAll("<!--", BROKEN_COMMENT_OPEN);
}

// `text` cut to fit COMMENT_LIMIT (see lib/build.mts#cutAtCharacter).
function cutToLimit(text: string): string {
  return text.length <= COMMENT_LIMIT ? text : cutAtCharacter(text, COMMENT_LIMIT);
}

// The reply the host posts on a thread for `action` (runPass's step 12):
// FOLLOW_UP_REPLY_MARKER, a first line naming the verdict (and, for a bot
// thread, the resolution, such as "Resolved as won't fix."), then the reason
// — through `publicError`, which hides a secret, with its <!-- and every
// @mention or #123 reference outside code broken — and "Fixed in <commit>"
// when the verdict names one. Cut to fit GitHub's comment limit.
export function replyBody(action: ThreadAction, publicError: (text: string) => string): string {
  const { verdict, resolve } = action;
  const lead =
    resolve === undefined
      ? `**${VERDICT_WORDS[verdict.verdict]}.** Left open for the repository owner.`
      : `**${VERDICT_WORDS[verdict.verdict]}.** Resolved as ${RESOLUTION_WORDS[resolve]}.`;
  const reason = withoutReferences(withoutCommentOpeners(publicError(verdict.reason)));
  const commit = verdict.commit === undefined ? [] : [`Fixed in ${verdict.commit}.`];
  return cutToLimit([`${FOLLOW_UP_REPLY_MARKER}\n${lead}`, reason, ...commit].join("\n\n"));
}

// One pass's outcome, for passSummaryComment: which attempt this was, what
// commit was pushed (undefined when nothing needed pushing), whether main
// needed merging in and how that went, every thread action taken, the
// ignored verdicts, the "fixed" verdicts left unanswered because their commit
// didn't check out (see fixesInPush), any GitHub write that failed, how
// many threads were left for a person, and what was done about red CI:
// planRedCi's plan, with `rerun` naming only the checks actually re-run (none
// when the pass pushed). Left out, or all empty, when no check was red.
export type PassReport = {
  pass: number;
  pushed: string | undefined;
  merged: "none" | "clean" | "conflicts";
  actions: ThreadAction[];
  ignored: string[];
  unverified: string[];
  failedWrites: string[];
  leftForHuman: number;
  redCi?: RedCiPlan;
};

// How the pass summary says main was merged in, if it was.
const MERGE_SENTENCES: Record<PassReport["merged"], string[]> = {
  none: [],
  clean: ["Merged `main` into the branch."],
  conflicts: ["Merged `main` into the branch and resolved its conflicts."],
};

// The PR comment a pass posts once it's done (runPass's step 13):
// FOLLOW_UP_MARKER, "Follow-up pass n of FOLLOW_UP_PASS_CAP", what was
// pushed, and one line per thread action naming its verdict and resolution,
// or "left open for the owner" for one that was only replied to. The role's
// text in it goes through `publicError` first, as replyBody's does.
export function passSummaryComment(report: PassReport, publicError: (text: string) => string): string {
  const lines = [`${FOLLOW_UP_MARKER}\nSandcastle's follow-up pass ${report.pass} of ${FOLLOW_UP_PASS_CAP} on this PR.`];
  const pushed =
    report.pushed === undefined ? "Nothing needed pushing." : `Pushed \`${report.pushed}\`, which passed \`scripts/gate.sh\`.`;
  lines.push([...MERGE_SENTENCES[report.merged], pushed].join(" "));
  const ci = report.redCi;
  if (ci !== undefined) {
    if (ci.fix) lines.push("`scripts/gate.sh` was red on the PR's head before this pass.");
    if (ci.forward.length > 0) {
      lines.push(`Gave the follow-up role the failed-job logs of these checks, which \`scripts/gate.sh\` doesn't cover: ${checkList(ci.forward)}.`);
    }
    if (ci.rerun.length > 0) {
      lines.push(`Re-ran the failed jobs of ${checkList(ci.rerun)} once as flaky, since \`scripts/gate.sh\` passes on the PR's head.`);
    }
  }
  if (report.actions.length > 0) {
    lines.push(["Review threads:", ...report.actions.map((action) => summaryLine(action, publicError))].join("\n"));
  }
  if (report.ignored.length > 0) {
    lines.push(`Ignored verdicts for threads the follow-up role wasn't given, or already answered: ${idList(report.ignored, publicError)}.`);
  }
  if (report.unverified.length > 0) {
    lines.push(
      `Left open, since their "fixed" verdict names no commit this pass added to the branch: ${idList(report.unverified, publicError)}.`,
    );
  }
  if (report.failedWrites.length > 0) {
    lines.push(`These GitHub writes failed: ${report.failedWrites.join("; ")}.`);
  }
  if (report.leftForHuman > 0) {
    lines.push(
      `${report.leftForHuman} review thread(s) opened by someone other than the repository owner or a bot were left for a person.`,
    );
  }
  return cutToLimit(lines.join("\n\n"));
}

// Model text for the pass summary: through `publicError`, which hides a
// secret, before it's cut (a secret cut in half no longer matches), then cut
// to `limit` without splitting a character, which GitHub would refuse, and
// kept to plain text.
function summaryText(text: string, limit: number, publicError: (text: string) => string): string {
  return plainText(cutAtCharacter(publicError(text), limit));
}

// Thread ids the role wrote, for a line of the pass summary.
function idList(ids: readonly string[], publicError: (text: string) => string): string {
  return ids.map((id) => summaryText(id, 100, publicError)).join(", ");
}

// One thread action's line in the pass summary. The reason is model text, so
// it's cut short; the reply on the thread has it all.
function summaryLine(action: ThreadAction, publicError: (text: string) => string): string {
  const { thread, verdict, resolve } = action;
  const where = thread.path === null ? "" : ` on ${plainText(thread.path)}${thread.line === null ? "" : `:${thread.line}`}`;
  const outcome = resolve === undefined ? "left open for the owner" : `resolved ${resolve}`;
  return `- ${thread.from} thread${where}: ${verdict.verdict}, ${outcome}. ${summaryText(verdict.reason, 300, publicError)}`;
}

// Check names for a line of the pass summary or a give-up reason. They're
// the repository's own job names, but a matrix entry's name comes from the
// branch, so each is kept to plain text all the same.
function checkList(names: readonly string[]): string {
  return names.map(plainText).join(", ");
}

// Re-runs the failed jobs of `names` (planRedCi's `rerun`) once as flaky,
// and returns the ones still red: red after a re-run that already happened,
// or left out of the host's answer, since a check missing from it isn't
// known to have passed. `expectedHead` is the commit the pass gated
// (target.headRefOid): the host refuses when the PR's head has moved past it,
// rather than re-run jobs for a commit the pass never judged (#79).
function stillRedAfterRerun(pr: number, names: readonly string[], host: PassHost, expectedHead: string): string[] {
  const after = new Map(host.rerunFailedChecks(pr, names, expectedHead).map((check) => [check.name, check]));
  return names.filter((name) => {
    const check = after.get(name);
    return check === undefined || (check.completed && !check.green);
  });
}

// The failed-job logs of `names`, which stayed red after their re-run, for
// the hand-back comment to quote. Undefined when they can't be read: the
// hand-back goes ahead without them. `expectedHead` is threaded through to
// the host the same way stillRedAfterRerun's is.
function rerunLog(pr: number, names: readonly string[], host: PassHost, log: (line: string) => void, expectedHead: string): string | undefined {
  try {
    return host.failedCheckLog(pr, names, expectedHead);
  } catch (error) {
    log(`reading the failed-job logs of ${names.join(", ")} failed, so the hand-back doesn't quote them: ${error}`);
    return undefined;
  }
}

// The PR hand-back comment for a pass that gave up (runPass's step 4, 9, 10,
// 11): why, then the tail of the last gate output or the role's error (when
// given) in a fence longer than any backtick run in it, and how to re-queue
// the PR (remove sandcastle:needs-human).
export function giveUpComment(reason: string, output: string | undefined): string {
  const parts = [
    `Sandcastle stopped its follow-up passes on this PR: ${reason}. It's labelled \`sandcastle:needs-human\` until a person ` +
      "has looked at it.",
  ];
  if (output !== undefined && output.trim() !== "") {
    const quoted = tail(output, GATE_COMMENT_LINES);
    const longestRun = Math.max(0, ...[...quoted.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    parts.push(`The last ${GATE_COMMENT_LINES} lines of the output:\n\n${fence}text\n${quoted}\n${fence}`);
  }
  parts.push(
    "To have Sandcastle pick the PR up again, remove `sandcastle:needs-human`. That also starts its count of follow-up " +
      "passes again.",
  );
  return cutToLimit(parts.join("\n\n"));
}

// What one call to runPass decided or did:
// - "skipped": nothing counted against FOLLOW_UP_PASS_CAP (the head moved
//   since the sweep read it, there's nothing a pass handles yet, or
//   markBuilding said another run already has the issue);
// - "passed": the pass ran to completion; `pushed` is the commit pushed, or
//   undefined when nothing needed pushing;
// - "push-failed": the gated commit failed to push because someone pushed to
//   the PR meanwhile (its head on GitHub moved, or couldn't be read); not
//   counted and not a give-up, so the next sweep tries again with the PR's
//   new head. A push that failed with the head unmoved gives up instead, and
//   one that reported an error but landed counts as pushed;
// - "gave-up": the PR was handed back with sandcastle:needs-human.
export type PassOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "passed"; pushed: string | undefined }
  | { kind: "push-failed"; error: string }
  | { kind: "gave-up"; reason: string };

// `target`'s entry for the run report (lib/report.mts), or undefined for a
// pass that was skipped or gave up: a gave-up pass's hand-back already makes
// a row (the hand-back's own), and a skipped PR touched nothing this round.
export function passOutcomeEntry(target: PassTarget, outcome: PassOutcome): OutcomeEntry | undefined {
  const pr = { kind: "pr", number: target.number, outcome: "follow-up pass" } as const;
  switch (outcome.kind) {
    case "passed":
      return { ...pr, detail: outcome.pushed === undefined ? "nothing needed pushing" : `pushed ${outcome.pushed.slice(0, 7)}` };
    case "push-failed":
      return { ...pr, detail: "its push failed; see the run log; swept again next round" };
    case "gave-up":
    case "skipped":
      return undefined;
  }
}

// What runPass needs from outside the pass itself; tests pass a stub. The
// live wiring sits at the bottom of this module.
export type PassHost = {
  // branches.mts's originGit.fetch, so the sandbox's createSandbox(branch)
  // checks the PR's head out from its remote-tracking ref.
  fetchBranch(branch: string): void;
  // lib/github.mts#reviewThreadsOf.
  reviewThreads(pr: number): { headRefOid: string; threads: ReviewThread[] };
  // lib/queue.mts#ownerCheck(signedInHostLogin, pushAccess).
  isOwner: IsOwner;
  // lib/github.mts#signedInHostLogin: who the host's replies are posted as.
  hostLogin(): string;
  // FOLLOW_UP_MARKER comments posted since sandcastle:needs-human was last
  // removed (lib/github.mts#markerComments), counted against
  // FOLLOW_UP_PASS_CAP.
  passCount(pr: number): number;
  // git merge-base --is-ancestor, in the main checkout.
  contains(commit: string, ancestor: string): boolean;
  // lib/building.mts#claimBuildingLabel.
  markBuilding(issue: number): boolean;
  // lib/building.mts#releaseBuildingLabel.
  unmarkBuilding(issue: number): void;
  createSandbox(branch: string): Promise<sandcastle.Sandbox>;
  // lib/host-safety.mts's worktree-tamper check, as lib/build.mts#BuildHost
  // already exposes it.
  worktreeProblems(path: string): string[];
  // The first match (see lib/scan.mts#firstSecretMatch) in what the commits
  // from `base` to `commit` publish, against one of the sandbox's secrets or
  // a token shape, or undefined when nothing matches. Carries only where the
  // match sits and what kind it is, never the matched text, so logging or
  // reporting it never risks the secret itself (#324).
  leaksSecret(base: string, commit: string): SecretMatch | undefined;
  // A plain push of the gated commit to the PR's branch, retried on a
  // GitHub server error the way lib/build.mts#publish's push is.
  push(branch: string, commit: string): Promise<void>;
  // branches.mts's originRefs.remoteHead: the branch's head on GitHub now.
  remoteHead(branch: string): string | undefined;
  // A fresh read of the PR's current checks on its head, since the ones the
  // sweep read (lib/follow-up.mts#SweepPullRequest.checks) may be stale by
  // the time a pass claims the PR (lib/github.mts#headChecksOf). The head the
  // checks were read from travels with them, so a caller can tell a race from
  // a settled read (#79) rather than decide red CI from a commit it never
  // gated.
  checks(pr: number): { headRefOid: string; checks: HeadCheck[] };
  // `gh run rerun --failed` for the run(s) backing each of `checkNames`
  // (planRedCi's `rerun`), then the state of exactly those checks: running
  // for a run it re-ran, or as they stand for a run already re-run once,
  // where a red one means the re-run failed too. It doesn't wait for a re-run
  // to finish, since that would hold the issue's building label, and the
  // whole host, for as long as CI takes (lib/github.mts#rerunFailedChecksOnce).
  // `expectedHead` is the commit the pass gated: the host refuses when the
  // PR's head has moved past it (#79), rather than re-run a commit the pass
  // never judged.
  rerunFailedChecks(pr: number, checkNames: readonly string[], expectedHead: string): CheckState[];
  // `gh run view --log-failed` for the run(s) backing each of `checkNames`
  // (planRedCi's `forward`), concatenated: the text the follow-up role gets
  // to fix what the gate doesn't cover (lib/github.mts#failedCheckLogs).
  // `expectedHead` is checked the same way rerunFailedChecks' is. `limit`,
  // when given, keeps each run's own section to an even share of it, so one
  // run's log can't crowd another's out when the joined text is cut to fit a
  // prompt (#79).
  failedCheckLog(pr: number, checkNames: readonly string[], expectedHead: string, limit?: number): string;
  // lib/github.mts#replyToReviewThread.
  replyToThread(threadId: string, body: string): void;
  // lib/github.mts#resolveReviewThread.
  resolveThread(threadId: string): void;
  // lib/github.mts#commentOnPullRequest.
  commentOnPullRequest(pr: number, body: string): void;
  // lib/github.mts#handBack({ kind: "pr", number: pr }, "sandcastle:needs-human", reason, body).
  handBack(pr: number, reason: string, body: string): void;
  // lib/report.mts#humanThreadReport.record.
  recordHumanThread(entry: HumanThreadEntry): void;
  // lib/build.mts#publicErrorText, checked against the sandbox's secrets.
  publicError(text: unknown): string;
  // The run's limits (lib/limits.mts#runLimits): runPass runs the follow-up
  // role and the gate-fixer through runRoleInSandbox(..., host.limits).
  limits: RunLimits;
  log(line: string): void;
};

// The live PassHost.
export const livePassHost: PassHost = {
  fetchBranch: (branch) => originGit.fetch(branch),
  reviewThreads: (pr) => reviewThreadsOf(pr),
  isOwner: ownerCheck(
    () => signedInHostLogin(),
    (login) => pushAccess(login),
  ),
  hostLogin: () => signedInHostLogin(),
  passCount: (pr) => markerComments(pr, "sandcastle:needs-human", FOLLOW_UP_MARKER).length,
  contains: (commit, ancestor) => originRefs.contains(commit, ancestor),
  markBuilding: (issue) => claimBuildingLabel(issue),
  unmarkBuilding: (issue) => releaseBuildingLabel(issue),
  createSandbox: (branch) => createCheckedSandbox(branch),
  worktreeProblems: (path) => worktreeLinkProblems(path, repoGitDir()),
  leaksSecret: (base, commit) => firstSecretMatch(base, commit, sandboxSecrets()),
  push: (branch, commit) =>
    retryOnServerError(
      () => void git("push", "--quiet", "origin", `${commit}:refs/heads/${branch}`),
      (ms) => sleep(ms),
    ),
  remoteHead: (branch) => originRefs.remoteHead(branch),
  checks: (pr) => headChecksOf(pr),
  rerunFailedChecks: (pr, checkNames, expectedHead) => rerunFailedChecksOnce(pr, checkNames, expectedHead),
  failedCheckLog: (pr, checkNames, expectedHead, limit) => failedCheckLogs(pr, checkNames, expectedHead, undefined, undefined, limit),
  replyToThread: (threadId, body) => replyToReviewThread(threadId, body),
  resolveThread: (threadId) => resolveReviewThread(threadId),
  commentOnPullRequest: (pr, body) => commentOnPullRequest(pr, body),
  handBack: (pr, reason, body) => handBack({ kind: "pr", number: pr }, "sandcastle:needs-human", reason, body),
  // A thread left for a person is found again every round a pass looks at
  // its PR, so the run's report lists it once.
  recordHumanThread: (entry) => {
    if (!humanThreadReport.items().some((item) => item.url === entry.url)) humanThreadReport.record(entry);
  },
  publicError: (text) => publicErrorText(String(text instanceof Error ? text.message : text), containsSandboxSecret),
  limits: runLimits,
  log: (line) => console.log(line),
};

// `value` as one single-quoted shell word. Every value runPass puts in a
// sandbox command comes from GitHub or the host's git, never the role, but
// it's quoted anyway rather than trusted to hold no shell syntax.
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Whether `ancestor` is in `commit`'s history, asked in the sandbox's
// worktree, where the role's commits are.
async function sandboxContains(sandbox: Pick<sandcastle.Sandbox, "exec">, commit: string, ancestor: string): Promise<boolean> {
  const result = await sandbox.exec(`git merge-base --is-ancestor ${shellWord(ancestor)} ${shellWord(commit)}`);
  return result.exitCode === 0;
}

// Runs the follow-up role, with `ciLog` (the failed-job logs of the red
// checks the gate doesn't cover, when there are any), and reads its verdicts
// from VERDICTS_FILE. Returns them, or the outcome from `stop` when the role
// failed, ended unfinished or wrote no usable file. An UncountedStopError is
// rethrown.
async function followUpVerdicts(
  sandbox: sandcastle.Sandbox,
  issue: SandcastleIssue,
  target: PassTarget,
  forRole: PromptThread[],
  mergeNote: string,
  ciLog: string | undefined,
  host: PassHost,
  stop: (reason: string, output?: string) => PassOutcome,
): Promise<ThreadVerdict[] | PassOutcome> {
  let run: sandcastle.SandboxRunResult;
  try {
    run = await runRoleInSandbox(
      sandbox,
      "follow-up",
      {
        promptFile: "./.sandcastle/roles/follow-up.md",
        promptArgs: followUpPromptArgs(issue, target.headRefName, target.number, forRole, mergeNote, ciLog),
      },
      host.limits,
    );
  } catch (error) {
    if (error instanceof UncountedStopError) throw error;
    return stop("the follow-up run failed", String(error));
  }
  if (run.completionSignal === undefined) return stop("the follow-up run ended unfinished");

  // Read inside the sandbox, never from the host: the role wrote it, and
  // it could be a symlink to a host file.
  const file = await sandbox.exec(`cat ${VERDICTS_FILE} 2>/dev/null`);
  if (file.exitCode !== 0) {
    return forRole.length > 0 ? stop(`the follow-up run wrote no \`${VERDICTS_FILE}\` for the threads it was given`) : [];
  }
  try {
    const parsed = parseVerdicts(file.stdout);
    if (parsed.rejected.length > 0) host.log(`  PR #${target.number} ignored ${parsed.rejected.length} malformed verdict(s) in ${VERDICTS_FILE}`);
    return parsed.verdicts;
  } catch (error) {
    return stop(`the follow-up run's \`${VERDICTS_FILE}\` isn't a JSON array of verdicts`, String(error));
  }
}

// Splits `actions` (threadActions' matched verdicts, at most one per thread)
// into those the host carries out and the thread ids of "fixed" ones it
// doesn't. Run after the matching, so a verdict for an unknown thread stays
// in threadActions' `ignored`, and a thread's first verdict failing this
// check never lets a later one for the same thread win. A "fixed" verdict is kept only when its commit is one this pass
// added: it resolves in the sandbox, `gated` contains it, and neither `head`
// (the PR's head before the pass) nor `base` (main, whose commits a merge
// brings in) does, and it isn't `hostMerge`, the merge commit the host made
// itself when main merged in cleanly. Otherwise the reply would say "Fixed in" a
// commit the PR doesn't hold, or resolve a bot thread nothing changed for, and
// nobody would look at it again. An unverified verdict's thread is left open,
// so the next pass sees it again.
async function fixesInPush(
  sandbox: Pick<sandcastle.Sandbox, "exec">,
  actions: readonly ThreadAction[],
  { gated, head, base, hostMerge }: { gated: string; head: string; base: string; hostMerge: string | undefined },
): Promise<{ kept: ThreadAction[]; unverified: string[] }> {
  const kept: ThreadAction[] = [];
  const unverified: string[] = [];
  for (const action of actions) {
    const { verdict } = action;
    if (verdict.verdict !== "fixed") {
      kept.push(action);
      continue;
    }
    const resolved =
      verdict.commit === undefined
        ? undefined
        : (await sandbox.exec(`git rev-parse --verify --quiet ${shellWord(`${verdict.commit}^{commit}`)}`)).stdout.trim();
    const added =
      resolved !== undefined &&
      /^[0-9a-f]{40,64}$/.test(resolved) &&
      resolved !== hostMerge &&
      (await sandboxContains(sandbox, gated, resolved)) &&
      !(await sandboxContains(sandbox, head, resolved)) &&
      !(await sandboxContains(sandbox, base, resolved));
    if (added) kept.push(action);
    else unverified.push(verdict.threadId);
  }
  return { kept, unverified };
}

// Whether `checkName` is a job scripts/gate.sh actually runs: the build and
// test jobs in ci.yml ("Build Solution", and "Tests: <project>" for each
// matrix entry) and the lint jobs in lint-markdown.yml ("markdownlint") and
// lint-yaml.yml ("yamllint"). Every other check on a PR's head, CodeQL's
// "Analyze" jobs included, isn't: the gate never runs it, so a pass can't
// tell whether it's a real failure or a flaky one by gating alone (see "Red
// CI" in docs/plans/sandcastle-workflow.md). ci.yml's "Test Suite" counts
// as covered too: it only reports the test jobs' results, so it's red exactly
// when one of them is, and `gh run rerun --failed` re-runs it with them.
export function isGateCovered(checkName: string): boolean {
  return GATE_COVERED_CHECKS.has(checkName) || /^Tests: \S/.test(checkName);
}

// The check names isGateCovered matches exactly; ci.yml's test matrix jobs
// ("Tests: <project>") are matched by their prefix.
const GATE_COVERED_CHECKS = new Set(["Build Solution", "Test Suite", "markdownlint", "yamllint"]);

// What a pass does about a PR's red checks (planPass's `redChecks`),
// decided from whether `scripts/gate.sh` reproduced a failure on the head
// (`gatePassed`): `fix` when it's red, so the gate-fixer takes it and the
// host pushes once it's green. Otherwise `rerun` names each still-red check
// the gate covers, for one re-run as flaky (`gh run rerun --failed`); a
// check named there that's still red after the re-run gives up with
// sandcastle:needs-human. `forward` names each red check the gate doesn't
// cover (CodeQL), whose failed-job log (`gh run view --log-failed`) goes to
// the follow-up role. Both arrays are empty when `gatePassed` is false (there's
// nothing to re-run or forward until the gate is green), and when there are
// no red checks at all.
export type RedCiPlan = { fix: boolean; rerun: string[]; forward: string[] };
export function planRedCi(gatePassed: boolean, redChecks: readonly CheckState[]): RedCiPlan {
  if (!gatePassed) return { fix: true, rerun: [], forward: [] };
  // A check can be listed twice (a status and a check run of one name), but
  // it's re-run or forwarded once.
  const names = [...new Set(redChecks.map((check) => check.name))];
  return { fix: false, rerun: names.filter(isGateCovered), forward: names.filter((name) => !isGateCovered(name)) };
}

// Runs one follow-up pass on `target`, a PR the sweep (lib/follow-up.mts)
// marked as needing one, for its issue. See this module's header and the
// design note at .sandcastle/work/78/design.md for the step-by-step: reset
// the PR's worktree to its head, merge main in when the PR needs it, run the
// follow-up role, gate and push, then reply to and resolve the role's
// verdicts and post the pass summary. `base` is the commit fetchMain()
// resolved origin/main to this round.
export async function runPass(
  target: PassTarget,
  issue: SandcastleIssue,
  base: string,
  host: PassHost = livePassHost,
): Promise<PassOutcome> {
  const log = (line: string) => host.log(`  PR #${target.number} ${line}`);
  const skip = (reason: string): PassOutcome => {
    log(`isn't given a follow-up pass this round: ${reason}.`);
    return { kind: "skipped", reason };
  };

  // Read before the claim, so a PR with nothing to do doesn't have its issue
  // labelled every round, and read again once the claim is held: another run
  // may have passed on the PR in between, so what it decides from must be
  // read while no other run can change it.
  const before = planPass(target, base, host, skip, false);
  if (!("forRole" in before)) return before;

  // Claimed as a build claims it, so two runs never pass on one PR or share
  // its worktree, and a build of the same issue stands aside meanwhile.
  if (!host.markBuilding(issue.number)) return skip(`another run marked #${issue.number} ${BUILDING_LABEL}`);
  try {
    const plan = planPass(target, base, host, skip, true);
    if (!("forRole" in plan)) return plan;
    return await passOnMarkedIssue(target, issue, base, host, plan);
  } finally {
    try {
      host.unmarkBuilding(issue.number);
    } catch (error) {
      console.error(`  ⚠ #${issue.number}: removing ${BUILDING_LABEL} failed, so it's tried again when this run exits: ${error}`);
    }
  }
}

// What runPass decides from: the PR's head, threads and checks, and its pass
// count, read from GitHub. Returns the plan for a pass, or the outcome when
// there's to be none: skipped (the head moved since the sweep read it, an
// author's ownership is unknown, or there's nothing a pass handles) or handed
// back (the PR has had FOLLOW_UP_PASS_CAP passes). Only a read made while the
// claim is held (`claimed`) checks the cap: one before it may be stale, so
// the hand-back is left to the read after the claim.
// Records each thread left for a person.
function planPass(
  target: PassTarget,
  base: string,
  host: PassHost,
  skip: (reason: string) => PassOutcome,
  claimed: boolean,
): PassPlan | PassOutcome {
  const { headRefOid, threads } = host.reviewThreads(target.number);
  if (headRefOid !== target.headRefOid) return skip("its head moved since the sweep read it");
  const sorted = threadsForRole(threads, host.isOwner, host.hostLogin());
  if (sorted.unknown.length > 0) return skip("couldn't check whether a review thread's author is the repository owner");
  for (const thread of sorted.leftForHuman) {
    const first = thread.comments[0];
    host.recordHumanThread({ pr: target.number, author: first?.author ?? null, url: first?.url ?? "" });
  }
  // Read fresh, since a re-run may have started or finished since the sweep.
  // While any check is still running the PR isn't settled, so its red checks
  // wait for a later sweep rather than being re-run or fixed from half a
  // result. A red check with no Actions run behind it (such as code
  // scanning's own "CodeQL" result, lib/github.mts's HeadCheck) is left out
  // of redChecks entirely: no pass can re-run, forward or gate-fix a failure
  // with nothing behind it to act on, and sending it to the follow-up role
  // anyway would only start a run with no log to fix from, over and over
  // every sweep (#79). A thread about the same alert, if the owner or a bot
  // opens one, still reaches the role as a bot or owner thread.
  const checksRead = host.checks(target.number);
  if (checksRead.headRefOid !== target.headRefOid) return skip("its checks were read from a commit other than its head");
  const checks = checksRead.checks;
  const redChecks = checks.some((check) => !check.completed) ? [] : checks.filter((check) => !check.green && check.runId !== undefined);
  // Only a needed merge, a bot thread or a red check starts a pass. One with
  // only owner threads keeps the sweep's rule that human threads alone don't
  // start a pass, so an owner thread is answered only alongside one of the
  // others. A merge is needed when the PR conflicts with main, or, since
  // `pull_request` CI builds the head merged with main, when a settled red
  // check sits on a head that's merely behind it: gating the bare head would
  // then judge a commit CI never built, possibly misreading a real failure
  // main's own change caused as one the gate doesn't reproduce (#79). A head
  // that's behind with no red check is left for the sweep's update-branch
  // instead, so a clean PR doesn't spend a counted pass merging every time
  // main moves.
  const needsMerge = !host.contains(target.headRefOid, base) && (target.conflicted || redChecks.length > 0);
  if (!needsMerge && redChecks.length === 0 && !sorted.forRole.some((thread) => thread.from === "bot")) {
    return skip("there's nothing a follow-up pass handles yet");
  }

  const passCount = host.passCount(target.number);
  if (claimed && passCount >= FOLLOW_UP_PASS_CAP) {
    return giveUp(
      target,
      host,
      `it has had ${FOLLOW_UP_PASS_CAP} follow-up passes already and still needs another (${target.reasons.join("; ")})`,
      undefined,
    );
  }
  return { forRole: sorted.forRole, leftForHuman: sorted.leftForHuman.length, needsMerge, redChecks, passCount };
}

// Hands the PR back with sandcastle:needs-human (see giveUpComment), quoting
// `output` once it's safe to post. `privateDetail`, when given, is added to
// the reason in the run log and the run report but left out of the PR comment,
// for what's fine for the run's own records but not for the public PR, such as
// where the secret scan matched (#324). A hand-back that fails is logged: the
// next round's sweep finds the PR again.
function giveUp(target: PassTarget, host: PassHost, reason: string, output: string | undefined, privateDetail?: string): PassOutcome {
  const recorded = privateDetail === undefined ? reason : `${reason} (${privateDetail})`;
  host.log(`  ✋ PR #${target.number}: ${recorded}, so it's handed back.`);
  try {
    host.handBack(target.number, recorded, giveUpComment(reason, output === undefined ? undefined : host.publicError(output)));
  } catch (error) {
    console.error(`  ⚠ PR #${target.number}: handing it back failed, so the next round tries again: ${error}`);
  }
  return { kind: "gave-up", reason: recorded };
}

// What planPass decided, read again once the issue was marked: the threads
// for the role, how many were left for a person, whether main needs merging
// in, the PR's red checks (empty while any check is still running), and how
// many passes the PR has already had.
type PassPlan = {
  forRole: PromptThread[];
  leftForHuman: number;
  needsMerge: boolean;
  redChecks: CheckState[];
  passCount: number;
};

// runPass's work once the issue is marked: everything from creating the
// sandbox to closing it.
async function passOnMarkedIssue(
  target: PassTarget,
  issue: SandcastleIssue,
  base: string,
  host: PassHost,
  { forRole, leftForHuman, needsMerge, redChecks, passCount }: PassPlan,
): Promise<PassOutcome> {
  const branch = target.headRefName;
  const log = (line: string) => host.log(`  PR #${target.number} ${line}`);
  const stop = (reason: string, output?: string, privateDetail?: string) => giveUp(target, host, reason, output, privateDetail);
  let sandbox: sandcastle.Sandbox;
  try {
    sandbox = await host.createSandbox(branch);
  } catch (error) {
    // Such as a leftover worktree that no longer points at this repository:
    // it fails the same way every round, so it goes to a person.
    return stop("creating the sandbox failed", String(error));
  }
  try {
    // GitHub's head is the PR's state: a reused worktree can hold a stopped
    // pass's unpushed commits, a half-done merge or an earlier verdicts file.
    const reset = await sandbox.exec(`git reset --hard ${shellWord(target.headRefOid)} && git clean -fd`);
    if (reset.exitCode !== 0) return stop("resetting the worktree to the PR's head failed", `${reset.stdout}\n${reset.stderr}`);
    await sandbox.exec(`rm -f ${VERDICTS_FILE}`);
    const head = await sandbox.exec("git rev-parse HEAD");
    if (head.stdout.trim() !== target.headRefOid) return stop("the worktree isn't at the PR's head after resetting it to it");

    // Merged, never rebased: the push that follows is a plain one, so the
    // PR's history stays as reviewers saw it.
    let merged: PassReport["merged"] = "none";
    let hostMerge: string | undefined;
    let mergeNote = "No merge with main is needed in this pass, so there's no merge to finish.";
    // Attempts the merge `needsMerge` calls for. `merged` is "none" with
    // `failure` set when it fails for a reason other than a conflict.
    const tryMerge = async (): Promise<{ merged: PassReport["merged"]; hostMerge: string | undefined; mergeNote: string; failure?: string }> => {
      const merge = await sandbox.exec(`git merge --no-edit -m ${shellWord(`Merge main into ${branch}`)} ${shellWord(base)}`);
      if (merge.exitCode === 0) {
        return {
          merged: "clean",
          hostMerge: (await sandbox.exec("git rev-parse HEAD")).stdout.trim(),
          mergeNote: "The host merged main into the branch cleanly, so there's no merge to finish.",
        };
      }
      const conflicted = await sandbox.exec("git diff --name-only --diff-filter=U");
      const files = conflicted.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      // No conflicted file means the merge failed for some other reason.
      if (conflicted.exitCode !== 0 || files.length === 0) {
        return { merged: "none", hostMerge: undefined, mergeNote: "", failure: `${merge.stdout}\n${merge.stderr}` };
      }
      return {
        merged: "conflicts",
        hostMerge: undefined,
        mergeNote:
          `The host's merge of main into the branch conflicted in: ${files.join(", ")}. Resolve every conflict, then ` +
          "finish the merge with `git commit --no-edit`.",
      };
    };
    // A merge main can bring in cleanly happens before the gate decides red
    // CI, since `pull_request` CI builds the head merged with main: gating
    // the bare head first would then judge a commit CI never built (#79).
    // GitHub already says this PR isn't conflicted, so the merge is expected
    // to be clean; `tryMerge` falls back to the conflict path if it isn't. A
    // conflicted PR can't be merged without the role, so its gate still runs
    // on the bare head, as it always has, and the merge happens after.
    let mergeFirst = needsMerge && !target.conflicted;
    if (mergeFirst) {
      const attempt = await tryMerge();
      if (attempt.failure !== undefined) return stop("merging main into the branch failed", attempt.failure);
      if (attempt.merged === "conflicts") {
        // GitHub's mergeability can be stale by the time this pass fetches
        // main: the conflict is real, but the worktree it leaves behind is
        // mid-merge, with conflict markers and no commit at all. Gating that
        // tree would judge nonsense (#259), so abort back to the bare head
        // and fall through to the conflicted-PR order below: gate the head,
        // then merge after, leaving the conflict for the follow-up role.
        const abort = await sandbox.exec("git merge --abort");
        if (abort.exitCode !== 0) return stop("aborting the conflicted merge failed", `${abort.stdout}\n${abort.stderr}`);
        mergeFirst = false;
      } else {
        ({ merged, hostMerge, mergeNote } = attempt);
      }
    }

    // Red CI is decided by the gate (see planRedCi), run on the commit CI
    // checked: already merged with main above when `mergeFirst` is why the
    // PR had a red check to begin with.
    let headGate: GateRun | undefined;
    let redCi: RedCiPlan = { fix: false, rerun: [], forward: [] };
    if (redChecks.length > 0) {
      headGate = await runGate(sandbox);
      redCi = planRedCi(headGate.passed, redChecks);
      log(`has ${redChecks.length} red check(s), and \`scripts/gate.sh\` ${headGate.passed ? "passes" : "fails"} on its head`);
    }
    let ciLog: string | undefined;
    if (redCi.forward.length > 0) {
      try {
        ciLog = host.failedCheckLog(target.number, redCi.forward, target.headRefOid, CI_LOG_LIMIT);
      } catch (error) {
        // Nothing has run or pushed yet, so there's nothing of this pass's to
        // lose by giving up here (#79): a GitHub API error, a rate limit, or
        // the PR's head having moved since redChecks was read.
        return stop(`reading the failed-job log of ${checkList(redCi.forward)} failed`, String(error));
      }
    }

    if (needsMerge && !mergeFirst) {
      const attempt = await tryMerge();
      if (attempt.failure !== undefined) return stop("merging main into the branch failed", attempt.failure);
      ({ merged, hostMerge, mergeNote } = attempt);
    }

    // With no conflict to resolve, no thread to answer and no failed-job log
    // to fix from, the role has nothing to do, and a run of it would only
    // cost usage or make changes nobody asked for.
    let verdicts: ThreadVerdict[] = [];
    const roleRuns = merged === "conflicts" || forRole.length > 0 || ciLog !== undefined;
    if (roleRuns) {
      const role = await followUpVerdicts(sandbox, issue, target, forRole, mergeNote, ciLog, host, stop);
      if (!Array.isArray(role)) return role;
      verdicts = role;
      log("follow-up finished");
    }

    // The gate on the head is the checkpoint's first run when nothing has
    // changed the worktree since: running it again on the same commit would
    // only cost time, and a red one goes straight to the gate-fixer. That
    // holds when no merge happened at all, and when `mergeFirst`'s merge
    // happened before headGate ran, so headGate already reflects it; a
    // conflicted merge after headGate means the tree changed since, and
    // `roleRuns` being true then (it's one of its conditions) already keeps
    // this from reusing a gate run from before that.
    let unchangedGate = (merged === "none" || mergeFirst) && !roleRuns ? headGate : undefined;

    const gate = await runCheckpoint(
      2,
      {
        gate: async () => {
          const known = unchangedGate;
          unchangedGate = undefined;
          return known ?? (await runGate(sandbox));
        },
        fix: (at, gateOutput) =>
          runRoleInSandbox(
            sandbox,
            "gate-fixer",
            { promptFile: "./.sandcastle/roles/gate-fixer.md", promptArgs: gateFixerPromptArgs(issue, branch, at, gateOutput) },
            host.limits,
          ),
        uncounted: (error) => error instanceof UncountedStopError,
      },
      log,
    );
    // An unresolved conflict ends here too: it leaves the worktree dirty.
    // lib/checkpoint.mts#runGate reports a dirty worktree, or a HEAD that
    // moved or can't be read, as a gate that didn't pass, so the reason names
    // each and the quoted output says which.
    if (!gate.passed || gate.head === undefined) {
      return stop(
        `\`scripts/gate.sh\` didn't pass on a known, clean commit after ${GATE_FIXER_ATTEMPTS} gate-fixer attempts: it's ` +
          "red, the worktree isn't clean, or HEAD moved while it ran",
        gate.output,
      );
    }
    const gated = gate.head;
    if (!(await sandboxContains(sandbox, gated, target.headRefOid))) {
      return stop("the gated commit doesn't contain the PR's head, so the PR's history was rewritten");
    }
    if (needsMerge && !(await sandboxContains(sandbox, gated, base))) {
      return stop("the gated commit doesn't contain main, so the merge with main was abandoned");
    }

    let pushed: string | undefined;
    if (gated !== target.headRefOid) {
      // The push is public, and the sandbox holds the Claude token or API
      // key. The comment doesn't say where the secret is: the PR is public too.
      // The log and the run report do (#324), since the location names no
      // part of the secret, and the runner is the only holder of the commit.
      const leak = host.leaksSecret(base, gated);
      if (leak !== undefined) {
        return stop(
          "a commit holds one of the sandbox's secrets, or something shaped like a Claude or GitHub token, so nothing " +
            "was pushed. Find it before anything pushes the branch, and rotate the secret if it has left the machine",
          undefined,
          describeSecretMatch(leak),
        );
      }
      try {
        await host.push(branch, gated);
        pushed = gated;
      } catch (error) {
        // Sandcastle's token can't push a .github/workflows/** change, such
        // as one main's merge brought in, so a retry would only fail again.
        if (isWorkflowPushRejection(error)) {
          return stop(
            "GitHub refused the push because it changes a workflow file, which Sandcastle's token can't push. A person " +
              "has to bring main's workflow change into the branch",
            String(error),
          );
        }
        // Only a race is worth another round: the next sweep reads the new
        // head and tries again, uncounted. With the head unmoved the same push
        // fails again (branch protection, a token without push rights), and
        // with no summary posted the cap would never stop the PR being passed
        // on every round, so it's handed back.
        let remote: string | undefined;
        try {
          remote = host.remoteHead(branch);
        } catch {
          remote = undefined;
        }
        // A retried push can land and still end in a server error.
        if (remote === gated) {
          log(`pushed ${gated}, although the push reported an error: ${error}`);
        } else if (remote === target.headRefOid) {
          return stop("GitHub refused the push, and the PR's head hasn't moved, so pushing again would fail the same way", String(error));
        } else {
          log(`couldn't push ${gated}, since the PR's head moved, so no reply or summary is posted and the next round tries again: ${error}`);
          return { kind: "push-failed", error: host.publicError(error) };
        }
        pushed = gated;
      }
    }

    // Replied to and resolved before the red-CI re-run is decided, so a
    // give-up below for a check still red after its re-run never throws the
    // role's verdicts away unanswered (#79): the push, if any, has already
    // landed, so there's nothing left to lose by answering threads first.
    const matched = threadActions(verdicts, forRole);
    const { kept: actions, unverified } = await fixesInPush(sandbox, matched.actions, { gated, head: target.headRefOid, base, hostMerge });
    if (unverified.length > 0) log(`left ${unverified.length} "fixed" verdict(s) unanswered: their commit isn't one this pass added`);
    const { ignored } = matched;
    const failedWrites = answerThreads(actions, host, log);

    // A push starts CI afresh on the new head, which is as good as a re-run,
    // so only a head the pass left as it was gets its flaky checks re-run.
    let rerun: string[] = [];
    if (redCi.rerun.length > 0 && pushed !== undefined) {
      log(`didn't re-run ${redCi.rerun.join(", ")}: the push starts CI again on the new head`);
    } else if (redCi.rerun.length > 0) {
      let stillRed: string[];
      try {
        stillRed = stillRedAfterRerun(target.number, redCi.rerun, host, target.headRefOid);
      } catch (error) {
        return stop(`re-running the failed jobs of ${checkList(redCi.rerun)} failed`, String(error));
      }
      if (stillRed.length > 0) {
        return stop(
          `\`scripts/gate.sh\` passes on the head, but ${checkList(stillRed)} stayed red after its one re-run as flaky`,
          rerunLog(target.number, stillRed, host, log, target.headRefOid),
        );
      }
      rerun = redCi.rerun;
      log(`re-ran the failed jobs of ${rerun.join(", ")} once as flaky`);
    }

    // The role ran only to read `ciLog` (no thread to answer, no conflict to
    // resolve), so pushing nothing means it couldn't act on the forwarded
    // check either: nothing re-runs a forwarded check the way a push or
    // `gh run rerun --failed` does, so the next sweep would only find the
    // same red check and run the role the same way again, over and over
    // until FOLLOW_UP_PASS_CAP (#79). Giving up now, rather than reporting
    // "passed", stops that at once instead of after two wasted repeats.
    if (ciLog !== undefined && forRole.length === 0 && merged !== "conflicts" && pushed === undefined) {
      return stop(`the follow-up role committed nothing for the forwarded failed-job log of ${checkList(redCi.forward)}`);
    }

    try {
      host.commentOnPullRequest(
        target.number,
        passSummaryComment(
          {
            pass: passCount + 1,
            pushed,
            merged,
            actions,
            ignored,
            unverified,
            failedWrites,
            leftForHuman,
            redCi: { ...redCi, rerun },
          },
          (text) => host.publicError(text),
        ),
      );
    } catch (error) {
      log(`posting the pass summary failed, so this pass isn't counted: ${error}`);
    }
    log(`had follow-up pass ${passCount + 1} of ${FOLLOW_UP_PASS_CAP}${pushed === undefined ? ", with nothing to push" : `, pushing ${pushed}`}.`);
    return { kind: "passed", pushed };
  } finally {
    // Sandcastle's close() runs git in the worktree; leave one that no longer
    // points at this repository, with its sandbox, for a person to look at.
    const problems = host.worktreeProblems(sandbox.worktreePath);
    if (problems.length > 0) {
      console.error(`  ✗ PR #${target.number}: left ${sandbox.worktreePath} and its sandbox in place: ${problems.join("; ")}`);
      try {
        host.commentOnPullRequest(
          target.number,
          `Sandcastle stopped: the worktree for \`${branch}\` no longer points at this repository, so it was left for a ` +
            "person to look at. Don't run git in it.",
        );
      } catch (error) {
        console.error(`  ⚠ PR #${target.number}: commenting on the tampered worktree failed: ${error}`);
      }
    } else {
      await sandbox.close();
    }
  }
}

// Replies to each of `actions`' threads and resolves the bot threads among
// them, carrying on past a write that fails. Returns the writes that failed,
// for the pass summary.
function answerThreads(actions: readonly ThreadAction[], host: PassHost, log: (line: string) => void): string[] {
  const failedWrites: string[] = [];
  for (const action of actions) {
    const id = action.thread.threadId;
    try {
      host.replyToThread(id, replyBody(action, (text) => host.publicError(text)));
    } catch (error) {
      log(`replying on thread ${id} failed: ${error}`);
      failedWrites.push(`the reply on thread ${id}`);
      // A thread isn't resolved without the reply that says why.
      continue;
    }
    if (action.resolve === undefined) continue;
    try {
      host.resolveThread(id);
    } catch (error) {
      log(`resolving thread ${id} failed: ${error}`);
      failedWrites.push(`resolving thread ${id}`);
    }
  }
  return failedWrites;
}

// main.mts's pass phase: fetches every target's branch serially first (a
// failed fetch skips that PR for the round, as prepareBranches'
// lib/branches.mts#fetchMain-style fetches do), then runs runPass for each
// PR whose issue is in `issues` with Promise.allSettled, logging each
// outcome. A rejection is logged and the PR is swept again next round. Once
// every pass has settled, the first UncountedStopError among them (a usage
// or time-budget stop from the follow-up role or the gate-fixer) is
// rethrown, so main.mts's catch ends the run cleanly rather than the round
// carrying on as if nothing had stopped it. Each settled pass reaches
// `report` first (passOutcomeEntry, or "stopped" for a stop), so a stop
// doesn't lose the round's rows. Returns one outcome per target, in order; a
// PR that wasn't passed on is "skipped".
export async function followUpPassPhase(
  targets: readonly PassTarget[],
  issues: readonly SandcastleIssue[],
  base: string,
  host: PassHost = livePassHost,
  report: OutcomeReport = outcomeReport,
): Promise<PassOutcome[]> {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const outcomes: PassOutcome[] = targets.map(() => ({ kind: "skipped", reason: "not started" }));
  const started: { index: number; issue: SandcastleIssue }[] = [];
  // Serially, because concurrent fetches contend on the same ref lock.
  for (const [index, target] of targets.entries()) {
    const issue = byNumber.get(target.issueNumber);
    if (issue === undefined) {
      outcomes[index] = { kind: "skipped", reason: `#${target.issueNumber} isn't in this round's queue` };
      continue;
    }
    try {
      host.fetchBranch(target.headRefName);
    } catch (error) {
      host.log(`  ⚠ PR #${target.number}: fetching ${target.headRefName} failed, so it's passed on next round: ${error}`);
      outcomes[index] = { kind: "skipped", reason: `fetching ${target.headRefName} failed` };
      continue;
    }
    started.push({ index, issue });
  }

  const settled = await Promise.allSettled(started.map(({ index, issue }) => runPass(targets[index]!, issue, base, host)));
  let stop: UncountedStopError | undefined;
  for (const [position, result] of settled.entries()) {
    const { index } = started[position]!;
    const target = targets[index]!;
    if (result.status === "fulfilled") {
      outcomes[index] = result.value;
      const entry = passOutcomeEntry(target, result.value);
      if (entry !== undefined) report.record(entry);
      continue;
    }
    const pr = { kind: "pr", number: target.number } as const;
    if (result.reason instanceof UncountedStopError) {
      stop ??= result.reason;
      host.log(`  ⏹ PR #${target.number}: the follow-up pass stopped uncounted: ${result.reason.message}`);
      report.record({ ...pr, outcome: "stopped", detail: result.reason.message });
    } else {
      host.log(`  ✗ PR #${target.number}: the follow-up pass failed, so it's swept again next round: ${result.reason}`);
      report.record({ ...pr, outcome: "follow-up pass", detail: "the pass failed; see the run log" });
    }
    outcomes[index] = { kind: "skipped", reason: `the pass threw: ${result.reason}` };
  }
  if (stop !== undefined) throw stop;
  return outcomes;
}
