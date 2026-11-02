// A limit on each command the host runs in a sandbox. Sandcastle's `exec` has no timeout, and the
// time budget (lib/config.mts#DEFAULT_BUDGET_MINUTES) is only checked between iterations, so a gate
// or a git command that stalls would hold a run until the job's own cap. A stalled step is killed
// with coreutils `timeout` inside the container, so the process ends there and not just on the host,
// and its failure names the step. A real run once sat three hours with no log line after a role crashed.
// `timeout` signals its own process group, and `docker exec` returns only when its output pipe closes,
// so a daemon that outlives the kill could still hold the host: a timer on the host's side gives up on
// the call a little after the limit and the kill grace, and fails the step the same way.
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { GATE_COMMAND, GATE_LIMIT_MINUTES } from "./repo-config.mts";
import { terminalText } from "./status.mts";

// How long any command other than the gate may run, in minutes. The gate's limit is per repo
// (lib/repo-config.mts#GATE_LIMIT_MINUTES). config.test.mts sizes BUILDING_LABEL_MAX_AGE_MS from both.
export const COMMAND_LIMIT_MINUTES = 10;

// Seconds `timeout` waits after TERM before it sends KILL.
export const KILL_GRACE_SECONDS = 30;

// The most a timer can wait: setTimeout fires at once for a longer delay.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Seconds the host waits past the limit and the kill grace before it gives up on a call that hasn't returned.
export const BACKSTOP_SLACK_SECONDS = 60;

// How many code points of a command its step name keeps in the log.
const NAME_LENGTH = 60;

// `timeout` exits 124 when the command ran over, and 137 when it had to send KILL as well. A command can
// exit with either for its own reasons (an out-of-memory kill is 137), so a code counts only when the step
// also ran for about its limit.
const TIMED_OUT_EXIT_CODES = new Set([124, 137]);

// How much shorter than its limit a step may have run and still count as timed out, in milliseconds.
const CLOCK_SLACK_MS = 1000;

