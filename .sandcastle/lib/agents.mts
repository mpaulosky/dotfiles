// The one place a role's agent is built. Every sandcastle.run() and
// sandbox.run() goes through runRole or runRoleInSandbox, which apply the
// role's model, effort, iteration cap and timeout from ROLE_AGENTS and record
// the run's token usage. The role is recorded before the run starts, so one
// that times out or fails still appears in the end-of-run report. Every role's
// prompt file also gets the shared role rules as {{SHARED_RULES}}, and the
// repo's skills block as {{REPO_SKILLS}} to a prompt that has that placeholder.
// No role starts once the run's limits (lib/limits.mts) say stop, and a run
// that hits Claude's usage limit ends in an UncountedStopError.

import { readFileSync } from "node:fs";
import * as sandcastle from "@ai-hero/sandcastle";
import { FIXED_ROLE_AGENTS, ROLE_RUN_GRACE_MINUTES, type AnyRole, type RoleAgent } from "./config.mts";
import { MAX_TIMER_MS, markHostCallAbandoned } from "./host-limit.mts";
import { ROLE_AGENTS } from "./repo-config.mts";
import { StalledStepError, UncountedStopError } from "./errors.mts";
import { markSandboxStalled, stalledStepOf } from "./step-limit.mts";
import { MAX_CAUSE_DEPTH, RunLimits, runLimits, usageLimitLine } from "./limits.mts";
import { usageReport } from "./report.mts";
import { RoleRun, timedProvider, timelineReport } from "./role-timeline.mts";

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
  const agent = role === "pre-push-reviewer" || role === "pre-push-review-lead" ? FIXED_ROLE_AGENTS[role] : agents[role];
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
// it gets (with `agents`, they are written as the `tools` of the lead's own `--agents` definition and no `--tools` is passed), rules it is denied, and whether only the MCP servers named on the
// command line may start, and whether Claude Code reads only the user's settings, not the branch's .claude/settings.json (whose hooks
// would run shell commands, with the sandbox's environment, in a run that is meant to hold no shell). `agents` adds the subagents defined on the command line
// (`--agents`); a role that has them must hold exactly the tool `Agent(<those names>)` (leadTools) beside only REVIEWER_TOOLS, must set `denied` to LEAD_DENIED_TOOLS and both
// flags, and each subagent holds only some of REVIEWER_TOOLS.
export type AgentRestrictions = {
  tools?: readonly string[];
  denied?: readonly string[];
  strictMcp?: boolean;
  userSettingsOnly?: boolean;
  // Subagents defined on the command line (`--agents`), by name.
  agents?: Readonly<Record<string, SubagentDefinition>>;
};

// One subagent as `--agents` takes it.
export type SubagentDefinition = { description: string; prompt: string; tools: readonly string[]; model: string };

// The most bytes the `--agents` shell word may be: the JSON in single quotes, each single quote inside it written as four bytes. One argv word is capped at
// 128 KiB on Linux, and JSON full of apostrophes grows to four times its size once quoted, so the limit is on the word and not on the raw JSON.
export const MAX_AGENTS_WORD_BYTES = 60_000;

// The built-in subagent types of Claude Code known today. This list is a second layer only: it can't name a type a later release adds or one from the user's own
// `~/.claude/agents` or a plugin (`--setting-sources user` still loads those), so the lead's `Agent` tool is also restricted to the defined `lens-<id>` agents (leadTools).
// A real `claude` 2.1.317 showed that `--tools 'Agent(a,b),Read'` gives the session no Agent tool at all and a bare `Agent` there starts user-level and plugin agents as well,
// so the lead is itself defined in `--agents` (LEAD_AGENT_NAME) and started with `--agent`: its own `tools` list is where `Agent(a,b)` is enforced (every other type is "not found").
// `general-purpose` holds every tool, a shell and the network among them, and the lead reads answers from reviewers that read branch-planted files.
const BUILTIN_SUBAGENT_TYPES = ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "output-style-setup"] as const;

// What the lead of a review's subagents is denied: the ledger rules, and every known built-in subagent type (the allowlist in leadTools is the first layer).
// The lead's own definition holds none of the tools that run commands, write files, reach the network, load skills or enter worktrees, but `--tools` no longer narrows the session, so the
// ones known today are denied too, as a second layer behind the definition's tools: a deny list can't name a tool a later release adds, so it is not a guarantee should `--agent` not
// apply the definition's tools. `Task` (the old name of Agent) and a bare `Agent` are left out on purpose: a deny rule may alias them to the lead's own Agent tool, and the allowlist covers spawning.
const LEAD_NEVER_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Monitor", "PowerShell", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Skill", "EnterWorktree",
] as const;
export const LEAD_DENIED_TOOLS: readonly string[] = [...LEDGER_DENIED_TOOLS, ...BUILTIN_SUBAGENT_TYPES.map((type) => `Agent(${type})`), ...LEAD_NEVER_TOOLS];

