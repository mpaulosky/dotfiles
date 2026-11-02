// A limit on each command the host runs in a sandbox. Sandcastle's `exec` has no timeout, and the
// time budget (lib/config.mts#DEFAULT_BUDGET_MINUTES) is only checked between iterations, so a gate
// or a git command that stalls would hold a run until the job's own cap. A stalled step is killed
// with coreutils `timeout` inside the container, so the process ends there and not just on the host,
// and its failure names the step. A real run once sat three hours with no log line after a role crashed.
import type { Sandbox } from "@ai-hero/sandcastle";
import { GATE_COMMAND } from "./repo-config.mts";

// How long the gate may run, and how long any other command (git, cat, rm) may, in minutes.
// config.test.mts adds the gate's limit to the longest build when it sizes BUILDING_LABEL_MAX_AGE_MS.
export const GATE_LIMIT_MINUTES = 10;
export const COMMAND_LIMIT_MINUTES = 10;

// Seconds `timeout` waits after TERM before it sends KILL.
const KILL_GRACE_SECONDS = 30;

// `timeout` exits 124 when the command ran over, and 137 when it had to send KILL as well.
const TIMED_OUT_EXIT_CODES = new Set([124, 137]);

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// The step's name for the log and the failure: the gate, or the command's first words.
export function stepName(command: string): string {
  if (command.trim().startsWith(GATE_COMMAND)) return "the gate";
  return command.replace(/\s+/g, " ").trim().slice(0, 60);
}

// The minutes a command may run: the gate gets GATE_LIMIT_MINUTES, everything else COMMAND_LIMIT_MINUTES.
export function limitFor(command: string): number {
  return command.trim().startsWith(GATE_COMMAND) ? GATE_LIMIT_MINUTES : COMMAND_LIMIT_MINUTES;
}

// The command run under `timeout`. `sh -c` keeps redirections such as `2>&1` inside the limit.
export function limitedCommand(command: string, minutes: number): string {
  return `timeout -k ${KILL_GRACE_SECONDS}s ${minutes}m sh -c ${shellWord(command)}`;
}

// A sandbox whose `exec` runs each command under its limit, logs when the step starts and ends, and
// answers a killed step with exit code 124 and the reason appended to its output, so every caller's
// existing "non-zero exit is a failure" handling fails closed. Every other member is the sandbox's own.
export function limitSandboxExec(
  sandbox: Sandbox,
  log: (line: string) => void = console.log,
  now: () => number = Date.now,
): Sandbox {
  const exec: Sandbox["exec"] = async (command, options) => {
    const name = stepName(command);
    const minutes = limitFor(command);
    const started = now();
    log(`  step start: ${name} (limit ${minutes} minutes)`);
    const result = await sandbox.exec(limitedCommand(command, minutes), options);
    const seconds = Math.round((now() - started) / 1000);
    if (TIMED_OUT_EXIT_CODES.has(result.exitCode)) {
      log(`  step killed: ${name} ran over its ${minutes}-minute limit after ${seconds}s`);
      return {
        ...result,
        exitCode: 124,
        stdout: `${result.stdout}\n❌ The step "${name}" ran over its ${minutes}-minute limit and was killed.`,
      };
    }
    log(`  step end: ${name} (exit ${result.exitCode}, ${seconds}s)`);
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
