import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const hasPs = spawnSync("ps", ["-e"]).error === undefined;

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
    for (const header of ["== disk ==", "== memory ==", "== processes ==", "== zombies ==", "== process limits ==", "== biggest processes", "== core files =="]) {
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

  it("counts a zombie, which a PID 1 that never waits leaves for every orphan", { skip: (process.platform !== "linux" || !hasPs) && "needs ps on Linux" }, async () => {
    // The shell backgrounds a subshell that exits at once, then becomes `sleep`, which never waits for it: the subshell stays a
    // zombie, a child of `sleep`, for the five seconds `sleep` runs.
    const parent = spawn("sh", ["-c", "(true) & exec sleep 5"], { stdio: "ignore" });
    try {
      // The test's own zombie, found by its parent, so the wait is for what the test made and not for the machine's count to change.
      const ownZombies = () =>
        spawnSync("ps", ["-eo", "ppid=,stat="], { encoding: "utf8" })
          .stdout.split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter(([ppid, stat]) => Number(ppid) === parent.pid && stat?.startsWith("Z")).length;
      for (const deadline = Date.now() + 4_000; ownZombies() < 1 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(ownZombies(), 1, "the test's own zombie never appeared");

      // The test's count of every zombie, from `ps` alone. The probe's count must lie between two of these taken around it, which a count of
      // some other state (a sleeping `sleep` is also running now) does not. Other zombies can come and go meanwhile, so a miss is tried again.
      const counted = () => spawnSync("ps", ["-eo", "stat="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.startsWith("Z")).length;
      let last = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const low = counted();
        const run = spawnSync("sh", ["-c", PROBE_SCRIPT], { encoding: "utf8" });
        const high = counted();
        assert.equal(run.status, 0, run.stderr);
        const probed = Number(/== zombies ==\n(\d+)\n/.exec(run.stdout)?.[1]);
        if (probed >= 1 && probed >= Math.min(low, high) && probed <= Math.max(low, high)) return;
        last = `the probe counted ${probed} zombies, ps counted ${low} before and ${high} after`;
      }
      assert.fail(last);
    } finally {
      parent.kill();
    }
  });

  it("says so when ps is missing, not that there are no zombies", { skip: process.platform !== "linux" && "needs /bin/sh" }, () => {
    const run = spawnSync("/bin/sh", ["-c", PROBE_SCRIPT], { encoding: "utf8", env: { PATH: "/nonexistent" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /== zombies ==\nn\/a \(no ps\)\n/);
  });

  it("prints the limits that decide whether a fork can succeed", { skip: process.platform !== "linux" && "needs /proc" }, () => {
    const run = spawnSync("sh", ["-c", PROBE_SCRIPT], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /== process limits ==\nMax processes +\S+ +\S+ +processes *\n/);
  });

  it("prints each cgroup pids file that exists, under its own name, and nothing for one it lacks", { skip: process.platform === "win32" && "needs sh" }, () => {
    const root = mkdtempSync(join(tmpdir(), "probe-cgroup-"));
    try {
      const dir = join(root, "all");
      mkdirSync(join(dir, "pids"), { recursive: true });
      writeFileSync(join(dir, "pids.current"), "17386\n");
      writeFileSync(join(dir, "pids.max"), "max\n");
      writeFileSync(join(dir, "pids", "pids.current"), "3\n");
      writeFileSync(join(dir, "pids", "pids.max"), "4194304\n");
      // A machine can have only some of the files (v1 has the pids folder, v2 the top-level two), here just one.
      const some = join(root, "some");
      mkdirSync(join(some, "pids"), { recursive: true });
      writeFileSync(join(some, "pids", "pids.max"), "max\n");
      const section = (cgroupRoot: string) => {
        const run = spawnSync("sh", ["-c", PROBE_SCRIPT], { encoding: "utf8", env: { ...process.env, CGROUP_ROOT: cgroupRoot } });
        assert.equal(run.status, 0, run.stderr);
        return run.stdout.slice(run.stdout.indexOf("== process limits =="), run.stdout.indexOf("== biggest processes")).split("\n").filter((line) => line.startsWith("pids"));
      };
      assert.deepEqual(section(dir), ["pids.current: 17386", "pids.max: max", "pids/pids.current: 3", "pids/pids.max: 4194304"]);
      assert.deepEqual(section(some), ["pids/pids.max: max"]);
      assert.deepEqual(section(join(root, "none")), []);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("runs through the sandbox's own wrapper under a real sh, so its re-quoting leaves the script whole", { skip: (!hasTimeout || process.platform === "win32") && "needs GNU timeout and sh" }, () => {
    const run = spawnSync("sh", ["-c", limitedCommand(SANDBOX_PROBE, 1)], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    for (const header of ["== disk ==", "== memory ==", "== processes ==", "== zombies ==", "== process limits ==", "== biggest processes", "== core files =="]) {
      assert.ok(run.stdout.includes(header), `${header} in ${run.stdout}`);
    }
  });
});