// The subagent names `--agents` takes: lowercase ASCII, so a name is never a shell or JSON surprise (nor a wildcard, comma or parenthesis in an allowlist).
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;

// The name the lead is defined under in `--agents`, and started as with `--agent`.
export const LEAD_AGENT_NAME = "pre-push-review-lead";

// The lead's `description` and `prompt` in `--agents`: under `--agent` the prompt is the session's system prompt, and the round's own prompt arrives on stdin.
export const LEAD_DESCRIPTION = "Starts the round's reviewers and relays their answers";
export const LEAD_PROMPT = "Follow the task you are given.";

// Throws for a subagent name that is the lead's own, which `--agents` would let the lead's definition silently replace, and which the lead's allowlist must not name.
function checkNotLeadName(name: string): void {
  if (name === LEAD_AGENT_NAME) throw new Error(`the agent name ${LEAD_AGENT_NAME} is reserved for the lead`);
}

// The tools the lead of a review's subagents gets: `Agent(<names>)`, which lets it start only those subagents and no other, and the reviewers' own tools.
// Claude Code honours `Agent(name,...)` in a `--agents` definition's `tools`, not in `--tools`; restrictedClaudeCode puts these tools there, refuses a lead whose Agent tool
// isn't exactly this beside only the reviewers' own tools, and requires the deny list in LEAD_DENIED_TOOLS beside it.
export function leadTools(agentNames: readonly string[]): string[] {
  if (agentNames.length === 0) throw new Error("the lead's Agent tool needs at least one agent to allow");
  for (const name of agentNames) {
    checkNotLeadName(name);
    if (!AGENT_NAME.test(name)) throw new Error(`an agent name for the lead's Agent tool must be lowercase ASCII letters, digits and hyphens, starting with a letter, not ${JSON.stringify(name.slice(0, 40))}`);
  }
  return [`Agent(${agentNames.join(",")})`, ...REVIEWER_TOOLS];
}

// Throws unless `tools` holds one `Agent(...)` entry naming exactly `agentNames` and no bare `Agent` (a lead that may start any other subagent would break the 'no shell, no
// network, no write tool' claim), and nothing besides it but REVIEWER_TOOLS: with no `--tools` to narrow the session, the lead's definition is the only tool ceiling.
function checkLeadAgentTool(tools: readonly string[] | undefined, agentNames: readonly string[]): void {
  const agentTools = (tools ?? []).filter((tool) => tool === "Agent" || tool.startsWith("Agent("));
  const expected = `Agent(${agentNames.join(",")})`;
  if (agentTools.length !== 1 || agentTools[0] !== expected) {
    throw new Error(`a role with subagents defined must have the tool ${expected} and no other Agent tool, so it starts only those agents; got ${JSON.stringify(agentTools)}`);
  }
  // The lead's definition is the only ceiling on its tools (no `--tools` narrows the session), so nothing but the reviewers' own tools may sit beside the Agent tool.
  const others = (tools ?? []).filter((tool) => tool !== "Agent" && !tool.startsWith("Agent("));
  const extra = others.filter((tool) => !(REVIEWER_TOOLS as readonly string[]).includes(tool));
  if (extra.length > 0) throw new Error(`a role with subagents defined may hold only Agent(...) and ${REVIEWER_TOOLS.join(", ")} as tools, not the tool(s) ${JSON.stringify(extra)}`);
}

const PRINT_COMMAND_START = "claude --print ";

