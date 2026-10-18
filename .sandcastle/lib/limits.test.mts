import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUsageLimitError, RunLimits } from "./limits.mts";
import { UncountedStopError } from "./errors.mts";

// A clock the test moves by hand, rather than the wall clock.
function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("RunLimits", () => {
  it("has no stop reason before start() is called", () => {
    const { now } = fakeClock();
    const limits = new RunLimits(now);

    assert.equal(limits.stopReason(), undefined);
  });

  it("has no stop reason just short of the budget", () => {
    const clock = fakeClock();
    const limits = new RunLimits(clock.now);
    limits.start(240);

    clock.advance(240 * 60_000 - 1);

    assert.equal(limits.stopReason(), undefined);
  });

  it("names the budget once exactly that many minutes have passed", () => {
    const clock = fakeClock();
    const limits = new RunLimits(clock.now);
    limits.start(240);

    clock.advance(240 * 60_000);

    assert.match(limits.stopReason() ?? "", /240-minute time budget has passed/);
  });

  it("throwIfStopped throws an UncountedStopError carrying the stop reason", () => {
    const clock = fakeClock();
    const limits = new RunLimits(clock.now);
    limits.start(240);
    clock.advance(240 * 60_000);

    assert.throws(
      () => limits.throwIfStopped(),
      (error: unknown) => error instanceof UncountedStopError && error.message === limits.stopReason(),
    );
  });

  it("doesn't throw while nothing has stopped the run", () => {
    const clock = fakeClock();
    const limits = new RunLimits(clock.now);
    limits.start(240);

    assert.doesNotThrow(() => limits.throwIfStopped());
  });

  it("keeps a usage-limit stop's reason", () => {
    const limits = new RunLimits();

    limits.hitUsageLimit("Claude's usage limit was hit during the backend run");

    assert.equal(limits.usageLimitReason(), "Claude's usage limit was hit during the backend run");
  });

  it("has no usage-limit reason before one is recorded", () => {
    const limits = new RunLimits();

    assert.equal(limits.usageLimitReason(), undefined);
  });

  it("keeps only the first usage-limit reason", () => {
    const limits = new RunLimits();

    limits.hitUsageLimit("first stop");
    limits.hitUsageLimit("second stop");

    assert.equal(limits.usageLimitReason(), "first stop");
  });

  it("gives the usage-limit stop before the budget stop, even once the budget has also passed", () => {
    const clock = fakeClock();
    const limits = new RunLimits(clock.now);
    limits.start(240);
    clock.advance(240 * 60_000);

    limits.hitUsageLimit("usage limit reached");

    assert.equal(limits.stopReason(), "usage limit reached");
  });

  it("stops for the usage limit even before the budget has started", () => {
    const limits = new RunLimits();

    limits.hitUsageLimit("usage limit reached");

    assert.equal(limits.stopReason(), "usage limit reached");
  });
});

describe("isUsageLimitError", () => {
  const phrasings = [
    "Claude AI usage limit reached",
    "Claude usage limit reached",
    "You've hit your usage limit",
    "You’ve hit your session limit",
    "You've hit your weekly limit",
    "You've hit your limit",
    "5-hour limit reached",
    "session limit reached",
    "daily limit reached",
    "weekly limit reached",
    "Opus weekly limit reached",
    "Sonnet weekly limit reached",
    "API Error: 429",
    "Request rejected (429)",
    '"type":"rate_limit_error"',
    '"type": "rate_limit_error"',
  ];

  for (const phrase of phrasings) {
    it(`recognises "${phrase}" in a claude-code exit message`, () => {
      const error = new Error(`claude-code exited with code 1:\n${phrase}`);

      assert.equal(isUsageLimitError(error), true, phrase);
    });
  }

  it("recognises the phrasing case-insensitively", () => {
    const error = new Error("claude-code exited with code 1:\nCLAUDE AI USAGE LIMIT REACHED");

    assert.equal(isUsageLimitError(error), true);
  });

  it("recognises the phrasing nested in an Error's cause", () => {
    const inner = new Error("claude-code exited with code 1:\nClaude AI usage limit reached");
    const outer = new Error("the role run rejected", { cause: inner });

    assert.equal(isUsageLimitError(outer), true);
  });

  it("recognises the result text inside a stream-json line", () => {
    const error = new Error(
      'claude-code exited with code 1:\n{"type":"result","result":"Claude AI usage limit reached|1760000000"}',
    );

    assert.equal(isUsageLimitError(error), true);
  });

  it("recognises a cause chain nested up to 5 levels deep", () => {
    let error: Error = new Error("claude-code exited with code 1:\nClaude AI usage limit reached");
    for (let i = 0; i < 4; i++) {
      error = new Error(`wrapped ${i}`, { cause: error });
    }

    assert.equal(isUsageLimitError(error), true);
  });

  it("recognises a rate limit in a stream-json result event's text", () => {
    const error = new Error(
      'claude-code exited with code 1:\n{"type":"result","is_error":true,"result":"API Error: 429 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"rate_limit_error\\"}}"}',
    );

    assert.equal(isUsageLimitError(error), true);
  });

  // Sandcastle works on itself: a role that reads lib/limits.mts or its tests
  // sees these phrasings in its own tool output, and the AgentError message
  // can end with that output. Only Claude Code's own report is a usage limit.
  it("is false for a tool result in stream-json that quotes a usage-limit phrasing", () => {
    const toolResult = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "  /Claude (AI )?usage limit reached/i,\nAPI Error: 429" }] },
    });
    const error = new Error(`claude-code exited with code 1:\n${toolResult}`);

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for the agent's own text in stream-json mentioning a rate limit", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: 'API Error: 429 is matched by "type":"rate_limit_error" too' }] },
    });
    const error = new Error(`claude-code exited with code 1:\n${assistant}`);

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for a plain output line that only quotes a phrasing partway through, as grep output does", () => {
    const error = new Error(
      "claude-code exited with code 1:\n.sandcastle/lib/limits.test.mts:105:    \"Claude AI usage limit reached\",\nerror: tests failed",
    );

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for a result event that isn't about a limit", () => {
    const error = new Error('claude-code exited with code 1:\n{"type":"result","is_error":true,"result":"Tests fail: expected API Error: 429 handling"}');

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for a server overload, not a usage or rate limit", () => {
    const error = new Error('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for an abort or timeout", () => {
    const error = new DOMException("The operation was aborted", "AbortError");

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for a plain test failure", () => {
    const error = new Error("claude-code exited with code 1:\nerror: tests failed");

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for a failed hook, not a usage limit", () => {
    const error = new Error("Command `pnpm install` exited with code 1: EACCES");

    assert.equal(isUsageLimitError(error), false);
  });

  it("is false for undefined", () => {
    assert.equal(isUsageLimitError(undefined), false);
  });

  it("is false for a non-Error value", () => {
    assert.equal(isUsageLimitError({ not: "an error" }), false);
  });
});
