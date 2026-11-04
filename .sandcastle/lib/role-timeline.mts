// Where a role's time goes. Sandcastle's role logs carry no timestamps, so a role that ran for sixteen minutes (a build's
// backend did, in two Actions runs) left nothing to say whether it spent them on commands or on the model. The host times each
// tool call as the agent's stream reports it (`timedProvider`), and the run report (lib/report.mts) prints, for each role, how
// many calls it made, how long it ran, and the longest stretches between one call and the next. The time between two calls is
// the first call running plus the model's thinking after it, so a gate or a test run shows up as a long stretch after a `Bash`
// call. Only a call's name is kept, never its arguments, and only when it is a plain tool name: the report is a public
// artifact (lib/role-logs.mts).

import type { AgentProvider } from "@ai-hero/sandcastle";

// How many of a role's longest stretches the report names.
export const TIMELINE_GAPS = 3;

// A tool name as the report prints it: a plain one (`Bash`, `Read`), else `other`, which keeps an MCP tool's server and
// tool names and anything an agent-chosen name could carry out of a public artifact.
const PLAIN_TOOL_NAME = /^[A-Za-z]{1,24}$/;

export function reportedToolName(name: string): string {
  return PLAIN_TOOL_NAME.test(name) ? name : "other";
}

type Gap = { readonly ms: number; readonly after: string };

type RoleTiming = { runs: number; calls: number; ms: number; gaps: Gap[] };

// One role run's clock. `call` is told of each tool call, `end` of the run's end; a later call to either does nothing, so a
// run that is reported twice (a retry's, a late event from a run the host gave up on) is counted once.
export class RoleRun {
  private last: { atMs: number; after: string };
  private ended = false;

  constructor(
    private readonly timing: RoleTiming,
    private readonly startedAtMs: number,
  ) {
    this.last = { atMs: startedAtMs, after: "start" };
    timing.runs += 1;
  }

  call(name: string, atMs: number): void {
    if (this.ended) return;
    this.closeGap(atMs);
    this.timing.calls += 1;
    this.last = { atMs, after: reportedToolName(name) };
  }

  end(atMs: number): void {
    if (this.ended) return;
    this.closeGap(atMs);
    this.timing.ms += Math.max(0, atMs - this.startedAtMs);
    this.ended = true;
  }

  // The stretch from the last call (or the start) to `atMs`, kept when it is one of the role's longest.
  private closeGap(atMs: number): void {
    const gaps = this.timing.gaps;
    gaps.push({ ms: Math.max(0, atMs - this.last.atMs), after: this.last.after });
    gaps.sort((a, b) => b.ms - a.ms);
    gaps.length = Math.min(gaps.length, TIMELINE_GAPS);
  }
}

// The timings of every role the run started.
export class TimelineReport {
  private readonly byRole = new Map<string, RoleTiming>();

  // Starts timing one run of `role`. Its handle is the only way to add to the role's numbers, so two runs of the same role at once
  // (two builds) don't mix their stretches.
  begin(role: string, atMs: number = Date.now()): RoleRun {
    let timing = this.byRole.get(role);
    if (timing === undefined) {
      timing = { runs: 0, calls: 0, ms: 0, gaps: [] };
      this.byRole.set(role, timing);
    }
    return new RoleRun(timing, atMs);
  }

  // One line per role: runs, tool calls, the time the runs took in total, and the longest stretches, each named for the call
  // that was running when it began.
  lines(): string[] {
    return [...this.byRole].map(([role, timing]) => {
      const stretches = timing.gaps.map((gap) => `${seconds(gap.ms)} after ${gap.after}`).join(", ");
      const runs = timing.runs === 1 ? "1 run" : `${timing.runs} runs`;
      const longest = stretches === "" ? "" : `; longest stretches between calls: ${stretches}`;
      return `${role}: ${runs}, ${timing.calls} tool calls, ${seconds(timing.ms)} in all${longest}`;
    });
  }
}

// The one report every role run records into.
export const timelineReport = new TimelineReport();

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

// `provider` with each tool call its stream reports passed to `run.call`. The provider itself is returned unchanged in what it
// parses and how it builds its command: this only watches.
export function timedProvider<P extends AgentProvider>(provider: P, run: RoleRun, now: () => number = Date.now): P {
  return {
    ...provider,
    parseStreamLine: (line: string) => {
      const events = provider.parseStreamLine(line);
      for (const event of events) {
        if (event.type === "tool_call") run.call(event.name, now());
      }
      return events;
    },
  };
}
