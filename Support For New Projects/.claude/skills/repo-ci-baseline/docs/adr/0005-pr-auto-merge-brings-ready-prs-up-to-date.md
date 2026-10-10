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
  with no thread holding it, no off-diff hold, no `sandcastle:needs-human`, `mergeable: MERGEABLE`, every required check's newest run passed
  and no check's newest run failed, required or not, gets `PUT /pulls/{n}/update-branch` with `expected_head_sha` set to that head.
  An update reruns all of CI (and, before this change, a review), and a PR still waiting on a review or a fix gains nothing from being current;
  it is updated on the first event after it becomes ready. The cost is one more CI run between the review and the merge, the same as by hand.
  Required checks are read from the head's check runs (`isRequired`, through `headRef`, since GitHub lists a PR's commits by date)
  and from `main`'s rulesets (`GET /rules/branches/main`), since `mergeStateStatus` says only `BEHIND`, the rollup's own state
  counts this workflow's runs and cancelled duplicates, and a required check whose job isn't queued yet has no run: it counts as pending.
  A failed optional check holds the update too: Claude Review's post and answer-check jobs fail on purpose to leave a PR `UNSTABLE`,
  and an update would start a new head without the failure. PR Auto-Merge's own job is left out: a transient failure of it stays on the head
  until the next PR event.
