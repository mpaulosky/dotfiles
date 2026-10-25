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

// The host skills the role prompts tell the agent to use (lib/skills.mts
// mounts each one read-only). None: dotfiles' own skills, the
// repo-ci-baseline skill among them, are in the worktree under
// "Support For New Projects/.claude/skills/", and the roles read them there.
export const SANDBOX_SKILLS: readonly string[] = [];

// The CI checks scripts/gate.sh reproduces, which a follow-up pass re-runs
// once as flaky when the gate is green on the PR's head, rather than send
// their log to the follow-up role (lib/follow-up-pass.mts#isGateCovered).
// dotfiles' one is "Template tests" in repo-ci-baseline.yml, which runs
// test.sh and the Sandcastle check, as the gate does. A rename of that job
// must change this too.
export const GATE_COVERED_CHECKS: readonly string[] = ["Template tests"];

// The command the host runs in the sandbox as the gate. dotfiles has no
// Docker-backed tests, so it keeps the Template's default.
export const GATE_COMMAND = "scripts/gate.sh";

// The Template's Owned files under this folder, of which dotfiles carries copies at the same path from the repo root (its own
// .sandcastle/ included): the list test.sh's copy check walks, entry for entry and in the same order.
// lib/overlap.mts counts each pair as one path, since every change to one changes the other.
export const TEMPLATE_OWNED_DIR = "Support For New Projects/.claude/skills/repo-ci-baseline/template/owned";
export const TEMPLATE_ROOT_COPIES: readonly string[] = [
  ".github/workflows/claude-review.yml",
  ".github/workflows/pr-automerge.yml",
  ".github/workflows/pr-review-submitted.yml",
  ".github/scripts/post_claude_review.py",
  ".github/hooks/pre-commit",
  ".github/hooks/pre-push",
  ".github/hooks/post-checkout",
  "scripts/check-branch-name.sh",
  ".sandcastle/.env.example",
  ".sandcastle/.gitignore",
  ".sandcastle/.markdownlint-cli2.jsonc",
  ".sandcastle/critique-prompt.md",
  ".sandcastle/intake-prompt.md",
  ".sandcastle/lib/agents.mts",
  ".sandcastle/lib/agents.test.mts",
  ".sandcastle/lib/branches.mts",
  ".sandcastle/lib/branches.test.mts",
  ".sandcastle/lib/build.mts",
  ".sandcastle/lib/build.test.mts",
  ".sandcastle/lib/building.mts",
  ".sandcastle/lib/building.test.mts",
  ".sandcastle/lib/checkpoint.mts",
  ".sandcastle/lib/checkpoint.test.mts",
  ".sandcastle/lib/config.mts",
  ".sandcastle/lib/config.test.mts",
  ".sandcastle/lib/critique.mts",
  ".sandcastle/lib/critique.test.mts",
  ".sandcastle/lib/errors.mts",
  ".sandcastle/lib/follow-up-pass.mts",
  ".sandcastle/lib/follow-up-pass.test.mts",
  ".sandcastle/lib/follow-up.mts",
  ".sandcastle/lib/follow-up.test.mts",
  ".sandcastle/lib/gate.mts",
  ".sandcastle/lib/gate.test.mts",
  ".sandcastle/lib/git-sandbox-fake.mts",
  ".sandcastle/lib/github.mts",
  ".sandcastle/lib/github.test.mts",
  ".sandcastle/lib/handback.mts",
  ".sandcastle/lib/handback.test.mts",
  ".sandcastle/lib/host-safety.mts",
  ".sandcastle/lib/host-safety.test.mts",
  ".sandcastle/lib/intake.mts",
  ".sandcastle/lib/intake.test.mts",
  ".sandcastle/lib/limits.mts",
  ".sandcastle/lib/limits.test.mts",
  ".sandcastle/lib/overlap.mts",
  ".sandcastle/lib/overlap.test.mts",
  ".sandcastle/lib/plan.mts",
  ".sandcastle/lib/plan.test.mts",
  ".sandcastle/lib/prompts.mts",
  ".sandcastle/lib/prompts.test.mts",
  ".sandcastle/lib/queue.mts",
  ".sandcastle/lib/queue.test.mts",
  ".sandcastle/lib/report.mts",
  ".sandcastle/lib/report.test.mts",
  ".sandcastle/lib/round.mts",
  ".sandcastle/lib/round.test.mts",
  ".sandcastle/lib/sandbox-env.mts",
  ".sandcastle/lib/sandbox-env.test.mts",
  ".sandcastle/lib/scan.mts",
  ".sandcastle/lib/scan.test.mts",
  ".sandcastle/lib/shell.mts",
  ".sandcastle/lib/shell.test.mts",
  ".sandcastle/lib/skills.mts",
  ".sandcastle/lib/skills.test.mts",
  ".sandcastle/lib/umbrella.mts",
  ".sandcastle/lib/umbrella.test.mts",
  ".sandcastle/lib/work.mts",
  ".sandcastle/lib/work.test.mts",
  ".sandcastle/main.mts",
  ".sandcastle/tsconfig.json",
];
