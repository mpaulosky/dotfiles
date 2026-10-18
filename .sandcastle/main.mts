// Parallel Planner with Review — plan → execute → review → PR loop
//
// This template drives a multi-phase workflow:
//   Phase 0 (Housekeeping):     Two steps that need no agent. First the
//                               follow-up sweep (lib/follow-up.mts): for each
//                               open PR the host published for an in-scope
//                               issue, it re-requests a Copilot review that
//                               never came, updates a settled PR that's only
//                               behind main on GitHub, and logs one that needs
//                               a follow-up pass; and it hands back an issue
//                               whose latest PR closed without merging. Then
//                               the host closes as completed every umbrella
//                               (an issue intake split) whose sub-issues have
//                               all closed as completed (lib/umbrella.mts).
//                               Then the early exit (lib/work.mts): with no
//                               issue for intake, no ready unblocked issue and
//                               no PR that needs a follow-up pass, the run
//                               exits 0 before any sandbox or agent starts.
//                               Then the follow-up passes
//                               (lib/follow-up-pass.mts): for each PR the
//                               sweep logged, one sandbox merges main in when
//                               needed, the follow-up role resolves conflicts
//                               and the bot's and owner's review threads, and
//                               the host gates and pushes the result, then
//                               replies to and resolves the bot threads.
//   Phase 0a (Intake):          One run judges every open issue that carries
//                               none of sandcastle:ready, sandcastle:needs-info
//                               and sandcastle:needs-human against the
//                               Definition of Ready (intake-prompt.md). The
//                               host adds sandcastle:ready, or hands the issue
//                               back with sandcastle:needs-info and numbered
//                               questions, or splits an issue too big for one
//                               PR into blocked child issues and turns it into
//                               an umbrella, and adds bug when the verdict says
//                               so (lib/intake.mts).
//   Phase 0b (Gate):            The host resolves each open issue's blockers
//                               (GitHub "blocked by" links and "Blocked by #N"
//                               / "Depends on #N" lines) and holds back every
//                               issue whose blocker hasn't landed yet, that
//                               already has an open PR, that another run is
//                               building (sandcastle:building), that intake
//                               hasn't marked sandcastle:ready, or that's
//                               handed back (sandcastle:needs-info or
//                               sandcastle:needs-human).
//   Phase 1 (Plan):             The planner analyzes the ready issues, builds
//                               a dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues.
//   Phase 1b (Critique):        A second run checks whether the picks are safe
//                               to build in parallel and defers the ones that
//                               aren't behind a native "blocked by" link. The
//                               host names each remaining pick's branch and
//                               fetches it if it exists.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(), and the issue carries
//                               sandcastle:building until its build ends,
//                               however it ends. The architect, when the
//                               planner picked it, writes a design note the
//                               host posts on the issue. The tester commits
//                               failing tests, then the backend developer and,
//                               when picked, the UI developer make them pass;
//                               if any of these fails, the issue stops for the
//                               round. If the branch is then ahead of main (this
//                               run's commits or earlier ones), the host runs
//                               scripts/gate.sh in the sandbox (checkpoint 1),
//                               the scribe (when picked) documents the change,
//                               a reviewer runs, main is merged in when the
//                               branch doesn't contain it, and the gate runs
//                               again (checkpoint 2). A red gate gets two gate-fixer
//                               attempts per checkpoint; past that nothing is
//                               pushed. A red checkpoint or a failed architect,
//                               tester, backend or UI run is a failed build
//                               attempt: the first gets a comment, the second
//                               hands the issue back with sandcastle:needs-human
//                               (lib/handback.mts). A failed scribe or reviewer
//                               still publishes, with a note in the PR.
//                               Otherwise the host scans the commits for the
//                               sandbox's secrets, pushes the commit the gate
//                               passed on from the main checkout with git hooks
//                               off, and opens a pull request that closes its
//                               issue (lib/host-safety.mts). All issue
//                               pipelines run concurrently via
//                               Promise.allSettled().
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round. The loop stops early when a round
// opens no pull request, but not when the critique defers every pick.
//
// The run also stops cleanly, exiting 0, once it can't finish more work
// (lib/limits.mts, #147): no new round or role run starts after
// SANDCASTLE_BUDGET_MINUTES (default 240) have passed since it started, and
// once a role run hits Claude's usage or rate limit no role starts; a build
// whose roles all finished still publishes, since that costs no usage.
// Neither stop counts as a failed build attempt. A stopped build's commits
// weren't pushed, so an ephemeral runner drops them, and the next run
// rebuilds the issue from what GitHub has.
//
// Every role's model, effort, iteration cap and timeout comes from ROLE_AGENTS
// in lib/config.mts. The sandbox gets no GitHub token: the host reads GitHub
// with its own gh auth and passes each role what it needs through its prompt.
//
// Every phase reads the queue through lib/queue.mts#loadQueue, scoped to the
// run's queue (lib/config.mts#queueScopeFrom): in GitHub Actions every issue
// labelled Sandcastle, and locally only the issue or label the command line
// names. Within it, an issue reaches the phases only when the repository
// owner added its queue label and nobody else has edited it since; anything
// else is skipped and logged. An untrusted sandcastle:ready is removed, and
// a hand-back label someone else removed is put back (#146).
//
// Usage:
//   SANDCASTLE_ISSUE=<n> pnpm run sandcastle         (only issue #n and its PR)
//   SANDCASTLE_LABEL=<label> pnpm run sandcastle     (the issues labelled <label>, e.g. Sandcastle:dev)

