// Gate checkpoints. The host runs scripts/gate.sh inside the sandbox after the
// last developer run (checkpoint 1) and just before the host-side review (checkpoint 2); after each review round that fixes
// something it runs again (checkpoint 3), and the commit the last one passed on is published.
// The gate's exit code decides, never what an agent reports, and only while the
// branch leaves the gate script as main has it (see gateScriptChange): the
// gate-fixer's job is to make the exit code 0, and a script it can edit would
// let it do that by weakening the check. A red gate gets up
// to GATE_FIXER_ATTEMPTS gate-fixer runs, with the gate re-run after each; a
// fixer run that throws or times out still uses up its attempt.

import type { Sandbox } from "@ai-hero/sandcastle";
import { GATE_COMMENT_LINES, GATE_FIXER_ATTEMPTS } from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import { GATE_COMMAND, GATE_SCRIPT } from "./repo-config.mts";

export type Checkpoint = 1 | 2 | 3;

// A gate run, and on a pass the commit it passed on: the one the host pushes.
// `firstOutput` is the output of the checkpoint's first red gate run, kept when
// the checkpoint ended red after a fixer had run and that output differs from
// the last run's (see sameGateOutput for what counts as the same), since the last
// run's output may be about something else (a dead sandbox, a different failure).
// `fixersRun` is how many gate-fixer attempts ran, set only when the checkpoint
// ended early because the sandbox was down.
export type GateRun = { passed: boolean; output: string; head?: string; firstOutput?: string; fixersRun?: number };

// Whether two gate outputs are the same failure. A gate may end its step headers with the seconds since it started (dotfiles'
// scripts/gate.sh and the test.sh it runs print ` [+312s]`), which differ on every run, so a ` [+Ns]` that ends a line is left out of
// the comparison: a gate-fixer that changed nothing leaves the first red run the same as the last, and the failure comment
// quotes it once.
const STEP_SECONDS = / \[\+\d+s\]$/gm;
export function sameGateOutput(a: string, b: string): boolean {
  return a.replace(STEP_SECONDS, "") === b.replace(STEP_SECONDS, "");
}

