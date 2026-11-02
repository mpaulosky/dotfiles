// A limit on each command the host runs in a sandbox. Sandcastle's `exec` has no timeout, and the
// time budget (lib/config.mts#DEFAULT_BUDGET_MINUTES) is only checked between iterations, so a gate
// or a git command that stalls would hold a run until the job's own cap. A stalled step is killed
// with coreutils `timeout` inside the container, so the process ends there and not just on the host,
// and its failure names the step. A real run once sat three hours with no log line after a role crashed.
// `timeout` signals its own process group (and the wrapper kills what is left of it after a timeout, since `timeout`
// returns as soon as its command exits), and `docker exec` returns only when its output pipe closes,
// so a daemon that outlives the kill could still hold the host: a timer on the host's side gives up on
// the call a little after the limit and the kill grace, and stalls the step the same way.
//
// The gate's own overrun is a red gate (exit 124): `timeout` ended it cleanly, and the gate-fixer may try. Any
// other overrun, or a call the host gives up on (a role's sandbox run too, lib/agents.mts), throws StalledStepError, and so does every exec after it. A call the host gives up on is also
// recorded with markHostCallAbandoned (lib/host-limit.mts), so main.mts ends the process after its cleanup (exitAfterStall).
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { MAX_TIMER_MS, markHostCallAbandoned } from "./host-limit.mts";
import { GATE_COMMAND, GATE_LIMIT_MINUTES } from "./repo-config.mts";
import { terminalText } from "./status.mts";

// How long any command other than the gate may run, in minutes. The gate's limit is per repo
// (lib/repo-config.mts#GATE_LIMIT_MINUTES). config.test.mts sizes BUILDING_LABEL_MAX_AGE_MS from both.
export const COMMAND_LIMIT_MINUTES = 10;

// How long createCheckedSandbox's probe (`true`, which takes milliseconds) may take, in minutes.
export const PROBE_LIMIT_MINUTES = 1;

