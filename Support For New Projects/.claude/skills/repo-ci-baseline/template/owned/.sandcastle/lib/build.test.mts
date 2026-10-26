import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox, SandboxRunOptions } from "@ai-hero/sandcastle";
import { spawnSync, type execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildIssue,
  createCheckedSandbox,
  designComment,
  designNoteIn,
  latestDesignNote,
  isGitHubServerError,
  isWorkflowPushRejection,
  liveHostIdentity,
  PR_BODY_LIMIT,
  publicErrorText,
  prTitle,
  publish,
  remoteBranchIsOnOrigin,
  remoteMainIs,
  UncountedStopError,
  type BuildHost,
  type HostIdentity,
  workflowFilesFrom,
  workflowLogArgs,
} from "./build.mts";
import {
  BUILD_FAILED_MARKER,
  BUILD_ROLES,
  DESIGN_MARKER,
  GATE_FIXER_ATTEMPTS,
  PR_MARKER,
  PUBLISH_RETRY_ATTEMPTS,
  type OptionalRole,
} from "./config.mts";
import { TamperedWorktreeError } from "./errors.mts";
import { gitSandboxFake } from "./git-sandbox-fake.mts";
import { RunLimits } from "./limits.mts";
import type { SecretMatch } from "./scan.mts";
import { GATE_COMMAND, GATE_SCRIPT } from "./repo-config.mts";
import { withUiRole } from "./ui-role-fixture.mts";

// These tests name the Template's gate command, whatever this repo's
// GATE_COMMAND is: the fake sandbox reports the configured one as the default.
const asDefaultGate = (command: string) => (command === `${GATE_COMMAND} 2>&1` ? "scripts/gate.sh 2>&1" : command);

const issue = { number: 69, title: "Run the gate", body: "", labels: ["Sandcastle"], comments: [], roles: [] as OptionalRole[] };

// `issue`, picking the optional roles named in `roles` (see RoledIssue in
// build.mts and resolveRoles in lib/plan.mts).
const withRoles = (roles: OptionalRole[]) => ({ ...issue, roles });
const branch = "feature/69-run-the-gate";
// The commit fetchMain() resolved origin/main to.
const base = "f".repeat(40);

// A match host.leaksSecret can return: a line, so a test can check the log
// and the report name its path and line number without naming the secret.
const sampleSecretMatch: SecretMatch = {
  location: { commit: "c".repeat(40), field: "line", path: "src/example.ts", line: 3 },
  kind: { type: "pattern", shape: "sk-ant-" },
};

// A pr-body.md with the three headings the reviewer must write.
const validPrBody = "## Why\n\nBecause.\n\n## What changed\n\nAdded X.\n\n## Verification\n\nRan the tests.";

