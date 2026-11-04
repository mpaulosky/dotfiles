import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { KNOWN_TOOLS, TIMELINE_GAPS, TimelineReport, reportedToolName, timedProvider, toolNamesInLine } from "./role-timeline.mts";

describe("reportedToolName", () => {
  it("keeps the name of a known tool and reports anything else as other", () => {
    for (const name of KNOWN_TOOLS) assert.equal(reportedToolName(name), name);
    // A plain word of any length is not a known tool, so an agent can't choose what the report prints.
    assert.equal(reportedToolName("Bashh"), "other");
    assert.equal(reportedToolName("bash"), "other");
    assert.equal(reportedToolName("a".repeat(24)), "other");
    assert.equal(reportedToolName("mcp__server__tool"), "other");
    assert.equal(reportedToolName("sk-ant-oat01-secret"), "other");
    assert.equal(reportedToolName(""), "other");
  });
});

describe("toolNamesInLine", () => {
  const line = (...blocks: unknown[]) => JSON.stringify({ type: "assistant", message: { content: blocks } });

  it("names every tool_use block of an assistant line, whatever the tool", () => {
    assert.deepEqual(
      toolNamesInLine(line({ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { file_path: "/a" } }, { type: "tool_use", name: "Edit", input: {} }, { type: "tool_use", name: "Grep", input: { pattern: "x" } })),
      ["Read", "Edit", "Grep"],
    );
  });

  it("names nothing for a line that isn't an assistant message with content, and never throws", () => {
    for (const text of [
      "",
      "plain text",
      "{",
      "{not json",
      "null",
      "[]",
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "assistant", message: null }),
      JSON.stringify({ type: "assistant", message: { content: "text" } }),
      line(null, 7, "x", { type: "tool_use" }, { type: "tool_use", name: 5 }, { type: "tool_result", name: "Bash" }),
    ]) {
      assert.deepEqual(toolNamesInLine(text), [], text);
    }
  });
});

describe("TimelineReport", () => {
  it("counts a role's calls and time and names its longest stretches by the call that was running", () => {
    const report = new TimelineReport();
    const run = report.begin("backend", 1_000);
    run.call("Read", 3_000); // 2 s after start
    run.call("Bash", 4_000); // 1 s after Read
    run.call("Edit", 124_000); // 120 s after Bash
    run.end(130_000); // 6 s after Edit
    assert.deepEqual(report.lines(), [
      "backend: 1 run, 3 tool calls, 129 s in all; longest stretches between calls: 120 s after Bash, 6 s after Edit, 2 s after start",
    ]);
  });

  it("keeps only the longest TIMELINE_GAPS stretches", () => {
    assert.equal(TIMELINE_GAPS, 3);
    const report = new TimelineReport();
    const run = report.begin("tester", 0);
    for (const [name, at] of [["Bash", 1_000], ["Read", 3_000], ["Edit", 6_000], ["Grep", 10_000]] as const) run.call(name, at);
    run.end(15_000);
    // Stretches: start 1, Bash 2, Read 3, Edit 4, Grep 5.
    assert.match(report.lines()[0]!, /longest stretches between calls: 5 s after Grep, 4 s after Edit, 3 s after Read$/);
  });

  it("adds a second run of a role to the first, and keeps two runs at once apart", () => {
    const report = new TimelineReport();
    const first = report.begin("backend", 0);
    const second = report.begin("backend", 0);
    first.call("Bash", 10_000);
    second.call("Bash", 1_000);
    first.end(10_000);
    second.end(2_000);
    // Neither run's stretch is measured from the other's call: 10 s and 1 s, then 0 s and 1 s.
    assert.equal(report.lines()[0], "backend: 2 runs, 2 tool calls, 12 s in all; longest stretches between calls: 10 s after start, 1 s after start, 1 s after Bash");
  });

  it("counts a run once, however often its calls and end are reported", () => {
    const report = new TimelineReport();
    const run = report.begin("planner", 0);
    run.call("Read", 1_000);
    run.end(2_000);
    run.call("Read", 50_000);
    run.end(60_000);
    assert.equal(report.lines()[0], "planner: 1 run, 1 tool calls, 2 s in all; longest stretches between calls: 1 s after start, 1 s after Read");
  });

  it("lists a role that started and never ended with no time, and a clock that went backwards as 0 s", () => {
    const report = new TimelineReport();
    report.begin("critique", 5_000);
    const run = report.begin("reviewer", 5_000);
    run.call("Read", 1_000);
    run.end(2_000);
    assert.equal(report.lines()[0], "critique: 1 run, 0 tool calls, 0 s in all");
    assert.equal(report.lines()[1], "reviewer: 1 run, 1 tool calls, 0 s in all; longest stretches between calls: 1 s after Read, 0 s after start");
  });

  it("prints a tool name that isn't known as other", () => {
    const report = new TimelineReport();
    const run = report.begin("backend", 0);
    run.call("mcp__github__create_issue", 1_000);
    run.end(2_000);
    assert.ok(!report.lines()[0]!.includes("mcp"));
    assert.match(report.lines()[0]!, /1 s after other/);
  });

  it("forgets every role on reset", () => {
    const report = new TimelineReport();
    report.begin("backend", 0);
    report.reset();
    assert.deepEqual(report.lines(), []);
  });

  it("has no lines before a role starts", () => {
    assert.deepEqual(new TimelineReport().lines(), []);
  });
});

