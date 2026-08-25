---
name: "Review Changes"
description: "Review the full current worktree, fix repo lint issues, validate the approved changes, and commit only the in-scope files."
model: Claude Sonnet 4.5 (copilot)
agent: "Squad"
---

Review all current worktree changes and treat the entire current worktree as the review surface unless the user explicitly narrows scope. Do not silently exclude unrelated edits; instead, identify them, keep them protected, and only stage the approved in-scope files.

Important guardrail: never skip lint or build validation because a subset of files was approved. Even when the user requests a narrow review, the repo-level validation gates still apply to the current branch state and must be satisfied before the review is complete.

Always run the repo validation gates for the current worktree:

- YAML lint must always run and any findings must be fixed before continuing.
- Markdown lint must always run and any findings must be fixed before continuing.
- The project build-repair flow must be run until it succeeds.
- The narrowest relevant tests for the approved change set must be run and must pass before committing.

Mode selection:

- Normal mode is the default and follows the workflow below.
- If the user requests a dry run using wording such as `dry run` or `--dry-run`, do not stage, commit, amend, push, or modify any files. In dry-run mode, follow this workflow instead:
  1. Inspect `git status --short`, the current branch, and the complete unstaged and staged diffs without changing anything.
  2. Treat existing user changes as protected. Do not reset, checkout, clean, amend, or otherwise modify unrelated files. Do not include this prompt file in the review or the proposed staging set.
  3. Identify all current changes and the files and behavior that are in scope. If the intended scope is unclear, report that clarification is required and stop.
  4. Review the in-scope diff for correctness, regressions, security concerns, missing focused tests, and broken lint issues. Keep unrelated changes untouched.
  5. Run YAML lint, Markdown lint, the required build-repair flow, and the narrowest relevant tests or validation that is safe in read-only dry-run mode. Do not claim validation that was not run. Report failures without making changes.
  6. Report exactly what would be staged, the commit message that would be used, the validation commands and results, and what would remain uncommitted. Do not stage, commit, amend, push, or modify files.

Follow this workflow:

1. Inspect `git status --short`, the current branch, and the complete unstaged and staged diffs before changing anything.
2. Treat existing user changes as protected. Do not reset, checkout, clean, amend, or otherwise modify unrelated files. Do not include this prompt file in the review or commit.
3. Identify the full current worktree and the files and behavior in scope. If the intended scope is unclear, ask for clarification before staging or committing.
4. Review the in-scope diff for correctness, regressions, security concerns, and missing focused tests. Keep unrelated changes untouched.
5. Run the required lint and build gates before finalizing the patch:
   - YAML lint: run the repo YAML lint command and fix all findings.
   - Markdown lint: run the repo Markdown lint command and fix all findings.
   - Build repair: run the full build-repair flow from `.github/prompts/build-repair.prompt.md` until it succeeds.
   - Focused tests: run the narrowest relevant tests for the approved change set and fix any failures.
6. Do not stop after the first passing subset. Continue the repair loop until the repo validation gates pass and the build is successful.
7. Stage only the approved in-scope files by path. Recheck the staged diff and confirm that no unrelated files or the prompt itself are staged.
8. Create one concise commit with an appropriate conventional message. Do not amend an existing commit or push changes.
9. Report the commit hash and message, the files committed, the validation commands and results, and any worktree changes that remain uncommitted.
