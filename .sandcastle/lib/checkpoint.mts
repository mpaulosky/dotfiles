// Gate checkpoints. The host runs scripts/gate.sh inside the sandbox after the
// last developer run (checkpoint 1) and just before publishing (checkpoint 2).
// The gate's exit code decides, never what an agent reports, and only while the
// branch leaves the gate script as main has it (see gateScriptChange): the
// gate-fixer's job is to make the exit code 0, and a script it can edit would
// let it do that by weakening the check. A red gate gets up
// to GATE_FIXER_ATTEMPTS gate-fixer runs, with the gate re-run after each; a
// fixer run that throws or times out still uses up its attempt.

import type { Sandbox } from "@ai-hero/sandcastle";
import { GATE_COMMENT_LINES, GATE_FIXER_ATTEMPTS } from "./config.mts";
import { GATE_COMMAND, GATE_SCRIPT } from "./repo-config.mts";

export type Checkpoint = 1 | 2;

// A gate run, and on a pass the commit it passed on: the one the host pushes.
export type GateRun = { passed: boolean; output: string; head?: string };

// What a checkpoint does in the sandbox; tests pass stubs.
export type CheckpointSteps = {
  gate(): Promise<GateRun>;
  fix(checkpoint: Checkpoint, gateOutput: string): Promise<unknown>;
  // Whether a fix's error ends the checkpoint at once, rethrown, rather than
  // using up an attempt: a usage-limit or time-budget stop (see
  // UncountedStopError in lib/errors.mts) would only stop every later fixer
  // run too, after another full gate run each.
  uncounted?(error: unknown): boolean;
};

// The gate prints in colour, which only gets in the way of a prompt or an
// issue comment. lib/follow-up-pass.mts's gate strips it too.
export const ansiEscape = /\u001b\[[0-9;]*[A-Za-z]/g;

// A full commit id, SHA-1 or SHA-256.
const commitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// The sandbox's HEAD commit, or undefined when it can't be read. Also how
// lib/follow-up-pass.mts's gate learns the commit it passed on.
export async function headOf(sandbox: Pick<Sandbox, "exec">): Promise<string | undefined> {
  const { stdout, exitCode } = await sandbox.exec("git rev-parse HEAD");
  const commit = stdout.trim();
  return exitCode === 0 && commitId.test(commit) ? commit : undefined;
}

// What a gate run vouches for: the branch's own changes. `base` is the commit
// the branch was cut from or, for a branch kept from an earlier round, this
// round's main: the host resolved it from GitHub, so its copy of every file is
// main's. `mergedMain` is the main commit a build merged in afterwards, which the
// caller passes only once GitHub has confirmed it is main (the ref in the shared
// .git is the agents' to move).
export type GateGuard = { base: string; mergedMain?: string };

const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Every git call here ignores replace refs, which agents can write: a
// `git replace` of `base` by a commit of their own would otherwise make the
// weakened script they hold read as main's.
const plainGit = "git --no-replace-objects --literal-pathspecs";

// The files under `paths` that `head` holds in a form that none of main's
// copies has, so the ones the branch changed, sorted; undefined when git can't
// say. The copies are those at `base`, at `mergedMain`, and at the merge base
// of `base` and `head`: the last is where a branch kept from an earlier round
// left main, and main's changes since aren't the branch's. All by content, not
// history: an edit that is later undone leaves no trace, a change made in a
// merge commit shows, and a deleted file counts.
export async function changedFiles(
  sandbox: Pick<Sandbox, "exec">,
  guard: GateGuard,
  paths: readonly string[],
  head = "HEAD",
): Promise<string[] | undefined> {
  const mergeBase = await sandbox.exec(`${plainGit} merge-base ${quoted(guard.base)} ${quoted(head)} 2>/dev/null`);
  const common = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || !commitId.test(common)) return undefined;
  let changed: Set<string> | undefined;
  for (const from of new Set([guard.base, ...(guard.mergedMain === undefined ? [] : [guard.mergedMain]), common])) {
    const { stdout, exitCode } = await sandbox.exec(
      `${plainGit} diff -z --no-renames --name-only ${quoted(from)} ${quoted(head)} -- ${paths.map(quoted).join(" ")} 2>/dev/null`,
    );
    if (exitCode !== 0) return undefined;
    const differing = stdout.split("\0").filter(Boolean);
    changed = changed === undefined ? new Set(differing) : new Set(differing.filter((file) => changed!.has(file)));
  }
  return [...(changed ?? [])].sort();
}