describe("timedProvider", () => {
  const assistantLine = (...names: string[]) =>
    JSON.stringify({ type: "assistant", message: { content: names.map((name) => ({ type: "tool_use", name, input: { command: "secret --token sk-ant-xxxxxxxx" } })) } });
  const base = (): AgentProvider => ({
    name: "test",
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: "claude --print x" }),
    parseStreamLine: (line) => (line.includes("Bash") ? [{ type: "tool_call", name: "Bash", args: "secret --token sk-ant-xxxxxxxx" }] : line === "text" ? [{ type: "text", text: "hi" }] : []),
  });

  it("times every tool call of the stream, also those the provider's parser doesn't report, and returns its events unchanged", () => {
    const report = new TimelineReport();
    const run = report.begin("backend", 0);
    let clock = 0;
    const provider = timedProvider(base(), run, () => (clock += 4_000));
    assert.deepEqual(provider.parseStreamLine(assistantLine("Read", "Bash")), [{ type: "tool_call", name: "Bash", args: "secret --token sk-ant-xxxxxxxx" }]);
    assert.deepEqual(provider.parseStreamLine("text"), [{ type: "text", text: "hi" }]);
    assert.deepEqual(provider.parseStreamLine(assistantLine("Edit")), []);
    run.end(20_000);
    // Read at 4 s, Bash at 8 s, Edit at 12 s: stretches 4 (start), 4 (Read), 4 (Bash), 8 (Edit, to the end).
    assert.equal(report.lines()[0], "backend: 1 run, 3 tool calls, 20 s in all; longest stretches between calls: 8 s after Edit, 4 s after start, 4 s after Read");
  });

  it("never puts a call's arguments in the report", () => {
    const report = new TimelineReport();
    const run = report.begin("backend", 0);
    const provider = timedProvider(base(), run, () => 1_000);
    provider.parseStreamLine(assistantLine("Bash"));
    run.end(2_000);
    assert.ok(!report.lines().join("\n").includes("sk-ant"));
    assert.ok(!report.lines().join("\n").includes("secret"));
  });

  it("doesn't parse a line that can't hold a tool call, and still names the calls of one that can", (t) => {
    const parse = t.mock.method(JSON, "parse");
    const user = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(2_000_000) }] } });
    parse.mock.resetCalls();
    assert.deepEqual(toolNamesInLine(user), []);
    assert.deepEqual(toolNamesInLine("plain text"), []);
    assert.equal(parse.mock.callCount(), 0, "a line with no tool_use was parsed");

    assert.deepEqual(toolNamesInLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } })), ["Bash"]);
    assert.equal(parse.mock.callCount(), 1);
  });

  it("lets a line that isn't JSON through without a throw or a call", () => {
    const report = new TimelineReport();
    const provider = timedProvider(base(), report.begin("backend", 0), () => 1_000);
    assert.deepEqual(provider.parseStreamLine("{ not json"), []);
    assert.match(report.lines()[0]!, /0 tool calls/);
  });

  it("keeps the rest of the provider as it was", () => {
    const original = base();
    const provider = timedProvider(original, new TimelineReport().begin("x", 0));
    assert.equal(provider.name, "test");
    assert.equal(provider.buildPrintCommand({ prompt: "p", dangerouslySkipPermissions: true }).command, "claude --print x");
  });
});
