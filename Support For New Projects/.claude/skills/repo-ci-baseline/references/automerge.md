# Auto-merge after review

Template files (Owned): `.github/workflows/pr-automerge.yml` and its tests in `.github/scripts/tests/pr-automerge.test.mjs`, `.github/workflows/pr-review-submitted.yml`,
and Claude Review: `.github/workflows/claude-review.yml` with `.github/scripts/post_claude_review.py` and its tests in `.github/scripts/tests/test_post_claude_review.py`,
with `dependabot-auto-merge.yml` and `release.yml` as the two deliberate exceptions.
History: IssueTracker #140 and #201 (re-check on a submitted review); Blazor-Server #94 (the hand-back label hold) and #119 (the Copilot review cap, now the review loop of mpaulosky/dotfiles#375).
IssueManager #235 moved the decision into `.github/scripts/automerge-decision.mjs` with `node --test` tests, and TicketManager carries the same shape.
The Template keeps the script inline in the workflow and tests it there:
`.github/scripts/tests/pr-automerge.test.mjs` reads the `script: |` block out of the workflow and runs it against a fake GitHub client, so the tests cover exactly what the workflow runs.
CI's `Auto-merge tests` job and `test.sh` run it.
It stays inline: a separate module would need a checkout step in the privileged `pull_request_target` job, and a module tested apart from the workflow can drift from what runs.
TicketManager's module arms native auto-merge without waiting for review, which the Template replaces.
IssueManager's waits for review as the Template does, without the review loop or the hand-back hold.
Both also merge an `UNSTABLE` PR (required checks passed, optional ones pending or failing).
The Template waits for `CLEAN` on purpose, so a failing optional check such as markdownlint gets fixed rather than merged past.

## What it guarantees

