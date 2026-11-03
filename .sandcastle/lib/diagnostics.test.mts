import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { StalledStepError } from "./errors.mts";
import { logSandboxState, SANDBOX_PROBE } from "./diagnostics.mts";

type Exec = Pick<Sandbox, "exec">["exec"];
const sandboxOf = (exec: (command: string) => Promise<{ stdout: string; exitCode: number }>) =>
  ({ exec: exec as unknown as Exec }) as Pick<Sandbox, "exec">;

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
    const text = lines.join("\n");
    assert.match(text, /the reviewer failed/);
    assert.match(text, /Filesystem 90% used/);
    assert.match(text, /Mem: 100 free/);
  });

  it("asks for disk, memory, process count, biggest processes and core files", () => {
    for (const part of ["df", "free", "ps", "core"]) assert.ok(SANDBOX_PROBE.includes(part), part);
  });

  it("logs and returns when the probe throws, even a stalled step", async () => {
    for (const error of [new Error("docker exec failed"), new StalledStepError("stalled")]) {
      const lines: string[] = [];
      await logSandboxState(sandboxOf(async () => { throw error; }), "backend failed", (line) => lines.push(line));
      assert.match(lines.join("\n"), /probe failed/);
    }
  });

  it("logs a non-zero exit and still shows what it printed", async () => {
    const lines: string[] = [];
    await logSandboxState(sandboxOf(async () => ({ stdout: "sh: 0: Cannot fork", exitCode: 2 })), "x", (line) => lines.push(line));
    assert.match(lines.join("\n"), /exit 2/);
    assert.match(lines.join("\n"), /Cannot fork/);
  });

  it("scrubs what it logs", async () => {
    const lines: string[] = [];
    await logSandboxState(sandboxOf(async () => ({ stdout: "TOKEN=abc", exitCode: 0 })), "x", (line) => lines.push(line), (text) => text.replaceAll("abc", "***"));
    assert.ok(!lines.join("\n").includes("abc"));
  });
});
