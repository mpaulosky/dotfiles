// Why an unattended run must stop starting work: the time budget and
// Claude's usage limit. The role runner (lib/agents.mts#runWithinLimits)
// checks this before every role run, and main.mts checks it once at the top
// of each round, so a run never starts a round or a role once the budget has
// passed or the usage limit has been hit (#147).

import { UncountedStopError } from "./errors.mts";

// Keeps the run's own stop state. A module singleton (see runLimits), like
// usageReport and the queue scope: tests pass their own instance through the
// injected parameters and never touch the shared one.
export class RunLimits {
  private budget: { startedAt: number; minutes: number } | undefined;
  private usageReason: string | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  // Starts the budget clock at now(). Before start() is called there's no
  // budget, so tests and modules used without main.mts never stop.
  start(budgetMinutes: number): void {
    this.budget = { startedAt: this.now(), minutes: budgetMinutes };
  }

  // Records a usage-limit stop. Only the first is kept.
  hitUsageLimit(reason: string): void {
    this.usageReason ??= reason;
  }

  // The usage-limit reason, if one was recorded.
  usageLimitReason(): string | undefined {
    return this.usageReason;
  }

  // Why the run must stop starting work, or undefined. A usage stop comes
  // first. Otherwise the budget has passed once
  // now() - start >= budgetMinutes * 60_000, and the reason reads like
  // "the run's 240-minute time budget has passed".
  stopReason(): string | undefined {
    if (this.usageReason !== undefined) {
      return this.usageReason;
    }
    if (this.budget && this.now() - this.budget.startedAt >= this.budget.minutes * 60_000) {
      return `the run's ${this.budget.minutes}-minute time budget has passed`;
    }
    return undefined;
  }

  // Throws new UncountedStopError(stopReason()) when stopReason() is set.
  throwIfStopped(): void {
    const reason = this.stopReason();
    if (reason !== undefined) {
      throw new UncountedStopError(reason);
    }
  }
}

// The run's own limits. main.mts calls runLimits.start(...) at startup.
export const runLimits: RunLimits = new RunLimits();

// Whether a failed role run's error is Claude's usage or rate limit, as
// Claude Code itself reports it (see reportedText). Reads
// the error's message, String(error) and its `cause` chain (up to 5 levels
// deep: Sandcastle rejects through Effect, which may wrap the AgentError).
// Sandcastle's AgentError message is "claude-code exited with code N:\n
// <stderr, else the result text, else the last 20 stdout lines>".
export function isUsageLimitError(error: unknown): boolean {
  return usageLimitLine(error) !== undefined;
}

// Claude Code's usage- and rate-limit phrasings, each anchored to the start
// of the text Claude Code reports it in (see reportedText). Its wording
// changes between versions, so they're kept in this one list. 529 /
// overloaded_error is a server overload, not a usage limit, and stays a
// counted failure.
const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /^Claude (AI )?usage limit reached/i,
  /^You['’]ve hit your (usage |session |weekly )?limit/i,
  /^(5-hour|session|daily|weekly|Opus weekly|Sonnet weekly) limit reached/i,
  /^API Error: 429/i,
  /^Request rejected \(429\)/i,
  /^"type"\s*:\s*"rate_limit_error"/i,
];

// The text in one line of an AgentError message that Claude Code itself
// reports: a plain line (its stderr or result text), trimmed, or the result
// text of a stream-json `result` event. Undefined for any other stream-json
// event: an assistant message or a tool result can quote a usage-limit
// phrasing (Sandcastle works on this very file and its tests), and treating
// that as a limit would stop every run on the issue, uncounted, for good.
function reportedText(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const event = JSON.parse(trimmed) as { type?: unknown; result?: unknown };
    return event.type === "result" && typeof event.result === "string" ? event.result.trim() : undefined;
  } catch {
    return trimmed;
  }
}

// How deep usageLimitLine (and lib/agents.mts#isRoleTimeout) follows an
// error's `cause` chain.
export const MAX_CAUSE_DEPTH = 5;

// The first line of `error`'s text (its message, String(error) and its
// `cause` chain) that matches a usage-limit phrasing, or undefined. The
// role runner names this line in the stop reason.
export function usageLimitLine(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    const texts = current instanceof Error ? [current.message, String(current)] : [String(current)];
    for (const text of texts) {
      for (const line of text.split("\n")) {
        const reported = reportedText(line);
        if (reported !== undefined && USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(reported))) {
          return reported;
        }
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
