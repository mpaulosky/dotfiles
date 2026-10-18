import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Extracts the fenced ```bash ... ``` Commands block from CLAUDE.md.
const commandsBlock = () => {
  const claudeMd = read("CLAUDE.md");
  const start = claudeMd.indexOf("## Commands");
  assert.notEqual(start, -1, "CLAUDE.md has no Commands section");
  const fenceStart = claudeMd.indexOf("```bash", start);
  assert.notEqual(fenceStart, -1, "Commands section has no ```bash block");
  const fenceEnd = claudeMd.indexOf("```", fenceStart + "```bash".length);
  assert.notEqual(fenceEnd, -1, "Commands ```bash block is not closed");
  return claudeMd.slice(fenceStart, fenceEnd);
};

// Extracts the "// Usage:" note from main.mts's header comment.
const usageNote = () => {
  const mainMts = read(".sandcastle/main.mts");
  const start = mainMts.indexOf("// Usage:");
  assert.notEqual(start, -1, "main.mts header has no Usage note");
  const end = mainMts.indexOf("\nimport", start);
  return mainMts.slice(start, end === -1 ? undefined : end);
};

describe("package.json scripts", () => {
  it("adds a sandcastle script that starts a Sandcastle run", () => {
    const packageJson: { scripts?: Record<string, string> } = JSON.parse(read("package.json"));

    assert.equal(packageJson.scripts?.sandcastle, "tsx .sandcastle/main.mts");
  });
});

// #146: a local run needs SANDCASTLE_ISSUE or SANDCASTLE_LABEL, so the
// bare "pnpm run sandcastle" line is no longer a usable example on its own.
describe("CLAUDE.md Commands block", () => {
  it("shows both local queue-scope forms of pnpm run sandcastle", () => {
    assert.match(commandsBlock(), /^SANDCASTLE_ISSUE=<n> pnpm run sandcastle(?=\s|$)/m);
    assert.match(commandsBlock(), /^SANDCASTLE_LABEL=<label> pnpm run sandcastle(?=\s|$)/m);
  });
});

describe("main.mts header", () => {
  it("points the usage note at both local queue-scope forms", () => {
    assert.match(usageNote(), /SANDCASTLE_ISSUE=<n> pnpm run sandcastle/);
    assert.match(usageNote(), /SANDCASTLE_LABEL=<label> pnpm run sandcastle/);
  });
});

