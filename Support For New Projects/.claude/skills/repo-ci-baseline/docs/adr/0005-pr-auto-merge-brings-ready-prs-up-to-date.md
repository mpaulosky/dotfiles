# PR Auto-Merge brings ready PRs up to date, and a clean merge from main keeps its review

**Status:** accepted and implemented in `template/owned/.github/workflows/pr-automerge.yml` and `claude-review.yml` (#142).

Every Baseline repo's `main-rules` requires a branch to be up to date before it merges.
Each merge to `main`, and the release-blog PR each merge opens, leaves every other open PR `BEHIND`,
and `pr-automerge.yml` treated `BEHIND` as "wait for a later event" that never came.
PRs merged only while someone ran `land.sh` or `gh pr update-branch` by hand: Blazor-Server #183's two "Merge branch 'main'" commits
(committed by `web-flow`, authored by the owner, 50 seconds apart, after each of two merges to `main`) were `land.sh` doing exactly that.
That works only while someone watches, and each update re-requested Copilot, whose budget runs out.

So PR Auto-Merge now does the update itself, and a clean merge from `main` no longer needs a new review.

## Decisions

- **Update only a PR that is otherwise ready.** A same-repo, non-draft PR into `main` whose head is reviewed (or covered, below) or past the cap,
  with no thread holding it, no off-diff hold, no `sandcastle:needs-human`, `mergeable: MERGEABLE` and every required check's newest run passed,
  gets `PUT /pulls/{n}/update-branch` with `expected_head_sha` set to that head.
  An update reruns all of CI (and, before this change, a review), and a PR still waiting on a review or a fix gains nothing from being current;
  it is updated on the first event after it becomes ready. The cost is one more CI run between the review and the merge, the same as by hand.
  Required checks are read from the head's check runs (`isRequired`), since `mergeStateStatus` says only `BEHIND` and the rollup's own state
  counts this workflow's runs and cancelled duplicates.
- **A PR with native auto-merge armed** (release-blog PRs, Dependabot's) is updated once its required checks pass, with no review: GitHub merges it, but never brings it up to date.
- **`RELEASE_PR_PAT`, never `GITHUB_TOKEN`.** A merge commit pushed with `GITHUB_TOKEN` starts no workflows, so CI would never run on it.
  Without the PAT the run logs a notice and the PR waits, as before.
- **Dependabot's own PRs get `@dependabot rebase`** instead, once per head (the comment ends with a marker naming the head), so Dependabot keeps managing them.
  One that someone else pushed to (any commit not authored by `dependabot[bot]`) is updated like any other PR.
- **A push to `main` sweeps the open PRs.** No existing trigger fired when `main` moved: the `workflow_run`s of `main`'s own CI carry `main`'s head,
  which no open PR has. `push: branches: [main]` runs `main`'s copy, like every other trigger. Right after the push GitHub reports `UNKNOWN`
  while it recomputes, so the run asks again a few times (5 s apart) before leaving the PR to the next event.
- **No loops or races.** Each update is pinned to the head it judged, so it happens at most once per head: a second request for that head,
  from a parallel run, is refused with a 422 (or merges nothing new), which is logged quietly. Fork PRs are never touched. An update error is a warning,
  never a failed run: on a `pull_request_target` run that would be a failed check on the PR.
- **A clean merge from `main` keeps the review of the commit it merges into.** The head counts as reviewed when it is a merge
  whose first parent is reviewed (or is itself such a merge, up to five deep), whose second parent is on `main`,
  and whose every file is what a clean merge gives: where both sides agree, that; where only one side changed a file since the merge base, that side's version.
  A file both sides changed, a rename across them, or any other change (a conflict resolution included) needs a fresh review.
  So nothing reaches `main` that neither a reviewer nor `main` itself has seen. Claude's off-diff hold on the covered commit still holds.
  This was already the cap's view: merges from `main` aren't review rounds ([ADR 0002](0002-copilot-review-cap-and-hand-back-hold.md)).
- **Claude Review skips such a head** on `synchronize`, by the same rule, in a job of its own before the review job,
  so a skipped run doesn't join the review's concurrency group and cancel a review in progress. It reviews whenever it can't tell.
- **`land.sh`** keeps updating `BEHIND` PRs (it also covers repos without the PAT, and dotfiles), but in a Baseline repo it no longer re-requests Copilot for a head that was already reviewed.

## Considered Options

- **Update every `BEHIND` PR**: rejected; it reruns CI on PRs that can't merge yet, and each new head re-requested a review.
- **The merge queue** (#142's option 2): the most robust, but it replaces the up-to-date rule and this workflow's merge, and depends on the plan's features.
- **Drop the strict up-to-date rule** (option 3): cheapest, but `main` would no longer be tested as merged.
- **Use `git merge-tree` in PR Auto-Merge**: rejected; the privileged `pull_request_target` job never checks out PR content. The tree rule needs only the API.
- **Accept any merge commit whose second parent is on `main`**: rejected; a merge commit can carry any change, and a conflict resolution is new code.

## Consequences

- Copilot still re-reviews each update (`review_on_push` in `main-rules`) while its budget lasts; its review is no longer waited for.
- A merge from `main` that git resolved by merging a file both sides changed is reviewed again, as is a rename across the two sides.
- The two copies of the rule (JavaScript in `pr-automerge.yml`, Python in `claude-review.yml`) must agree; each has tests on the same shapes of history.
  Where they could differ (several merge bases, a tree listing GitHub truncates), Claude Review errs towards reviewing,
  except for a tree past GitHub's listing limit (100,000 entries), which no Baseline repo comes near.
- A repo without `RELEASE_PR_PAT` keeps waiting on `BEHIND` PRs, with a notice in the run log.