import { existsSync, readFileSync } from "node:fs";
import { buildIssue } from "./lib/build.mts";
import { clearStaleBuildingLabels, installBuildingLabelRelease, releaseAllBuildingLabels } from "./lib/building.mts";
import { fetchMain, prepareBranches } from "./lib/branches.mts";
import {
  BudgetError,
  budgetMinutesFrom,
  BUILDING_LABEL,
  describeQueueScope,
  MAX_ITERATIONS,
  QueueScopeError,
  queueScopeFrom,
  type QueueScope,
} from "./lib/config.mts";
import { critiqueRound } from "./lib/critique.mts";
import { UncountedStopError } from "./lib/errors.mts";
import { followUpPassPhase } from "./lib/follow-up-pass.mts";
import { followUpPhase } from "./lib/follow-up.mts";
import { gateIssues } from "./lib/gate.mts";
import { cacheHostLogin, ensureLabels, openPullRequests, repoName } from "./lib/github.mts";
import { protectHostGit } from "./lib/host-safety.mts";
import { intakePhase } from "./lib/intake.mts";
import { runLimits } from "./lib/limits.mts";
import { planRound, resolveRoles } from "./lib/plan.mts";
import { loadQueue, startQueueRound, useQueueScope } from "./lib/queue.mts";
import {
  handBackReport,
  humanThreadReport,
  intakeStopExitCode,
  intakeStopReport,
  outcomeReport,
  renderSummary,
  REPORT_DIR,
  usageReport,
  waitingPrReport,
  writeRunReport,
  type RunEnding,
} from "./lib/report.mts";
import { roundOutcomes, roundSummary } from "./lib/round.mts";
import { githubTokensIn } from "./lib/sandbox-env.mts";
import { forgetGatedHead } from "./lib/shell.mts";
import { umbrellaPhase } from "./lib/umbrella.mts";
import { findWork } from "./lib/work.mts";

// The queue scope comes first, so a local run that names none exits with
// the usage message before it touches git, gh or a sandbox (#146).
let scope: QueueScope;
try {
  scope = queueScopeFrom(process.env);
} catch (error) {
  if (!(error instanceof QueueScopeError)) throw error;
  console.error(error.message);
  process.exit(2);
}
useQueueScope(scope);
console.log(`Queue: ${describeQueueScope(scope)}`);

// The time budget is read just as early, so a bad value exits the same way.
// Its clock starts here, as close to the job's own start as it gets (#147).
let budgetMinutes: number;
try {
  budgetMinutes = budgetMinutesFrom(process.env);
} catch (error) {
  if (!(error instanceof BudgetError)) throw error;
  console.error(error.message);
  process.exit(2);
}
runLimits.start(budgetMinutes);
console.log(`Time budget: ${budgetMinutes} minutes`);

