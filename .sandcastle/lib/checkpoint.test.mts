import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { Sandbox } from "@ai-hero/sandcastle";
import { publicErrorText } from "./build.mts";
import { GATE_FIXER_ATTEMPTS } from "./config.mts";
import { changedFiles, gateFailureComment, gateScriptChange, printableLine, runCheckpoint, runGate, sameGateOutput, sandboxDown, tail, withoutRunnerCommands, type Checkpoint, type GateRun } from "./checkpoint.mts";
import { GATE_COMMAND, GATE_LIMIT_MINUTES, GATE_SCRIPT } from "./repo-config.mts";
import { StalledStepError } from "./errors.mts";
import { limitSandboxExec } from "./step-limit.mts";

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

  it("runs checkpoint 3 like the others, naming it in its log lines and giving the fixer its number", async () => {
    const s = steps([red("after the review's fixes"), green]);
    const logs: string[] = [];

    const result = await runCheckpoint(3, s, (line) => void logs.push(line));

    assert.equal(result.passed, true);
    assert.deepEqual(s.calls, ["gate", "fix 3: after the review's fixes", "gate"]);
    assert.ok(logs.every((line) => line.startsWith("checkpoint 3:")), logs.join("\n"));
  });

  it("stops after two fixer attempts and returns the final gate result", async () => {
    const s = steps([red("one"), red("two"), red("three")]);

    const result = await runCheckpoint(1, s, () => {});

    assert.deepEqual(result, { ...red("three"), firstOutput: "one" });
    assert.deepEqual(s.calls, ["gate", "fix 1: one", "gate", "fix 1: two", "gate"]);
  });

  it("keeps the first red run's output when the checkpoint ends red, but not one that is the same as the last", async () => {
    const differs = await runCheckpoint(1, steps([red("first"), red("second"), red("third")]), () => {});
    const same = await runCheckpoint(1, steps([red("same"), red("same"), red("same")]), () => {});
    const passes = await runCheckpoint(1, steps([red("first"), green]), () => {});

    assert.equal(differs.firstOutput, "first");
    assert.equal(same.firstOutput, undefined);
    assert.equal(passes.firstOutput, undefined);
  });

  it("treats runs that differ only in the seconds on their step headers as the same (scripts/gate.sh prints [+Ns])", async () => {
    const run = (n: number, tail = "FAIL: shellcheck") => red(`── Hook tests [+${n}s]\n${tail}\ntest.sh: 1 check(s) failed [+${n + 100}s]`);
    const same = await runCheckpoint(1, steps([run(3), run(5), run(7)]), () => {});
    const otherFailure = await runCheckpoint(1, steps([run(3), run(5, "FAIL: pytest"), run(7, "FAIL: pytest")]), () => {});

    assert.equal(same.firstOutput, undefined);
    assert.equal(otherFailure.firstOutput, run(3).output);
  });

  describe("sameGateOutput", () => {
    it("ignores a [+Ns] that ends a line, and nothing else", () => {
      assert.equal(sameGateOutput("── a [+3s]\nx", "── a [+40s]\nx"), true);
      assert.equal(sameGateOutput("── a [+3s]\nx", "── a\nx"), true); // the stamp is left out, so a header without one is the same text
      assert.equal(sameGateOutput("a [+3s] b", "a [+4s] b"), false);
      assert.equal(sameGateOutput("a [+3s]", "a [+3s]"), true);
      assert.equal(sameGateOutput("a [+s]", "a [+1s]"), false);
      assert.equal(sameGateOutput("a [-3s]", "a [-4s]"), false);
      assert.equal(sameGateOutput("a [+3m]", "a [+4m]"), false);
      assert.equal(sameGateOutput("a [+3s]x", "a [+4s]x"), false);
      assert.equal(sameGateOutput("── a [+3s]\r\nx", "── a [+40s]\r\nx"), true);
      assert.equal(sameGateOutput("a [+3s]\rx", "a [+4s]\rx"), true);
      assert.equal(sameGateOutput("a [+3s] ", "a [+4s] "), false);
      assert.equal(sameGateOutput("one", "two"), false);
      assert.equal(sameGateOutput("", ""), true);
    });
  });

  describe("when an error ends the checkpoint after a red run", () => {
    const scrub = (text: string) => text.replaceAll("secret", "[withheld]");
    const logged = (lines: string[]) => lines.filter((line) => line.includes("first red gate run's output"));

    it("logs the scrubbed tail of the first red run, then rethrows a stall from the probe unchanged", async () => {
      const stall = new StalledStepError("stalled");
      // 149 lines and the secret make 150, so the last 100 start at line 51.
      const long = Array.from({ length: 149 }, (_, i) => `line ${i + 1}`).join("\n");
      const s = { ...steps([red(`${long}\nsecret`)]), scrub, alive: async () => Promise.reject(stall) };
      const lines: string[] = [];

      await assert.rejects(() => runCheckpoint(1, s, (line) => lines.push(line)), (error: unknown) => error === stall);

      assert.equal(logged(lines).length, 1, lines.join("\n"));
      assert.ok(logged(lines)[0]!.startsWith("checkpoint 1: the first red gate run's output, before this stopped the checkpoint:\n"));
      assert.ok(logged(lines)[0]!.includes("line 51\n"));
      assert.ok(!logged(lines)[0]!.includes("line 50\n"));
      assert.ok(logged(lines)[0]!.endsWith("[withheld]"));
      assert.ok(!lines.join("\n").includes("secret"));
      assert.deepEqual(s.calls, ["gate"]);
    });

    it("logs it for an uncounted fixer error and for a later gate run that throws", async () => {
      const stop = new Error("usage limit reached");
      const fixer = { ...steps([red("secret one")], async () => { throw stop; }), scrub, uncounted: (error: unknown) => error === stop };
      const fixerLines: string[] = [];
      await assert.rejects(() => runCheckpoint(1, fixer, (line) => fixerLines.push(line)), (error: unknown) => error === stop);

      const broken = new Error("the gate crashed");
      const gate = { ...steps([red("first")]), scrub };
      const gates = [red("first")];
      gate.gate = async () => {
        const next = gates.shift();
        if (next === undefined) throw broken;
        return next;
      };
      const gateLines: string[] = [];
      await assert.rejects(() => runCheckpoint(1, gate, (line) => gateLines.push(line)), (error: unknown) => error === broken);

      assert.match(logged(fixerLines)[0]!, /\[withheld\] one$/);
      assert.match(logged(gateLines)[0]!, /:\nfirst$/);
    });

    it("logs the first red run, not the last, when the error comes in a later attempt, and logs it once", async () => {
      const stall = new StalledStepError("stalled");
      const answers: (string | undefined)[] = [undefined];
      const s = {
        ...steps([red("one"), red("two")], async () => {
          throw new Error("a fixer failure that counts");
        }),
        scrub,
        alive: async () => {
          if (answers.length > 0) return answers.shift();
          throw stall;
        },
      };
      const lines: string[] = [];

      await assert.rejects(() => runCheckpoint(1, s, (line) => lines.push(line)), (error: unknown) => error === stall);

      assert.equal(logged(lines).length, 1, lines.join("\n"));
      assert.ok(logged(lines)[0]!.endsWith(":\none"), lines.join("\n"));
      assert.ok(!logged(lines)[0]!.includes("two"));
    });

    it("says the first run couldn't be logged when the scrub throws, and still rethrows the original error", async () => {
      const stall = new StalledStepError("stalled");
      const s = { ...steps([red("one")]), scrub: () => { throw new Error("the scrub broke"); }, alive: async () => Promise.reject(stall) };
      const lines: string[] = [];

      await assert.rejects(() => runCheckpoint(1, s, (line) => lines.push(line)), (error: unknown) => error === stall);

      assert.deepEqual(logged(lines), []);
      assert.ok(lines.includes("checkpoint 1: the first red gate run couldn't be logged"), lines.join("\n"));
    });

    it("rethrows the original error when the log throws on both diagnostic lines, the fallback included", async () => {
      const stall = new StalledStepError("stalled");
      const s = { ...steps([red("one")]), scrub, alive: async () => Promise.reject(stall) };
      const lines: string[] = [];
      const throwing = (line: string) => {
        lines.push(line);
        // The checkpoint's own lines are outside the diagnostic: a log that throws there is the error itself.
        if (line.includes("the first red gate run")) throw new Error("the log broke");
      };

      await assert.rejects(() => runCheckpoint(1, s, throwing), (error: unknown) => error === stall);

      assert.equal(lines.filter((line) => line.includes("the first red gate run")).length, 2, lines.join("\n"));
    });

    it("rethrows the original error when the scrub or the log throws", async () => {
      const stall = new StalledStepError("stalled");
      const failing = (scrubber: (text: string) => string) => ({ ...steps([red("one")]), scrub: scrubber, alive: async () => Promise.reject(stall) });

      await assert.rejects(() => runCheckpoint(1, failing(() => { throw new Error("the scrub broke"); }), () => {}), (error: unknown) => error === stall);
      await assert.rejects(
        () => runCheckpoint(1, failing(scrub), (line) => { if (line.includes("first red gate run's output")) throw new Error("the log broke"); }),
        (error: unknown) => error === stall,
      );
    });

    it("logs nothing without a scrub, and nothing when the first gate run itself throws or the checkpoint ends normally", async () => {
      const stall = new StalledStepError("stalled");
      const unscrubbed = { ...steps([red("secret")]), alive: async () => Promise.reject(stall) };
      const lines: string[] = [];
      await assert.rejects(() => runCheckpoint(1, unscrubbed, (line) => lines.push(line)), (error: unknown) => error === stall);

      const first = { ...steps([]), scrub };
      await assert.rejects(() => runCheckpoint(1, first, (line) => lines.push(line)), /gate ran more often/);

      await runCheckpoint(1, { ...steps([red("one"), red("two"), red("three")]), scrub }, (line) => lines.push(line));
      await runCheckpoint(1, { ...steps([green]), scrub }, (line) => lines.push(line));

      assert.deepEqual(logged(lines), []);
      assert.ok(!lines.some((line) => line.includes("couldn't be logged")), lines.join("\n"));
    });
  });

  describe("with a sandbox that can be asked whether it is down", () => {
    const withAlive = (gateResults: GateRun[], answers: (string | undefined)[]) => {
      const s = steps(gateResults);
      return { ...s, alive: async () => (s.calls.push("alive"), answers.shift()) };
    };

    it("asks before every fixer attempt and runs the fixer when the sandbox answers", async () => {
      const s = withAlive([red("one"), red("two"), green], [undefined, undefined]);

      const result = await runCheckpoint(1, s, () => {});

      assert.equal(result.passed, true);
      assert.deepEqual(s.calls, ["gate", "alive", "fix 1: one", "gate", "alive", "fix 1: two", "gate"]);
    });

    it("runs no fixer and ends the checkpoint when the sandbox is down before the first attempt", async () => {
      const s = withAlive([red("the sandbox error")], ["The sandbox is down."]);
      const lines: string[] = [];

      const result = await runCheckpoint(2, s, (line) => lines.push(line));

      assert.deepEqual(s.calls, ["gate", "alive"]);
      assert.equal(result.passed, false);
      assert.equal(result.output, "the sandbox error\n❌ The sandbox is down.");
      assert.equal(result.fixersRun, 0);
      assert.equal(result.firstOutput, undefined);
      assert.deepEqual(lines, ["checkpoint 2: gate failed", "checkpoint 2: gate-fixer attempt 1/2 not run: The sandbox is down."]);
    });

    it("doesn't quote a first run that is the same as the last when the sandbox goes down at attempt 2", async () => {
      const s = withAlive([red("same"), red("same")], [undefined, "The sandbox is down."]);

      const result = await runCheckpoint(1, s, () => {});

      assert.equal(result.firstOutput, undefined);
      assert.equal(result.fixersRun, 1);
    });

    it("doesn't quote a first run that differs from the last only in its seconds when the sandbox goes down at attempt 2", async () => {
      const s = withAlive([red("── Hook tests [+3s]\nFAIL"), red("── Hook tests [+8s]\nFAIL")], [undefined, "The sandbox is down."]);

      const result = await runCheckpoint(1, s, () => {});

      assert.equal(result.firstOutput, undefined);
    });

    it("counts a fixer that threw as a run, then stops when the sandbox is down at attempt 2", async () => {
      const s = {
        ...withAlive([red("one"), red("two")], [undefined, "The sandbox is down."]),
        fix: async () => {
          throw new Error("timed out");
        },
      };
      const lines: string[] = [];

      const result = await runCheckpoint(1, s, (line) => lines.push(line));

      assert.equal(result.fixersRun, 1);
      assert.equal(result.firstOutput, "one");
      assert.ok(lines.includes("checkpoint 1: gate-fixer attempt 2/2 not run: The sandbox is down."), lines.join("\n"));
    });

    it("rethrows a stall from the probe, without running a fixer", async () => {
      const stall = new StalledStepError("stalled");
      const s = { ...steps([red("one")]), alive: async () => Promise.reject(stall) };

      await assert.rejects(() => runCheckpoint(1, s, () => {}), (error: unknown) => error === stall);
      assert.deepEqual(s.calls, ["gate"]);
    });

    it("keeps the first run's output when the sandbox goes down after the first fixer attempt", async () => {
      const s = withAlive([red("real failure"), red("sandbox error")], [undefined, "The sandbox is down."]);

      const result = await runCheckpoint(1, s, () => {});

      assert.deepEqual(s.calls, ["gate", "alive", "fix 1: real failure", "gate", "alive"]);
      assert.equal(result.output, "sandbox error\n❌ The sandbox is down.");
      assert.equal(result.firstOutput, "real failure");
      assert.equal(result.fixersRun, 1);
    });
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

  it("logs a fixer failure as one printable line, with no ##[ and the scrub applied", async () => {
    const lines: string[] = [];
    const s = {
      ...steps([red(), green], async () => {
        throw new Error("boom\n::stop-commands::t\n##[add-mask]y secret");
      }),
      scrubLine: (text: string) => text.replaceAll("secret", "[withheld]"),
    };

    await runCheckpoint(1, s, (line) => lines.push(line));

    const failure = lines.find((line) => line.includes("failed: "))!;
    assert.equal(failure, "checkpoint 1: gate-fixer attempt 1/2 failed: Error: boom ::stop-commands::t ## [add-mask]y [withheld]");
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
            return tracked ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "fatal: path 'scripts/gate.sh' does not exist in 'cccc'\n", stderr: "", exitCode: 128 };
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

describe("withoutRunnerCommands", () => {
  it("changes every ##[ so the runner's legacy command form can't appear, and leaves other text alone", () => {
    assert.equal(withoutRunnerCommands("##[add-mask]x and a ##[error]y"), "## [add-mask]x and a ## [error]y");
    assert.equal(withoutRunnerCommands("## [already safe] # [ ##"), "## [already safe] # [ ##");
    assert.equal(withoutRunnerCommands("###[x"), "### [x");
    assert.equal(withoutRunnerCommands(""), "");
  });
});

describe("printableLine", () => {
  it("gives one printable line: newlines become a space, escapes and hidden characters are deleted, and a ##[ is changed", () => {
    const line = printableLine(new Error("x\n::stop-commands::t\n##[add-mask]y\u001b[31m\u202e"));

    assert.ok(!/[\r\n]/.test(line), line);
    assert.ok(!line.includes("##["), line);
    assert.equal(line, "Error: x ::stop-commands::t ## [add-mask]y");
  });

  it("applies the scrub before the cut, so a secret across the cut doesn't survive as a fragment", () => {
    // 195 characters then the secret: the cut at 200 lands inside it when it runs first.
    const text = `${"a".repeat(195)}ghp_0123456789`;

    const line = printableLine(text, (value) => value.replace(/ghp_\d{10}/g, "[x]"));

    assert.ok(!line.includes("ghp_"), line);
    assert.ok(line.endsWith("[x]"), line);
  });

  it("cuts at the limit", () => {
    for (const [length, kept] of [[199, 199], [200, 200], [201, 200]] as const) {
      assert.equal(printableLine("x".repeat(length)).length, kept, `${length} characters`);
    }
    assert.equal(printableLine("x".repeat(30), undefined, 10), "x".repeat(10));
  });

  it("drops a hidden character before the scrub, so it can't split a secret the scrub would match", () => {
    const scrub = (value: string) => value.replaceAll("ghp_abc", "[withheld]");

    assert.equal(printableLine("token ghp_a\u200bbc here", scrub), "token [withheld] here");
  });

  it("deletes a combining mark, folds a run of line breaks to one space, and stops a line break from hiding a ##[", () => {
    const scrub = (value: string) => value.replaceAll("ghp_abc", "[withheld]");

    assert.equal(printableLine("ghp_a\u0301bc", scrub), "[withheld]");
    assert.equal(printableLine("a\r\n\u2028\u0085b"), "a b");
    assert.equal(printableLine("x ##\u0085[error]"), "x ## [error]");
  });

  it("strips a colour code before the scrub, so it neither splits a secret nor leaves its tail", () => {
    assert.equal(printableLine("\u001b[31mred\u001b[0m ghp_a\u001b[1mbc", (value) => value.replaceAll("ghp_abc", "[withheld]")), "red [withheld]");
  });

  it("withholds a secret that is padded after, or holds a line break itself", () => {
    const scrub = (value: string) => value.replaceAll("sec\nret", "[withheld]").replaceAll("ghp_abc", "[withheld]");

    assert.equal(printableLine("a sec\nret b", scrub), "a [withheld] b");
    const padded = `${"\u200b".repeat(3996)}ghp_\u200babc`;
    assert.equal(printableLine(padded, scrub), "[withheld]");
  });

  it("cuts an enormous text before the scrub, so the scrub never sees more than a bounded part", () => {
    let seen = 0;

    printableLine("x".repeat(1_000_000), (value) => { seen = value.length; return value; }, 10);

    assert.equal(seen, 200);
  });

  it("gives a fixed text when nothing printable is left", () => {
    assert.equal(printableLine(""), "(no printable text)");
    assert.equal(printableLine("\u200b\n"), "(no printable text)");
    assert.equal(printableLine("x", () => ""), "(no printable text)");
  });

  it("gives a fixed text for a value that can't be printed and for a scrub that throws", () => {
    const hostile = { toString: () => { throw new Error("no"); } };

    assert.equal(printableLine(hostile), "an error that can't be printed");
    assert.equal(printableLine("secret", () => { throw new Error("the scrub broke"); }), "text that couldn't be made safe to log");
  });
});

describe("sandboxDown", () => {
  const exec = (result: { stdout: string; exitCode: number } | Error) =>
    ({ exec: async () => (result instanceof Error ? Promise.reject(result) : { stderr: "", ...result }) }) as unknown as Pick<Sandbox, "exec">;

  it("is undefined when git rev-parse HEAD answers with a commit", async () => {
    assert.equal(await sandboxDown(exec({ stdout: `${"a".repeat(40)}\n`, exitCode: 0 })), undefined);
  });

  it("says the sandbox no longer answers when git fails, as it did with exit 128 after the gate was killed", async () => {
    assert.match((await sandboxDown(exec({ stdout: "fatal: not a git repository", exitCode: 128 }))) ?? "", /no longer answers `git rev-parse HEAD`, so no gate-fixer was run/);
  });

  it("says the same for an answer that isn't a commit", async () => {
    assert.match((await sandboxDown(exec({ stdout: "\n", exitCode: 0 }))) ?? "", /no longer answers/);
  });

  it("says the sandbox can't run a command when the exec throws, with the error as printable ASCII, capped", async () => {
    const reason = (await sandboxDown(exec(new Error(`stalled\u001b[31m ${"x".repeat(300)}`)))) ?? "";

    assert.match(reason, /^The sandbox can't run a command \(Error: stalled x+\), so no gate-fixer was run\.$/);
    assert.ok(reason.length < 300, String(reason.length));
  });

  it("changes a ##[ in the error text, and deletes a hidden character inside one", async () => {
    const reason = (await sandboxDown(exec(new Error("failed ##[add-mask]x ##\u200b[error]y")))) ?? "";

    assert.ok(!reason.includes("##["), reason);
    assert.ok(reason.includes("## [add-mask]x"), reason);
    assert.ok(reason.includes("## [error]y"), reason);
  });

  it("keeps exactly 200 characters of the error text", async () => {
    for (const [length, kept] of [[199, 199], [200, 200], [201, 200]] as const) {
      const long = (await sandboxDown({ exec: async () => Promise.reject("x".repeat(length)) } as unknown as Pick<Sandbox, "exec">)) ?? "";

      assert.ok(long.includes(`(${"x".repeat(kept)})`) && !long.includes("x".repeat(kept + 1)), `${length} characters`);
    }
  });

  it("still reports a dead sandbox when the scrub throws, instead of rejecting with the scrub's error", async () => {
    const reason = await sandboxDown(exec(new Error("exec failed")), () => { throw new Error("the scrub broke"); });

    assert.match(reason ?? "", /^The sandbox can't run a command \(text that couldn't be made safe to log\), so no gate-fixer was run\.$/);
  });

  it("rethrows a stall, which ends the run, instead of reporting it as a dead sandbox", async () => {
    const stall = new StalledStepError('The step "git rev-parse HEAD" ran over its limit.');

    await assert.rejects(() => sandboxDown(exec(stall)), (error: unknown) => error === stall);
  });

  it("scrubs the error text before cutting it, so a secret across the cut doesn't survive as a fragment", async () => {
    const secret = "ghp_0123456789";
    // "Error: " is 7 characters, so the secret starts at 192 and the cut at 200 lands inside it.
    const text = `${"a".repeat(185)}${secret}`;
    const scrub = (value: string) => value.replace(/ghp_\d{10}/g, "[x]");

    const reason = (await sandboxDown(exec(new Error(text)), scrub)) ?? "";

    assert.ok(!reason.includes("ghp_"), reason);
    assert.ok(reason.includes("[x]"), reason);
  });

  // The host's publicError (lib/build.mts) withholds text that looks like it holds a secret. Only the scrubbed reason is logged or posted:
  // the raw error is dropped, so a reason must not send a reader to a run log that doesn't hold it.
  describe("when the probe's error looks like it holds a secret", () => {
    const secret = `${"gh"}p_${"A".repeat(36)}`;
    const scrub = (text: string) => publicErrorText(text, (cleaned) => cleaned.includes(secret));
    const probe = () => exec(new Error(`exit 1: token ${secret} in the output`));

    it("leaves the secret out of the reason", async () => {
      const reason = (await sandboxDown(probe(), scrub)) ?? "";

      assert.ok(!reason.includes(secret), reason);
      assert.match(reason, /^The sandbox can't run a command \(.*\), so no gate-fixer was run\.$/);
    });

    it("says the error was withheld because it may hold a secret, and no longer points to the run log", async () => {
      const reason = (await sandboxDown(probe(), scrub)) ?? "";

      assert.doesNotMatch(reason, /run log/i, reason);
      assert.match(reason, /withheld/i, reason);
      assert.match(reason, /secret/i, reason);
    });

    it("writes the secret to neither the checkpoint's log nor its output, and the log doesn't point to a run log", async () => {
      const logs: string[] = [];
      const s = { ...steps([red("one")]), alive: () => sandboxDown(probe(), scrub), scrub };

      const result = await runCheckpoint(2, s, (line) => logs.push(line));

      const text = `${logs.join("\n")}\n${result.output}`;
      assert.ok(!text.includes(secret), text);
      assert.doesNotMatch(text, /run log/i, text);
      assert.ok(logs.some((line) => line.includes("not run: The sandbox can't run a command")), logs.join("\n"));
    });
  });

  it("reports an error that can't be turned into text without throwing", async () => {
    const hostile = { toString: () => { throw new Error("no"); } };

    assert.match((await sandboxDown({ exec: async () => Promise.reject(hostile) } as unknown as Pick<Sandbox, "exec">)) ?? "", /\(an error that can't be printed\)/);
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

  it("names checkpoint 3, the gate after the host-side review's fixes", () => {
    const comment = gateFailureComment(3, "feature/387-x", output);

    assert.match(comment, /checkpoint 3/);
    assert.match(comment, /wasn't pushed/);
  });

  it("quotes only the last 100 lines of the gate output", () => {
    const comment = gateFailureComment(1, "feature/69-x", output);

    assert.ok(comment.includes("line 51\n"));
    assert.ok(comment.includes("line 150\n"));
    assert.ok(!comment.includes("line 50\n"));
  });

  it("quotes the first red run too when it differs from the last, before the last so an over-long comment keeps the last", () => {
    const comment = gateFailureComment(1, "feature/69-x", "last run", { firstOutput: "first run" });

    assert.match(comment, /The last 100 lines of the first red gate run, before a gate-fixer ran:\n\n```text\nfirst run\n```\n\nThe last 100 lines of the last gate output:\n\n```text\nlast run\n```$/);
  });

  it("counts the gate-fixer attempts that ran, not the most there could be", () => {
    assert.match(gateFailureComment(1, "feature/69-x", "o", { fixersRun: 0 }), /still red at checkpoint 1 after 0 gate-fixer attempts/);
    assert.match(gateFailureComment(1, "feature/69-x", "o", { fixersRun: 1 }), /after 1 gate-fixer attempt\b/);
    assert.match(gateFailureComment(1, "feature/69-x", "o"), /after 2 gate-fixer attempts/);
  });

  it("doesn't repeat a first run that is the last", () => {
    assert.ok(!gateFailureComment(1, "feature/69-x", "same", { firstOutput: "same" }).includes("first red gate run"));
    assert.ok(!gateFailureComment(1, "feature/69-x", "same").includes("first red gate run"));
  });

  it("doesn't repeat a first run that differs from the last only in its step headers' seconds", () => {
    const comment = gateFailureComment(1, "feature/69-x", "── Hook tests [+9s]\nFAIL", { firstOutput: "── Hook tests [+4s]\nFAIL" });

    assert.ok(!comment.includes("first red gate run"));
  });

  it("quotes only the last 100 lines of the first run", () => {
    const comment = gateFailureComment(1, "feature/69-x", "last", { firstOutput: output });

    assert.ok(comment.includes("line 51\n"));
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

  it("says the gate script is missing when it isn't a file at the base", async () => {
    await inRepo(async ({ git, run }) => {
      git("rm", "--quiet", GATE_SCRIPT);
      git("commit", "--quiet", "-m", "drop the gate");
      const base = git("rev-parse", "HEAD");

      const message = (await gateScriptChange(run, { base })) ?? "";
      assert.match(message, /isn't a file at /);
      assert.match(message, /GATE_SCRIPT in lib\/repo-config\.mts/);
    });
  });

  it("names the exit code and first output line when git itself fails, without pointing at GATE_SCRIPT", async () => {
    const run = { exec: async () => ({ stdout: "fatal: detected dubious ownership\nmore\n", stderr: "", exitCode: 128 }) } as unknown as Pick<Sandbox, "exec">;

    const message = (await gateScriptChange(run, { base: "abc123" })) ?? "";
    assert.match(message, /git failed \(exit 128: fatal: detected dubious ownership\)/);
    assert.doesNotMatch(message, /GATE_SCRIPT in lib/);
    assert.doesNotMatch(message, /more/);
  });

  describe("when cat-file fails", () => {
    const failing = (exitCode: number, stdout = "", stderr = "") =>
      ({ exec: async () => ({ stdout, stderr, exitCode }) }) as unknown as Pick<Sandbox, "exec">;
    const missing = /isn't a file at abc123.*GATE_SCRIPT in lib\/repo-config\.mts/;

    it("calls exit 1 with no output a missing script", async () => {
      assert.match((await gateScriptChange(failing(1), { base: "abc123" })) ?? "", missing);
    });

    it("calls git's 'exists on disk, but not in' answer a missing script", async () => {
      const run = failing(128, "fatal: path 'scripts/gate.sh' exists on disk, but not in 'abc123'\n");

      assert.match((await gateScriptChange(run, { base: "abc123" })) ?? "", missing);
    });

    it("calls exit 1 with output a git failure", async () => {
      assert.match((await gateScriptChange(failing(1, "something odd"), { base: "abc123" })) ?? "", /git failed \(exit 1: something odd\)/);
    });

    it("says 'no output' for a git that fails silently, and reads output printed on stderr", async () => {
      assert.match((await gateScriptChange(failing(137), { base: "abc123" })) ?? "", /git failed \(exit 137: \(no output\)\)/);
      assert.match((await gateScriptChange(failing(2, "", "fatal: boom\n"), { base: "abc123" })) ?? "", /git failed \(exit 2: fatal: boom\)/);
    });

    it("treats another fatal path message as a git failure, not a missing script", async () => {
      const message = (await gateScriptChange(failing(128, "fatal: path 'x' is ambiguous\n"), { base: "abc123" })) ?? "";

      assert.match(message, /git failed \(exit 128: fatal: path 'x' is ambiguous\)/);
      assert.doesNotMatch(message, /GATE_SCRIPT in lib/);
    });

    it("keeps only the first line with text, capped at 200 characters", async () => {
      const crlf = (await gateScriptChange(failing(128, "fatal: x\r\nmore\r\n"), { base: "abc123" })) ?? "";
      assert.match(crlf, /\(exit 128: fatal: x\)/);

      for (const [length, kept] of [[199, 199], [200, 200], [201, 200]] as const) {
        const long = (await gateScriptChange(failing(128, `${"y".repeat(length)}\nmore`), { base: "abc123" })) ?? "";
        assert.ok(long.includes(`(exit 128: ${"y".repeat(kept)})`), `${length} characters`);
      }

      const blank = (await gateScriptChange(failing(128, "\u0007\u001b\nfatal: real\n"), { base: "abc123" })) ?? "";
      assert.match(blank, /\(exit 128: fatal: real\)/);
    });

    it("replaces everything but printable ASCII with a space", async () => {
      const text = "fatal:\tx\ry\u001b[31mz\u007f\u009bq\u202ew\u200bv\u2028u\u2029t\u{E0041}s\ufe0fr\u3164p\u00a0o\u{1F600}n\u001fm}~l";
      const message = (await gateScriptChange(failing(128, text), { base: "abc123" })) ?? "";

      assert.ok(message.includes("(exit 128: fatal: x y [31mz  q w v u t  s r p o  n m}~l)"), message);
    });

    it("never cuts a surrogate pair at the cap", async () => {
      const message = (await gateScriptChange(failing(128, `${"y".repeat(199)}\u{1F600}`), { base: "abc123" })) ?? "";

      assert.ok(!/[\ud800-\udfff]/.test(message), message);
      assert.ok(message.includes(`(exit 128: ${"y".repeat(199)})`), message);
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

// The step limit (lib/step-limit.mts) answers a gate it killed with exit code 124 and the step named in the output.
describe("a gate the step limit killed", () => {
  it("is a red gate that goes through the fixer's attempts, and the failure comment names the step", async () => {
    let time = 0;
    const commands: string[] = [];
    const raw = {
      exec: async (command: string) => {
        commands.push(command);
        if (command.includes(GATE_COMMAND)) return { stdout: "building...\n", stderr: "", exitCode: 124 };
        return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
      },
    } as unknown as Sandbox;
    const limited = limitSandboxExec(raw, { log: () => undefined, now: () => (time += GATE_LIMIT_MINUTES * 60_000) });
    let fixes = 0;

    const result = await runCheckpoint(1, { gate: () => runGate(limited), fix: async () => void fixes++ }, () => undefined);

    assert.equal(result.passed, false);
    assert.equal(fixes, GATE_FIXER_ATTEMPTS);
    assert.match(result.output, /The step "the gate" ran over its \d+-minute limit and was killed\.$/);
    assert.match(gateFailureComment(1, "fix/1-x", result.output), /The step "the gate" ran over its \d+-minute limit and was killed\./);
    assert.equal(commands.filter((command) => command.includes(GATE_COMMAND)).length, GATE_FIXER_ATTEMPTS + 1);
  });
});