// A host whose sandbox records each role run and gate run in `steps`, and
// answers the gate with the queued exit codes in order. A role in `failing`
// throws, and one in `unfinished` ends without signalling completion. A role
// named in `failWith` throws that error instead of the generic timeout.
function host(
  gateExitCodes: number[],
  {
    ahead = 1,
    statuses = [""],
    failing = [],
    failWith = {},
    unfinished = [],
    leaksSecret,
    leaksOnlyInMergedMain,
    worktreeProblems = [],
    publishError,
    designNote,
    designFile = "",
    prBodyFile = validPrBody,
    latestMain = base,
    containsMain = true,
    mergeExitCode = 0,
    abortExitCode = 0,
    latestMainError,
    remoteMain,
    remoteMainError,
    mainWorkflowFiles = [],
    pushRefusesWorkflowChanges = true,
    branchOnOrigin = false,
    createBranchError,
    deleteBranchError,
    baseExecError,
    baseIsAncestor = true,
    gateOutput,
    gateScriptChanged = "",
    checkFiles = "",
    checkFilesError,
  }: {
    ahead?: number | number[];
    statuses?: string[];
    failing?: string[];
    failWith?: Record<string, Error>;
    unfinished?: string[];
    leaksSecret?: SecretMatch;
    // A match that sits only in the commits main gained since `base`, so
    // leaksSecret returns it unless the scan excludes the merged main
    // commit's history, as the live scan does.
    leaksOnlyInMergedMain?: SecretMatch;
    worktreeProblems?: string[];
    publishError?: string;
    // What latestDesignNote returns for the architect's prompt: the body of
    // its latest earlier design comment, or undefined on a first run.
    designNote?: string;
    // The content .sandcastle/work/{n}/design.md holds in the sandbox once
    // the architect has run, read back and posted as the issue's design
    // comment (see DESIGN_MARKER in lib/config.mts).
    designFile?: string;
    // The content .sandcastle/work/{n}/pr-body.md holds in the sandbox once
    // the reviewer has run: its Why, What changed and Verification sections,
    // read back before publish() is called. A valid one by default, as
    // a reviewer that finished writes, so a test that pins the log isn't
    // handed the fallback's line.
    prBodyFile?: string;
    // What every gate run prints, instead of "gate output, exit <n>".
    gateOutput?: string;
    // The commit latestMain() resolves origin/main to just before checkpoint
    // 2, whether the branch already contains it, how `git merge` of it and
    // `git merge --abort` exit, and an error latestMain() throws instead (a
    // failed fetch).
    latestMain?: string;
    containsMain?: boolean;
    mergeExitCode?: number;
    abortExitCode?: number;
    latestMainError?: string;
    // What the remote says main is when buildIssue asks (isRemoteMain), for
    // the check that the merged main commit is really GitHub's: the
    // latestMain commit by default, and an error it throws instead.
    remoteMain?: string;
    remoteMainError?: string;
    // The workflow files `<branch head>..<latest main>` touches: what
    // workflowFiles returns when asked about the range ending at latestMain.
    // Empty by default, as when main hasn't changed a workflow.
    mainWorkflowFiles?: string[];
    // Whether the push token lacks the Workflows permission, as in Actions
    // (the default); false is a local `Sandcastle:local` run.
    pushRefusesWorkflowChanges?: boolean;
    // Whether origin already has the issue's branch (an earlier round pushed
    // it), and an error creating it at `base` throws.
    branchOnOrigin?: boolean;
    createBranchError?: string;
    deleteBranchError?: string;
    baseExecError?: string;
    // Whether `base` is an ancestor of the commit the gate passed on; false
    // when an earlier round's branch was built on an older main.
    baseIsAncestor?: boolean;
    // What `git diff -z` prints for the gate script when it differs from base's, and
    // for the files under CHECK_PATHS that do.
    gateScriptChanged?: string;
    checkFiles?: string;
    // An error listing the files under CHECK_PATHS throws instead.
    checkFilesError?: string;
  } = {},
) {
  const steps: string[] = [];
  const runs: SandboxRunOptions[] = [];
  const logs: string[] = [];
  const comments: { issueNumber: number; body: string }[] = [];
  const recordBuildFailureCalls: { issueNumber: number; branch: string; detail: string }[] = [];
  // Every role run and markBuilding/unmarkBuilding call, in the order they
  // happened, so a test can check the label is added before the first role
  // runs and removed however the build stopped, without the other tests'
  // `steps` assertions having to account for it.
  const order: string[] = [];
  const aheadCounts = Array.isArray(ahead) ? [...ahead] : [ahead];
  const worktreeStatuses = [...statuses];
  let aheadIndex = 0;
  // Each role run commits, so HEAD is a new commit after every run.
  let headNumber = 0;
  const head = () => headNumber.toString(16).padStart(40, "0");
  const aheadBranches: string[] = [];
  const aheadBases: string[] = [];
  const scanned: string[] = [];
  const scannedBases: string[] = [];
  const scannedExclusions: (string | undefined)[] = [];
  const listedExclusions: (string | undefined)[] = [];
  const mainChecks: string[] = [];
  const baseChecks: string[] = [];
  const workflowFileCalls: { from: string; to: string }[] = [];
  const pushed: { branch: string; commit: string }[] = [];
  // Each command on .sandcastle/work/ (the design note), with how many role
  // runs came before it.
  const workCommands: { command: string; rolesRun: number }[] = [];
  const sandbox = {
    worktreePath: "/worktree",
    run: async (options: SandboxRunOptions) => {
      // runRoleInSandbox always names the run after its role.
      const role = options.name!;
      runs.push(options);
      headNumber++;
      steps.push(role === "gate-fixer" ? `gate-fixer ${options.promptArgs?.CHECKPOINT}` : role);
      order.push(role);
      if (failing.includes(role)) throw failWith[role] ?? new Error(`${role} timed out`);
      return {
        iterations: [],
        commits: [{ sha: role }],
        completionSignal: unfinished.includes(role) ? undefined : "<promise>COMPLETE</promise>",
      };
    },
    exec: async (rawCommand: string) => {
      const command = asDefaultGate(rawCommand);
      if (command.startsWith("git status")) {
        const stdout = worktreeStatuses.shift() ?? "";
        return { stdout, stderr: "", exitCode: 0 };
      }
      if (command === "git rev-parse HEAD") {
        return { stdout: `${head()}\n`, stderr: "", exitCode: 0 };
      }
      if (command.startsWith(`git merge-base --is-ancestor '${base}'`)) {
        baseChecks.push(command);
        if (baseExecError !== undefined) throw new Error(baseExecError);
        return { stdout: "", stderr: "", exitCode: baseIsAncestor ? 0 : 1 };
      }
      if (command.startsWith("git merge-base --is-ancestor")) {
        mainChecks.push(command);
        return { stdout: "", stderr: "", exitCode: containsMain ? 0 : 1 };
      }
      if (command.startsWith("git --no-replace-objects") && command.includes(" cat-file -e ")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.startsWith("git --no-replace-objects") && command.includes(" merge-base ")) {
        return { stdout: `${"e".repeat(40)}\n`, stderr: "", exitCode: 0 };
      }
      if (command.startsWith("git --no-replace-objects") && command.includes(" diff ")) {
        // The gate guard asks about the gate script alone, the PR body's note about CHECK_PATHS.
        const forGuard = command.split(" -- ")[1]?.replace(" 2>/dev/null", "") === `'${GATE_SCRIPT}'`;
        if (forGuard) gateGuardChecks.push(command);
        if (!forGuard && checkFilesError !== undefined) throw new Error(checkFilesError);
        return { stdout: forGuard ? gateScriptChanged : checkFiles, stderr: "", exitCode: 0 };
      }
      if (command.startsWith("git merge --abort")) {
        steps.push("merge abort");
        return { stdout: "", stderr: "", exitCode: abortExitCode };
      }
      if (command.startsWith("git merge ")) {
        // A conflicting merge leaves HEAD where it was.
        if (mergeExitCode === 0) headNumber++;
        steps.push(`merge ${command.split(" ").at(-1)}`);
        return { stdout: "", stderr: mergeExitCode === 0 ? "" : "CONFLICT (content)", exitCode: mergeExitCode };
      }
      const reset = /^git reset --hard '([0-9a-f]+)'$/.exec(command);
      if (reset) {
        headNumber = Number.parseInt(reset[1]!, 16);
        steps.push(`reset ${reset[1]}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes(".sandcastle/work/")) {
        workCommands.push({ command, rolesRun: runs.length });
        if (command.includes("pr-body.md")) {
          return { stdout: prBodyFile, stderr: "", exitCode: 0 };
        }
        return { stdout: designFile, stderr: "", exitCode: 0 };
      }
      steps.push(`gate: ${command}`);
      const exitCode = gateExitCodes.shift();
      if (exitCode === undefined) throw new Error("the gate ran more often than the test expected");
      return { stdout: gateOutput ?? `gate output, exit ${exitCode}\n`, stderr: "", exitCode };
    },
    close: async () => {
      steps.push("close");
      order.push("close");
      return {};
    },
  } as unknown as Sandbox;
  const buildingCalls: number[] = [];
  const designNoteCalls: number[] = [];
  const gateGuardChecks: string[] = [];
  const publishedCheckChanges: (readonly string[])[] = [];
  const publishCalls: { reviewed: boolean; docsFailed: boolean }[] = [];
  // The prBody argument buildMarkedIssue passed to host.publish, one entry
  // per call, kept apart from publishCalls so existing assertions on that
  // shape don't have to change.
  const publishedPrBodies: (string | undefined)[] = [];
  const startFromMainCalls: { issueNumber: number; branch: string; base: string }[] = [];
  const handBackWorkflowChangeCalls: { issueNumber: number; branch: string; detail: string; change: { head: string; files: string[] } }[] = [];
  const moveToLocalCalls: {
    issueNumber: number;
    branch: string;
    detail: string;
    change: { head: string; files: string[] };
    createdAtBase: boolean;
  }[] = [];
  const deletedBranches: { branch: string; commit: string }[] = [];
  const createdBranches: { branch: string; commit: string }[] = [];
  // "create-branch", "publish", "delete-branch" and "move-to-local" in the order the host did them, kept apart
  // from `steps` so the existing assertions on its exact list don't change.
  const publishEvents: string[] = [];
  const buildHost: BuildHost = {
    createSandbox: async () => {
      order.push("create");
      return sandbox;
    },
    startFromMain: (issueNumber, startFromMainBranch, startFromMainBase) => {
      order.push("startFromMain");
      startFromMainCalls.push({ issueNumber, branch: startFromMainBranch, base: startFromMainBase });
      return undefined;
    },
    commitsAhead: (aheadBranch, aheadBase) => {
      aheadBranches.push(aheadBranch);
      aheadBases.push(aheadBase);
      const current = aheadCounts[Math.min(aheadIndex, aheadCounts.length - 1)] ?? 0;
      aheadIndex++;
      return current;
    },
    commentOnIssue: (issueNumber, body) => void comments.push({ issueNumber, body }),
    recordBuildFailure: (issueNumber, failureBranch, detail) => {
      recordBuildFailureCalls.push({ issueNumber, branch: failureBranch, detail });
      // The real BuildHost posts the attempt's comment itself; this stub
      // mirrors that into `comments` too, so assertions on the comment text
      // don't have to care which host method produced it.
      comments.push({ issueNumber, body: detail });
    },
    markBuilding: (issueNumber) => {
      buildingCalls.push(issueNumber);
      order.push("mark");
      return true;
    },
    unmarkBuilding: (issueNumber) => {
      buildingCalls.push(issueNumber);
      order.push("unmark");
    },
    latestDesignNote: (issueNumber) => {
      designNoteCalls.push(issueNumber);
      return designNote;
    },
    log: (line) => void logs.push(line),
    leaksSecret: (scanBase, commit, mergedMain) => {
      scannedBases.push(scanBase);
      scanned.push(commit);
      scannedExclusions.push(mergedMain);
      return leaksSecret ?? (mergedMain === undefined ? leaksOnlyInMergedMain : undefined);
    },
    publish: async (_issue, publishedBranch, commit, reviewed, docsFailed, prBody, checkChanges = []) => {
      if (publishError) throw new Error(publishError);
      pushed.push({ branch: publishedBranch, commit });
      publishEvents.push("publish");
      publishCalls.push({ reviewed, docsFailed });
      publishedPrBodies.push(prBody);
      publishedCheckChanges.push(checkChanges);
      steps.push(`publish${reviewed ? "" : " unreviewed"}${docsFailed ? " docs-failed" : ""}`);
      return "https://github.com/o/r/pull/1";
    },
    latestMain: () => {
      if (latestMainError !== undefined) throw new Error(latestMainError);
      return latestMain;
    },
    isRemoteMain: (commit) => {
      if (remoteMainError !== undefined) throw new Error(remoteMainError);
      return commit === (remoteMain ?? latestMain);
    },
    worktreeProblems: () => worktreeProblems,
    publicError: (error) => publicErrorText(String(error instanceof Error ? error.message : error), () => false),
    limits: new RunLimits(),
    pushRefusesWorkflowChanges,
    workflowFiles: (from, to, mergedMain) => {
      workflowFileCalls.push({ from, to });
      // The range ending at main is the sync check's; any other range
      // is the base..gated one the hand-back lists, which leaves out the main
      // commit syncWithMain merged.
      if (to === latestMain) return mainWorkflowFiles;
      listedExclusions.push(mergedMain);
      return [`.github/workflows/${from.slice(0, 4)}-${to.slice(0, 4)}.yml`];
    },
    handBackWorkflowChange: (issueNumber, failureBranch, detail, change) => {
      handBackWorkflowChangeCalls.push({ issueNumber, branch: failureBranch, detail, change });
    },
    remoteBranchExists: () => branchOnOrigin,
    createBranchAt: (createdBranch, commit) => {
      if (createBranchError !== undefined) throw new Error(createBranchError);
      createdBranches.push({ branch: createdBranch, commit });
      publishEvents.push("create-branch");
    },
    moveToLocal: (issueNumber, failureBranch, detail, change, createdAtBase) => {
      publishEvents.push("move-to-local");
      moveToLocalCalls.push({ issueNumber, branch: failureBranch, detail, change, createdAtBase });
    },
    deleteBranchAt: (deletedBranch, commit) => {
      if (deleteBranchError !== undefined) throw new Error(deleteBranchError);
      publishEvents.push("delete-branch");
      deletedBranches.push({ branch: deletedBranch, commit });
    },
  };
  return {
    steps, runs, logs, comments, recordBuildFailureCalls, buildHost, aheadBranches, aheadBases, scanned, scannedBases, pushed, head,
    order, buildingCalls, designNoteCalls, publishCalls, publishedPrBodies, publishedCheckChanges, gateGuardChecks, workCommands, startFromMainCalls, handBackWorkflowChangeCalls,
    mainChecks, baseChecks, scannedExclusions, listedExclusions, workflowFileCalls, moveToLocalCalls, createdBranches, deletedBranches, publishEvents,
  };
}

describe("buildIssue", () => {
  it("runs the tester, the backend developer, checkpoint 1, the reviewer and checkpoint 2 before publishing", async () => {
    const { steps, comments, buildHost } = host([0, 0]);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps, [
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "reviewer",
      "gate: scripts/gate.sh 2>&1",
      "publish",
      "close",
    ]);
    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
    assert.equal(result.publishFailed, false);
    assert.deepEqual(comments, []);
  });

  it("logs each role and checkpoint of a built issue in the order they ran", async () => {
    const { logs, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(logs, [
      "  #69 tester finished",
      "  #69 backend finished",
      "  #69 checkpoint 1: gate passed",
      "  #69 reviewer finished",
      "  #69 checkpoint 2: gate passed",
    ]);
  });

  it("runs the tester and the backend developer from their role prompts, with the shared rules", async () => {
    const { runs, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    for (const role of ["tester", "backend"]) {
      const run = runs.find((options) => options.name === role)!;
      assert.equal(run.promptFile, `./.sandcastle/roles/${role}.md`);
      assert.equal(run.promptArgs?.TASK_ID, "69");
      assert.equal(run.promptArgs?.BRANCH, branch);
      assert.ok(run.promptArgs?.SHARED_RULES);
    }
  });

  for (const role of ["tester", "backend"]) {
    const stepsUntilClose = role === "tester" ? ["tester", "close"] : ["tester", "backend", "close"];

    it(`publishes nothing and runs no gate when the ${role} fails`, async () => {
      const { steps, buildHost } = host([], { failing: [role] });

      const result = await buildIssue(issue, branch, base, buildHost);

      assert.deepEqual(steps, stepsUntilClose);
      assert.equal(result.prUrl, undefined);
    });

    it(`comments on the issue with the error when the ${role} fails`, async () => {
      const { comments, buildHost } = host([], { failing: [role] });

      await buildIssue(issue, branch, base, buildHost);

      assert.equal(comments.length, 1);
      assert.equal(comments[0]!.issueNumber, 69);
      assert.match(comments[0]!.body, new RegExp(`the ${role} failed`));
      assert.match(comments[0]!.body, new RegExp(`${role} timed out`));
      assert.match(comments[0]!.body, new RegExp(`\`${branch}\` wasn't pushed`));
    });

    // A role's error carries claude-code's stderr or its last stream-json
    // lines, which can hold tool output: the sandbox's token, a mention, or a
    // host marker that markerComments would count.
    it(`withholds a ${role} error that looks like it holds a secret`, async () => {
      const { comments, buildHost } = host([], { failing: [role], failWith: { [role]: new Error("exit 1: GH token ghp_abc in the output") } });
      buildHost.publicError = (text) => publicErrorText(String(text instanceof Error ? text.message : text), (cleaned) => cleaned.includes("ghp_"));

      await buildIssue(issue, branch, base, buildHost);

      assert.doesNotMatch(comments[0]!.body, /ghp_/);
      assert.match(comments[0]!.body, /looked like it held a secret/);
    });

    it(`quotes a ${role} error in a code block, with its <!-- broken, so it can't mention anyone or pass for a host comment`, async () => {
      const error = new Error("exit 1: <!-- sandcastle:build-failed --> cc @someone, see #12");
      const { comments, buildHost } = host([], { failing: [role], failWith: { [role]: error } });

      await buildIssue(issue, branch, base, buildHost);

      const body = comments[0]!.body;
      assert.ok(!body.includes("<!-- sandcastle:build-failed"), body);
      assert.match(body, /\n```+text\n[^\n]*@someone, see #12[^\n]*\n```+$/);
    });

    it(`publishes nothing and runs no gate when the ${role} runs out of iterations unfinished`, async () => {
      const { steps, logs, buildHost } = host([], { unfinished: [role] });

      const result = await buildIssue(issue, branch, base, buildHost);

      assert.deepEqual(steps, stepsUntilClose);
      assert.equal(result.prUrl, undefined);
      assert.ok(!logs.includes(`  #69 ${role} finished`));
    });

    it(`comments on the issue when the ${role} runs out of iterations unfinished`, async () => {
      const { comments, buildHost } = host([], { unfinished: [role] });

      await buildIssue(issue, branch, base, buildHost);

      assert.equal(comments.length, 1);
      assert.equal(comments[0]!.issueNumber, 69);
      assert.match(comments[0]!.body, new RegExp(`the ${role} ran out of iterations`));
      assert.match(comments[0]!.body, new RegExp(`\`${branch}\` wasn't pushed`));
    });
  }

  for (const role of ["tester", "backend"]) {
    it(`treats a ${role} failure as a failed build attempt`, async () => {
      const { recordBuildFailureCalls, buildHost } = host([], { failing: [role] });

      await buildIssue(issue, branch, base, buildHost);

      assert.equal(recordBuildFailureCalls.length, 1);
      assert.equal(recordBuildFailureCalls[0]!.issueNumber, 69);
      assert.equal(recordBuildFailureCalls[0]!.branch, branch);
    });

    it(`rethrows a usage-limit or time-budget stop from the ${role} instead of treating it as a failed attempt`, async () => {
      const stop = new UncountedStopError("usage limit reached");
      const { comments, recordBuildFailureCalls, buildHost } = host([], { failing: [role], failWith: { [role]: stop } });

      await assert.rejects(
        () => buildIssue(issue, branch, base, buildHost),
        (error: unknown) => error instanceof UncountedStopError && error.message === "usage limit reached",
      );

      assert.deepEqual(comments, []);
      assert.deepEqual(recordBuildFailureCalls, []);
    });
  }

  it("rethrows a usage-limit or time-budget stop from the gate-fixer instead of treating it as a failed attempt", async () => {
    const stop = new UncountedStopError("time budget spent");
    const { steps, recordBuildFailureCalls, buildHost } = host([1], { failing: ["gate-fixer"], failWith: { "gate-fixer": stop } });

    await assert.rejects(() => buildIssue(issue, branch, base, buildHost), (error: unknown) => error === stop);

    assert.equal(steps.filter((step) => step.startsWith("gate:")).length, 1);
    assert.deepEqual(recordBuildFailureCalls, []);
  });

  it("rethrows a usage-limit or time-budget stop from the reviewer instead of publishing unreviewed", async () => {
    const stop = new UncountedStopError("usage limit reached");
    const { pushed, recordBuildFailureCalls, buildHost } = host([0], { failing: ["reviewer"], failWith: { reviewer: stop } });

    await assert.rejects(() => buildIssue(issue, branch, base, buildHost), (error: unknown) => error === stop);

    assert.deepEqual(pushed, []);
    assert.deepEqual(recordBuildFailureCalls, []);
  });

  it("treats a checkpoint that stays red after the gate-fixer's attempts as a failed build attempt", async () => {
    const { recordBuildFailureCalls, buildHost } = host([1, 1, 1]);

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(recordBuildFailureCalls.length, 1);
    assert.equal(recordBuildFailureCalls[0]!.issueNumber, 69);
  });

  it("doesn't treat a gate-fixer attempt as a failed build attempt when the checkpoint later passes", async () => {
    const { recordBuildFailureCalls, buildHost } = host([1, 0, 1, 1, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(recordBuildFailureCalls, []);
  });

  it("doesn't treat a reviewer failure as a failed build attempt", async () => {
    const { recordBuildFailureCalls, buildHost } = host([0, 0], { failing: ["reviewer"] });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(recordBuildFailureCalls, []);
  });

  it("keeps the commits of a developer run that came before the failure", async () => {
    const { buildHost } = host([], { failing: ["backend"] });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(result.commits.map((commit) => commit.sha), ["tester"]);
  });

  it("gives a red gate to the gate-fixer and carries on once it passes", async () => {
    const { steps, buildHost } = host([1, 0, 1, 1, 0]);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps.filter((step) => !step.startsWith("gate:")), [
      "tester",
      "backend",
      "gate-fixer 1",
      "reviewer",
      "gate-fixer 2",
      "gate-fixer 2",
      "publish",
      "close",
    ]);
    assert.deepEqual(result.commits.map((commit) => commit.sha), [
      "tester", "backend", "gate-fixer", "reviewer", "gate-fixer", "gate-fixer",
    ]);
  });

  it("publishes nothing and comments on the issue when checkpoint 1 stays red", async () => {
    const { steps, comments, buildHost } = host([1, 1, 1]);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps.filter((step) => !step.startsWith("gate:")), ["tester", "backend", "gate-fixer 1", "gate-fixer 1", "close"]);
    assert.equal(result.prUrl, undefined);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.issueNumber, 69);
    assert.match(comments[0]!.body, /checkpoint 1/);
    assert.match(comments[0]!.body, /gate output, exit 1/);
  });

  // The gate is the branch's own scripts and tests, which agents write, run
  // in the sandbox that holds the Claude token.
  it("withholds red gate output that looks like it holds a secret", async () => {
    const { comments, buildHost } = host([1, 1, 1], { gateOutput: "FAIL: env dump\nCLAUDE_CODE_OAUTH_TOKEN=ghp_abc\n" });
    buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await buildIssue(issue, branch, base, buildHost);

    assert.doesNotMatch(comments[0]!.body, /ghp_/);
    assert.match(comments[0]!.body, /looked like it held a secret/);
  });

  it("breaks a host marker's <!-- in red gate output", async () => {
    const { comments, buildHost } = host([1, 1, 1], { gateOutput: "FAIL: expected <!-- sandcastle:build-failed --> in the comment\n" });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(!comments[0]!.body.includes("<!-- sandcastle:build-failed"), comments[0]!.body);
    assert.match(comments[0]!.body, /sandcastle:build-failed/);
  });

  it("publishes nothing and comments on the issue when checkpoint 2 stays red", async () => {
    const { steps, comments, buildHost } = host([0, 1, 1, 1]);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.includes("publish"));
    assert.equal(result.prUrl, undefined);
    assert.match(comments[0]!.body, /checkpoint 2/);
  });

  it("skips the gate when the branch holds nothing main doesn't", async () => {
    const { steps, buildHost } = host([], { ahead: 0 });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps, ["tester", "backend", "close"]);
    assert.equal(result.prUrl, undefined);
  });

  it("runs checkpoint 1 when the worktree is dirty even if no commits are ahead", async () => {
    const { steps, comments, buildHost } = host([0, 0, 0], {
      ahead: [0, 0],
      statuses: [" M src/App.razor\n", " M src/App.razor\n", " M src/App.razor\n", " M src/App.razor\n"],
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps.filter((step) => !step.startsWith("gate:")), ["tester", "backend", "gate-fixer 1", "gate-fixer 1", "close"]);
    assert.equal(result.prUrl, undefined);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /checkpoint 1/);
    assert.match(comments[0]!.body, /uncommitted changes/);
  });
});