// Seconds `timeout` waits after TERM before it sends KILL.
export const KILL_GRACE_SECONDS = 30;

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
  // GNU `timeout -k 0` sends no KILL at all, so the grace must be positive; the host's extra wait may be 0.
  if (!Number.isFinite(graceSeconds) || graceSeconds <= 0) throw new Error(`graceSeconds must be a number of seconds above 0, not ${graceSeconds}`);
  if (!Number.isFinite(backstopSlackSeconds) || backstopSlackSeconds < 0) {
    throw new Error(`backstopSlackSeconds must be a number of seconds, 0 or more, not ${backstopSlackSeconds}`);
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

// What runs after `timeout` ends: when it timed out (124, or 137 after KILL), kill whatever is left of its process
// group. `timeout` returns as soon as its command exits, so a descendant that ignores TERM (a background job with its
// output redirected) outlives a command that died on TERM, and `-k` only sends KILL while the command still runs.
// `timeout` makes itself a group leader, so the group's id is its pid. A descendant that left the group (setsid) is
// beyond this. It is a case, not a shell `trap`, because the monitored `sh` is already gone by then.
const CLEANUP_AFTER_TIMEOUT = "wait $p; c=$?; case $c in 124|137) kill -s KILL -- -$p 2>/dev/null;; esac; exit $c";

// What limitedCommand puts around the `timeout` command. A shell gives an asynchronous command /dev/null for stdin before
// it applies the command's own redirections (dash does; bash doesn't), so `<&0` on the command would copy /dev/null. The
// prefix copies the real stdin to fd 3 first, and the suffix reads the command's stdin from that copy and closes it,
// so stdin survives in either shell. `&` runs `timeout` in the background so the group it leads can be cleaned up
// afterwards (CLEANUP_AFTER_TIMEOUT). A command in the background also ignores SIGINT and SIGQUIT; the host only ever
// ends a step with TERM and KILL. A test or a fake that unwraps a limited command strips both.
export const LIMITED_COMMAND_PREFIX = "exec 3<&0; ";
export const LIMITED_COMMAND_SUFFIX = ` <&3 3<&- & p=$!; ${CLEANUP_AFTER_TIMEOUT}`;

// The command run under `timeout`. `sh -c` keeps redirections such as `2>&1` inside the limit.
export function limitedCommand(command: string, minutes: number, graceSeconds: number = KILL_GRACE_SECONDS): string {
  return `${LIMITED_COMMAND_PREFIX}timeout -k ${graceSeconds}s ${minutes}m sh -c ${shellWord(command)}${LIMITED_COMMAND_SUFFIX}`;
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
  // How long createCheckedSandbox waits for Docker to create the sandbox, or to close one it refuses.
  dockerCallMinutes?: number;
};

// The step that stalled each limited sandbox, if one did (see stalledStepOf).
const stalledSteps = new WeakMap<object, string>();

// The name of the step that stalled this sandbox, when it came from limitSandboxExec and one did: a caller about to
// publish, or a role about to start, checks it, since a caller that tolerates a thrown exec (a read of the PR body) may
// have swallowed the one that stalled it. An object limitSandboxExec didn't make is never stalled, so a test's fake
// sandbox passes; createCheckedSandbox is the one place that hands the build a sandbox, and a test pins that it is
// the limited one.
export function stalledStepOf(sandbox: object): string | undefined {
  return stalledSteps.get(sandbox);
}

// Records that a step of this sandbox didn't end and the host gave up on it (a role run that never answered, lib/agents.mts), so
// stalledStepOf names it and a limited sandbox refuses every later exec. Keeps the first one.
export function markSandboxStalled(sandbox: object, name: string): void {
  if (!stalledSteps.has(sandbox)) stalledSteps.set(sandbox, name);
}

// A sandbox whose `exec` runs each command under its limit and logs when the step starts and ends. The gate
// that ran over comes back as exit code 124 with the reason appended to its output, so the caller's "non-zero exit
// is a red gate" handling applies. A command other than the gate that ran over, or one the host gave up on, throws
// StalledStepError naming it, and so does every exec after it: a caller must not read a stall as a git answer, and
// a role must not start in a container that may still be running a command (lib/agents.mts#runRoleInSandbox checks
// stalledStepOf too). Every other member is the sandbox's own, bound to it.
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

  // The first step that ran over its limit (a command other than the gate) or that the host gave up on is kept in
  // stalledSteps. The gate's own kill is clean: `timeout` ended it, and the next gate may run. After either of the
  // others a command may still be running in the container, holding git's locks, so the step throws, and every later
  // exec throws too. That keeps the build's worst case at one command limit (lib/config.test.mts).
  const stall = (name: string, message: string): never => {
    if (!stalledSteps.has(limited)) stalledSteps.set(limited, name);
    throw new StalledStepError(message);
  };

  const exec: Sandbox["exec"] = async (command, execOptions) => {
    const name = stepName(command);
    const stalledStep = stalledSteps.get(limited);
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
        markHostCallAbandoned(`the sandbox exec "${name}"`);
        log(`${prefix}step gave up: ${name} didn't return after its ${minutes}-minute limit and the kill grace`);
        return stall(name, `The step "${name}" didn't return within its ${minutes}-minute limit and the kill grace, so the host gave up on it.`);
      }
      result = outcome;
    } finally {
      clearTimeout(timer);
    }

    const elapsed = now() - started;
    const seconds = Math.round(elapsed / 1000);
    if (TIMED_OUT_EXIT_CODES.has(result.exitCode) && elapsed >= limitMs - CLOCK_SLACK_MS) {
      log(`${prefix}step killed: ${name} ran over its ${minutes}-minute limit after ${seconds}s`);
      if (!isGate(command)) return stall(name, `The step "${name}" ran over its ${minutes}-minute limit and was killed.`);
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
