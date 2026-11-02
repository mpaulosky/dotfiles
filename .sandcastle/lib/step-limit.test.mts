import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { GATE_COMMAND, GATE_LIMIT_MINUTES } from "./repo-config.mts";
import { StalledStepError } from "./errors.mts";
import { COMMAND_LIMIT_MINUTES, KILL_GRACE_SECONDS, limitSandboxExec, limitedCommand, stalledStepOf, stepName } from "./step-limit.mts";

type Answer = { stdout: string; exitCode: number };

// A sandbox whose exec records the command and options it was given and answers with `answer`.
function fakeSandbox(answer: Answer) {
  const calls: { command: string; options: unknown }[] = [];
  const sandbox = {
    worktreePath: "/work",
    state: "real",
    close(this: { state: string }) {
      return Promise.resolve(this.state);
    },
    exec: async (command: string, options?: unknown) => {
      calls.push({ command, options });
      return { stderr: "", ...answer };
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
}

// A clock that moves by `step` milliseconds each time it is read: a step reads it twice, so it appears to last `step`.
function clockOf(step: number) {
  let time = 0;
  return () => (time += step) - step;
}

describe("limitedCommand", () => {
  it("runs the command under timeout inside sh -c, so a redirection stays inside the limit", () => {
    assert.equal(limitedCommand("scripts/gate.sh 2>&1", 15), `timeout -k ${KILL_GRACE_SECONDS}s 15m sh -c 'scripts/gate.sh 2>&1'`);
  });

  it("takes the kill grace as a parameter", () => {
    assert.equal(limitedCommand("x", 1, 2), "timeout -k 2s 1m sh -c 'x'");
  });

  it("quotes a single quote in the command", () => {
    assert.equal(limitedCommand("git merge -m 'a b'", 10), `timeout -k ${KILL_GRACE_SECONDS}s 10m sh -c 'git merge -m '\\''a b'\\'''`);
  });
});

describe("stepName", () => {
  it("names the gate, with or without arguments or a redirection", () => {
    assert.equal(stepName(`${GATE_COMMAND} 2>&1`), "the gate");
    assert.equal(stepName(`  ${GATE_COMMAND}`), "the gate");
    assert.equal(stepName(GATE_COMMAND), "the gate");
  });

  it("doesn't name a longer file that starts like the gate as the gate", () => {
    assert.equal(stepName(`${GATE_COMMAND}-other --x`), `${GATE_COMMAND}-other --x`);
  });

  it("names any other command by its first words, with whitespace collapsed", () => {
    assert.equal(stepName("git   status\n--porcelain"), "git status --porcelain");
  });

  it("cuts a long command at 60 code points, never inside a surrogate pair", () => {
    const name = stepName(`${"a".repeat(59)}😀 and more`);

    assert.equal(name, `${"a".repeat(59)}😀`);
  });

  it("drops terminal control characters from the name", () => {
    assert.doesNotMatch(stepName("git merge -m 'x\u001b[31my'"), /\u001b/);
  });
});

describe("limitSandboxExec", () => {
  it("runs each command under its limit and logs the step's start and end under the prefix", async () => {
    const { sandbox, calls } = fakeSandbox({ stdout: "ok", exitCode: 0 });
    const lines: string[] = [];
    const limited = limitSandboxExec(sandbox, { log: (line) => lines.push(line), prefix: "feature/1: ", now: clockOf(2000) });

    const result = await limited.exec("git status --porcelain 2>&1");

    assert.deepEqual(calls.map((call) => call.command), [`timeout -k ${KILL_GRACE_SECONDS}s ${COMMAND_LIMIT_MINUTES}m sh -c 'git status --porcelain 2>&1'`]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok");
    assert.deepEqual(lines, [
      `feature/1: step start: git status --porcelain 2>&1 (limit ${COMMAND_LIMIT_MINUTES} minutes)`,
      "feature/1: step end: git status --porcelain 2>&1 (exit 0, 2s)",
    ]);
  });

  it("gives the gate the repo's gate limit, even with a leading space", async () => {
    const { sandbox, calls } = fakeSandbox({ stdout: "", exitCode: 0 });

    await limitSandboxExec(sandbox, { log: () => undefined }).exec(`  ${GATE_COMMAND} 2>&1`);

    assert.match(calls[0]!.command, new RegExp(`^timeout -k \\d+s ${GATE_LIMIT_MINUTES}m sh -c`));
  });

  it("fails a step that timeout killed after its limit, for both of timeout's exit codes, naming the step", async () => {
    for (const exitCode of [124, 137]) {
      const { sandbox } = fakeSandbox({ stdout: "partial output", exitCode });
      const lines: string[] = [];
      const limited = limitSandboxExec(sandbox, { log: (line) => lines.push(line), now: clockOf(GATE_LIMIT_MINUTES * 60_000) });

      const result = await limited.exec(`${GATE_COMMAND} 2>&1`);

      assert.equal(result.exitCode, 124);
      assert.equal(result.stdout, `partial output\n❌ The step "the gate" ran over its ${GATE_LIMIT_MINUTES}-minute limit and was killed.`);
      assert.deepEqual(lines, [
        `  step start: the gate (limit ${GATE_LIMIT_MINUTES} minutes)`,
        `  step killed: the gate ran over its ${GATE_LIMIT_MINUTES}-minute limit after ${GATE_LIMIT_MINUTES * 60}s`,
      ]);
    }
  });

  it("leaves a 124 or 137 that came back long before the limit alone, since the command ended itself or was killed by something else", async () => {
    for (const exitCode of [124, 137]) {
      const { sandbox } = fakeSandbox({ stdout: "Killed", exitCode });
      const lines: string[] = [];
      const limited = limitSandboxExec(sandbox, { log: (line) => lines.push(line), now: clockOf(20_000) });

      const result = await limited.exec(`${GATE_COMMAND} 2>&1`);

      assert.equal(result.exitCode, exitCode);
      assert.equal(result.stdout, "Killed");
      assert.equal(lines.at(-1), `  step end: the gate (exit ${exitCode}, 20s)`);
    }
  });

  it("leaves a command's own failure alone", async () => {
    const { sandbox } = fakeSandbox({ stdout: "boom", exitCode: 1 });

    const result = await limitSandboxExec(sandbox, { log: () => undefined }).exec("git merge main");

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "boom");
  });

  it("hands exec's options to the sandbox unchanged", async () => {
    const { sandbox, calls } = fakeSandbox({ stdout: "", exitCode: 0 });
    const options = { stdin: "in", cwd: "/w", sudo: true, onLine: () => undefined };

    await limitSandboxExec(sandbox, { log: () => undefined }).exec("cat", options);

    assert.equal(calls[0]!.options, options);
  });

  it("passes the error of an exec that rejects, with no end line", async () => {
    const lines: string[] = [];
    const sandbox = { exec: async () => Promise.reject(new Error("docker is gone")) } as unknown as Sandbox;

    await assert.rejects(limitSandboxExec(sandbox, { log: (line) => lines.push(line) }).exec("git status"), /docker is gone/);

    assert.deepEqual(lines, [`  step start: git status (limit ${COMMAND_LIMIT_MINUTES} minutes)`]);
  });

  it("passes every other member through, a method bound to the real sandbox", async () => {
    const { sandbox } = fakeSandbox({ stdout: "", exitCode: 0 });
    const limited = limitSandboxExec(sandbox, { log: () => undefined });

    assert.equal(limited.worktreePath, "/work");
    assert.equal(await limited.close(), "real");
  });

  it("throws on every later exec after a command other than the gate ran over its limit, so a stalled sandbox costs one limit", async () => {
    const { sandbox, calls } = fakeSandbox({ stdout: "", exitCode: 124 });
    const lines: string[] = [];
    const limited = limitSandboxExec(sandbox, { log: (line) => lines.push(line), now: clockOf(COMMAND_LIMIT_MINUTES * 60_000) });

    const first = await limited.exec("git fetch");

    assert.match(first.stdout, /ran over its 10-minute limit/);
    assert.equal(stalledStepOf(limited), "git fetch");
    await assert.rejects(
      limited.exec("git status"),
      (error: unknown) =>
        error instanceof StalledStepError && /^The step "git status" wasn't run: the step "git fetch" didn't end at its limit/.test(error.message),
    );
    assert.equal(calls.length, 1, "the second command reached the sandbox");
    assert.match(lines.at(-1)!, /step refused: git status/);
  });

  it("lets the gate run again after a gate that timeout killed, since the kill was clean", async () => {
    const { sandbox, calls } = fakeSandbox({ stdout: "", exitCode: 124 });
    const limited = limitSandboxExec(sandbox, { log: () => undefined, now: clockOf(GATE_LIMIT_MINUTES * 60_000) });

    await limited.exec(`${GATE_COMMAND} 2>&1`);
    await limited.exec(`${GATE_COMMAND} 2>&1`);

    assert.equal(calls.length, 2);
    assert.equal(stalledStepOf(limited), undefined);
  });

  it("throws on every later exec after the host gave up on one, since its command may still be running", async () => {
    let started = 0;
    const sandbox = { exec: () => (started++, new Promise(() => undefined)) } as unknown as Sandbox;
    const limited = limitSandboxExec(sandbox, { log: () => undefined, commandMinutes: 0.001, graceSeconds: 0, backstopSlackSeconds: 0.05 });

    await limited.exec("git fetch");

    assert.equal(stalledStepOf(limited), "git fetch");
    await assert.rejects(limited.exec("git status"), StalledStepError);
    assert.equal(started, 1);
  });

  it("refuses a limit timeout or the host's timer can't hold: zero, negative, NaN, infinite or past setTimeout's ceiling", () => {
    const { sandbox } = fakeSandbox({ stdout: "", exitCode: 0 });

    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      assert.throws(() => limitSandboxExec(sandbox, { graceSeconds: bad }), /graceSeconds must be a number of seconds/, String(bad));
      assert.throws(() => limitSandboxExec(sandbox, { backstopSlackSeconds: bad }), /backstopSlackSeconds must be a number of seconds/, String(bad));
    }
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      assert.throws(() => limitSandboxExec(sandbox, { gateMinutes: bad }), /GATE_LIMIT_MINUTES must be a positive number/, String(bad));
      assert.throws(() => limitSandboxExec(sandbox, { commandMinutes: bad }), /COMMAND_LIMIT_MINUTES must be a positive number/, String(bad));
    }
  });

  it("measures a step on a monotonic clock, so a wall-clock step during it doesn't hide the kill", async (t) => {
    let wall = 0;
    t.mock.method(Date, "now", () => (wall -= 1e7));
    const sandbox = {
      exec: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { stdout: "", stderr: "", exitCode: 124 };
      },
    } as unknown as Sandbox;
    const limited = limitSandboxExec(sandbox, { log: () => undefined, commandMinutes: 0.0001 });

    const result = await limited.exec("git fetch");

    assert.match(result.stdout, /ran over its/);
  });

  it("gives up on an exec that never returns, a little after the limit and the kill grace", async () => {
    const sandbox = { exec: () => new Promise(() => undefined) } as unknown as Sandbox;
    const lines: string[] = [];
    const limited = limitSandboxExec(sandbox, {
      log: (line) => lines.push(line),
      commandMinutes: 0.001,
      graceSeconds: 0,
      backstopSlackSeconds: 0.05,
    });

    const result = await limited.exec("git fetch");

    assert.equal(result.exitCode, 124);
    assert.match(result.stdout, /^❌ The step "git fetch" didn't return within its 0\.001-minute limit and the kill grace, so the host gave up on it\.$/);
    assert.match(lines.at(-1)!, /^ {2}step gave up: git fetch/);
  });
});