// What a checkpoint does in the sandbox; tests pass stubs.
export type CheckpointSteps = {
  gate(): Promise<GateRun>;
  fix(checkpoint: Checkpoint, gateOutput: string): Promise<unknown>;
  // Whether a fix's error ends the checkpoint at once, rethrown, rather than
  // using up an attempt: a usage-limit or time-budget stop (see
  // UncountedStopError in lib/errors.mts) would only stop every later fixer
  // run too, after another full gate run each.
  uncounted?(error: unknown): boolean;
  // Why the sandbox can't run a fixer, or undefined when it answers. Asked
  // before every fixer attempt: a fixer run into a dead sandbox only fails on
  // its first command and costs a whole attempt (a run's second gate-fixer died
  // on `git config`, exit 128, and every git call after it did too: see
  // mpaulosky/dotfiles#417). Any error it throws ends the checkpoint and is
  // rethrown unchanged, in particular an UncountedStopError for a stalled
  // sandbox, so the run ends on the stall instead of recording a failed attempt.
  alive?(): Promise<string | undefined>;
  // Makes the first red run's output safe to log. When the checkpoint ends on
  // an error rather than a result (a stall, a usage limit, a gate run that
  // throws), that output has no other way out, so runCheckpoint logs its tail
  // through this before rethrowing. Without it nothing is logged, since the
  // output is written by agents and may hold a secret. A scrub that throws, or a
  // log that does, doesn't replace the error that ended the checkpoint, and a
  // line says the output couldn't be logged.
  scrub?(text: string): string;
  // Makes one line of text, such as an error's message, safe to log: the same job
  // as `scrub` for text that has to stay a single line, since `scrub` may return
  // several. runCheckpoint logs a failed gate-fixer attempt's error through it. A
  // caller without one still gets that line cleaned (printableLine), but with
  // any secret in it left in. Like printableLine's `scrub`, it must withhold
  // the whole text when it finds a secret, not replace only the match.
  scrubLine?(text: string): string;
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
    const output = `${tracked.stdout}${tracked.stderr}`.trim();
    // Git says a missing path with exit 1 and no output, or exit 128 and "path ... does not exist in ..." (or "exists on disk, but not in ...").
    // This reads git's English wording: under a translated locale a missing script falls to the git-failed message below, which still refuses.
    const missing = (tracked.exitCode === 1 && output === "") || (tracked.exitCode === 128 && /^fatal: path .* (does not exist in|exists on disk, but not in) /.test(output));
    if (missing) {
      return (
        `❌ ${GATE_SCRIPT} isn't a file at ${guard.base}, so it can't be shown that the branch leaves the gate alone. ` +
        "GATE_SCRIPT in lib/repo-config.mts must name the committed file GATE_COMMAND runs."
      );
    }
    // Any other failure is git itself (a broken sandbox, a bad object database), not a verdict on GATE_SCRIPT.
    // The first line git printed that has text left, as printable ASCII only and capped. It goes into a comment and a prompt, and the branch's agent may
    // control what git prints, so anything that can hide or reorder text (control, format, combining, private-use and non-ASCII space characters)
    // is replaced by an allow-list, and the cap can't cut a surrogate pair.
    const clean = (line: string) => line.replace(/[^\x20-\x7e]/g, " ").slice(0, 200).trim();
    const firstLine = output.split("\n").map(clean).find((line) => line !== "") ?? "(no output)";
    return (
      `❌ git failed (exit ${tracked.exitCode}: ${firstLine}) checking ${GATE_SCRIPT} at ${guard.base}, so it can't be shown that the branch leaves the gate alone. ` +
      "The sandbox or its git may be broken, or git's output may not be in English."
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
// Returns the last gate run. It carries the first red run's output
// (`firstOutput`) when the checkpoint ended red after a fixer ran and it differs
// from the last run's output (see sameGateOutput). When `alive` reports the sandbox down, the
// checkpoint ends before that attempt's fixer, with the reason appended to the
// output and `fixersRun` set to the attempts that ran. A caller that passes no
// `alive` never gets `fixersRun` or that early end, but still gets
// `firstOutput`. An `alive` that throws an UncountedStopError ends the
// checkpoint with it. Any error that ends it is rethrown unchanged. When the
// steps have a `scrub`, the first red run's output is logged through it first;
// a scrub or a log that throws is ignored, and a line says so.
export async function runCheckpoint(
  checkpoint: Checkpoint,
  steps: CheckpointSteps,
  log: (line: string) => void,
): Promise<GateRun> {
  const prefix = `checkpoint ${checkpoint}:`;
  let result = await steps.gate();
  log(`${prefix} gate ${result.passed ? "passed" : "failed"}`);

  const firstOutput = result.output;
  try {
    for (let attempt = 1; !result.passed && attempt <= GATE_FIXER_ATTEMPTS; attempt++) {
      const label = `gate-fixer attempt ${attempt}/${GATE_FIXER_ATTEMPTS}`;
      const down = await steps.alive?.();
      if (down !== undefined) {
        log(`${prefix} ${label} not run: ${down}`);
        return { ...result, output: `${result.output.replace(/\n$/, "")}\n❌ ${down}`, fixersRun: attempt - 1, ...(attempt > 1 && !sameGateOutput(firstOutput, result.output) ? { firstOutput } : {}) };
      }
      try {
        await steps.fix(checkpoint, result.output);
      } catch (error) {
        if (steps.uncounted?.(error)) throw error;
        log(`${prefix} ${label} failed: ${printableLine(error, steps.scrubLine)}`);
      }
      result = await steps.gate();
      log(`${prefix} gate ${result.passed ? "passed" : "failed"} after ${label}`);
    }
  } catch (error) {
    // An error that ends the checkpoint (a stall, a usage limit, a gate run that throws) never reaches the failure comment, so the first
    // red run's output would be lost with it: log its scrubbed tail first. The error itself goes on unchanged.
    if (steps.scrub !== undefined) {
      try {
        log(`${prefix} the first red gate run's output, before this stopped the checkpoint:\n${tail(steps.scrub(firstOutput), GATE_COMMENT_LINES)}`);
      } catch {
        // Only a diagnostic: a scrub or a log that throws must not replace the error that ended the checkpoint. A line says the output is
        // missing, so a broken scrub isn't read as a checkpoint that never saw a red run.
        try {
          log(`${prefix} the first red gate run couldn't be logged`);
        } catch {
          // Nothing more can be done with a log that throws.
        }
      }
    }
    throw error;
  }

  return result.passed || sameGateOutput(firstOutput, result.output) ? result : { ...result, firstOutput };
}

// `text` without the `##[` form of a GitHub Actions command. The runner can read
// that legacy form from anywhere in a log line, not only at its start
// (`##[add-mask]` would hide the lines after it), so it is changed to `## [`,
// which is not that form. The match is a literal one, so a caller removes hidden
// characters first (terminalText, or the ASCII filter in printableLine), or a
// `##` and a `[` could be rebuilt around them.
export function withoutRunnerCommands(text: string): string {
  return text.replaceAll("##[", "## [");
}

// `text` with colour codes removed, each run of line breaks and tabs folded to a space, and every other control, format (zero-width) and
// combining character deleted, not turned into a space: a deleted character can't split a secret into a shape a scrub misses. status.mts's
// terminalText does more, but it can't be imported here: status.mts imports this module, through the follow-up pass.
function withoutHiddenCharacters(text: string): string {
  return text.replace(ansiEscape, "").replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, " ").replace(/[\p{Cc}\p{Cf}\p{M}]/gu, "");
}

// `value` (an error, for one) as a single printable line for the host's log or a
// comment. The scrub runs on the text as it is first (a secret that holds a line
// break or a mark is withheld whole, if it is within the first `limit * 500`
// characters), then again after withoutHiddenCharacters and a cut to `limit * 20`
// characters (so a hidden character can't split a secret the scrub would match,
// padding can't push the rest of one past the cut, and an enormous message costs
// the scrub little), so a secret in it can't be cut into a shape the scrub no
// longer recognises. Then the text is reduced to printable ASCII (what is left of
// a non-ASCII character becomes a space, so the result is one line, and a caller
// puts it after a prefix of its own so it can't start one with `::`), changed by
// withoutRunnerCommands, cut to `limit` characters and trimmed. The guarantee holds
// for a `scrub` that withholds the whole text when it finds a secret, as the host's
// publicError does: one that replaces only the match leaves the rest of a secret a
// hidden character split, because the second pass works on the first's output.
// A value that can't be printed, a scrub that throws, or a result with nothing
// printable left gives a fixed text instead, so the caller's own error is never
// replaced by this one and the message never reads as an empty pair of brackets.
export function printableLine(value: unknown, scrub: (text: string) => string = (text) => text, limit = 200): string {
  let text: string;
  try {
    text = String(value);
  } catch {
    return "an error that can't be printed";
  }
  try {
    const first = scrub(text.slice(0, limit * 500));
    const base = first === text.slice(0, limit * 500) ? text : first;
    const safe = scrub(withoutHiddenCharacters(base).slice(0, limit * 20));
    return withoutRunnerCommands(safe.replace(/[^\x20-\x7e]/g, " ")).slice(0, limit).trim() || "(no printable text)";
  } catch {
    return "text that couldn't be made safe to log";
  }
}

// Why the sandbox can't run a fixer, or undefined when `git rev-parse HEAD`
// answers in it. A probe that throws counts as the sandbox being down, except a
// stall (an UncountedStopError): that ends the run, and recording it as a
// failed build attempt would hide it. The reason holds the error's text as
// printableLine makes it, with `scrub` applied first. The default scrub does
// nothing, so a caller that logs or posts the reason must pass one. The raw
// error text is never logged: only that reason is.
export async function sandboxDown(
  sandbox: Pick<Sandbox, "exec">,
  scrub: (text: string) => string = (text) => text,
): Promise<string | undefined> {
  try {
    if ((await headOf(sandbox)) !== undefined) return undefined;
    return "The sandbox no longer answers `git rev-parse HEAD`, so no gate-fixer was run.";
  } catch (error) {
    if (error instanceof UncountedStopError) throw error;
    return `The sandbox can't run a command (${printableLine(error, scrub)}), so no gate-fixer was run.`;
  }
}

// The last `lines` lines of the output.
export function tail(output: string, lines: number): string {
  return output.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
}

// The last `limit` characters of `text`, never starting halfway through a
// character: a CI log's error is at its end (lib/github.mts#failedCheckLogs,
// lib/follow-up-pass.mts's CI_LOG_LIMIT), and so is a gate run's (giveUpComment).
export function endOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = text.slice(-limit);
  return /^[\uDC00-\uDFFF]/.test(end) ? end.slice(1) : end;
}

