import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { changedFiles, gateFailureComment, gateScriptChange, runCheckpoint, runGate, tail, type Checkpoint, type GateRun } from "./checkpoint.mts";
import { GATE_COMMAND, GATE_SCRIPT } from "./repo-config.mts";

// These tests name the Template's gate command, whatever this repo's
// GATE_COMMAND is: the fake sandbox reports the configured one as the default.
const asDefaultGate = (command: string) => (command === `${GATE_COMMAND} 2>&1` ? "scripts/gate.sh 2>&1" : command);

const red = (output = "error CS1002: ; expected"): GateRun => ({ passed: false, output });
const green: GateRun = { passed: true, output: "Gate passed" };

// Steps that return the queued gate results in order and record every call.
function steps(gateResults: GateRun[], fix: (checkpoint: Checkpoint, output: string) => Promise<unknown> = async () => {}) {
  const calls: string[] = [];
  return {
    calls,
    gate: async () => {
      calls.push("gate");
      const result = gateResults.shift();
      if (!result) throw new Error("gate ran more often than the test expected");
      return result;
    },
    fix: async (checkpoint: Checkpoint, output: string) => {
      calls.push(`fix ${checkpoint}: ${output}`);
      return fix(checkpoint, output);
    },
  };
}

describe("runCheckpoint", () => {
  it("runs the gate once and no fixer when it passes", async () => {
    const s = steps([green]);

    const result = await runCheckpoint(1, s, () => {});

    assert.equal(result.passed, true);
    assert.deepEqual(s.calls, ["gate"]);
  });

  it("gives a red gate's output and the checkpoint number to the fixer, then re-runs the gate", async () => {
    const s = steps([red("first failure"), green]);

    const result = await runCheckpoint(2, s, () => {});

    assert.equal(result.passed, true);
    assert.deepEqual(s.calls, ["gate", "fix 2: first failure", "gate"]);
  });

  it("stops after two fixer attempts and returns the final gate result", async () => {
    const s = steps([red("one"), red("two"), red("three")]);

    const result = await runCheckpoint(1, s, () => {});

    assert.deepEqual(result, red("three"));
    assert.deepEqual(s.calls, ["gate", "fix 1: one", "gate", "fix 1: two", "gate"]);
  });

  it("counts a fixer run that throws as an attempt and re-runs the gate after it", async () => {
    const s = steps([red("one"), red("two"), green], async (_, output) => {
      if (output === "one") throw new Error("timed out");
    });

    const result = await runCheckpoint(1, s, () => {});

    assert.equal(result.passed, true);
    assert.deepEqual(s.calls, ["gate", "fix 1: one", "gate", "fix 1: two", "gate"]);
  });

  it("rethrows a fixer error that the steps mark as uncounted, without running the gate again", async () => {
    const stop = new Error("usage limit reached");
    const s = {
      ...steps([red("one")], async () => {
        throw stop;
      }),
      uncounted: (error: unknown) => error === stop,
    };

    await assert.rejects(() => runCheckpoint(1, s, () => {}), (error: unknown) => error === stop);

    assert.deepEqual(s.calls, ["gate", "fix 1: one"]);
  });

  it("logs every gate result and fixer failure", async () => {
    const lines: string[] = [];
    const s = steps([red(), red(), green], async () => {
      throw new Error("timed out");
    });

    await runCheckpoint(2, s, (line) => lines.push(line));

    assert.deepEqual(lines, [
      "checkpoint 2: gate failed",
      "checkpoint 2: gate-fixer attempt 1/2 failed: Error: timed out",
      "checkpoint 2: gate failed after gate-fixer attempt 1/2",
      "checkpoint 2: gate-fixer attempt 2/2 failed: Error: timed out",
      "checkpoint 2: gate passed after gate-fixer attempt 2/2",
    ]);
  });

  it("logs a first-run pass", async () => {
    const lines: string[] = [];

    await runCheckpoint(1, steps([green]), (line) => lines.push(line));

    assert.deepEqual(lines, ["checkpoint 1: gate passed"]);
  });
});