// The real thing: `timeout` and `sh` on this machine, behind an exec that spawns them as the sandbox's does.
const hasTimeout = spawnSync("timeout", ["--version"]).status === 0;

describe("limitSandboxExec against a real timeout", { skip: !hasTimeout && "GNU coreutils' timeout isn't installed" }, () => {
  function shellSandbox() {
    return {
      exec: (command: string) =>
        new Promise((resolve) => {
          execFile("sh", ["-c", command], (error, stdout, stderr) => {
            // A process killed by SIGKILL has no exit code: docker exec reports it as 128 + 9, and so does this.
            const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : error.signal === "SIGKILL" ? 137 : 1;
            resolve({ stdout, stderr, exitCode });
          });
        }),
    } as unknown as Sandbox;
  }
  const quick = { log: () => undefined, commandMinutes: 0.01, graceSeconds: 1 };

  it("kills a command that never ends at its limit", async () => {
    const started = Date.now();

    const result = await limitSandboxExec(shellSandbox(), quick).exec("sleep 60");

    assert.equal(result.exitCode, 124);
    assert.match(result.stdout, /ran over its 0\.01-minute limit and was killed/);
    assert.ok(Date.now() - started < 10_000, "the command was not killed at its limit");
  });

  it("kills a command that ignores TERM after the grace, and a child it left running", async () => {
    const started = Date.now();

    const result = await limitSandboxExec(shellSandbox(), quick).exec("trap '' TERM; sleep 60 & wait");

    assert.equal(result.exitCode, 124);
    assert.ok(Date.now() - started < 15_000, "the command was not killed after the grace");
  });

  it("lets a command that finishes in time return its own output", async () => {
    const result = await limitSandboxExec(shellSandbox(), quick).exec("echo done");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "done\n");
  });
});