// Why the gate can't be trusted on this branch, or undefined when it can: the
// script it runs (GATE_SCRIPT) is written in the worktree, by the agents whose
// work it judges, so a branch that changes it leaves the exit code showing
// nothing. The old host ran main's copy to avoid this; a script run from the
// worktree can't be swapped for main's without breaking what it finds by its
// own path, so the gate refuses the branch until the script is back to what
// main has. A change to the gate itself is for a person to make. It fails
// closed: a GATE_SCRIPT that isn't a file at `base`, or a git that can't say,
// is refused rather than waved through.
export async function gateScriptChange(sandbox: Pick<Sandbox, "exec">, guard: GateGuard): Promise<string | undefined> {
  const tracked = await sandbox.exec(`${plainGit} cat-file -e ${quoted(`${guard.base}:${GATE_SCRIPT}`)} 2>&1`);
  if (tracked.exitCode !== 0) {
    return (
      `❌ ${GATE_SCRIPT} isn't a file at ${guard.base}, so it can't be shown that the branch leaves the gate alone. ` +
      "GATE_SCRIPT in lib/repo-config.mts must name the committed file GATE_COMMAND runs."
    );
  }
  const changed = await changedFiles(sandbox, guard, [GATE_SCRIPT]);
  if (changed === undefined) {
    return `❌ git diff failed, so it can't be shown that the branch leaves ${GATE_SCRIPT}, the gate itself, alone.`;
  }
  if (changed.length === 0) return undefined;
  return (
    `❌ The branch changes ${GATE_SCRIPT}, which is the gate itself, so a pass wouldn't show the work is sound. ` +
    `Restore it with \`git checkout ${guard.mergedMain ?? guard.base} -- ${GATE_SCRIPT}\` and commit. ` +
    "A change to the gate is for a person to make."
  );
}

// Run the gate with stderr folded into stdout, so the output keeps the order
// it was printed in. A passing gate over a dirty worktree still fails: the gate
// checks BASE..HEAD and publish() pushes only commits, so uncommitted edits
// would be gated but never pushed. So does one during which HEAD moved, or
// whose HEAD can't be read: the host pushes the commit the gate passed on, by
// its id, so that commit must be known. Given a `guard`, a branch whose gate
// script differs from main's fails without running it.
export async function runGate(sandbox: Pick<Sandbox, "exec">, guard?: GateGuard): Promise<GateRun> {
  if (guard !== undefined) {
    const changed = await gateScriptChange(sandbox, guard);
    if (changed !== undefined) return { passed: false, output: changed };
  }
  const before = await headOf(sandbox);
  const { stdout, exitCode } = await sandbox.exec(`${GATE_COMMAND} 2>&1`);
  const output = stdout.replace(ansiEscape, "");
  if (exitCode !== 0) return { passed: false, output };

  const status = await sandbox.exec("git status --porcelain 2>&1");
  if (status.exitCode !== 0) {
    return { passed: false, output: `${output}\n❌ git status failed, so the worktree can't be shown to be clean:\n${status.stdout}` };
  }
  if (status.stdout.trim()) {
    return {
      passed: false,
      output:
        `${output}\n❌ The gate passed, but the worktree has uncommitted changes. Commit them, or discard ` +
        `them if they don't belong, so the pushed branch is exactly what the gate checked:\n${status.stdout}`,
    };
  }
  const after = await headOf(sandbox);
  if (before === undefined || after !== before) {
    return {
      passed: false,
      output: `${output}\n❌ The gate passed, but HEAD ${before === undefined ? "couldn't be read" : "moved while it ran"}, so the commit it checked isn't known.`,
    };
  }
  return { passed: true, output, head: before };
}

// Run the gate, and the gate-fixer while it's red and attempts are left.
// Returns the last gate run.
export async function runCheckpoint(
  checkpoint: Checkpoint,
  steps: CheckpointSteps,
  log: (line: string) => void,
): Promise<GateRun> {
  const prefix = `checkpoint ${checkpoint}:`;
  let result = await steps.gate();
  log(`${prefix} gate ${result.passed ? "passed" : "failed"}`);

  for (let attempt = 1; !result.passed && attempt <= GATE_FIXER_ATTEMPTS; attempt++) {
    const label = `gate-fixer attempt ${attempt}/${GATE_FIXER_ATTEMPTS}`;
    try {
      await steps.fix(checkpoint, result.output);
    } catch (error) {
      if (steps.uncounted?.(error)) throw error;
      log(`${prefix} ${label} failed: ${error}`);
    }
    result = await steps.gate();
    log(`${prefix} gate ${result.passed ? "passed" : "failed"} after ${label}`);
  }

  return result;
}

// The last `lines` lines of the output.
export function tail(output: string, lines: number): string {
  return output.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
}

// The last `limit` characters of `text`, never starting halfway through a
// character: a CI log's error is at its end (lib/github.mts#failedCheckLogs,
// lib/follow-up-pass.mts's CI_LOG_LIMIT).
export function endOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = text.slice(-limit);
  return /^[\uDC00-\uDFFF]/.test(end) ? end.slice(1) : end;
}

// The issue comment for a checkpoint that stayed red past the fixer's attempts.
export function gateFailureComment(checkpoint: Checkpoint, branch: string, output: string): string {
  return [
    `Sandcastle stopped building this issue: \`${GATE_COMMAND}\` is still red at checkpoint ${checkpoint} ` +
      `after ${GATE_FIXER_ATTEMPTS} gate-fixer attempts, so \`${branch}\` wasn't pushed. The branch keeps its commits.`,
    "",
    `The last ${GATE_COMMENT_LINES} lines of the gate output:`,
    "",
    textBlock(tail(output, GATE_COMMENT_LINES)),
  ].join("\n");
}

// `text` in a fenced text block longer than any backtick run in it, so it
// renders as written and nothing in it can mention anyone or cross-reference
// an issue.
export function textBlock(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}text`, text, fence].join("\n");
}
