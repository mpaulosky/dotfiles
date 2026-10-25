// Not implemented yet: the per-repo values split out of config.mts. These re-export today's values so the module loads; the real
// split moves them here.
export { ROLE_AGENTS, MAX_ITERATIONS, hooks, copyToWorktree, TEMPLATE_OWNED_DIR, TEMPLATE_ROOT_COPIES } from "./config.mts";

export const SANDBOX_SKILLS: readonly string[] = [];

export const GATE_COVERED_CHECKS: readonly string[] = [];
