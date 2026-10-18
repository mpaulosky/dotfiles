// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

import type { ClaudeCodeOptions } from "@ai-hero/sandcastle";

const opus = "claude-opus-5-5";
const sonnet = "claude-sonnet-5";

export type RoleAgent = {
  model: string;
  effort: NonNullable<ClaudeCodeOptions["effort"]>;
  maxIterations: number;
  timeoutMinutes: number;
};

// Every role's agent and budget, from the "Roles, models and budgets" table in
// docs/plans/sandcastle-workflow.md. Opus goes where a wrong answer costs a
// whole round; Sonnet goes where the gate, the reviewer or CI checks the
// output anyway. Structured-output roles must stay at one iteration.
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
} as const satisfies Record<string, RoleAgent>;

export type Role = keyof typeof ROLE_AGENTS;

// The roles the planner may pick per issue, besides the tester, developer
// (the backend role) and reviewer, which always run (see "Phase 4: Plan" and
// "Phase 6: Build" in docs/plans/sandcastle-workflow.md). lib/plan.mts#resolveRoles
// validates the planner's roles field against this list, falling back to
// every one of them when the field is missing or invalid.
export const OPTIONAL_ROLES = ["architect", "scribe"] as const satisfies readonly Role[];

export type OptionalRole = (typeof OPTIONAL_ROLES)[number];

// Marks an issue comment as the architect's design note (lib/build.mts), so
// a re-run can find its own latest one and keep building on the same design
// rather than starting blind.
export const DESIGN_MARKER = "<!-- sandcastle:design -->";

// The roles lib/build.mts#buildIssue runs, each at most once per build,
// besides the gate-fixer, which runs up to GATE_FIXER_ATTEMPTS times at each
// checkpoint. BUILDING_LABEL_MAX_AGE_MS is sized from these roles' timeouts:
// config.test.mts checks the sum fits, and build.test.mts that buildIssue runs
// no role outside the list.
export const BUILD_ROLES = ["architect", "tester", "backend", "scribe", "reviewer"] as const satisfies readonly Role[];

// The ref each issue branch is compared with: every issue PR targets main,
// and fetchMain() refreshes origin/main before each round. The sandbox mounts
// the host's .git, so the ref resolves there too.
export const BASE_BRANCH = "origin/main";

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
export const MAX_ITERATIONS = 10;

// The default for SANDCASTLE_BUDGET_MINUTES: no new round starts, and no role
// run starts, once this many minutes have passed since the run started. The
// job's timeout-minutes is 350 ("Trigger and run environment" in
// docs/plans/sandcastle-workflow.md).
export const DEFAULT_BUDGET_MINUTES = 240;

// Thrown by budgetMinutesFrom for a value that isn't a positive whole number
// of minutes.
export class BudgetError extends Error {}

// SANDCASTLE_BUDGET_MINUTES from `env`: unset or blank gives
// DEFAULT_BUDGET_MINUTES. Otherwise it must match /^[1-9]\d*$/ after trim.
// Anything else ("0", "-5", "1.5", "4h") throws BudgetError rather than
// falling back to the default. Allowed in GitHub Actions too, unlike the
// scope variables.
export function budgetMinutesFrom(env: Record<string, string | undefined>): number {
  const value = env.SANDCASTLE_BUDGET_MINUTES?.trim();
  if (!value) {
    return DEFAULT_BUDGET_MINUTES;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BudgetError(
      `SANDCASTLE_BUDGET_MINUTES must be a positive whole number of minutes, not "${value}".`,
    );
  }
  return Number(value);
}

// How many issues one intake run judges. A malformed or truncated <intake>
// block costs every verdict in it, so a large backlog is judged in several
// runs of this many issues each (#224, #227).
export const INTAKE_BATCH_SIZE = 10;

// How many intake runs in a row may fail before intake stops for the round.
// A failed batch is split in halves to find the issues that break it, which
// takes up to 5 failed runs in a row for one bad issue in a full batch, and a
// few more for bad issues next to each other: 8 leaves room for three. A
// failure every run hits (a sandbox that won't start, an answer the parser
// always rejects) then costs 8 runs a round, not one for every split of every
// batch (#229).
export const INTAKE_FAILED_RUNS_LIMIT = 8;

// How many batches in a row may have GitHub refuse every verdict before
// intake stops for the round. A batch counts only when it held more than one
// verdict: one refused edit can be the issue's own (closed or transferred
// since the queue was read), and narrowing a failed batch makes single-issue
// batches back to back (#229).
export const INTAKE_REFUSED_BATCHES_LIMIT = 2;

