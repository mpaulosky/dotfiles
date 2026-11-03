import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { logSandboxState, PROBE_SECONDS, SANDBOX_PROBE } from "./diagnostics.mts";

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

  it("says the probe timed out on exit 124 and 137", async () => {
    for (const exitCode of [124, 137]) {
      const lines: string[] = [];
      await logSandboxState(sandboxOf(async () => ({ stdout: "partial", exitCode })), "x", (line) => lines.push(line));
      assert.match(lines.join("\n"), new RegExp(`exit ${exitCode}: the probe timed out`));
    }
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

describe("SANDBOX_PROBE", () => {
  it("runs under its own short timeout, far below the sandbox's command limit", () => {
    assert.ok(SANDBOX_PROBE.startsWith(`timeout -k 2 ${PROBE_SECONDS} sh -c '`));
    assert.ok(PROBE_SECONDS <= 30);
  });

  it("holds no single quote inside the script, so it survives the sandbox's own quoting", () => {
    const script = SANDBOX_PROBE.slice(SANDBOX_PROBE.indexOf("sh -c '") + "sh -c '".length, -1);
    assert.ok(!script.includes("'"));
  });

  it("runs under a real sh: exits 0, prints every section, lists core and core.<pid> but not core.js", { skip: !hasTimeout && "needs GNU timeout" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    try {
      for (const name of ["core", "core.123", "core.js"]) writeFileSync(join(dir, name), "x");
      const run = spawnSync("sh", ["-c", SANDBOX_PROBE], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      for (const header of ["== disk ==", "== memory ==", "== processes ==", "== biggest processes", "== core files =="]) {
        assert.ok(run.stdout.includes(header), `${header} in ${run.stdout}`);
      }
      const cores = run.stdout.slice(run.stdout.indexOf("== core files =="));
      assert.ok(cores.includes(join(dir, "core.123")), cores);
      assert.ok(/\/core$/m.test(cores), cores);
      assert.ok(!cores.includes("core.js"), cores);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
