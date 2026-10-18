// Gate checkpoints. The host runs scripts/gate.sh inside the sandbox after the
// last developer run (checkpoint 1) and just before publishing (checkpoint 2).
// The gate's exit code decides, never what an agent reports. A red gate gets up
// to GATE_FIXER_ATTEMPTS gate-fixer runs, with the gate re-run after each; a
// fixer run that throws or times out still uses up its attempt.

import type { Sandbox } from "@ai-hero/sandcastle";
import { GATE_COMMENT_LINES, GATE_FIXER_ATTEMPTS } from "./config.mts";

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

// Run the gate with stderr folded into stdout, so the output keeps the order
// it was printed in. A passing gate over a dirty worktree still fails: the gate
// checks BASE..HEAD and publish() pushes only commits, so uncommitted edits
// would be gated but never pushed. So does one during which HEAD moved, or
// whose HEAD can't be read: the host pushes the commit the gate passed on, by
// its id, so that commit must be known.
export async function runGate(sandbox: Pick<Sandbox, "exec">): Promise<GateRun> {
  const before = await headOf(sandbox);
  const { stdout, exitCode } = await sandbox.exec("scripts/gate.sh 2>&1");
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
  const quoted = tail(output, GATE_COMMENT_LINES);
  const longestRun = Math.max(0, ...[...quoted.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [
    `Sandcastle stopped building this issue: \`scripts/gate.sh\` is still red at checkpoint ${checkpoint} ` +
      `after ${GATE_FIXER_ATTEMPTS} gate-fixer attempts, so \`${branch}\` wasn't pushed. The branch keeps its commits.`,
    "",
    `The last ${GATE_COMMENT_LINES} lines of the gate output:`,
    "",
    `${fence}text`,
    quoted,
    fence,
  ].join("\n");
}
