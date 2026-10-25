import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateFailureComment, runCheckpoint, runGate, tail, type Checkpoint, type GateRun } from "./checkpoint.mts";

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
      exec: async (command: string) => {
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