// Gate-fixer runs allowed at each gate checkpoint before the issue's round is
// given up, and how much of the final gate output the issue comment quotes.
export const GATE_FIXER_ATTEMPTS = 2;
export const GATE_COMMENT_LINES = 100;

// Attempts allowed for a publish step (git push, gh pr create) that keeps
// failing with a GitHub server error, before Sandcastle gives up on the round
// and comments on the issue. A push rejected for any other reason isn't
// retried at all.
export const PUBLISH_RETRY_ATTEMPTS = 4;

// A label the host manages: created at startup if the repository doesn't
// have it yet (see docs/plans/sandcastle-workflow.md, "Labels").
export type SandcastleLabel = { name: string; color: string; description: string };

// The label that queues an issue in GitHub Actions, and the approval label
// for an issue-scoped local run (see queueLabelOf). A human's to add, like
// every other label SANDCASTLE_LABELS doesn't manage (#146).
export const QUEUE_LABEL = "Sandcastle";

// What a run builds from, resolved once at startup (see queueScopeFrom):
// every open issue carrying `label` (GitHub Actions always uses QUEUE_LABEL),
// or just one `number` and its pull request, for a local run that mustn't
// compete with GitHub Actions over the whole queue (#146).
export type QueueScope = { kind: "label"; label: string } | { kind: "issue"; number: number };

// Thrown by queueScopeFrom when the environment names no valid scope. Its
// message carries QUEUE_SCOPE_USAGE plus the specific problem, so main.mts
// can print it and exit without a stack trace.
export class QueueScopeError extends Error {}

// Printed, with the specific problem, when queueScopeFrom throws.
export const QUEUE_SCOPE_USAGE = `Usage: SANDCASTLE_ISSUE=<n> pnpm run sandcastle      (only issue #n and its PR)
   or: SANDCASTLE_LABEL=<label> pnpm run sandcastle  (issues carrying <label>, e.g. Sandcastle:dev)
Set it on the command line, not in .sandcastle/.env. In GitHub Actions the queue is always the Sandcastle label.`;