A same-repo PR into `main` squash-merges on its own once its required checks pass, a reviewer has reviewed its head commit, and every review thread is resolved.
The reviewer is Copilot, or Claude as its backup when Copilot can't review the head (its quota note, or a request GitHub dropped, #318, #360): see [ADR 0004](../docs/adr/0004-claude-review-as-copilots-backup.md).
Claude reviews only where Copilot can't: `review:claude` is ignored while Copilot can review (mpaulosky/dotfiles#378), and PR Auto-Merge takes it off at once.
Nothing merges before the review arrives, or past an unresolved thread, until the PR's review loop is exhausted (three dirty rounds in a row);
an exhausted loop is documented in one comment and then merges with the threads Copilot and Claude opened still open, but not past a thread a person opened:
see [ADR 0002](../docs/adr/0002-copilot-review-cap-and-hand-back-hold.md).
A ready PR that falls `BEHIND` main is brought up to date, and a clean merge from main keeps the review of the commit it merges into:
see [ADR 0005](../docs/adr/0005-pr-auto-merge-brings-ready-prs-up-to-date.md).
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
  Even then it counts as a review of a commit only where Copilot can't review it: Claude is the backup. Copilot can't when its quota note is on that
  commit, or when it is the head, Copilot was asked, the ask has settled and Copilot has no review of it and no pending review request (GitHub drops the request "without a word" once the
  budget is used up, #318; ADR 0004's #360 update; a request list the run can't read in full counts as pending, and a record it can't read as not settled).
  The ask settles 30 seconds after its record, or at once for the run that asked and read the request back. A Claude review of an earlier commit with no note covers
  nothing, label or not (so `land.sh` and the workflow agree on that).
  A head with no check besides Claude's and the workflow's own gets no label from the run: it logs a notice to review and merge it by hand.
  `land.sh` and the workflow use one rule (`landing.copilot_gone`), and `land.sh` waits out the 30 seconds too, even for a request it read back as dropped:
  PR Auto-Merge takes `review:claude` off an ask younger than that and `land.sh` would not add it again (mpaulosky/dotfiles#378).
  Neither counts Claude's review of a head Copilot's request is still pending for (unless the note is on it), since that review may be merely late and counting Claude's would let the PR merge before Copilot's
  findings arrive (`pr-automerge.test.mjs` pins each case).
  A Copilot review counts only when it reviewed something. Once the account's Copilot code review quota is used up, Copilot still posts a review
  of each head whose body starts "Copilot was unable to review" (`COPILOT_NO_REVIEW`). It covers no commit and counts toward no round.
  `claude-review.yml`'s reviewed list and the landing scripts (`landing.COPILOT_NO_REVIEW`) skip it the same way: the start of the body, after any
  whitespace. Copilot's "wasn't able to review any files" note (every changed file is one it excludes) still counts, as before.
  `github/tests/test_copilot_no_review.py` runs the JS, jq and Python patterns on the same bodies.
  `claude-review.yml`'s reviewed list holds a Claude review of a commit with Copilot's note and of the PR's current head (whatever Copilot's request or the ask's state, so a head isn't reviewed twice),
  and none of an earlier commit without a note,
  so a clean merge of main into an earlier commit Claude reviewed under a dropped request gets a review of its own when its push starts a run, instead of waiting for a person.
  When a bot pushes a clean merge H2 of main while Claude Review is running for the earlier head H1, that run reviews H1 if H1 carries Copilot's note, since the gate counts
  a review of a commit that is no longer the head only then; without the note it reviews H2 itself, against main's current tip, because H2's own run is skipped (a bot's push).
  This covers only a run that sees H2 at its check step: when H1's run is past that step or finished before the bot pushed, nothing starts a run for H2, and PR Auto-Merge doesn't re-trigger
  `review:claude` for it, so H2 waits for a person's push or label.
  `land.sh` treats a head Copilot answered with the note as it treats a dropped request: it adds `review:claude` rather than asking Copilot (it asks once per PR).
  PR Auto-Merge does the same (#190), so a PR nobody lands with `land.sh` gets Claude's review too (#189 waited for one that never came).
  Counting it let
  Blazor-Server#390 merge an unreviewed head and made Claude Review skip that head and Blazor-Server#392's (Blazor-Server#393).
  A reviewer must have reviewed the `headRefOid`, or the commit a chain of clean merges from main sits on (below).
  More threads than one page is left to a person.
- **Resolved bot threads nobody replied to (mpaulosky/dotfiles#328).** `docs/PROCESS.md` has a session reply to a fixed thread with the
  fixing commit's short SHA and what changed, but nothing made it, and a thread resolved by hand in the GitHub UI skips the reply.
  Once every thread is resolved, the run logs a notice (`core.notice`) naming up to 3 such threads as `path:line` with the opening comment's url
  and `and N more`. It is a notice, not a hold: the PR merges. A thread counts when it is resolved, its opening comment is by the Bot
  `copilot-pull-request-reviewer` or by `github-actions` in a review starting with `CLAUDE_MARKER` (the rule `claude-review.yml` reads threads by),
  and no later comment is by another login. The reply's text isn't read, so Sandcastle's reply (a reason, not a commit) and a session's reply count;
  a person's thread, another bot's and a thread with more comments than the 10 read don't. To make it a hold, return from `mergeIfReady`
  after the notice and have `decide()` return `WAIT` for `unreplied_threads`. The notice repeats on each evaluation of a PR that waits on something else.
- **The review loop (mpaulosky/dotfiles#375, replacing the review cap of #119).** Each reviewer re-reviews every push and can raise something new each time,
  so a PR could chase its reviews forever. One loop bounds both reviewers, counted in dirty rounds in a row:
  - A **round** is a review of a non-merge commit, Copilot's or Claude's (Claude's counts where Copilot can't review the PR: its quota note is on that commit or on the head,
    or the ask settled with no request pending). A merge of `main` is never a round (PR Auto-Merge's own update-branch makes them, and the ruleset keeps branches up to date),
    and two reviews of one commit are one round.
  - A round is **dirty** when its review raised at least one inline thread (`comments.totalCount`) or, for Claude, a finding outside the diff, and **clean** otherwise.
  - The loop is **exhausted** after `MAX_CLAUDE_ROUNDS` (3) dirty rounds in a row, counted back from the newest reviewed commit; a clean round ends the count at zero,
    and a merge of `main` between rounds changes nothing. `COPILOT_REVIEW_CAP` keeps its name and its value 3 because `github-settings.sh` reads it, and bounds nothing itself.
  - Until then every new non-merge head that nobody reviewed gets a review: Copilot's, or `review:claude` added where Copilot can't review it, even if an earlier removal
    took the label off. A clean review of the head, every thread resolved and the required checks green merges, as always.
  - **At exhaustion** the run takes `review:claude` off (`GITHUB_TOKEN`, #170; before the draft, hand-back and auto-merge checks, for any open same-repo PR into `main`),
    posts **one comment** with `GITHUB_TOKEN` and then lets the PR merge once its required checks pass and it has no conflict. Exhaustion itself holds nothing,
    and the threads Copilot and Claude Review opened that are still unresolved then hold nothing either, nor Claude's findings outside the diff on the head: the comment is where they are kept,
    so they can be resolved later. **A thread opened by a person still holds the merge** (an unreadable author counts as a person), and the log says so:
    `Waiting on PR #n: N unresolved review thread(s) opened by a person hold the merge`. This supersedes #146's rule that every unresolved thread held the merge, whatever the round,
    for the bots' threads only (mpaulosky/dotfiles#378). The comment names the head and says whether a review covers it (``The head `abc1234` was not reviewed.``, or that it is a clean merge of `main`
    onto a reviewed commit), says `review:claude` is off (or is being removed, when the removal failed), and holds a bullet list of every thread still unresolved
    (path and line, the first line of its first comment, a link to the thread; a person's thread is marked "holds the merge" and is listed first when the list is cut) and every off-diff finding
    of Claude's review of the head (its first line). It ends with the hidden marker
    `<!-- pr-automerge:review-loop-exhausted <head> -->`, so it is posted once per exhaustion, before the merge call. Text quoted from the PR is escaped, since it is posted as `github-actions`.
    The record is "the newest marker comment is no older than the newest round", so a head moved by update-branch while exhausted posts no second one, and a new dirty round after it does.
    Two runs can both find no comment, so after posting a run reads the comments again and deletes its own when another run's comment for this exhaustion is listed first.
    The comment is posted once the PR is otherwise ready: not `BEHIND` (updated first), no conflict, required checks green, not while a check still holds it.
    A comment that fails to post, or comments that weren't read in full, hold the merge until the next event. The comment is looked for in all the PR's comments:
    when the last 100 hold none the run pages through them with `issues.listComments`, and when it still can't read them it posts a notice naming the PR.
    A failing required check, a conflict, a branch that is `BEHIND`, a draft and the hand-back label still hold it. The log says `Review loop exhausted on PR #n: merging with N unresolved thread(s)`.
  - **A new loop.** The first `review:claude` added after the round that exhausted the loop **by a login with write access to the repository** (the owner, or the PAT's account, read with
    `repos.getCollaboratorPermissionLevel`, `GITHUB_TOKEN`) starts one: only rounds submitted after it count, whether or not the exhaustion comment exists yet
    (a PR with none gets the old loop's comment first). An add by anyone else is ignored, and a permission that can't be read leaves the loop unread (no merge, no label, a warning): it fails closed.
    A **404** from the permission lookup (a login that no longer exists) is no write access, cached for the run like a found permission;
    a network error, a 5xx and a rate limit still leave the loop unread (mpaulosky/dotfiles#381).
    **A recognised restart stays recognised** (mpaulosky/dotfiles#381): an add counts unless PR Auto-Merge (`github-actions`) removed the label after it
    and before the next round, which is what an add made while Copilot can review leaves behind. Whether Copilot can review now doesn't decide it,
    so Copilot reviewing a later head, or a request going pending, doesn't undo a restart. `landing.py` and `status.py` read the label's `unlabeled` events the same way.
    The first add, not the latest: PR Auto-Merge's PAT adds the label for later heads in the new loop, and a restart at that add would make it endless.
    Reading the label events fails closed too. PR Auto-Merge never adds `review:claude` while the comment is the newest word on the PR.
  - **Claude reviews only where Copilot can't** (mpaulosky/dotfiles#378). Copilot can't review the PR when its quota note is on the head, or it is gone (asked, the ask settled, no request pending,
    and no real review of the head). Otherwise `review:claude` is ignored while Copilot can review: the run takes it off at once, whoever added it (the workflow starts on the `labeled` event for that),
    logs why, and `claude-review.yml` starts no paid review (its first step applies the same rule; when it can't read the state it skips with a warning). No exception for an owner's add.
    No add counts as the start of a new loop then either.
  - The run takes `review:claude` off a PR once Copilot has really reviewed its head (#270) too: Copilot has budget, so Claude's review would cover nothing.
    A failed removal is a warning, tried again on the next run. A Claude Review run that posts nothing (a failure, a timeout, a usage limit) leaves the label on until one posts
    and makes no round. That's accepted: such a run opens no thread and holds no merge, so it costs only the runs.
  - A review of a merge from `main` is not paid for either: `claude-review.yml` skips a clean merge of `main` into any commit a reviewer reviewed (Claude's review of any commit is listed).
  - A re-Apply PR (`chore/reapply-baseline`) is bounded like any other since #174. It was exempt from #115 (Articles#298 merged past
    a real Copilot finding on its third round), but with Claude reviewing each re-Apply commit across every repo, the exemption let a round
    chase reviews indefinitely. A finding on a re-Apply PR is fixed in the Template and arrives with the next round.
- **Asking Copilot once (#360, replacing #318's grace).** When a same-repo, non-draft PR's head has no Copilot review or quota note, no Copilot request pending, no review
  covering it and no record of an ask, and the PR's review loop isn't exhausted, the run asks Copilot for its review of the PR once.
  It posts a comment holding `<!-- pr-automerge:copilot-asked -->` (the record, `COPILOT_ASKED_MARKER`; written before the request, with `GITHUB_TOKEN`),
  requests the review with the PAT (GraphQL `requestReviewsByLogin`, as Sandcastle does), and reads the request back for up to `COPILOT_ASK_WAIT_MS` (30 seconds, polling every 5).
  Two runs can both post one, so the run then reads the PR's comments again (up to three times, `COPILOT_ASK_REREADS`, `COPILOT_ASK_REREAD_MS` apart, if its own record doesn't show or the read fails;
  a rate limit or a bad token ends the retries, and a sweep's run) and stands down if another run's record is listed before its own (#369);
  a run that never finds its own record, or whose every re-read fails with an error that doesn't end a run, requests anyway with a warning (#374), since a repeat request is idempotent.
  Only a record by `github-actions` or the repository owner counts, and the first one listed decides. A comment that fails to post means no request, and a request that fails
  counts as dropped at once. A record that can't be read (the comments query is the last 100 comments; more than that with no record among them) counts as asked but not settled:
  nothing asks, and nothing is called dropped. Copilot is never asked again for the PR: a later head with no pending request goes straight to the next bullet,
  because the record is long settled. A request that registers (the ruleset's own per push, or a budget that came back) is waited for, and a real Copilot review of the head
  takes the label off (#270). `land.sh` writes the same record (a comment as the owner) and makes the same request, so the two agree.
- **Calling in Claude (#190, #318, #360).** When Copilot's quota note is the only review of the head, or Copilot was asked and the ask has settled
  (30 seconds after the record, `COPILOT_ASK_SETTLE_MS`, or in the run that asked and read the request back) and it has no review of the head and no request
  pending, and no review covers it while the loop isn't exhausted,
  the run adds `review:claude` on much the terms `land.sh` uses (`landing.review_needed`), whose constants a test holds in step:
  no merge conflict, the required checks passed (one with no run yet is pending) and no check failed but Claude Review's own,
  the label isn't on, no person took it off and no exhaustion comment is the newest word (the owner adds the label to start a new loop).
  A check that isn't required and is still running doesn't hold it, as it doesn't hold an update: unlike `land.sh`, which polls,
  this workflow waits for an event, and that check's completion may never start it (another workflow's, or an app's like CodeQL's).
  In a repo where neither main's rulesets nor `isRequired` name a required check, the head's checks must all have finished instead
  (mpaulosky/dotfiles#216), and CI must have reported: the head needs a check other than Claude Review's and PR Auto-Merge's own, and
  no workflow run for the head may still be queued, waiting or in progress, as its jobs may not have created their checks yet
  (mpaulosky/dotfiles#233). A CI run held for approval (`action_required` as its status or its conclusion, as GitHub holds a
  Copilot push's runs) has created no checks either, so the run logs a notice to approve the PR's runs or merge by hand.
  PR Review Submitted's, Claude Review's and PR Auto-Merge's own held runs don't count: Copilot's review always leaves a PR Review
  Submitted run held (mpaulosky/dotfiles#236). Nor does a held run that a later run (higher `id`) of the same workflow `path` and
  `event` has replaced, as when the owner starts the workflow again on the head (mpaulosky/dotfiles#238). It reads the head's
  checks again after the runs and waits if they changed, as a run may have finished between the two reads. When everything is quiet but no CI check exists (path filters left out every CI
  workflow, or a push with `GITHUB_TOKEN` started none, leaving GraphQL's `statusCheckRollup` null), nothing will start the
  workflow again, so the run logs a notice to review and merge it by hand. A failed read of the runs isn't settled.
  As for an update, that holds only off a PR event, where CI may not have created the required checks yet.
  Once the label is added, the run logs a notice that it has no required check.
  A person who took the label off decides for that PR, so it isn't added back; this workflow's own removals don't count.
  The run logs a notice naming them, to add it back or review and merge by hand (mpaulosky/dotfiles#215).
  When the label is on but no review of the head is coming, the run logs a notice to push, or to take the label off and add
  it back (mpaulosky/dotfiles#209). It reads Claude Review's workflow runs for the head (`actions: read`): none ran or runs,
  and one since the label was last added was held for approval (as GitHub holds a Copilot push's runs) or skipped a push
  by a bot or Copilot. A person's skip (another label, a draft) doesn't count. A push with `GITHUB_TOKEN` starts no run,
  which looks like one not started yet, so it gets none. A Dependabot PR gets its own notice first, as nothing brings it a review.
  It adds the label with `RELEASE_PR_PAT`, since a label added with `GITHUB_TOKEN` starts no workflow and Claude Review would never run,
  so the PAT needs Pull requests (or Issues) write; without it every run only warns that adding the label failed.
  Without the PAT it logs a notice to add it by hand. A failure is a warning, never a failed check.
  When the quota note comes before CI finishes (as on #189), CI's `workflow_run` adds it.
  When it comes after, nothing starts this workflow: GitHub holds any run a Copilot review starts at `action_required`
  (see [Verify live](#verify-live)), so the next scheduled sweep adds it, often an hour or more later. That's accepted:
  the PR would otherwise wait for a person, and the held run creates no check on the head, so it doesn't hold the label back.
  A dropped request is read back in the run that makes it, so the label is added in that run, not after an event a dropped request never brings.
  A later head's dropped request brings none, but nothing is asked for it: the record decides at once, and the head's own events (its push, CI's completion) start the run.
  A head with no check but Claude Review's and this job's own gets the notice above to review and merge it by hand.
- **Reviewing until a review comes back clean (#193).** Claude Review reviews every push while the label is on,
  so a fix for its findings is reviewed in turn. Reviewing is done when a review of the head comes back clean
  (no threads, no findings outside the diff): that covers the head, and the PR merges once its checks are green.
  The stop is the exhausted review loop (`MAX_CLAUDE_ROUNDS` dirty rounds in a row, Copilot's and Claude's together): there the label comes off,
  one comment documents the threads and findings still open, and the PR merges once its checks pass, without a review of the last fix
  ([ADR 0002](../docs/adr/0002-copilot-review-cap-and-hand-back-hold.md)). With the cap counted in reviewed commits (#190), a second round's findings left their fix unreviewed
  and the PR waited for the owner (#191 and #192 both did); with merges of `main` counted, #371 stalled the same way. Neither happens now.
- **Merges from main keep their review** ([ADR 0005](../docs/adr/0005-pr-auto-merge-brings-ready-prs-up-to-date.md)).
  The head counts as reviewed when it is a merge whose first parent is reviewed (or is such a merge, up to `MERGE_CHAIN_LIMIT`, 5, deep),
  whose second parent is on `main`, and whose every file is what a clean merge gives: where only one side changed a file since the merge base,
  that side's version, compared by mode and blob together, so a mode-only change (`chmod +x`, a file swapped for a symlink) isn't clean (#155).
  Read with the API alone (commits, compare and recursive trees), since the job never checks out PR content.
  A file both sides changed, a rename across them or any other change needs a fresh review. Claude's off-diff hold on the covered commit still holds,
  even when Copilot reviewed the merge: it comes from the newest commit Claude reviewed down the chain of clean merges.
  Claude Review's `merge-from-main` job skips the review of such a head on `synchronize` by the same rule (with `git ls-tree` on its checkout),
  in a job of its own so a skipped run can't cancel a review in progress; the two copies must agree.
  It reviews anyway when the base's `pr-automerge.yml` lacks the rule (a re-Apply PR's `main` has the old one),
  and skips a run whose head is no longer the PR's, unless the newer head only merges `main` into it
  and no run for it got past the job's condition (an app's or Copilot's push of that merge starts no review, so the older head is reviewed
  if it carries Copilot's note, which covers the merge; otherwise the run reviews the newer head itself).
  That review and its post take concurrency groups keyed by the older head, so they can't cancel the newer head's review,
  and a Claude Review run's completion evaluates every open PR holding its commit, not only the PR whose head it is.
- **Bringing a ready PR up to date.** A PR that passes every check above but is `BEHIND` (and `MERGEABLE`, every required check's newest run passed,
  no check's newest run failed, required or not) gets `pulls.updateBranch` with `expected_head_sha: headRefOid`, made with `RELEASE_PR_PAT`, since a `GITHUB_TOKEN` push starts no CI.
  Required checks are the head's `isRequired` ones (read through `headRef`, since GitHub lists a PR's commits by date) and the ones `main`'s rulesets list;
  one with no run yet (its job not queued) is pending. A failed optional check holds the update: Claude Review fails on purpose to leave a PR `UNSTABLE`.
  This workflow's own job is left out, since a transient failure of it stays on the head until the next PR event.
  A PR with native auto-merge armed (release-blog and Dependabot PRs) is updated once its required checks pass, with no review; GitHub merges it on those alone.
  Dependabot's own PRs (every commit by `dependabot[bot]`) get an `@dependabot rebase` comment instead, once per head
  (a marker in the comment names it; only a marker posted by the PAT's account counts).
  Without the PAT the run logs a notice and the PR waits. A 422 (the head moved, or nothing to merge) is logged quietly; any other error is a warning, never a failed run.
  Only ready PRs are updated: an update reruns CI, and a PR waiting on a review or a fix gains nothing from being current.
  A sweep (a push to `main`, the schedule or a manual run) updates at most one PR, the oldest ready `BEHIND` one, since it lists open PRs oldest first (#155):
  only the first PR to finish CI can merge, and its merge leaves the rest `BEHIND` again, so updating them all at once costs on the order of N² CI runs.
  The update is the sweep's last step, made only if the sweep merged nothing: a PR it merged after updating an older one
  would leave that one `BEHIND` again, wasting its CI run (TicketManager #191's review). A merge's push sweeps again anyway.
  Before updating, the sweep evaluates the candidate again, since it may have changed while the other PRs were checked
  (a new thread, a hand-back label, closed); one no longer ready is skipped for the next. An error on one PR is logged and the sweep goes on
  to its update, then fails the run, so one bad PR can't stall every update. An error that holds for the whole run
  (a 401, a 429, a 403 that is a rate limit, a GraphQL `RATE_LIMITED`) ends it at once instead: every later call would fail too (#179).
  Any other 403 (a locked PR, a branch restriction) is one PR's error. The same holds for a sweep's update itself (#181);
  any other update error in a sweep fails the run once it's done. On a PR event an update error stays a warning, since there is no other PR to try.
  The next merge's push sweeps again for the next one. A 422 doesn't count as the sweep's update, and an event for one PR still updates that PR.
  The limit holds within one sweep only. A scheduled or manual sweep that runs while an updated PR's CI is still running doesn't see that update,
  and can start a second one. That's accepted: scheduled sweeps run about an hour apart, far longer than a CI run, and telling an update
  in flight from an author's push would take a second pass over every open PR. A Dependabot PR already asked to rebase its head doesn't count either,
  so a Dependabot that never rebases can't hold the sweep.
  The other cost: when the updated PR doesn't merge (its CI fails, the merge from `main` needs a fresh review, or it picks up a thread),
  there's no push to `main`, so the other ready `BEHIND` PRs wait for the next scheduled sweep, about an hour, or a manual run.
  That's accepted too: the sweep then skips the stuck PR, since it's no longer ready, and updates the next one.
  Updating them all at once instead would cost on the order of N² CI runs on every merge, to save that hour only in the failure case.
- **Hand-back hold.** A PR labelled `sandcastle:needs-human` (Sandcastle giving up and handing it to a person) is skipped while it carries the label,
  and also when someone other than the repository owner last removed it, since anyone with triage access can remove a label.
  The removal comes from the PR's paginated issue events, read with `GITHUB_TOKEN` (`issues: read`), so `RELEASE_PR_PAT` needs no Issues read.
  Both checks run again on a fresh snapshot, and every later check reads that snapshot, so a thread, head or check that changed meanwhile counts.
  More labels than one page is left to a person. A repo that never applies the label is unaffected.
- **The merge** is `pulls.merge` with `sha: headRefOid`, so a push landing between the check and the merge fails the merge instead of merging unreviewed code.
  405 and 409 are warnings; a later event re-evaluates.
- **Triggers**, each a moment a condition can become true: `push` to `main` (it leaves every open PR `BEHIND`, so it sweeps them;
  GitHub reports `UNKNOWN` merge states right after, so each PR is asked again up to four times, 5 s apart),
  `pull_request_target` (opened, ready_for_review, reopened, edited, synchronize, and unlabeled for the hand-back label),
  `workflow_run` completion of every workflow that owns a required check, of **PR Review Submitted** and of **Claude Review**,
  a schedule (resolving a thread has no Actions trigger), and `workflow_dispatch` from `main`.
- **PR Review Submitted** (`pr-review-submitted.yml`) runs on `pull_request_review: submitted` with no permissions and does nothing.
  Its completion fires this workflow's `workflow_run`, which runs main's copy.
  Copilot's review usually arrives after CI has finished, so without it the last blocker clears with no trigger and the PR waits for the sweep (IssueTracker #197 waited, and was swept by hand).
- **Claude Review** (`claude-review.yml`) is the backup reviewer, run only while a PR into `main` carries `review:claude`, on `labeled`, `synchronize`, `reopened` and `ready_for_review`.
  It skips drafts, Dependabot and events a bot started (the action refuses a bot actor, `Copilot` included, which has no `[bot]` suffix),
  and logs a notice and succeeds without the `CLAUDE_CODE_OAUTH_TOKEN` secret.
  It must not fail on its own: it isn't a required check, so a failed run leaves the PR `UNSTABLE`, which this workflow never merges.
  So a Review step that fails, times out or hits the usage limit warns and posts nothing (`continue-on-error`), and the PR waits for a review of its head:
  Copilot's, or Claude's on a rerun. The one deliberate failure is a review the post step had to redact a credential from.
  Claude (`anthropics/claude-code-action`; model, effort and prompt in [ADR 0004](../docs/adr/0004-claude-review-as-copilots-backup.md#model-effort-and-prompt-117))
  never holds a write token: its job has read-only permissions,
  gets the diff against the base in pieces, with context pieces of whole files around the change and the pinned actions' gatekeeping source
  ([ADR 0004](../docs/adr/0004-claude-review-as-copilots-backup.md#context-pieces-117)), all read in one turn,
  leaving out a root copy of an Owned file when the PR changes the Template's file to the same bytes (INDEX lists it as an identical copy; a copy that differs
  from the Template's file, or whose Template file isn't in the PR, is still read, so drift reaches the review),
  and reads only the checkout, the diff and the runner's `_actions`, with no tool granted outright
  ([ADR 0004](../docs/adr/0004-claude-review-as-copilots-backup.md#keeping-the-token-out-of-the-review-121)), and answers in a JSON schema.
  Its prompt also holds the PR's resolved Copilot and Claude Review threads, with the replies of the PR's author, whoever resolved the thread and the repo's owner,
  and tells it not to raise a resolved thread's problem again unless the code has changed in a way that brings it back,
  so a finding a maintainer declined doesn't come back on every push (auth0-management-app#59 had one four times).
  The author's local review ([pre-push-review.md](pre-push-review.md)) has already reviewed the whole branch, so the prompt asks for findings (each of which holds the merge)
  only for bugs in code that runs, security weaknesses, tests and how GitHub itself behaves, and has docs, comments and conventions go under "Advisory" in the summary.
  It also holds the findings the author accepted, from the PR description's `## Review notes`, as decisions like a resolved thread's; they count only on a same-repo PR
  whose author is the `OWNER` (a `MEMBER` or `COLLABORATOR` may have read access only). The step reads the description from the API as it runs.
  The prompt tells Claude that a note never covers a security weakness, which is an instruction, not an enforced rule.
  The markers must sit on lines of their own outside a code fence. A PR opened with the owner's token, Sandcastle's included, counts as the owner's.
  A second job runs `post_claude_review.py`, which posts one `COMMENT` review pinned to the head,
  each finding an inline thread, and a finding outside the diff in the body (GitHub rejects a whole review over one such comment).
  A finding at a line its changed file doesn't have is a wrong number, so it goes on the file's nearest diff line instead, as a thread.
  A body finding opens no thread, so the review's body carries a second marker, `<!-- claude-review:off-diff -->`, and this workflow holds the merge
  while that review is Claude's latest of the newest commit it reviewed that covers the head
  (until the review loop is exhausted, then it is listed in the exhaustion comment, like the threads); the post job warns but passes.
  The hold lives in the review, not the check: a failed check would leave the PR `UNSTABLE`, which this workflow never merges,
  and adding another label re-runs Claude Review with its jobs skipped, which would replace a failed check anyway.
  The review is posted with `GITHUB_TOKEN`, which starts no workflows, so PR Auto-Merge follows Claude Review's completion instead of PR Review Submitted.
- **The schedule** is `7,22,37,52 * * * *`, off the round minutes where GitHub drops the most scheduled runs.
  GitHub still runs it far less often than asked: IssueTracker's sweeps after #201 ran about 70 minutes apart. Treat it as the fallback, never the expected path.
- **Safety:** `pull_request_target` runs main's copy of the file and never checks out PR code, so a PR can't edit what decides whether it merges.
  `pull_request_review` is never a trigger here: it would run the PR's own copy with write access. It reaches this workflow only through PR Review Submitted.
- **Token:** every read goes through `GITHUB_TOKEN` (the script's `github`), whose rate limit is the repo's own
  (1,000 REST requests and 1,000 GraphQL points an hour, shared with the repo's other workflows; see [tokens.md](tokens.md)),
  and so does taking `review:claude` off. Only the calls GitHub must treat as a person's go through `RELEASE_PR_PAT`, falling back to `GITHUB_TOKEN`
  (the script's `patClient`): the merge, update-branch, adding `review:claude` and `@dependabot rebase`, plus one read of the PAT's own login.
  A merge made with `GITHUB_TOKEN` starts no workflows, so the release and its blog PR would silently skip; an update would start no CI.
  The PAT also posts `@dependabot rebase`, which Dependabot takes from a person.
  [tokens.md](tokens.md) lists every call, which client makes it and why, and the allowance the PAT shares with everything acting as its owner.

## Landing

- **A re-Apply PR opens ready, not as a draft, and this workflow lands it.** The copy on `main` is already the Template's,
  so it waits for Copilot's review of the head and every thread resolved; answer the threads and let it merge.
- **A Standardize PR is a draft landed by hand.** The repo's old workflow on `main` would merge it the moment its checks pass: see [Adapting](#adapting).
- **`land.sh` watches a round** until it lands: see [Landing a round](#landing-a-round).
- **Copilot's review request is read back.** `gh pr edit --add-reviewer @copilot` exits 0 even when GitHub drops the request,
  so `reapply.sh` and `land.sh` then read the PR's review requests (and Copilot's reviews of the head).
  When Copilot isn't there they warn, and never add `review:claude` then: the head's CI has only just started, and a Claude review costs money.
  `land.sh` asks Copilot once per PR (a record comment, then the request, read back) and adds the label once the request didn't register and the head's checks are green,
  whether it read the drop back itself or finds the record 30 seconds old with no request pending in a later run, even a `--once` run
  (see [Landing a round](#landing-a-round)); `reapply.sh` prints that `land.sh` command.
  A request GitHub refuses outright (`Could not add requested reviewers`, TicketManager#141) is handled the same way: it warns with gh's message and reads back (#118).
- **GitHub drops the request once the account's Copilot code review budget is used up.** Nothing in the API says so:
  `gh pr edit` and GraphQL `requestReviewsByLogin` return success with no request, and REST `requested_reviewers` returns 422 "not a collaborator".
  Seen on 2026-10-07 from about 20:30 UTC (#97: TicketManager#131, then every re-Apply PR of the #82 round).
  Until the budget resets no Copilot review comes, which stranded the whole round: nothing merged.
  Claude Review is the way out now: `review:claude` (added by PR Auto-Merge or the tooling once Copilot posts its quota note on the head,
  or its one request for the PR didn't register) gets the head a review this workflow accepts.
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

A line ends with `notice: resolved without a reply: path:line, ...` (3 named, then `and N more`) when resolved Copilot or Claude Review threads
got no reply, by the rule above. `decide()` ignores it (`PrState.unreplied_threads`), and `land.sh` prints the line again when the notice changes.
A failed or empty `THREADS_QUERY` for one PR keeps that PR's comment-less threads (no notice) and is reported once on stderr; it never
makes the repo unreadable.
Tests: `test_landing.py` (the rule and the notice text), `test_status.py` (the line and the query), `test_land.py` and `pr-automerge.test.mjs`.

`landing.decide(PrState)` returns one action, the rules PRs are landed by:
nothing for a merged, closed or already-armed PR; **report blocker** for a failed check, a cancelled check nothing newer replaced, or a conflict;
**mark ready** for a draft only when the caller says it should be (otherwise wait);
**arm auto-merge** for a release-blog PR its workflow didn't arm (branch `docs/release-notes` or `docs/backfill-blog-posts`, no review needed, as `release.yml` arms it);
**update branch** when it's `BEHIND` (nobody is asked to review the new head: Copilot is asked once per PR); **wait** until Copilot, or Claude (a marked `github-actions[bot]` review,
backing a quota note or a request that didn't register on the same head), reviewed the current head and no thread is open.
A head with neither review waits while Copilot is requested or `review:claude` is on; otherwise, for a PR with no record of an ask, **request Copilot**:
a comment holding the marker (`landing.COPILOT_ASKED_COMMENT`), then the request, read back. With a record that hasn't settled (under 30 seconds) it **waits**.
Only once Copilot can't review the head (`PrState.copilot_gone`), because it answered with its quota note (`copilot_declined`), its request didn't register
(`copilot_dropped`: `land.sh` remembers it per head within a watching process), or it was asked (`copilot_asked`, from the record that `landing.copilot_ask` reads
from the PR's last 100 comments; unreadable counts as asked) and the record is 30 seconds old (`copilot_ask_settled`) with no request pending,
does it **add review:claude**.
`status.sh` reads the comments of only the PRs that need the record, or whose loop could be exhausted
(three dirty rounds in a row, before any restart; 1 GraphQL point each, plus a page per 100 comments back to the exhaustion comment), every `review:claude` label event of such a PR (paged),
the permission of each login that added one (REST, once per login) and the authors of its open threads, which `landing.py` splits into a person's and the bots'.
It needs no memory, and neither does a `land.sh --once` run.
A loop whose comments, label events or permissions can't be read is never shown as exhausted, and gets no `review:claude`.
With Copilot available (`claude_requested` and not `copilot_gone` or `copilot_declined`) the label is ignored: it asks for Copilot, not Claude.
It adds it once the head has at least one check other than Claude Review's own and every such check is green
(Claude Review's own don't count: a run cancelled when the label came off needs no rerun), never while one runs or is queued, and never while an exhaustion comment is the newest word.
When PR Auto-Merge's review loop is exhausted (`PrState.loop_exhausted`: `MAX_CLAUDE_ROUNDS` dirty rounds in a row in `PrState.rounds`,
re-Apply PRs included; `REVIEW_CAP` must still match `COPILOT_REVIEW_CAP`) it asks for neither reviewer,
and goes on to the checks as PR Auto-Merge does: the bots' threads and off-diff findings still open no longer hold it, a person's thread does (the line reads `wait`, naming the person's threads),
and otherwise the line reads `review loop exhausted (3 rounds with findings in a row), ready to merge, N thread(s) left open`.
While PR Auto-Merge's exhaustion comment is the newest word (no `review:claude` added since, `PrState.exhaustion_marker_newest`) it asks for no review either: the owner adds the label to start a new loop;
then **leave to PR Auto-Merge** in a Baseline repo, whose workflow merges it (it never arms native auto-merge, so neither does anything going around it),
or **arm auto-merge** where there is no such workflow. A repo with no required checks waits for its checks to finish green first,
since auto-merge alone wouldn't wait for CI.
dotfiles has both: a copy of PR Auto-Merge, which `test.sh` keeps identical, and a `main-rules` of its own. A cancelled run with a newer run of the same check on the same
head is superseded, not a failure:
CI's concurrency cancels runs, and the newest counts. Commands that act on PRs call the same function, so they can't drift from these rules.

### Landing a round

A session watching its own PR uses `scripts/watch-pr.sh` ([watch-pr.md](watch-pr.md)); `land.sh` is the owner's round across repos.

```bash
land.sh --once --dry-run      # one pass over every open PR in github/repos.txt, printing the calls it would make
land.sh mpaulosky/<repo>#<n>  # watch these PRs (or owner/repo for all its open PRs) until they land
```

`land.sh` polls the PRs (default every 60 s, one GraphQL query per repo) and does what `decide()` says, once per head:
`gh pr update-branch` then `gh pr edit --add-reviewer @copilot` (warning when the request is dropped or refused),
`gh pr edit --add-reviewer @copilot` again for an unreviewed head, `gh pr edit --add-label review:claude` once `decide()` says so, `gh pr ready` only with `--ready`,
and `gh pr merge --auto --squash --match-head-commit <head>`. It has no rules of its own.
It also watches each release-blog PR that opens in a watched repo, and after a watched Baseline PR merges it waits `--blog-wait` (15) minutes for one.
It prints status.sh's line only for a PR whose state or action changed (one line when no PR is open, then it exits),
and exits once every watched PR is merged or closed, or with 1 at `--timeout` (180 minutes).
A quiet round costs one GraphQL query per repo (about 3 points, plus 1 for each PR whose threads are all resolved and that a bot reviewed),
and each action a call or three, all on the owner's `gh` login,
which spends almost only GraphQL points (of the account's 5,000 an hour) and leaves the REST allowance to the PAT and Sandcastle:
[tokens.md](tokens.md#landsh-and-the-shared-allowance) gives the numbers.

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
After a third dirty round in a row, the log reads `Review loop exhausted on PR #n: merging with N unresolved thread(s) ...` if the exhausted loop is what let it through.

**Claude Review**, on TicketManager with the secret set and Copilot unavailable: a re-Apply PR gets `review:claude` from `land.sh` once its checks are green,
Claude's review of its head (a `github-actions[bot]` review starting with `<!-- claude-review -->`, findings as threads),
and merges through PR Auto-Merge once its threads are resolved. The re-Apply PR that brings Claude Review in still runs the old `pr-automerge.yml` from `main`,
so the round after it is the first that can land on Claude's review.
