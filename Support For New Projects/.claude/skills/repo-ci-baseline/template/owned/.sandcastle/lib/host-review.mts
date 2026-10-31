// The host-side half of the pre-push review for a branch Sandcastle built: the reviewers (the Bar and one per lens
// whose files match), the triage of their findings, the backend role's fixes and the rounds that follow them, and the
// record. Only the host records; no agent gets a shell, a token or the ledger. Not implemented yet.

import { z } from "zod";
import type { Ledger, PreparedRound, ReviewInput } from "./review-ledger.mts";

// One row of lenses.md's table (or of a repo's own lenses table).
export type Lens = { name: string; appliesTo: string; row: string };

// Reads the `| Lens | Applies to | Ask |` table. Throws when it finds none, or a row with fewer than three cells.
export function parseLensTable(_markdown: string): Lens[] {
  throw new Error("Not implemented");
}

// For each lens lenses.md names, the "Applies to" text the table holds and the paths the host reviews it for.
export const LENS_APPLIES: Record<string, { appliesTo: string; matches(path: string): boolean }> = {};

// The repository paths a patch changes, read from its `diff --git` headers.
export function patchPaths(_patch: string): string[] {
  throw new Error("Not implemented");
}

// A reviewer to start: the Bar or one lens. The Bar's `row` is empty.
export type Reviewer = { lens: string; row: string };

export const BAR_LENS = "Bar";

// The reviewers for the files a round reads: the Bar first, then each matching lens in table order.
export function reviewersFor(_files: readonly string[], _lenses: readonly Lens[]): Reviewer[] {
  throw new Error("Not implemented");
}

// A finding as a reviewer answers it.
export const reviewerFindingSchema = z
  .object({
    lens: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().nonnegative(),
    severity: z.enum(["critical", "warning", "advisory"]),
    summary: z.string().min(1),
    fix: z.string(),
    needsPerson: z.boolean(),
    why: z.string(),
  })
  .strict();

export type ReviewerFinding = z.infer<typeof reviewerFindingSchema>;

// Thrown for a reviewer answer that holds no valid findings block.
export class ReviewerAnswerError extends Error {}

// The findings in the last `<findings>[...]</findings>` block of a reviewer's output.
export function parseReviewerAnswer(_stdout: string): ReviewerFinding[] {
  throw new Error("Not implemented");
}

// A finding as triage leaves it: ready to record, plus what the host needs to route it.
export type TriageFinding = ReviewInput["findings"][number] & { needsPerson: boolean; fixable: boolean };

// Merge duplicates, number the findings, grade security, and decide which the backend role fixes.
export function triageRound(_input: {
  raw: { reviewer: Reviewer; findings: ReviewerFinding[] }[];
  firstId: number;
  reviewOnly: boolean;
}): TriageFinding[] {
  throw new Error("Not implemented");
}

// What the backend role says became of one finding.
export type FixOutcome = { id: string; status: "fixed" | "dismissed" | "open"; test: string | null; reason: string | null };

// Turn the backend's verdicts into final statuses, enforcing the skill's rules.
export function applyOutcomes(
  _findings: readonly TriageFinding[],
  _outcomes: readonly FixOutcome[],
  _changedFiles: readonly string[],
  _headAdvanced: boolean,
): ReviewInput["findings"] {
  throw new Error("Not implemented");
}

// The skill files the host reads from the main checkout, never the worktree.
export type SkillFiles = { lenses: string; bar: string; severities: string; agentBody: string; repoLenses?: string };

// What the review needs from outside; tests pass stubs.
export type HostReviewHost = {
  readSkillFiles(): SkillFiles;
  // The worktree's absolute path inside the sandbox.
  worktree(): Promise<string>;
  prepare(opts: { main?: string; head?: string; since?: { commit: string; preparedHead: string | undefined } }): PreparedRound;
  takenIds(head: string): number;
  // Writes a file under the run's folder inside the sandbox.
  writeRunFile(path: string, content: Buffer | string): Promise<void>;
  runReviewer(reviewer: Reviewer, prompt: string): Promise<string>;
  runFixer(prompt: string): Promise<void>;
  readOutcomes(): Promise<string | undefined>;
  head(): Promise<string | undefined>;
  changedFiles(from: string, to: string): string[];
  // Checkpoint 3: the gate (and gate-fixer) after a round's fixes. The commit it passed on, or undefined when red.
  gate(): Promise<string | undefined>;
  record(input: ReviewInput, at: { head: string; branch: string }): Ledger;
  log(line: string): void;
};

export type HostReviewResult =
  | { status: "recorded"; head: string; rounds: number; ledger: Ledger }
  | { status: "failed"; head: string; reason: string }
  | { status: "gate failed" };

// Runs the review's rounds on `startHead` against `main`, and records them.
export async function runHostReview(
  _host: HostReviewHost,
  _input: { issue: { number: number; title: string; body: string }; branch: string; main: string; startHead: string },
): Promise<HostReviewResult> {
  throw new Error("Not implemented");
}

// The PR note listing the findings the review left open.
export function openFindingsNote(_ledger: Ledger): string {
  throw new Error("Not implemented");
}
