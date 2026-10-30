// Prompt arguments built from GitHub content. Roles can't reach GitHub, so this
// is everything they learn about an issue. The issues passed in have already
// lost every comment but those from authors with write access (see
// ownerApproved).

import type { PromptArgs } from "@ai-hero/sandcastle";
import type { Checkpoint } from "./checkpoint.mts";
import { BASE_BRANCH } from "./config.mts";
import type { PromptThread } from "./follow-up-pass.mts";
import type { SandcastleIssue } from "./github.mts";

// Sandcastle sets {{TARGET_BRANCH}} itself (to the sandbox's own branch inside
// createSandbox) and refuses an override, so the branch to compare against
// goes in as {{BASE_BRANCH}}.
export function issuePromptArgs(issue: SandcastleIssue, branch: string) {
  return {
    TASK_ID: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body.trim() === "" ? "(no description)" : issue.body,
    ISSUE_COMMENTS: issue.comments.length > 0 ? issue.comments.join("\n\n---\n\n") : "(no comments)",
    BRANCH: branch,
    BASE_BRANCH,
  };
}

// The gate-fixer needs the issue, since at checkpoint 1 it may finish the
// implementation, plus the red gate's output and which checkpoint it's at.
export function gateFixerPromptArgs(issue: SandcastleIssue, branch: string, checkpoint: Checkpoint, gateOutput: string) {
  return { ...issuePromptArgs(issue, branch), CHECKPOINT: String(checkpoint), GATE_OUTPUT: gateOutput };
}

// What the host refuses in the reviewer's PR description, filled in as
// {{PR_BODY_RULES}} in review-prompt.md. It lives here, not in the Seed
// prompt, because Apply never overwrites a Seed file: a repo gets new wording
// on its next re-Apply only if the Template owns it (see
// mpaulosky/dotfiles#320). Keep it in step with lib/build.mts#reviewerPrBody:
// build.test.mts fails when a refusal there isn't named here.
export const PR_BODY_RULES = [
  "The host publishes `pr-body.md` word for word. When the file breaks any rule below it publishes a generic body instead, your description is lost,",
  "and you get no error. So:",
  "",
  "- Write the file, and don't leave it empty. Use exactly the headings `## Why`, `## What changed` and `## Verification`, each on a line of its own.",
  "- Keep it under 60,000 characters.",
  "- Never put a secret, a token or a credential in it, nor a colour code or a URL with credentials.",
  "- Never write the words \"Review notes\", in any form: a heading, in code, split by emphasis, tags or character references, or run together with other",
  "  letters. Only a person's local review writes that section, and the host reads your text as a reader sees it.",
  "- Don't name another issue with a closing keyword (`Closes`, `Fixes`, `Resolves` and their other forms before `#<n>`, `owner/repo#<n>` or an issue URL):",
  "  GitHub would close it when the PR merges. Refer to it without a keyword (\"see #<n>\"). The host adds the line that closes this issue itself.",
  "- Don't write `@name` anywhere: GitHub would notify them. The one exception is an `@` placed directly after an opening backtick, as in `` `@copilot` ``.",
  "  In a longer code span, such as `` `npm install @types/node` ``, the host still sees `@name` and refuses the body, so rephrase it.",
  "- Don't write `<!--`: the host's markers start with it. Add no marker or sign-off line of your own.",
].join("\n");

// The reviewer's prompt arguments: the issue's, plus PR_BODY_RULES.
export function reviewerPromptArgs(issue: SandcastleIssue, branch: string): PromptArgs {
  return { ...issuePromptArgs(issue, branch), PR_BODY_RULES };
}

// The follow-up role (lib/follow-up-pass.mts#runPass) needs the issue, the
// PR number (its prompt can't reach GitHub to learn it), the open review
// threads it must act on (already sorted and trimmed by
// lib/follow-up-pass.mts#threadsForRole, so no stranger's comment reaches
// it), and one plain sentence on where the merge with main stands: already
// contains main, merged main cleanly, or merging main conflicted in which
// files (and that it must finish the merge with `git commit --no-edit`).
// `ciLog` is the failed-job log of each red check the gate doesn't cover,
// such as CodeQL's, as CODEQL_LOG; Sandcastle refuses a placeholder
// with no value, so a pass with none still sends a sentence saying so.
export function followUpPromptArgs(
  issue: SandcastleIssue,
  branch: string,
  pr: number,
  threads: readonly PromptThread[],
  merge: string,
  ciLog?: string,
): PromptArgs {
  return {
    ...issuePromptArgs(issue, branch),
    PR_NUMBER: String(pr),
    THREADS_JSON: JSON.stringify(threads),
    MERGE: merge,
    CODEQL_LOG:
      ciLog === undefined
        ? "(No CI check that the gate doesn't cover failed, so there's no log to fix from.)"
        : `The host already ran \`scripts/gate.sh\` on the PR's head, and it passes.\n\n${ciLog}`,
  };
}

// The architect also gets the body of its own latest design note comment
// (see DESIGN_MARKER in lib/config.mts), so a re-run builds on its earlier
// decisions instead of starting blind.
export function architectPromptArgs(issue: SandcastleIssue, branch: string, designNote: string | undefined): PromptArgs {
  return { ...issuePromptArgs(issue, branch), DESIGN_NOTE: designNote ?? "(no earlier design note)" };
}

// The backend developer needs to know whether the UI developer runs after it
// for this issue: when it does, the Blazor components and pages are the UI
// developer's, and the backend's run needn't leave every test green.
export function backendPromptArgs(issue: SandcastleIssue, branch: string, uiRuns: boolean): PromptArgs {
  return {
    ...issuePromptArgs(issue, branch),
    UI_DEVELOPER: uiRuns
      ? "The UI developer runs after you for this issue. Leave Blazor components and pages (`.razor` files, their code-behind and their " +
        "bUnit tests) to it, and make every other test pass. If the gate is still red only on those tests when you finish, say so in your " +
        "last commit's body."
      : "No UI developer runs for this issue, so your run is the last developer run: every test must pass by its end.",
  };
}

// The host names branches and has already dropped issues with an open PR, so
// the planner needs only the ready issues.
export function plannerPromptArgs(ready: SandcastleIssue[]) {
  return { ISSUES_JSON: JSON.stringify(ready) };
}

// The issues intake must judge against the Definition of Ready: every open
// in-scope issue that has none of sandcastle:ready, sandcastle:needs-info and
// sandcastle:needs-human yet (see lib/intake.mts#needsIntake).
export function intakePromptArgs(issues: SandcastleIssue[]): { ISSUES_JSON: string } {
  return { ISSUES_JSON: JSON.stringify(issues) };
}

// An open Sandcastle issue whose PR is waiting for review, with the files that
// PR changes.
export type InFlightPrompt = { issue: SandcastleIssue; pr: number; branch: string; files: string[] };

// The round's picks, the in-flight issues and the ready issues the planner left
// out. The critique compares the picks with each other and with the rest.
export function critiquePromptArgs(picks: SandcastleIssue[], inFlight: InFlightPrompt[], unpicked: SandcastleIssue[]) {
  return {
    PICKED_JSON: JSON.stringify(picks),
    IN_FLIGHT_JSON: JSON.stringify(
      inFlight.map(({ issue, pr, branch, files }) => ({ number: issue.number, title: issue.title, body: issue.body, pr, branch, files })),
    ),
    UNPICKED_JSON: JSON.stringify(unpicked),
  };
}

export type CritiquePromptArgs = ReturnType<typeof critiquePromptArgs>;