// #146, "Document SANDCASTLE_ISSUE and SANDCASTLE_LABEL in
// .sandcastle/.env.example": Sandcastle passes every key the file defines
// into the sandbox, so both variables must stay commented out there and be
// set on the command line instead.
describe(".sandcastle/.env.example", () => {
  it("mentions both SANDCASTLE_ISSUE and SANDCASTLE_LABEL, commented out", () => {
    const envExample = read(".sandcastle/.env.example");

    assert.match(envExample, /SANDCASTLE_ISSUE/);
    assert.match(envExample, /SANDCASTLE_LABEL/);
    for (const line of envExample.split("\n")) {
      if (/SANDCASTLE_ISSUE|SANDCASTLE_LABEL/.test(line)) {
        assert.match(line.trim(), /^#/, `expected "${line}" to be commented out`);
      }
    }
  });
});

// #146: the queue scope must be resolved, and the run must exit on a bad
// one, before anything touches git, gh or a sandbox.
describe("main.mts's queue-scope wiring", () => {
  it("resolves the queue scope before protectHostGit() and ensureLabels()", () => {
    const mainMts = read(".sandcastle/main.mts");
    const scopeCall = mainMts.indexOf("queueScopeFrom(");
    const protectCall = mainMts.indexOf("protectHostGit()");
    const ensureLabelsCall = mainMts.indexOf("ensureLabels()");

    assert.notEqual(scopeCall, -1, "main.mts doesn't call queueScopeFrom(");
    assert.ok(scopeCall < protectCall, "main.mts doesn't resolve the queue scope before protectHostGit()");
    assert.ok(scopeCall < ensureLabelsCall, "main.mts doesn't resolve the queue scope before ensureLabels()");
  });
});

describe("main.mts's queue round", () => {
  it("starts a fresh queue round at the top of each round, before the follow-up sweep", () => {
    const mainMts = read(".sandcastle/main.mts");
    const loop = mainMts.indexOf("for (let iteration = 1;");
    const startRound = mainMts.indexOf("startQueueRound()", loop);
    const sweep = mainMts.indexOf("followUpPhase()", loop);

    assert.notEqual(startRound, -1, "main.mts's round loop doesn't call startQueueRound()");
    assert.ok(startRound < sweep, "main.mts doesn't start the queue round before the follow-up sweep");
  });
});

// #146's first acceptance criterion: a local run without SANDCASTLE_ISSUE or
// SANDCASTLE_LABEL must exit non-zero with a usage message and touch
// nothing, not even shell out to gh, git or docker to check whether it
// could.
describe("main.mts entry point", () => {
  it("exits non-zero with a usage message and touches nothing when no queue scope is set", () => {
    const binDir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-usage-bin-")));
    const stubLog = join(binDir, "stub-calls.log");
    try {
      for (const name of ["gh", "git", "docker"]) {
        const path = join(binDir, name);
        writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> "${stubLog}"\nexit 1\n`);
        chmodSync(path, 0o755);
      }
      // Only PATH and HOME: no GITHUB_ACTIONS (set in CI), no GH_TOKEN, and
      // no SANDCASTLE_ISSUE or SANDCASTLE_LABEL from this process's own env.
      const env = { PATH: `${binDir}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "" };
      let status: number | null = null;
      let stderr = "";

      try {
        execFileSync("node", ["--import", "tsx", ".sandcastle/main.mts"], {
          cwd: repoRoot,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        status = (error as { status: number | null }).status;
        stderr = String((error as { stderr?: unknown }).stderr ?? "");
      }

      assert.notEqual(status, 0, `expected main.mts to exit non-zero; stderr:\n${stderr}`);
      assert.match(stderr, /SANDCASTLE_ISSUE/);
      assert.match(stderr, /SANDCASTLE_LABEL/);
      assert.equal(existsSync(stubLog), false, "main.mts shelled out to gh, git or docker before exiting");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

// Covers "`.sandcastle/work/` is gitignored" from issue #72: the architect's
// design note and other inter-role notes live there (lib/build.mts), and
// must never reach a commit. Checked with git itself, rather than by
// pattern-matching .sandcastle/.gitignore's text, since git's own matching
// rules (trailing slashes, anchoring) are what actually decide this.
describe(".sandcastle/.gitignore", () => {
  it("ignores .sandcastle/work/, the folder architect design notes and other inter-role files live in", () => {
    assert.doesNotThrow(
      () => execFileSync("git", ["check-ignore", "--quiet", ".sandcastle/work/72/design.md"], { cwd: repoRoot }),
      "expected git to ignore .sandcastle/work/72/design.md",
    );
  });
});

// main.mts runs at import, so its wiring is checked in its source: intake
// must run before the blocker gate, so a human's questions reach them even
// while a blocker is still in flight (#74).
describe("main.mts's intake wiring", () => {
  it("runs intake before the blocker gate", () => {
    const mainMts = read(".sandcastle/main.mts");
    const intakeCall = mainMts.indexOf("intakePhase(");
    const gateCall = mainMts.indexOf("gateIssues()");

    assert.notEqual(intakeCall, -1, "main.mts doesn't call intakePhase(");
    assert.notEqual(gateCall, -1, "main.mts doesn't call gateIssues()");
    assert.ok(intakeCall < gateCall, "main.mts doesn't run intake before the blocker gate");
  });

  // Without the open PRs, intake would judge, and might hand back, an issue
  // whose work is already waiting for review.
  it("passes intake the open pull requests", () => {
    const mainMts = read(".sandcastle/main.mts");
    const call = mainMts.slice(mainMts.indexOf("intakePhase("), mainMts.indexOf(";", mainMts.indexOf("intakePhase(")));

    assert.match(call, /openPullRequests\(\)/);
  });
});

// Each round closes the umbrellas whose children have all finished (#75).
// It runs before intake and the gate, so it runs even in a round that ends
// early with nothing ready.
describe("main.mts's umbrella wiring", () => {
  it("checks for finished umbrellas in each round, before intake", () => {
    const mainMts = read(".sandcastle/main.mts");
    const loop = mainMts.indexOf("for (let iteration");
    const umbrellaCall = mainMts.indexOf("umbrellaPhase(");
    const intakeCall = mainMts.indexOf("intakePhase(");

    assert.notEqual(umbrellaCall, -1, "main.mts doesn't call umbrellaPhase(");
    assert.ok(loop < umbrellaCall && umbrellaCall < intakeCall, "main.mts doesn't check umbrellas in each round, before intake");
  });
});

// Each round sweeps the open Sandcastle PRs before anything else, so a PR
// falls no further behind, misses no Copilot review, and a closed-without-
// merging issue is handed back even in a round that ends early with nothing
// ready (#77).
describe("main.mts's follow-up wiring", () => {
  it("sweeps open pull requests in each round, before the umbrella check and intake", () => {
    const mainMts = read(".sandcastle/main.mts");
    const loop = mainMts.indexOf("for (let iteration");
    const followUpCall = mainMts.indexOf("followUpPhase(");
    const umbrellaCall = mainMts.indexOf("umbrellaPhase(");
    const intakeCall = mainMts.indexOf("intakePhase(");

    assert.notEqual(followUpCall, -1, "main.mts doesn't call followUpPhase(");
    assert.ok(
      loop < followUpCall && followUpCall < umbrellaCall && umbrellaCall < intakeCall,
      "main.mts doesn't sweep pull requests in each round, before the umbrella check and intake",
    );
  });
});

// #147: a local run without a queue scope must exit before touching git or
// gh (#146's own check, above); a run with a bad SANDCASTLE_BUDGET_MINUTES
// must exit the same way, so the budget is resolved just as early.
describe("main.mts's budget wiring", () => {
  it("resolves the time budget before protectHostGit()", () => {
    const mainMts = read(".sandcastle/main.mts");
    const budgetCall = mainMts.indexOf("budgetMinutesFrom(");
    const protectCall = mainMts.indexOf("protectHostGit()");

    assert.notEqual(budgetCall, -1, "main.mts doesn't call budgetMinutesFrom(");
    assert.ok(budgetCall < protectCall, "main.mts doesn't resolve the time budget before protectHostGit()");
  });

  // No new round starts once the budget, or Claude's usage limit, has
  // stopped the run (#147).
  it("checks the run's limits at the top of each round, before starting a fresh queue round", () => {
    const mainMts = read(".sandcastle/main.mts");
    const loop = mainMts.indexOf("for (let iteration = 1;");
    const stopReasonCall = mainMts.indexOf("runLimits.stopReason()", loop);
    const startRound = mainMts.indexOf("startQueueRound()", loop);

    assert.notEqual(stopReasonCall, -1, "main.mts doesn't call runLimits.stopReason()");
    assert.ok(loop < stopReasonCall && stopReasonCall < startRound, "main.mts doesn't check the run's limits before starting a fresh queue round");
  });

  // Once a pipeline throws UncountedStopError (a usage-limit or budget
  // stop from any role), the run ends cleanly rather than crashing or
  // counting the issue as a failed build.
  it("catches an UncountedStopError around the round loop and ends the run cleanly", () => {
    const mainMts = read(".sandcastle/main.mts");

    assert.match(mainMts, /catch[\s\S]{0,200}instanceof UncountedStopError/);
  });
});

// #147: the early exit must check for work before the Docker image is built
// or Claude is called, so it has to sit after the housekeeping phases and
// before intake, the first phase that can start an agent.
describe("main.mts's early-exit wiring", () => {
  it("checks for work after the umbrella check and before intake", () => {
    const mainMts = read(".sandcastle/main.mts");
    const loop = mainMts.indexOf("for (let iteration = 1;");
    const umbrellaCall = mainMts.indexOf("umbrellaPhase(", loop);
    const findWorkCall = mainMts.indexOf("findWork(", loop);
    const intakeCall = mainMts.indexOf("intakePhase(", loop);

    assert.notEqual(findWorkCall, -1, "main.mts doesn't call findWork(");
    assert.ok(
      umbrellaCall < findWorkCall && findWorkCall < intakeCall,
      "main.mts doesn't check for work after the umbrella check and before intake",
    );
  });
});

// #78: a settled PR the sweep marked as needing a follow-up pass gets one
// before intake runs, since a pass starts an agent the same way intake does,
// and findWork's early exit already counted it as this round's work.
describe("main.mts's follow-up pass wiring", () => {
  it("runs the follow-up pass phase after findWork and before intake, fetching main first", () => {
    const mainMts = read(".sandcastle/main.mts");
    const loop = mainMts.indexOf("for (let iteration = 1;");
    const findWorkCall = mainMts.indexOf("findWork(", loop);
    const fetchMainCall = mainMts.indexOf("fetchMain()", loop);
    const passPhaseCall = mainMts.indexOf("followUpPassPhase(", loop);
    const intakeCall = mainMts.indexOf("intakePhase(", loop);

    assert.notEqual(passPhaseCall, -1, "main.mts doesn't call followUpPassPhase(");
    assert.ok(findWorkCall < fetchMainCall, "main.mts doesn't fetch main before the follow-up pass phase");
    assert.ok(fetchMainCall < passPhaseCall, "main.mts doesn't fetch main before calling followUpPassPhase(");
    assert.ok(passPhaseCall < intakeCall, "main.mts doesn't run the follow-up pass phase before intake");
  });
});

// The follow-up role writes its verdicts to this gitignored file
// (.sandcastle/roles/follow-up.md, lib/follow-up-pass.mts); without it in
// .gitignore the gate's clean-worktree check would fail every pass.
describe(".sandcastle/.gitignore follow-up.json", () => {
  it("ignores .sandcastle/follow-up.json", () => {
    assert.doesNotThrow(
      () => execFileSync("git", ["check-ignore", "--quiet", ".sandcastle/follow-up.json"], { cwd: repoRoot }),
      "expected git to ignore .sandcastle/follow-up.json",
    );
  });
});

// The run report's reportRepo() shells out to gh (repoName()) to link its
// issues and PRs. Doing that before protectHostGit() has run would read git
// remotes through an environment that check hasn't pinned yet, defeating the
// very protection a failed startup (a planted .git/commondir, say) is there
// to guard. reportRepo() must wait for startedUp before it tries gh.
describe("main.mts's reportRepo wiring", () => {
  it("sets startedUp only after clearStaleBuildingLabels(), and reportRepo() checks it before calling repoName()", () => {
    const mainMts = read(".sandcastle/main.mts");
    const clearStaleCall = mainMts.indexOf("clearStaleBuildingLabels()");
    const startedUpTrue = mainMts.indexOf("startedUp = true;");
    const reportRepoFn = mainMts.slice(mainMts.indexOf("function reportRepo"));

    assert.notEqual(clearStaleCall, -1, "main.mts doesn't call clearStaleBuildingLabels()");
    assert.notEqual(startedUpTrue, -1, "main.mts never sets startedUp = true");
    assert.ok(clearStaleCall < startedUpTrue, "main.mts doesn't set startedUp = true after clearStaleBuildingLabels()");
    assert.match(reportRepoFn, /if \(!startedUp\)/, "reportRepo() doesn't check startedUp before calling repoName()");
    assert.ok(reportRepoFn.indexOf("repoName()") > reportRepoFn.indexOf("if (!startedUp)"));
  });
});

// #320: a run whose intake stopped (a repeated failure, such as the missing
// Docker image in the first automatic runs) must end red, whatever hand-backs
// it also made, rather than exit 0 and leave the queue stuck with no signal.
describe("main.mts's intake-stop exit code", () => {
  it("sets the exit code from intakeStopExitCode(intakeStopReport.items()) after writing the run report", () => {
    const mainMts = read(".sandcastle/main.mts");
    const writeReportCall = mainMts.indexOf("writeRunReport(");
    const exitCodeAssignment = mainMts.indexOf("process.exitCode", writeReportCall);

    assert.notEqual(writeReportCall, -1, "main.mts doesn't call writeRunReport(");
    assert.notEqual(exitCodeAssignment, -1, "main.mts never sets process.exitCode");
    assert.ok(exitCodeAssignment > writeReportCall, "main.mts doesn't set process.exitCode after writeRunReport(");
    const assignment = mainMts.slice(exitCodeAssignment, mainMts.indexOf(";", exitCodeAssignment));
    assert.match(assignment, /intakeStopExitCode\(/, "main.mts doesn't derive the exit code from intakeStopExitCode(");
    assert.match(assignment, /intakeStopReport\.items\(\)/, "main.mts doesn't pass intakeStopReport.items() to the exit-code decision");
  });
});

// #147: SANDCASTLE_BUDGET_MINUTES reaches the sandbox like every other key in
// this file, and the host reads the budget from its own environment instead,
// so it must stay commented out, as SANDCASTLE_ISSUE and SANDCASTLE_LABEL do.
describe(".sandcastle/.env.example budget", () => {
  it("mentions SANDCASTLE_BUDGET_MINUTES only on commented-out lines", () => {
    const envExample = read(".sandcastle/.env.example");

    assert.match(envExample, /SANDCASTLE_BUDGET_MINUTES/);
    for (const line of envExample.split("\n")) {
      if (line.includes("SANDCASTLE_BUDGET_MINUTES")) {
        assert.match(line.trim(), /^#/, `expected "${line}" to be commented out`);
      }
    }
  });
});