// AC: buildIssue's outcome and detail reach the run report (lib/report.mts).
describe("buildIssue's outcome and detail", () => {
  it("is published, with the PR's URL as its detail", async () => {
    const { buildHost } = host([0, 0]);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(result.detail, "https://github.com/o/r/pull/1");
  });

  it("is role failed, naming the role, when a developer role fails", async () => {
    const { buildHost } = host([], { failing: ["tester"] });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "role failed");
    assert.match(result.detail ?? "", /the tester failed/);
  });

  it("is timed out when a developer role's own timeout aborts it", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { buildHost } = host([], { failing: ["tester"], failWith: { tester: timeout } });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "timed out");
  });

  it("hands the files the branch changes under the gate's and CI's folders to publish", async () => {
    const { publishedCheckChanges, buildHost } = host([0, 0], { checkFiles: ".github/ci/a.sh\0scripts/gate.sh\0" });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(publishedCheckChanges, [[".github/ci/a.sh", "scripts/gate.sh"]]);
  });

  it("still publishes when listing the files under the gate's and CI's folders throws", async () => {
    const { publishedCheckChanges, logs, buildHost } = host([0, 0], { checkFilesError: "container died" });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "published");
    assert.deepEqual(publishedCheckChanges, [[]]);
    assert.ok(logs.some((line) => line.includes("can't be listed")), logs.join("\n"));
  });

  it("is gate failed, naming the checkpoint, when a checkpoint stays red past the gate-fixer's attempts", async () => {
    const { buildHost } = host([1, 1, 1]);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "gate failed");
    assert.match(result.detail ?? "", /checkpoint 1/);
  });

  it("fails the gate without running it when a commit of the branch changes the gate script", async () => {
    const { steps, gateGuardChecks, buildHost } = host([], { gateScriptChanged: `${GATE_SCRIPT}\0` });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "gate failed");
    assert.ok(gateGuardChecks.length > 0);
    assert.ok(gateGuardChecks.some((command) => command.includes(`'${base}' 'HEAD'`)), gateGuardChecks.join("\n"));
    assert.ok(!steps.some((step) => step.startsWith("gate:")), steps.join("\n"));
  });

  it("is not published, naming the secret, when a commit holds one of the sandbox's secrets", async () => {
    const { buildHost } = host([0, 0], { leaksSecret: sampleSecretMatch });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "not published");
    assert.match(result.detail ?? "", /secret/);
  });

  it("is not published when the branch holds nothing main doesn't", async () => {
    const { buildHost } = host([], { ahead: 0 });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "not published");
  });
});

describe("buildIssue publishing", () => {
  it("counts the branch's commits by ref from the pinned base, not in the worktree", async () => {
    const { aheadBranches, aheadBases, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(aheadBranches.length > 0);
    assert.ok(aheadBranches.every((counted) => counted === branch));
    assert.ok(aheadBases.every((counted) => counted === base));
  });

  it("scans and pushes the commit checkpoint 2's gate passed on", async () => {
    const { pushed, scanned, scannedBases, head, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    // tester, backend and reviewer each committed once.
    assert.equal(head(), (3).toString(16).padStart(40, "0"));
    assert.deepEqual(pushed, [{ branch, commit: head() }]);
    assert.deepEqual(scanned, [head()]);
    assert.deepEqual(scannedBases, [base]);
  });

  it("pushes the commit after the gate-fixer's when checkpoint 2 needed it", async () => {
    const { pushed, head, buildHost } = host([0, 1, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(head(), (4).toString(16).padStart(40, "0"));
    assert.deepEqual(pushed, [{ branch, commit: head() }]);
  });

  it("publishes nothing when a commit holds a secret, and doesn't quote it", async () => {
    const { steps, comments, buildHost } = host([0, 0], { leaksSecret: sampleSecretMatch });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.includes("publish"));
    assert.equal(result.prUrl, undefined);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /holds one of the sandbox's secrets/);
    assert.match(comments[0]!.body, new RegExp(`\`${branch}\` wasn't pushed`));
  });

  it("logs the match's location, and adds it to the run report, without naming the secret itself or changing the public comment", async () => {
    const { logs, comments, buildHost } = host([0, 0], { leaksSecret: sampleSecretMatch });

    const result = await buildIssue(issue, branch, base, buildHost);

    const logged = logs.join("\n");
    assert.match(logged, /src\/example\.ts/);
    assert.match(logged, /\b3\b/);
    assert.match(result.detail ?? "", /src\/example\.ts/);
    assert.match(result.detail ?? "", /\b3\b/);
    // The public comment on the issue stays as it is: no path or line number.
    assert.equal(comments.length, 1);
    assert.doesNotMatch(comments[0]!.body, /src\/example\.ts/);
  });

  it("comments on the issue, and closes the sandbox, when the push is rejected", async () => {
    const { steps, comments, buildHost } = host([0, 0], {
      publishError: "git push --quiet origin abc:refs/heads/x failed:\n ! [rejected] abc -> x (non-fast-forward)",
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.prUrl, undefined);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, new RegExp(`couldn't publish \`${branch}\``));
    assert.match(comments[0]!.body, /non-fast-forward/);
    // GitHub can create the PR and still answer with an error, so the comment
    // asks the reader to check rather than saying none is open.
    assert.match(comments[0]!.body, /check whether a pull request from it is already open/i);
    assert.doesNotMatch(comments[0]!.body, /no pull request is open/);
    // The push runs before the PR is opened, so the advice covers a branch
    // origin lacks and one it already has.
    // An earlier round may have pushed the branch already, so the reader checks
    // origin's head against the commit the gate passed on, not that it exists.
    assert.match(comments[0]!.body, new RegExp(`if origin's \`${branch}\` isn't at \`[0-9a-f]+\``));
    assert.doesNotMatch(comments[0]!.body, /: If /);
    assert.match(comments[0]!.body, new RegExp(`open one by hand with \`Closes #${issue.number}\``));
    assert.equal(steps.at(-1), "close");
  });

  it("flags the result as a publish failure when publishing fails after its retries, unlike a round with nothing to publish", async () => {
    const failed = await buildIssue(
      issue,
      branch,
      base,
      host([0, 0], { publishError: "gh pr create failed:\n remote: Internal Server Error" }).buildHost,
    );
    const nothingToPublish = await buildIssue(issue, branch, base, host([], { ahead: 0 }).buildHost);

    assert.equal(failed.publishFailed, true);
    assert.equal(nothingToPublish.publishFailed, false);
  });

  it("says so on the issue, and stops the round, when the sandbox was left in place for a tampered worktree", async () => {
    const { comments, buildHost } = host([0, 0]);
    const tampered: BuildHost = {
      ...buildHost,
      createSandbox: async () => {
        throw new TamperedWorktreeError("setting the identity failed; left /work/tree in place", "/work/tree");
      },
    };

    await assert.rejects(buildIssue(issue, branch, base, tampered), TamperedWorktreeError);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /no longer points at this repository/);
  });

  it("closes the sandbox when its worktree still points at this repository", async () => {
    const { steps, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(steps.at(-1), "close");
  });

  it("leaves a worktree that no longer points at this repository, and says so on the issue", async () => {
    const { steps, comments, buildHost } = host([0, 0], { worktreeProblems: ["/worktree/.git doesn't point into /repo/.git/worktrees"] });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.includes("close"));
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /no longer points at this repository/);
  });
});

describe("buildIssue syncing with main before publishing", () => {
  // The commit origin/main has moved on to since the round started.
  const newerMain = "a".repeat(40);

  it("merges main in after the reviewer and before checkpoint 2 when the branch doesn't contain it", async () => {
    const { steps, mainChecks, logs, buildHost } = host([0, 0], { latestMain: newerMain, containsMain: false });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps, [
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "reviewer",
      `merge '${newerMain}'`,
      "gate: scripts/gate.sh 2>&1",
      "publish",
      "close",
    ]);
    assert.deepEqual(mainChecks, [`git merge-base --is-ancestor '${newerMain}' HEAD`]);
    assert.ok(logs.includes("  #69 merged main in before checkpoint 2"));
  });

  it("pushes the commit checkpoint 2 passed on after the merge", async () => {
    const { pushed, scanned, scannedBases, head, buildHost } = host([0, 0], { latestMain: newerMain, containsMain: false });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(pushed, [{ branch, commit: head() }]);
    assert.deepEqual(scanned, [head()]);
    assert.deepEqual(scannedBases, [base]);
  });

  it("merges nothing when the branch already contains main", async () => {
    const { steps, mainChecks, buildHost } = host([0, 0], { latestMain: newerMain });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.some((step) => step.startsWith("merge")));
    assert.equal(mainChecks.length, 1);
  });

  it("leaves the merged main out of the gate guard only once GitHub says it is main", async () => {
    const trusted = host([0, 0], { latestMain: newerMain, containsMain: false });
    await buildIssue(issue, branch, base, trusted.buildHost);
    const untrusted = host([0, 0], { latestMain: newerMain, containsMain: false, remoteMain: "9".repeat(40) });
    await buildIssue(issue, branch, base, untrusted.buildHost);

    assert.ok(trusted.gateGuardChecks.some((command) => command.includes(`'${newerMain}'`)), trusted.gateGuardChecks.join("\n"));
    assert.ok(!untrusted.gateGuardChecks.some((command) => command.includes(`'${newerMain}'`)), untrusted.gateGuardChecks.join("\n"));
  });

  it("aborts a merge that conflicts and publishes the reviewed commit, leaving the conflict to the follow-up pass", async () => {
    const { steps, logs, comments, pushed, head, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mergeExitCode: 1,
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps.slice(3, 7), ["reviewer", `merge '${newerMain}'`, "merge abort", "gate: scripts/gate.sh 2>&1"]);
    assert.equal(result.outcome, "published");
    // tester, backend and reviewer each committed once.
    assert.deepEqual(pushed, [{ branch, commit: head() }]);
    assert.equal(head(), (3).toString(16).padStart(40, "0"));
    assert.ok(logs.some((line) => line.includes("merging main conflicted")));
    assert.deepEqual(comments, []);
  });

  it("resets to the reviewed commit when aborting the conflicting merge fails", async () => {
    const { steps, pushed, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mergeExitCode: 1,
      abortExitCode: 128,
    });
    const reviewed = (3).toString(16).padStart(40, "0");

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps.slice(5, 8), ["merge abort", `reset ${reviewed}`, "gate: scripts/gate.sh 2>&1"]);
    assert.equal(result.outcome, "published");
    assert.deepEqual(pushed, [{ branch, commit: reviewed }]);
  });

  it("gates the merged tree once without the gate-fixer, and on red publishes the reviewed commit without main", async () => {
    const { steps, logs, pushed, comments, recordBuildFailureCalls, buildHost } = host([0, 1, 0], {
      latestMain: newerMain,
      containsMain: false,
    });
    const reviewed = (3).toString(16).padStart(40, "0");

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps, [
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "reviewer",
      `merge '${newerMain}'`,
      "gate: scripts/gate.sh 2>&1",
      `reset ${reviewed}`,
      "gate: scripts/gate.sh 2>&1",
      "publish",
      "close",
    ]);
    assert.equal(result.outcome, "published");
    assert.deepEqual(pushed, [{ branch, commit: reviewed }]);
    assert.ok(logs.includes("  #69 checkpoint 2: gate failed with main merged in"));
    assert.ok(logs.some((line) => line.includes("main broke the gate once merged in")));
    assert.deepEqual(recordBuildFailureCalls, []);
    assert.deepEqual(comments, []);
  });

  // After the merge, `gated` holds the commits main gained since
  // `base`, which aren't the branch's work.
  it("leaves the main commit it merged out of the secret scan", async () => {
    const { scanned, scannedBases, scannedExclusions, head, buildHost } = host([0, 0], { latestMain: newerMain, containsMain: false });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(scanned, [head()]);
    assert.deepEqual(scannedBases, [base]);
    assert.deepEqual(scannedExclusions, [newerMain]);
  });

  it("publishes when a token-shaped string is only in main's newly merged commits", async () => {
    const { pushed, comments, logs, head, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      leaksOnlyInMergedMain: sampleSecretMatch,
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "published");
    assert.deepEqual(pushed, [{ branch, commit: head() }]);
    assert.deepEqual(comments, []);
    assert.ok(!logs.some((line) => line.includes("holds a secret")));
  });

  it("still doesn't publish when a token-shaped string is in the branch's own commits, with main merged in", async () => {
    const { pushed, comments, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      leaksSecret: sampleSecretMatch,
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "not published");
    assert.deepEqual(pushed, []);
    assert.equal(comments.length, 1);
  });

  it("leaves the main commit it merged out of the workflow listing for a refused push", async () => {
    const { listedExclusions, handBackWorkflowChangeCalls, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      publishError:
        "git push failed:\n ! [remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(handBackWorkflowChangeCalls.length, 1);
    assert.deepEqual(listedExclusions, [newerMain]);
  });

  it("excludes no main commit from the scan or the listing when GitHub's main isn't the merged commit", async () => {
    const { scannedExclusions, listedExclusions, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      remoteMain: "f".repeat(40),
      publishError: "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`",
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(scannedExclusions, [undefined]);
    assert.deepEqual(listedExclusions, [undefined]);
  });

  it("blocks a token-shaped string in main's commits when GitHub's main can't be asked", async () => {
    const { pushed, scannedExclusions, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      remoteMainError: "could not resolve host",
      leaksOnlyInMergedMain: sampleSecretMatch,
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "not published");
    assert.deepEqual(pushed, []);
    assert.deepEqual(scannedExclusions, [undefined]);
  });

  it("excludes no main commit from the scan or the listing when the merge conflicted", async () => {
    const { scannedExclusions, listedExclusions, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mergeExitCode: 1,
      publishError: "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`",
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(scannedExclusions, [undefined]);
    assert.deepEqual(listedExclusions, [undefined]);
  });

  it("excludes no main commit from the scan when the merged tree failed the gate and the branch went back to the reviewed commit", async () => {
    const { scannedExclusions, buildHost } = host([0, 1, 0], { latestMain: newerMain, containsMain: false });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(scannedExclusions, [undefined]);
  });

  it("excludes no main commit from the scan when the branch already contains main or fetching main failed", async () => {
    const contained = host([0, 0], { latestMain: newerMain });
    const failedFetch = host([0, 0], { latestMainError: "could not resolve host" });

    await buildIssue(issue, branch, base, contained.buildHost);
    await buildIssue(issue, branch, base, failedFetch.buildHost);

    assert.deepEqual(contained.scannedExclusions, [undefined]);
    assert.deepEqual(failedFetch.scannedExclusions, [undefined]);
  });

  // Main's own workflow change would ride into the branch on the merge
  // commit, and the push of it is refused for lack of Workflows permission,
  // handing the issue back for a change the issue never made.
  it("doesn't merge main in when the branch head..latest main touches .github/workflows/, and publishes the gated head", async () => {
    const { steps, mainChecks, logs, pushed, head, workflowFileCalls, handBackWorkflowChangeCalls, comments, recordBuildFailureCalls, buildHost } =
      host([0, 0], {
        latestMain: newerMain,
        containsMain: false,
        mainWorkflowFiles: [".github/workflows/ci.yml"],
      });
    const reviewed = (3).toString(16).padStart(40, "0");

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.some((step) => step.startsWith("merge")), steps.join(", "));
    assert.equal(result.outcome, "published");
    assert.equal(result.publishFailed, false);
    // tester, backend and reviewer each committed once, and nothing merged.
    assert.equal(head(), reviewed);
    assert.deepEqual(pushed, [{ branch, commit: reviewed }]);
    assert.deepEqual(handBackWorkflowChangeCalls, []);
    assert.deepEqual(comments, []);
    assert.deepEqual(recordBuildFailureCalls, []);
    // Main is checked for the workflow change from the branch's head, the
    // range the issue names.
    assert.ok(
      workflowFileCalls.some((call) => call.from === reviewed && call.to === newerMain),
      JSON.stringify(workflowFileCalls),
    );
    assert.ok(mainChecks.length <= 1);
    assert.ok(!logs.some((line) => line.includes("merged main in")), logs.join("\n"));
  });

  it("still merges main in, whatever main changed under .github/workflows/, when the push token can push workflow changes", async () => {
    const { steps, workflowFileCalls, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mainWorkflowFiles: [".github/workflows/ci.yml"],
      pushRefusesWorkflowChanges: false,
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(steps.includes(`merge '${newerMain}'`), steps.join(", "));
    assert.ok(!workflowFileCalls.some((call) => call.to === newerMain), JSON.stringify(workflowFileCalls));
  });

  it("gates the branch as it is at checkpoint 2 when it leaves main's workflow change unmerged", async () => {
    const { steps, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mainWorkflowFiles: [".github/workflows/release.yml"],
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(steps, [
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "reviewer",
      "gate: scripts/gate.sh 2>&1",
      "publish",
      "close",
    ]);
  });

  it("still merges main in when the branch head..latest main touches no workflow file", async () => {
    const { steps, workflowFileCalls, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mainWorkflowFiles: [],
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(steps.includes(`merge '${newerMain}'`), steps.join(", "));
    assert.ok(workflowFileCalls.some((call) => call.to === newerMain));
  });

  it("still hands the issue back for the branch's own workflow change when main is merged in", async () => {
    const { handBackWorkflowChangeCalls, steps, comments, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      publishError:
        "git push --quiet origin abc:refs/heads/x failed:\n ! [remote rejected] abc -> x (refusing to allow a GitHub App to " +
        "create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(steps.includes(`merge '${newerMain}'`), steps.join(", "));
    assert.equal(handBackWorkflowChangeCalls.length, 1);
    const { head, files } = handBackWorkflowChangeCalls[0]!.change;
    assert.deepEqual(files, [`.github/workflows/${base.slice(0, 4)}-${head.slice(0, 4)}.yml`]);
    assert.deepEqual(comments, []);
    assert.equal(result.publishFailed, true);
  });

  // On a branch origin already has, the push is an update judged against the
  // branch's own tip, so main's workflow change isn't what GitHub refuses.
  it("hands the issue back for the branch's own workflow change, listing only its files, when main's workflow change is left unmerged", async () => {
    const { handBackWorkflowChangeCalls, steps, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      branchOnOrigin: true,
      mainWorkflowFiles: [".github/workflows/release.yml"],
      publishError:
        "git push --quiet origin abc:refs/heads/x failed:\n ! [remote rejected] abc -> x (refusing to allow a GitHub App to " +
        "create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
    });
    const reviewed = (3).toString(16).padStart(40, "0");

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.some((step) => step.startsWith("merge")), steps.join(", "));
    assert.equal(handBackWorkflowChangeCalls.length, 1);
    // The files and head are the branch's own: base..reviewed head, with no
    // file of main's.
    const { head, files } = handBackWorkflowChangeCalls[0]!.change;
    assert.equal(head, reviewed);
    assert.deepEqual(files, [`.github/workflows/${base.slice(0, 4)}-${reviewed.slice(0, 4)}.yml`]);
    assert.equal(result.publishFailed, true);
  });

  it("still publishes, without merging, when fetching main fails", async () => {
    const { steps, logs, buildHost } = host([0, 0], { latestMainError: "could not resolve host" });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.some((step) => step.startsWith("merge")));
    assert.equal(result.outcome, "published");
    assert.ok(logs.some((line) => line.includes("fetching main failed")));
  });

  it("still publishes, without merging, when main's workflow changes can't be listed", async () => {
    const { steps, logs, pushed, buildHost } = host([0, 0], { latestMain: newerMain, containsMain: false });
    const listWorkflows = buildHost.workflowFiles;
    buildHost.workflowFiles = (from, to) => {
      if (to === newerMain) throw new Error("git log failed");
      return listWorkflows(from, to);
    };
    const reviewed = (3).toString(16).padStart(40, "0");

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.some((step) => step.startsWith("merge")), steps.join(", "));
    assert.equal(result.outcome, "published");
    assert.deepEqual(pushed, [{ branch, commit: reviewed }]);
    assert.ok(logs.some((line) => line.includes("can't be listed")), logs.join("\n"));
  });
});

