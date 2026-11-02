import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { DOCKER_CALL_LIMIT_MINUTES, HOST_COMMAND_LIMIT_MINUTES, closeWithinLimit, hostExecFileSync, withinDockerLimit } from "./host-limit.mts";

const never = () => new Promise<never>(() => undefined);

describe("hostExecFileSync", () => {
  it("returns a command's output like execFileSync", () => {
    assert.equal(hostExecFileSync("sh", ["-c", "echo hi"], { encoding: "utf8" }), "hi\n");
    assert.equal(hostExecFileSync("echo", { encoding: "utf8" } as never), "\n");
  });

  it("kills a command that runs past its limit and throws like a failed call, with code ETIMEDOUT", () => {
    const started = Date.now();

    assert.throws(
      () => hostExecFileSync("sleep", ["30"], { timeout: 200 }),
      (error: NodeJS.ErrnoException) => error.code === "ETIMEDOUT",
    );
    assert.ok(Date.now() - started < 5000);
  });

  it("kills with KILL by default, so a command that ignores TERM still ends", () => {
    const started = Date.now();

    assert.throws(() => hostExecFileSync("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { timeout: 300 }));
    assert.ok(Date.now() - started < 5000);
  });

  it("limits a call that gives no options at all", () => {
    assert.equal(hostExecFileSync("true", []).toString(), "");
    assert.ok(HOST_COMMAND_LIMIT_MINUTES > 0 && HOST_COMMAND_LIMIT_MINUTES <= 30);
  });
});

describe("withinDockerLimit", () => {
  it("returns what the call returns inside its limit", async () => {
    assert.equal(await withinDockerLimit("creating the sandbox", Promise.resolve(7), 1), 7);
  });

  it("fails as the call failed when it fails inside its limit", async () => {
    await assert.rejects(() => withinDockerLimit("creating the sandbox", Promise.reject(new Error("no docker")), 1), /no docker/);
  });

  it("throws a StalledStepError naming the call when it hasn't answered by the limit", async () => {
    await assert.rejects(
      () => withinDockerLimit("creating the sandbox", never(), 0.001),
      (error: Error) => error instanceof StalledStepError && /creating the sandbox didn't finish within 0\.001 minutes/.test(error.message),
    );
  });

  it("hands a value that arrives after the host gave up to onLate", async () => {
    let resolveCall: (value: string) => void = () => undefined;
    const call = new Promise<string>((resolve) => (resolveCall = resolve));
    const late: string[] = [];

    await assert.rejects(() => withinDockerLimit("creating the sandbox", call, 0.001, (value) => late.push(value)), StalledStepError);
    resolveCall("a sandbox");
    await call;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(late, ["a sandbox"]);
  });

  it("does not call onLate for a value that arrived in time", async () => {
    const late: number[] = [];

    await withinDockerLimit("x", Promise.resolve(1), 1, (value) => late.push(value));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(late, []);
  });

  it("leaves no timer behind once the call has answered", async () => {
    await withinDockerLimit("x", Promise.resolve(1), 60);
    // A leftover 60-minute timer would keep this test file's process alive; the run finishing is the check.
  });

  it("refuses a limit the host's timer can't wait for", async () => {
    for (const minutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      await assert.rejects(() => withinDockerLimit("x", Promise.resolve(1), minutes), /positive number of minutes/);
    }
  });

  it("defaults to the Docker call limit", () => {
    assert.ok(DOCKER_CALL_LIMIT_MINUTES > 0 && DOCKER_CALL_LIMIT_MINUTES <= 30);
  });
});

describe("closeWithinLimit", () => {
  it("closes the sandbox", async () => {
    let closed = 0;

    await closeWithinLimit({ close: async () => void closed++ } as unknown as Sandbox, 1);

    assert.equal(closed, 1);
  });

  it("throws a StalledStepError when the close hangs", async () => {
    await assert.rejects(() => closeWithinLimit({ close: never } as unknown as Sandbox, 0.001), StalledStepError);
  });
});

describe("the host's calls", () => {
  it("never default to a bare execFileSync, so every gh and git call the host makes has a time limit", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const bare = readdirSync(dir)
      .filter((name) => name.endsWith(".mts") && !name.endsWith(".test.mts") && name !== "host-limit.mts")
      .filter((name) => /=\s*execFileSync\b|[^\w.]execFileSync\(/.test(readFileSync(new URL(name, dir), "utf8").replace(/^\s*\/\/.*$/gm, "")));

    // review-ledger.mts and security-record.mts run in a person's terminal under scripts/review.sh, not in the unattended run.
    assert.deepEqual(bare.filter((name) => !["review-ledger.mts", "security-record.mts", "git-sandbox-fake.mts"].includes(name)), []);
  });
});