describe("runGate", () => {
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);

  // A sandbox whose gate exits with `gateExit`, whose git status prints
  // `status`, and whose HEAD reads as each of `heads` in turn.
  const sandbox = (gateExit: number, status = "", statusExit = 0, heads: string[] = [headA]) => {
    const commands: string[] = [];
    const queue = [...heads];
    return {
      commands,
      exec: async (rawCommand: string) => {
        const command = asDefaultGate(rawCommand);
        commands.push(command);
        if (command === "git rev-parse HEAD") {
          const head = queue.length > 1 ? queue.shift()! : queue[0]!;
          return { stdout: `${head}\n`, stderr: "", exitCode: /^[0-9a-f]+$/.test(head) ? 0 : 128 };
        }
        return command.startsWith("git status")
          ? { stdout: status, stderr: "", exitCode: statusExit }
          : { stdout: "Gate passed\n", stderr: "", exitCode: gateExit };
      },
    };
  };

  it("runs scripts/gate.sh with stderr folded into stdout, and passes on exit code 0 with a clean worktree", async () => {
    const s = sandbox(0);

    const result = await runGate(s);

    assert.deepEqual(s.commands, ["git rev-parse HEAD", "scripts/gate.sh 2>&1", "git status --porcelain 2>&1", "git rev-parse HEAD"]);
    assert.equal(result.passed, true);
  });

  it("reports the commit a passing gate checked, which is the one the host pushes", async () => {
    assert.equal((await runGate(sandbox(0))).head, headA);
  });

  it("fails a passing gate when HEAD moved while it ran, so an unchecked commit can't be pushed", async () => {
    const result = await runGate(sandbox(0, "", 0, [headA, headB]));

    assert.equal(result.passed, false);
    assert.equal(result.head, undefined);
    assert.match(result.output, /HEAD moved while it ran/);
  });

  it("fails a passing gate when HEAD can't be read", async () => {
    const result = await runGate(sandbox(0, "", 0, ["fatal: not a git repository"]));

    assert.equal(result.passed, false);
    assert.match(result.output, /HEAD couldn't be read/);
  });

  it("fails a passing gate when the worktree has uncommitted changes, and names them", async () => {
    const result = await runGate(sandbox(0, " M src/A.cs\n?? src/B.cs\n"));

    assert.equal(result.passed, false);
    assert.match(result.output, /uncommitted changes/);
    assert.match(result.output, /src\/A\.cs/);
    assert.match(result.output, /src\/B\.cs/);
  });

  it("fails a passing gate when git status can't run", async () => {
    const result = await runGate(sandbox(0, "fatal: not a git repository", 128));

    assert.equal(result.passed, false);
    assert.match(result.output, /git status failed/);
  });

  describe("with a guard", () => {
    const base = "c".repeat(40);

    // A sandbox whose gate script is a file at base (unless `tracked` is false), and
    // whose `git diff` of it prints `changed`.
    const guarded = (changed: string, { tracked = true, diffExit = 0 } = {}) => {
      const inner = sandbox(0);
      return {
        commands: inner.commands,
        exec: async (command: string) => {
          if (command.includes(" cat-file ")) {
            inner.commands.push(command);
            return { stdout: "", stderr: "", exitCode: tracked ? 0 : 128 };
          }
          if (command.includes(" merge-base ")) {
            inner.commands.push(command);
            return { stdout: `${"d".repeat(40)}\n`, stderr: "", exitCode: 0 };
          }
          if (command.includes(" diff ")) {
            inner.commands.push(command);
            return { stdout: changed, stderr: "", exitCode: diffExit };
          }
          return inner.exec(command);
        },
      };
    };

    it("runs the gate when the branch leaves the gate script alone", async () => {
      const s = guarded("");

      const result = await runGate(s, { base });

      assert.equal(result.passed, true);
      assert.match(s.commands[0]!, new RegExp(`^git --no-replace-objects --literal-pathspecs cat-file -e '${base}:`));
    });

    it("fails without running the gate when the branch changes the gate script, and says how to restore it", async () => {
      const s = guarded(`${GATE_SCRIPT}\0`);

      const result = await runGate(s, { base });

      assert.equal(result.passed, false);
      assert.equal(result.head, undefined);
      assert.match(result.output, /changes .*, which is the gate itself/);
      assert.match(result.output, new RegExp(`git checkout ${base} -- ${GATE_SCRIPT.replaceAll(".", "\\.")}`));
      assert.ok(!s.commands.some((command) => command.includes("2>&1") && !command.startsWith("git")), s.commands.join("\n"));
    });

    it("fails closed when the gate script isn't a file at base", async () => {
      const result = await runGate(guarded("", { tracked: false }), { base });

      assert.equal(result.passed, false);
      assert.match(result.output, /isn't a file at/);
    });

    it("fails when git can't say whether the gate script changed", async () => {
      const result = await runGate(guarded("", { diffExit: 128 }), { base });

      assert.equal(result.passed, false);
      assert.match(result.output, /git diff failed/);
    });

    it("doesn't ask without a guard", async () => {
      const s = guarded(`${GATE_SCRIPT}\0`);

      assert.equal((await runGate(s)).passed, true);
      assert.ok(!s.commands.some((command) => command.includes(" cat-file ")));
    });
  });

  it("doesn't check the worktree when the gate is already red", async () => {
    const s = sandbox(1);

    await runGate(s);

    assert.deepEqual(s.commands, ["git rev-parse HEAD", "scripts/gate.sh 2>&1"]);
  });

  it("fails on any other exit code, whatever the output says", async () => {
    const sandbox = { exec: async () => ({ stdout: "Gate passed ✅", stderr: "", exitCode: 1 }) };

    assert.equal((await runGate(sandbox)).passed, false);
  });

  it("strips terminal colour codes from the output", async () => {
    const sandbox = { exec: async () => ({ stdout: "\u001b[0;31m❌ Build failed\u001b[0m\n", stderr: "", exitCode: 1 }) };

    assert.equal((await runGate(sandbox)).output, "❌ Build failed\n");
  });
});

describe("tail", () => {
  it("keeps the last lines of the output, ignoring a trailing newline", () => {
    assert.equal(tail("a\nb\nc\nd\n", 2), "c\nd");
  });

  it("keeps short output whole", () => {
    assert.equal(tail("a\nb", 100), "a\nb");
  });
});

describe("gateFailureComment", () => {
  const output = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");

  it("names the checkpoint and the branch, and says nothing was pushed", () => {
    const comment = gateFailureComment(2, "feature/69-run-the-gate", output);

    assert.match(comment, /checkpoint 2/);
    assert.match(comment, /`feature\/69-run-the-gate`/);
    assert.match(comment, /2 gate-fixer attempts/);
    assert.match(comment, /wasn't pushed/);
  });

  it("quotes only the last 100 lines of the gate output", () => {
    const comment = gateFailureComment(1, "feature/69-x", output);

    assert.ok(comment.includes("line 51\n"));
    assert.ok(comment.includes("line 150\n"));
    assert.ok(!comment.includes("line 50\n"));
  });

  it("fences the output with more backticks than it contains", () => {
    const comment = gateFailureComment(1, "feature/69-x", "```\nnot the end\n````");

    assert.match(comment, /\n`````text\n```\nnot the end\n````\n`````$/);
  });
});

// The same checks against a real repository, since what they promise is about
// git's view of content and history.
describe("the gate guard in a git repository", () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };

  // A repo whose first commit holds the gate script and src/a.txt; `run` is its sandbox.
  const inRepo = async (test: (repo: { git: (...args: string[]) => string; write: (path: string, text: string) => void; run: Pick<Sandbox, "exec"> }) => Promise<void>) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gate-guard-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const run = {
      exec: async (command: string) => {
        const result = spawnSync("bash", ["-c", command], { cwd: dir, env, encoding: "utf8" });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
      },
    } as unknown as Pick<Sandbox, "exec">;
    try {
      git("init", "--quiet", "-b", "main");
      write(GATE_SCRIPT, "#!/bin/sh\nexit 0\n");
      write("src/a.txt", "a\n");
      git("add", "-A");
      git("commit", "--quiet", "-m", "base");
      await test({ git, write, run });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };

  it("lets a branch that leaves the gate script alone through", async () => {
    await inRepo(async ({ git, write, run }) => {
      const base = git("rev-parse", "HEAD");
      write("src/a.txt", "changed\n");
      git("commit", "--quiet", "-am", "work");

      assert.equal(await gateScriptChange(run, { base }), undefined);
    });
  });

  it("refuses a branch that edits the gate script, and accepts it once the script is restored", async () => {
    await inRepo(async ({ git, write, run }) => {
      const base = git("rev-parse", "HEAD");
      write(GATE_SCRIPT, "#!/bin/sh\nexit 0 # weakened\n");
      git("commit", "--quiet", "-am", "weaken the gate");
      assert.match((await gateScriptChange(run, { base })) ?? "", /changes .*, which is the gate itself/);

      git("checkout", "--quiet", base, "--", GATE_SCRIPT);
      git("commit", "--quiet", "-am", "restore the gate");

      assert.equal(await gateScriptChange(run, { base }), undefined);
    });
  });

  it("sees a change made in a merge commit", async () => {
    await inRepo(async ({ git, write, run }) => {
      const base = git("rev-parse", "HEAD");
      git("checkout", "--quiet", "-b", "throwaway");
      write("src/other.txt", "x\n");
      git("add", "-A");
      git("commit", "--quiet", "-m", "side");
      git("checkout", "--quiet", "-");
      git("merge", "--quiet", "--no-ff", "--no-commit", "throwaway");
      write(GATE_SCRIPT, "#!/bin/sh\nexit 0 # weakened in the merge\n");
      git("add", "-A");
      git("commit", "--quiet", "-m", "merge");

      assert.match((await gateScriptChange(run, { base })) ?? "", /changes .*, which is the gate itself/);
    });
  });

  it("leaves main's own change to the gate script out once main is merged in, and only then", async () => {
    await inRepo(async ({ git, write, run }) => {
      const base = git("rev-parse", "HEAD");
      git("checkout", "--quiet", "-b", "later-main");
      write(GATE_SCRIPT, "#!/bin/sh\nexit 0 # main's change\n");
      git("commit", "--quiet", "-am", "main changes the gate");
      const mergedMain = git("rev-parse", "HEAD");
      git("checkout", "--quiet", "-");
      write("src/a.txt", "branch work\n");
      git("commit", "--quiet", "-am", "work");
      git("merge", "--quiet", "--no-edit", mergedMain);

      assert.equal(await gateScriptChange(run, { base, mergedMain }), undefined);
      assert.match((await gateScriptChange(run, { base })) ?? "", /changes .*, which is the gate itself/);
    });
  });

  it("leaves out main's change to the gate script for a branch cut from an older main, until the branch changes it too", async () => {
    await inRepo(async ({ git, write, run }) => {
      git("checkout", "--quiet", "-b", "work");
      write("src/a.txt", "branch work\n");
      git("commit", "--quiet", "-am", "work");
      git("checkout", "--quiet", "main");
      write(GATE_SCRIPT, "#!/bin/sh\nexit 0 # main's change\n");
      git("commit", "--quiet", "-am", "main changes the gate");
      const newMain = git("rev-parse", "HEAD");
      git("checkout", "--quiet", "work");

      assert.equal(await gateScriptChange(run, { base: newMain }), undefined);

      write(GATE_SCRIPT, "#!/bin/sh\nexit 0 # weakened\n");
      git("commit", "--quiet", "-am", "weaken the gate");
      assert.match((await gateScriptChange(run, { base: newMain })) ?? "", /changes .*, which is the gate itself/);
    });
  });

  it("isn't fooled by a replace ref that makes base hold the branch's weakened script", async () => {
    await inRepo(async ({ git, write, run }) => {
      const base = git("rev-parse", "HEAD");
      write(GATE_SCRIPT, "#!/bin/sh\nexit 0 # weakened\n");
      git("commit", "--quiet", "-am", "weaken the gate");
      const fake = git("commit-tree", "-m", "fake base", git("rev-parse", "HEAD^{tree}"));
      git("replace", base, fake);

      assert.match((await gateScriptChange(run, { base })) ?? "", /changes .*, which is the gate itself/);
    });
  });

  it("refuses a gate script that isn't a file at base", async () => {
    await inRepo(async ({ git, run }) => {
      git("rm", "--quiet", "-r", "--cached", GATE_SCRIPT);
      git("commit", "--quiet", "-m", "untrack the gate");
      const base = git("rev-parse", "HEAD");

      assert.match((await gateScriptChange(run, { base })) ?? "", /isn't a file at/);
    });
  });
});

describe("changedFiles", () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };

  it("lists, sorted, what the branch changed under the paths, names with odd characters and deletions included", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-changed-files-")));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "keep.sh"), "k\n");
      writeFileSync(join(dir, "scripts", "gone.sh"), "g\n");
      writeFileSync(join(dir, "other.txt"), "o\n");
      git("init", "--quiet", "-b", "main");
      git("add", "-A");
      git("commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "scripts", "a` closes #12 `b.sh"), "x\n");
      writeFileSync(join(dir, "scripts", "keep.sh"), "changed\n");
      writeFileSync(join(dir, "other.txt"), "changed\n");
      git("rm", "--quiet", "scripts/gone.sh");
      git("add", "-A");
      git("commit", "--quiet", "-m", "work");
      const run = {
        exec: async (command: string) => {
          const result = spawnSync("bash", ["-c", command], { cwd: dir, env, encoding: "utf8" });
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
        },
      } as unknown as Pick<Sandbox, "exec">;

      assert.deepEqual(await changedFiles(run, { base }, ["scripts/"]), ["scripts/a` closes #12 `b.sh", "scripts/gone.sh", "scripts/keep.sh"]);
      assert.equal(await changedFiles(run, { base: "0".repeat(40) }, ["scripts/"]), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