- **A PR with native auto-merge armed** (release-blog PRs, Dependabot's) is updated once its required checks pass, with no review: GitHub merges it, but never brings it up to date.
  A failed optional check doesn't hold it, since GitHub merges it on its required checks alone.
- **`RELEASE_PR_PAT`, never `GITHUB_TOKEN`.** A merge commit pushed with `GITHUB_TOKEN` starts no workflows, so CI would never run on it.
  Without the PAT the run logs a notice and the PR waits, as before.
- **Dependabot's own PRs get `@dependabot rebase`** instead, once per head (the comment ends with a marker naming the head;
  only a marker the PAT's account posted counts), so Dependabot keeps managing them.
  One that someone else pushed to (any commit not authored by `dependabot[bot]`) is updated like any other PR.
- **A push to `main` sweeps the open PRs.** No existing trigger fired when `main` moved: the `workflow_run`s of `main`'s own CI carry `main`'s head,
  which no open PR has. `push: branches: [main]` runs `main`'s copy, like every other trigger. Right after the push GitHub reports `UNKNOWN`
  while it recomputes, so the run asks again a few times (5 s apart) before leaving the PR to the next event.
  A sweep updates one ready `BEHIND` PR, the oldest (#155): updating every ready PR at once makes them race, and each merge leaves the rest
  `BEHIND` again, so N PRs cost on the order of N² CI runs. One at a time, each merge's push brings the next one up to date.
  The update comes after the sweep's merges, and only if there were none, so a merge in the same sweep can't undo it.
  The limit is per sweep: a scheduled sweep during an updated PR's CI run can start a second update, which is accepted (schedules run about an hour apart).
  When the updated PR doesn't merge (red CI, a merge that needs a fresh review, a new thread), nothing pushes to `main`, so the other ready PRs
  wait for the next scheduled sweep, which skips the stuck PR and updates the next. That hour's wait, only when the front PR fails, is the accepted price of not spending N² CI runs on every merge.
- **No loops or races.** Each update is pinned to the head it judged, so it happens at most once per head: a second request for that head,
  from a parallel run, is refused with a 422 (or merges nothing new), which is logged quietly. Fork PRs are never touched. An update error is a warning,
  never a failed run: on a `pull_request_target` run that would be a failed check on the PR.
- **A clean merge from `main` keeps the review of the commit it merges into.** The head counts as reviewed when it is a merge
  whose first parent is reviewed (or is itself such a merge, up to five deep), whose second parent is on `main`,
  and whose every file is what a clean merge gives: where both sides agree, that; where only one side changed a file since the merge base, that side's version.
  A file both sides changed, a rename across them, or any other change (a conflict resolution included) needs a fresh review.
  So nothing reaches `main` that neither a reviewer nor `main` itself has seen. Claude's off-diff hold on the covered commit still holds,
  even when Copilot reviewed the merge: the hold comes from the newest commit Claude reviewed down the chain of clean merges.
  This was already the cap's view: merges from `main` aren't review rounds ([ADR 0002](0002-copilot-review-cap-and-hand-back-hold.md)).
- **Claude Review skips such a head** on `synchronize`, by the same rule, in a job of its own before the review job,
  so a skipped run doesn't join the review's concurrency group and cancel a review in progress. It reviews whenever it can't tell,
  and whenever the base's `pr-automerge.yml` doesn't honour the skip: dotfiles has none (it carries a copy of `claude-review.yml` and lands PRs with `land.sh`,
  whose decision wants a review of the exact head), and the re-Apply PR that brings this change still has the old one on `main`. The same job skips a run whose head is no longer the PR's,
  since the check job's varying length could otherwise let a stale review join the concurrency group last and cancel the newer one,
  unless the newer head only merges `main` into it and no run for it got past the job's condition: an app's or Copilot's push of that merge starts no review,
  so the stale head is reviewed, which covers the merge. That review and its post take concurrency groups keyed by the stale head,
  so they can't cancel the newer head's review (a CANCELLED check would hold the PR), and PR Auto-Merge evaluates every open PR holding the commit
  a Claude Review run completed on, not only the PR whose head it is.
- **`land.sh`** keeps updating `BEHIND` PRs (it also covers repos without the PAT) and keeps requesting Copilot after an update:
  Copilot reviews every push anyway (`review_on_push`), and the request's read-back is what calls in Claude (`review:claude`) when Copilot's budget is spent,
  for an update that isn't a clean merge. The label stays on, so that costs at most one Claude review per PR.

## Considered Options

- **Update every `BEHIND` PR**: rejected; it reruns CI on PRs that can't merge yet, and each new head re-requested a review.
- **The merge queue** (#142's option 2): the most robust, but it replaces the up-to-date rule and this workflow's merge, and depends on the plan's features.
- **Drop the strict up-to-date rule** (option 3): cheapest, but `main` would no longer be tested as merged.
- **Use `git merge-tree` in PR Auto-Merge**: rejected; the privileged `pull_request_target` job never checks out PR content. The tree rule needs only the API.
- **Accept any merge commit whose second parent is on `main`**: rejected; a merge commit can carry any change, and a conflict resolution is new code.

## Consequences

- Copilot still re-reviews each update (`review_on_push` in `main-rules`) while its budget lasts; its review is no longer waited for.
- A merge from `main` that git resolved by merging a file both sides changed is reviewed again, as is a rename across the two sides.
  When PR Auto-Merge made that update, nothing calls in Claude: with Copilot's budget spent and no `review:claude` on the PR,
  it waits for a review like any other push (`status.sh` shows `review:no`); add the label, or let `land.sh` do it.
- The two copies of the rule (JavaScript in `pr-automerge.yml`, Python in `claude-review.yml`) must agree; each has tests on the same shapes of history.
  Where they could differ (several merge bases, a tree listing GitHub truncates), Claude Review errs towards reviewing,
  except for a tree past GitHub's listing limit (100,000 entries), which no Baseline repo comes near.
- A repo without `RELEASE_PR_PAT` keeps waiting on `BEHIND` PRs, with a notice in the run log.
- Accepted limit: a stale head's review reports its checks on that older commit, not on the PR's head.
  So when it fails on purpose (an answer withheld for quoting a secret, or an execution file it can't read), it posts no review and the head shows no failed check.
  Below the review cap the head then still waits for a review. Past the cap it can merge, since the cap stops that wait.
  Counting failed Claude Review checks on commits under the head would mean walking the chain whether or not anything was reviewed,
  and reading each commit's checks, for a case that needs a stale review, a deliberate failure and a PR past the cap all at once.
  The post job's warning and the failed check on the older commit stay visible on the PR.
