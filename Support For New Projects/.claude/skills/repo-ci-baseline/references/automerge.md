# Auto-merge after review

Template files (Owned): `.github/workflows/pr-automerge.yml` and its tests in `.github/scripts/tests/pr-automerge.test.mjs`, `.github/workflows/pr-review-submitted.yml`,
and Claude Review: `.github/workflows/claude-review.yml` with `.github/scripts/post_claude_review.py` and its tests in `.github/scripts/tests/test_post_claude_review.py`,
with `dependabot-auto-merge.yml` and `release.yml` as the two deliberate exceptions.
History: IssueTracker #140 and #201 (re-check on a submitted review); Blazor-Server #94 (the hand-back label hold) and #119 (the Copilot review cap).
IssueManager #235 moved the decision into `.github/scripts/automerge-decision.mjs` with `node --test` tests, and TicketManager carries the same shape.
The Template keeps the script inline in the workflow and tests it there:
`.github/scripts/tests/pr-automerge.test.mjs` reads the `script: |` block out of the workflow and runs it against a fake GitHub client, so the tests cover exactly what the workflow runs.
CI's `Auto-merge tests` job and `test.sh` run it.
It stays inline: a separate module would need a checkout step in the privileged `pull_request_target` job, and a module tested apart from the workflow can drift from what runs.
TicketManager's module arms native auto-merge without waiting for review, which the Template replaces.
IssueManager's waits for review as the Template does, without the review cap or the hand-back hold.
Both also merge an `UNSTABLE` PR (required checks passed, optional ones pending or failing).
The Template waits for `CLEAN` on purpose, so a failing optional check such as markdownlint gets fixed rather than merged past.

## What it guarantees

A same-repo PR into `main` squash-merges on its own once its required checks pass, a reviewer has reviewed its head commit, and every review thread is resolved.
The reviewer is Copilot, or Claude as its backup when a PR carries `review:claude`: see [ADR 0004](../docs/adr/0004-claude-review-as-copilots-backup.md).
Nothing merges before the review arrives, until the review cap: see [ADR 0002](../docs/adr/0002-copilot-review-cap-and-hand-back-hold.md).
A PR handed back with `sandcastle:needs-human` never merges while it carries the label.

## Design

- **The workflow merges directly and leaves GitHub's native auto-merge unarmed.** Native auto-merge merges the moment the required checks pass,
  and Copilot's review is requested on each push but isn't a required check, so the PR would land before the review.
  Two workflows arm native auto-merge on purpose, and this one skips a PR that already has it armed: `release.yml` on its blog PRs, and `dependabot-auto-merge.yml` on Dependabot's,
  which merge on green required checks without Copilot's review.
  Copilot flags the Dependabot bypass on review; it is the Baseline's policy, so answer it and name both in the skip's comment.
- **Readiness** comes from one GraphQL query: state, draft, fork, mergeability, `mergeStateStatus`, the auto-merge request, both reviewers' reviews and the review threads.
  The reviews are fetched by author, `copilot-pull-request-reviewer[bot]` and `github-actions[bot]`, so thread replies can't push them off the page.
  A `github-actions[bot]` review counts as Claude's only when its body starts with `<!-- claude-review -->`.
  A reviewer must have reviewed the exact `headRefOid`: both re-review every push, merge-from-main commits included.
  More threads than one page is left to a person.
- **Review cap.** Each reviewer re-reviews every push and can raise something new each time, so a PR could chase its reviews forever.
  Once Copilot and Claude between them have reviewed `COPILOT_REVIEW_CAP` (3) distinct non-merge commits, the merge stops waiting for a review of the head
  and stops counting their unresolved threads.
  The constant keeps Copilot's name because `github-settings.sh` reads the cap by it.
  Rounds are counted across both, so a PR can't reset the cap by switching reviewer.
  Merges from `main` aren't rounds: the ruleset keeps branches up to date, so they'd use up the cap without a fix.
  A thread belongs to whoever wrote its first comment; one with no known author counts as a person's.
  A `github-actions` thread is Claude's only when its first comment belongs to a marked review, so other workflows' threads still hold.
  Everything else still holds at the cap, and the log says when the cap let a PR through and past how many Copilot and Claude threads.
- **Hand-back hold.** A PR labelled `sandcastle:needs-human` (Sandcastle giving up and handing it to a person) is skipped while it carries the label,
  and also when someone other than the repository owner last removed it, since anyone with triage access can remove a label.
  The removal comes from the PR's paginated issue events, read with `GITHUB_TOKEN` (`issues: read`), so `RELEASE_PR_PAT` needs no Issues access.
  Both checks run again on a fresh snapshot, and every later check reads that snapshot, so a thread, head or check that changed meanwhile counts.
  More labels than one page is left to a person. A repo that never applies the label is unaffected.
- **The merge** is `pulls.merge` with `sha: headRefOid`, so a push landing between the check and the merge fails the merge instead of merging unreviewed code.
  405 and 409 are warnings; a later event re-evaluates.