// A role run that hits Claude's usage limit, or a build the time
// budget has already stopped, must end the build uncounted rather than
// treating it as a failed attempt or publishing unreviewed work.
describe("buildIssue and the usage limit", () => {
  it("rejects with UncountedStopError, without recording a failed attempt, commenting or publishing, when the tester hits Claude's usage limit", async () => {
    const usageLimitError = new Error("claude-code exited with code 1:\nClaude AI usage limit reached|1760000000");
    const { comments, recordBuildFailureCalls, pushed, order, buildHost } = host([], {
      failing: ["tester"],
      failWith: { tester: usageLimitError },
    });

    await assert.rejects(
      () => buildIssue(issue, branch, base, buildHost),
      (error: unknown) => error instanceof UncountedStopError,
    );

    assert.deepEqual(comments, []);
    assert.deepEqual(recordBuildFailureCalls, []);
    assert.deepEqual(pushed, []);
    assert.ok(order.includes("close"), order.join(", "));
    assert.ok(order.includes("unmark"), order.join(", "));
  });

  it("rejects with UncountedStopError and doesn't publish once the run's limits have recorded a usage-limit stop", async () => {
    const { pushed, buildHost } = host([0, 0]);
    buildHost.limits.hitUsageLimit("usage limit reached during the reviewer run");

    await assert.rejects(
      () => buildIssue(issue, branch, base, buildHost),
      (error: unknown) => error instanceof UncountedStopError,
    );

    assert.deepEqual(pushed, []);
  });

  // The stop above is recorded before the tester starts, so it never reaches
  // the publish step. Here another build in the round hits the limit only
  // after this one's reviewer has finished: the work is built, gated and
  // reviewed, and publishing it costs no Claude usage, while an ephemeral
  // runner would throw away anything left unpushed.
  it("still publishes work whose roles all finished when another build hits the usage limit after this one's reviewer", async () => {
    const { pushed, recordBuildFailureCalls, steps, buildHost } = host([0, 0]);
    const createSandbox = buildHost.createSandbox;
    buildHost.createSandbox = async (sandboxBranch) => {
      const sandbox = await createSandbox(sandboxBranch);
      return {
        ...sandbox,
        run: async (options: SandboxRunOptions) => {
          const result = await sandbox.run(options);
          if (options.name === "reviewer") buildHost.limits.hitUsageLimit("usage limit reached during #70's backend run");
          return result;
        },
      } as Sandbox;
    };

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.ok(steps.includes("reviewer"), steps.join(", "));
    assert.notEqual(result.prUrl, undefined);
    assert.equal(pushed.length, 1);
    assert.deepEqual(recordBuildFailureCalls, []);
  });
});

