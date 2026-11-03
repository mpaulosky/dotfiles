import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { spawn } from "node:child_process";
import { DOCKER_CALL_LIMIT_MINUTES, STALL_EXIT_GRACE_SECONDS, hostCallHasBeenAbandoned, exitAfterStall, markHostCallAbandoned, HOST_COMMAND_LIMIT_MINUTES, closeAfterWork, closeWithinLimit, hostExecFileSync, hostExecOptions, withinDockerLimit } from "./host-limit.mts";

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

  it("logs a close the host gave up on and returns, so the work's outcome stands (exitAfterStall ends the run red)", async () => {
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
      // An unterminated block comment hides what follows it.
      'import { a } from "./a.mts"; /* import { execFileSync } from "node:child_process";',
      '// import { execFileSync } from "node:child_process"',
      // Hang guards, not behaviour checks: a string with no closing quote, whether the input ends in a single backslash, a pair or neither,
      // must end the walk instead of looping. There is no import after it to find either way.
      'const s = "abc\\',
      'const s = "abc\\\\',
      'const s = "abc',
      'const s = "import { execFileSync } from \\"node:child_process\\"";',
    ]) {
      assert.equal(usesChildProcessAsValue(source), false, source);
    }
  });
});

describe("the host's calls", () => {
  it("never use child_process as a value outside host-limit.mts, so every gh, git and docker info call the host makes has a time limit", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const uses = readdirSync(dir)
      .filter((name) => name.endsWith(".mts") && !name.endsWith(".test.mts") && name !== "host-limit.mts")
      .filter((name) => usesChildProcessAsValue(readFileSync(new URL(name, dir), "utf8")));

    // git-sandbox-fake.mts is a test helper that runs shell setup, not the host's gh, git or docker info. review-ledger.mts and security-record.mts
    // also run on the host, in-process (lib/host-review.mts calls prepareRound and recordReview), so their git calls are limited too.
    assert.deepEqual(uses.filter((name) => !["git-sandbox-fake.mts"].includes(name)), []);
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

// Runs `body` as an ES module in a child Node process (with tsx, so it can import the .mts modules) that has host-limit.mts's exports in
// scope, and reports how it ended. A child that outlives `killAfterMs` is killed, so a regression fails the test and doesn't hang the suite.
const runChild = async (body: string, killAfterMs = 25_000) => {
  const hostLimit = new URL("./host-limit.mts", import.meta.url).href;
  const stepLimit = new URL("./step-limit.mts", import.meta.url).href;
  const script = [
    `import { closeAfterWork, exitAfterStall, markHostCallAbandoned, withinDockerLimit } from ${JSON.stringify(hostLimit)};`,
    `import { limitSandboxExec } from ${JSON.stringify(stepLimit)};`,
    body,
  ].join("\n");
  const started = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "--import", import.meta.resolve("tsx"), "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const killer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
  // "close", not "exit": stderr may still hold unread data when the child has exited.
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(killer);
  return { code, stderr, elapsed: Date.now() - started };
};

const stallDockerCall = 'await withinDockerLimit("creating the sandbox", new Promise(() => undefined), 0.001).catch(() => undefined);';

describe("exitAfterStall", () => {
  it("waits ten seconds by default", () => {
    assert.equal(STALL_EXIT_GRACE_SECONDS, 10);
  });

  it("calls exit with the run's code after the grace period once the host gave up on a call, and names the call", async () => {
    await assert.rejects(() => withinDockerLimit("creating the sandbox", never(), 0.001), StalledStepError);
    markHostCallAbandoned("the sandbox exec \"git\u0007fetch\"");
    assert.equal(hostCallHasBeenAbandoned(), true);
    const before = process.exitCode;
    try {
      for (const [set, expected] of [[4, 4]] as const) {
        process.exitCode = set;
        const exits: number[] = [];
        const logged: string[] = [];
        exitAfterStall(0.01, (code) => void exits.push(code), (line) => void logged.push(line));
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.deepEqual(exits, [expected]);
        assert.match(logged.join("\n"), /gave up on \d+ calls?.*creating the sandbox.*the sandbox exec "git fetch"/);
        assert.doesNotMatch(logged.join("\n"), /\u0007/);
      }
    } finally {
      process.exitCode = before;
    }
  });

  it("ends a process that a referenced handle keeps running after the host gave up on a Docker call, with the code the run set", async () => {
    const { code, stderr, elapsed } = await runChild([stallDockerCall, "setTimeout(() => undefined, 30_000);", "process.exitCode = 3;", "exitAfterStall(0.3);"].join("\n"));

    assert.equal(code, 3, stderr);
    assert.match(stderr, /^ {2}⚠ ending the run 0\.3s after its cleanup\. The host gave up on 1 call.*creating the sandbox/m);
    assert.equal((stderr.match(/gave up on/g) ?? []).length, 1, stderr);
    assert.equal((stderr.match(/⚠/g) ?? []).length, 1, stderr);
    assert.ok(elapsed < 20_000, `took ${elapsed} ms`);
  });

  it("ends a process that a sandbox exec the host gave up on keeps running", async () => {
    const body = [
      "const sandbox = { exec: () => new Promise(() => undefined) };",
      'const limited = limitSandboxExec(sandbox, { log: () => undefined, commandMinutes: 0.001, graceSeconds: 0.001, backstopSlackSeconds: 0.05 });',
      'await limited.exec("git fetch").catch(() => undefined);',
      "setTimeout(() => undefined, 30_000);",
      "process.exitCode = 3;",
      "exitAfterStall(0.3);",
    ].join("\n");
    const { code, stderr, elapsed } = await runChild(body);

    assert.equal(code, 3, stderr);
    assert.match(stderr, /the sandbox exec "git fetch"/);
    assert.equal((stderr.match(/gave up on/g) ?? []).length, 1, stderr);
    assert.ok(elapsed < 20_000, `took ${elapsed} ms`);
  });

  it("doesn't hold a process that has nothing else running for the grace period: its timer is unref'd", async () => {
    const { code, stderr, elapsed } = await runChild([stallDockerCall, "exitAfterStall(60);"].join("\n"));

    assert.equal(code, 0, stderr);
    assert.match(stderr, /^ {2}⚠ The host gave up on 1 call.*creating the sandbox/m, "the exit listener didn't print the warning");
    assert.equal((stderr.match(/gave up on/g) ?? []).length, 1, stderr);
    assert.ok(elapsed < 20_000, `took ${elapsed} ms`);
  });

  it("leaves a process alone when the host gave up on nothing", async () => {
    const { code, stderr, elapsed } = await runChild(["setTimeout(() => undefined, 2000);", "exitAfterStall(0.2);"].join("\n"));

    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.ok(elapsed >= 1800, `ended after ${elapsed} ms, before its own 2-second timer`);
  });

  it("removes format and line-separator characters from a call's name too", async () => {
    const logged: string[] = [];
    const before = process.exitCode; // an earlier test may have made a close end the run red, which exitAfterStall sets
    markHostCallAbandoned("bidi\u202Eand\u2028line\u200Bbreak");
    exitAfterStall(0.01, () => undefined, (line) => void logged.push(line));
    process.exitCode = before;
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.match(logged.join("\n"), /bidi and line break/);
    assert.doesNotMatch(logged.join("\n"), /[\u202E\u2028\u200B]/);
  });

  it("names the abandoned calls when the process exits before exitAfterStall runs, such as on a crash", async () => {
    const { code, stderr } = await runChild([stallDockerCall, 'throw new Error("crashed after the stall");'].join("\n"));

    assert.equal(code, 1);
    assert.match(stderr, /gave up on 1 call.*creating the sandbox/);
    assert.equal((stderr.match(/gave up on/g) ?? []).length, 1, stderr);
  });

  it("removes format and line-separator characters from a failing onLate's message too", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    let resolveCall: (value: string) => void = () => undefined;
    const call = new Promise<string>((resolve) => (resolveCall = resolve));

    await assert.rejects(
      () => withinDockerLimit("creating the sandbox", call, 0.001, () => { throw new Error("bad\u202Ething\u2028here"); }),
      StalledStepError,
    );
    resolveCall("a sandbox");
    await call;
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(logged.join("\n"), /handling the late answer failed: Error: bad thing here/);
    assert.doesNotMatch(logged.join("\n"), /[\u202E\u2028]/);
  });

  it("prints the warning ahead of an exit listener registered before the first call was abandoned", async () => {
    const body = ['process.on("exit", () => console.error("EARLIER-REGISTERED-LISTENER"));', stallDockerCall].join("\n");
    const { code, stderr } = await runChild(body);

    assert.equal(code, 0, stderr);
    const warning = stderr.indexOf("gave up on");
    const earlier = stderr.indexOf("EARLIER-REGISTERED-LISTENER");
    assert.ok(warning !== -1 && earlier !== -1, stderr);
    assert.ok(warning < earlier, `the warning came after the listener registered before it:\n${stderr}`);
  });

  it("exits with 0 when the run set no code and no close was given up on", async () => {
    const { code, stderr } = await runChild([stallDockerCall, "setTimeout(() => undefined, 30_000);", "exitAfterStall(0.3);"].join("\n"));

    assert.equal(code, 0, stderr);
  });

  const hungClose = 'const hangs = { close: () => new Promise(() => undefined) };';
  const giveUpOnClose = (stalled: boolean) => `await closeAfterWork(hangs, { stalled: ${stalled}, minutes: 0.001, log: (line) => console.error(line) });`;

  it("ends the run red when a close was given up on after finished work, whether the forced exit or the process's own end comes first", async () => {
    for (const tail of ["setTimeout(() => undefined, 30_000);\nexitAfterStall(0.3);", "exitAfterStall(60);"]) {
      const { code, stderr } = await runChild([hungClose, giveUpOnClose(false), tail].join("\n"));

      // The give-up was logged by closeAfterWork and didn't throw: a crash would exit 1 as well.
      assert.match(stderr, /may still be running, so the run ends red/);
      assert.doesNotMatch(stderr, /\n\s+at /, "the child crashed");
      assert.equal(code, 1, stderr);
    }
  });

  it("ends the run red when the run set its code to 0 explicitly, as main.mts does on a green run", async () => {
    for (const tail of ["setTimeout(() => undefined, 30_000);\nexitAfterStall(0.3);", "exitAfterStall(60);"]) {
      const { code, stderr } = await runChild([hungClose, giveUpOnClose(false), "process.exitCode = 0;", tail].join("\n"));

      assert.equal(code, 1, stderr);
    }
  });

  it("keeps a failing exit code the run already set when a close was given up on", async () => {
    const { code, stderr } = await runChild([hungClose, giveUpOnClose(false), "process.exitCode = 3;", "exitAfterStall(60);"].join("\n"));

    assert.equal(code, 3, stderr);
  });

  it("doesn't turn a run green into red for the close of a sandbox that already stalled, since its StalledStepError ends the run", async () => {
    const { code, stderr } = await runChild([hungClose, giveUpOnClose(true), "exitAfterStall(60);"].join("\n"));

    assert.equal(code, 0, stderr);
  });
});