// The issue comment for a checkpoint that stayed red past the fixer's attempts.
// `firstOutput` is the checkpoint's first red run, quoted too when it differs
// from the last (see sameGateOutput): a gate-fixer attempt can leave the last run showing a dead
// sandbox or a timeout, not the failure the build began with. `fixersRun` is
// how many attempts ran when that is fewer than GATE_FIXER_ATTEMPTS.
export function gateFailureComment(
  checkpoint: Checkpoint,
  branch: string,
  output: string,
  { firstOutput, fixersRun = GATE_FIXER_ATTEMPTS }: { firstOutput?: string; fixersRun?: number } = {},
): string {
  const first =
    firstOutput === undefined || sameGateOutput(firstOutput, output)
      ? []
      : ["", `The last ${GATE_COMMENT_LINES} lines of the first red gate run, before a gate-fixer ran:`, "", textBlock(tail(firstOutput, GATE_COMMENT_LINES))];
  return [
    `Sandcastle stopped building this issue: \`${GATE_COMMAND}\` is still red at checkpoint ${checkpoint} ` +
      `after ${fixersRun} gate-fixer ${fixersRun === 1 ? "attempt" : "attempts"}, so \`${branch}\` wasn't pushed. The branch keeps its commits.`,
    // The first run goes before the last: an over-long comment loses its start, and the last run is the one to keep.
    ...first,
    "",
    `The last ${GATE_COMMENT_LINES} lines of the ${first.length === 0 ? "gate output" : "last gate output"}:`,
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
