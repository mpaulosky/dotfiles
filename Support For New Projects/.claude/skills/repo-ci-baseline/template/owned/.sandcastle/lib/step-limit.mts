// A limit on each command the host runs in a sandbox. Sandcastle's `exec` has no timeout, and the
// time budget (lib/config.mts#DEFAULT_BUDGET_MINUTES) is only checked between iterations, so a gate
// or a git command that stalls would hold a run until the job's own cap. A stalled step is killed
// with coreutils `timeout` inside the container, so the process ends there and not just on the host,
// and its failure names the step. A real run once sat three hours with no log line after a role crashed.
// `timeout` signals its own process group, and `docker exec` returns only when its output pipe closes,
// so a daemon that outlives the kill could still hold the host: a timer on the host's side gives up on
// the call a little after the limit and the kill grace, and fails the step the same way.
import type { Sandbox } from "@ai-hero/sandcastle";
import { GATE_COMMAND, GATE_LIMIT_MINUTES } from "./repo-config.mts";
import { terminalText } from "./status.mts";

// How long any command other than the gate may run, in minutes. The gate's limit is per repo
// (lib/repo-config.mts#GATE_LIMIT_MINUTES). config.test.mts sizes BUILDING_LABEL_MAX_AGE_MS from both.
export const COMMAND_LIMIT_MINUTES = 10;

// Seconds `timeout` waits after TERM before it sends KILL.
export const KILL_GRACE_SECONDS = 30;

// Seconds the host waits past the limit and the kill grace before it gives up on a call that hasn't returned.
export const BACKSTOP_SLACK_SECONDS = 60;

// How many characters of a command name a step in the log.
const NAME_LENGTH = 60;

// `timeout` exits 124 when the command ran over, and 137 when it had to send KILL as well. A command can
// exit with either for its own reasons (an out-of-memory kill is 137), so a code counts only when the step
// also ran for about its limit.
const TIMED_OUT_EXIT_CODES = new Set([124, 137]);

// How much shorter than its limit a step may have run and still count as timed out, in milliseconds.
const CLOCK_SLACK_MS = 1000;

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

// A sandbox whose `exec` runs each command under its limit, logs when the step starts and ends, and answers a
// step that ran over (or that the host gave up on) with exit code 124 and the reason appended to its output, so
// every caller's existing "non-zero exit is a failure" handling fails closed. Every other member is the
// sandbox's own, bound to it.
export function limitSandboxExec(sandbox: Sandbox, options: StepLimitOptions = {}): Sandbox {
  const {
    log = console.log,
    prefix = "  ",
    now = Date.now,
    gateMinutes = GATE_LIMIT_MINUTES,
    commandMinutes = COMMAND_LIMIT_MINUTES,
    graceSeconds = KILL_GRACE_SECONDS,
    backstopSlackSeconds = BACKSTOP_SLACK_SECONDS,
  } = options;

  const exec: Sandbox["exec"] = async (command, execOptions) => {
    const name = stepName(command);
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
  return new Proxy(sandbox, {
    get: (target, property) => {
      if (property === "exec") return exec;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
