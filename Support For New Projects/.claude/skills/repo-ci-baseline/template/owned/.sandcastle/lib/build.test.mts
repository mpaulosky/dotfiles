import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox, SandboxRunOptions } from "@ai-hero/sandcastle";
import { spawnSync, type execFileSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { worktreePathFor } from "./host-safety.mts";
import { hostExecFileSync } from "./host-limit.mts";
import { forgetRepoName, repoName } from "./github.mts";
import { join } from "node:path";
import {
  buildIssue,
  createCheckedSandbox,
  worktreeIsGone,
  designComment,
  designNoteIn,
  HoldFailedError,
  latestDesignNote,
  isGitHubServerError,
  isWorkflowPushRejection,
  liveHostIdentity,
  liveReviewHost,
  PR_BODY_LIMIT,
  boundedCheckList,
  cutDescription,
  logSafeGateOutput,
  PR_BODY_TOTAL_LIMIT,
  publicErrorText,
  prTitle,
  publish,
  openHeldPullRequest,
  DRAFT_NOTE,
  remoteBranchIsOnOrigin,
  readSkillFiles,
  remoteMainIs,
  retryOnServerError,
  UncountedStopError,
  type BuildHost,
  type HostIdentity,
  type LocalReviewArgs,
  workflowFilesFrom,
  workflowLogArgs,
} from "./build.mts";
import {
  BUILD_FAILED_MARKER,
  BUILD_ROLES,
  DESIGN_MARKER,
  FIXED_ROLE_AGENTS,
  GATE_FIXER_ATTEMPTS,
  MAX_GATE_RUNS,
  MAX_REVIEWERS_PER_ROUND,
  PR_MARKER,
  PUBLISH_RETRY_ATTEMPTS,
  type OptionalRole,
} from "./config.mts";
import { LEAD_DENIED_TOOLS, leadTools, LEDGER_DENIED_TOOLS, MAX_AGENTS_WORD_BYTES } from "./agents.mts";
import { SANDBOX_PROBE } from "./diagnostics.mts";
import { StalledStepError, TamperedWorktreeError } from "./errors.mts";
import { gitSandboxFake } from "./git-sandbox-fake.mts";
import type { HostReviewResult } from "./host-review.mts";
import { RunLimits } from "./limits.mts";
import { PR_BODY_RULES } from "./prompts.mts";
import { ledgerGitEnv, renderAdvisories, type Ledger } from "./review-ledger.mts";
import type { SecretMatch } from "./scan.mts";
import { buildLogs, reviewerLogFileName } from "./role-logs.mts";
import { GATE_COMMAND, GATE_LIMIT_MINUTES, GATE_SCRIPT } from "./repo-config.mts";
import { KILL_GRACE_SECONDS, LIMITED_COMMAND_PREFIX, LIMITED_COMMAND_SUFFIX, PROBE_LIMIT_MINUTES, limitSandboxExec, limitedCommand, markSandboxStalled, stalledStepOf } from "./step-limit.mts";
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

// A recorded review with no findings, as the default localReview returns.
const emptyLedger = (head: string, ledgerBranch: string): Ledger => ({
  version: 1,
  key: "k",
  branch: ledgerBranch,
  base,
  head,
  recordedAt: "2026-01-01T00:00:00.000Z",
  rounds: 1,
  reviewerAgent: "pre-push-reviewer",
  findings: [],
});

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
    publishHoldFailed,
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
    sandboxDiesAfterGates,
    sandboxDeathError,
    gateScriptChanged = "",
    checkFiles = "",
    checkFilesError,
    localReview,
    probeError,
    probeOutput = "disk 10% used\n",
  }: {
    // What the sandbox-state probe (lib/diagnostics.mts) throws, instead of printing a state.
    probeError?: Error;
    // What the probe prints.
    probeOutput?: string;
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
    publishHoldFailed?: boolean;
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
    // What every gate run prints, or what gate run <n> prints (counting from 1) when this is a function, instead of "gate output, exit <exit code>".
    gateOutput?: string | ((gateRun: number) => string);
    // `git rev-parse HEAD` fails once this many gate runs have printed, as in a sandbox that was killed during or right after the gate,
    // with exit 128, or by throwing `sandboxDeathError` when that is set.
    sandboxDiesAfterGates?: number;
    // What `git rev-parse HEAD` throws, instead of failing with exit 128, once `sandboxDiesAfterGates` gate runs have printed.
    sandboxDeathError?: Error;
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
    // What the host's local review does once checkpoint 2 has passed. By default it records a review of the commit it was given
    // without touching the branch, so the tests that don't care about the review see the build as before.
    localReview?: (args: LocalReviewArgs) => Promise<HostReviewResult>;
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
      if (command === SANDBOX_PROBE) {
        probes.push(`${runs.length} roles run`);
        if (probeError !== undefined) throw probeError;
        return { stdout: probeOutput, stderr: "", exitCode: 0 };
      }
      if (command.startsWith("git status")) {
        const stdout = worktreeStatuses.shift() ?? "";
        return { stdout, stderr: "", exitCode: 0 };
      }
      if (command === "git rev-parse HEAD") {
        if (sandboxDiesAfterGates !== undefined && steps.filter((step) => step.startsWith("gate:")).length >= sandboxDiesAfterGates) {
          if (sandboxDeathError !== undefined) throw sandboxDeathError;
          return { stdout: "fatal: not a git repository\n", stderr: "", exitCode: 128 };
        }
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
      const gateRun = steps.filter((step) => step.startsWith("gate:")).length;
      const printed = typeof gateOutput === "function" ? gateOutput(gateRun) : gateOutput;
      return { stdout: printed ?? `gate output, exit ${exitCode}\n`, stderr: "", exitCode };
    },
    close: async () => {
      steps.push("close");
      order.push("close");
      return {};
    },
  } as unknown as Sandbox;
  // A note per probe of the sandbox's state.
  const probes: string[] = [];
  const buildingCalls: number[] = [];
  const designNoteCalls: number[] = [];
  const gateGuardChecks: string[] = [];
  const publishedCheckChanges: (readonly string[])[] = [];
  const publishCalls: { reviewed: boolean; docsFailed: boolean }[] = [];
  // The prBody argument buildMarkedIssue passed to host.publish, one entry
  // per call, kept apart from publishCalls so existing assertions on that
  // shape don't have to change.
  const publishedPrBodies: (string | undefined)[] = [];
  // The reviewNote argument buildMarkedIssue passed to host.publish (its 11th), one entry per call.
  const publishedReviewNotes: (string | undefined)[] = [];
  // The holdAsDraft argument buildMarkedIssue passed to host.publish (its 12th), one entry per call.
  const publishedDrafts: (boolean | undefined)[] = [];
  // Every follow-up issue the build filed for the review's open Advisory findings.
  const advisoryIssues: { title: string; body: string }[] = [];
  // Every localReview call's arguments.
  const localReviewCalls: LocalReviewArgs[] = [];
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
    publish: async (_issue, publishedBranch, commit, reviewed, docsFailed, prBody, checkChanges = [], _push, _create, _wait, reviewNote, holdAsDraft) => {
      // Only a publish that holds the PR as a draft can fail to hold it.
      if (publishHoldFailed && holdAsDraft) throw new HoldFailedError(publishedBranch, new Error("gh pr ready failed:\nHTTP 422"));
      if (publishError) throw new Error(publishError);
      pushed.push({ branch: publishedBranch, commit });
      publishEvents.push("publish");
      publishCalls.push({ reviewed, docsFailed });
      publishedPrBodies.push(prBody);
      publishedReviewNotes.push(reviewNote);
      publishedDrafts.push(holdAsDraft);
      publishedCheckChanges.push(checkChanges);
      steps.push(`publish${reviewed ? "" : " unreviewed"}${docsFailed ? " docs-failed" : ""}`);
      return "https://github.com/o/r/pull/1";
    },
    fileAdvisoryIssue: (title, body) => {
      publishEvents.push("file-advisory");
      advisoryIssues.push({ title, body });
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
    localReview: async (args) => {
      localReviewCalls.push(args);
      order.push("local-review");
      if (localReview !== undefined) return localReview(args);
      return { status: "recorded", head: args.startHead, rounds: 1, ledger: emptyLedger(args.startHead, args.branch), readPaths: new Set() };
    },
  };
  return {
    steps, runs, logs, probes, comments, recordBuildFailureCalls, buildHost, aheadBranches, aheadBases, scanned, scannedBases, pushed, head,
    order, buildingCalls, designNoteCalls, publishCalls, publishedPrBodies, publishedCheckChanges, gateGuardChecks, workCommands, startFromMainCalls, handBackWorkflowChangeCalls,
    mainChecks, baseChecks, scannedExclusions, listedExclusions, workflowFileCalls, moveToLocalCalls, createdBranches, deletedBranches, publishEvents,
    publishedReviewNotes, localReviewCalls, publishedDrafts, advisoryIssues,
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("buildIssue when Docker never answers the close", () => {
  // The host's sandbox, with a close that never answers and a 0.001-minute close limit.
  function hungClose(options: Parameters<typeof host>[1] = {}) {
    const hosted = host([0, 0], options);
    hosted.buildHost.dockerCallMinutes = 0.001;
    const createSandbox = hosted.buildHost.createSandbox;
    hosted.buildHost.createSandbox = async (sandboxBranch) => {
      const raw = await createSandbox(sandboxBranch);
      return { ...raw, close: () => new Promise<never>(() => undefined) } as typeof raw;
    };
    return hosted;
  }

  it("keeps the published pull request: the hung close is logged and not reported as the build's outcome", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    const { buildHost } = hungClose();

    const result = await buildIssue(issue, branch, base, buildHost);

    assert.equal(result.outcome, "published");
    assert.ok(logged.some((line) => /closing the sandbox didn't finish within 0\.001 minutes/.test(line)), logged.join("\n"));
  });

  it("keeps the error that ended the work when the close then hangs", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const hosted = hungClose({ failing: ["tester"], failWith: { tester: new UncountedStopError("usage limit") } });

    await assert.rejects(() => buildIssue(issue, branch, base, hosted.buildHost), UncountedStopError);
  });
});

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
      "  #69 sandbox state (before checkpoint 1):\n    | disk 10% used",
      "  #69 checkpoint 1: gate passed",
      "  #69 reviewer finished",
      "  #69 sandbox state (before checkpoint 2):\n    | disk 10% used",
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

  it("logs the sandbox's state when the reviewer fails, and still publishes unreviewed", async () => {
    const { logs, probes, pushed, buildHost } = host([0, 0], { failing: ["reviewer"] });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(logs.some((line) => /sandbox state \(the reviewer failed\):\n    \| disk 10% used/.test(line)), logs.join("\n"));
    assert.ok(probes.length >= 1, "the probe never ran");
    assert.equal(pushed.length, 1);
  });

  it("logs the sandbox's state when a developer role fails, and still records the failed attempt", async () => {
    const { logs, recordBuildFailureCalls, buildHost } = host([], { failing: ["backend"] });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(logs.some((line) => /sandbox state \(the backend failed\):/.test(line)), logs.join("\n"));
    assert.equal(recordBuildFailureCalls.length, 1);
  });

  it("logs the sandbox's state when a developer ran out of iterations unfinished, and records the failed attempt", async () => {
    const { logs, recordBuildFailureCalls, buildHost } = host([], { unfinished: ["backend"] });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(logs.some((line) => /sandbox state \(the backend ran out of iterations unfinished\):/.test(line)), logs.join("\n"));
    assert.equal(recordBuildFailureCalls.length, 1);
  });

  it("records the same failed attempt when a developer role fails and the probe fails too", async () => {
    const healthy = host([], { failing: ["backend"] });
    await buildIssue(issue, branch, base, healthy.buildHost);
    const broken = host([], { failing: ["backend"], probeError: new Error("docker exec failed") });

    const result = await buildIssue(issue, branch, base, broken.buildHost);

    assert.equal(result.outcome, "role failed");
    assert.deepEqual(broken.recordBuildFailureCalls, healthy.recordBuildFailureCalls);
    assert.ok(broken.logs.some((line) => /the probe failed/.test(line)), broken.logs.join("\n"));
  });

  it("cleans the probe's output like the gate's: every logged line is prefixed, and no ##[ command is left", async () => {
    const { logs, buildHost } = host([0, 0], { probeOutput: "== core files ==\n::add-mask::secret\n::stop-commands::x\n##[error]y\n" });

    await buildIssue(issue, branch, base, buildHost);

    const state = logs.filter((line) => line.includes("sandbox state"));
    assert.ok(state.length > 0);
    for (const line of state.flatMap((entry) => entry.split("\n").slice(1))) {
      assert.ok(line.startsWith("    | "), line);
      assert.ok(!line.includes("##["), line);
    }
  });

  it("runs no probe when a usage-limit or time-budget stop ends a developer role or the reviewer", async () => {
    for (const role of ["backend", "reviewer"]) {
      const stop = new UncountedStopError("usage limit reached");
      const { logs, probes, buildHost } = host([0], { failing: [role], failWith: { [role]: stop } });

      await assert.rejects(() => buildIssue(issue, branch, base, buildHost), (error: unknown) => error === stop);

      assert.equal(probes.length, logs.filter((line) => line.includes("sandbox state (before checkpoint")).length, `${role}: a probe ran for the stop`);

      assert.ok(!logs.some((line) => line.includes(`(the ${role} failed)`)), `${role}: ${logs.join("\n")}`);
    }
  });

  // The state of the sandbox after the other roles fail too (mpaulosky/dotfiles#428): a gate-fixer or a scribe that dies can leave it as broken as a reviewer.
  it("logs the sandbox's state when the gate-fixer fails, and carries on with the checkpoint's own handling", async () => {
    const { logs, recordBuildFailureCalls, buildHost } = host([1, 1, 1], { failing: ["gate-fixer"] });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(logs.some((line) => /sandbox state \(the gate-fixer failed\):/.test(line)), logs.join("\n"));
    assert.equal(recordBuildFailureCalls.length, 1);
  });

  it("logs the sandbox's state when the scribe fails, and still publishes with a note", async () => {
    const { logs, pushed, buildHost } = host([0, 0], { failing: ["scribe"] });

    await buildIssue(withRoles(["scribe"]), branch, base, buildHost);

    assert.ok(logs.some((line) => /sandbox state \(the scribe failed\):/.test(line)), logs.join("\n"));
    assert.equal(pushed.length, 1);
  });

  it("runs no probe when a usage-limit or time-budget stop ends the gate-fixer or the scribe", async () => {
    for (const role of ["gate-fixer", "scribe"]) {
      const stop = new UncountedStopError("usage limit reached");
      const { logs, buildHost } = host(role === "gate-fixer" ? [1] : [0, 0], { failing: [role], failWith: { [role]: stop } });

      await assert.rejects(() => buildIssue(withRoles(["scribe"]), branch, base, buildHost), (error: unknown) => error === stop);

      assert.ok(!logs.some((line) => line.includes(`(the ${role} failed)`)), `${role}: ${logs.join("\n")}`);
    }
  });

  it("adds the build to the record the reviewer-log index reads", async () => {
    const { buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(buildLogs.issueOf(reviewerLogFileName(branch)), issue.number);
  });

  it("logs the sandbox's state before each checkpoint's gate", async () => {
    const { logs, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(logs.some((line) => /sandbox state \(before checkpoint 1\):/.test(line)), logs.join("\n"));
    assert.ok(logs.some((line) => /sandbox state \(before checkpoint 2\):/.test(line)), logs.join("\n"));
  });

  it("builds the same when the probe of the sandbox's state fails", async () => {
    const { logs, pushed, buildHost } = host([0, 0], { failing: ["reviewer"], probeError: new Error("docker exec failed") });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(logs.some((line) => /the probe failed:\n    \| Error: docker exec failed/.test(line)), logs.join("\n"));
    assert.equal(pushed.length, 1);
  });

  it("treats a checkpoint that stays red after the gate-fixer's attempts as a failed build attempt", async () => {
    const { recordBuildFailureCalls, buildHost } = host([1, 1, 1]);

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(recordBuildFailureCalls.length, 1);
    assert.equal(recordBuildFailureCalls[0]!.issueNumber, 69);
  });

  it("runs no gate-fixer, and records the dead sandbox, when git stops answering after the first gate", async () => {
    const { steps, recordBuildFailureCalls, buildHost } = host([1], { sandboxDiesAfterGates: 1 });

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(!steps.some((step) => step.startsWith("gate-fixer")), steps.join(", "));
    assert.equal(recordBuildFailureCalls.length, 1);
    assert.match(recordBuildFailureCalls[0]!.detail, /after 0 gate-fixer attempts/);
    assert.match(recordBuildFailureCalls[0]!.detail, /gate output, exit 1\n❌ The sandbox no longer answers `git rev-parse HEAD`, so no gate-fixer was run\./);
  });

  it("quotes the first red gate run before the last when they differ, and counts the fixers that ran", async () => {
    const { recordBuildFailureCalls, buildHost } = host([1, 1, 1], { gateOutput: (run) => `run ${run} failed\n` });

    await buildIssue(issue, branch, base, buildHost);

    const detail = recordBuildFailureCalls[0]!.detail;
    assert.match(detail, /after 2 gate-fixer attempts/);
    assert.match(detail, /first red gate run, before a gate-fixer ran:\n\n```text\nrun 1 failed\n```\n\nThe last 100 lines of the last gate output:\n\n```text\nrun 3 failed\n```/);
  });

  it("withholds a first red gate run that looks like it holds a secret, as it does the last", async () => {
    const { recordBuildFailureCalls, buildHost } = host([1, 1, 1], {
      gateOutput: (run) => (run === 1 ? "FAIL: env dump\nCLAUDE_CODE_OAUTH_TOKEN=ghp_abc\n" : "later failure\n"),
    });
    buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await buildIssue(issue, branch, base, buildHost);

    const detail = recordBuildFailureCalls[0]!.detail;
    assert.ok(!detail.includes("ghp_abc"), detail);
    assert.match(detail, /first red gate run, before a gate-fixer ran:\n\n```text\n.*looked like it held a secret.*```\n\nThe last 100 lines of the last gate output:\n\n```text\nlater failure/s);
  });

  it("breaks a host marker's <!-- in the first red gate run, as in the last", async () => {
    const { recordBuildFailureCalls, buildHost } = host([1, 1, 1], {
      gateOutput: (run) => (run === 1 ? "FAIL: expected <!-- sandcastle:build-failed --> in the comment\n" : "later failure\n"),
    });

    await buildIssue(issue, branch, base, buildHost);

    const detail = recordBuildFailureCalls[0]!.detail;
    assert.ok(!detail.includes("<!-- sandcastle:build-failed"), detail);
    assert.match(detail, /first red gate run, before a gate-fixer ran:\n\n```text\nFAIL: expected .*build-failed -->/);
  });

  it("stops before the second gate-fixer when the sandbox goes down, quoting both runs and the attempts that ran", async () => {
    const { steps, recordBuildFailureCalls, buildHost } = host([1, 1], { sandboxDiesAfterGates: 2, gateOutput: (run) => `run ${run} failed\n` });

    await buildIssue(issue, branch, base, buildHost);

    assert.equal(steps.filter((step) => step.startsWith("gate-fixer")).length, 1, steps.join(", "));
    const detail = recordBuildFailureCalls[0]!.detail;
    assert.match(detail, /after 1 gate-fixer attempt, so/);
    assert.match(detail, /```text\nrun 1 failed\n```/);
    assert.match(detail, /run 2 failed\n❌ The sandbox no longer answers `git rev-parse HEAD`, so no gate-fixer was run\./);
  });

  it("withholds a secret in the sandbox probe's error from the log and the comment", async () => {
    const { logs, recordBuildFailureCalls, buildHost } = host([1], {
      sandboxDiesAfterGates: 1,
      sandboxDeathError: new Error("exit 1: GH token ghp_abc in the output"),
    });
    buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await buildIssue(issue, branch, base, buildHost);

    assert.ok(!logs.join("\n").includes("ghp_"), logs.join("\n"));
    assert.ok(!recordBuildFailureCalls[0]!.detail.includes("ghp_"), recordBuildFailureCalls[0]!.detail);
    assert.ok(logs.some((line) => line.includes("not run: The sandbox can't run a command")), logs.join("\n"));
  });

  it("doesn't point to a run log for a probe error it withheld, since only the scrubbed reason is logged", async () => {
    const { logs, recordBuildFailureCalls, buildHost } = host([1], {
      sandboxDiesAfterGates: 1,
      sandboxDeathError: new Error("exit 1: GH token ghp_abc in the output"),
    });
    buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await buildIssue(issue, branch, base, buildHost);

    assert.doesNotMatch(logs.join("\n"), /run log/i);
    assert.doesNotMatch(recordBuildFailureCalls[0]!.detail, /run log/i);
  });

  it("logs a failed gate-fixer attempt's error on one line through the real scrub, without a prefix", async () => {
    const { logs, buildHost } = host([1, 1, 1], { failing: ["gate-fixer"], failWith: { "gate-fixer": new Error("boom\n##[add-mask]x") } });

    await buildIssue(issue, branch, base, buildHost);

    const failure = logs.find((line) => line.includes("gate-fixer attempt 1/2 failed"))!;
    assert.match(failure, /failed: Error: boom ## \[add-mask\]x$/);
    assert.ok(!failure.includes("|"), failure);
  });

  it("logs the first red gate run, scrubbed, when a stall on the probe ends the work", async () => {
    const stall = new StalledStepError('The step "git rev-parse HEAD" ran over its limit.');
    const { logs, buildHost } = host([1], {
      sandboxDiesAfterGates: 1,
      sandboxDeathError: stall,
      gateOutput: "FAIL: env dump\nCLAUDE_CODE_OAUTH_TOKEN=ghp_abc\n",
    });
    buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await assert.rejects(buildIssue(issue, branch, base, buildHost), (error: unknown) => error === stall);

    const text = logs.join("\n");
    assert.match(text, /the first red gate run's output, before this stopped the checkpoint:\n.*looked like it held a secret/s);
    assert.ok(!text.includes("ghp_abc"), text);
  });

  it("logs the first red gate run with every line prefixed and cleaned for a terminal, so none starts with ::", async () => {
    const stall = new StalledStepError('The step "git rev-parse HEAD" ran over its limit.');
    const { logs, buildHost } = host([1], {
      sandboxDiesAfterGates: 1,
      sandboxDeathError: stall,
      gateOutput: "plain line\r::stop-commands::tok\n::error::x\n\u001b]0;title\u0007after\n",
    });

    await assert.rejects(buildIssue(issue, branch, base, buildHost), (error: unknown) => error === stall);

    const entry = logs.find((line) => line.includes("the first red gate run's output"))!;
    const [, ...body] = entry.split("\n");
    assert.ok(body.length >= 3, entry);
    for (const line of body) assert.ok(line.startsWith("    | "), JSON.stringify(line));
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(body.join("")), JSON.stringify(entry));
  });

  it("drops a final newline, so the tail isn't spent on a blank line, and cuts a line at 500 characters", () => {
    const logged = logSafeGateOutput("one\ntwo\n", (text) => text);
    assert.equal(logged, "    | one\n    | two");

    for (const [length, kept] of [[499, 499], [500, 500], [501, 500]] as const) {
      assert.equal(logSafeGateOutput("y".repeat(length), (text) => text), `    | ${"y".repeat(kept)}`, `${length} characters`);
    }
    // The shapes a text can end in.
    const same = (text: string) => logSafeGateOutput(text, (value) => value);
    assert.equal(same("a\r\nb\r\n"), "    | a\n    | b");
    assert.equal(same(""), "    | ");
    assert.equal(same("\n"), "    | ");
    assert.equal(same("a\n\n"), "    | a\n    | ");
    // A text the real publicErrorText withholds comes out as one prefixed line.
    const withheld = logSafeGateOutput(`${"y".repeat(900)}\nghp_abc`, (value) => publicErrorText(value, (cleaned) => cleaned.includes("ghp_")));
    assert.match(withheld, /^    \| \(This text isn't shown: it looked like it held a secret\./);
    assert.ok(!withheld.includes("\n"), withheld);
    // A character outside the basic plane counts once, so the cut can't split it.
    assert.equal(logSafeGateOutput(`${"y".repeat(499)}\u{1F600}z`, (text) => text), `    | ${"y".repeat(499)}\u{1F600}`);
  });

  it("changes a ##[ so the runner's legacy command form isn't left in a logged line", () => {
    const logged = logSafeGateOutput("##[add-mask]checkpoint\nsee ##[error]x\n##\u200b[group]y", (value) => value);

    assert.ok(!logged.includes("##["), logged);
    assert.equal(logged, "    | ## [add-mask]checkpoint\n    | see ## [error]x\n    | ## [group]y");
  });

  it("cleans each line before the secret check, so a hidden character can't hide a token that is rebuilt afterwards", () => {
    const publicError = (text: string) => publicErrorText(text, (cleaned) => cleaned.includes("ghp_abc"));

    const logged = logSafeGateOutput("fine\nghp_a\u200bbc leaked", publicError);

    assert.ok(!logged.includes("ghp_abc"), logged);
    assert.match(logged, /looked like it held a secret/);
    assert.ok(logged.split("\n").every((line) => line.startsWith("    | ")), logged);
  });

  it("lets a stall on the sandbox probe end the work instead of recording a failed build attempt", async () => {
    const stall = new StalledStepError('The step "git rev-parse HEAD" ran over its limit.');
    const { steps, recordBuildFailureCalls, buildHost } = host([1], { sandboxDiesAfterGates: 1, sandboxDeathError: stall });

    await assert.rejects(buildIssue(issue, branch, base, buildHost), (error: unknown) => error === stall);

    assert.ok(!steps.some((step) => step.startsWith("gate-fixer")), steps.join(", "));
    assert.deepEqual(recordBuildFailureCalls, []);
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

// A command that runs over its limit stalls the sandbox: the build ends with StalledStepError naming the step, whatever
// the command was. The fake answers `match` with timeout's code, after what looks like a full limit on the clock below.
describe("buildIssue when a step stalls the sandbox", () => {
  function stalledOn(match: RegExp, { closeFails = false } = {}) {
    const hosted = host([0, 0]);
    const createSandbox = hosted.buildHost.createSandbox;
    hosted.buildHost.createSandbox = async (sandboxBranch) => {
      const raw = await createSandbox(sandboxBranch);
      const slow = {
        ...raw,
        // The fake answers the commands as the build wrote them, so the `timeout … sh -c '…'` wrapper comes off first.
        exec: async (wrapped: string, options?: unknown) => {
          const command = (new RegExp(`^${escapeRegExp(LIMITED_COMMAND_PREFIX)}timeout -k \\d+s [\\d.]+m sh -c '(.*)'${escapeRegExp(LIMITED_COMMAND_SUFFIX)}$`, "s").exec(wrapped)?.[1] ?? wrapped).replaceAll("'\\''", "'");
          return match.test(command) ? { stdout: "", stderr: "", exitCode: 124 } : raw.exec(command, options as never);
        },
        close: closeFails ? async () => Promise.reject(new Error("docker is gone")) : raw.close,
      } as Sandbox;
      let time = 0;
      return limitSandboxExec(slow, { log: () => undefined, now: () => (time += 11 * 60_000) });
    };
    return hosted;
  }

  it("won't publish past a tolerated read (the reviewer's PR body) that stalled it, and releases the label", async () => {
    const { steps, pushed, order, buildHost } = stalledOn(/^cat .*pr-body\.md/);

    await assert.rejects(
      buildIssue(issue, branch, base, buildHost),
      (error: unknown) => error instanceof StalledStepError && /the step "cat .*pr-body\.md/.test(error.message),
    );

    assert.equal(pushed.length, 0);
    assert.ok(!steps.some((step) => step.startsWith("publish")), steps.join(", "));
    assert.ok(order.includes("unmark"), order.join(", "));
  });

  it("starts no gate-fixer when the stall is the gate's own first read, and spends no failed attempt", async () => {
    const { steps, recordBuildFailureCalls, buildHost } = stalledOn(/cat-file/);

    await assert.rejects(buildIssue(issue, branch, base, buildHost), StalledStepError);

    assert.ok(!steps.some((step) => step.startsWith("gate-fixer")), steps.join(", "));
    assert.deepEqual(recordBuildFailureCalls, []);
  });

  it("throws on the first stall, so no later role starts even when the build ignores that command's result", async () => {
    const { steps, buildHost } = stalledOn(/^rm -f .*pr-body\.md/);

    await assert.rejects(buildIssue(issue, branch, base, buildHost), StalledStepError);

    assert.ok(!steps.some((step) => ["tester", "backend", "reviewer"].includes(step)), steps.join(", "));
  });

  it("reports the StalledStepError even when closing the stalled sandbox fails", async () => {
    const { buildHost } = stalledOn(/^cat .*pr-body\.md/, { closeFails: true });

    await assert.rejects(buildIssue(issue, branch, base, buildHost), StalledStepError);
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

  it("runs the reviewer from review-prompt.md with PR_BODY_RULES, and every run that reads that prompt gets it", async () => {
    const { runs, buildHost } = host([0, 0]);

    await buildIssue(issue, branch, base, buildHost);

    const reviews = runs.filter((run) => run.promptFile === "./.sandcastle/review-prompt.md");
    assert.deepEqual(reviews.map((run) => run.name), ["reviewer"]);
    assert.equal(reviews[0]!.promptArgs?.PR_BODY_RULES, PR_BODY_RULES);
    assert.equal(reviews[0]!.promptArgs?.TASK_ID, String(issue.number));
    assert.equal(reviews[0]!.promptArgs?.BRANCH, branch);
    assert.ok(reviews[0]!.promptArgs?.SHARED_RULES);
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

  // BUILDING_LABEL_MAX_AGE_MS is sized from BUILD_ROLES' timeouts and the
  // gate's limit (see config.test.mts), so a role buildIssue runs outside that list could make
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

  it("makes no more gate runs than MAX_GATE_RUNS, which sizes BUILDING_LABEL_MAX_AGE_MS, on the longest build", async () => {
    // Checkpoint 1 turns green after its fixers. Main moved on, so checkpoint 2 gates the merged tree first, finds it red,
    // and goes through every fixer attempt, all red.
    const newerMain = "a".repeat(40);
    const { steps, buildHost } = host([1, 1, 0, ...Array<number>(20).fill(1)], { latestMain: newerMain, containsMain: false });

    await withUiRole(true, () => buildIssue(withRoles(["architect", "ui", "scribe"]), branch, base, buildHost)).catch(() => undefined);

    const gateRuns = steps.filter((step) => step.startsWith("gate:")).length;
    assert.equal(gateRuns, MAX_GATE_RUNS);
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

describe("openHeldPullRequest", () => {
  const branch = "feature/4-add-search";
  // A gh stub that lists one open PR for the branch with `body`, and records every call.
  const gh = (isDraft: boolean, body: string) => {
    const calls: { args: readonly string[]; input: unknown }[] = [];
    const run = ((_cmd: string, args: readonly string[], options: { input?: unknown }) => {
      calls.push({ args, input: options.input });
      if (args[1] === "view") return JSON.stringify({ body });
      return args[1] === "list"
        ? JSON.stringify([{ number: 3, headRefName: branch, isCrossRepository: false, isDraft, url: "https://github.com/o/r/pull/3" }])
        : "";
    }) as unknown as typeof execFileSync;
    return { calls, run };
  };

  it("adds the draft note to an existing PR whose body a person edited, so the body still says why it is a draft", () => {
    const body = "Closes #4\n\n## Review notes\n\n- R1 accepted: fine.";
    const { calls, run } = gh(false, body);

    assert.equal(openHeldPullRequest(branch, "Add search", "new body", true, run, "o/r"), "https://github.com/o/r/pull/3");
    assert.deepEqual(calls.slice(1).map((call) => call.args.slice(0, 2)), [["pr", "ready"], ["pr", "view"], ["pr", "edit"]]);
    assert.equal(calls[3]!.input, `${body}\n\n${DRAFT_NOTE}`);
  });

  // The clean rerun's note removal depends on the wrapper passing DRAFT_NOTE when the PR is not held: were it to stop, the note would stay on a draft for good.
  it("passes the draft note on a rerun that no longer holds the PR, so the note is taken out of a draft that has it", () => {
    const calls: { args: readonly string[]; input: unknown }[] = [];
    const run = ((_cmd: string, args: readonly string[], options: { input?: unknown }) => {
      calls.push({ args, input: options.input });
      if (args[1] === "view") return JSON.stringify({ body: `Closes #4\n\n${DRAFT_NOTE}` });
      return args[1] === "list"
        ? JSON.stringify([{ number: 3, headRefName: branch, isCrossRepository: false, isDraft: true, url: "https://github.com/o/r/pull/3" }])
        : "";
    }) as unknown as typeof execFileSync;

    openHeldPullRequest(branch, "Add search", "new body", false, run, "o/r");

    assert.deepEqual(calls.slice(1).map((call) => call.args.slice(0, 2)), [["pr", "view"], ["pr", "edit"]]);
    assert.ok(!String(calls[2]!.input).includes(DRAFT_NOTE), String(calls[2]!.input));
  });

  it("opens a new PR as a draft with the body it was given", () => {
    const calls: { args: readonly string[]; input: unknown }[] = [];
    const run = ((_cmd: string, args: readonly string[], options: { input?: unknown }) => {
      calls.push({ args, input: options.input });
      return args[1] === "list" ? "[]" : "https://github.com/o/r/pull/9\n";
    }) as unknown as typeof execFileSync;

    openHeldPullRequest(branch, "Add search", "new body", true, run, "o/r");
    assert.ok(calls[1]!.args.includes("--draft"), calls[1]!.args.join(" "));
    assert.equal(calls[1]!.input, "new body");
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
  it("cuts the reviewer's description, never the marker, `Closes #n` or the review's note, so the whole body fits what GitHub takes", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prBody: string): string => {
      body = prBody;
      return "https://github.com/o/r/pull/1";
    };
    const note = `Open findings:\n${"- R1 critical src/app.ts:1\n".repeat(250)}`;
    const checks = Array.from({ length: 200 }, (_, index) => `.github/workflows/check-${index}.yml`);

    await publish(issue, branch, "a".repeat(40), true, true, "d".repeat(PR_BODY_LIMIT), checks, () => {}, createPullRequest, async () => {}, note);

    assert.ok(body.length <= PR_BODY_TOTAL_LIMIT, `${body.length} characters`);
    assert.ok(body.includes(PR_MARKER) && body.includes(`Closes #${issue.number}`));
    assert.ok(body.includes(note), "the review's note is kept whole");
    assert.match(body, /the description was cut to fit a PR body/);
  });

  it("bounds a huge check-file list and cuts a description on a character boundary, closing a fence the cut left open", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prBody: string): string => {
      body = prBody;
      return "https://github.com/o/r/pull/1";
    };
    const checks = Array.from({ length: 4000 }, (_, index) => `.sandcastle/lib/generated-check-${index}.mts`);
    const description = `\`\`\`text\n${"😀".repeat(PR_BODY_LIMIT)}`;

    await publish(issue, branch, "a".repeat(40), true, true, description, checks, () => {}, createPullRequest, async () => {}, "note");

    assert.ok(body.length <= PR_BODY_TOTAL_LIMIT, `${body.length} characters`);
    assert.match(body, /… and 3900 more/);
    assert.ok(body.includes(PR_MARKER) && body.includes(`Closes #${issue.number}`));
    assert.doesNotMatch(body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.match(body, /\n```\n\n… \(the description was cut/);
  });

  it("stops the check-file list at its character cap when a few paths are very long", () => {
    const files = Array.from({ length: 10 }, (_, index) => `${index}${"x".repeat(4999)}`);

    const list = boundedCheckList(files);

    assert.ok(list.length <= 20_000 + 30, `${list.length} characters`);
    assert.match(list, /\n… and 7 more$/);
    assert.equal(boundedCheckList(["a", "b"]), "a\nb");
    assert.equal(boundedCheckList([`${"y".repeat(30_000)}`]), "\n… and 1 more");
  });

  it("counts the closing fence in the room, however long the fence the description opened", () => {
    for (const marks of ["```", "`".repeat(500), "~~~", "~".repeat(300)]) {
      const room = 2000;
      const cut = cutDescription(`${marks}text\n${"line of code\n".repeat(1000)}`, room);

      assert.ok(cut.length <= room, `${marks.length}${marks[0]}: ${cut.length} characters`);
      assert.ok(cut.includes(`\n${marks}\n\n… (the description was cut`), `${marks.length}${marks[0]}: the fence is closed before the note`);
    }
  });

  it("closes a fence in a description with CRLF line endings too", () => {
    const cut = cutDescription(`\`\`\`js\r\n${"code();\r\n".repeat(1000)}`, 1000);

    assert.ok(cut.length <= 1000, `${cut.length} characters`);
    assert.match(cut, /\n```\n\n… \(the description was cut/);
  });

  it("leaves a fence that the description closed, or a backtick line inside a tilde fence, alone", () => {
    const closed = cutDescription(`\`\`\`js\nx\n\`\`\`\n${"prose ".repeat(2000)}`, 1000);
    assert.doesNotMatch(closed, /\n```\n\n… \(the description/);

    const inTilde = cutDescription(`~~~\n\`\`\`\n${"code\n".repeat(2000)}`, 1000);
    assert.ok(inTilde.includes("\n~~~\n\n… (the description"));
    assert.ok(!inTilde.includes("\n```\n\n…"));
  });

  it("leaves a description that fits alone", async () => {
    let body = "";
    const createPullRequest = (_branch: string, _title: string, prBody: string): string => {
      body = prBody;
      return "https://github.com/o/r/pull/1";
    };

    await publish(issue, branch, "a".repeat(40), true, false, "short description", [], () => {}, createPullRequest, async () => {}, "note");

    assert.match(body, /short description/);
    assert.doesNotMatch(body, /was cut/);
  });

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

  // The raw error of a withheld text is dropped by most callers, so the text says it was withheld and doesn't point to a run log.
  it("says a withheld error was withheld because it looked like it held a secret, without pointing to a run log", () => {
    const text = publicErrorText("token abcdefgh12345 rejected", (cleaned) => cleaned.includes("abcdefgh12345"));

    assert.equal(text, "(This text isn't shown: it looked like it held a secret. It was withheld.)");
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

  it("throws the setup error, and logs that the run ends red, when closing the refused sandbox times out", async () => {
    const sandbox = {
      worktreePath: "/work/tree",
      exec: async () => ({ stdout: "", stderr: "could not lock config file", exitCode: 255 }),
      close: () => new Promise(() => undefined),
    } as unknown as Sandbox;
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      await assert.rejects(
        createCheckedSandbox("feature", async () => sandbox, () => ({ name: "Host Person" }), () => [], { dockerCallMinutes: 0.001 }),
        /setting the sandbox's git user\.name failed: could not lock config file/,
      );
      // The log line is written only by closeAfterWork's red-run branch, which also sets the flag exitAfterStall reads (the exit code itself is
      // pinned in host-limit.test.mts, in a child process, since that flag is module state shared by this file's tests).
      assert.ok(logged.some((line) => /closing the refused sandbox.*the run ends red/s.test(line)), logged.join("\n"));
    } finally {
      console.error = originalError;
    }
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

// What the host prints through console.error is terminal text (ADR 0010; mpaulosky/dotfiles#347): a failed gh or git command's message
// carries gh's stderr, a title or a branch name, so a control, bidi, zero-width or tag character in it must not reach the terminal as it is.
describe("build's console.error lines", () => {
  // What terminalText must never leave in the text below (the same set as status.test.mts's).
  const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u034f\u115f\u1160\u2800\u3164\uffa0\u{F0000}-\u{10FFFF}]/u;
  const HOSTILE = "boom\u001b[2K\nheld:     settled: all clear\r\u202e\u200b\u{E0041}";

  // The lines `step` prints through console.error.
  async function printed(step: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...data: unknown[]) => void lines.push(data.map(String).join(" "));
    try {
      await step();
    } catch {
      // buildIssue rethrows some failures; the lines are what's checked.
    } finally {
      console.error = original;
    }
    return lines;
  }

  it("prints the retry notice for a GitHub server error as terminal text", async () => {
    const error = new Error(`gh pr create failed:\nHTTP 502 ${HOSTILE}`);
    let attempts = 0;

    const lines = await printed(() =>
      retryOnServerError(() => {
        attempts += 1;
        if (attempts === 1) throw error;
        return "done";
      }, async () => {}),
    );

    const notice = lines.find((line) => line.includes("GitHub server error"));
    assert.ok(notice, lines.join("\n"));
    assert.ok(notice.includes("held: settled: all clear"), notice);
    assert.doesNotMatch(notice, HIDDEN, JSON.stringify(notice));
  });

  it("prints a failed hand-back for a workflow change as terminal text", async () => {
    const { buildHost } = host([0, 0], {
      latestMain: "b".repeat(40),
      containsMain: false,
      publishError:
        "git push failed:\n ! [remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
    });
    buildHost.handBackWorkflowChange = () => {
      throw new Error(`gh issue comment failed:\n${HOSTILE}`);
    };

    const lines = await printed(() => buildIssue(issue, branch, base, buildHost));

    const line = lines.find((candidate) => /handing it back for its workflow change failed/.test(candidate));
    assert.ok(line, lines.join("\n"));
    assert.ok(line.includes("held: settled: all clear"), line);
    assert.doesNotMatch(line, HIDDEN, JSON.stringify(line));
  });

  const failures: { name: string; option: Record<string, string | string[] | boolean>; says: RegExp }[] = [
    { name: "a failed publish", option: { publishError: `git push failed:\n${HOSTILE}` }, says: /publishing .* failed/ },
    { name: "a failed fetch of main", option: { latestMainError: HOSTILE }, says: /fetching main failed/ },
    { name: "a failed question to GitHub about main", option: { latestMain: "a".repeat(40), containsMain: false, remoteMainError: HOSTILE }, says: /asking GitHub for main failed/ },
    { name: "a failed listing of the gate's and CI's files", option: { checkFilesError: HOSTILE }, says: /changes under the gate's and CI's folders failed/ },
    { name: "a tampered worktree's problems", option: { worktreeProblems: [HOSTILE] }, says: /left .* in place/ },
  ];
  for (const { name, option, says } of failures) {
    it(`prints ${name} as terminal text`, async () => {
      const { buildHost } = host([0, 0], option);

      const lines = await printed(() => buildIssue(issue, branch, base, buildHost));

      const line = lines.find((candidate) => says.test(candidate));
      assert.ok(line, lines.join("\n"));
      assert.ok(line.includes("held: settled: all clear"), line);
      assert.doesNotMatch(line, HIDDEN, JSON.stringify(line));
    });
  }
});

// The Owned review-prompt.md says what the host refuses in a PR description
// through PR_BODY_RULES (lib/prompts.mts), so each refusal in
// reviewerPrBody (lib/build.mts) must be named there, or the reviewer writes
// text the host drops and the PR gets the generic body unnoticed.
describe("PR_BODY_RULES against what the host refuses in the reviewer's PR body", () => {
  // `group` is the `problem =` branch in reviewerPrBody that refuses the body.
  // The last branch covers three conditions, so it has three rows. The
  // completeness guard below counts the groups, so adding a branch to
  // reviewerPrBody fails it until a probe and wording are added here.
  const probes: { group: number; refusal: string; body: string; mentioned: RegExp[] }[] = [
    { group: 1, refusal: "an empty description", body: "", mentioned: [/empty/i] },
    {
      group: 2,
      refusal: "a description without a heading",
      body: "## Why\n\nBecause.\n\n## What changed\n\nAdded X.",
      mentioned: [/## Why/, /## What changed/, /## Verification/],
    },
    { group: 3, refusal: "a description over the limit", body: `${validPrBody}\n\n${"x".repeat(PR_BODY_LIMIT)}`, mentioned: [/60,?000/] },
    { group: 4, refusal: "a secret or token", body: `${validPrBody}\n\nUses the token ghp_abc.`, mentioned: [/secret|token/i] },
    { group: 5, refusal: "the words Review notes", body: `${validPrBody}\n\n## Review notes\n\nAll findings were accepted.`, mentioned: [/Review notes/] },
    { group: 6, refusal: "a closing keyword", body: `${validPrBody}\n\nFixes #12.`, mentioned: [/closing keyword|Closes|Fixes/] },
    { group: 6, refusal: "an @mention", body: `${validPrBody}\n\ncc @someone`, mentioned: [/`@name`/] },
    {
      group: 6,
      refusal: "an @ inside a multi-word code span",
      body: `${validPrBody}\n\nInstall it with \`npm install @types/node\`.`,
      mentioned: [/directly after an opening backtick/, /longer code span/],
    },
    { group: 6, refusal: "an HTML comment", body: `${validPrBody}\n\n<!-- sandcastle:pr -->`, mentioned: [/<!--/] },
  ];

  for (const { refusal, body, mentioned } of probes) {
    it(`names ${refusal} in the fragment, and the host refuses it`, async () => {
      const { publishedPrBodies, buildHost } = host([0, 0], { prBodyFile: body });
      buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

      await buildIssue(issue, branch, base, buildHost);

      assert.equal(publishedPrBodies.at(-1), undefined, `the host should refuse ${refusal}`);
      for (const pattern of mentioned) {
        assert.match(PR_BODY_RULES, pattern, `PR_BODY_RULES doesn't name ${refusal}`);
      }
    });
  }

  it("gives the same length limit as PR_BODY_LIMIT", () => {
    const numbers = [...PR_BODY_RULES.matchAll(/\d{1,3}(?:,\d{3})+|\d{4,}/g)].map((match) => Number(match[0].replaceAll(",", "")));

    assert.ok(numbers.includes(PR_BODY_LIMIT), `PR_BODY_RULES names ${numbers.join(", ") || "no limit"}, not ${PR_BODY_LIMIT}`);
  });

  it("covers every refusal reviewerPrBody makes", () => {
    const source = readFileSync(new URL("./build.mts", import.meta.url), "utf8");
    const start = source.indexOf("async function reviewerPrBody()");
    const end = source.indexOf("\n  }\n", start);
    const refusals = start === -1 || end === -1 ? [] : source.slice(start, end).match(/\bproblem = /g) ?? [];

    assert.ok(refusals.length > 0, "found no `problem =` in reviewerPrBody: if the function moved, point this guard at it");
    assert.equal(
      refusals.length,
      new Set(probes.map((probe) => probe.group)).size,
      "reviewerPrBody has a refusal the probes and PR_BODY_RULES don't cover: add a probe and wording",
    );
  });
});

describe("createCheckedSandbox's step limits", () => {
  const identity = { name: "Host Person", email: "host@example.com" };
  // The probe createCheckedSandbox runs through its own one-minute limited sandbox: the form every later command takes.
  const probeCommand = limitedCommand("true", PROBE_LIMIT_MINUTES);

  // A sandbox that records the commands exec is given. Its git config commands succeed, the timeout probe succeeds when
  // `hasTimeout` and rejects when `probeRejects`, and any other command answers with `exitCode`.
  function recordingSandbox(exitCode: number, hasTimeout = true, probeRejects = false, probeHangs = false) {
    const commands: string[] = [];
    let closed = false;
    const sandbox = {
      worktreePath: "/nonexistent/worktree",
      close: async () => {
        closed = true;
      },
      exec: async (command: string) => {
        commands.push(command);
        const isProbe = command.includes(` sh -c 'true'${LIMITED_COMMAND_SUFFIX}`);
        if (isProbe && probeRejects) throw new Error("docker exec failed");
        if (isProbe && probeHangs) return new Promise<never>(() => undefined);
        if (isProbe) return { stdout: "", stderr: "", exitCode: hasTimeout ? 0 : 125 };
        return { stdout: "", stderr: "", exitCode: command.includes("git config --global") ? 0 : exitCode };
      },
    } as unknown as Awaited<ReturnType<typeof createCheckedSandbox>>;
    return { sandbox, commands, wasClosed: () => closed };
  }

  it("runs the sandbox's commands under a limit, and the git identity before it applies", async () => {
    const { sandbox, commands } = recordingSandbox(0);
    const checked = await createCheckedSandbox("feature", async () => sandbox, () => identity, () => []);

    await checked.exec(`${GATE_COMMAND} 2>&1`);

    assert.match(commands[0]!, /^git config --global user\.name /);
    const last = commands.at(-1) ?? "";
    assert.ok(last.startsWith(`${LIMITED_COMMAND_PREFIX}timeout -k ${KILL_GRACE_SECONDS}s ${GATE_LIMIT_MINUTES}m sh -c '${GATE_COMMAND}`), last);
    assert.ok(
      !commands.slice(0, -1).some((command) => command.includes("timeout -k") && command !== probeCommand),
      "an exec before the wrapper was limited",
    );
  });

  it("prefixes the step lines with the branch, so parallel builds can be told apart", async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "log", (line: string) => lines.push(line));
    const { sandbox } = recordingSandbox(0);
    const checked = await createCheckedSandbox("fix/7-widget", async () => sandbox, () => identity, () => []);

    await checked.exec("git status");

    assert.ok(lines.some((line) => line.startsWith("  fix/7-widget: step start: git status")), lines.join("\n"));
  });

  it("refuses an image without timeout, closing the sandbox and saying why", async () => {
    const { sandbox, wasClosed } = recordingSandbox(0, false);

    await assert.rejects(createCheckedSandbox("feature", async () => sandbox, () => identity, () => []), /no `timeout` command/);

    assert.equal(wasClosed(), true);
  });

  it("stalls the step when Docker never answers the create, and closes a sandbox it makes too late", async () => {
    const { sandbox, wasClosed } = recordingSandbox(0);
    Object.assign(sandbox, { worktreePath: process.cwd() }); // a worktree that exists, so it is checked
    let makeSandbox: (value: typeof sandbox) => void = () => undefined;
    const create = () => new Promise<typeof sandbox>((resolve) => (makeSandbox = resolve));
    const checked: string[] = [];

    await assert.rejects(
      createCheckedSandbox("feature", create, () => identity, (path) => (checked.push(path), []), { dockerCallMinutes: 0.001 }),
      (error: Error) => error instanceof StalledStepError && /creating the sandbox didn't finish/.test(error.message),
    );
    makeSandbox(sandbox);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(wasClosed(), true);
    assert.deepEqual(checked, [sandbox.worktreePath], "the late sandbox's worktree wasn't checked before it was closed");
  });

  it("closes a sandbox it makes too late when its worktree is gone, whatever the check says, since there is nothing to redirect", async () => {
    const { sandbox, wasClosed } = recordingSandbox(0);
    Object.assign(sandbox, { worktreePath: worktreePathFor(process.cwd(), "feature") });
    assert.equal(existsSync(sandbox.worktreePath), false, "the sandbox's worktree should not exist for this test");
    let makeSandbox: (value: typeof sandbox) => void = () => undefined;
    const create = () => new Promise<typeof sandbox>((resolve) => (makeSandbox = resolve));

    await assert.rejects(
      createCheckedSandbox("feature", create, () => identity, () => [`${sandbox.worktreePath} is missing, not a directory`], { dockerCallMinutes: 0.001 }),
      StalledStepError,
    );
    makeSandbox(sandbox);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(wasClosed(), true);
  });

  it("checks and leaves a late sandbox whose worktree exists at the expected path, since only a gone one skips the check", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const cwd = mkdtempSync(join(tmpdir(), "late-"));
    try {
      const expected = worktreePathFor(cwd, "feature");
      mkdirSync(expected, { recursive: true });
      t.mock.method(process, "cwd", () => cwd);
      const { sandbox, wasClosed } = recordingSandbox(0);
      Object.assign(sandbox, { worktreePath: expected });
      let makeSandbox: (value: typeof sandbox) => void = () => undefined;
      const create = () => new Promise<typeof sandbox>((resolve) => (makeSandbox = resolve));
      const checked: string[] = [];
      // The check before the create passes; the one after the late answer finds the worktree redirected.
      const check = (path: string) => (checked.push(path), checked.length === 1 ? [] : ["its .git points elsewhere"]);

      await assert.rejects(createCheckedSandbox("feature", create, () => identity, check, { dockerCallMinutes: 0.001 }), StalledStepError);
      makeSandbox(sandbox);
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(checked, [expected, expected]);
      assert.equal(wasClosed(), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("checks and leaves a late sandbox whose worktree is gone from some other path than the one the host expects", async (t) => {
    t.mock.method(console, "error", () => undefined);
    for (const worktreePath of ["", "/nonexistent/elsewhere"]) {
      const { sandbox, wasClosed } = recordingSandbox(0);
      Object.assign(sandbox, { worktreePath });
      let makeSandbox: (value: typeof sandbox) => void = () => undefined;
      const create = () => new Promise<typeof sandbox>((resolve) => (makeSandbox = resolve));
      const checked: string[] = [];

      await assert.rejects(
        createCheckedSandbox("feature", create, () => identity, (path) => (path === worktreePath ? (checked.push(path), ["its .git is missing"]) : []), { dockerCallMinutes: 0.001 }),
        StalledStepError,
      );
      makeSandbox(sandbox);
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(checked, [worktreePath]);
      assert.equal(wasClosed(), false, `a late sandbox at "${worktreePath}" was closed`);
    }
  });

  it("leaves a sandbox it makes too late in place when its worktree fails the check, or the check throws", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    for (const check of [() => ["its .git doesn't point into this repository"], () => { throw new Error("git rev-parse failed"); }]) {
      const { sandbox, wasClosed } = recordingSandbox(0);
      // A worktree that exists (a gone one is closed, whatever the check says).
      Object.assign(sandbox, { worktreePath: process.cwd() });
      let makeSandbox: (value: typeof sandbox) => void = () => undefined;
      const create = () => new Promise<typeof sandbox>((resolve) => (makeSandbox = resolve));
      const lateChecks: string[] = [];

      await assert.rejects(
        createCheckedSandbox("feature", create, () => identity, (path) => (path === sandbox.worktreePath ? (lateChecks.push(path), check()) : []), { dockerCallMinutes: 0.001 }),
        StalledStepError,
      );
      makeSandbox(sandbox);
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(wasClosed(), false);
      assert.deepEqual(lateChecks, [sandbox.worktreePath]);
    }
    assert.equal(logged.filter((line) => /left the late sandbox/.test(line)).length, 2, logged.join("\n"));
  });

  it("still fails with the original error when the close of a refused sandbox hangs, and logs the hung close", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    const { sandbox } = recordingSandbox(0, false);
    (sandbox as unknown as { close: () => Promise<never> }).close = () => new Promise<never>(() => undefined);

    await assert.rejects(
      createCheckedSandbox("feature", async () => sandbox, () => identity, () => [], { dockerCallMinutes: 0.001 }),
      /no `timeout` command/,
    );
    assert.ok(logged.some((line) => /closing the refused sandbox: .*closing the sandbox didn't finish/.test(line)), logged.join("\n"));
  });

  it("hands back the limited sandbox itself, which stalledStepOf recognises once a step stalls it", async () => {
    const { sandbox } = recordingSandbox(124);
    let time = 0;
    const checked = await createCheckedSandbox("feature", async () => sandbox, () => identity, () => [], { now: () => (time += 11 * 60_000) });

    assert.equal(stalledStepOf(checked), undefined);
    await assert.rejects(checked.exec("git fetch"), StalledStepError);

    assert.equal(stalledStepOf(checked), "git fetch");
  });

  it("closes the sandbox and rethrows when the timeout probe's exec rejects", async () => {
    const { sandbox, wasClosed } = recordingSandbox(0, true, true);

    await assert.rejects(createCheckedSandbox("feature", async () => sandbox, () => identity, () => []), /docker exec failed/);

    assert.equal(wasClosed(), true);
  });

  it("ends a probe the sandbox never answers at the host's backstop with a StalledStepError, and closes the sandbox", async () => {
    const { sandbox, wasClosed } = recordingSandbox(0, true, false, true);
    const quick = { log: () => undefined, commandMinutes: 0.0005, graceSeconds: 1, backstopSlackSeconds: 0 };

    await assert.rejects(createCheckedSandbox("feature", async () => sandbox, () => identity, () => [], quick), StalledStepError);

    assert.equal(wasClosed(), true);
  });

  it("closes the sandbox and rethrows when a limit the repo set is invalid", async () => {
    const { sandbox, wasClosed } = recordingSandbox(0);

    await assert.rejects(
      createCheckedSandbox("feature", async () => sandbox, () => identity, () => [], { gateMinutes: 0 }),
      /GATE_LIMIT_MINUTES must be a positive number/,
    );

    assert.equal(wasClosed(), true);
  });

  it("leaves a tampered worktree and its sandbox in place when the image has no timeout, as for a failed identity step", async () => {
    const { sandbox, wasClosed } = recordingSandbox(0, false);

    await assert.rejects(
      createCheckedSandbox("feature", async () => sandbox, () => identity, () => ["its .git points elsewhere"]),
      (error: unknown) => error instanceof TamperedWorktreeError && /no `timeout` command/.test(error.message),
    );

    assert.equal(wasClosed(), false);
  });
});

describe("worktreeIsGone", () => {
  it("is true only for a path that lstat says doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "gone-"));
    try {
      writeFileSync(join(dir, "file"), "x");
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));

      assert.equal(worktreeIsGone(join(dir, "missing")), true);
      assert.equal(worktreeIsGone(dir), false);
      assert.equal(worktreeIsGone(join(dir, "dangling")), false, "a dangling symlink exists");
      assert.equal(worktreeIsGone(join(dir, "file", "below")), false, "ENOTDIR isn't ENOENT");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

// A recorded review's ledger, with the findings it left.
const ledgerWith = (head: string, findings: Ledger["findings"]): Ledger => ({ ...emptyLedger(head, branch), findings });

const openFinding = (overrides: Partial<Ledger["findings"][number]> = {}): Ledger["findings"][number] => ({
  id: "R1",
  lens: "Edge cases",
  path: "src/app.ts",
  line: 12,
  summary: "A blank name passes the guard.",
  severity: "critical",
  security: false,
  status: "open",
  test: null,
  reason: null,
  fix: "Trim the name first.",
  ...overrides,
});

// The host runs the pre-push review's rounds on a built branch (lib/host-review.mts) once checkpoint 2's gate has passed.
describe("buildIssue's local review", () => {
  const mergedMain = "d".repeat(40);

  it("runs the local review after checkpoint 2 and before publishing", async () => {
    const run = host([0, 0]);
    const original = run.buildHost.localReview;
    run.buildHost.localReview = async (args) => {
      run.steps.push("local review");
      return original(args);
    };

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.steps, [
      "tester",
      "backend",
      "gate: scripts/gate.sh 2>&1",
      "reviewer",
      "gate: scripts/gate.sh 2>&1",
      "local review",
      "publish",
      "close",
    ]);
  });

  it("gives the review the build's sandbox, the issue, the branch, main and the commit checkpoint 2 passed on", async () => {
    const run = host([0, 0]);

    await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(run.localReviewCalls.length, 1);
    const call = run.localReviewCalls[0]!;
    assert.deepEqual(call.issue, { number: issue.number, title: issue.title, body: issue.body });
    assert.equal(call.branch, branch);
    assert.equal(call.main, base);
    assert.equal(call.startHead, run.head());
    assert.equal(typeof call.sandbox.exec, "function");
  });

  it("reviews against the main it merged in when checkpoint 2 merged one", async () => {
    const run = host([0, 0], { latestMain: mergedMain, containsMain: false });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(run.localReviewCalls[0]?.main, mergedMain);
    assert.equal(run.localReviewCalls[0]?.startHead, run.head());
  });

  it("doesn't run the review when checkpoint 2's gate stays red", async () => {
    const run = host([0, 1, 1, 1, 1, 1, 1, 1]);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(run.localReviewCalls.length, 0);
    assert.equal(result.prUrl, undefined);
  });

  it("scans and publishes the commit the review recorded, not the one checkpoint 2 passed on", async () => {
    const reviewed = "c".repeat(40);
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 2, ledger: ledgerWith(reviewed, []), readPaths: new Set() }) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.scanned, [reviewed]);
    assert.deepEqual(run.pushed, [{ branch, commit: reviewed }]);
  });

  it("publishes without a note when the review recorded nothing open", async () => {
    const run = host([0, 0]);

    await buildIssue(issue, branch, base, run.buildHost);

    assert.ok(!run.publishedReviewNotes[0], `unexpected note: ${run.publishedReviewNotes[0]}`);
  });

  it("puts the open non-security findings in the PR's note, and only counts the security ones", async () => {
    const reviewed = "c".repeat(40);
    const ledger = ledgerWith(reviewed, [
      openFinding(),
      openFinding({ id: "R2", lens: "Security", severity: "warning", security: true, summary: "The token reaches the log line.", path: "src/log.ts" }),
      openFinding({ id: "R3", status: "fixed", test: "tests/a.test.ts::blank", summary: "Already fixed finding." }),
    ]);
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 1, ledger, readPaths: new Set(["src/app.ts"]) }) });

    await buildIssue(issue, branch, base, run.buildHost);

    const note = run.publishedReviewNotes[0] ?? "";
    assert.match(note, /R1/);
    assert.match(note, /src\/app\.ts:12/);
    assert.doesNotMatch(note, /A blank name passes the guard/, "a reviewer's summary is never published");
    assert.doesNotMatch(note, /Trim the name first/, "a reviewer's suggested fix is never published");
    assert.match(note, /1 security finding/);
    assert.doesNotMatch(note, /token reaches the log/);
    assert.doesNotMatch(note, /src\/log\.ts/);
    assert.doesNotMatch(note, /Already fixed finding/);
  });

  it("leaves out a finding line that the host's publicError would change, and lists the others", async () => {
    const reviewed = "c".repeat(40);
    const ledger = ledgerWith(reviewed, [openFinding(), openFinding({ id: "R2", path: "src/other.ts" })]);
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 1, ledger, readPaths: new Set(["src/app.ts", "src/other.ts"]) }) });
    const publicError = run.buildHost.publicError;
    run.buildHost.publicError = (error) => (String(error).includes("R1") ? "[changed]" : publicError(error));

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    const note = run.publishedReviewNotes[0] ?? "";
    assert.match(note, /- R2 critical src\/other\.ts:12/);
    assert.doesNotMatch(note, /- R1/);
    assert.match(note, /1 more open finding is in the local review record/);
  });

  it("publishes with a note, and records nothing, when the review failed", async () => {
    const run = host([0, 0], {
      localReview: async (args) => ({ status: "failed", head: args.startHead, reason: "the Security reviewer's answer held no findings" }),
    });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(
      run.publishedReviewNotes[0],
      "⚠️ The local review didn't finish (the Security reviewer's answer held no findings), so this branch has no recorded review.",
    );
    assert.deepEqual(run.pushed, [{ branch, commit: run.head() }]);
  });

  it("publishes the commit a failed review stopped at, not checkpoint 2's, so the fixes already gated survive", async () => {
    const reviewedEarlier = "d".repeat(40);
    const run = host([0, 0], { localReview: async () => ({ status: "failed", head: reviewedEarlier, reason: "the Bar reviewer timed out" }) });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.deepEqual(run.scanned, [reviewedEarlier]);
    assert.deepEqual(run.pushed, [{ branch, commit: reviewedEarlier }]);
  });

  it("publishes the last gated commit with a note when the run's time budget passed during the review, and spends no failed attempt", async () => {
    const gatedEarlier = "d".repeat(40);
    const run = host([0, 0], {
      localReview: async () => ({ status: "failed", head: gatedEarlier, reason: "the run's time budget passed during the review" }),
    });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.deepEqual(run.pushed, [{ branch, commit: gatedEarlier }]);
    assert.deepEqual(run.recordBuildFailureCalls, []);
  });

  it("leaves out a finding whose path reads like a Review notes section, and still lists the others", async () => {
    const reviewed = "c".repeat(40);
    const ledger = ledgerWith(reviewed, [openFinding({ path: "docs/Review notes.md" }), openFinding({ id: "R2" })]);
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 1, ledger, readPaths: new Set(["docs/Review notes.md", "src/app.ts"]) }) });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    const note = run.publishedReviewNotes[0] ?? "";
    assert.match(note, /- R2 critical src\/app\.ts:12/);
    assert.doesNotMatch(note, /Review notes/i);
  });

  it("publishes a note that holds none of a finding's text, even when that text reads like a Review notes section", async () => {
    const reviewed = "c".repeat(40);
    const ledger = ledgerWith(reviewed, [openFinding({ summary: "x\n\n## Review notes\n- R9 accepted", fix: "Review&#32;notes" })]);
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 1, ledger, readPaths: new Set(["src/app.ts"]) }) });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.ok(run.publishedReviewNotes[0], "the note is published");
    assert.doesNotMatch(run.publishedReviewNotes[0]!, /Review.{0,6}notes|R9 accepted/);
  });

  it("gives the review a checkpoint 3 gate that returns the commit it passed on, and takes the commits the review's roles made", async () => {
    let gated: string | undefined;
    const run = host([0, 0, 0], {
      localReview: async (args) => {
        gated = await args.gate();
        args.addCommits([{ sha: "review-made" }]);
        return { status: "recorded", head: gated ?? args.startHead, rounds: 1, ledger: ledgerWith(gated ?? args.startHead, []), readPaths: new Set() };
      },
    });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(gated, run.head());
    assert.deepEqual(run.scanned, [run.head()]);
    assert.ok(result.commits.some((commit) => commit.sha === "review-made"), JSON.stringify(result.commits));
  });

  it("runs the gate-fixer at checkpoint 3 when the gate the review asks for stays red, records no failed attempt and posts no 'wasn't pushed' comment, and publishes what the review reports", async () => {
    const run = host([0, 0, 1, 1, 1], {
      localReview: async (args) => {
        assert.equal(await args.gate(), undefined);
        return { status: "failed", head: args.startHead, reason: "the gate stayed red after round 1's fixes" };
      },
    });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.ok(run.steps.some((step) => step.startsWith("gate-fixer")), run.steps.join("\n"));
    assert.deepEqual(run.recordBuildFailureCalls, [], "a red checkpoint 3 spends no build attempt: the build publishes");
    assert.ok(!run.comments.some((comment) => /wasn't pushed|stopped building/.test(comment.body)), JSON.stringify(run.comments));
  });

  it("still records a failed attempt when checkpoint 2 stays red, before any review runs", async () => {
    const run = host([0, 1, 1, 1]);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "gate failed");
    assert.equal(run.recordBuildFailureCalls.length, 1);
  });

  it("gives the review's gate the merged main, so the gate-script guard treats checkpoint 3 as it does checkpoint 2", async () => {
    const newerMain = "a".repeat(40);
    let before = 0;
    let after = 0;
    const count = (checks: string[]) => checks.filter((command) => command.includes(`'${newerMain}'`)).length;
    const run = host([0, 0, 0], {
      latestMain: newerMain,
      containsMain: false,
      localReview: async (args) => {
        before = count(run.gateGuardChecks);
        await args.gate();
        after = count(run.gateGuardChecks);
        return { status: "failed", head: args.startHead, reason: "stop here" };
      },
    });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.ok(before > 0, "checkpoint 2 names the merged main");
    assert.ok(after > before, run.gateGuardChecks.join("\n"));
  });

  it("closes the sandbox, which removes the container of a role run the host gave up on, and publishes nothing, when the review's role run stalls", async () => {
    const stop = new StalledStepError("The pre-push-reviewer run didn't finish within its timeout and the host's grace, so the host gave up on it.");
    const run = host([0, 0], {
      localReview: async (args) => {
        markSandboxStalled(args.sandbox, "the pre-push-reviewer run");
        throw stop;
      },
    });

    await assert.rejects(() => buildIssue(issue, branch, base, run.buildHost), (error: unknown) => error === stop);

    assert.equal(run.steps.at(-1), "close", "the build's finally closes the sandbox the stalled run was in");
    assert.deepEqual(run.pushed, []);
  });

  it("logs a failed review as an error that names its reason", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => void errors.push(parts.join(" "));
    try {
      const run = host([0, 0], { localReview: async (args) => ({ status: "failed", head: args.startHead, reason: "the Bar reviewer timed out" }) });

      await buildIssue(issue, branch, base, run.buildHost);
    } finally {
      console.error = original;
    }

    assert.ok(errors.some((line) => line.includes("the Bar reviewer timed out")), errors.join("\n"));
  });

  it("publishes the last gated commit with a note, not a failed attempt, when the gate stays red after the review's fixes", async () => {
    const run = host([0, 0], {
      localReview: async () => ({ status: "failed", head: "gated-before-the-red-fixes", reason: "the gate stayed red after round 2's fixes" }),
    });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.notEqual(result.outcome, "gate failed");
    assert.ok(run.scanned.includes("gated-before-the-red-fixes"), run.scanned.join(","));
  });

  it("rejects with UncountedStopError, publishing and recording nothing, when a usage-limit stop ends the review", async () => {
    const stop = new UncountedStopError("Claude's usage limit was hit during the pre-push-reviewer run");
    const run = host([0, 0], {
      localReview: async () => {
        throw stop;
      },
    });

    await assert.rejects(() => buildIssue(issue, branch, base, run.buildHost), (error: unknown) => error === stop);

    assert.deepEqual(run.pushed, []);
    assert.deepEqual(run.comments, []);
    assert.deepEqual(run.recordBuildFailureCalls, []);
    assert.ok(run.order.includes("close"), run.order.join(", "));
    assert.ok(run.order.includes("unmark"), run.order.join(", "));
  });

  it("never runs scripts/review.sh or touches .git/review in the sandbox: only the host's review records", async () => {
    const commands: string[] = [];
    const run = host([0, 0]);
    const createSandbox = run.buildHost.createSandbox;
    run.buildHost.createSandbox = async (sandboxBranch) => {
      const sandbox = await createSandbox(sandboxBranch);
      return {
        ...sandbox,
        exec: async (command: string, options?: unknown) => {
          commands.push(command);
          return (sandbox.exec as (command: string, options?: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>)(command, options);
        },
      } as Sandbox;
    };

    await buildIssue(issue, branch, base, run.buildHost);

    assert.ok(commands.length > 0);
    assert.deepEqual(commands.filter((command) => /review\.sh|\.git\/review/.test(command)), []);
  });
});

describe("publish with a review note", () => {
  const createPullRequest = (bodies: string[]) => (_branch: string, _title: string, body: string) => {
    bodies.push(body);
    return "https://github.com/o/r/pull/1";
  };

  it("appends the review note after the check note", async () => {
    const bodies: string[] = [];
    const note = "⚠️ The local review didn't finish (a reason), so this branch has no recorded review.";

    await publish(issue, branch, "a".repeat(40), true, false, undefined, ["scripts/gate.sh"], () => {}, createPullRequest(bodies), async () => {}, note);

    const body = bodies[0] ?? "";
    assert.ok(body.endsWith(note), body);
    assert.ok(body.indexOf("scripts/gate.sh") < body.indexOf(note), body);
    assert.ok(body.includes(`\n\n${note}`), body);
  });

  it("leaves the body as it was when the note is empty", async () => {
    const withNote: string[] = [];
    const without: string[] = [];

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest(withNote), async () => {}, "");
    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest(without), async () => {});

    assert.equal(withNote[0], without[0]);
  });
});

// liveReviewHost and readSkillFiles decide what the review's agents may do and which skill files the host trusts. The sandbox here is
// a recorder: no git, no network, only the commands and role runs the host makes.
describe("liveReviewHost", () => {
  const SKILL = ".claude/skills/pre-push-review";
  const skillFile = (severitiesLast: boolean, marker: string) =>
    severitiesLast ? `# Skill\n\n## Steps\n\nDo it.\n\n## Severities\n\n- Critical ${marker}\n- Warning\n` : `# Skill\n\n## Severities\n\n- Critical ${marker}\n\n## Steps\n\nDo it.\n`;
  function checkout(options: { severitiesLast?: boolean; marker?: string } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "live-review-host-"));
    mkdirSync(join(dir, SKILL), { recursive: true });
    mkdirSync(join(dir, ".claude/agents"), { recursive: true });
    writeFileSync(join(dir, SKILL, "SKILL.md"), skillFile(options.severitiesLast ?? false, options.marker ?? "main"));
    writeFileSync(join(dir, SKILL, "lenses.md"), "| Lens | Applies to | Ask |\n| --- | --- | --- |\n| Edge cases | Any code | Ask. |\n");
    writeFileSync(join(dir, SKILL, "review-bar.md"), "The bar.");
    writeFileSync(join(dir, ".claude/agents/pre-push-reviewer.md"), "---\nname: pre-push-reviewer\n---\nThe reviewer's body.");
    return dir;
  }
  function recorder(outcomes?: string) {
    const execs: { command: string; stdin?: string }[] = [];
    const runs: SandboxRunOptions[] = [];
    const orderOf: string[] = [];
    const sandbox = {
      exec: async (command: string, options?: { stdin?: string }) => {
        execs.push({ command, stdin: options?.stdin });
        orderOf.push(`exec ${command}`);
        if (command.startsWith("cat ")) return outcomes === undefined ? { stdout: "", stderr: "", exitCode: 1 } : { stdout: outcomes, stderr: "", exitCode: 0 };
        return { stdout: command.startsWith("git rev-parse") ? "/home/agent/workspace\n" : "", stderr: "", exitCode: 0 };
      },
      run: async (options: SandboxRunOptions) => {
        runs.push(options);
        orderOf.push(`run ${options.name}`);
        return { iterations: [], commits: [{ sha: "made" }], stdout: "<findings>[]</findings>" };
      },
    } as unknown as Sandbox;
    const commits: { sha: string }[] = [];
    const args: LocalReviewArgs = {
      sandbox,
      issue: { number: 387, title: "t", body: "b" },
      branch: "feature/387-x",
      main: base,
      startHead: "a".repeat(40),
      gate: async () => undefined,
      addCommits: (made) => void commits.push(...made),
      limits: new RunLimits(),
    };
    return { args, execs, runs, orderOf, commits };
  }
  const commandOf = (options: SandboxRunOptions) => options.agent.buildPrintCommand({ prompt: "p", dangerouslySkipPermissions: true }).command;

  it("runs a reviewer with only Read, Grep and Glob, strict MCP and the ledger deny list", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      const stdout = await liveReviewHost(args, dir).runReviewer({ lens: "Bar", row: "" }, "review");

      assert.equal(stdout, "<findings>[]</findings>");
      const command = commandOf(runs[0]!);
      assert.match(command, /--tools '?Read,Grep,Glob'?(?= |$)/);
      assert.match(command, /--strict-mcp-config/);
      assert.match(command, /--setting-sources '?user'?(?= |$)/);
      assert.match(command, /--disallowedTools/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  // Issue 399: in the subagents mode one lead run starts a round's reviewers as parallel subagents; in the sequential mode nothing changes.
  const members = (...lenses: string[]) =>
    lenses.map((lens, index) => ({
      id: index + 1,
      agent: `lens-${index + 1}`,
      file: `/home/agent/workspace/.sandcastle/work/387/review/lens-${index + 1}.md`,
      reviewer: { lens, row: lens === "Bar" ? "" : `| ${lens} | Any code | Ask. |` },
    }));
  const wordsOf = (command: string): string[] => {
    const shell = spawnSync("sh", ["-c", `printf '%s\n' ${command.slice("claude --print ".length)}`], { encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
    return shell.stdout.split("\n");
  };

  it("has no runReviewerTeam in the sequential mode, and starts the pre-push-reviewer as before", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      const live = liveReviewHost({ ...args, reviewerMode: "sequential" }, dir);

      await live.runReviewer({ lens: "Bar", row: "" }, "review");

      assert.equal(live.runReviewerTeam, undefined);
      assert.deepEqual(runs.map((found) => found.name), ["pre-push-reviewer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  // The production default: `reviewerMode` absent, so SANDCASTLE_REVIEWERS decides. Every other test passes the mode.
  describe("without an explicit reviewerMode", () => {
    const withEnv = (value: string | undefined, run: () => void) => {
      const before = process.env.SANDCASTLE_REVIEWERS;
      try {
        if (value === undefined) delete process.env.SANDCASTLE_REVIEWERS;
        else process.env.SANDCASTLE_REVIEWERS = value;
        run();
      } finally {
        if (before === undefined) delete process.env.SANDCASTLE_REVIEWERS;
        else process.env.SANDCASTLE_REVIEWERS = before;
      }
    };
    const teamOf = (value: string | undefined) => {
      const { args } = recorder();
      const dir = checkout();
      try {
        let team: unknown;
        withEnv(value, () => {
          team = liveReviewHost(args, dir).runReviewerTeam;
        });
        return team;
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      }
    };

    it("stays sequential when SANDCASTLE_REVIEWERS is unset or empty", () => {
      assert.equal(teamOf(undefined), undefined);
      assert.equal(teamOf(""), undefined);
      assert.equal(teamOf("sequential"), undefined);
    });

    it("uses the subagents when SANDCASTLE_REVIEWERS is subagents", () => {
      assert.equal(typeof teamOf("subagents"), "function");
    });

    it("throws for a mistyped SANDCASTLE_REVIEWERS", () => {
      assert.throws(() => teamOf("subagent"), /SANDCASTLE_REVIEWERS/);
    });
  });

  it("has a runReviewerTeam in the subagents mode, which the host review then uses instead of runReviewer", () => {
    const { args } = recorder();
    const dir = checkout();
    try {
      assert.equal(typeof liveReviewHost({ ...args, reviewerMode: "subagents" }, dir).runReviewerTeam, "function");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("starts the pre-push-review-lead once for the whole team, with the idle timeout set to the role's timeout, and returns the lead's output", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      const stdout = await liveReviewHost({ ...args, reviewerMode: "subagents" }, dir).runReviewerTeam!(members("Bar", "Edge cases", "Tests"), "the lead's prompt");

      assert.equal(stdout, "<findings>[]</findings>");
      assert.deepEqual(runs.map((found) => found.name), ["pre-push-review-lead"]);
      assert.equal(runs[0]!.prompt, "the lead's prompt");
      // Sandcastle's default idle timeout is ten minutes of silence, and a lead waiting on its subagents may print nothing for longer.
      assert.equal(runs[0]!.idleTimeoutSeconds, FIXED_ROLE_AGENTS["pre-push-review-lead"].timeoutMinutes * 60);
      assert.equal(runs[0]!.idleTimeoutSeconds, 1800);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("gives the lead Agent, Read, Grep and Glob, no shell, the ledger deny list, strict MCP and the user's settings only", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      await liveReviewHost({ ...args, reviewerMode: "subagents" }, dir).runReviewerTeam!(members("Bar", "Edge cases"), "lead");

      const command = commandOf(runs[0]!);
      const words = wordsOf(command);
      // The lead's Agent tool names exactly the lens-<id> agents defined for the round, so no other subagent (a user-level or plugin one, a type a later Claude Code adds) starts.
      // Claude Code 2.1.317 honours `Agent(name,...)` only in an --agents definition's tools: in --tools it leaves the session no Agent tool at all. So the lead is a definition, started with --agent.
      assert.ok(!words.includes("--tools"), "--tools would leave the lead no Agent tool");
      assert.equal(words[words.indexOf("--agent") + 1], "pre-push-review-lead");
      const defined = JSON.parse(words[words.indexOf("--agents") + 1]!) as Record<string, { tools: string[] }>;
      assert.deepEqual(defined["pre-push-review-lead"]!.tools, leadTools(["lens-1", "lens-2"]));
      assert.deepEqual(defined["pre-push-review-lead"]!.tools, ["Agent(lens-1,lens-2)", "Read", "Grep", "Glob"]);
      assert.doesNotMatch(defined["pre-push-review-lead"]!.tools.join(","), /Bash|Edit|Write/);
      assert.ok(words.includes("--strict-mcp-config"));
      assert.equal(words[words.indexOf("--setting-sources") + 1], "user");
      assert.ok(words.includes("--disallowedTools"));
      for (const rule of LEDGER_DENIED_TOOLS) assert.ok(words.includes(rule), rule);
      // A steered lead must not start a built-in subagent (general-purpose holds a shell and the network) in place of the lens-<id> agents.
      for (const type of ["general-purpose", "Explore", "Plan"]) assert.ok(words.includes(`Agent(${type})`), `Agent(${type}) isn't denied`);
      for (const rule of LEAD_DENIED_TOOLS) assert.ok(words.includes(rule), rule);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("defines one subagent per member with --agents: named lens-<id>, Read, Grep and Glob only, pointing at the member's prompt file", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      const team = members("Bar", "Edge cases", "Tests");

      await liveReviewHost({ ...args, reviewerMode: "subagents" }, dir).runReviewerTeam!(team, "lead");

      const words = wordsOf(commandOf(runs[0]!));
      const defined = JSON.parse(words[words.indexOf("--agents") + 1]!) as Record<string, { description: string; prompt: string; tools: string[]; model: string }>;
      assert.deepEqual(Object.keys(defined).sort(), ["lens-1", "lens-2", "lens-3", "pre-push-review-lead"]);
      for (const member of team) {
        const one = defined[member.agent]!;
        assert.deepEqual(one.tools, ["Read", "Grep", "Glob"]);
        assert.equal(one.model, FIXED_ROLE_AGENTS["pre-push-reviewer"].model);
        assert.ok(one.prompt.includes(member.file), member.agent);
        assert.ok(one.description.includes(member.reviewer.lens), member.agent);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  // A repository's lens row has no length limit: a full round of the longest names must still fit the --agents word, and with apostrophes in every one.
  it("builds the lead's command for a full round of lenses with very long names, within the --agents cap", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      const long = (n: number) => `Lens ${n} it's ${"'x".repeat(50_000)}`;
      const team = members(...Array.from({ length: MAX_REVIEWERS_PER_ROUND }, (_, index) => long(index)));

      await liveReviewHost({ ...args, reviewerMode: "subagents" }, dir).runReviewerTeam!(team, "lead");

      const words = wordsOf(commandOf(runs[0]!));
      const word = words[words.indexOf("--agents") + 1]!;
      assert.ok(Buffer.byteLength(word) < MAX_AGENTS_WORD_BYTES / 2, `${Buffer.byteLength(word)} bytes`);
      // The lenses and the lead's own definition.
      assert.equal(Object.keys(JSON.parse(word) as object).length, MAX_REVIEWERS_PER_ROUND + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("runs the team's lead through none of review.sh or .git/review but the deny rules", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      await liveReviewHost({ ...args, reviewerMode: "subagents" }, dir).runReviewerTeam!(members("Bar"), "lead");

      const withoutDenyRules = LEDGER_DENIED_TOOLS.reduce((text, rule) => text.split(rule).join(""), commandOf(runs[0]!));
      assert.doesNotMatch(withoutDenyRules, /review\.sh|\.git\/review/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("refuses to start a lead for no members rather than run a lead with nothing to start", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      await assert.rejects(() => liveReviewHost({ ...args, reviewerMode: "subagents" }, dir).runReviewerTeam!([], "lead"));

      assert.equal(runs.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("rejects with an UncountedStopError when the lead hits Claude's usage limit, and gives the build's limits the stop", async () => {
    const { args } = recorder();
    const dir = checkout();
    try {
      const sandbox = {
        ...(args.sandbox as object),
        run: async () => {
          throw new Error("claude-code exited with code 1:\nClaude AI usage limit reached|1760000000");
        },
      } as unknown as Sandbox;

      await assert.rejects(
        () => liveReviewHost({ ...args, sandbox, reviewerMode: "subagents" }, dir).runReviewerTeam!(members("Bar"), "lead"),
        (error: unknown) => error instanceof UncountedStopError && /pre-push-review-lead/.test(error.message),
      );
      assert.throws(() => args.limits.throwIfStopped());
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("gives up on a lead that never answers, stalling the sandbox, like a reviewer", async () => {
    const { args } = recorder();
    const dir = checkout();
    try {
      const sandbox = { ...(args.sandbox as object), run: () => new Promise(() => undefined) } as unknown as Sandbox;

      await assert.rejects(
        () => liveReviewHost({ ...args, sandbox, backstopMs: 20, reviewerMode: "subagents" }, dir).runReviewerTeam!(members("Bar"), "lead"),
        (error: unknown) => error instanceof StalledStepError,
      );
      assert.match(stalledStepOf(sandbox) ?? "", /pre-push-review-lead/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("stops the fixer, before it starts, when the run folder is a link and the earlier outcomes can't be cleared", async () => {
    const { args, runs } = recorder();
    const dir = checkout();
    try {
      const sandbox = { ...(args.sandbox as object), exec: async () => ({ stdout: "", stderr: ".sandcastle/work/387/review is a link", exitCode: 1 }) } as unknown as Sandbox;

      await assert.rejects(() => liveReviewHost({ ...args, sandbox }, dir).runFixer("fix"), /clearing .*outcomes\.json.* failed: .*is a link/);
      assert.equal(runs.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("runs the fixer with the ledger deny list only, clears the earlier outcomes first and hands the build its commits", async () => {
    const { args, runs, orderOf, commits } = recorder();
    const dir = checkout();
    try {
      await liveReviewHost(args, dir).runFixer("fix");

      const command = commandOf(runs[0]!);
      assert.match(command, /--disallowedTools/);
      assert.doesNotMatch(command, /--tools|--strict-mcp-config/);
      const cleared = orderOf.findIndex((entry) => / && rm -f -- '\.sandcastle\/work\/387\/review\/outcomes\.json'$/.test(entry));
      assert.ok(cleared >= 0 && cleared < orderOf.indexOf("run backend"), orderOf.join("\n"));
      assert.match(orderOf[cleared]!, /test ! -L '\.sandcastle\/work\/387\/review'/);
      assert.deepEqual(commits, [{ sha: "made" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("writes run files only under the run's own folder", async () => {
    const { args, execs } = recorder();
    const dir = checkout();
    try {
      const live = liveReviewHost(args, dir);

      await live.writeRunFile(".sandcastle/work/387/review/diff.patch", "patch");
      for (const path of [".sandcastle/work/387/review/../../evil", ".sandcastle/work/388/review/diff.patch", "scripts/gate.sh", "/etc/passwd"]) {
        await assert.rejects(() => live.writeRunFile(path, "x"), /may only write under/, path);
      }

      assert.equal(execs.filter((found) => found.stdin !== undefined).length, 1);
      assert.equal(execs.find((found) => found.stdin !== undefined)?.stdin, Buffer.from("patch").toString("base64"));
      assert.match(execs.find((found) => found.stdin !== undefined)?.command ?? "", /base64 -d > /);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("removes a file only under the run's own folder", async () => {
    const { args, execs } = recorder();
    const dir = checkout();
    try {
      const live = liveReviewHost(args, dir);

      await live.removeRunFile(".sandcastle/work/387/review/fixes.patch");
      for (const path of [".sandcastle/work/387/review/../../evil", ".sandcastle/work/388/review/fixes.patch", "scripts/gate.sh", "/etc/passwd"]) {
        await assert.rejects(() => live.removeRunFile(path), /may only remove under/, path);
      }

      assert.match(execs.at(-1)?.command ?? "", / && rm -f -- '\.sandcastle\/work\/387\/review\/fixes\.patch'$/);
      assert.equal(execs.filter((found) => found.command.includes("rm -f")).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("removes a run file's path before writing it, so a link left there isn't followed", async () => {
    const { args, execs } = recorder();
    const dir = checkout();
    try {
      const live = liveReviewHost(args, dir);
      await live.writeRunFile(".sandcastle/work/387/review/lens-1.md", "one");
      await live.writeRunFile(".sandcastle/work/387/review/lens-2.md", "");

      const matched = execs.filter((e) => /lens-\d\.md/.test(e.command));
      assert.equal(matched.length, 2);
      for (const found of matched) {
        assert.match(found.command, /rm -f -- '\.sandcastle\/work\/387\/review\/lens-\d\.md' && /, found.command);
        assert.ok(found.command.indexOf("rm -f") < found.command.search(/base64 -d >|: >/), found.command);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  const RUN = ".sandcastle/work/387/review";
  const plantRun = (root: string) => mkdirSync(join(root, RUN), { recursive: true });

  it("writes a run file whole, empty or not, replacing a link, a hard link or a dangling link at its path instead of following it", async () => {
    const cases: [string, string, (root: string) => void, boolean][] = [
      ["a clean folder", "lens one", () => {}, false],
      ["an empty file", "", () => {}, false],
      ["a symlink to another prompt", "lens one", (root) => { plantRun(root); writeFileSync(join(root, RUN, "lens-2.md"), "two"); symlinkSync("lens-2.md", join(root, RUN, "lens-1.md")); }, true],
      ["a hard link to another prompt", "lens one", (root) => { plantRun(root); writeFileSync(join(root, RUN, "lens-2.md"), "two"); linkSync(join(root, RUN, "lens-2.md"), join(root, RUN, "lens-1.md")); }, true],
      ["a dangling symlink", "lens one", (root) => { plantRun(root); symlinkSync("nowhere.md", join(root, RUN, "lens-1.md")); }, false],
    ];
    for (const [name, content, plant, otherPlanted] of cases) {
      const { args, execs } = recorder();
      const dir = checkout();
      const root = mkdtempSync(join(tmpdir(), "run-file-"));
      try {
        plant(root);
        await liveReviewHost(args, dir).writeRunFile(`${RUN}/lens-1.md`, content);
        const found = execs.at(-1);
        const shell = spawnSync("sh", ["-c", found?.command ?? "false"], { cwd: root, input: found?.stdin ?? "", encoding: "utf8" });

        assert.equal(shell.error, undefined, name);
        assert.equal(shell.status, 0, `${name}: ${shell.stderr}`);
        assert.equal(readFileSync(join(root, RUN, "lens-1.md"), "utf8"), content, name);
        assert.equal(lstatSync(join(root, RUN, "lens-1.md")).isSymbolicLink(), false, name);
        if (otherPlanted) assert.equal(readFileSync(join(root, RUN, "lens-2.md"), "utf8"), "two", `${name}: the other prompt`);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  });

  it("removes a run file in a real shell: an existing one, an absent one, a missing run folder, and a link without touching its target", async () => {
    const cases: [string, (root: string, outside: string) => void, (root: string, outside: string) => void][] = [
      ["an existing file", (root) => { plantRun(root); writeFileSync(join(root, RUN, "fixes.patch"), "p"); }, (root) => assert.equal(existsSync(join(root, RUN, "fixes.patch")), false)],
      ["an absent file", (root) => plantRun(root), (root) => assert.deepEqual(readdirSync(join(root, RUN)), [])],
      ["a run folder that does not exist yet", () => {}, (root) => assert.equal(existsSync(join(root, ".sandcastle")), false)],
      [
        "a symlink at the path",
        (root, outside) => { plantRun(root); writeFileSync(join(outside, "target"), "keep"); symlinkSync(join(outside, "target"), join(root, RUN, "fixes.patch")); },
        (root, outside) => {
          assert.equal(existsSync(join(root, RUN, "fixes.patch")), false);
          assert.equal(readFileSync(join(outside, "target"), "utf8"), "keep");
        },
      ],
    ];
    for (const [name, plant, check] of cases) {
      const { args, execs } = recorder();
      const dir = checkout();
      const root = mkdtempSync(join(tmpdir(), "run-file-"));
      const outside = mkdtempSync(join(tmpdir(), "run-file-outside-"));
      try {
        plant(root, outside);
        await liveReviewHost(args, dir).removeRunFile(`${RUN}/fixes.patch`);
        const shell = spawnSync("sh", ["-c", execs.at(-1)?.command ?? "false"], { cwd: root, encoding: "utf8" });

        assert.equal(shell.error, undefined, name);
        assert.equal(shell.status, 0, `${name}: ${shell.stderr}`);
        check(root, outside);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
        rmSync(outside, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  });

  it("fails, and writes nothing, when the run file's path is a folder", async () => {
    const { args, execs } = recorder();
    const dir = checkout();
    const root = mkdtempSync(join(tmpdir(), "run-file-"));
    try {
      mkdirSync(join(root, RUN, "lens-1.md"), { recursive: true });
      await liveReviewHost(args, dir).writeRunFile(`${RUN}/lens-1.md`, "x");
      // No stdin: the command fails at the removal, before the write reads it, and a shell that has already exited makes spawnSync report EPIPE for it.
      const shell = spawnSync("sh", ["-c", execs.at(-1)?.command ?? "false"], { cwd: root, encoding: "utf8" });

      assert.equal(shell.error, undefined);
      assert.notEqual(shell.status, 0);
      assert.match(shell.stderr, /lens-1\.md/);
      assert.doesNotMatch(shell.stderr, /is a link/);
      assert.deepEqual(readdirSync(join(root, RUN, "lens-1.md")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("refuses to write or remove a run file when the run folder or a folder above it is a link, says so, and touches nothing through it", async () => {
    const links: [string, (root: string, outside: string) => void][] = [
      [".sandcastle", (root, outside) => symlinkSync(outside, join(root, ".sandcastle"))],
      [".sandcastle/work", (root, outside) => { mkdirSync(join(root, ".sandcastle")); symlinkSync(outside, join(root, ".sandcastle/work")); }],
      [".sandcastle/work/387", (root, outside) => { mkdirSync(join(root, ".sandcastle/work"), { recursive: true }); symlinkSync(outside, join(root, ".sandcastle/work/387")); }],
      [RUN, (root, outside) => { mkdirSync(join(root, ".sandcastle/work/387"), { recursive: true }); symlinkSync(outside, join(root, RUN)); }],
    ];
    for (const [name, plant] of links) {
      for (const action of ["write", "remove"] as const) {
        const { args, execs } = recorder();
        const dir = checkout();
        const root = mkdtempSync(join(tmpdir(), "run-file-"));
        const outside = mkdtempSync(join(tmpdir(), "run-file-outside-"));
        try {
          writeFileSync(join(outside, "lens-1.md"), "keep");
          plant(root, outside);
          const live = liveReviewHost(args, dir);
          if (action === "write") await live.writeRunFile(`${RUN}/lens-1.md`, "lens one");
          else await live.removeRunFile(`${RUN}/lens-1.md`);
          const found = execs.at(-1);
          // No stdin: the guard fails before anything reads it, and a shell that has already exited makes spawnSync report EPIPE for the unread input.
          // A guard that let the write through would find an empty stdin and truncate the file outside, which the checks below still catch.
          const shell = spawnSync("sh", ["-c", found?.command ?? "false"], { cwd: root, encoding: "utf8" });
          const label = `${action} through a link at ${name}`;

          assert.equal(shell.error, undefined, label);
          assert.equal(shell.status, 1, label);
          assert.match(shell.stderr, /is a link/, label);
          assert.deepEqual(readdirSync(outside), ["lens-1.md"], label);
          assert.equal(readFileSync(join(outside, "lens-1.md"), "utf8"), "keep", label);
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
          rmSync(root, { recursive: true, force: true, maxRetries: 5 });
          rmSync(outside, { recursive: true, force: true, maxRetries: 5 });
        }
      }
    }
  });

  it("makes an empty run file without feeding the sandbox's command an empty stdin", async () => {
    const { args, execs } = recorder();
    const dir = checkout();
    try {
      await liveReviewHost(args, dir).writeRunFile(".sandcastle/work/387/review/fixes.patch", "");

      assert.equal(execs.filter((found) => found.stdin !== undefined).length, 0);
      assert.match(execs.at(-1)?.command ?? "", /: > '\.sandcastle\/work\/387\/review\/fixes\.patch'$/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  // Criterion: a reviewer or fix run that never answers ends the review red instead of holding the job. The tests of runRoleInSandbox
  // alone could not tell whether the live host passes through it, so this runs the live host over a sandbox whose run never settles.
  it("gives up on a reviewer run that never answers with a StalledStepError, and leaves the sandbox stalled", { timeout: 10_000 }, async () => {
    const { args } = recorder();
    const sandbox = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), run: () => new Promise(() => undefined) } as unknown as Sandbox;
    const dir = checkout();
    try {
      const live = liveReviewHost({ ...args, sandbox, backstopMs: 20 }, dir);

      await assert.rejects(() => live.runReviewer({ lens: "Bar", row: "" }, "review"), (error: unknown) => error instanceof StalledStepError);

      assert.match(stalledStepOf(sandbox) ?? "", /pre-push-reviewer/);
      await assert.rejects(() => live.runFixer("fix"), (error: unknown) => error instanceof StalledStepError);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("gives up on a backend fix run that never answers with a StalledStepError", { timeout: 10_000 }, async () => {
    const { args } = recorder();
    const sandbox = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), run: () => new Promise(() => undefined) } as unknown as Sandbox;
    const dir = checkout();
    try {
      await assert.rejects(
        () => liveReviewHost({ ...args, sandbox, backstopMs: 20 }, dir).runFixer("fix"),
        (error: unknown) => error instanceof StalledStepError && /backend/.test(error.message),
      );

      assert.match(stalledStepOf(sandbox) ?? "", /backend/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("reads the worktree's path from the sandbox, and fails when it can't", async () => {
    const { args } = recorder();
    const dir = checkout();
    try {
      assert.equal(await liveReviewHost(args, dir).worktree(), "/home/agent/workspace");
      const failing = { ...args, sandbox: { exec: async () => ({ stdout: "", stderr: "", exitCode: 128 }) } as unknown as Sandbox };
      await assert.rejects(() => liveReviewHost(failing, dir).worktree(), /worktree path/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("sends the bytes of a patch that isn't UTF-8 through unchanged", async () => {
    const { args, execs } = recorder();
    const dir = checkout();
    try {
      const bytes = Buffer.from([0x2b, 0xff, 0xfe, 0x0a]);

      await liveReviewHost(args, dir).writeRunFile(".sandcastle/work/387/review/diff.patch", bytes);

      assert.deepEqual(Buffer.from(execs.find((found) => found.stdin !== undefined)!.stdin!, "base64"), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("runs none of its sandbox commands or role runs through scripts/review.sh or .git/review", async () => {
    const { args, execs, runs } = recorder();
    const dir = checkout();
    try {
      const live = liveReviewHost(args, dir);

      await live.worktree();
      await live.writeRunFile(".sandcastle/work/387/review/diff.patch", "p");
      await live.runFixer("fix");
      await live.runReviewer({ lens: "Bar", row: "" }, "review");
      await live.readOutcomes();

      assert.equal(runs.length, 2);
      // The deny rules name the ledger on purpose; nothing else in a role's command may.
      const withoutDenyRules = (command: string) => LEDGER_DENIED_TOOLS.reduce((text, rule) => text.split(rule).join(""), command);
      assert.ok(runs.every((found) => !/review\.sh|\.git\/review/.test(withoutDenyRules(commandOf(found)))), runs.map((found) => commandOf(found)).join("\n"));
      assert.ok(execs.length >= 4);
      assert.ok(execs.every((found) => !/review\.sh|\.git\/review/.test(found.command)), execs.map((found) => found.command).join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("makes a logged line safe for the operator's terminal and keeps its prefix", () => {
    const { args } = recorder();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
    try {
      liveReviewHost(args, process.cwd()).log("  ✗ the Bar reviewer's error: boom \u001b[2J\u0007 done");
    } finally {
      console.log = original;
    }

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^ {2}#387 /);
    assert.doesNotMatch(lines[0]!, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  });

  it("pins the ledger's git to the checkout's own .git, and refuses a checkout whose .git has a planted commondir", () => {
    const repo = mkdtempSync(join(tmpdir(), "live-review-pin-"));
    try {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      const { args } = recorder();
      const live = liveReviewHost(args, repo);

      assert.throws(() => live.takenIds("0".repeat(40)), /left main|can't find|fetch/);
      assert.equal(ledgerGitEnv(repo).GIT_COMMON_DIR, join(repo, ".git"));

      writeFileSync(join(repo, ".git", "commondir"), "../elsewhere\n");
      assert.throws(() => live.takenIds("0".repeat(40)), /commondir/);
      assert.throws(() => live.prepare({ main: "origin/main" }), /commondir/);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("returns outcomes.json's text when the sandbox has the file", async () => {
    const { args } = recorder('{"outcomes":[]}');
    const dir = checkout();
    try {
      assert.equal(await liveReviewHost(args, dir).readOutcomes(), '{"outcomes":[]}');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("lists the files a round changed, NUL-split, with spaces, non-ASCII and a deleted file", () => {
    const repo = mkdtempSync(join(tmpdir(), "live-review-git-"));
    const run = (...gitArgs: string[]) => spawnSync("git", gitArgs, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
    try {
      run("init", "-q", "-b", "main");
      writeFileSync(join(repo, "gone.txt"), "x");
      writeFileSync(join(repo, "keep.txt"), "a");
      run("add", "-A");
      run("commit", "-q", "-m", "first");
      const from = run("rev-parse", "HEAD").stdout.trim();
      rmSync(join(repo, "gone.txt"));
      writeFileSync(join(repo, "keep.txt"), "b");
      writeFileSync(join(repo, "with space.txt"), "c");
      writeFileSync(join(repo, "café.txt"), "d");
      run("add", "-A");
      run("commit", "-q", "-m", "second");
      const to = run("rev-parse", "HEAD").stdout.trim();
      const { args } = recorder();

      const changed = liveReviewHost(args, repo).changedFiles(from, to);

      assert.deepEqual([...changed].sort(), ["café.txt", "gone.txt", "keep.txt", "with space.txt"]);
      assert.deepEqual(liveReviewHost(args, repo).changedFiles(to, to), []);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("reads outcomes.json when the sandbox has it, and nothing when it doesn't", async () => {
    const { args } = recorder();
    const dir = checkout();
    try {
      assert.equal(await liveReviewHost(args, dir).readOutcomes(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("reads the skill files from the checkout it is given, whatever the worktree holds", () => {
    const main = checkout({ marker: "main's" });
    const worktree = checkout({ marker: "the branch's easy one" });
    try {
      const files = readSkillFiles(main);

      assert.match(files.severities, /main's/);
      assert.doesNotMatch(files.severities, /easy one/);
      assert.equal(files.bar, "The bar.");
      assert.equal(files.agentBody, "The reviewer's body.");
      assert.equal(files.repoLenses, undefined);
      assert.match(readSkillFiles(worktree).severities, /easy one/);
    } finally {
      rmSync(main, { recursive: true, force: true, maxRetries: 5 });
      rmSync(worktree, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("keeps the repository's own lens table, ignores a code-review skill with none, and ignores a missing one", () => {
    const dir = checkout();
    try {
      mkdirSync(join(dir, ".claude/skills/code-review"), { recursive: true });
      const own = "# Own\n\n| Lens | Applies to | Ask |\n| --- | --- | --- |\n| Mine | Any file | Ask. |\n";
      writeFileSync(join(dir, ".claude/skills/code-review/SKILL.md"), own);
      assert.equal(readSkillFiles(dir).repoLenses, own);

      writeFileSync(join(dir, ".claude/skills/code-review/SKILL.md"), "# No table here\n");
      assert.equal(readSkillFiles(dir).repoLenses, undefined);

      rmSync(join(dir, ".claude/skills/code-review"), { recursive: true, force: true, maxRetries: 5 });
      assert.equal(readSkillFiles(dir).repoLenses, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("fails, rather than dropping the repository's lenses, when its code-review skill can't be read", () => {
    const dir = checkout();
    try {
      mkdirSync(join(dir, ".claude/skills/code-review/SKILL.md"), { recursive: true });

      assert.throws(() => readSkillFiles(dir), /EISDIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("reads a Severities section that is the skill's last one", () => {
    const dir = checkout({ severitiesLast: true });
    try {
      assert.match(readSkillFiles(dir).severities, /- Warning/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("fails clearly when SKILL.md has no Severities section", () => {
    const dir = checkout();
    try {
      writeFileSync(join(dir, SKILL, "SKILL.md"), "# Skill\n\n## Steps\n\nDo it.\n");
      assert.throws(() => readSkillFiles(dir), /no Severities section/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("fails when the reviewer's agent file is missing", () => {
    const dir = checkout();
    try {
      rmSync(join(dir, ".claude/agents/pre-push-reviewer.md"));
      assert.throws(() => readSkillFiles(dir), /ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

// Open Critical or Warning findings hold a built branch's PR as a draft until a person accepts them (`scripts/review.sh accept`) and marks it ready
// (`gh pr ready`); a PR with none open is opened ready. Only a person accepts: the host never does.
describe("buildIssue's PR state after the local review", () => {
  const reviewed = "c".repeat(40);
  const recorded = (findings: Ledger["findings"]) => async () =>
    ({ status: "recorded", head: reviewed, rounds: 1, ledger: ledgerWith(reviewed, findings), readPaths: new Set(["src/app.ts", "src/log.ts"]) }) as const;
  const warning = () => openFinding({ id: "R2", lens: "Security", severity: "warning", security: true, summary: "The token reaches the log line.", path: "src/log.ts" });

  it("holds the PR as a draft when a Critical finding is open", async () => {
    const run = host([0, 0], { localReview: recorded([openFinding()]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishedDrafts, [true]);
  });

  it("holds the PR as a draft when a Warning finding is open", async () => {
    const run = host([0, 0], { localReview: recorded([warning()]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishedDrafts, [true]);
  });

  it("opens the PR ready when the review left nothing open", async () => {
    const run = host([0, 0], { localReview: recorded([]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishedDrafts, [false]);
  });

  it("opens the PR ready when only fixed, dismissed or accepted findings and open Advisory ones remain", async () => {
    const run = host([0, 0], {
      localReview: recorded([
        openFinding({ id: "R1", status: "fixed", test: "tests/a.test.ts::blank" }),
        openFinding({ id: "R2", status: "dismissed", reason: "src/app.ts:12 is guarded." }),
        openFinding({ id: "R3", status: "accepted", reason: "A person accepted it." }),
        openFinding({ id: "R4", severity: "advisory", path: "docs/a.md", summary: "A stale sentence." }),
      ]),
    });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishedDrafts, [false]);
  });

  // A review that didn't finish has not cleared the code, and PR Auto-Merge only merges ready PRs: the PR is held, and the note in its body says why.
  it("holds the PR as a draft when the review didn't finish and recorded nothing, with the note saying the review didn't finish", async () => {
    const run = host([0, 0], { localReview: async (args) => ({ status: "failed", head: args.startHead, reason: "the Bar reviewer timed out" }) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishedDrafts, [true]);
    assert.match(run.publishedReviewNotes[0] ?? "", /The local review didn't finish \(the Bar reviewer timed out\)/);
    assert.match(DRAFT_NOTE, /didn't finish/);
  });

  // The review's ledger stays on the Actions runner, so `scripts/review.sh accept` finds nothing in a later checkout: the note tells a person to record
  // one with the review itself (`report` only prints a ledger, it records none).
  it("DRAFT_NOTE says the ledger stayed on the runner and that /pre-push-review records one to accept against", () => {
    assert.match(DRAFT_NOTE, /ledger the review recorded stayed on the runner/);
    assert.match(DRAFT_NOTE, /run `\/pre-push-review` on it, which records a ledger/);
    assert.match(DRAFT_NOTE, /ids that review prints/);
    assert.ok(DRAFT_NOTE.indexOf("/pre-push-review") < DRAFT_NOTE.indexOf("review.sh accept <id>"), DRAFT_NOTE);
    assert.match(DRAFT_NOTE, /`gh pr ready`/);
    assert.ok(!DRAFT_NOTE.includes("review.sh report"), DRAFT_NOTE);
  });

  it("holds the PR as a draft for an open finding graded Advisory that is a security finding", async () => {
    const run = host([0, 0], { localReview: recorded([openFinding({ id: "R3", severity: "advisory", security: true, lens: "Security", path: "src/log.ts" })]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishedDrafts, [true]);
    assert.doesNotMatch(run.publishedReviewNotes[0] ?? "", /R3 /, "a security finding is counted, never listed");
  });

  it("lists an open finding that isn't a security one and counts the security one beside it", async () => {
    const run = host([0, 0], {
      localReview: recorded([
        openFinding({ id: "R2", path: "src/a.ts", line: 3, security: false }),
        openFinding({ id: "R3", severity: "advisory", security: true, lens: "Security", path: "src/log.ts" }),
      ]),
    });
    // The note lists only paths the review read.
    const local = run.buildHost.localReview;
    run.buildHost.localReview = async (args) => {
      const result = await local(args);
      return result.status === "recorded" ? { ...result, readPaths: new Set(["src/a.ts", "src/log.ts"]) } : result;
    };

    await buildIssue(issue, branch, base, run.buildHost);

    const note = run.publishedReviewNotes[0] ?? "";
    assert.match(note, /R2 /);
    assert.doesNotMatch(note, /R3 /);
    assert.match(note, /1 security finding is left open/);
  });

  it("holds the PR as a draft when the only open finding's path the note can't list", async () => {
    const run = host([0, 0], { localReview: recorded([openFinding({ path: "src/unread.ts" })]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishedDrafts, [true]);
    assert.doesNotMatch(run.publishedReviewNotes[0] ?? "", /unread\.ts/);
  });

  it("never writes a Review notes section: only a person's acceptances make one", async () => {
    const run = host([0, 0], { localReview: recorded([openFinding(), warning()]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.ok((run.publishedReviewNotes[0] ?? "").length > 0, "the note was built");
    assert.doesNotMatch(run.publishedReviewNotes[0] ?? "", /Review.{0,6}notes/i);
  });

  it("writes no Review notes section into the body publish assembles for a held PR", async () => {
    const bodies: string[] = [];
    const note = "The local review left these findings open (their details are in the local review record):\n\n- R1 critical src/app.ts:12";

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, (_b, _t, body) => (bodies.push(body), "u"), async () => {}, note, true, () => {});

    assert.ok(bodies[0]?.includes(note));
    assert.doesNotMatch(bodies[0] ?? "", /Review.{0,6}notes/i);
  });
});

// The follow-up issue holds the open Advisory findings of the review, as the skill's step 9 files it (`scripts/review.sh advisory`).
describe("buildIssue's follow-up issue for open Advisory findings", () => {
  const reviewed = "c".repeat(40);
  const advisory = (overrides: Partial<Ledger["findings"][number]> = {}) =>
    openFinding({ id: "R5", severity: "advisory", path: "docs/a.md", line: 4, summary: "A stale sentence.", fix: "Reword it.", ...overrides });
  const recorded = (findings: Ledger["findings"]) => async () =>
    ({ status: "recorded", head: reviewed, rounds: 1, ledger: ledgerWith(reviewed, findings), readPaths: new Set(["docs/a.md"]) }) as const;

  it("files one issue titled for the branch, whose body is the ledger's list of the open Advisory findings", async () => {
    const ledger = ledgerWith(reviewed, [advisory(), advisory({ id: "R6", line: 9, summary: "A stale comment." })]);
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 1, ledger, readPaths: new Set(["docs/a.md"]) }) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(run.advisoryIssues.length, 1);
    assert.equal(run.advisoryIssues[0]?.title, `chore(review): Advisory review findings: ${branch}`);
    assert.equal(run.advisoryIssues[0]?.body, renderAdvisories(ledger));
    assert.match(run.advisoryIssues[0]?.body ?? "", /R5/);
    assert.match(run.advisoryIssues[0]?.body ?? "", /R6/);
  });

  it("files nothing, still publishes, and says so when the branch name hides text, so a dropped issue isn't mistaken for no findings", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    const hidden = { ...ledgerWith(reviewed, [advisory()]), branch: `${branch}\u202Ey` };
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 1, ledger: hidden, readPaths: new Set(["docs/a.md"]) }) });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.deepEqual(run.advisoryIssues, []);
    assert.ok([...run.logs, ...logged].some((line) => /Advisory findings can't be listed/.test(line)), [...run.logs, ...logged].join("\n"));
  });

  it("logs nothing about a dropped issue when no Advisory finding is open", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    const run = host([0, 0], { localReview: recorded([openFinding()]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.ok(![...run.logs, ...logged].some((line) => /Advisory findings can't be listed/.test(line)));
  });

  it("files nothing when no Advisory finding is open", async () => {
    const run = host([0, 0], { localReview: recorded([openFinding(), advisory({ status: "fixed", test: null, reason: "Reworded." })]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.advisoryIssues, []);
  });

  it("leaves a security finding out of the public issue, whatever its grade", async () => {
    const run = host([0, 0], { localReview: recorded([advisory(), advisory({ id: "R7", security: true, summary: "The token reaches the log line." })]) });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(run.advisoryIssues.length, 1);
    assert.doesNotMatch(run.advisoryIssues[0]?.body ?? "", /R7|token reaches/);
  });

  it("files nothing when the review didn't finish", async () => {
    const run = host([0, 0], { localReview: async (args) => ({ status: "failed", head: args.startHead, reason: "the Bar reviewer timed out" }) });

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.advisoryIssues, []);
    assert.equal(result.findingsUnlisted, undefined, "a review that didn't finish recorded no findings to lose");
  });

  const filed = (findings: Ledger["findings"], options: Parameters<typeof host>[1] = {}) =>
    host([0, 0], { localReview: recorded(findings), ...options });

  it("files the issue only once the branch is published", async () => {
    const run = filed([advisory()]);

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.publishEvents.slice(-2), ["publish", "file-advisory"]);
  });

  it("files nothing when the secret scan refuses the branch", async () => {
    const run = filed([advisory()], { leaksSecret: sampleSecretMatch });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.advisoryIssues, []);
  });

  it("files nothing when publishing fails", async () => {
    const run = filed([advisory()], { publishError: "push rejected" });

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.advisoryIssues, []);
  });

  it("leaves a finding whose summary holds a secret out of the issue, and files the rest", async () => {
    const run = filed([advisory(), advisory({ id: "R6", summary: `Hard-coded ${"gh"}p_${"A".repeat(36)} in the page.` })]);
    run.buildHost.publicError = (text) => publicErrorText(String(text), (cleaned) => cleaned.includes("ghp_"));

    await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(run.advisoryIssues.length, 1);
    assert.match(run.advisoryIssues[0]?.body ?? "", /R5/);
    assert.doesNotMatch(run.advisoryIssues[0]?.body ?? "", /R6|ghp_/);
  });

  it("leaves a finding whose path the review didn't read out of the issue", async () => {
    const run = filed([advisory({ path: "docs/unread.md" })]);

    await buildIssue(issue, branch, base, run.buildHost);

    assert.deepEqual(run.advisoryIssues, []);
  });

  it("ends the run red, as findings nobody sees, when open Advisory findings exist and none of them can be listed", async (t) => {
    t.mock.method(console, "error", () => {});
    const run = filed([advisory({ path: "docs/unread.md" })]);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(result.findingsUnlisted, true);
    assert.equal(result.findingsLost, undefined);
    assert.deepEqual(run.advisoryIssues, []);
  });

  it("does not mark findings unlisted for a branch that isn't published, whatever the findings", async (t) => {
    t.mock.method(console, "error", () => {});
    const refused = filed([advisory({ path: "docs/unread.md" })], { leaksSecret: sampleSecretMatch });
    const failed = filed([advisory({ path: "docs/unread.md" })], { publishError: "push rejected" });

    for (const run of [refused, failed]) {
      const result = await buildIssue(issue, branch, base, run.buildHost);

      assert.notEqual(result.outcome, "published");
      assert.equal(result.findingsUnlisted, undefined);
    }
  });

  it("does not end the run red when only some of the open Advisory findings can't be listed", async () => {
    const run = filed([advisory(), advisory({ id: "R6", path: "docs/unread.md" })]);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.findingsUnlisted, undefined);
    assert.equal(run.advisoryIssues.length, 1);
  });

  it("does not end the run red when the review left no open Advisory finding", async () => {
    const run = filed([]);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.findingsUnlisted, undefined);
    assert.equal(result.findingsLost, undefined);
  });

  it("leaves a finding that reads like a Review notes section out of the issue", async () => {
    const run = filed([advisory(), advisory({ id: "R6", summary: "Add a Review notes section." })]);

    await buildIssue(issue, branch, base, run.buildHost);

    assert.doesNotMatch(run.advisoryIssues[0]?.body ?? "", /R6/);
  });

  it("still files the findings for a branch whose name holds the words review notes", async () => {
    const named = "feature/12-add-review-notes-section";
    const ledger = { ...ledgerWith(reviewed, [advisory()]), branch: named };
    const run = host([0, 0], { localReview: async () => ({ status: "recorded", head: reviewed, rounds: 1, ledger, readPaths: new Set(["docs/a.md"]) }) });
    run.buildHost.publicError = (text) => publicErrorText(String(text));

    await buildIssue(issue, named, base, run.buildHost);

    assert.equal(run.advisoryIssues.length, 1);
    assert.match(run.advisoryIssues[0]?.body ?? "", /R5/);
    assert.match(run.advisoryIssues[0]?.body ?? "", /feature\/12-add-review-notes-section/);
  });

  it("files nothing, and says so, when the issue's text as a whole isn't safe to publish", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    const run = filed([advisory()]);
    run.buildHost.publicError = (text) => (String(text).includes("Advisory findings from the local review") ? "(withheld)" : String(text));
    run.logs.length = 0;

    const withheld = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(withheld.findingsUnlisted, true, "no follow-up issue was filed, so the run must end red");

    assert.deepEqual(run.advisoryIssues, []);
    assert.ok(run.logs.some((line) => /follow-up issue/.test(line)) || logged.some((line) => /follow-up issue/.test(line)), [...run.logs, ...logged].join("\n"));
  });

  it("retries filing the issue after a GitHub server error", async () => {
    const run = host([0, 0], { localReview: recorded([advisory()]) });
    let attempts = 0;
    run.buildHost.wait = async () => {};
    run.buildHost.fileAdvisoryIssue = () => {
      if (++attempts === 1) throw new Error("gh issue create failed:\nHTTP 503: Service Unavailable");
    };

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(attempts, 2);
  });

  it("still publishes the PR when filing the issue fails, tries once, and logs the failure", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    const run = host([0, 0], { localReview: recorded([advisory()]) });
    let attempts = 0;
    run.buildHost.fileAdvisoryIssue = () => {
      attempts++;
      throw new Error("gh issue create failed");
    };

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(attempts, 1, "a failure that isn't a GitHub server error is not retried");
    assert.ok(run.publishEvents.includes("publish"));
    assert.ok(logged.some((line) => /filing the follow-up issue/.test(line)), logged.join("\n"));
  });

  // A failed filing must leave a trace: on an ephemeral runner the ledger is gone, so the Advisory findings are posted on the Sandcastle issue instead.
  it("posts the findings on the Sandcastle issue when filing the follow-up issue fails, so they are not lost", async (t) => {
    t.mock.method(console, "error", () => {});
    const comments: { issue: number; body: string }[] = [];
    const run = host([0, 0], { localReview: recorded([advisory()]) });
    run.buildHost.commentOnIssue = (n, body) => void comments.push({ issue: n, body });
    run.buildHost.fileAdvisoryIssue = () => {
      throw new Error("gh issue create failed");
    };

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(result.findingsLost, undefined, "the comment on the issue holds the findings, so nothing is lost");
    const posted = comments.filter((comment) => /follow-up issue/.test(comment.body));
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.issue, issue.number);
    assert.match(posted[0]?.body ?? "", /couldn't file the follow-up issue/);
    assert.match(posted[0]?.body ?? "", /R5 docs\/a\.md:4: A stale sentence\./);
    assert.ok(posted[0]?.body.includes(result.prUrl ?? "no PR url"), "the comment names the pull request");
  });

  it("still publishes, and logs both failures, when the comment on the findings fails too", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => void logged.push(String(line)));
    const run = host([0, 0], { localReview: recorded([advisory()]) });
    run.buildHost.commentOnIssue = () => {
      throw new Error("gh issue comment failed");
    };
    run.buildHost.fileAdvisoryIssue = () => {
      throw new Error("gh issue create failed");
    };

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(result.findingsLost, true, "the findings are in the log only, so the run must end red");
    assert.ok(logged.some((line) => /filing the follow-up issue/.test(line)));
    assert.ok(logged.some((line) => /posting the Advisory findings/.test(line)), logged.join("\n"));
  });

  it("posts nothing on the Sandcastle issue when the follow-up issue is filed", async () => {
    const comments: string[] = [];
    const run = host([0, 0], { localReview: recorded([advisory()]) });
    run.buildHost.commentOnIssue = (_n, body) => void comments.push(body);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.findingsLost, undefined, "a filed issue loses nothing");
    assert.ok(!comments.some((body) => /couldn't file the follow-up issue/.test(body)));
  });

  it("gives up filing after the last attempt of a GitHub server error, and still publishes", async (t) => {
    t.mock.method(console, "error", () => {});
    const run = host([0, 0], { localReview: recorded([advisory()]) });
    let attempts = 0;
    run.buildHost.wait = async () => {};
    run.buildHost.fileAdvisoryIssue = () => {
      attempts++;
      throw new Error("gh issue create failed:\nHTTP 503: Service Unavailable");
    };

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "published");
    assert.equal(attempts, PUBLISH_RETRY_ATTEMPTS);
  });
});

describe("buildIssue when the open PR can't be held as a draft", () => {
  it("says nothing was pushed and the PR must be made a draft, files nothing and publishes nothing", async () => {
    const comments: string[] = [];
    // A blocking finding makes the build hold the PR, and an open Advisory one is what the follow-up issue would list: the issue must not be filed for a branch
    // that was never pushed.
    const reviewed = "c".repeat(40);
    const findings = [openFinding(), openFinding({ id: "R2", severity: "advisory", path: "docs/a.md", line: 4, summary: "A stale sentence.", fix: "Reword it." })];
    const run = host([0, 0], {
      publishHoldFailed: true,
      localReview: async () =>
        ({ status: "recorded", head: reviewed, rounds: 1, ledger: ledgerWith(reviewed, findings), readPaths: new Set(["src/app.ts", "docs/a.md"]) }) as const,
    });
    run.buildHost.commentOnIssue = (_n, body) => void comments.push(body);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "not published");
    assert.equal(result.publishFailed, true);
    assert.equal(comments.length, 1);
    assert.match(comments[0] ?? "", /gh pr ready feature\/69-run-the-gate --undo/);
    assert.match(comments[0] ?? "", /Nothing was pushed/);
    assert.doesNotMatch(comments[0] ?? "", /push it\s+from its worktree/);
    assert.deepEqual(run.advisoryIssues, []);
  });
});

// A review that didn't finish holds the PR too, with no finding to fix or accept: the hand-back comment for a PR that couldn't be made a draft says the review didn't finish, and the one for a publish that failed after the hold says to run it again.
describe("buildIssue when a review that didn't finish held the PR and publishing failed", () => {
  const unfinished = { localReview: async (args: { startHead: string }) => ({ status: "failed", head: args.startHead, reason: "the Bar reviewer timed out" }) as const };

  it("says the review didn't finish when the PR can't be made a draft", async () => {
    const comments: string[] = [];
    const run = host([0, 0], { publishHoldFailed: true, ...unfinished });
    run.buildHost.commentOnIssue = (_n, body) => void comments.push(body);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "not published");
    assert.match(comments[0] ?? "", /the review didn't finish/);
    assert.doesNotMatch(comments[0] ?? "", /left findings open/);
  });

  it("says the review didn't finish and to run it again, not to accept findings, when publishing fails after the hold", async () => {
    const comments: string[] = [];
    const run = host([0, 0], { publishError: "git push --quiet origin abc:refs/heads/x failed:\n ! [rejected] abc -> x (non-fast-forward)", ...unfinished });
    run.buildHost.commentOnIssue = (_n, body) => void comments.push(body);

    await buildIssue(issue, branch, base, run.buildHost);

    assert.match(comments[0] ?? "", /the review didn't finish and the pull request was held as a draft/);
    assert.match(comments[0] ?? "", /until the review has been run again and nothing is open/);
    assert.doesNotMatch(comments[0] ?? "", /fixed or accepted|left findings open/);
  });
});

// A push or a PR create that fails after the hold leaves a draft: the comment must say so, not send a person to open a second PR.
describe("buildIssue when publishing fails after the PR was held as a draft", () => {
  const reviewed = "c".repeat(40);
  const blocked = () =>
    host([0, 0], {
      publishError: "git push --quiet origin abc:refs/heads/x failed:\n ! [rejected] abc -> x (non-fast-forward)",
      localReview: async () =>
        ({ status: "recorded", head: reviewed, rounds: 1, ledger: ledgerWith(reviewed, [openFinding()]), readPaths: new Set(["src/app.ts"]) }) as const,
    });

  it("says the pull request may already be a draft and why, to find it rather than open another, and to mark it ready only once nothing is open", async () => {
    const comments: string[] = [];
    const run = blocked();
    run.buildHost.commentOnIssue = (_n, body) => void comments.push(body);

    const result = await buildIssue(issue, branch, base, run.buildHost);

    assert.equal(result.outcome, "not published");
    assert.equal(comments.length, 1);
    assert.match(comments[0] ?? "", /held as a draft/);
    assert.match(comments[0] ?? "", /gh pr list --head feature\/69-run-the-gate/);
    assert.match(comments[0] ?? "", /scripts\/review\.sh accept/);
    // The ledger stayed on the runner: accept needs a ledger from a local /pre-push-review first.
    assert.match(comments[0] ?? "", /ledger is on the runner: run `\/pre-push-review` on the branch first, then `scripts\/review\.sh accept <id> <reason>`/);
    assert.doesNotMatch(comments[0] ?? "", /open one by hand/);
    assert.match(comments[0] ?? "", /non-fast-forward/);
  });

  it("keeps the generic wording, which sends a person to open the PR by hand, when nothing held the PR", async () => {
    const comments: string[] = [];
    const run = host([0, 0], { publishError: "gh pr create failed:\n remote: Internal Server Error" });
    run.buildHost.commentOnIssue = (_n, body) => void comments.push(body);

    await buildIssue(issue, branch, base, run.buildHost);

    assert.match(comments[0] ?? "", /open one by hand/);
    assert.doesNotMatch(comments[0] ?? "", /held as a draft/);
  });
});

// publish's live defaults, run against a fake `gh` that is the only program on PATH, so a test can never reach the real gh and its login: the hold must reach gh
// before the push, and a created PR must carry --draft and DRAFT_NOTE.
describe("publish's default hold and PR creation", { skip: process.platform === "win32" }, () => {
  const withFakeGh = async (
    listed: string,
    body: (log: () => string[], created: () => string, edited: () => string) => Promise<void>,
    repoAnswer = "o/r",
    viewBody = "",
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    const logFile = join(dir, "calls.log");
    const createdFile = join(dir, "created-body.txt");
    const editedFile = join(dir, "edited-body.txt");
    const viewFile = join(dir, "view.json");
    writeFileSync(viewFile, JSON.stringify({ body: viewBody }));
    // Shell builtins only, since PATH holds nothing else: it logs its arguments, answers `repo view`, `pr list`, `pr view` and `pr create` (keeping its body), and reads and drops the input of anything else, such as the hold's `pr ready`.
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${logFile}"`,
        'case "$1 $2" in',
        `  "repo view") echo ${repoAnswer} ;;`,
        `  "pr list") echo '${listed}' ;;`,
        `  "pr view") read -r answer < "${viewFile}"; printf '%s\\n' "$answer" ;;`,
        `  "pr edit") while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line" >> "${editedFile}"; done ;;`,
        `  "pr create") while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line" >> "${createdFile}"; done; echo https://github.com/o/r/pull/9 ;;`,
        "  *) while IFS= read -r line || [ -n \"$line\" ]; do :; done ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const saved = process.env.PATH;
    // Whatever an earlier use or test cached is not the fake's answer.
    forgetRepoName();
    process.env.PATH = dir;
    try {
      // The fake must be what runs: were it unrunnable the real gh, with the developer's login, would not be reachable either (PATH holds nothing else).
      assert.equal(String(hostExecFileSync("gh", ["repo", "view"], { encoding: "utf8" })).trim(), repoAnswer);
      rmSync(logFile);
      await body(
        () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []),
        () => (existsSync(createdFile) ? readFileSync(createdFile, "utf8") : ""),
        () => (existsSync(editedFile) ? readFileSync(editedFile, "utf8") : ""),
      );
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
      // The fake's repository name must not stay cached for the tests that follow.
      forgetRepoName();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  const open = (isDraft: boolean) =>
    JSON.stringify([{ number: 4, headRefName: branch, isCrossRepository: false, isDraft, url: "https://github.com/o/r/pull/4" }]);

  it("forgets a repository name cached before it starts, so the fake's own answer is read", async () => {
    await withFakeGh("[]", async () => {
      assert.equal(repoName(), "o/r");
      await withFakeGh("[]", async () => assert.equal(repoName(), "p/q"), "p/q");
    });
  });

  // Not through withFakeGh, whose start forgets the name too and would hide a missing forget at its end.
  it("forgets the repository name the fake gh gave, so a later use reads its own", async () => {
    await withFakeGh("[]", async () => assert.equal(repoName(), "o/r"));
    const dir = mkdtempSync(join(tmpdir(), "later-gh-"));
    writeFileSync(join(dir, "gh"), "#!/bin/sh\necho x/y\n", { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      assert.equal(repoName(), "x/y");
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
      forgetRepoName();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("turns the ready PR for the branch into a draft before the push, not only in the later create hop", async () => {
    await withFakeGh(open(false), async (calls) => {
      const atPush: string[][] = [];
      await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => void atPush.push(calls()), undefined, async () => {}, "note", true);

      assert.equal(atPush.length, 1);
      assert.ok(atPush[0]!.some((line) => line.startsWith("pr ready 4") && line.includes("--undo")), `at the push: ${atPush[0]!.join(" | ")}`);
    });
  });

  it("takes the draft note out of an existing draft on a rerun that no longer holds it, and does not convert it", async () => {
    await withFakeGh(
      open(true),
      async (calls, _created, edited) => {
        await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, undefined, async () => {}, "", false);

        assert.ok(calls().some((line) => line.startsWith("pr view 4")), calls().join("\n"));
        assert.ok(calls().some((line) => line.startsWith("pr edit 4")), calls().join("\n"));
        assert.ok(!calls().some((line) => line.startsWith("pr ready")), calls().join("\n"));
        assert.ok(!edited().includes(DRAFT_NOTE), edited());
        assert.match(edited(), /Why it was built/);
      },
      "o/r",
      `Why it was built.\n\n${DRAFT_NOTE}`,
    );
  });

  it("creates a new PR as a draft with the draft note in its body when nothing is open", async () => {
    await withFakeGh("[]", async (calls, created) => {
      await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, undefined, async () => {}, "note", true);

      assert.ok(calls().some((line) => line.startsWith("pr create") && line.includes("--draft")), calls().join("\n"));
      assert.ok(created().includes(DRAFT_NOTE), created());
    });
  });

  it("creates a ready PR with no draft wording, and holds none, when nothing holds it", async () => {
    await withFakeGh("[]", async (calls, created) => {
      await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, undefined, async () => {}, "", false);

      assert.ok(calls().some((line) => line.startsWith("pr create") && !line.includes("--draft")), calls().join("\n"));
      assert.ok(!calls().some((line) => line.startsWith("pr ready")));
      assert.ok(!created().includes(DRAFT_NOTE));
    });
  });
});

describe("publish holds an existing PR before it pushes", () => {
  const note = "The local review left these findings open:\n\n- R1 critical src/app.ts:12";
  const args = (order: string[]) => ({
    push: () => void order.push("push"),
    create: () => (order.push("create"), "https://github.com/o/r/pull/1"),
    hold: () => void order.push("hold"),
  });

  it("turns a ready PR into a draft before the push, so new commits never sit on a ready PR", async () => {
    const order: string[] = [];
    const { push, create, hold } = args(order);

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, create, async () => {}, note, true, hold);

    assert.deepEqual(order, ["hold", "push", "create"]);
  });

  it("does not push when the PR can't be held, and rejects with a HoldFailedError naming the branch and keeping the cause", async () => {
    const order: string[] = [];
    const { push, create } = args(order);
    const cause = new Error("gh pr ready failed: HTTP 422");

    await assert.rejects(
      publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, create, async () => {}, note, true, () => {
        throw cause;
      }),
      (error: unknown) => error instanceof HoldFailedError && error.message.includes(branch) && /HTTP 422/.test(error.message) && error.cause === cause,
    );
    assert.deepEqual(order, []);
  });

  it("rejects with the push's own error, not a HoldFailedError, when the hold worked and the push fails", async () => {
    const failure = new Error("git push failed: non-fast-forward");

    await assert.rejects(
      publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => { throw failure; }, () => "u", async () => {}, note, true, () => {}),
      (error: unknown) => error === failure && !(error instanceof HoldFailedError),
    );
  });

  it("rejects with the create's own error, not a HoldFailedError, when the hold and the push worked and the create fails", async () => {
    const failure = new Error("gh pr create failed: validation");

    await assert.rejects(
      publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, () => { throw failure; }, async () => {}, note, true, () => {}),
      (error: unknown) => error === failure && !(error instanceof HoldFailedError),
    );
  });


  it("retries holding the PR after a GitHub server error", async () => {
    let attempts = 0;
    const order: string[] = [];
    const { push, create } = args(order);

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, create, async () => {}, note, true, () => {
      if (++attempts === 1) throw new Error("gh pr ready failed:\nHTTP 503: Service Unavailable");
    });

    assert.equal(attempts, 2);
    assert.deepEqual(order, ["push", "create"]);
  });

  it("does not look for a PR to hold when nothing holds the PR", async () => {
    const order: string[] = [];
    const { push, create, hold } = args(order);

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], push, create, async () => {}, "", false, hold);

    assert.deepEqual(order, ["push", "create"]);
  });
});

describe("publish with the review holding the PR as a draft", () => {
  const create = () => {
    const calls: { body: string; draft: boolean | undefined }[] = [];
    return { calls, createPullRequest: (_branch: string, _title: string, body: string, draft?: boolean) => (calls.push({ body, draft }), "https://github.com/o/r/pull/1") };
  };
  const note = "The local review left these findings open (their details are in the local review record):\n\n- R1 critical src/app.ts:12";

  it("opens the PR as a draft and says why in its body, naming what a person does", async () => {
    const { calls, createPullRequest } = create();

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest, async () => {}, note, true, () => {});

    assert.equal(calls[0]?.draft, true);
    const body = calls[0]?.body ?? "";
    assert.match(body, /draft/i);
    assert.match(body, /scripts\/review\.sh accept/);
    assert.match(body, /gh pr ready/);
    assert.ok(body.includes(note), "the note of the open findings stays in the body");
  });

  it("opens the PR ready, with no draft wording, when nothing holds it", async () => {
    const { calls, createPullRequest } = create();

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest, async () => {}, "", false);

    assert.equal(calls[0]?.draft, false);
    assert.doesNotMatch(calls[0]?.body ?? "", /draft|gh pr ready/i);
  });

  it("opens the PR ready by default", async () => {
    const { calls, createPullRequest } = create();

    await publish(issue, branch, "a".repeat(40), true, false, undefined, [], () => {}, createPullRequest, async () => {});

    assert.equal(calls[0]?.draft, false);
  });

  it("keeps the marker, Closes and the reason whole when the description is cut to fit", async () => {
    const { calls, createPullRequest } = create();

    await publish(issue, branch, "a".repeat(40), true, false, `## Why\n\n${"x".repeat(80_000)}`, [], () => {}, createPullRequest, async () => {}, note, true, () => {});

    const body = calls[0]?.body ?? "";
    assert.ok(body.length <= PR_BODY_TOTAL_LIMIT, String(body.length));
    assert.ok(body.length >= PR_BODY_TOTAL_LIMIT - 100, `the room is used, not just under GitHub's cap: ${body.length}`);
    assert.match(body, /^<!-- sandcastle:pr -->\nCloses #69\n/);
    assert.match(body, /gh pr ready/);
  });
});
