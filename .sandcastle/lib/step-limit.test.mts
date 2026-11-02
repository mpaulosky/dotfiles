import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { GATE_COMMAND } from "./repo-config.mts";
import { COMMAND_LIMIT_MINUTES, GATE_LIMIT_MINUTES, limitSandboxExec, limitedCommand, limitFor, stepName } from "./step-limit.mts";

// A sandbox whose exec records the command it was given and answers with `answer`.
function fakeSandbox(answer: { stdout: string; exitCode: number }) {
  const commands: string[] = [];
  const sandbox = {
    worktreePath: "/work",
    exec: async (command: string) => {
      commands.push(command);
      return { stderr: "", ...answer };
    },
  } as unknown as Sandbox;
  return { sandbox, commands };
}

describe("limitedCommand", () => {
  it("runs the command under timeout inside sh -c, so a redirection stays inside the limit", () => {
    assert.equal(limitedCommand("scripts/gate.sh 2>&1", 10), "timeout -k 30s 10m sh -c 'scripts/gate.sh 2>&1'");
  });

  it("quotes a single quote in the command", () => {
    assert.equal(limitedCommand("git merge -m 'a b'", 10), `timeout -k 30s 10m sh -c 'git merge -m '\\''a b'\\'''`);
  });
});

describe("limitFor and stepName", () => {
  it("gives the gate its own limit and names it", () => {
    assert.equal(limitFor(`${GATE_COMMAND} 2>&1`), GATE_LIMIT_MINUTES);
    assert.equal(stepName(`${GATE_COMMAND} 2>&1`), "the gate");
  });

  it("gives any other command the command limit and names it by its first words", () => {
    assert.equal(limitFor("git status --porcelain 2>&1"), COMMAND_LIMIT_MINUTES);
    assert.equal(stepName("git   status\n--porcelain"), "git status --porcelain");
  });
});

describe("limitSandboxExec", () => {
  it("runs each command under its limit and logs the step's start and end", async () => {
    const { sandbox, commands } = fakeSandbox({ stdout: "ok", exitCode: 0 });
    const lines: string[] = [];
    let clock = 0;
    const limited = limitSandboxExec(sandbox, (line) => lines.push(line), () => (clock += 2000));

    const result = await limited.exec("git status --porcelain 2>&1");

    assert.deepEqual(commands, [`timeout -k 30s ${COMMAND_LIMIT_MINUTES}m sh -c 'git status --porcelain 2>&1'`]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok");
    assert.deepEqual(lines, [
      `  step start: git status --porcelain 2>&1 (limit ${COMMAND_LIMIT_MINUTES} minutes)`,
      "  step end: git status --porcelain 2>&1 (exit 0, 2s)",
    ]);
  });

  it("fails a gate that timeout killed, naming the step, for both of timeout's exit codes", async () => {
    for (const exitCode of [124, 137]) {
      const { sandbox } = fakeSandbox({ stdout: "partial output", exitCode });
      const lines: string[] = [];
      const limited = limitSandboxExec(sandbox, (line) => lines.push(line));

      const result = await limited.exec(`${GATE_COMMAND} 2>&1`);

      assert.equal(result.exitCode, 124);
      assert.match(result.stdout, /^partial output\n❌ The step "the gate" ran over its 10-minute limit and was killed\.$/);
      assert.ok(lines.some((line) => line.startsWith("  step killed: the gate")), `no killed line for exit ${exitCode}`);
    }
  });

  it("leaves a command's own failure alone", async () => {
    const { sandbox } = fakeSandbox({ stdout: "boom", exitCode: 1 });
    const limited = limitSandboxExec(sandbox, () => undefined);

    const result = await limited.exec("git merge main");

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "boom");
  });

  it("passes every other member of the sandbox through", () => {
    const { sandbox } = fakeSandbox({ stdout: "", exitCode: 0 });

    assert.equal(limitSandboxExec(sandbox, () => undefined).worktreePath, "/work");
  });
});