// A push GitHub refuses because it touches .github/workflows/** without
// Workflows permission needs a person, not a retry and not a generic
// publish-failure comment.
describe("buildIssue publishing a workflow file", () => {
  const workflowRejection =
    "git push --quiet origin abc:refs/heads/x failed:\n ! [remote rejected] abc -> x (refusing to allow a GitHub App to " +
    "create or update workflow `.github/workflows/ci.yml` without `workflows` permission)";

  it("hands the issue back instead of posting the generic publish-failure comment", async () => {
    const { comments, recordBuildFailureCalls, handBackWorkflowChangeCalls, buildHost } = host([0, 0], {
      publishError: workflowRejection,
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(handBackWorkflowChangeCalls.length, 1);
    assert.equal(handBackWorkflowChangeCalls[0]!.issueNumber, issue.number);
    assert.equal(handBackWorkflowChangeCalls[0]!.branch, branch);
    assert.match(handBackWorkflowChangeCalls[0]!.detail, /refusing to allow/);
    // The workflow files and head are read from the base to the commit the
    // gate passed, the one the refused push carried.
    const { head, files } = handBackWorkflowChangeCalls[0]!.change;
    assert.deepEqual(files, [`.github/workflows/${base.slice(0, 4)}-${head.slice(0, 4)}.yml`]);
    assert.notEqual(head, base);
    assert.deepEqual(comments, []);
    assert.deepEqual(recordBuildFailureCalls, []);
    assert.equal(result.prUrl, undefined);
    assert.equal(result.publishFailed, true);
  });

  it("still resolves when the hand-back for a workflow-file rejection itself fails", async () => {
    const { buildHost } = host([0, 0], { publishError: workflowRejection });
    buildHost.handBackWorkflowChange = () => {
      throw new Error("gh issue edit failed: HTTP 502");
    };

    await assert.doesNotReject(() => buildIssue(issue, branch, base, buildHost));
  });
});

// GitHub judges the push of a branch it doesn't have yet against main's
// current tip, so a build cut before main changed a workflow "changes" that
// workflow back, and the push is refused. The host creates the branch at `base`
// first, then pushes the build's commits as an update to it.
describe("buildIssue publishing a new branch after main changed a workflow", () => {
  // The commit origin/main has moved on to since the round started.
  const newerMain = "a".repeat(40);
  const mainChangedWorkflow = {
    latestMain: newerMain,
    containsMain: false,
    mainWorkflowFiles: [".github/workflows/claude-review.yml"],
  };
  const refusal =
    "git push --quiet origin abc:refs/heads/x failed:\n ! [remote rejected] abc -> x (refusing to allow a Personal Access Token to " +
    "create or update workflow `.github/workflows/claude-review.yml` without `workflow` scope)";

  it("creates the branch at base before pushing the build's commits to it, when main changed a workflow since base", async () => {
    const { createdBranches, publishEvents, pushed, workflowFileCalls, head, buildHost } = host([0, 0], mainChangedWorkflow);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, [{ branch, commit: base }]);
    assert.deepEqual(publishEvents, ["create-branch", "publish"]);
    assert.deepEqual(pushed, [{ branch, commit: head() }]);
    assert.equal(result.outcome, "published");
    // The check asks about base..latest main, the range GitHub judges a new branch by.
    assert.ok(
      workflowFileCalls.some((call) => call.from === base && call.to === newerMain),
      JSON.stringify(workflowFileCalls),
    );
  });

  it("publishes as today, creating no branch first, when main changed no workflow since base", async () => {
    const { createdBranches, publishEvents, pushed, head, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mainWorkflowFiles: [],
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
    assert.deepEqual(pushed, [{ branch, commit: head() }]);
    assert.equal(result.outcome, "published");
  });

  it("publishes as today when main is still the commit the build started from", async () => {
    const { createdBranches, publishEvents, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
  });

  it("creates no branch when base isn't an ancestor of the commit the gate passed on, since the push would not fast-forward", async () => {
    const { createdBranches, publishEvents, baseChecks, head, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      baseIsAncestor: false,
    });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(baseChecks.length, 1);
    assert.equal(baseChecks[0], `git merge-base --is-ancestor '${base}' '${head()}'`);
    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
    assert.equal(result.outcome, "published");
  });

  it("hands the issue back, not to Sandcastle:local, when base isn't an ancestor and the push is refused", async () => {
    const { moveToLocalCalls, handBackWorkflowChangeCalls, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      baseIsAncestor: false,
      publishError: refusal,
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(moveToLocalCalls, []);
    assert.equal(handBackWorkflowChangeCalls.length, 1);
  });

  it("creates no branch when origin already has it, since the push is then an update", async () => {
    const { createdBranches, publishEvents, buildHost } = host([0, 0], { ...mainChangedWorkflow, branchOnOrigin: true });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
  });

  it("creates no branch in a local run, whose push token can push a workflow change", async () => {
    const { createdBranches, workflowFileCalls, publishEvents, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      pushRefusesWorkflowChanges: false,
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
    assert.ok(!workflowFileCalls.some((call) => call.from === base && call.to === newerMain), JSON.stringify(workflowFileCalls));
  });

  it("publishes as today when main's workflow files since base can't be listed", async () => {
    const { createdBranches, publishEvents, buildHost } = host([0, 0], mainChangedWorkflow);
    const listWorkflows = buildHost.workflowFiles;
    buildHost.workflowFiles = (from, to, mergedMain) => {
      if (from === base && to === newerMain) throw new Error("git log failed");
      return listWorkflows(from, to, mergedMain);
    };

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
    assert.equal(result.outcome, "published");
  });

  it("publishes as today when origin can't be asked whether it has the branch", async () => {
    const { createdBranches, publishEvents, buildHost } = host([0, 0], mainChangedWorkflow);
    buildHost.remoteBranchExists = () => {
      throw new Error("git ls-remote failed");
    };

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
    assert.equal(result.outcome, "published");
  });

  it("still pushes the build's commits when creating the branch at base fails", async () => {
    const { pushed, head, buildHost } = host([0, 0], { ...mainChangedWorkflow, createBranchError: "git push failed" });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(pushed, [{ branch, commit: head() }]);
    assert.equal(result.outcome, "published");
  });

  it("moves the issue to Sandcastle:local when creating the branch failed and the push is then refused", async () => {
    const { moveToLocalCalls, handBackWorkflowChangeCalls, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      createBranchError: "git push failed",
      publishError: refusal,
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(moveToLocalCalls.length, 1);
    assert.deepEqual(handBackWorkflowChangeCalls, []);
  });

  it("moves the issue to Sandcastle:local, not to needs-human, when the push is still refused after the branch was created", async () => {
    const { moveToLocalCalls, handBackWorkflowChangeCalls, comments, recordBuildFailureCalls, createdBranches, buildHost } = host(
      [0, 0],
      { ...mainChangedWorkflow, publishError: refusal },
    );

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(createdBranches.length, 1);
    assert.equal(moveToLocalCalls.length, 1);
    assert.equal(moveToLocalCalls[0]!.issueNumber, issue.number);
    assert.equal(moveToLocalCalls[0]!.branch, branch);
    assert.match(moveToLocalCalls[0]!.detail, /refusing to allow/);
    // The head and files are the build's own: base..the commit the gate passed.
    const { head, files } = moveToLocalCalls[0]!.change;
    assert.notEqual(head, base);
    assert.deepEqual(files, [`.github/workflows/${base.slice(0, 4)}-${head.slice(0, 4)}.yml`]);
    assert.deepEqual(handBackWorkflowChangeCalls, []);
    assert.deepEqual(comments, []);
    assert.deepEqual(recordBuildFailureCalls, []);
    assert.equal(result.prUrl, undefined);
    assert.equal(result.publishFailed, true);
    assert.equal(result.outcome, "not published");
  });

  it("deletes the branch it created at base, before moving the issue, when the push is still refused", async () => {
    const { deletedBranches, publishEvents, buildHost } = host([0, 0], { ...mainChangedWorkflow, publishError: refusal });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(deletedBranches, [{ branch, commit: base }]);
    assert.deepEqual(publishEvents, ["create-branch", "delete-branch", "move-to-local"]);
  });

  it("still moves the issue to Sandcastle:local when deleting the stray branch fails", async () => {
    const { moveToLocalCalls, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      publishError: refusal,
      deleteBranchError: "git push failed",
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(moveToLocalCalls.length, 1);
  });

  it("deletes no branch when creating it at base failed, since none is there", async () => {
    const { deletedBranches, moveToLocalCalls, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      createBranchError: "git push failed",
      publishError: refusal,
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(deletedBranches, []);
    assert.equal(moveToLocalCalls[0]!.createdAtBase, false);
  });

  it("tells the move whether the branch was created at base", async () => {
    const { moveToLocalCalls, buildHost } = host([0, 0], { ...mainChangedWorkflow, publishError: refusal });

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(moveToLocalCalls[0]!.createdAtBase, true);
  });

  it("deletes no branch when the publish fails for any other reason, since the push may have landed", async () => {
    const { deletedBranches, buildHost } = host([0, 0], { ...mainChangedWorkflow, publishError: "HTTP 502 from gh pr create" });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(deletedBranches, []);
  });

  it("publishes as today when checking that base is an ancestor throws", async () => {
    const { createdBranches, publishEvents, buildHost } = host([0, 0], { ...mainChangedWorkflow, baseExecError: "container died" });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(createdBranches, []);
    assert.deepEqual(publishEvents, ["publish"]);
    assert.equal(result.outcome, "published");
  });

  it("still hands the issue back for a refused push when no branch was created first", async () => {
    const { moveToLocalCalls, handBackWorkflowChangeCalls, buildHost } = host([0, 0], {
      latestMain: newerMain,
      containsMain: false,
      mainWorkflowFiles: [],
      publishError: refusal,
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(moveToLocalCalls, []);
    assert.equal(handBackWorkflowChangeCalls.length, 1);
  });

  it("moves the issue to Sandcastle:local when the push of a new branch is refused only for main's workflow change", async () => {
    // The refused push leaves a local branch on the old main that the next round would reuse
    // and could never push, so the issue can't stay in the queue for it.
    const { moveToLocalCalls, handBackWorkflowChangeCalls, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      createBranchError: "git push failed",
      publishError: refusal,
    });
    buildHost.workflowFiles = (_from, to) => (to === newerMain ? mainChangedWorkflow.mainWorkflowFiles : []);

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(moveToLocalCalls.length, 1);
    assert.equal(moveToLocalCalls[0]!.createdAtBase, false);
    assert.deepEqual(handBackWorkflowChangeCalls, []);
    assert.equal(result.publishFailed, true);
    assert.equal(result.outcome, "not published");
  });

  it("moves the issue to Sandcastle:local when the branch was created at base, even if the build touches no workflow", async () => {
    const { moveToLocalCalls, buildHost } = host([0, 0], { ...mainChangedWorkflow, publishError: refusal });
    buildHost.workflowFiles = (_from, to) => (to === newerMain ? mainChangedWorkflow.mainWorkflowFiles : []);

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(moveToLocalCalls.length, 1);
  });

  it("moves the issue to Sandcastle:local when the build's own workflow files can't be listed", async () => {
    const { moveToLocalCalls, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      createBranchError: "git push failed",
      publishError: refusal,
    });
    buildHost.workflowFiles = (_from, to) => {
      if (to === newerMain) return mainChangedWorkflow.mainWorkflowFiles;
      throw new Error("git diff failed");
    };

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(moveToLocalCalls.length, 1);
  });

  it("moves the issue to Sandcastle:local when the build itself changes a workflow and the branch wasn't created", async () => {
    const { moveToLocalCalls, buildHost } = host([0, 0], {
      ...mainChangedWorkflow,
      createBranchError: "git push failed",
      publishError: refusal,
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(moveToLocalCalls.length, 1);
  });

  it("reports in the run's detail that moving the issue failed, rather than that it moved", async () => {
    const { buildHost } = host([0, 0], { ...mainChangedWorkflow, publishError: refusal });
    buildHost.moveToLocal = () => {
      throw new Error("gh issue edit failed: HTTP 502");
    };

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.match(result.detail, /moving it to Sandcastle:local failed/);
  });

  it("reports in the run's detail that the issue moved when the move worked", async () => {
    const { buildHost } = host([0, 0], { ...mainChangedWorkflow, publishError: refusal });

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.match(result.detail, /so it moved to Sandcastle:local/);
  });

  it("still resolves when moving the issue to Sandcastle:local itself fails", async () => {
    const { buildHost } = host([0, 0], { ...mainChangedWorkflow, publishError: refusal });
    buildHost.moveToLocal = () => {
      throw new Error("gh issue edit failed: HTTP 502");
    };

    await assert.doesNotReject(() => buildIssue(issue, branch, base, buildHost));
  });
});

describe("buildIssue ui role", () => {
  it("runs the UI developer after the backend developer and before checkpoint 1, when the plan picks it", async () => {
    await withUiRole(true, async () => {
      const { steps, buildHost } = host([0, 0]);

      await buildIssue(withRoles(["ui"]), branch, base, buildHost);

      assert.deepEqual(steps, [
        "tester",
        "backend",
        "ui",
        "gate: scripts/gate.sh 2>&1",
        "reviewer",
        "gate: scripts/gate.sh 2>&1",
        "publish",
        "close",
      ]);
    });
  });

  it("runs every optional role in build order when the plan picks them all", async () => {
    await withUiRole(true, async () => {
      const { steps, buildHost } = host([0, 0]);

      await buildIssue(withRoles(["architect", "ui", "scribe"]), branch, base, buildHost);

      assert.deepEqual(steps.filter((step) => !step.startsWith("gate:")), ["architect", "tester", "backend", "ui", "scribe", "reviewer", "publish", "close"]);
    });
  });

  it("tells the backend developer the UI developer follows, and that it is the last developer run otherwise", async () => {
    await withUiRole(true, async () => {
      const withUi = host([0, 0]);
      await buildIssue(withRoles(["ui"]), branch, base, withUi.buildHost);
      const without = host([0, 0]);
      await buildIssue(withRoles([]), branch, base, without.buildHost);

      assert.match(String(withUi.runs.find((run) => run.name === "backend")?.promptArgs?.UI_DEVELOPER), /UI developer runs after you/);
      assert.match(String(without.runs.find((run) => run.name === "backend")?.promptArgs?.UI_DEVELOPER), /last developer run/);
    });
  });

  it("runs the UI developer from roles/ui.md with the issue's prompt arguments and the shared rules", async () => {
    await withUiRole(true, async () => {
      const { runs, buildHost } = host([0, 0]);

      await buildIssue(withRoles(["ui"]), branch, base, buildHost);

      const run = runs.find((options) => options.name === "ui")!;
      assert.equal(run.promptFile, "./.sandcastle/roles/ui.md");
      assert.equal(run.promptArgs?.TASK_ID, "69");
      assert.equal(run.promptArgs?.BRANCH, branch);
      assert.ok(run.promptArgs?.SHARED_RULES);
    });
  });

  it("skips the UI developer, and tells the backend developer it is the last developer run, when the plan names ui in a repo that hasn't opted in", async () => {
    await withUiRole(false, async () => {
      const { steps, runs, buildHost } = host([0, 0]);

      const result = await buildIssue(withRoles(["ui"]), branch, base, buildHost);

      assert.ok(!steps.includes("ui"));
      assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
      assert.match(String(runs.find((run) => run.name === "backend")?.promptArgs?.UI_DEVELOPER), /last developer run/);
    });
  });

  it("publishes nothing and comments on the issue when the UI developer runs out of iterations unfinished", async () => {
    await withUiRole(true, async () => {
      const { steps, comments, recordBuildFailureCalls, buildHost } = host([0, 0], { unfinished: ["ui"] });

      const result = await buildIssue(withRoles(["ui"]), branch, base, buildHost);

      assert.ok(!steps.includes("publish"));
      assert.equal(result.prUrl, undefined);
      assert.equal(recordBuildFailureCalls.length, 1);
      assert.match(comments[0]!.body, /ui ran out of iterations/);
    });
  });

  it("stops the build, without publishing, and counts a failed attempt when the UI developer fails", async () => {
    await withUiRole(true, async () => {
      const { steps, recordBuildFailureCalls, buildHost } = host([0, 0], { failing: ["ui"] });

      const result = await buildIssue(withRoles(["ui"]), branch, base, buildHost);

      assert.ok(!steps.includes("publish"));
      assert.equal(result.prUrl, undefined);
      assert.equal(recordBuildFailureCalls.length, 1);
    });
  });

  it("rethrows a usage-limit stop from the UI developer instead of counting a failed attempt", async () => {
    await withUiRole(true, async () => {
      const stop = new UncountedStopError("usage limit reached");
      const { recordBuildFailureCalls, buildHost } = host([0, 0], { failing: ["ui"], failWith: { ui: stop } });

      await assert.rejects(
        () => buildIssue(withRoles(["ui"]), branch, base, buildHost),
        (error: unknown) => error === stop,
      );

      assert.deepEqual(recordBuildFailureCalls, []);
    });
  });
});

// Covers Blazor-Server#72 ("Add architect, UI developer and scribe roles
// picked by the planner"): the build order is
// [architect] → tester → backend → [ui] → gate 1 → [scribe] → reviewer → gate 2 → publish,
// with each bracketed role run only when the planner picked it (issue.roles).
describe("buildIssue optional roles", () => {
  it("runs tester, backend, scribe and reviewer, and no architect, when the plan picks only the scribe", async () => {
    const { steps, logs, buildHost } = host([0, 0]);

    const result = await buildIssue(withRoles(["scribe"]), branch, base, buildHost);

    assert.deepEqual(steps, [
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "scribe",
      "reviewer",
      "gate: scripts/gate.sh 2>&1",
      "publish",
      "close",
    ]);
    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
    assert.ok(!logs.some((line) => line.includes("architect")));
  });

  it("runs the architect before the tester and the scribe after checkpoint 1 and before the reviewer, when the plan picks every optional role", async () => {
    const { steps, buildHost } = host([0, 0]);

    await buildIssue(withRoles(["architect", "scribe"]), branch, base, buildHost);

    assert.deepEqual(steps, [
      "architect",
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "scribe",
      "reviewer",
      "gate: scripts/gate.sh 2>&1",
      "publish",
      "close",
    ]);
  });

  it("runs neither the architect nor the scribe when the plan picks none of them", async () => {
    const { steps, buildHost } = host([0, 0]);

    await buildIssue(withRoles([]), branch, base, buildHost);

    assert.deepEqual(steps, [
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "reviewer",
      "gate: scripts/gate.sh 2>&1",
      "publish",
      "close",
    ]);
  });

  for (const role of ["architect"] as const) {
    // gateExitCodes has enough green answers for the whole old pipeline, so a
    // ${role} that's wrongly left out of the build still reaches publish
    // instead of exhausting the gate stub and failing for an unrelated reason.
    it(`stops the build, without publishing, when the ${role} fails`, async () => {
      const { steps, buildHost } = host([0, 0], { failing: [role] });

      const result = await buildIssue(withRoles([role]), branch, base, buildHost);

      assert.ok(!steps.includes("publish"));
      assert.equal(result.prUrl, undefined);
    });

    it(`treats a ${role} failure as a failed build attempt, with a comment saying the branch wasn't pushed`, async () => {
      const { comments, recordBuildFailureCalls, buildHost } = host([0, 0], { failing: [role] });

      await buildIssue(withRoles([role]), branch, base, buildHost);

      assert.equal(recordBuildFailureCalls.length, 1);
      assert.equal(recordBuildFailureCalls[0]!.issueNumber, 69);
      assert.match(comments[0]!.body, new RegExp(`\`${branch}\` wasn't pushed`));
    });

    it(`rethrows a usage-limit or time-budget stop from the ${role} instead of treating it as a failed attempt`, async () => {
      const stop = new UncountedStopError("usage limit reached");
      const { recordBuildFailureCalls, buildHost } = host([0, 0], { failing: [role], failWith: { [role]: stop } });

      await assert.rejects(
        () => buildIssue(withRoles([role]), branch, base, buildHost),
        (error: unknown) => error === stop,
      );

      assert.deepEqual(recordBuildFailureCalls, []);
    });
  }

  it("reads the architect's latest design note and gives it to the architect's prompt", async () => {
    const { runs, buildHost } = host([0, 0], { designNote: "## Design\n\nUse a Result<T>." });

    await buildIssue(withRoles(["architect"]), branch, base, buildHost);

    const architectRun = runs.find((run) => run.name === "architect");
    assert.ok(architectRun, "the architect should have run");
    assert.equal(architectRun.promptArgs?.DESIGN_NOTE, "## Design\n\nUse a Result<T>.");
  });

  it("tells the architect it has no earlier design note on a first run", async () => {
    const { runs, buildHost } = host([0, 0], { designNote: undefined });

    await buildIssue(withRoles(["architect"]), branch, base, buildHost);

    const architectRun = runs.find((run) => run.name === "architect");
    assert.equal(architectRun?.promptArgs?.DESIGN_NOTE, "(no earlier design note)");
  });

  it("posts the architect's design note as an issue comment carrying the sandcastle:design marker", async () => {
    const { comments, buildHost } = host([0, 0], { designFile: "## Design\n\nUse a Result<T> for the new endpoint." });

    await buildIssue(withRoles(["architect"]), branch, base, buildHost);

    const designComment = comments.find((comment) => comment.body.includes("<!-- sandcastle:design -->"));
    assert.ok(designComment, "expected a comment carrying the sandcastle:design marker");
    assert.match(designComment.body, /Use a Result<T> for the new endpoint\./);
  });

  // The worktree is named after the branch, so it can still hold an earlier
  // round's note; the roles follow the note when it exists, so only this
  // build's architect may have written it.
  it("removes an earlier design note in the sandbox before the first role runs", async () => {
    for (const roles of [["architect"], []] as OptionalRole[][]) {
      const { workCommands, buildHost } = host([0, 0]);

      await buildIssue(withRoles(roles), branch, base, buildHost);

      assert.deepEqual(workCommands[0], { command: "rm -f .sandcastle/work/69/design.md", rolesRun: 0 }, JSON.stringify(workCommands));
    }
  });

  // The note is agent-written sandbox text going onto a public issue, so it's
  // made safe the way a failed publish's error is.
  it("withholds a design note that looks like it holds a secret", async () => {
    const { comments, buildHost } = host([0, 0], { designFile: "## Design\n\nUse the token ghp_abc." });
    buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await buildIssue(withRoles(["architect"]), branch, base, buildHost);

    const designPosted = comments.find((comment) => comment.body.includes(DESIGN_MARKER));
    assert.ok(designPosted, "expected a design comment");
    assert.doesNotMatch(designPosted.body, /ghp_/);
    assert.match(designPosted.body, /looked like it held a secret/);
  });

  it("posts no design comment, and still publishes, when the architect wrote no design note", async () => {
    const { comments, steps, buildHost } = host([0, 0], { designFile: "" });

    const result = await buildIssue(withRoles(["architect"]), branch, base, buildHost);

    assert.ok(!comments.some((comment) => comment.body.includes(DESIGN_MARKER)));
    assert.ok(steps.includes("publish"), steps.join(", "));
    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
  });

  it("still publishes when posting the design note fails", async () => {
    const { steps, recordBuildFailureCalls, buildHost } = host([0, 0], { designFile: "## Design" });
    buildHost.commentOnIssue = () => {
      throw new Error("gh issue comment failed: HTTP 502");
    };

    const result = await buildIssue(withRoles(["architect"]), branch, base, buildHost);

    assert.ok(steps.includes("publish"), steps.join(", "));
    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
    assert.deepEqual(recordBuildFailureCalls, []);
  });

  it("doesn't stop the build and publishes the PR with a note that the documentation step failed when the scribe fails", async () => {
    const { steps, comments, recordBuildFailureCalls, publishCalls, buildHost } = host([0, 0], { failing: ["scribe"] });

    const result = await buildIssue(withRoles(["scribe"]), branch, base, buildHost);

    assert.deepEqual(steps.filter((step) => !step.startsWith("gate:")), [
      "tester", "backend", "scribe", "reviewer", "publish docs-failed", "close",
    ]);
    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
    assert.deepEqual(recordBuildFailureCalls, []);
    assert.deepEqual(publishCalls, [{ reviewed: true, docsFailed: true }]);
    assert.ok(!comments.some((comment) => /wasn't pushed/.test(comment.body)));
  });

  it("publishes the PR with a note that the documentation step failed when the scribe runs out of iterations unfinished", async () => {
    const { recordBuildFailureCalls, publishCalls, buildHost } = host([0, 0], { unfinished: ["scribe"] });

    const result = await buildIssue(withRoles(["scribe"]), branch, base, buildHost);

    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
    assert.deepEqual(recordBuildFailureCalls, []);
    assert.deepEqual(publishCalls, [{ reviewed: true, docsFailed: true }]);
  });

  it("publishes with no documentation note when the scribe succeeds", async () => {
    const { publishCalls, buildHost } = host([0, 0]);

    await buildIssue(withRoles(["scribe"]), branch, base, buildHost);

    assert.deepEqual(publishCalls, [{ reviewed: true, docsFailed: false }]);
  });

  it("rethrows a usage-limit or time-budget stop from the scribe instead of publishing", async () => {
    const stop = new UncountedStopError("usage limit reached");
    const { recordBuildFailureCalls, publishCalls, buildHost } = host([0, 0], { failing: ["scribe"], failWith: { scribe: stop } });

    await assert.rejects(
      () => buildIssue(withRoles(["scribe"]), branch, base, buildHost),
      (error: unknown) => error === stop,
    );

    assert.deepEqual(recordBuildFailureCalls, []);
    assert.deepEqual(publishCalls, []);
  });
});

// Every PR Sandcastle opens had the same generic body, however the
// branch changed. The reviewer now writes .sandcastle/work/{n}/pr-body.md
// with its Why, What changed and Verification sections; buildMarkedIssue
// reads it from the sandbox (never the host's filesystem, since an agent
// wrote it) before publishing, and falls back to the generic body, logging
// why, when the file can't be used as it is.
describe("buildIssue reading the reviewer's PR body", () => {
  it("reads .sandcastle/work/{n}/pr-body.md through the sandbox, and passes its content to host.publish", async () => {
    const { workCommands, publishedPrBodies, buildHost } = host([0, 0], { prBodyFile: validPrBody });

    await buildIssue(issue, branch, base, buildHost);

    // Only the sandbox stub, not a host filesystem reader, could have
    // produced this: there's no other route to the file's content.
    assert.ok(
      workCommands.some((entry) => entry.command === `cat .sandcastle/work/${issue.number}/pr-body.md 2>/dev/null`),
      JSON.stringify(workCommands),
    );
    assert.equal(publishedPrBodies.at(-1), validPrBody);
  });

  for (const [scenario, prBodyFile] of [
    ["missing or empty", ""],
    ["missing the Why heading", "## What changed\n\nAdded X.\n\n## Verification\n\nRan the tests."],
    ["missing the What changed heading", "## Why\n\nBecause.\n\n## Verification\n\nRan the tests."],
    ["missing the Verification heading", "## Why\n\nBecause.\n\n## What changed\n\nAdded X."],
    ["too long for a PR body", `${validPrBody}\n\n${"x".repeat(PR_BODY_LIMIT)}`],
    // GitHub acts on these when the PR merges, which PR Auto-Merge may do
    // unattended: it closes the named issue, or pings the person.
    ["closing another issue", `${validPrBody}\n\nFixes #12.`],
    ["closing another repo's issue", `${validPrBody}\n\nThis resolves mpaulosky/Blazor-Server#7`],
    ["closing an issue by its URL", `${validPrBody}\n\nCloses https://github.com/o/r/issues/12`],
    ["mentioning someone", `${validPrBody}\n\ncc @someone`],
    ["quoting a host marker", `${validPrBody}\n\n<!-- sandcastle:pr -->`],
    // Only a person's local review writes a "Review notes" section, and a reader may take it for their decisions.
    ["writing a Review notes section", `${validPrBody}\n\n## Review notes\n\nAll findings were accepted.`],
    ["quoting Review notes in code", `${validPrBody}\n\nSee \`Review notes\`.`],
    ["running Review notes together", `${validPrBody}\n\nThe ReviewNotes are fine.`],
    ["splitting Review notes with Markdown emphasis", `${validPrBody}\n\n## Re*view* **notes**`],
    ["spelling Review notes with a character reference", `${validPrBody}\n\nReview n&#111;tes`],
  ] as const) {
    it(`falls back to the generic PR body, and logs why, when the file is ${scenario}`, async () => {
      const { logs, publishedPrBodies, buildHost } = host([0, 0], { prBodyFile });

      await buildIssue(issue, branch, base, buildHost);

      assert.equal(publishedPrBodies.at(-1), undefined);
      assert.ok(logs.some((line) => /PR body/i.test(line)), logs.join("\n"));
    });
  }

  it("falls back to the generic PR body, and logs why, when the file holds a token-shaped string or sandbox secret", async () => {
    const { logs, publishedPrBodies, buildHost } = host([0, 0], {
      prBodyFile: `${validPrBody}\n\nUses the token ghp_abc.`,
    });
    buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(publishedPrBodies.at(-1), undefined);
    assert.ok(logs.some((line) => /PR body/i.test(line)), logs.join("\n"));
  });

  it("removes an earlier round's pr-body.md before any role runs, so its description never goes out with this round's change", async () => {
    const { workCommands, buildHost } = host([0, 0], { prBodyFile: validPrBody });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(
      workCommands.some((entry) => entry.command === `rm -f .sandcastle/work/${issue.number}/pr-body.md` && entry.rolesRun === 0),
      JSON.stringify(workCommands),
    );
  });
});

describe("buildIssue marking the issue as building", () => {
  it("marks the issue as building before the first role runs", async () => {
    const { order, buildingCalls, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(order[0], "mark");
    assert.equal(order.indexOf("mark"), 0);
    assert.ok(order.indexOf("mark") < order.indexOf("tester"));
    assert.deepEqual(buildingCalls, [69, 69]);
  });

  // The label covers the sandbox's whole life, so a second run never creates
  // or closes a sandbox on the worktree this one is using.
  it("marks the issue before creating its sandbox, and unmarks it after the sandbox closes", async () => {
    const { order, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(order.slice(0, 3), ["mark", "startFromMain", "create"]);
    assert.deepEqual(order.slice(-2), ["close", "unmark"]);
  });

  // A closed-without-merging PR's old work must be discarded before a
  // fresh sandbox is created from the branch, but only once the issue is
  // marked (so a second run can't race to delete the same refs).
  it("calls startFromMain with the issue, branch and base after marking the issue and before creating its sandbox", async () => {
    const { order, startFromMainCalls, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(order.slice(0, 3), ["mark", "startFromMain", "create"]);
    assert.deepEqual(startFromMainCalls, [{ issueNumber: issue.number, branch, base }]);
  });

  it("propagates a throw from startFromMain before any sandbox is created, still unmarks the issue, and records no build failure", async () => {
    const { order, recordBuildFailureCalls, buildHost } = host([0, 0]);
    buildHost.startFromMain = () => {
      throw new Error("git branch -D failed: worktree in use");
    };

    await assert.rejects(() => buildIssue(issue, branch, base, buildHost), /worktree in use/);

    assert.ok(!order.includes("create"), "no sandbox should be created");
    assert.ok(order.includes("unmark"), "the issue should still be unmarked");
    assert.deepEqual(recordBuildFailureCalls, []);
  });

  for (const role of ["tester", "backend"]) {
    it(`unmarks the issue as building when the ${role} fails`, async () => {
      const { order, buildHost } = host([], { failing: [role] });

      await buildIssue(issue, branch, base, buildHost);

      assert.ok(order.includes("unmark"));
    });

    it(`unmarks the issue as building even when the ${role} throws an uncounted stop error`, async () => {
      const stop = new UncountedStopError("usage limit reached");
      const { order, buildHost } = host([], { failing: [role], failWith: { [role]: stop } });

      await assert.rejects(() => buildIssue(issue, branch, base, buildHost));

      assert.ok(order.includes("unmark"));
    });
  }

  it("unmarks the issue as building when a checkpoint stays red past the gate-fixer's attempts", async () => {
    const { order, buildHost } = host([1, 1, 1]);

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(order.includes("unmark"));
  });

  it("unmarks the issue as building when publishing fails", async () => {
    const { order, buildHost } = host([0, 0], {
      publishError: "git push --quiet origin abc:refs/heads/x failed:\n ! [rejected] abc -> x (non-fast-forward)",
    });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(order.includes("unmark"));
  });

  it("still returns the PR and closes the sandbox when removing the label fails", async () => {
    const { order, buildHost } = host([0, 0]);
    buildHost.unmarkBuilding = () => {
      throw new Error("gh issue edit failed:\nHTTP 502: Bad Gateway");
    };

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
    assert.equal(order.at(-1), "close");
  });

  // Another run's gate read the issue's labels before this run marked it, so
  // both picked it: the second to mark it leaves it to the first.
  it("leaves the issue alone when another run marked it first, without a sandbox or counting an attempt", async () => {
    const { order, recordBuildFailureCalls, buildHost } = host([0, 0]);
    buildHost.markBuilding = () => {
      order.push("mark refused");
      return false;
    };

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.prUrl, undefined);
    assert.deepEqual(order, ["mark refused"]);
    assert.deepEqual(recordBuildFailureCalls, []);
  });

  it("stops the build before creating a sandbox, without counting an attempt, when the label can't be added", async () => {
    const { order, recordBuildFailureCalls, buildHost } = host([0, 0]);
    buildHost.markBuilding = () => {
      throw new Error("gh issue edit failed:\nHTTP 502: Bad Gateway");
    };

    await assert.rejects(() => buildIssue(issue, branch, base, buildHost), /502/);

    assert.deepEqual(order, []);
    assert.deepEqual(recordBuildFailureCalls, []);
  });

  // BUILDING_LABEL_MAX_AGE_MS is sized from BUILD_ROLES' timeouts (see
  // config.test.mts), so a role buildIssue runs outside that list could make
  // a live build outlast the label and let a second run clear it.
  it("runs every BUILD_ROLES role once, and the gate-fixer at most its attempts per checkpoint, on the longest build", async () => {
    // Each checkpoint: red, fixer, red, fixer, green. The planner picked
    // every optional role, so this is the longest path BUILDING_LABEL_MAX_AGE_MS
    // (see config.test.mts) must outlast.
    const { runs, buildHost } = host([1, 1, 0, 1, 1, 0]);

    const result = await withUiRole(true, () => buildIssue(withRoles(["architect", "ui", "scribe"]), branch, base, buildHost));

    const roles = runs.map((run) => run.name!);
    const others = roles.filter((role) => role !== "gate-fixer");
    assert.equal(result.prUrl, "https://github.com/o/r/pull/1");
    assert.deepEqual(new Set(others), new Set(BUILD_ROLES));
    assert.equal(new Set(others).size, others.length);
    assert.equal(roles.filter((role) => role === "gate-fixer").length, 2 * GATE_FIXER_ATTEMPTS);
  });

  it("marks the issue as building exactly once and unmarks it exactly once per build", async () => {
    const { order, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.deepEqual(order.filter((entry) => entry === "mark" || entry === "unmark"), ["mark", "unmark"]);
  });
});

describe("prTitle", () => {
  const titled = (title: string, labels: string[] = []) => prTitle({ number: 69, title, labels });

  it("keeps a title that already follows the commit format", () => {
    assert.equal(titled("fix(baseline): Say to push the fix first"), "fix(baseline): Say to push the fix first");
    assert.equal(titled("feat!: Drop the old queue"), "feat!: Drop the old queue");
  });

  it("gives a title with no prefix feat:, or fix: for a bug", () => {
    assert.equal(titled("Add dark mode toggle", ["Sandcastle"]), "feat: Add dark mode toggle");
    assert.equal(titled("Search crashes on empty input", ["bug", "Sandcastle"]), "fix: Search crashes on empty input");
  });

  it("capitalises the summary and drops a final period", () => {
    assert.equal(titled("add dark mode toggle."), "feat: Add dark mode toggle");
    assert.equal(titled("fix(ui): handle the empty list."), "fix(ui): Handle the empty list");
  });

  it("keeps a summary that starts with a digit, a backtick or a bracket, which the title check allows", () => {
    assert.equal(titled("404 on the login page"), "feat: 404 on the login page");
    assert.equal(titled("`gate.sh` hangs on Windows"), "feat: `gate.sh` hangs on Windows");
    assert.equal(titled("[ui] Broken toggle", ["bug"]), "fix: [ui] Broken toggle");
  });

  it("falls back to the issue number when nothing is left of the title to make a summary", () => {
    assert.equal(titled("..."), "feat: Issue #69");
    assert.equal(titled("   ", ["bug"]), "fix: Issue #69");
  });

  // dotfiles has no scripts/check-pr-title.sh of its own, so the test waits for a repo that does.
  const script = join(import.meta.dirname, "..", "..", "scripts", "check-pr-title.sh");
  it("always gives a title scripts/check-pr-title.sh accepts", { skip: !existsSync(script) }, () => {
    for (const title of ["Add dark mode toggle", "fix: lower case.", "docs(x): ok", "...", "404 errors", "[x] y", "feat!: breaking"]) {
      const result = spawnSync("bash", [script, prTitle({ number: 7, title, labels: [] })], { encoding: "utf8" });
      assert.equal(result.status, 0, `${title}: ${result.stdout}`);
    }
  });

  it("doesn't double a prefix the title has, and squeezes stray spaces", () => {
    assert.equal(titled("  chore:   Bump   the pins "), "chore: Bump the pins");
  });
});

describe("publish", () => {
  // git's output for a GitHub Internal Server Error: a transient
  // GitHub failure that's worth retrying.
  const serverError =
    "git push --quiet origin abc:refs/heads/x failed:\nremote: Internal Server Error\nremote: (request ID A83C:231712:11AADA:1D38A9:6AC6797C)";
  // A push git itself refuses, not GitHub: retrying it would never help.
  const nonFastForward = "git push --quiet origin abc:refs/heads/x failed:\n ! [rejected] abc -> x (non-fast-forward)";

  // A push stub that throws `error` on its first `failures` calls, then
  // succeeds, and counts its calls.
  function flaky(failures: number, error: string) {
    let calls = 0;
    const push = (_branch: string, _commit: string): void => {
      calls++;
      if (calls <= failures) throw new Error(error);
    };
    return { push, calls: () => calls };
  }

  function recordedWaits() {
    const delays: number[] = [];
    return { delays, wait: async (ms: number) => void delays.push(ms) };
  }

  const neverCreatePr = (): string => {
    throw new Error("gh pr create shouldn't run");
  };

  it("retries a push that fails with a GitHub server error, and still publishes the PR", async () => {
    const { push, calls } = flaky(2, serverError);
    const { delays, wait } = recordedWaits();

    const prUrl = await publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, () => "https://github.com/o/r/pull/1", wait);

    assert.equal(prUrl, "https://github.com/o/r/pull/1");
    assert.equal(calls(), 3);
    assert.equal(delays.length, 2);
    assert.ok(delays.every((delay) => delay > 0), "backs off before each retry");
  });

  it("retries a gh pr create that fails with a GitHub server error, and still publishes the PR", async () => {
    const { push, calls: pushCalls } = flaky(0, serverError);
    let prCreateCalls = 0;
    const createPullRequest = (): string => {
      prCreateCalls++;
      if (prCreateCalls <= 1) throw new Error("gh pr create failed:\nHTTP 503");
      return "https://github.com/o/r/pull/2";
    };
    const { wait } = recordedWaits();

    const prUrl = await publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, createPullRequest, wait);

    assert.equal(prUrl, "https://github.com/o/r/pull/2");
    assert.equal(pushCalls(), 1);
    assert.equal(prCreateCalls, 2);
  });

  it("doesn't retry a push rejected for a reason other than a GitHub server error", async () => {
    const { push, calls } = flaky(1, nonFastForward);
    const { wait } = recordedWaits();

    await assert.rejects(
      () => publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, neverCreatePr, wait),
      (error: unknown) => error instanceof Error && error.message === nonFastForward,
    );
    assert.equal(calls(), 1);
  });

  it("gives up and rethrows once every retry attempt still fails with a GitHub server error", async () => {
    const { push, calls } = flaky(Infinity, serverError);
    const { wait } = recordedWaits();

    await assert.rejects(() => publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, neverCreatePr, wait));
    assert.equal(calls(), PUBLISH_RETRY_ATTEMPTS);
  });

  // Covers "A scribe failure still publishes the PR, and its body says the
  // documentation step failed".
  it("says the documentation step failed in the PR body when docsFailed is true", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prBody: string): string => {
      body = prBody;
      return "https://github.com/o/r/pull/1";
    };

    await publish(issue, branch, "a".repeat(40), true, true, undefined, [], () => {}, createPullRequest, async () => {});

    assert.match(body, /documentation step failed/i);
  });

  it("says nothing about documentation when docsFailed is false", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prBody: string): string => {
      body = prBody;
      return "https://github.com/o/r/pull/1";
    };

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest, async () => {});

    assert.doesNotMatch(body, /documentation/i);
  });

  // The follow-up sweep (lib/follow-up.mts#isSandcastlePullRequest) only
  // ever acts on a PR whose body carries this marker, so every PR the host
  // publishes from now on must carry it.
  it("opens the PR under a title that passes the PR title check", async () => {
    let title = "";
    const createPullRequest = (_branch: string, prTitleText: string): string => {
      title = prTitleText;
      return "https://github.com/o/r/pull/1";
    };

    await publish({ ...issue, title: "run the gate." }, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest, async () => {});

    assert.equal(title, "feat: Run the gate");
  });

  it("lists the files the branch changes under the gate's and CI's folders in the PR body", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prText: string): string => {
      body = prText;
      return "https://github.com/o/r/pull/1";
    };

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [".github/ci/test.sh", "scripts/gate.sh"], () => {}, createPullRequest, async () => {});

    assert.match(body, /changes files the gate and CI run/);
    assert.match(body, /```text\n\.github\/ci\/test\.sh\nscripts\/gate\.sh\n```/);
  });

  it("keeps a file name from closing an issue or mentioning anyone, by listing the names in a fence", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prText: string): string => {
      body = prText;
      return "https://github.com/o/r/pull/1";
    };

    await publish(issue, branch, "a".repeat(40), true, false, undefined, ["scripts/a` closes #12 `b.sh", "scripts/@someone.sh"], () => {}, createPullRequest, async () => {});

    const fenced = /(`{3,})text\n([\s\S]*?)\n\1$/.exec(body);
    assert.ok(fenced, body);
    assert.match(fenced[2]!, /closes #12/);
    assert.doesNotMatch(body.slice(0, fenced.index), /closes #12|@someone/);
  });

  it("adds no such note when the branch leaves those folders alone", async () => {
    assert.doesNotMatch(await publishedBody(true, false, undefined), /gate and CI run/);
  });

  it("carries PR_MARKER in the body, so the follow-up sweep recognises a PR the host published", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prBody: string): string => {
      body = prBody;
      return "https://github.com/o/r/pull/1";
    };

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest, async () => {});

    assert.ok(body.includes(PR_MARKER), body);
  });

  // Every PR Sandcastle opens had the same generic body. The reviewer
  // now writes a pr-body.md with Why, What changed and Verification
  // sections, read and validated before publish() is called, so a valid
  // `prBody` replaces the generic note entirely.
  const prBody = "## Why\n\nThe old body carried no account of the change.\n\n## What changed\n\n" +
    "Reads pr-body.md and uses it as the PR body.\n\n## Verification\n\nAdded tests in build.test.mts; ran `pnpm run check:sandcastle`.";

  async function publishedBody(reviewed: boolean, docsFailed: boolean, body: string | undefined): Promise<string> {
    let captured = "";
    const createPullRequest = (_branch: string, _title: string, prText: string): string => {
      captured = prText;
      return "https://github.com/o/r/pull/1";
    };
    await publish(issue, branch, "a".repeat(40), reviewed, docsFailed, body, [], () => {}, createPullRequest, async () => {});
    return captured;
  }

  it("publishes the marker, Closes #n, then the file's Why, What changed and Verification sections when a valid PR body is given", async () => {
    const body = await publishedBody(true, false, prBody);

    assert.equal(body, `${PR_MARKER}\nCloses #${issue.number}\n\n${prBody}`);
  });

  it("places the review-failed warning after the reviewer's sections when the review failed and a PR body is given", async () => {
    const body = await publishedBody(false, false, prBody);

    assert.ok(body.startsWith(`${PR_MARKER}\nCloses #${issue.number}\n\n${prBody}`), body);
    assert.match(body, /review step failed/i);
    assert.ok(body.indexOf(prBody) < body.indexOf("review step failed"), "the warning must come after the sections");
  });

  it("places the documentation-step-failed warning after the reviewer's sections when docsFailed is true and a PR body is given", async () => {
    const body = await publishedBody(true, true, prBody);

    assert.ok(body.startsWith(`${PR_MARKER}\nCloses #${issue.number}\n\n${prBody}`), body);
    assert.match(body, /documentation step failed/i);
    assert.ok(body.indexOf(prBody) < body.indexOf("documentation step failed"), "the warning must come after the sections");
  });

  it("places both warnings after the reviewer's sections when both the review and the documentation step failed", async () => {
    const body = await publishedBody(false, true, prBody);

    const sectionsEnd = body.indexOf(prBody) + prBody.length;
    assert.ok(/review step failed/i.test(body.slice(sectionsEnd)), body);
    assert.ok(/documentation step failed/i.test(body.slice(sectionsEnd)), body);
  });
});

describe("isGitHubServerError", () => {
  it("recognises the server errors git and gh report", () => {
    for (const output of [
      "git push failed:\nremote: Internal Server Error",
      "git push failed:\nerror: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500",
      "git push failed:\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 502",
      "gh pr create failed:\nHTTP 503",
      "gh pr list failed:\nHTTP 502: Bad Gateway (https://api.github.com/graphql)",
      "gh pr create failed:\nService Unavailable",
      "gh pr create failed:\nGateway Timeout",
      "gh pr create failed:\nGraphQL: Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.",
    ]) {
      assert.equal(isGitHubServerError(new Error(output)), true, output);
    }
  });

  it("doesn't take a rejected push, a client error or a 5xx in a branch name for a server error", () => {
    for (const output of [
      "git push --quiet origin abc:refs/heads/x failed:\n ! [rejected] abc -> x (non-fast-forward)",
      "git push --quiet origin abc:refs/heads/fix/500-retry failed:\n ! [rejected] (stale info)",
      "gh pr create failed:\nHTTP 422: Validation Failed",
      "gh pr create failed:\nHTTP 401: Bad credentials",
    ]) {
      assert.equal(isGitHubServerError(new Error(output)), false, output);
    }
  });

  it("reads only the command's output, not the command line it quotes", () => {
    const output = "gh pr create --title Show a page on Internal Server Error or HTTP 503 failed:\nHTTP 422: Validation Failed";

    assert.equal(isGitHubServerError(new Error(output)), false);
  });
});

// A push GitHub refused because it touches .github/workflows/** without
// Workflows permission must hand the issue back, not be treated as a
// transient server error or a generic publish failure.
describe("isWorkflowPushRejection", () => {
  it("recognises git's real output for a Personal Access Token without the workflow scope", () => {
    const output =
      "git push --quiet origin abc:refs/heads/feature/69-run-the-gate failed:\n" +
      " ! [remote rejected] abc -> feature/69-run-the-gate (refusing to allow a Personal Access Token to create or " +
      "update workflow `.github/workflows/ci.yml` without `workflow` scope)";

    assert.equal(isWorkflowPushRejection(new Error(output)), true);
  });

  it("recognises the rejection for an OAuth App", () => {
    const output =
      "git push failed:\n ! [remote rejected] abc -> x (refusing to allow an OAuth App to create or update workflow " +
      "`.github/workflows/ci.yml` without `workflow` scope)";

    assert.equal(isWorkflowPushRejection(new Error(output)), true);
  });

  it("recognises the rejection for a GitHub App", () => {
    const output =
      "git push failed:\n ! [remote rejected] abc -> x (refusing to allow a GitHub App to create or update workflow " +
      "`.github/workflows/ci.yml` without `workflows` permission)";

    assert.equal(isWorkflowPushRejection(new Error(output)), true);
  });

  it("doesn't take a non-fast-forward rejection for a workflow rejection", () => {
    const output = "git push --quiet origin abc:refs/heads/x failed:\n ! [rejected] abc -> x (non-fast-forward)";

    assert.equal(isWorkflowPushRejection(new Error(output)), false);
  });

  it("doesn't take a server error for a workflow rejection", () => {
    const output = "git push failed:\nremote: Internal Server Error";

    assert.equal(isWorkflowPushRejection(new Error(output)), false);
  });

  it("reads only the command's output, not a command line that names a workflow branch", () => {
    const output =
      "git push --quiet origin abc:refs/heads/feature/5-workflow-tweak failed:\n ! [rejected] abc -> x (non-fast-forward)";

    assert.equal(isWorkflowPushRejection(new Error(output)), false);
  });
});

describe("publicErrorText", () => {
  it("strips colour codes and the credentials in a URL", () => {
    assert.equal(
      publicErrorText("\u001b[31merror\u001b[0m: failed to push to 'https://x-access:abc123@github.com/o/r.git'", () => false),
      "error: failed to push to 'https://***@github.com/o/r.git'",
    );
  });

  it("withholds an error that holds a secret", () => {
    assert.match(publicErrorText("token abcdefgh12345 rejected", (text) => text.includes("abcdefgh12345")), /isn't shown/);
  });
});

// The architect's design note as the host posts it and reads it back
// (lib/build.mts). The host finds its own comments by marker substring
// (markerComments), so a note quoting a marker, as one for a change to
// Sandcastle itself would, mustn't pass for a host comment.
describe("designComment", () => {
  const note = `## Design\n\nOn failure, post ${BUILD_FAILED_MARKER} and keep ${DESIGN_MARKER} last.\n\n\`\`\`\`ts\nconst x = 1;\n\`\`\`\`\n\ncc @someone, see #12`;

  it("carries the design marker once, and no other host marker", () => {
    const body = designComment(note, "feature/3-add-a-thing", ".sandcastle/work/3/design.md");

    assert.equal(body.split(DESIGN_MARKER).length, 2, body);
    assert.ok(body.startsWith(DESIGN_MARKER), body);
    assert.ok(!body.includes(BUILD_FAILED_MARKER), body);
  });

  it("puts the note in a code fence longer than any backtick run in it, so it can't mention or cross-reference", () => {
    const body = designComment(note, "feature/3-add-a-thing", ".sandcastle/work/3/design.md");

    assert.match(body, /^`````markdown\n[\s\S]*\n`````$/m);
  });

  // Breaking a <!-- adds a character, so the cut is measured after it.
  it("stays under GitHub's comment limit for a note full of <!--", () => {
    const body = designComment("<!--".repeat(16_000), "feature/3-add-a-thing", ".sandcastle/work/3/design.md");

    assert.ok(body.length < 65_536, String(body.length));
  });

  it("cuts a note between characters, never inside a surrogate pair", () => {
    const body = designComment(`a${"\u{1F600}".repeat(40_000)}`, "feature/3-add-a-thing", ".sandcastle/work/3/design.md");

    assert.doesNotMatch(body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("cuts a note too long for a GitHub comment, and says where the whole of it is", () => {
    const body = designComment("x".repeat(70_000), "feature/3-add-a-thing", ".sandcastle/work/3/design.md");

    assert.ok(body.length < 65_536, String(body.length));
    assert.match(body, /Cut short to fit in a comment\. The whole note is in the sandbox's `\.sandcastle\/work\/3\/design\.md`/);
  });
});

describe("designNoteIn", () => {
  it("gives the architect back the note it wrote, markers included", () => {
    const note = `## Design\n\nPost ${BUILD_FAILED_MARKER}.\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;

    assert.equal(designNoteIn(designComment(note, "feature/3-add-a-thing", ".sandcastle/work/3/design.md")), note);
  });

  // GitHub stores a comment edited on github.com with CRLF line endings.
  it("reads back a design comment edited on github.com, with CRLF line endings", () => {
    const note = "## Design\n\nUse a Result<T>.";
    const edited = designComment(note, "feature/3-add-a-thing", ".sandcastle/work/3/design.md").replace(/\n/g, "\r\n");

    assert.equal(designNoteIn(edited), note);
  });

  it("gives back the body without the marker for a comment with no fence", () => {
    assert.equal(designNoteIn(`${DESIGN_MARKER}\nSome note.`), "Some note.");
  });
});

// The live lookup a re-run's architect prompt comes from. Anyone can comment
// on a public issue, so only the host's own design comments may reach the
// prompt, past the ownerApproved filtering every other prompt gets.
describe("latestDesignNote", () => {
  // A gh stub answering markerComments' three reads: the comments, the
  // label timeline (no events) and the issue's creation time.
  function gh(comments: { body: string; author: string; createdAt: string }[]) {
    return ((_cmd: string, args: readonly string[]) => {
      const path = String(args[args[1] === "--paginate" ? 2 : 1]);
      if (path.endsWith("/comments")) return comments.map((comment) => JSON.stringify(comment)).join("\n");
      if (path.endsWith("/timeline")) return "";
      return "2026-01-01T00:00:00Z\n";
    }) as unknown as typeof execFileSync;
  }

  it("reads the host's latest design note, ignoring a design comment from anyone else", () => {
    const run = gh([
      { body: designComment("The host's note.", "feature/3-a", "p"), author: "host", createdAt: "2026-01-02T00:00:00Z" },
      { body: designComment("A stranger's note.", "feature/3-a", "p"), author: "stranger", createdAt: "2026-01-03T00:00:00Z" },
    ]);

    assert.equal(latestDesignNote(3, "o/r", run, "host"), "The host's note.");
  });

  it("is undefined when the host has posted no design note", () => {
    const run = gh([{ body: designComment("A stranger's note.", "feature/3-a", "p"), author: "stranger", createdAt: "2026-01-03T00:00:00Z" }]);

    assert.equal(latestDesignNote(3, "o/r", run, "host"), undefined);
  });
});

// GitHub refuses a push when any pushed commit touches a workflow file,
// even one a later commit reverts, so the files come from the commits, not
// from the net diff, which would list nothing for an edit and its revert.
describe("workflowLogArgs", () => {
  it("lists the workflow files each commit on the branch side touches", () => {
    assert.deepEqual(workflowLogArgs("origin/main", "abc123"), [
      "log", "--name-only", "--format=", "origin/main..abc123", "--", ".github/workflows/",
    ]);
  });
});

// Main's commits merged in after `base` aren't the branch's work.
describe("workflowLogArgs with a merged main commit", () => {
  it("excludes the history of the main commit that was merged in", () => {
    assert.deepEqual(workflowLogArgs("origin/main", "abc123", "def456"), [
      "log", "--name-only", "--format=", "origin/main..abc123", "^def456", "--", ".github/workflows/",
    ]);
  });
});

describe("remoteMainIs", () => {
  const sha = "a".repeat(40);

  it("asks origin for refs/heads/main and compares the commit it names", () => {
    const asked: string[][] = [];
    const run = (...args: string[]) => {
      asked.push(args);
      return `${sha}\trefs/heads/main\n`;
    };

    assert.equal(remoteMainIs(sha, run), true);
    assert.equal(remoteMainIs("b".repeat(40), run), false);
    assert.deepEqual(asked[0], ["ls-remote", "origin", "refs/heads/main"]);
  });

  it("is false when origin names no main", () => {
    assert.equal(remoteMainIs(sha, () => ""), false);
  });

  it("takes the line whose ref is exactly refs/heads/main, not a branch that matches by its tail", () => {
    const other = "c".repeat(40);
    const run = () => `${other}\trefs/heads/a/refs/heads/main\n${sha}\trefs/heads/main\n`;

    assert.equal(remoteMainIs(sha, run), true);
    assert.equal(remoteMainIs(other, run), false);
  });

  it("is false for a commit main has moved past, without fetching or reading ancestry from the local .git", () => {
    const tip = "d".repeat(40);
    const asked: string[][] = [];
    const run = (...args: string[]) => {
      asked.push(args);
      return args[0] === "ls-remote" ? `${tip}\trefs/heads/main\n` : "";
    };

    assert.equal(remoteMainIs(sha, run), false);
    assert.deepEqual(asked, [["ls-remote", "origin", "refs/heads/main"]]);
  });
});

describe("remoteBranchIsOnOrigin", () => {
  const branch = "fix/253-publish";

  it("asks origin for the branch's ref and is true when it names it", () => {
    const asked: string[][] = [];
    const run = (...args: string[]) => {
      asked.push(args);
      return `${"a".repeat(40)}\trefs/heads/${branch}\n`;
    };

    assert.equal(remoteBranchIsOnOrigin(branch, run), true);
    assert.deepEqual(asked, [["ls-remote", "origin", `refs/heads/${branch}`]]);
  });

  it("is false when origin has no such branch", () => {
    assert.equal(remoteBranchIsOnOrigin(branch, () => ""), false);
  });

  it("is false when the branch's line names no commit", () => {
    assert.equal(remoteBranchIsOnOrigin(branch, () => `\trefs/heads/${branch}\n`), false);
  });

  it("is false when only a branch that matches by its tail exists", () => {
    const run = () => `${"c".repeat(40)}\trefs/heads/a/refs/heads/${branch}\n`;

    assert.equal(remoteBranchIsOnOrigin(branch, run), false);
  });

  it("throws when origin can't be asked", () => {
    const run = (): string => {
      throw new Error("git ls-remote failed");
    };

    assert.throws(() => remoteBranchIsOnOrigin(branch, run), /ls-remote failed/);
  });
});

describe("workflowFilesFrom", () => {
  it("names each file once, in first-seen order, without blank lines", () => {
    const output = "\n.github/workflows/ci.yml\n\n.github/workflows/release.yml\n.github/workflows/ci.yml\n";

    assert.deepEqual(workflowFilesFrom(output), [".github/workflows/ci.yml", ".github/workflows/release.yml"]);
  });
});

describe("createCheckedSandbox's git identity", () => {
  const MERGE = "git merge --no-edit -m 'Merge main into feature' main";

  // The sandbox createCheckedSandbox hands over, made over a scratch git
  // repository whose global config has no identity, as a fresh sandbox's hasn't.
  async function sandboxFor(identity: HostIdentity) {
    const fake = gitSandboxFake();
    const sandbox = await createCheckedSandbox("feature", fake.create, () => identity);
    return { fake, sandbox };
  }

  // Acceptance criterion: "A test pins that a sandbox from
  // `createCheckedSandbox` gets the host's identity before the host's first
  // `git merge`."
  it("gives the sandbox the host's identity, so the host's first git merge can commit", async (t) => {
    const { fake, sandbox } = await sandboxFor({ name: "Host Person", email: "host@example.com" });
    t.after(() => fake.cleanup());

    const merge = await sandbox.exec(MERGE);

    assert.equal(merge.exitCode, 0, `${merge.stdout}\n${merge.stderr}`);
    assert.equal(fake.headIdentity(), "Host Person <host@example.com>|Host Person <host@example.com>");
  });

  // Acceptance criterion: "`createCheckedSandbox` sets the host's `git config
  // user.name` and `user.email` in the sandbox (`git config --global`)."
  it("sets the host's user.name and user.email as the sandbox's global git config", async (t) => {
    const { fake, sandbox } = await sandboxFor({ name: "Host Person", email: "host@example.com" });
    t.after(() => fake.cleanup());

    assert.equal((await sandbox.exec("git config --global user.name")).stdout.trim(), "Host Person");
    assert.equal((await sandbox.exec("git config --global user.email")).stdout.trim(), "host@example.com");
  });

  it("sets the identity before the sandbox is handed over, ahead of any command the caller runs", async (t) => {
    const { fake, sandbox } = await sandboxFor({ name: "Host Person", email: "host@example.com" });
    t.after(() => fake.cleanup());
    const setUp = [...fake.execs];

    await sandbox.exec(MERGE);

    assert.ok(setUp.some((command) => /git config --global user\.name/.test(command)), setUp.join("\n"));
    assert.ok(setUp.some((command) => /git config --global user\.email/.test(command)), setUp.join("\n"));
    assert.ok(!setUp.some((command) => command.startsWith("git merge")), setUp.join("\n"));
  });

  it("keeps a name with quotes and spaces intact", async (t) => {
    const name = `Host "Quoted" O'Neil`;
    const { fake, sandbox } = await sandboxFor({ name, email: "host@example.com" });
    t.after(() => fake.cleanup());

    assert.equal((await sandbox.exec("git config --global user.name")).stdout.trim(), name);
  });

  // Acceptance criterion: "If the host has neither, the sandbox is left as it
  // is."
  it("leaves the sandbox as it is when the host has neither a name nor an email", async (t) => {
    const fake = gitSandboxFake();
    t.after(() => fake.cleanup());
    const before = fake.globalConfig();

    await createCheckedSandbox("feature", fake.create, () => ({}));

    assert.deepEqual(fake.execs.filter((command) => /user\.(name|email)/.test(command)), []);
    assert.equal(fake.globalConfig(), before);
  });

  it("sets only the email when the host has an email and no name", async (t) => {
    const { fake, sandbox } = await sandboxFor({ email: "host@example.com" });
    t.after(() => fake.cleanup());

    assert.equal((await sandbox.exec("git config --global user.email")).stdout.trim(), "host@example.com");
    assert.equal((await sandbox.exec("git config --global user.name")).exitCode, 1);
  });

  it("sets only the name when the host has a name and no email", async (t) => {
    const { fake, sandbox } = await sandboxFor({ name: "Host Person" });
    t.after(() => fake.cleanup());

    assert.equal((await sandbox.exec("git config --global user.name")).stdout.trim(), "Host Person");
    assert.equal((await sandbox.exec("git config --global user.email")).exitCode, 1);
  });

  it("closes the sandbox and rejects when setting the identity fails", async () => {
    let closed = 0;
    const sandbox = {
      exec: async () => ({ stdout: "", stderr: "could not lock config file", exitCode: 255 }),
      close: async () => {
        closed += 1;
        return {};
      },
    } as unknown as Sandbox;

    await assert.rejects(
      createCheckedSandbox("feature", async () => sandbox, () => ({ name: "Host Person" }), () => []),
      /setting the sandbox's git user\.name failed: could not lock config file/,
    );
    assert.equal(closed, 1);
  });

  it("leaves the sandbox in place and reports the problems when setting the identity fails in a tampered worktree", async () => {
    let closed = 0;
    const sandbox = {
      worktreePath: "/work/tree",
      exec: async () => ({ stdout: "", stderr: "could not lock config file", exitCode: 255 }),
      close: async () => {
        closed += 1;
        return {};
      },
    } as unknown as Sandbox;
    const checked: string[] = [];

    await assert.rejects(
      createCheckedSandbox(
        "feature",
        async () => sandbox,
        () => ({ name: "Host Person" }),
        (worktreePath) => {
          checked.push(worktreePath);
          return worktreePath === "/work/tree" ? ["its .git doesn't point into this repository"] : [];
        },
      ),
      (error: unknown) =>
        error instanceof TamperedWorktreeError &&
        error.worktreePath === "/work/tree" &&
        /could not lock config file.*left \/work\/tree.*doesn't point into this repository/s.test(error.message),
    );
    assert.equal(closed, 0);
    assert.ok(checked.includes("/work/tree"));
  });

  it("leaves the sandbox in place, and keeps the identity error, when checking the worktree throws", async () => {
    let closed = 0;
    const sandbox = {
      worktreePath: "/work/tree",
      exec: async () => ({ stdout: "", stderr: "could not lock config file", exitCode: 255 }),
      close: async () => {
        closed += 1;
        return {};
      },
    } as unknown as Sandbox;

    await assert.rejects(
      createCheckedSandbox(
        "feature",
        async () => sandbox,
        () => ({ name: "Host Person" }),
        (worktreePath) => {
          if (worktreePath === "/work/tree") throw new Error("git rev-parse failed");
          return [];
        },
      ),
      (error: unknown) =>
        error instanceof TamperedWorktreeError && /could not lock config file.*checking the worktree failed: git rev-parse failed/s.test(error.message),
    );
    assert.equal(closed, 0);
  });
});

describe("liveHostIdentity", () => {
  it("reads the host's user.name and user.email with git config", () => {
    const calls: string[][] = [];
    const values: Record<string, string> = { "user.name": "Host Person", "user.email": "host@example.com" };
    const identity = liveHostIdentity((...args) => {
      calls.push(args);
      return values[args[1] ?? ""] ?? "";
    });

    assert.deepEqual(identity, { name: "Host Person", email: "host@example.com" });
    assert.deepEqual(calls, [["config", "user.name"], ["config", "user.email"]]);
  });

  it("leaves out a key git config fails on, as it does for one that isn't set", () => {
    const identity = liveHostIdentity((...args) => {
      if (args[1] === "user.name") throw new Error("git config user.name failed");
      return "host@example.com";
    });

    assert.deepEqual(identity, { name: undefined, email: "host@example.com" });
  });

  it("leaves out a key git config reads as empty", () => {
    assert.deepEqual(liveHostIdentity(() => ""), { name: undefined, email: undefined });
  });
});
