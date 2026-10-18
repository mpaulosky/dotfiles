// ---------------------------------------------------------------------------
// Plan critique
//
// A second run after the planner checks one thing: whether the round's picks
// are safe to build in parallel, meaning no file or module overlap between
// them, and none depending on an API or decision another open issue will
// establish. Its only power is to defer a pick. The host saves each deferral
// as a native "blocked by" link, so the blocker gate holds the issue back
// until its blocker lands, and a human overrides it by deleting the link.
// ---------------------------------------------------------------------------

import * as sandcastle from "@ai-hero/sandcastle";
import { z } from "zod";
import { runRole } from "./agents.mts";
import { hooks } from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import { bodyBlockers, liveGitHub as gateGitHub, type Blocker } from "./gate.mts";
import {
  addBlockedBy,
  commentOnIssue,
  issueBody,
  pullRequestFiles,
  type OpenPullRequest,
  type SandcastleIssue,
} from "./github.mts";
import { critiquePromptArgs, type CritiquePromptArgs } from "./prompts.mts";
import { outcomeReport, type OutcomeReport } from "./report.mts";
import { agentSandbox } from "./skills.mts";

const critiqueSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["keep", "defer"]),
      blockedBy: z.string().optional(),
      reason: z.string(),
    }),
  ),
});

export type CritiqueVerdict = z.infer<typeof critiqueSchema>["verdicts"][number];

// An open Sandcastle issue held back because its PR is waiting for review.
export type InFlightIssue = { issue: SandcastleIssue; pr: OpenPullRequest };

export type CritiqueInput = {
  picks: SandcastleIssue[];
  inFlight: InFlightIssue[];
  // The ready issues the planner didn't pick.
  unpicked: SandcastleIssue[];
};

// The GitHub reads and writes the critique needs; tests pass a stub. Each one
// throws when GitHub can't answer.
export type CritiqueGitHub = {
  pullRequestFiles(pr: number): string[];
  issue(number: number): Blocker;
  // The issues this one waits on: its native "blocked by" links and its body's
  // "Blocked by #N" / "Depends on #N" lines, as the blocker gate reads them.
  blockersOf(number: number): number[];
  addBlockedBy(issue: number, blocker: number): void;
  comment(issue: number, body: string): void;
};

const liveGitHub: CritiqueGitHub = {
  pullRequestFiles,
  issue: gateGitHub.blocker,
  blockersOf: (number) => [
    ...gateGitHub.nativeBlockers(number).map((blocker) => blocker.number),
    ...bodyBlockers(issueBody(number)),
  ],
  addBlockedBy,
  comment: commentOnIssue,
};

export type CritiqueRun = (promptArgs: CritiquePromptArgs) => Promise<CritiqueVerdict[]>;

// Throws StructuredOutputError when the <critique> tag is missing, the JSON is
// malformed or it doesn't match the schema.
const runCritique: CritiqueRun = async (promptArgs) => {
  const critique = await runRole("critique", {
    hooks,
    sandbox: agentSandbox(),
    promptFile: "./.sandcastle/critique-prompt.md",
    promptArgs,
    output: sandcastle.Output.object({ tag: "critique", schema: critiqueSchema }),
  });
  return critique.output.verdicts;
};

export function deferralComment(blocker: number, reason: string): string {
  return [
    `Sandcastle's plan critique deferred this issue behind #${blocker}, so it won't be built until #${blocker} lands.`,
    `**Reason:** ${reason}`,
    `To override, delete the "blocked by #${blocker}" link on this issue.`,
  ].join("\n\n");
}

// Whether #blocker already waits on #id, directly or through a chain, so that
// "#id blocked by #blocker" would close a loop. Throws when a link can't be read.
function wouldCycle(id: number, blocker: number, blockersOf: (number: number) => number[]): boolean {
  const seen = new Set<number>();
  const pending = [blocker];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next === id) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...blockersOf(next));
  }
  return false;
}

