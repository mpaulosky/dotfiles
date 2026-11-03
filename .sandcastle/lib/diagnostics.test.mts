import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { logSandboxState, PROBE_SCRIPT, PROBE_SECONDS, SANDBOX_PROBE } from "./diagnostics.mts";
import { limitedCommand } from "./step-limit.mts";

type Exec = Pick<Sandbox, "exec">["exec"];
type Result = { stdout: string; stderr?: string; exitCode: number };
const sandboxOf = (exec: (command: string) => Promise<Result>) =>
  ({ exec: (async (command: string) => ({ stderr: "", ...(await exec(command)) })) as unknown as Exec }) as Pick<Sandbox, "exec">;

const hasTimeout = spawnSync("timeout", ["--version"]).status === 0;

describe("logSandboxState", () => {
  it("logs the probe's output under the reason", async () => {
    const lines: string[] = [];
    const commands: string[] = [];
    await logSandboxState(
      sandboxOf(async (command) => {
        commands.push(command);
        return { stdout: "Filesystem 90% used\nMem: 100 free\n", exitCode: 0 };
      }),
      "the reviewer failed",
      (line) => lines.push(line),
    );
    assert.deepEqual(commands, [SANDBOX_PROBE]);
    assert.equal(lines.join("\n"), "sandbox state (the reviewer failed):\nFilesystem 90% used\nMem: 100 free");
  });

  it("logs and returns when the probe throws, even a stalled step", async () => {
    for (const error of [new Error("docker exec failed"), new StalledStepError("stalled")]) {
      const lines: string[] = [];
      await logSandboxState(sandboxOf(async () => { throw error; }), "backend failed", (line) => lines.push(line));
      assert.match(lines.join("\n"), /probe failed/);
    }
  });

  it("logs stderr, where a shell that can't fork says so, and the exit code", async () => {
    const lines: string[] = [];
    await logSandboxState(sandboxOf(async () => ({ stdout: "", stderr: "sh: 0: Cannot fork", exitCode: 2 })), "x", (line) => lines.push(line));
    assert.equal(lines.join("\n"), "sandbox state (x) (exit 2):\nsh: 0: Cannot fork");
  });

  it("says when the probe printed nothing", async () => {
    const lines: string[] = [];
    await logSandboxState(sandboxOf(async () => ({ stdout: "", exitCode: 0 })), "x", (line) => lines.push(line));
    assert.match(lines.join("\n"), /\(no output\)/);
  });

  it("says the probe timed out on exit 124, and only that it was killed on 137, which an out-of-memory kill returns too", async () => {
    const say = async (exitCode: number) => {
      const lines: string[] = [];
      await logSandboxState(sandboxOf(async () => ({ stdout: "partial", exitCode })), "x", (line) => lines.push(line));
      return lines.join("\n");
    };
    assert.match(await say(124), /exit 124: the probe timed out/);
    assert.match(await say(137), /exit 137: the probe was killed, by its timeout or by the kernel/);
    assert.ok(!/timed out/.test(await say(137)));
  });

  it("scrubs what the sandbox printed and the error text, not the host's reason", async () => {
    const scrub = (text: string) => text.replaceAll("abc", "***");
    const printed: string[] = [];
    await logSandboxState(sandboxOf(async () => ({ stdout: "TOKEN=abc", stderr: "abc", exitCode: 0 })), "abc role", (line) => printed.push(line), scrub);
    assert.equal(printed.join("\n"), "sandbox state (abc role):\nTOKEN=***\n***");
    const failed: string[] = [];
    await logSandboxState(sandboxOf(async () => { throw new Error("abc"); }), "x", (line) => failed.push(line), scrub);
    assert.equal(failed.join("\n"), "sandbox state (x): the probe failed:\nError: ***");
  });
});

describe("logSandboxState when the scrub or the log throws", () => {
  it("still returns, with a line that holds nothing from the sandbox, when the scrub throws", async () => {
    const printed: string[] = [];
    const scrub = () => { throw new Error("scrub broke"); };
    await logSandboxState(sandboxOf(async () => ({ stdout: "x", stderr: "", exitCode: 0 })), "r", (line) => printed.push(line), scrub);
    await logSandboxState(sandboxOf(async () => { throw new Error("exec broke"); }), "r", (line) => printed.push(line), scrub);
    assert.equal(printed.length, 2);
    for (const line of printed) assert.equal(line, "sandbox state (r): the probe failed, and its output could not be logged");
  });

  it("returns when the log itself throws", async () => {
    await assert.doesNotReject(logSandboxState(sandboxOf(async () => ({ stdout: "x", stderr: "", exitCode: 0 })), "r", () => { throw new Error("log broke"); }));
  });
});

