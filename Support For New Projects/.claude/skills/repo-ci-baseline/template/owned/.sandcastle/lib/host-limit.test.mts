import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { DOCKER_CALL_LIMIT_MINUTES, HOST_COMMAND_LIMIT_MINUTES, closeAfterWork, closeWithinLimit, hostExecFileSync, hostExecOptions, withinDockerLimit } from "./host-limit.mts";

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

    assert.throws(() => hostExecFileSync("sh", ["-c", "trap '' TERM; for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; done"], { timeout: 300 }));
    assert.ok(Date.now() - started < 5000);
  });

  it("limits a call by default: the options carry the host limit and KILL, and a caller's own values win", () => {
    assert.deepEqual(hostExecOptions(), { timeout: HOST_COMMAND_LIMIT_MINUTES * 60_000, killSignal: "SIGKILL" });
    assert.deepEqual(hostExecOptions({ timeout: 5, encoding: "utf8" }), { timeout: 5, killSignal: "SIGKILL", encoding: "utf8" });
    assert.deepEqual(hostExecOptions({ killSignal: "SIGTERM" }), { timeout: HOST_COMMAND_LIMIT_MINUTES * 60_000, killSignal: "SIGTERM" });
    assert.equal(hostExecFileSync("true", []).toString(), "");
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
    const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const before = timers();

    await withinDockerLimit("x", Promise.resolve(1), 60);

    assert.equal(timers(), before);
  });

  it("does not leave an unhandled rejection when the call fails after a bad limit is refused or after the host gave up", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      let failLate: (error: Error) => void = () => undefined;
      const late = new Promise<never>((_, reject) => (failLate = reject));
      await assert.rejects(() => withinDockerLimit("x", late, 0.001), StalledStepError);
      failLate(new Error("too late"));
      const refused = Promise.reject(new Error("refused"));
      await assert.rejects(() => withinDockerLimit("x", refused, 0), /positive number of minutes/);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", listener);
    }

    assert.deepEqual(unhandled, []);
  });

  it("only logs an onLate that throws", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(line));
    let resolveCall: (value: number) => void = () => undefined;
    const call = new Promise<number>((resolve) => (resolveCall = resolve));
    await assert.rejects(() => withinDockerLimit("creating the sandbox", call, 0.001, () => { throw new Error("close is gone"); }), StalledStepError);

    resolveCall(1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(logged.some((line) => /handling the late answer failed: Error: close is gone/.test(line)), logged.join("\n"));
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

  it("turns a close that throws at once into a rejection", async () => {
    await assert.rejects(() => closeWithinLimit({ close: () => { throw new Error("gone"); } } as unknown as Sandbox, 1), /gone/);
  });

  it("throws a StalledStepError when the close hangs", async () => {
    await assert.rejects(() => closeWithinLimit({ close: never } as unknown as Sandbox, 0.001), StalledStepError);
  });
});

describe("closeAfterWork", () => {
  const hangs = { close: never } as unknown as Sandbox;
  const fails = { close: async () => Promise.reject(new Error("docker: busy")) } as unknown as Sandbox;

  it("only logs a close the host gave up on, so the work's outcome stands", async () => {
    const logged: string[] = [];

    await closeAfterWork(hangs, { stalled: false, minutes: 0.001, log: (line) => logged.push(line) });

    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /closing the sandbox didn't finish within 0\.001 minutes/);
  });

  it("throws a close failure on a sandbox that didn't stall, as a failed close always did", async () => {
    await assert.rejects(() => closeAfterWork(fails, { stalled: false, log: () => undefined }), /docker: busy/);
  });

  it("only logs any close failure on a stalled sandbox", async () => {
    const logged: string[] = [];

    await closeAfterWork(fails, { stalled: true, log: (line) => logged.push(line) });

    assert.match(logged[0]!, /closing the stalled sandbox failed: Error: docker: busy/);
  });
});

describe("the host's calls", () => {
  it("never use child_process as a value outside host-limit.mts, so every gh and git call the host makes has a time limit", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const uses = readdirSync(dir)
      .filter((name) => name.endsWith(".mts") && !name.endsWith(".test.mts") && name !== "host-limit.mts")
      .filter((name) => {
        const code = readFileSync(new URL(name, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/\b(?:require|import)\s*\(\s*["'](?:node:)?child_process["']/.test(code)) return true;
        // An import is a value import unless it is `import type …` or every name in its braces is `type X`.
        return [...code.matchAll(/\bimport\s+([^;]*?)\s*from\s*["'](?:node:)?child_process["']/g)].some(([, clause]) => {
          if (/^type\b/.test(clause!)) return false;
          const names = /\{([^}]*)\}/.exec(clause!)?.[1]?.split(",").map((name) => name.trim()).filter(Boolean);
          return names === undefined || names.some((name) => !/^type\s/.test(name));
        });
      });

    // review-ledger.mts and security-record.mts run in a person's terminal under scripts/review.sh, not in the unattended run, and
    // git-sandbox-fake.mts is a test helper that runs shell setup, not the host's gh or git.
    assert.deepEqual(uses.filter((name) => !["review-ledger.mts", "security-record.mts", "git-sandbox-fake.mts"].includes(name)), []);
  });

  it("never default a run parameter to a bare execFileSync", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const bare = readdirSync(dir)
      .filter((name) => name.endsWith(".mts") && !name.endsWith(".test.mts") && name !== "host-limit.mts")
      .filter((name) => /=\s*execFileSync\b/.test(readFileSync(new URL(name, dir), "utf8").replace(/^\s*\/\/.*$/gm, "")));

    assert.deepEqual(bare, []);
  });
});