// The run's queue scope from the environment (see "Labels" in
// docs/plans/sandcastle-workflow.md): in GitHub Actions (GITHUB_ACTIONS ===
// "true"), always every issue labelled QUEUE_LABEL, and SANDCASTLE_ISSUE or
// SANDCASTLE_LABEL set there is refused rather than silently ignored.
// Otherwise exactly one of SANDCASTLE_ISSUE (a local run building one issue
// and its PR) or SANDCASTLE_LABEL (a local run working a label of the
// owner's choosing, so it doesn't compete with Actions over the whole
// queue) must be set. Throws QueueScopeError for anything else, including a
// SANDCASTLE_LABEL naming a label the host manages (SANDCASTLE_LABELS or
// bug), compared case-insensitively.
export function queueScopeFrom(env: Record<string, string | undefined>): QueueScope {
  const issue = env.SANDCASTLE_ISSUE?.trim() || undefined;
  const label = env.SANDCASTLE_LABEL?.trim() || undefined;
  if (env.GITHUB_ACTIONS === "true") {
    if (issue !== undefined || label !== undefined) {
      throw scopeError("SANDCASTLE_ISSUE and SANDCASTLE_LABEL are for a local run; in GitHub Actions the queue is always the Sandcastle label.");
    }
    return { kind: "label", label: QUEUE_LABEL };
  }
  if (issue !== undefined) {
    if (label !== undefined) throw scopeError("Set SANDCASTLE_ISSUE or SANDCASTLE_LABEL, not both.");
    if (!/^[1-9]\d*$/.test(issue)) throw scopeError(`SANDCASTLE_ISSUE must be an issue number, not "${issue}".`);
    return { kind: "issue", number: Number(issue) };
  }
  if (label === undefined) throw scopeError("A local run needs SANDCASTLE_ISSUE or SANDCASTLE_LABEL.");
  if (label.length > 50) throw scopeError("SANDCASTLE_LABEL is longer than GitHub's 50-character limit for a label.");
  // gh's --label is a CSV list: a comma would split the label in two, and a
  // quote would fail gh's parse.
  if (/[,"]/.test(label)) throw scopeError(`SANDCASTLE_LABEL can't contain a comma or a double quote, which gh reads as a list: "${label}".`);
  const managed = [...SANDCASTLE_LABELS.map((managedLabel) => managedLabel.name), "bug"];
  if (managed.some((name) => name.toLowerCase() === label.toLowerCase())) {
    throw scopeError(`SANDCASTLE_LABEL can't be "${label}": Sandcastle adds and removes that label itself.`);
  }
  return { kind: "label", label };
}

function scopeError(problem: string): QueueScopeError {
  return new QueueScopeError(`${problem}\n\n${QUEUE_SCOPE_USAGE}`);
}

// The label that approves an issue in `scope`, and that intake puts on split
// children and removes from the original (lib/intake.mts#applySplit): the
// scope's own label, or QUEUE_LABEL in issue scope.
export function queueLabelOf(scope: QueueScope): string {
  return scope.kind === "label" ? scope.label : QUEUE_LABEL;
}

// A one-line description of `scope` for the run's log, such as "issues
// labelled Sandcastle:dev" or "issue #146 and its PR".
export function describeQueueScope(scope: QueueScope): string {
  return scope.kind === "label" ? `issues labelled ${scope.label}` : `issue #${scope.number} and its PR`;
}

// Marks an issue while a sandbox is building it (see lib/build.mts#buildIssue
// and lib/gate.mts), so a second Sandcastle run doesn't start building the
// same issue too (#150, a near-miss on #71).
export const BUILDING_LABEL = "sandcastle:building";

// How old a sandcastle:building label must be before startup clears it as a
// crashed run's (see lib/building.mts#clearStaleBuildingLabels). It outlasts
// any real build: every role's timeoutMinutes, even with two gate-fixer
// attempts at each of the two checkpoints, adds up to well under 6 hours.
// config.test.mts checks that sum (see BUILD_ROLES), with an hour to spare,
// stays below it.
export const BUILDING_LABEL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Every label from the Labels table that the host, not a human, is
// responsible for creating. `Sandcastle` is a human's to add. `bug` is
// GitHub's default label, but intake adds it too (#74), and an add fails for a
// label a repository has deleted.
export const SANDCASTLE_LABELS: readonly SandcastleLabel[] = [
  { name: "sandcastle:ready", color: "0E8A16", description: "The issue passed the Definition of Ready and isn't re-checked." },
  {
    name: BUILDING_LABEL,
    color: "1D76DB",
    description: "Sandcastle is building this issue right now. Leave it alone until the label clears.",
  },
  {
    name: "sandcastle:needs-info",
    color: "FBCA04",
    description: "The issue's text is the problem: answer the questions and edit the issue.",
  },
  {
    name: "sandcastle:needs-human",
    color: "D93F0B",
    description: "Sandcastle tried and couldn't. A person needs to look at this issue or pull request.",
  },
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
];

// The HTML comment marking an issue comment as a failed build attempt, so the
// count survives a restart (see lib/github.mts#markerCommentsSince).
export const BUILD_FAILED_MARKER = "<!-- sandcastle:build-failed -->";

// Failed build attempts, counted by BUILD_FAILED_MARKER comments posted since
// `sandcastle:needs-human` was last removed, before the issue is handed back
// (see "Giving up and telling the human" in docs/plans/sandcastle-workflow.md).
export const BUILD_FAILURE_CAP = 2;

// The HTML comment marking an issue a split verdict turned into an umbrella
// (see lib/intake.mts#applyVerdicts and lib/umbrella.mts). The issue loses
// Sandcastle at the same time, so this marker, not a label, is how a later
// round finds it again to check whether every child has finished.
export const UMBRELLA_MARKER = "<!-- sandcastle:umbrella -->";

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

// Marks a PR body as one the host published (lib/build.mts#publish), so the
// follow-up sweep (lib/follow-up.mts) never acts on a collaborator's PR from
// a matching branch (#77).
export const PR_MARKER = "<!-- sandcastle:pr -->";

// The login requestReviewsByLogin takes for Copilot's code review
// (lib/follow-up.mts#sweepPullRequests).
export const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";

// How long CI on a PR's head must have been complete, with no Copilot review
// or request, before the follow-up sweep asks Copilot again, once per head
// (lib/follow-up.mts#decide).
export const COPILOT_REREQUEST_AFTER_MS = 60 * 60 * 1000;

// Marks the follow-up pass's summary PR comment (lib/follow-up-pass.mts), so
// markerComments can count passes already run toward FOLLOW_UP_PASS_CAP
// (#78).
export const FOLLOW_UP_MARKER = "<!-- sandcastle:follow-up -->";

// Marks the host's own reply in a review thread (lib/follow-up-pass.mts), so
// an owner thread the host already answered isn't handed to the follow-up
// role again: the host posts replies from the same login the owner may be,
// so an author check alone can't tell the two apart (#78).
export const FOLLOW_UP_REPLY_MARKER = "<!-- sandcastle:follow-up-reply -->";

// Passes per PR, counted by FOLLOW_UP_MARKER comments since
// sandcastle:needs-human was last removed from it (lib/follow-up-pass.mts,
// "Giving up" in docs/plans/sandcastle-workflow.md, #78).
export const FOLLOW_UP_PASS_CAP = 3;