// A limit is a positive, finite number of minutes the host's timer can wait for: `timeout` treats 0 as no limit
// and exits at once on NaN or a negative, and setTimeout fires at once for a delay past MAX_TIMER_MS.
function checkedLimit(name: string, minutes: number, graceSeconds: number, backstopSlackSeconds: number): void {
  for (const [option, seconds] of [["graceSeconds", graceSeconds], ["backstopSlackSeconds", backstopSlackSeconds]] as const) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${option} must be a number of seconds, 0 or more, not ${seconds}`);
  }
  const waitMs = minutes * 60_000 + (graceSeconds + backstopSlackSeconds) * 1000;
  if (!Number.isFinite(minutes) || minutes <= 0 || waitMs > MAX_TIMER_MS) {
    throw new Error(`${name} must be a positive number of minutes the host can wait for, not ${minutes}`);
  }
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Whether the command is the gate: GATE_COMMAND on its own or followed by arguments or a redirection, not a
// longer file name that starts the same way.
function isGate(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === GATE_COMMAND || trimmed.startsWith(`${GATE_COMMAND} `);
}

// The step's name for the log and the failure: the gate, or the command's first words, cut by code point and
// cleaned for a terminal (a branch name in a `git merge -m` can carry what a log shouldn't).
export function stepName(command: string): string {
  if (isGate(command)) return "the gate";
  return terminalText(Array.from(command.replace(/\s+/g, " ").trim()).slice(0, NAME_LENGTH).join(""));
}

// The command run under `timeout`. `sh -c` keeps redirections such as `2>&1` inside the limit.
export function limitedCommand(command: string, minutes: number, graceSeconds: number = KILL_GRACE_SECONDS): string {
  return `timeout -k ${graceSeconds}s ${minutes}m sh -c ${shellWord(command)}`;
}

// What a test (or a repo with an unusual image) may change about the limits.
export type StepLimitOptions = {
  // Where the step lines go, and the text each starts with (the build's branch), so parallel builds can be told apart.
  log?: (line: string) => void;
  prefix?: string;
  now?: () => number;
  gateMinutes?: number;
  commandMinutes?: number;
  graceSeconds?: number;
  backstopSlackSeconds?: number;
};

// The step that stalled each limited sandbox, if one did (see stalledStepOf).
const stalledSteps = new WeakMap<object, string>();

// The name of the step that stalled this sandbox, when it came from limitSandboxExec and one did: a caller about to
// publish checks it, since a command whose failure it tolerates (a read of the PR body) may have been the one.
export function stalledStepOf(sandbox: object): string | undefined {
  return stalledSteps.get(sandbox);
}

// A sandbox whose `exec` runs each command under its limit, logs when the step starts and ends, and answers a
// step that ran over (or that the host gave up on) with exit code 124 and the reason appended to its output, so
// every caller's existing "non-zero exit is a failure" handling fails closed. Once a command other than the gate
// has run over, or the host has given up on one, every later exec throws StalledStepError. Every other member is
// the sandbox's own, bound to it.
export function limitSandboxExec(sandbox: Sandbox, options: StepLimitOptions = {}): Sandbox {
  const {
    log = console.log,
    prefix = "  ",
    now = () => performance.now(),
    gateMinutes = GATE_LIMIT_MINUTES,
    commandMinutes = COMMAND_LIMIT_MINUTES,
    graceSeconds = KILL_GRACE_SECONDS,
    backstopSlackSeconds = BACKSTOP_SLACK_SECONDS,
  } = options;
  checkedLimit("GATE_LIMIT_MINUTES", gateMinutes, graceSeconds, backstopSlackSeconds);
  checkedLimit("COMMAND_LIMIT_MINUTES", commandMinutes, graceSeconds, backstopSlackSeconds);

  // The first step that ran over its limit (a command other than the gate) or that the host gave up on. The gate's own
  // kill is clean: `timeout` ended it, and the next gate may run. After either of the others a command may still be
  // running in the container, holding git's locks, and a stalled sandbox would otherwise cost one limit per command, so
  // every later exec throws. It throws, not answers 124, because a caller reads a code as a git answer (`merge-base
  // --is-ancestor` 1 means no) or runs the gate-fixer on a gate that can't run again. That keeps the build's worst case
  // at one command limit (lib/config.test.mts).
  let stalledStep: string | undefined;
  const stall = (name: string): void => {
    stalledStep = name;
    stalledSteps.set(limited, name);
  };

  const exec: Sandbox["exec"] = async (command, execOptions) => {
    const name = stepName(command);
    if (stalledStep !== undefined) {
      log(`${prefix}step refused: ${name}, since the step "${stalledStep}" didn't end at its limit`);
      throw new StalledStepError(`The step "${name}" wasn't run: the step "${stalledStep}" didn't end at its limit, so this sandbox is stalled.`);
    }
    const minutes = isGate(command) ? gateMinutes : commandMinutes;
    const limitMs = minutes * 60_000;
    const started = now();
    log(`${prefix}step start: ${name} (limit ${minutes} minutes)`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<"gave up">((resolve) => {
      timer = setTimeout(() => resolve("gave up"), limitMs + (graceSeconds + backstopSlackSeconds) * 1000);
    });
    let result;
    try {
      const outcome = await Promise.race([sandbox.exec(limitedCommand(command, minutes, graceSeconds), execOptions), gaveUp]);
      if (outcome === "gave up") {
        stall(name);
        log(`${prefix}step gave up: ${name} didn't return after its ${minutes}-minute limit and the kill grace`);
        return {
          exitCode: 124,
          stdout: `❌ The step "${name}" didn't return within its ${minutes}-minute limit and the kill grace, so the host gave up on it.`,
          stderr: "",
        };
      }
      result = outcome;
    } finally {
      clearTimeout(timer);
    }

    const elapsed = now() - started;
    const seconds = Math.round(elapsed / 1000);
    if (TIMED_OUT_EXIT_CODES.has(result.exitCode) && elapsed >= limitMs - CLOCK_SLACK_MS) {
      if (!isGate(command)) stall(name);
      log(`${prefix}step killed: ${name} ran over its ${minutes}-minute limit after ${seconds}s`);
      return {
        ...result,
        exitCode: 124,
        stdout: `${result.stdout}\n❌ The step "${name}" ran over its ${minutes}-minute limit and was killed.`,
      };
    }
    log(`${prefix}step end: ${name} (exit ${result.exitCode}, ${seconds}s)`);
    return result;
  };

  // Functions are bound to the real sandbox, so one that uses `this` (or a private field) never sees the proxy.
  const limited: Sandbox = new Proxy(sandbox, {
    get: (target, property) => {
      if (property === "exec") return exec;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return limited;
}
