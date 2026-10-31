// The one place a role's agent is built. Every sandcastle.run() and
// sandbox.run() goes through runRole or runRoleInSandbox, which apply the
// role's model, effort, iteration cap and timeout from ROLE_AGENTS and record
// the run's token usage. The role is recorded before the run starts, so one
// that times out or fails still appears in the end-of-run report. Every role's
// prompt file also gets the shared role rules as {{SHARED_RULES}}. No role
// starts once the run's limits (lib/limits.mts) say stop, and a run that hits
// Claude's usage limit ends in an UncountedStopError.

import { readFileSync } from "node:fs";
import * as sandcastle from "@ai-hero/sandcastle";
import { FIXED_ROLE_AGENTS, type AnyRole, type RoleAgent } from "./config.mts";
import { ROLE_AGENTS } from "./repo-config.mts";
import { UncountedStopError } from "./errors.mts";
import { MAX_CAUSE_DEPTH, RunLimits, runLimits, usageLimitLine } from "./limits.mts";
import { usageReport } from "./report.mts";

// ROLE_AGENTS as every repo may write it: a repo-config.mts written before the
// `ui` role existed names none, and ROLE_AGENTS' own type then has no `ui` key.
const agents: Partial<Record<AnyRole, RoleAgent>> = ROLE_AGENTS;

// Whether the repo opted into the UI developer by giving ROLE_AGENTS a `ui`
// entry. A repo that hasn't never plans or runs the role.
export function uiEnabled(): boolean {
  return agents.ui !== undefined;
}

// The agent and budget one role runs with: FIXED_ROLE_AGENTS for a role the
// skill fixes, else ROLE_AGENTS'. A role the repo left out (only `ui` may be)
// is a bug in the caller, so it throws.
export function roleAgent(role: AnyRole): RoleAgent {
  const agent = role === "pre-push-reviewer" ? FIXED_ROLE_AGENTS[role] : agents[role];
  if (agent === undefined) throw new Error(`ROLE_AGENTS in lib/repo-config.mts has no ${role} entry`);
  return agent;
}

// The options a role fixes; callers supply everything else.
type RoleFixed = "name" | "agent" | "maxIterations" | "signal";

// The tools a pre-push reviewer gets: it only reads.
export const REVIEWER_TOOLS = ["Read", "Grep", "Glob"] as const;

// Rules that keep an agent from reading, writing or running the local review's
// ledger, which only the host records. They are a convenience on top of the
// empty read-only mount over `.git/review` (lib/skills.mts), which is the
// boundary: a rule alone cannot stop a command that was never named here.
export const LEDGER_DENIED_TOOLS: readonly string[] = [
  ...["Read", "Edit", "Write"].flatMap((tool) => [`${tool}(//**/.git/review)`, `${tool}(//**/.git/review/**)`]),
  "Bash(scripts/review.sh:*)",
];

// What a role's agent is held to besides its model and effort: the only tools
// it gets, rules it is denied, and whether only the MCP servers named on the
// command line may start.
export type AgentRestrictions = { tools?: readonly string[]; denied?: readonly string[]; strictMcp?: boolean };

const PRINT_COMMAND_START = "claude --print ";

// `value` as one single-quoted shell word.
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// `sandcastle.claudeCode` with `restrictions` put into its command as Claude
// Code flags. Sandcastle builds the command, so this fails closed when it
// doesn't start as expected: an agent run without the restrictions asked for
// would read more than it was meant to.
export function restrictedClaudeCode(
  model: string,
  effort: RoleAgent["effort"],
  restrictions: AgentRestrictions,
  build: typeof sandcastle.claudeCode = sandcastle.claudeCode,
): sandcastle.AgentProvider {
  const provider = build(model, { effort });
  const { tools, denied, strictMcp } = restrictions;
  const flags = [
    ...(tools === undefined ? [] : ["--tools", shellWord(tools.join(","))]),
    ...(strictMcp === true ? ["--strict-mcp-config"] : []),
    ...(denied === undefined || denied.length === 0 ? [] : ["--disallowedTools", ...denied.map(shellWord)]),
  ];
  if (flags.length === 0) return provider;
  const restricted = (printed: { command: string; stdin?: string }) => {
    if (!printed.command.startsWith(PRINT_COMMAND_START)) {
      throw new Error(`Sandcastle's Claude Code command no longer starts with \`${PRINT_COMMAND_START.trim()}\`, so its restrictions cannot be applied`);
    }
    return { ...printed, command: `${PRINT_COMMAND_START}${flags.join(" ")} ${printed.command.slice(PRINT_COMMAND_START.length)}` };
  };
  // Probe once now, so a changed command shape fails where the provider is built, not midway through a run.
  restricted(provider.buildPrintCommand({ prompt: "", dangerouslySkipPermissions: true }));
  return { ...provider, buildPrintCommand: (options) => restricted(provider.buildPrintCommand(options)) };
}

export function roleOptions(role: AnyRole, timeout: (ms: number) => AbortSignal = AbortSignal.timeout, restrictions?: AgentRestrictions) {
  const { model, effort, maxIterations, timeoutMinutes } = roleAgent(role);
  return {
    name: role,
    agent: restrictions === undefined ? sandcastle.claudeCode(model, { effort }) : restrictedClaudeCode(model, effort, restrictions),
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
  role: AnyRole,
  options: Omit<sandcastle.RunOptions, RoleFixed | "output"> & { output: sandcastle.OutputObjectDefinition<T> },
  limits?: RunLimits,
): Promise<sandcastle.RunResult & { output: T }>;
export function runRole(
  role: AnyRole,
  options: Omit<sandcastle.RunOptions, RoleFixed>,
  limits?: RunLimits,
): Promise<sandcastle.RunResult>;
export async function runRole(
  role: AnyRole,
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
  role: AnyRole,
  options: Omit<sandcastle.SandboxRunOptions, RoleFixed>,
  limits: RunLimits = runLimits,
  restrictions?: AgentRestrictions,
): Promise<sandcastle.SandboxRunResult> {
  usageReport.record(role, []);
  const result = await runWithinLimits(
    role,
    () => sandbox.run({ ...withSharedRules(options), ...roleOptions(role, undefined, restrictions) }),
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
export async function runWithinLimits<R>(role: AnyRole, start: () => Promise<R>, limits: RunLimits = runLimits): Promise<R> {
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
