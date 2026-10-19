// ---------------------------------------------------------------------------
// File overlap
//
// Before the critique, the host holds back, in code, any pick whose planned
// files share a path with a pick kept earlier in the planner's order or with
// an open PR into main (#248: two builds both rewrote build.mts's merge-main
// code and the second PR went DIRTY). The critique's own overlap check is a
// judgment and sees only this queue's PRs; this one is neither. A held pick
// is only skipped for the round, with no "blocked by" link: next round the
// earlier pick has an open PR, which this check sees.
// ---------------------------------------------------------------------------

import {
  commentOnIssue,
  openPullRequestsIntoMain,
  pullRequestFiles,
  type OpenPullRequest,
  type SandcastleIssue,
} from "./github.mts";
import { outcomeReport, type OutcomeReport } from "./report.mts";

// A pick with the files the planner expects it to change (lib/plan.mts#resolveFiles); [] when it named none.
export type FilePick = SandcastleIssue & { files: string[] };

// An open PR into main and the paths it changes.
export type ChangingPullRequest = { number: number; files: string[] };

// Why a pick is held back.
export type Overlap =
  | { kind: "pick"; blocker: number; path: string }
  | { kind: "pr"; blocker: number; path: string }
  | { kind: "no files"; waitsOn: { kind: "pick" | "pr"; number: number } };

// The GitHub reads and writes the check needs; tests pass a stub.
export type OverlapGitHub = {
  openPullRequestsIntoMain(): OpenPullRequest[];
  pullRequestFiles(pr: number): string[];
  comment(issue: number, body: string): void;
};

// A path with a Template Owned file's copy at the root mapped to the root path. Not implemented yet.
export function pathKey(path: string): string {
  void path;
  throw new Error("Not implemented");
}

// The picks to hold back, and why. Not implemented yet.
export function findOverlaps(
  picks: readonly FilePick[],
  pullRequests: readonly ChangingPullRequest[],
): Map<number, Overlap> {
  void picks;
  void pullRequests;
  throw new Error("Not implemented");
}

// The comment on a held pick. Not implemented yet.
export function overlapComment(overlap: Overlap): string {
  void overlap;
  throw new Error("Not implemented");
}

// Splits the picks into those to build this round and those held back. Not implemented yet.
export function holdOverlappingPicks<T extends FilePick>(
  picks: T[],
  github: OverlapGitHub = liveGitHub,
  log: (line: string) => void = console.log,
  report: OutcomeReport = outcomeReport,
): { kept: T[]; held: T[] } {
  void picks;
  void github;
  void log;
  void report;
  throw new Error("Not implemented");
}

const liveGitHub: OverlapGitHub = { openPullRequestsIntoMain, pullRequestFiles, comment: commentOnIssue };