// `value` as one single-quoted shell word.
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// `agents` as the JSON `--agents` takes. Throws for a name that isn't plain, for none at all (`{}` is not the same as leaving `agents` out),
// and for a shell word past MAX_AGENTS_WORD_BYTES, so a too-long command fails where the provider is built and not at exec.
function agentsJson(agents: Readonly<Record<string, SubagentDefinition>>, lead?: { model: string; tools: readonly string[] }): string {
  const names = Object.keys(agents);
  if (names.length === 0) throw new Error("the agents to define for --agents are empty: give none or at least one");
  for (const name of names) {
    checkNotLeadName(name);
    if (!AGENT_NAME.test(name)) throw new Error(`an agent name for --agents must be lowercase ASCII letters, digits and hyphens, starting with a letter, not ${JSON.stringify(name.slice(0, 40))}`);
  }
  // The ceiling on what a subagent can do is its own tools, so the builder holds it and not only the one caller that builds them today.
  for (const [name, { tools }] of Object.entries(agents)) {
    if (tools.length === 0 || !tools.every((tool) => (REVIEWER_TOOLS as readonly string[]).includes(tool))) {
      throw new Error(`the subagent ${name} must hold some of ${REVIEWER_TOOLS.join(", ")} and no other tool, not ${JSON.stringify(tools)}`);
    }
  }
  const json = JSON.stringify(
    lead === undefined
      ? agents
      : { ...agents, [LEAD_AGENT_NAME]: { description: LEAD_DESCRIPTION, prompt: LEAD_PROMPT, tools: lead.tools, model: lead.model } },
  );
  const bytes = Buffer.byteLength(shellWord(json));
  if (bytes > MAX_AGENTS_WORD_BYTES) throw new Error(`the --agents word is ${bytes} bytes once quoted for the shell, over the limit of ${MAX_AGENTS_WORD_BYTES} bytes`);
  return json;
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
  const { tools, denied, strictMcp, userSettingsOnly, agents: subagents } = restrictions;
  if (subagents !== undefined) {
    checkLeadAgentTool(tools, Object.keys(subagents));
    // The layers behind the definition's tools: the lead's denials, MCP servers only from the command line, and the user's settings only.
    const denies = new Set(denied ?? []);
    if (!LEAD_DENIED_TOOLS.every((rule) => denies.has(rule)) || strictMcp !== true || userSettingsOnly !== true) {
      throw new Error("a role with subagents defined must also set denied to the lead's denied tools, strictMcp and userSettingsOnly: they back the definition's tools");
    }
  }
  const flags = [
    // With subagents the tools go on the lead's own definition (see above); `--tools` would leave it no Agent tool.
    ...(tools === undefined || subagents !== undefined ? [] : ["--tools", shellWord(tools.join(","))]),
    ...(subagents === undefined ? [] : ["--agents", shellWord(agentsJson(subagents, { model, tools: tools ?? [] })), "--agent", LEAD_AGENT_NAME]),
    ...(strictMcp === true ? ["--strict-mcp-config"] : []),
    ...(userSettingsOnly === true ? ["--setting-sources", "user"] : []),
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
let repoSkills: string | undefined;

// The placeholder as Sandcastle matches it (its PLACEHOLDER_PATTERN allows spaces inside the braces).
const REPO_SKILLS_PLACEHOLDER = /\{\{\s*REPO_SKILLS\s*\}\}/;

// Add .sandcastle/roles/shared-rules.md as {{SHARED_RULES}} to a prompt file's
// arguments, and the trimmed text of .sandcastle/roles/skills.md (the repo's
// skills block, empty when it mounts none) as {{REPO_SKILLS}}, but only to a
// prompt that has that placeholder: Sandcastle logs a warning for every
// argument a prompt doesn't reference, and only tester, backend and ui do. An
// empty string is a fine value (Sandcastle refuses only null and undefined). A
// prompt file that can't be read gets it too, so Sandcastle names the missing
// file rather than a missing argument. An inline prompt is left alone:
// Sandcastle rejects prompt arguments for one. A missing roles/ file throws,
// as shared-rules.md's always has: both are Seed files.
export function withSharedRules<T extends { prompt?: string; promptFile?: string; promptArgs?: sandcastle.PromptArgs }>(
  options: T,
): T & { promptArgs?: sandcastle.PromptArgs } {
  if (options.promptFile === undefined) return options;
  sharedRules ??= readFileSync(new URL("../roles/shared-rules.md", import.meta.url), "utf8");
  repoSkills ??= readFileSync(new URL("../roles/skills.md", import.meta.url), "utf8").trim();
  const text = promptText(options.promptFile);
  const referencesSkills = text === undefined || REPO_SKILLS_PLACEHOLDER.test(text);
  return {
    ...options,
    promptArgs: { ...options.promptArgs, SHARED_RULES: sharedRules, ...(referencesSkills ? { REPO_SKILLS: repoSkills } : {}) },
  };
}

// A prompt file's text, read the way Sandcastle reads it (relative to the working directory), or undefined when it can't be read.
function promptText(promptFile: string): string | undefined {
  try {
    return readFileSync(promptFile, "utf8");
  } catch {
    return undefined;
  }
}

export function runRole<T>(
  role: AnyRole,
  options: Omit<sandcastle.RunOptions, RoleFixed | "output"> & { output: sandcastle.OutputObjectDefinition<T> },
  limits?: RunLimits,
  execute?: typeof sandcastle.run,
): Promise<sandcastle.RunResult & { output: T }>;
export function runRole(
  role: AnyRole,
  options: Omit<sandcastle.RunOptions, RoleFixed>,
  limits?: RunLimits,
  execute?: typeof sandcastle.run,
): Promise<sandcastle.RunResult>;
export async function runRole(
  role: AnyRole,
  options: Omit<sandcastle.RunOptions, RoleFixed>,
  limits: RunLimits = runLimits,
  // Starts the run; for tests.
  execute: typeof sandcastle.run = sandcastle.run,
): Promise<sandcastle.RunResult> {
  usageReport.record(role, []);
  // Timed from the moment the role starts: a role the run's limits refuse, or whose options can't be built, never does, and must not be
  // listed as one that ran. So the options come first, and the agent is wrapped (lib/role-timeline.mts) once the clock is running.
  let timing: RoleRun | undefined;
  try {
    const result = await runWithinLimits(
      role,
      () => {
        const prepared = { ...withSharedRules(options), ...roleOptions(role) };
        timing = timelineReport.begin(role);
        return execute({ ...prepared, agent: timedProvider(prepared.agent, timing) });
      },
      limits,
    );
    usageReport.record(role, result.iterations);
    return result;
  } finally {
    timing?.end(Date.now());
  }
}

export async function runRoleInSandbox(
  sandbox: sandcastle.Sandbox,
  role: AnyRole,
  options: Omit<sandcastle.SandboxRunOptions, RoleFixed>,
  limits: RunLimits = runLimits,
  restrictions?: AgentRestrictions,
  // How long to wait for the run, in milliseconds; for tests. The default is the role's timeoutMinutes plus ROLE_RUN_GRACE_MINUTES.
  backstop: { backstopMs?: number } = {},
): Promise<sandcastle.SandboxRunResult> {
  // Defensive: the first stall already threw from the exec that hit it, so only a caller that swallowed that throw gets here (agents.test.mts is its only test).
  // A role runs through sandbox.run, not the limited exec, so it would start in a container that may still be running the
  // stalled command; the build's own tolerant reads can have swallowed the throw that said so.
  const stalled = stalledStepOf(sandbox);
  if (stalled !== undefined) throw new StalledStepError(`the ${role} wasn't started: the step "${stalled}" didn't end at its limit, so the sandbox is stalled.`);
  // Before the usage record: a timeout the host can't wait for throws here, and a role that never started must not be listed as one that ran.
  const backstopMs = backstop.backstopMs ?? roleBackstopMs(role);
  usageReport.record(role, []);
  // Timed from the moment the role starts (see runRole); a run the host gives up on ends here too, and the late events of its stream are ignored.
  let timing: RoleRun | undefined;
  try {
    const result = await runWithinLimits(
      role,
      () => {
        const prepared = { ...withSharedRules(options), ...roleOptions(role, undefined, restrictions) };
        timing = timelineReport.begin(role);
        return withinBackstop(sandbox, role, backstopMs, sandbox.run({ ...prepared, agent: timedProvider(prepared.agent, timing) }));
      },
      limits,
    );
    usageReport.record(role, result.iterations);
    return result;
  } finally {
    timing?.end(Date.now());
  }
}

// How long the host waits for a role's sandbox run: the role's timeoutMinutes and ROLE_RUN_GRACE_MINUTES, in milliseconds. Throws for a
// timeout that isn't a positive number the host can wait for: a longer or non-numeric delay fires at once, which would give up on every run.
export function backstopMsFor(timeoutMinutes: number): number {
  const ms = (timeoutMinutes + ROLE_RUN_GRACE_MINUTES) * 60_000;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || ms > MAX_TIMER_MS) {
    throw new Error(`a role's timeoutMinutes must be a positive number of minutes the host can wait for, not ${timeoutMinutes}`);
  }
  return ms;
}

export const roleBackstopMs = (role: AnyRole): number => backstopMsFor(roleAgent(role).timeoutMinutes);

// Waits for a role's sandbox run for at most `ms`. The run's own AbortSignal ends one that answers it; a Docker exec that never answers
// would hold the review until the job's cap. Giving up stalls the sandbox (stalledStepOf, so no later role or exec starts in a container
// that may still be running the role), records the call (markHostCallAbandoned, so the process ends after its cleanup) and throws. The run itself can't be
// cancelled, but its container doesn't outlive the build: the StalledStepError ends the work, and buildIssue's finally closes the stalled sandbox within the
// Docker call limit (closeAfterWork), which removes the container and so the run. Only a close that stalls too leaves it, and the exit warning names that.
async function withinBackstop<R>(sandbox: object, role: AnyRole, ms: number, run: Promise<R>): Promise<R> {
  run.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const what = `the ${role} run`;
      markSandboxStalled(sandbox, what);
      markHostCallAbandoned(`the sandbox ${what}`);
      reject(new StalledStepError(`The ${role} run didn't finish within its timeout and the host's grace, so the host gave up on it.`));
    }, ms);
  });
  try {
    return await Promise.race([run, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
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