// Apply the critique's verdicts and return the picks still to build this
// round. Each applied defer adds a native link and one comment on the deferred
// issue, and reaches the run report as "deferred"; keeps are only logged. A
// verdict is ignored, with a log line, when its issue wasn't picked or already
// has a verdict, or when its blocker is missing, closed, a pull request, or
// would create a cycle. A defer GitHub won't link is ignored too: without the
// link the deferral wouldn't outlast the round.
export function applyVerdicts(
  picks: SandcastleIssue[],
  verdicts: CritiqueVerdict[],
  github: CritiqueGitHub = liveGitHub,
  log: (line: string) => void = console.log,
  report: OutcomeReport = outcomeReport,
): SandcastleIssue[] {
  const picked = new Set(picks.map((issue) => String(issue.number)));
  const judged = new Set<string>();
  const deferred = new Set<number>();

  // Links read from GitHub, plus the ones added this round, so a later verdict
  // can't close a loop with an earlier one.
  const read = new Map<number, number[]>();
  const added = new Map<number, number[]>();
  const blockersOf = (number: number): number[] => {
    let blockers = read.get(number);
    if (!blockers) {
      blockers = github.blockersOf(number);
      read.set(number, blockers);
    }
    return [...blockers, ...(added.get(number) ?? [])];
  };

  // Why a defer can't be applied, or undefined when it can.
  const deferProblem = (id: number, blocker: number): string | undefined => {
    let found: Blocker;
    try {
      found = github.issue(blocker);
    } catch {
      return `its blocker #${blocker} couldn't be found`;
    }
    if (found.is_pr) return `its blocker #${blocker} is a pull request, not an issue`;
    if (found.state !== "open") return `its blocker #${blocker} is closed`;
    try {
      if (wouldCycle(id, blocker, blockersOf)) return `blocking it by #${blocker} would create a cycle`;
    } catch {
      return `#${blocker}'s blocker chain couldn't be read, so a cycle can't be ruled out`;
    }
    return undefined;
  };

  for (const verdict of verdicts) {
    const ref = `#${verdict.id}`;
    if (!picked.has(verdict.id)) {
      log(`  ⚠ Ignoring the critique's verdict on ${ref}: it wasn't picked this round.`);
      continue;
    }
    if (judged.has(verdict.id)) {
      log(`  ⚠ Ignoring another critique verdict on ${ref}: it already has a verdict.`);
      continue;
    }

    if (verdict.verdict === "keep") {
      judged.add(verdict.id);
      log(`  ✓ The critique keeps ${ref}: ${verdict.reason}`);
      continue;
    }

    const blockerRef = /^#?(\d+)$/.exec(verdict.blockedBy?.trim() ?? "");
    if (!blockerRef) {
      log(`  ⚠ Ignoring the critique's deferral of ${ref}: it names no blocker.`);
      continue;
    }
    const id = Number(verdict.id);
    const blocker = Number(blockerRef[1]);
    const problem = deferProblem(id, blocker);
    if (problem) {
      log(`  ⚠ Ignoring the critique's deferral of ${ref}: ${problem}.`);
      continue;
    }

    try {
      github.addBlockedBy(id, blocker);
    } catch (error) {
      log(`  ⚠ Ignoring the critique's deferral of ${ref}: it couldn't be linked to #${blocker} (${error}).`);
      continue;
    }
    added.set(id, [...(added.get(id) ?? []), blocker]);
    judged.add(verdict.id);
    deferred.add(id);
    report.record({ kind: "issue", number: id, outcome: "deferred", detail: `behind #${blocker}` });
    log(`  ⏸ The critique defers ${ref} behind #${blocker}: ${verdict.reason}`);

    try {
      github.comment(id, deferralComment(blocker, verdict.reason));
    } catch (error) {
      log(`  ⚠ ${ref} is linked to #${blocker}, but the comment explaining why couldn't be posted (${error}).`);
    }
  }

  return picks.filter((issue) => !deferred.has(issue.number));
}

// The picks the critique gave no verdict on, as "#N" references.
function unjudged(picks: SandcastleIssue[], verdicts: CritiqueVerdict[]): string[] {
  const judged = new Set(verdicts.map((verdict) => verdict.id));
  return picks.filter((issue) => !judged.has(String(issue.number))).map((issue) => `#${issue.number}`);
}

// Critique the round's picks and return the ones to build. The critique is
// skipped when there's nothing to compare. When it fails (the run throws, its
// tag is missing, its output doesn't match the schema, it leaves a pick
// without a verdict, or a PR's files can't be read), only the planner's first
// pick is built, since a lone pick can't collide with another pick.
export async function critiqueRound(
  { picks, inFlight, unpicked }: CritiqueInput,
  run: CritiqueRun = runCritique,
  github: CritiqueGitHub = liveGitHub,
  log: (line: string) => void = console.log,
  report: OutcomeReport = outcomeReport,
): Promise<SandcastleIssue[]> {
  const [firstPick] = picks;
  if (!firstPick) return picks;
  const nothingToCompare = picks.length === 1 && inFlight.length === 0 && unpicked.length === 0;
  if (nothingToCompare) return picks;

  let verdicts: CritiqueVerdict[];
  try {
    const inFlightWithFiles = inFlight.map(({ issue, pr }) => ({
      issue,
      pr: pr.number,
      branch: pr.headRefName,
      files: github.pullRequestFiles(pr.number),
    }));
    verdicts = await run(critiquePromptArgs(picks, inFlightWithFiles, unpicked));
    const missing = unjudged(picks, verdicts);
    if (missing.length > 0) throw new Error(`it gave no verdict on ${missing.join(", ")}`);
  } catch (error) {
    // Out of usage or time, the critique didn't fail: the run is stopping,
    // so building even the first pick would start a role it can't finish.
    if (error instanceof UncountedStopError) throw error;
    log(`  ⚠ The plan critique failed (${error}). Building only the planner's first pick, #${firstPick.number}.`);
    return [firstPick];
  }

  return applyVerdicts(picks, verdicts, github, log, report);
}