// How the run ended, for the run report: set to "finished" or "stopped" by
// the try below, so anything that throws past it reads as a crash.
let ending: RunEnding = { kind: "crashed" };

// Whether protectHostGit() has pinned every git command's environment. Only
// past this point is it safe for the finally's reportRepo() to shell out to
// gh, which reads git remotes: before it, a planted .git/commondir (the case
// protectHostGit() guards against) could make gh read a config an agent
// wrote. Set once startup has finished, not right after protectHostGit()
// itself, so one failed later startup step (ensureLabels, cacheHostLogin)
// still leaves the report unlinked rather than guess which of them left git
// safe to use.
let startedUp = false;

// An UncountedStopError from any phase (intake, the planner, the critique)
// means the budget has passed or Claude's usage limit was hit: the catch below
// ends the run cleanly rather than crash, since the next run picks the work up.
// The try starts this early so its finally writes the run report
// (.sandcastle/logs/) after every run that got past reading its arguments,
// even one that fails a startup check: a workflow step reads handbacks.json.
try {
  const envFile = ".sandcastle/.env";
  const leakedTokens = existsSync(envFile) ? githubTokensIn(readFileSync(envFile, "utf8")) : [];
  if (leakedTokens.length > 0) {
    throw new Error(
      `${envFile} sets ${leakedTokens.join(" and ")}, which Sandcastle would pass into the sandbox. ` +
        "Remove it: the host uses its own gh auth, and agents must not reach GitHub.",
    );
  }

  // Every git command this process starts, Sandcastle's included, runs with hooks
  // off and its config pinned to this repository's .git: agents can write hooks
  // and files that point git elsewhere. Throws if .git/commondir exists. See
  // lib/host-safety.mts, which also keeps .git/config and .git/hooks read-only in
  // every sandbox.
  protectHostGit();
  forgetGatedHead();

  // The hand-backs and intake add sandcastle:* labels, which gh can't add until
  // the repository has them. The host's login, which the failed-attempt count
  // filters by, is read now so a token that can't read it fails before any work.
  ensureLabels();
  cacheHostLogin();

  // Release the labels this run holds however the process ends (see
  // lib/building.mts).
  installBuildingLabelRelease(process);

  // A run that crashed left sandcastle:building on the issue it was building.
  // Only a label older than any real build is cleared, so a live run's stays.
  for (const issueNumber of clearStaleBuildingLabels()) {
    console.log(`  🧹 #${issueNumber}: cleared a stale ${BUILDING_LABEL} label left by a run that didn't finish.`);
  }

  startedUp = true;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    // No new round once the budget has passed or the usage limit was hit.
    const stopReason = runLimits.stopReason();
    if (stopReason !== undefined) {
      console.log(`⏹ ${stopReason}, so no new round starts.`);
      break;
    }

    console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    // -----------------------------------------------------------------------
    // Phase 0: Housekeeping
    // -----------------------------------------------------------------------
    // The sweep runs first, even in a round that then exits early. A failure
    // in either step is logged, and the step runs again next round.
    // Every phase below loads the queue; they share one read of each issue
    // this round.
    startQueueRound();
    const { needsPass, passes } = followUpPhase();
    umbrellaPhase();

    // No build of this run is going between rounds, so any label it still
    // holds is one whose removal failed: try again before the work check
    // and the gate, which would otherwise hold the issue back for the rest
    // of the run.
    for (const issueNumber of releaseAllBuildingLabels()) {
      console.log(`  🧹 #${issueNumber}: removed ${BUILDING_LABEL}, which an earlier round couldn't.`);
    }

    // The early exit: before intake, the first step that can start Claude,
    // and before any sandbox needs the Docker image. A failed read here ends
    // the run red, as a failed gate does.
    const found = findWork(needsPass);
    if (found === undefined) {
      console.log(
        `Nothing to do in ${describeQueueScope(scope)}: no issue for intake, no ready unblocked issue and no PR ` +
          "that needs a follow-up pass. Exiting.",
      );
      break;
    }
    console.log(`Work found: ${found}`);

    // -----------------------------------------------------------------------
    // Phase 0 (continued): Follow-up passes
    // -----------------------------------------------------------------------
    // See lib/follow-up-pass.mts#followUpPassPhase: each pass runs in its own
    // sandbox, in parallel, and the build phase starts after them. A failed
    // pass is logged and the sweep finds its PR again next round.
    if (passes.length > 0) {
      const passBase = fetchMain();
      await followUpPassPhase(passes, loadQueue(), passBase);
    }

    // -----------------------------------------------------------------------
    // Phase 0a: Intake
    // -----------------------------------------------------------------------
    // See lib/intake.mts#intakePhase: a failed intake is logged and costs only
    // the issues it was judging this round.
    await intakePhase(() => ({ issues: loadQueue(), openPrs: openPullRequests() }));

    // -----------------------------------------------------------------------
    // Phase 0b: Gate
    // -----------------------------------------------------------------------
    const { ready, blocked } = gateIssues();

    for (const { issue, reasons } of blocked) {
      console.log(`  ⏸ #${issue.number} is held back: ${reasons.join("; ")}`);
    }

    if (ready.length === 0) {
      console.log(
        blocked.length > 0
          ? "Every open issue is waiting on a blocker, a pull request, another run, intake or a human. Exiting."
          : `No open, owner-approved issues in the queue (${describeQueueScope(scope)}). Exiting.`,
      );
      break;
    }

    // -----------------------------------------------------------------------
    // Phase 1: Plan
    // -----------------------------------------------------------------------
    const planned = await planRound(ready);

    if (planned.length === 0) {
      // No unblocked work — either everything is done or everything is blocked.
      console.log("No unblocked issues to work on. Exiting.");
      break;
    }

    // planRound keeps only ids from the ready list, so the lookup can't miss.
    // Each pick's optional roles (lib/config.mts#OptionalRole) come from the
    // planner's raw roles field, resolved to a safe list by resolveRoles
    // (lib/plan.mts), which falls back to every optional role when it's
    // missing or invalid.
    const readyById = new Map(ready.map((issue) => [String(issue.number), issue]));
    const picks = planned.map((issue) => ({ ...readyById.get(issue.id)!, roles: resolveRoles(issue.roles) }));

    // -----------------------------------------------------------------------
    // Phase 1b: Critique
    // -----------------------------------------------------------------------
    // critiqueRound only filters the picks, so its SandcastleIssue[] return
    // type is narrower than what it's given; put each kept pick's roles back
    // by issue number rather than widen the critique's own types for a field
    // it never reads.
    const rolesByNumber = new Map(picks.map((issue) => [issue.number, issue.roles]));
    const pickedNumbers = new Set(picks.map((issue) => issue.number));
    const critiqued = await critiqueRound({
      picks,
      inFlight: blocked.flatMap(({ issue, pr }) => (pr ? [{ issue, pr }] : [])),
      unpicked: ready.filter((issue) => !pickedNumbers.has(issue.number)),
    });
    const issues = critiqued.map((issue) => ({ ...issue, roles: rolesByNumber.get(issue.number)! }));

    if (issues.length === 0) {
      // Each deferral added a "blocked by" link, so the next round's gate
      // holds those issues back and the planner picks from what's left.
      console.log("The critique deferred every pick. Moving on to the next round.");
      continue;
    }

    // -----------------------------------------------------------------------
    // Phase 2: Execute + Review
    //
    // Promise.allSettled means one failing pipeline doesn't cancel the others.
    // -----------------------------------------------------------------------
    const base = fetchMain();
    const work = prepareBranches(issues);

    console.log(
      `Planning complete. ${work.length} issue(s) to work in parallel:`,
    );
    for (const { issue, branch } of work) {
      const roles = issue.roles.length > 0 ? issue.roles.join(", ") : "none";
      console.log(`  #${issue.number}: ${issue.title} → ${branch} (optional roles: ${roles})`);
    }

    const settled = await Promise.allSettled(
      work.map(({ issue, branch }) => buildIssue(issue, branch, base)),
    );

    // Log any agents that threw (network error, sandbox crash, timeout, etc.).
    // A clean stop is named in the round summary instead.
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected" && !(outcome.reason instanceof UncountedStopError)) {
        console.error(
          `  ✗ #${work[i]!.issue.number} (${work[i]!.branch}) failed: ${outcome.reason}`,
        );
      }
    }

    const summary = roundSummary(work, settled);
    for (const line of summary.lines) {
      console.log(line);
    }
    for (const entry of roundOutcomes(work, settled)) {
      outcomeReport.record(entry);
    }

    if (summary.stop !== undefined) {
      // Nothing reached a PR, so the next plan would pick the same issues and
      // repeat the same round: stop and let a human look. Or a build stopped
      // cleanly on the time budget or usage limit, so nothing more can start.
      console.log(summary.stop);
      break;
    }
  }
  // A loop that ended on the time budget or the usage limit (no new round,
  // or a build that stopped) stopped rather than finished.
  const limitReason = runLimits.stopReason();
  ending = limitReason === undefined ? { kind: "finished" } : { kind: "stopped", reason: limitReason };
} catch (error) {
  if (!(error instanceof UncountedStopError)) throw error;
  ending = { kind: "stopped", reason: error.message };
  console.log(`\n⏹ Stopping the run cleanly: ${error.message}. Nothing more starts; the next run picks the work up.`);
} finally {
  console.log("\nToken usage by role:");
  const lines = usageReport.lines();
  console.log(lines.length > 0 ? lines.join("\n") : "  (no role ran)");

  // Only logged and written here. Ending the run red on a hand-back is the
  // trigger workflow's final step (#82), reading the list written to
  // .sandcastle/logs/handbacks.json below; exiting non-zero here would make a
  // local run that hands something back look like a crash.
  const handBacks = handBackReport.items();
  if (handBacks.length > 0) {
    console.log("\nHanded back to a human:");
    for (const { kind, number, label, reason } of handBacks) {
      console.log(`  ${kind} #${number}: ${label} (${reason})`);
    }
  }

  // Threads a follow-up pass kept from the follow-up role because someone
  // other than the repository owner or a bot opened them (#78).
  const humanThreads = humanThreadReport.items();
  if (humanThreads.length > 0) {
    console.log("\nReview threads waiting on a person:");
    for (const { pr, author, url } of humanThreads) {
      console.log(`  PR #${pr}: ${author ?? "a deleted account"} (${url})`);
    }
  }

  // writeRunReport never throws, so the run's own error, if any, still
  // reaches the process.
  const summary = renderSummary({
    queue: describeQueueScope(scope),
    repo: reportRepo(),
    ending,
    outcomes: outcomeReport.items(),
    handBacks,
    waitingPrs: waitingPrReport.items(),
    humanThreads,
    usage: usageReport.totals(),
    stops: intakeStopReport.items(),
  });
  writeRunReport(summary, handBacks);
  console.log(`\nRun report: ${REPORT_DIR}/summary.md`);

  // Unlike a hand-back, an intake stop means the host couldn't run a role at
  // all, so the run ends red once the report is written (#320). A crash still
  // exits 1 on its uncaught error, whatever this sets.
  for (const { reason, firstError } of intakeStopReport.items()) {
    console.error(`\n✗ Intake stopped: ${reason}. First error: ${firstError}`);
  }
  process.exitCode = intakeStopExitCode(intakeStopReport.items());
}

console.log("\nAll done.");

// The repository the run report links to: GitHub Actions names it, and a
// local run asks gh, but only once startup has pinned every git command's
// environment (startedUp): asking before then would run gh, which reads git
// remotes, before protectHostGit() has ruled out a planted commondir file.
// Undefined when neither can, since gh may be what failed, or startup hasn't
// finished, and the report then names its issues and PRs unlinked.
function reportRepo(): string | undefined {
  if (!startedUp) {
    return process.env.GITHUB_REPOSITORY;
  }
  try {
    return process.env.GITHUB_REPOSITORY || repoName();
  } catch {
    return undefined;
  }
}
