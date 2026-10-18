// The one place a role's agent is built. Every sandcastle.run() and
// sandbox.run() goes through runRole or runRoleInSandbox, which apply the
// role's model, effort, iteration cap and timeout from ROLE_AGENTS and record
// the run's token usage. The role is recorded before the run starts, so one
// that times out or fails still appears in the end-of-run report. Every role's
// prompt file also gets the shared role rules as {{SHARED_RULES}}. No role
// starts once the run's limits (lib/limits.mts) say stop, and a run that hits
// Claude's usage limit ends in an UncountedStopError (#147).

import { readFileSync } from "node:fs";
import * as sandcastle from "@ai-hero/sandcastle";
import { ROLE_AGENTS, type Role } from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import { MAX_CAUSE_DEPTH, RunLimits, runLimits, usageLimitLine } from "./limits.mts";
import { usageReport } from "./report.mts";

// The options a role fixes; callers supply everything else.
type RoleFixed = "name" | "agent" | "maxIterations" | "signal";

export function roleOptions(role: Role, timeout: (ms: number) => AbortSignal = AbortSignal.timeout) {
  const { model, effort, maxIterations, timeoutMinutes } = ROLE_AGENTS[role];
  return {
    name: role,
    agent: sandcastle.claudeCode(model, { effort }),
    maxIterations,
    signal: timeout(timeoutMinutes * 60_000),
  };
}

let sharedRules: string | undefined;

// Add .sandcastle/roles/shared-rules.md to a prompt file's arguments. An inline
// prompt is left alone: Sandcastle rejects prompt arguments for one.
export function withSharedRules<T extends { prompt?: string; promptFile?: string; promptArgs?: sandcastle.PromptArgs }>(
  options: T,
): T & { promptArgs?: sandcastle.PromptArgs } {
  if (options.promptFile === undefined) return options;
  sharedRules ??= readFileSync(new URL("../roles/shared-rules.md", import.meta.url), "utf8");
  return { ...options, promptArgs: { ...options.promptArgs, SHARED_RULES: sharedRules } };
}

export function runRole<T>(
  role: Role,
  options: Omit<sandcastle.RunOptions, RoleFixed | "output"> & { output: sandcastle.OutputObjectDefinition<T> },
  limits?: RunLimits,
): Promise<sandcastle.RunResult & { output: T }>;
export function runRole(
  role: Role,
  options: Omit<sandcastle.RunOptions, RoleFixed>,
  limits?: RunLimits,
): Promise<sandcastle.RunResult>;
export async function runRole(
  role: Role,
  options: Omit<sandcastle.RunOptions, RoleFixed>,
  limits: RunLimits = runLimits,
): Promise<sandcastle.RunResult> {
  usageReport.record(role, []);
  const result = await runWithinLimits(
    role,
    () => sandcastle.run({ ...withSharedRules(options), ...roleOptions(role) }),
    limits,
  );
  usageReport.record(role, result.iterations);
  return result;
}

export async function runRoleInSandbox(
  sandbox: sandcastle.Sandbox,
  role: Role,
  options: Omit<sandcastle.SandboxRunOptions, RoleFixed>,
  limits: RunLimits = runLimits,
): Promise<sandcastle.SandboxRunResult> {
  usageReport.record(role, []);
  const result = await runWithinLimits(
    role,
    () => sandbox.run({ ...withSharedRules(options), ...roleOptions(role) }),
    limits,
  );
  usageReport.record(role, result.iterations);
  return result;
}

// Exact names a role's own timeout carries: AbortSignal.timeout's
// TimeoutError, the same wrapped in an Effect FiberFailure, and Sandcastle's
// AgentIdleTimeoutError (by _tag, not name). A suffix match such as
// /TimeoutError$/ would also catch undici's ConnectTimeoutError,
// HeadersTimeoutError and BodyTimeoutError, which Node's fetch throws on a
// host-side network timeout that has nothing to do with the role.
const TIMEOUT_NAMES = new Set(["TimeoutError", "(FiberFailure) TimeoutError"]);
const TIMEOUT_TAG = "AgentIdleTimeoutError";
const TIMEOUT_MESSAGE = /aborted due to timeout|Agent idle for/;

// Whether a role run's error is its own timeout: ROLE_AGENTS' timeoutMinutes
// (AbortSignal.timeout's TimeoutError, which Sandcastle dies with, possibly
// wrapped in an Effect FiberFailure) or Sandcastle's AgentIdleTimeoutError.
// Reads name, _tag and message along the cause chain, MAX_CAUSE_DEPTH deep, as
// lib/limits.mts#usageLimitLine does for a usage-limit line.
export function isRoleTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
    const { name, _tag, message } = current as { name?: unknown; _tag?: unknown; message?: unknown };
    if (typeof name === "string" && TIMEOUT_NAMES.has(name)) return true;
    if (_tag === TIMEOUT_TAG) return true;
    if (typeof message === "string" && TIMEOUT_MESSAGE.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Runs one role through `start`, refusing to start once `limits` say stop. A
// run that fails on Claude's usage limit (lib/limits.mts#usageLimitLine)
// records the stop, so no later role starts or publishes, and rejects with an
// UncountedStopError naming the role and the limit's line, with the original
// error as its cause. Any other error is rethrown unchanged.
export async function runWithinLimits<R>(role: Role, start: () => Promise<R>, limits: RunLimits = runLimits): Promise<R> {
  limits.throwIfStopped();
  try {
    return await start();
  } catch (error) {
    const line = usageLimitLine(error);
    if (line === undefined) {
      throw error;
    }
    const reason = `Claude's usage limit was hit during the ${role} run: ${line.slice(0, 200)}`;
    limits.hitUsageLimit(reason);
    throw new UncountedStopError(reason, { cause: error });
  }
}
