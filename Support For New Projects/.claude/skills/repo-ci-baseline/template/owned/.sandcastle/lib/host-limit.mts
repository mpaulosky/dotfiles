// Time limits on the host's own waits that are not a command in a sandbox (that is lib/step-limit.mts): the synchronous
// `gh` and `git` calls, and Docker's create and close of a sandbox. None of them has a timeout of its own, so one that never
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

// execFileSync with a time limit, for every `gh` and `git` call the host makes: the child is killed (KILL, since a hung `gh` may
// ignore TERM) when it runs past HOST_COMMAND_LIMIT_MINUTES, and the call throws like any failed one (code ETIMEDOUT), so each
// caller's own handling of a failed call applies. A caller's own `timeout` or `killSignal` wins.
export function hostExecOptions(given: object = {}): object {
  return { timeout: HOST_COMMAND_LIMIT_MINUTES * 60_000, killSignal: "SIGKILL", ...given };
}

export const hostExecFileSync = ((file: string, ...rest: unknown[]) => {
  const args = rest.find(Array.isArray) as string[] | undefined;
  const last = rest[rest.length - 1];
  const options = hostExecOptions(last !== null && typeof last === "object" && !Array.isArray(last) ? last : {});
  return args === undefined ? execFileSync(file, options as never) : execFileSync(file, args, options as never);
}) as typeof execFileSync;

// Waits for a Docker call (creating or closing a sandbox) for at most `minutes`, and throws StalledStepError when it hasn't
// answered by then: the call itself can't be cancelled, so it is left running, and `onLate` gets whatever it returns if it
// returns after all (a sandbox created too late is closed by the caller's `onLate`). A call that fails inside the limit
// fails as it did.
export async function withinDockerLimit<T>(
  what: string,
  call: Promise<T>,
  minutes: number = DOCKER_CALL_LIMIT_MINUTES,
  onLate: (value: T) => void = () => undefined,
): Promise<T> {
  let gaveUp = false;
  // Attached first, so a call that fails after the host gave up (or before a bad limit is refused) is never an unhandled rejection,
  // and an onLate that throws is only logged: the run must not crash on a sandbox it already moved past.
  call.then(
    (value) => {
      if (!gaveUp) return;
      try {
        onLate(value);
      } catch (error) {
        console.error(`  ⚠ ${what}: handling the late answer failed: ${String(error)}`);
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

// The close in a finally block, after the work is done or has failed. A close the host gave up on is only reported through `log`
// (a sandbox Docker won't close is a leak to look at, not a reason to discard a pull request that was opened or the error that ended
// the work). On a sandbox that stalled, any close failure is only reported too: the StalledStepError that ended the work is the one
// to surface. On any other, a close that fails for another reason throws as it always did.
export async function closeAfterWork(
  sandbox: Sandbox,
  { stalled, minutes, log }: { stalled: boolean; minutes?: number; log: (line: string) => void },
): Promise<void> {
  try {
    await closeWithinLimit(sandbox, minutes);
  } catch (error) {
    if (!stalled && !(error instanceof StalledStepError)) throw error;
    log(stalled ? `closing the stalled sandbox failed: ${String(error)}` : `${String(error)} The sandbox may still be running.`);
  }
}
