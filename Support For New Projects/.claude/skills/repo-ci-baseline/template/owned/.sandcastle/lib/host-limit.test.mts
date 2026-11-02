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

  it("strips control characters from the logged onLate failure, as terminalText does elsewhere", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(line));
    let resolveCall: (value: number) => void = () => undefined;
    const call = new Promise<number>((resolve) => (resolveCall = resolve));
    await assert.rejects(
      () => withinDockerLimit("creating the sandbox", call, 0.001, () => { throw new Error("x\u001b[31m\ny"); }),
      StalledStepError,
    );

    resolveCall(1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0]!, /[\u0000-\u001f\u007f-\u009f]/);
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

// The source without its comments. It walks the text so a `/*` or `//` inside a string, or a `/*` inside a line comment, isn't taken for
// a comment's start; strings stay, since the module name is one. A quote inside a regex literal can still mislead it, which only
// matters for a file that also hides a child_process import after one.
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const here = source[i]!;
    const next = source[i + 1];
    if (here === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (here === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
    } else if (here === '"' || here === "'" || here === "`") {
      out += here;
      i++;
      while (i < source.length && source[i] !== here) {
        if (source[i] === "\\") out += source[i++]!;
        out += source[i++] ?? "";
      }
      out += source[i] ?? "";
      i++;
    } else {
      out += here;
      i++;
    }
  }
  return out;
}

// Whether a module's source uses node:child_process as a value: any import or re-export of it that isn't `import type …` /
// `export type …` or all `type X` names, or a require() or import() call. Comments don't count.
function usesChildProcessAsValue(source: string): boolean {
  const code = withoutComments(source);
  if (/\b(?:require|import)\s*\(\s*["'`](?:node:)?child_process["'`]/.test(code)) return true;
  const statement = /\b(?:import|export)\s+((?:(?!\b(?:import|export)\b)[^;])*?)\s*from\s*["'`](?:node:)?child_process["'`]/g;
  return [...code.matchAll(statement)].some(([, clause]) => {
    if (/^type\b/.test(clause!)) return false;
    // A default or namespace binding (`cp`, `cp, { … }`, `* as cp`, `*`) is a value whatever the braces hold.
    const beforeBraces = clause!.split("{")[0]!.replace(/,/g, "").trim();
    if (beforeBraces !== "") return true;
    const names = /\{([^}]*)\}/.exec(clause!)?.[1]?.split(",").map((name) => name.trim()).filter(Boolean);
    return names === undefined || names.some((name) => !/^type\s/.test(name));
  });
}

describe("usesChildProcessAsValue", () => {
  it("flags every way to get child_process as a value", () => {
    for (const source of [
      'import { execFileSync } from "node:child_process";',
      "import { execFileSync } from 'child_process'",
      'import * as cp from "child_process";',
      'import {\n  execFileSync,\n} from "node:child_process";',
      'import { spawnSync, type execFileSync } from "node:child_process";',
      'const cp = await import("node:child_process");',
      'const cp = require("child_process");',
      'import type { A } from "./a.mts"\nimport { execFileSync } from "node:child_process"',
      'export { execFileSync } from "node:child_process";',
      'export * from "child_process";',
      'import cp, { type A } from "node:child_process";',
      'const cp = require(`child_process`);',
      '// see .github/workflows/**\nimport { execFileSync } from "node:child_process";\n/** doc */',
      'const g = ".github/workflows/*.yml";\nconst cp = require("child_process");\n/** x */',
      // An escaped quote doesn't end the string, so the `/*` inside it isn't a comment; with broken escapes it would swallow the import.
      'const s = "\\\\\\"/*";\nimport { execFileSync } from "node:child_process";\n/* x */',
      "const t = 'it\\'s /*';\nimport { execFileSync } from 'child_process';\n/* x */",
      // An apostrophe in a comment doesn't open a string.
      "/* it's */ import { execFileSync } from 'child_process'",
      "// it's\nimport { execFileSync } from 'child_process'",
      // A template literal holding a quote.
      'const t = `a "b`;\nimport { execFileSync } from "node:child_process";',
    ]) {
      assert.equal(usesChildProcessAsValue(source), true, source);
    }
  });

  it("accepts a type import and a commented-out one", () => {
    for (const source of [
      'import type { execFileSync } from "node:child_process";',
      'import { type execFileSync } from "node:child_process";',
      'import { type A, type B } from "node:child_process";',
      '// import { execFileSync } from "node:child_process";',
      '/* import { execFileSync } from "node:child_process"; */',
      'import { x } from "./x.mts";',
      'export type { A } from "node:child_process";',
      // An unterminated block comment hides what follows it, and unterminated input ends the walk instead of hanging it.
      'import { a } from "./a.mts"; /* import { execFileSync } from "node:child_process";',
      '// import { execFileSync } from "node:child_process"',
      'const s = "abc\\\\',
      'const s = "abc',
      'const s = "import { execFileSync } from \\"node:child_process\\"";',
    ]) {
      assert.equal(usesChildProcessAsValue(source), false, source);
    }
  });
});

describe("the host's calls", () => {
  it("never use child_process as a value outside host-limit.mts, so every gh and git call the host makes has a time limit", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const uses = readdirSync(dir)
      .filter((name) => name.endsWith(".mts") && !name.endsWith(".test.mts") && name !== "host-limit.mts")
      .filter((name) => usesChildProcessAsValue(readFileSync(new URL(name, dir), "utf8")));

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
