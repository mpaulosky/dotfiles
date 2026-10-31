// The prompts the host-side review (lib/host-review.mts) gives its reviewers and the backend role. Not implemented yet.

import type { Ledger, ReviewInput } from "./review-ledger.mts";
import type { Reviewer, TriageFinding } from "./host-review.mts";

type IssueText = { number: number; title: string; body: string };

// A reviewer's prompt: the agent file's body, the worktree, the bar, its lens, the severities, the files to read and the answer format.
export function reviewerPrompt(_args: {
  agentBody: string;
  bar: string;
  severities: string;
  lens: Reviewer;
  worktree: string;
  runDir: string;
  round: number;
  issue: IssueText;
  hasFixes: boolean;
}): string {
  throw new Error("Not implemented");
}

// The decisions file: this run's earlier findings and what became of them.
export function decisionsMarkdown(_findings: readonly ReviewInput["findings"][number][], _latest?: Ledger): string {
  throw new Error("Not implemented");
}

// The backend role's prompt for the fixable findings of a round.
export function reviewFixPrompt(_args: {
  issue: IssueText;
  branch: string;
  round: number;
  findings: readonly TriageFinding[];
  outcomesPath: string;
}): string {
  throw new Error("Not implemented");
}
