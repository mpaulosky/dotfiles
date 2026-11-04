import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { TIMELINE_GAPS, TimelineReport, reportedToolName, timedProvider } from "./role-timeline.mts";

describe("reportedToolName", () => {
  it("keeps a plain tool name and reports anything else as other", () => {
    assert.equal(reportedToolName("Bash"), "Bash");
    assert.equal(reportedToolName("a".repeat(24)), "a".repeat(24));
    assert.equal(reportedToolName("a".repeat(25)), "other");
    assert.equal(reportedToolName("mcp__server__tool"), "other");
    assert.equal(reportedToolName("sk-ant-oat01-secret"), "other");
    assert.equal(reportedToolName(""), "other");
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
    for (const [name, at] of [["A", 1_000], ["B", 3_000], ["C", 6_000], ["D", 10_000]] as const) run.call(name, at);
    run.end(15_000);
    // Stretches: start 1, A 2, B 3, C 4, D 5.
    assert.match(report.lines()[0]!, /longest stretches between calls: 5 s after D, 4 s after C, 3 s after B$/);
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

  it("prints a tool name that isn't plain as other", () => {
    const report = new TimelineReport();
    const run = report.begin("backend", 0);
    run.call("mcp__github__create_issue", 1_000);
    run.end(2_000);
    assert.ok(!report.lines()[0]!.includes("mcp"));
    assert.match(report.lines()[0]!, /1 s after other/);
  });

  it("has no lines before a role starts", () => {
    assert.deepEqual(new TimelineReport().lines(), []);
  });
});

describe("timedProvider", () => {
  const base = (): AgentProvider => ({
    name: "test",
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: "claude --print x" }),
    parseStreamLine: (line) =>
      line === "tool" ? [{ type: "tool_call", name: "Bash", args: "secret --token sk-ant-xxxxxxxx" }] : line === "text" ? [{ type: "text", text: "hi" }] : [],
  });

  it("passes the tool calls of the stream to the run and returns the events unchanged", () => {
    const report = new TimelineReport();
    const run = report.begin("backend", 0);
    let clock = 0;
    const provider = timedProvider(base(), run, () => (clock += 4_000));
    assert.deepEqual(provider.parseStreamLine("tool"), [{ type: "tool_call", name: "Bash", args: "secret --token sk-ant-xxxxxxxx" }]);
    assert.deepEqual(provider.parseStreamLine("text"), [{ type: "text", text: "hi" }]);
    assert.deepEqual(provider.parseStreamLine("other"), []);
    run.end(10_000);
    assert.equal(report.lines()[0], "backend: 1 run, 1 tool calls, 10 s in all; longest stretches between calls: 6 s after Bash, 4 s after start");
  });

  it("never puts a call's arguments in the report", () => {
    const report = new TimelineReport();
    const run = report.begin("backend", 0);
    const provider = timedProvider(base(), run, () => 1_000);
    provider.parseStreamLine("tool");
    run.end(2_000);
    assert.ok(!report.lines().join("\n").includes("sk-ant"));
    assert.ok(!report.lines().join("\n").includes("secret"));
  });

  it("keeps the rest of the provider as it was", () => {
    const original = base();
    const provider = timedProvider(original, new TimelineReport().begin("x", 0));
    assert.equal(provider.name, "test");
    assert.equal(provider.buildPrintCommand({ prompt: "p", dangerouslySkipPermissions: true }).command, "claude --print x");
  });
});
