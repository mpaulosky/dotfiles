// Time limits on the host's own waits that are not a command in a sandbox (that is lib/step-limit.mts): the synchronous
// `gh`, `git` and `docker info` calls, and Docker's create and close of a sandbox. None of them has a timeout of its own, so one that never
// answered would hold the run until the job's cap. This module imports only lib/errors.mts, so the modules that make the
// host's calls can import it without a cycle through lib/step-limit.mts (which imports lib/status.mts).
import { execFileSync } from "node:child_process";
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";

// The most a timer can wait: setTimeout fires at once for a longer delay.
export const MAX_TIMER_MS = 2 ** 31 - 1;

// How long one host command (a `gh` or `git` call) may run before it is killed, in minutes. The host's calls are synchronous, so
// one that never returned would hold the whole run.
export const HOST_COMMAND_LIMIT_MINUTES = 5;

// How long Docker may take to create or close a sandbox, in minutes. Both are Sandcastle calls with no timeout of their own.
export const DOCKER_CALL_LIMIT_MINUTES = 5;

// The options every host `gh`, `git` and `docker info` call gets: the host limit and KILL (a hung `gh` may ignore TERM). A caller's own values win.
export function hostExecOptions(given: object = {}): object {
  return { timeout: HOST_COMMAND_LIMIT_MINUTES * 60_000, killSignal: "SIGKILL", ...given };
}

// execFileSync with a time limit, for every `gh`, `git` and `docker info` call the host makes: the child is killed (KILL, since a hung `gh` may
// ignore TERM) when it runs past HOST_COMMAND_LIMIT_MINUTES, and the call throws like any failed one (code ETIMEDOUT), so each
// caller's own handling of a failed call applies. A caller's own `timeout` or `killSignal` wins.
export const hostExecFileSync = ((file: string, ...rest: unknown[]) => {
  const args = rest.find(Array.isArray) as string[] | undefined;
  const last = rest[rest.length - 1];
  const options = hostExecOptions(last !== null && typeof last === "object" && !Array.isArray(last) ? last : {});
  return args === undefined ? execFileSync(file, options as never) : execFileSync(file, args, options as never);
}) as typeof execFileSync;

// What the host has given up on this run and cannot cancel: a Docker create or close (withinDockerLimit), a sandbox exec
// (lib/step-limit.mts) or a role's run in a sandbox (lib/agents.mts#runRoleInSandbox), by name. Any of them may still hold a child process or socket that keeps Node alive after the run's work is
// done: see exitAfterStall.
const abandonedCalls: string[] = [];
let warnedOfAbandonedCalls = false;

// The warning that names the abandoned calls. The process ends without closing a sandbox that a create the host gave up on makes later,
// and an abandoned exec or close may still hold its container, so a person looks for a leftover container and worktree.
const abandonedCallsWarning = (): string =>
  `The host gave up on ${abandonedCalls.length} call${abandonedCalls.length === 1 ? "" : "s"} that may still be pending (${abandonedCalls.join("; ")}). ` +
  "A sandbox one of them was creating is not closed once it arrives, and one still running holds its container, so look for a leftover container and worktree.";

// Text for a log line with the characters that could change what a terminal or a CI log shows removed: control and format characters
// (bidi overrides, zero-width ones) and the line and paragraph separators. This module may import only lib/errors.mts, so it can't use status.mts#terminalText.
const plain = (text: string): string => text.replace(/[\p{C}\u2028\u2029]/gu, " ");

// Records a call the host gave up on. `what` is shown in the warning, cleaned by `plain`. The warning is also printed when the process
// exits (once), so a run that crashes before exitAfterStall still names the calls. The exit listener goes first, ahead of slow or fallible
// exit work such as the building labels' release. A test process that stalls a call without calling exitAfterStall prints it when it ends.
export function markHostCallAbandoned(what: string): void {
  abandonedCalls.push(plain(what));
  if (abandonedCalls.length === 1) {
    process.prependOnceListener("exit", () => {
      if (!warnedOfAbandonedCalls) console.error(`  ⚠ ${abandonedCallsWarning()}`);
    });
  }
}

// Whether a close the host gave up on, after the work was done, has made this run end red (see closeAfterWork and exitAfterStall).
let abandonedCloseEndsRunRed = false;

// Whether the host has given up on a call this run.
export const hostCallHasBeenAbandoned = (): boolean => abandonedCalls.length > 0;

// How long the run may take to exit by itself after its cleanup, once the host has given up on a call, in seconds.
export const STALL_EXIT_GRACE_SECONDS = 10;

