// Where a role's time goes. Sandcastle's role logs carry no timestamps, so a role that ran for sixteen minutes (a build's
// backend did, in two Actions runs) left nothing to say whether it spent them on commands or on the model. The host times each
// tool call in the agent's stream (`timedProvider`), and the run report (lib/report.mts) prints, for each role, how many calls it
// made, how long it ran, and the longest stretches between one call and the next. A stretch is the call before it running plus
// the model producing the next call, so a gate or a test run shows up as a long stretch after a `Bash` call; calls the model
// makes together arrive together and leave a 0 s stretch. The first stretch (after `start`) also holds the sandbox and agent
// starting, and the last holds the closing message. The calls are read from the stream's own lines, not from Sandcastle's
// parser, which reports only Bash, WebSearch, WebFetch and Agent calls and so would leave out every Read and Edit. Only a call's
// name is kept, never its arguments, and only a name in KNOWN_TOOLS: the report is a public artifact (lib/role-logs.mts).

import type { AgentProvider } from "@ai-hero/sandcastle";

// How many of a role's longest stretches the report names.
export const TIMELINE_GAPS = 3;

// The tools the report names. A fixed set, not a pattern: a pattern lets any word through, and what reaches a public artifact
// should not depend on what the agent, or a future Sandcastle, calls a tool.
export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Task",
  "Skill",
  "TodoWrite",
  "ToolSearch",
]);

// A tool name as the report prints it: one of KNOWN_TOOLS, else `other`, which also covers an MCP tool, whose server and tool
// names are the repo's own.
export function reportedToolName(name: string): string {
  return KNOWN_TOOLS.has(name) ? name : "other";
}

// The names of the tools a stream line has the assistant call. Claude Code prints one JSON object per line, and an `assistant`
// message holds `tool_use` blocks; any other line, malformed JSON included, holds none. Never throws: it runs inside
// Sandcastle's stream handling, which a throw would disturb.
export function toolNamesInLine(line: string): string[] {
  // A substring test first: most lines (a tool's result, a large file's text) hold no call, and need not be parsed a second time.
  if (!line.startsWith("{") || !line.includes('"tool_use"')) return [];
  try {
    const parsed: unknown = JSON.parse(line);
    const message = (parsed as { type?: unknown; message?: { content?: unknown } } | null);
    if (message?.type !== "assistant" || !Array.isArray(message.message?.content)) return [];
    const names: string[] = [];
    for (const block of message.message.content as unknown[]) {
      const entry = block as { type?: unknown; name?: unknown } | null;
      if (entry?.type === "tool_use" && typeof entry.name === "string") names.push(entry.name);
    }
    return names;
  } catch {
    return [];
  }
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

  // Forgets every role. For tests: a run keeps one report for its whole life.
  reset(): void {
    this.byRole.clear();
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

// `provider` with each tool call in its stream passed to `run.call`. The provider itself is returned unchanged in what it parses
// and how it builds its command: this only watches.
export function timedProvider<P extends AgentProvider>(provider: P, run: RoleRun, now: () => number = Date.now): P {
  return {
    ...provider,
    parseStreamLine: (line: string) => {
      const events = provider.parseStreamLine(line);
      for (const name of toolNamesInLine(line)) run.call(name, now());
      return events;
    },
  };
}
