# Auto-merge after review

Template files (Owned): `.github/workflows/pr-automerge.yml` and its tests in `.github/scripts/tests/pr-automerge.test.mjs`, with `dependabot-auto-merge.yml` and `release.yml` as the two deliberate exceptions.
History: IssueTracker #140; Blazor-Server #94 (the hand-back label hold) and #119 (the Copilot review cap).
IssueManager #235 moved the decision into `.github/scripts/automerge-decision.mjs` with `node --test` tests, and TicketManager carries the same shape.
The Template keeps the script inline in the workflow and tests it there:
`.github/scripts/tests/pr-automerge.test.mjs` reads the `script: |` block out of the workflow and runs it against a fake GitHub client, so the tests cover exactly what the workflow runs.
CI's `Auto-merge tests` job and `test.sh` run it.
Whether to move to IssueManager's separate module is still open, due before TicketManager is Standardized.

## What it guarantees

A same-repo PR into `main` squash-merges on its own once its required checks pass, Copilot has reviewed its head commit, and every review thread is resolved.
Nothing merges before the review arrives, until Copilot's review cap: see [ADR 0002](../docs/adr/0002-copilot-review-cap-and-hand-back-hold.md).
A PR handed back with `sandcastle:needs-human` never merges while it carries the label.

## Design

- **The workflow merges directly and leaves GitHub's native auto-merge unarmed.** Native auto-merge merges the moment the required checks pass,
  and Copilot's review is requested on each push but isn't a required check, so the PR would land before the review.
  Two workflows arm native auto-merge on purpose, and this one skips a PR that already has it armed: `release.yml` on its blog PRs, and `dependabot-auto-merge.yml` on Dependabot's,
  which merge on green required checks without Copilot's review.
  Copilot flags the Dependabot bypass on review; it is the Baseline's policy, so answer it and name both in the skip's comment.
- **Readiness** comes from one GraphQL query: state, draft, fork, mergeability, `mergeStateStatus`, the auto-merge request, Copilot's reviews and the review threads.
  The reviews are filtered by author `copilot-pull-request-reviewer[bot]`, so thread replies can't push them off the page.
  Copilot must have reviewed the exact `headRefOid`: it re-reviews every push, merge-from-main commits included.
  More threads than one page is left to a person.
- **Copilot review cap.** Copilot re-reviews every push and can raise something new each time, so a PR could chase its reviews forever.
  Once Copilot has reviewed `COPILOT_REVIEW_CAP` (3) distinct non-merge commits, the merge stops waiting for its review of the head and stops counting its unresolved threads.
  Merges from `main` aren't rounds: the ruleset keeps branches up to date, so they'd use up the cap without a fix.
  A thread belongs to whoever wrote its first comment; one with no known author counts as a person's.
  Everything else still holds at the cap, and the log says when the cap let a PR through and past how many Copilot threads.
- **Hand-back hold.** A PR labelled `sandcastle:needs-human` (Sandcastle giving up and handing it to a person) is skipped while it carries the label,
  and also when someone other than the repository owner last removed it, since anyone with triage access can remove a label.
  The removal comes from the PR's paginated issue events, read with `GITHUB_TOKEN` (`issues: read`), so `RELEASE_PR_PAT` needs no Issues access.
  Both checks run again on a fresh snapshot, and every later check reads that snapshot, so a thread, head or check that changed meanwhile counts.
  More labels than one page is left to a person. A repo that never applies the label is unaffected.
- **The merge** is `pulls.merge` with `sha: headRefOid`, so a push landing between the check and the merge fails the merge instead of merging unreviewed code.
  405 and 409 are warnings; a later event re-evaluates.
- **Triggers**, each a moment a condition can become true: `pull_request_target` (opened, ready_for_review, reopened, edited, synchronize, and unlabeled for the hand-back label),
  `workflow_run` completion of every workflow that owns a required check, a 15-minute schedule (resolving a thread has no Actions trigger), and `workflow_dispatch` from `main`.
- **Safety:** `pull_request_target` runs main's copy of the file and never checks out PR code, so a PR can't edit what decides whether it merges.
  `pull_request_review` is left out on purpose: it would run the PR's own copy with write access.
- **Token:** `RELEASE_PR_PAT`, falling back to `GITHUB_TOKEN`.
  A merge made with `GITHUB_TOKEN` starts no workflows, so the release and its blog PR would silently skip.

## Adapting

- **Survey whether the repo's auto-merge waits for review.** IssueManager's armed native auto-merge and merged on `CLEAN` alone; its #231 merged with an open Copilot thread.
- `workflow_run.workflows` lists every workflow that owns a required check, by its `name:`.
  A repo whose ruleset requires a check from a workflow outside the Template needs that workflow in the list: Template first.
- **Land the Standardize PR by hand, held as a draft.** The old workflow on `main` still runs on it and would arm auto-merge the moment its checks pass; drafts are the one state it skips.
  Open the PR as a draft, request Copilot's review with `gh pr edit <n> --add-reviewer @copilot`, and resolve every thread.
  Before `gh pr ready`, check `mergeStateStatus`: if it's `BEHIND`, keep the draft, run `gh pr update-branch <n>`, request the review again and wait for it on the new head.
  Then `gh pr ready <n>`, which starts CI again, so the PR is `BLOCKED` for one more full run; once it's green, the old workflow may merge it itself, which is fine now.
  Otherwise `gh pr merge <n> --squash --match-head-commit <sha>`.

## Verify live

The next PR after the Standardize must sit green but unmerged until Copilot's review of its head arrives, and again while any thread is open.
The workflow's log names what it waits on (`Waiting on PR #n: no Copilot review of <sha> yet.`, or `<k> unresolved review thread(s).`).
Once the last thread is resolved, the next sweep (at most 15 minutes) merges it.
After a third reviewed non-merge commit, the log reads `Copilot review cap (3) reached on PR #n: merging ...` if the cap is what let it through.