describe("SANDBOX_PROBE", () => {
  it("runs under its own short timeout, far below the sandbox's command limit", () => {
    assert.ok(SANDBOX_PROBE.startsWith(`timeout -k 2 ${PROBE_SECONDS} sh -c '`));
    assert.equal(PROBE_SECONDS, 20);
  });

  it("lists at most ten core files", { skip: process.platform === "win32" && "needs sh" }, () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "probe-cap-")));
    try {
      for (let n = 1; n <= 12; n++) writeFileSync(join(dir, `core.${n}`), "x");
      const here = PROBE_SCRIPT.replace('find / "$PWD" /tmp -xdev', 'find "$PWD" -xdev');
      const run = spawnSync("sh", ["-c", here], { cwd: dir, encoding: "utf8" });
      const listed = run.stdout.slice(run.stdout.indexOf("== core files ==")).split("\n").filter((line) => line.startsWith(dir));
      assert.equal(listed.length, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("holds no single quote inside the script, so it survives the sandbox's own quoting", () => {
    const script = SANDBOX_PROBE.slice(SANDBOX_PROBE.indexOf("sh -c '") + "sh -c '".length, -1);
    assert.ok(!script.includes("'"));
  });

  it("runs the script under a real sh: exits 0 and prints every section", { skip: process.platform === "win32" && "needs sh" }, () => {
    const run = spawnSync("sh", ["-c", PROBE_SCRIPT], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    for (const header of ["== disk ==", "== memory ==", "== processes ==", "== biggest processes", "== core files =="]) {
      assert.ok(run.stdout.includes(header), `${header} in ${run.stdout}`);
    }
  });

  it("lists core and core.<pid> within 4 levels of the working directory, nothing deeper, and not core.js", { skip: process.platform === "win32" && "needs sh" }, () => {
    // The script searches /, the working directory and /tmp and keeps ten lines, so a stray core file elsewhere on the machine
    // could push a fixture out of the list: this runs its find over the fixture folder alone, with the bound and the cap unchanged.
    assert.ok(PROBE_SCRIPT.includes('find / "$PWD" /tmp -xdev -maxdepth 4 '));
    assert.ok(PROBE_SCRIPT.includes("| sort -u | head -n 10"));
    const here = PROBE_SCRIPT.replace('find / "$PWD" /tmp -xdev', 'find "$PWD" -xdev');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "probe-")));
    try {
      for (const name of ["core", "core.123", "core.js", "empty/core", "a/b/c/core", "a/b/c/d/core"]) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), name === "empty/core" ? "" : "x");
      }
      mkdirSync(join(dir, "dir", "core"), { recursive: true });
      const run = spawnSync("sh", ["-c", here], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const listed = run.stdout.slice(run.stdout.indexOf("== core files ==")).split("\n");
      for (const name of ["core", "core.123", "a/b/c/core"]) assert.ok(listed.includes(join(dir, name)), `${name} in ${listed.join("\n")}`);
      for (const name of ["core.js", "empty/core", "dir/core", "a/b/c/d/core"]) assert.ok(!listed.includes(join(dir, name)), `${name} in ${listed.join("\n")}`);
      assert.equal(listed.filter((line) => line === join(dir, "core")).length, 1, "a file listed twice");
      // -xdev (a core file on another mount is not searched) needs a second mount to test, which a unit test can't make.
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("runs through the sandbox's own wrapper under a real sh, so its re-quoting leaves the script whole", { skip: (!hasTimeout || process.platform === "win32") && "needs GNU timeout and sh" }, () => {
    const run = spawnSync("sh", ["-c", limitedCommand(SANDBOX_PROBE, 1)], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    for (const header of ["== disk ==", "== memory ==", "== processes ==", "== biggest processes", "== core files =="]) {
      assert.ok(run.stdout.includes(header), `${header} in ${run.stdout}`);
    }
  });
});