// Called once the run's reports and cleanup are done. When the host gave up on a call, whatever it left referenced may keep Node
// running (process.exitCode doesn't force an exit), so the process is ended after `graceSeconds` with the code the run set (0 when it
// set none), after the warning that names the abandoned calls. A close the host gave up on after finished work (closeAfterWork) makes the
// run end red: a run that set no failing exit code gets 1, set here and not by the timer, so it holds when the process ends by itself. The timer is unref'd, so a process that does end by itself isn't held
// for it. Does nothing when the host gave up on nothing. `exit` and `log` are for tests.
export function exitAfterStall(
  graceSeconds: number = STALL_EXIT_GRACE_SECONDS,
  exit: (code: number) => void = (code) => process.exit(code),
  log: (line: string) => void = console.error,
): void {
  if (abandonedCloseEndsRunRed && (process.exitCode === undefined || Number(process.exitCode) === 0)) process.exitCode = 1;
  if (abandonedCalls.length === 0) return;
  setTimeout(() => {
    warnedOfAbandonedCalls = true;
    log(`  ⚠ ending the run ${graceSeconds}s after its cleanup. ${abandonedCallsWarning()}`);
    exit(Number(process.exitCode ?? 0));
  }, graceSeconds * 1000).unref();
}

// Waits for a Docker call (creating or closing a sandbox) for at most `minutes`, and throws StalledStepError when it hasn't
// answered by then: the call itself can't be cancelled, so it is left running, and `onLate` gets whatever it returns if it
// returns after all (the caller's `onLate` closes a sandbox created too late once its worktree passes the check). Giving up also records the
// call (markHostCallAbandoned), which makes main.mts end the process after its cleanup (exitAfterStall). A call that fails inside the limit
// fails as it did.
export async function withinDockerLimit<T>(
  what: string,
  call: Promise<T>,
  minutes: number = DOCKER_CALL_LIMIT_MINUTES,
  onLate: (value: T) => void = () => undefined,
): Promise<T> {
  let gaveUp = false;
  // The failure is cleaned inline, as this module may import only lib/errors.mts and so can't use status.mts#terminalText.
  // Attached first, so a call that fails after the host gave up (or before a bad limit is refused) is never an unhandled rejection,
  // and an onLate that throws is only logged: the run must not crash on a sandbox it already moved past.
  call.then(
    (value) => {
      if (!gaveUp) return;
      try {
        onLate(value);
      } catch (error) {
        console.error(`  ⚠ ${what}: handling the late answer failed: ${plain(String(error))}`);
      }
    },
    () => undefined,
  );
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60_000 > MAX_TIMER_MS) {
    throw new Error(`the Docker call limit must be a positive number of minutes the host can wait for, not ${minutes}`);
  }
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      gaveUp = true;
      markHostCallAbandoned(what);
      reject(new StalledStepError(`${what} didn't finish within ${minutes} minute${minutes === 1 ? "" : "s"}, so the host gave up on it.`));
    }, minutes * 60_000);
  });
  try {
    return await Promise.race([call, limit]);
  } finally {
    clearTimeout(timer);
  }
}

// Closes a sandbox within the Docker call limit (see withinDockerLimit). async, so a close() that throws at once is a rejection too.
export async function closeWithinLimit(sandbox: Sandbox, minutes: number = DOCKER_CALL_LIMIT_MINUTES): Promise<void> {
  await withinDockerLimit("closing the sandbox", Promise.resolve().then(() => sandbox.close()), minutes);
}

// The close in a finally block, or after createCheckedSandbox refuses a sandbox, after the work is done or has failed. A close the host gave up on is reported through `log` and ends the
// run red (exitAfterStall sets the exit code), but never discards a pull request that was opened or the error that ended the work: a
// sandbox Docker won't close is a leak for a person to look at. On a sandbox that stalled, any close failure is only reported: the
// StalledStepError that ended the work is the one to surface, and it already ends the run red. On any other, a close that fails for
// another reason throws as it always did.
export async function closeAfterWork(
  sandbox: Sandbox,
  { stalled, minutes, log }: { stalled: boolean; minutes?: number; log: (line: string) => void },
): Promise<void> {
  try {
    await closeWithinLimit(sandbox, minutes);
  } catch (error) {
    if (!stalled && !(error instanceof StalledStepError)) throw error;
    if (!stalled) abandonedCloseEndsRunRed = true;
    log(stalled ? `closing the stalled sandbox failed: ${String(error)}` : `${String(error)} The sandbox may still be running, so the run ends red.`);
  }
}