- **Triggers**, each a moment a condition can become true: `pull_request_target` (opened, ready_for_review, reopened, edited, synchronize, and unlabeled for the hand-back label),
  `workflow_run` completion of every workflow that owns a required check, of **PR Review Submitted** and of **Claude Review**,
  a schedule (resolving a thread has no Actions trigger), and `workflow_dispatch` from `main`.
- **PR Review Submitted** (`pr-review-submitted.yml`) runs on `pull_request_review: submitted` with no permissions and does nothing.
  Its completion fires this workflow's `workflow_run`, which runs main's copy.
  Copilot's review usually arrives after CI has finished, so without it the last blocker clears with no trigger and the PR waits for the sweep (IssueTracker #197 waited, and was swept by hand).
- **Claude Review** (`claude-review.yml`) is the backup reviewer, run only while a PR carries `review:claude`, on `labeled`, `synchronize`, `reopened` and `ready_for_review`.
  It skips drafts, Dependabot and events a bot started (the action refuses a bot actor), and logs a notice and succeeds without the `CLAUDE_CODE_OAUTH_TOKEN` secret.
  It must not fail on its own: it isn't a required check, so a failed run leaves the PR `UNSTABLE`, which this workflow never merges; re-run it or remove the label.
  Claude (Sonnet 5.5, medium effort, `anthropics/claude-code-action`) never holds a write token: its job has read-only permissions,
  gets the diff against the base and only Read, Glob and Grep, and answers in a JSON schema.
  A second job runs `post_claude_review.py`, which posts one `COMMENT` review pinned to the head,
  each finding an inline thread, and a finding outside the diff in the body (GitHub rejects a whole review over one such comment).
  A body finding opens no thread, so this workflow wouldn't wait on it: the post job fails after posting, and that failing check holds the merge until the next push.
  The review is posted with `GITHUB_TOKEN`, which starts no workflows, so PR Auto-Merge follows Claude Review's completion instead of PR Review Submitted.
- **The schedule** is `7,22,37,52 * * * *`, off the round minutes where GitHub drops the most scheduled runs.
  GitHub still runs it far less often than asked: IssueTracker's sweeps after #201 ran about 70 minutes apart. Treat it as the fallback, never the expected path.
- **Safety:** `pull_request_target` runs main's copy of the file and never checks out PR code, so a PR can't edit what decides whether it merges.
  `pull_request_review` is never a trigger here: it would run the PR's own copy with write access. It reaches this workflow only through PR Review Submitted.
- **Token:** `RELEASE_PR_PAT`, falling back to `GITHUB_TOKEN`.
  A merge made with `GITHUB_TOKEN` starts no workflows, so the release and its blog PR would silently skip.

## Landing

- **A re-Apply PR opens ready, not as a draft, and this workflow lands it.** The copy on `main` is already the Template's,
  so it waits for Copilot's review of the head and every thread resolved; answer the threads and let it merge.
- **A Standardize PR is a draft landed by hand.** The repo's old workflow on `main` would merge it the moment its checks pass: see [Adapting](#adapting).
- **`land.sh` watches a round** until it lands: see [Landing a round](#landing-a-round).
- **Copilot's review request is read back.** `gh pr edit --add-reviewer @copilot` exits 0 even when GitHub drops the request,
  so `reapply.sh` and `land.sh` then read the PR's review requests (and Copilot's reviews of the head).
  When Copilot isn't there they add `review:claude`, so Claude Review reviews the head instead, and warn; they fail with the PR's URL only when adding the label fails.
