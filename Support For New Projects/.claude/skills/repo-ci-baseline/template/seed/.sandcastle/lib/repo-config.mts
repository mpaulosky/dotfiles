// ---------------------------------------------------------------------------
// This repo's own Sandcastle values: each role's model and budget, the round
// cap, the sandbox hooks, what's copied into the worktree, the host skills
// mounted, the CI jobs scripts/gate.sh reproduces and the Template's root
// copies. A Seed file: Apply writes it only into a repo that has none, so
// each repo keeps its own. Every Owned module reads these names, so each one
// must stay. It imports only types from lib/config.mts, which holds what
// every Sandcastle repo shares and imports nothing from here.
// ---------------------------------------------------------------------------

import type { Role, RoleAgent } from "./config.mts";

const opus = "claude-opus-5-5";
const sonnet = "claude-sonnet-5-5";

// Every role's agent and budget, from the "Roles, models and budgets" table in
// Blazor-Server's docs/plans/sandcastle-workflow.md. Opus goes where a wrong
// answer costs a whole round; Sonnet goes where the gate, the reviewer or CI
// checks the output anyway. Structured-output roles must stay at one iteration.
export const ROLE_AGENTS = {
  intake: { model: sonnet, effort: "medium", maxIterations: 1, timeoutMinutes: 15 },
  planner: { model: opus, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
  critique: { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
  architect: { model: opus, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
  tester: { model: sonnet, effort: "high", maxIterations: 3, timeoutMinutes: 45 },
  backend: { model: opus, effort: "high", maxIterations: 10, timeoutMinutes: 45 },
  scribe: { model: sonnet, effort: "medium", maxIterations: 1, timeoutMinutes: 15 },
  reviewer: { model: opus, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
  "gate-fixer": { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 20 },
  "follow-up": { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 30 },
} as const satisfies Record<Role, RoleAgent>;

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
export const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// pnpm install ensures the sandbox always has fresh dependencies. The copied
// node_modules records the host's pnpm store, so pnpm may rebuild it against
// the sandbox's store; confirm-modules-purge=false lets it do that without a
// TTY prompt.
export const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "pnpm install --frozen-lockfile --config.confirm-modules-purge=false" },
    ],
  },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full pnpm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
export const copyToWorktree = ["node_modules"];

// The host skills the role prompts tell the agent to use, from the host
// user's ~/.claude/skills (lib/skills.mts mounts each one read-only). None by
// default: name a skill here only when a role prompt names it and it isn't in
// the worktree.
export const SANDBOX_SKILLS: readonly string[] = [];

// The CI checks scripts/gate.sh reproduces, which a follow-up pass re-runs
// once as flaky when the gate is green on the PR's head, rather than send
// their log to the follow-up role (lib/follow-up-pass.mts#isGateCovered).
// Name the ci.yml jobs whose work scripts/gate.sh repeats, the repo's test
// jobs included. A rename of one of those jobs must change this too.
export const GATE_COVERED_CHECKS: readonly string[] = ["Build Solution"];

// The Template's Owned folder and the Owned files the repo carries copies of
// at the same path from its root, which lib/overlap.mts counts as one path
// with their Template file. Only a repo that holds the Template itself lists
// its root copies here; every other repo leaves both empty.
export const TEMPLATE_OWNED_DIR = "";
export const TEMPLATE_ROOT_COPIES: readonly string[] = [];