- **GitHub drops the request once the account's Copilot code review budget is used up.** Nothing in the API says so:
  `gh pr edit` and GraphQL `requestReviewsByLogin` return success with no request, and REST `requested_reviewers` returns 422 "not a collaborator".
  Seen on 2026-10-07 from about 20:30 UTC (#97: TicketManager#131, then every re-Apply PR of the #82 round).
  Until the budget resets no Copilot review comes, which stranded the whole round: nothing merged.
  Claude Review is the way out now: `review:claude` (added by the tooling, or by hand) gets the head a review this workflow accepts.
  A repo without `CLAUDE_CODE_OAUTH_TOKEN` skips it, so there the choice is still to wait for the reset or review and merge by hand.
  Release-blog PRs don't wait for a review and still land.

## Adapting

- **Survey whether the repo's auto-merge waits for review.** IssueManager's armed native auto-merge and merged on `CLEAN` alone; its #231 merged with an open Copilot thread.
- `workflow_run.workflows` lists every workflow that owns a required check, by its `name:` (including `PR Title`), plus `PR Review Submitted`.
  A repo whose ruleset requires a check from a workflow outside the Template needs that workflow in the list: Template first.
- **Land the Standardize PR by hand, held as a draft.** The old workflow on `main` still runs on it and would arm auto-merge the moment its checks pass; drafts are the one state it skips.
  Open the PR as a draft, request Copilot's review with `gh pr edit <n> --add-reviewer @copilot`, and resolve every thread.
  Before `gh pr ready`, check `mergeStateStatus`: if it's `BEHIND`, keep the draft, run `gh pr update-branch <n>`, request the review again and wait for it on the new head.
  Then `gh pr ready <n>`, which starts CI again, so the PR is `BLOCKED` for one more full run; once it's green, the old workflow may merge it itself, which is fine now.
  Otherwise `gh pr merge <n> --squash --match-head-commit <sha>`.

## Status and the landing decision

Skill files (not copied into repos): `status.sh`, which runs `github/status.py`, `land.sh`, which runs `github/land.py`,
and the decision both act on, `github/landing.py`.
Tests: `github/tests/test_landing.py`, `test_status.py` and `test_land.py`, run by `test.sh`; none calls GitHub.

```bash
status.sh                     # one line per open PR in every repo in github/repos.txt
status.sh mpaulosky/<repo>    # just this repo
```

Each line shows the PR's head, draft, merge state, which reviewer reviewed the head (`review:copilot`, `review:claude` or `review:no`), open threads, auto-merge,
running, failed and cancelled checks, and the next action. It costs one GraphQL query per repo and prints nothing else
(one line when no PR is open), so it's the status check to run while PRs land, instead of hand-written queries.

`landing.decide(PrState)` returns one action, the rules PRs are landed by:
nothing for a merged, closed or already-armed PR; **report blocker** for a failed check, a cancelled check nothing newer replaced, or a conflict;
**mark ready** for a draft only when the caller says it should be (otherwise wait);
**arm auto-merge** for a release-blog PR its workflow didn't arm (branch `docs/release-notes` or `docs/backfill-blog-posts`, no review needed, as `release.yml` arms it);
**update branch and request Copilot** when it's `BEHIND`; **wait** until Copilot or Claude (a marked `github-actions[bot]` review) reviewed the current head and no thread is open;
then **leave to PR Auto-Merge** in a Baseline repo, whose workflow merges it (it never arms native auto-merge, so neither does anything going around it),
or **arm auto-merge** where there is no such workflow (dotfiles). A repo with no required checks (dotfiles, `repo-settings-only` in `repos.txt`) waits for its checks to finish green first,
since auto-merge alone wouldn't wait for CI. A cancelled run with a newer run of the same check on the same head is superseded, not a failure:
CI's concurrency cancels runs, and the newest counts. Commands that act on PRs call the same function, so they can't drift from these rules.

### Landing a round

```bash
land.sh --once --dry-run      # one pass over every open PR in github/repos.txt, printing the calls it would make
land.sh mpaulosky/<repo>#<n>  # watch these PRs (or owner/repo for all its open PRs) until they land
```

`land.sh` polls the PRs (default every 60 s, one GraphQL query per repo) and does what `decide()` says, once per head:
`gh pr update-branch` then `gh pr edit --add-reviewer @copilot` (and `--add-label review:claude` when the request is dropped), `gh pr ready` only with `--ready`,
and `gh pr merge --auto --squash --match-head-commit <head>`. It has no rules of its own.
It also watches each release-blog PR that opens in a watched repo, and after a watched Baseline PR merges it waits `--blog-wait` (15) minutes for one.
It prints status.sh's line only for a PR whose state or action changed (one line when no PR is open, then it exits),
and exits once every watched PR is merged or closed, or with 1 at `--timeout` (180 minutes).
On a `CLEAN` dotfiles PR, `gh pr merge --auto` merges at once, which is what arming there means: its checks are already green.

## Verify live

The next PR after the Standardize must sit green but unmerged until Copilot's (or Claude's) review of its head arrives, and again while any thread is open.
The workflow's log names what it waits on (`Waiting on PR #n: no Copilot or Claude review of <sha> yet.`, or `<k> unresolved review thread(s).`).
Once the last thread is resolved, the next sweep merges it; that can take an hour or more, since GitHub thins out scheduled runs.

**A submitted review re-checks the PR, but not Copilot's** (seen live on TicketManager #113, 2026-10-04).
Copilot's review did start **PR Review Submitted**, but GitHub held that run at `action_required`, waiting for someone to approve it,
so it never completed and PR Auto-Merge wasn't re-checked. A review the owner submitted (a reply to Copilot's thread) ran at once.
So the trigger helps only with reviews people submit; a PR whose last blocker is Copilot's review still waits for the sweep.
Copilot's review workflow itself ("Copilot", `dynamic/agents/copilot-pull-request-reviewer`) can't take its place: a probe on dotfiles (#38)
showed its completion does fire `workflow_run`, but GitHub holds that run at `action_required` too, because Copilot is the actor.
Any workflow a Copilot review starts waits for approval, so the scheduled sweep stays the way Copilot's review gets a PR merged.
After a third reviewed non-merge commit, the log reads `Review cap (3) reached on PR #n: merging ...` if the cap is what let it through.

**Claude Review**, on TicketManager with the secret set and Copilot unavailable: a re-Apply PR gets `review:claude` from `reapply.sh`,
Claude's review of its head (a `github-actions[bot]` review starting with `<!-- claude-review -->`, findings as threads),
and merges through PR Auto-Merge once its threads are resolved. The re-Apply PR that brings Claude Review in still runs the old `pr-automerge.yml` from `main`,
so the round after it is the first that can land on Claude's review.
