# The review loop ends after three dirty rounds in a row, and is documented in one comment; a handed-back PR never auto-merges

**Status:** accepted and implemented in `template/owned/.github/workflows/pr-automerge.yml`, ported from Blazor-Server #94 and #119
(Blazor-Server's ADR 0003 records the cap's original decision). Amended by mpaulosky/dotfiles#375: the cap of three reviewed commits became
a loop of three dirty rounds in a row, and it **supersedes the #146 decision** (below) that every unresolved thread holds the merge, cap or not.
Amended again by mpaulosky/dotfiles#378: a thread a person opened still holds the merge at an exhausted loop (only Copilot's and Claude Review's no longer do),
the comment is posted once the PR is ready and says when the head was not reviewed, and only a login with write access restarts a loop.

`pr-automerge.yml` merges a same-repo PR into `main` once its required checks pass, a reviewer has reviewed its head commit, and every review thread is resolved.
Copilot, and Claude as its backup ([ADR 0004](0004-claude-review-as-copilots-backup.md)), re-review every push and can raise something new each time,
so fixing their comments starts another round, and a PR can chase its reviews without ever merging.

So one loop bounds both reviewers, counted in dirty rounds:

- A **round** is a review of a non-merge commit. A merge of `main` into the PR is never a round, for either reviewer: the ruleset keeps branches up to date,
  and PR Auto-Merge's own update-branch makes the merges, so counting them would use up the loop without a single fix (mpaulosky/dotfiles#371 did).
  Two reviews of one commit are one round.
- A round is **dirty** when its review raised at least one thread or, for Claude, a finding outside the diff, and **clean** otherwise.
- The loop is **exhausted** after `MAX_CLAUDE_ROUNDS` (3) dirty rounds in a row, counted back from the newest reviewed commit. A clean round ends the count at zero.
  Until then every new non-merge head that nobody reviewed gets a review, and a clean review of the head, with every thread resolved and the required checks green, merges.
- A Copilot review with only a body and no inline comment is a clean round.
- At exhaustion PR Auto-Merge takes `review:claude` off, posts **one comment** on the PR and then lets the PR merge once its required checks pass and it has no conflict.
  The comment names the head and says whether a review covers it (``The head `abc1234` was not reviewed.``, or that it is a clean merge of `main` onto a reviewed commit),
  says whether `review:claude` is off (or is being removed, when the removal failed), lists every thread still unresolved (path and line, the first line of its first comment, a link;
  a person's first, marked as holding the merge) and every finding outside the diff that Claude raised on the head and nobody answered,
  and ends with a hidden marker naming the head (`pr-automerge:review-loop-exhausted`), so it is posted once per exhaustion; a new dirty round after it gets a new comment.
  It is posted before the merge, so the record exists on the merged PR, and only once the PR is otherwise ready to merge (not BEHIND, no conflict, required checks green).
  Exhaustion itself holds nothing, and the threads Copilot and Claude Review opened that are still open then hold nothing either:
  the comment is where they are kept, so they can be resolved later. **A thread a person opened still holds the merge**, and so does one whose author can't be read:
  a person's open thread is not the loop's to give up on. The fix for a third dirty round still merges without a review of its head.
- The loop restarts at the first `review:claude` added after the round that exhausted it **by a login with write access to the repository** (the owner, or the PAT's account),
  whether or not a comment exists yet: only rounds after the add count. An add by anyone else is ignored, and when the permission can't be read the loop counts as unread
  and the run waits (it fails closed). A PR with no comment yet gets the old loop's comment first, then counts the new loop.
  PR Auto-Merge never adds the label while the comment is the newest word on the PR.
- **Claude reviews only where Copilot can't**, and a PR never gets both reviewers' reviews. Copilot can't review the PR when its quota note is on the head, or it is gone (asked,
  the ask settled and no request pending). While Copilot can review, `review:claude` is ignored while Copilot can review it: PR Auto-Merge takes it off at once, whoever added it
  (the owner included: no exception), and `claude-review.yml` starts no paid review. The label's only job is to call Claude in where Copilot is out.

A thread belongs to whoever wrote its first comment.

Separately, a PR labelled `sandcastle:needs-human` never merges while it carries the label, or when someone other than the repository owner last removed it.
Sandcastle (an unattended agent) adds the label when it gives up on a PR and hands it to a person; without the hold, the PR would merge as soon as it went green.
The hold is in the Template, not a per-repo file, because Applying the old Template to Blazor-Server would otherwise silently remove a safety gate. In a repo that never applies the label it does nothing.

## Considered Options

- **No cap**: every Copilot comment is dealt with before merging. Rejected because PRs stalled on a fresh low-severity thread after each fix.
- **Cap the wait for a head review, but keep every thread blocking** (#146): first rejected because a review that arrives after the last thread is resolved can open a new one
  and hold the merge again. Adopted in #146, after IssueTracker#236, IssueManager#281 and Articles#314 merged at the cap with Claude's threads open,
  each needing a follow-up PR. **Superseded by mpaulosky/dotfiles#375**: at an exhausted loop the threads are documented in one comment and no longer hold the merge.
  Three dirty rounds in a row mean the reviewers keep finding something after each fix, so holding for the last round's threads only moves the wait to the owner,
  and the comment keeps the findings where a later fix can find them. The accepted cost: a PR can merge with its third round's findings still open.
- **Count reviewed commits, merges from `main` included** (the old cap): rejected because busy days on `main` reached the cap through branch updates alone,
  and mpaulosky/dotfiles#371 stalled with its head never reviewed after two merges of `main` and one real commit used up Claude's three rounds.
- **Count reviewed non-merge commits, clean or dirty** (the cap of #170 to #360): rejected because a clean review is the loop's goal, not a round spent. Only dirty rounds in a row end it.
- **A time limit instead of a round count**: rejected because the problem is repeated reviews, not missing ones.
- **Keep the hand-back hold in Blazor-Server only**: rejected because Owned files carry no per-repo values, and the next Apply would revert it.

## Consequences

- Below exhaustion everything holds the merge: every unresolved thread (Copilot's and Claude's included), Claude's off-diff findings on its review of the head,
  required checks, conflicts and the hand-back label. At exhaustion required checks, conflicts, a branch that is BEHIND (it is updated first), the hand-back label
  and a person's open thread still hold; Copilot's and Claude's threads and the off-diff findings do not, since the comment lists them.
- The exhaustion comment is posted with `GITHUB_TOKEN` (`pull-requests: write`) once the PR is not BEHIND, has no conflict and its required checks are green
  (mpaulosky/dotfiles#378), not while a check still holds the merge, and only when its comments were read in full. The marker is looked for in all the PR's comments:
  when the last 100 hold none, the run pages through every comment, and when it still can't read them it posts a notice naming the PR instead of only a log line.
  Two runs can both find no comment, so a run reads the comments again after posting and deletes its own when another run's comment for the same exhaustion is listed first.
  A failed post, or comments that can't be read, hold the merge until the next event.
  Everything it quotes from the PR (paths, the first line of a comment) is escaped, since it is posted as `github-actions` and `askRecords` trusts that login's ask record.
- A review that arrives after the merge comes too late: its findings land on a merged PR. The run log says when an exhausted loop let a PR through.
- Claude's off-diff findings hold below exhaustion like threads (they are findings that couldn't be threads), but they can't be resolved:
  only a push, which Claude reviews again while `review:claude` is on, or a merge by hand clears them.
  An API error while checking whether the head is a clean merge from main waits for the next event, exhausted or not.
  A head the check can't cover (more than five merges from main deep, or a tree listing GitHub truncates) counts as unreviewed.
- A re-Apply PR (`chore/reapply-baseline`) had no cap from #115 to #174. Its rounds come from the re-Apply commits `reapply.sh` adds to it,
  and it changes the Owned CI files and this gate itself: Articles#298 merged past a real Copilot finding on its third round.
  #174 dropped the exemption. With Claude reviewing every re-Apply commit across seven repos, a finding fixed in the Template added a commit to
  every open re-Apply PR and started another review on each, so a round could chase reviews without end (the dotfiles#171 round).
  A finding on a re-Apply PR now goes into the Template and arrives with the next round, as a finding at an exhausted loop does on any PR.
- At exhaustion PR Auto-Merge takes `review:claude` off (#170), whoever added it. It also takes it off once Copilot has really reviewed the head (#270).
  A label that comes off does not keep a later head from its review: the next unreviewed non-merge head gets it again while the loop isn't exhausted
  and no exhaustion comment is the newest word. The cost accepted: while Claude Review keeps ending without posting a review, the label stays on and each push starts another run.
  A run that posts nothing holds no merge and makes no round.
- Claude Review, Copilot's backup, shares the loop: rounds from both reviewers count toward it, and exhausted, neither reviewer's review of the head is waited for.
  Claude's review counts where Copilot can't review: its quota note is on that commit or on the head, or the ask settled with no request pending.
- `COPILOT_REVIEW_CAP` stays in the workflow under its old name, because `github-settings.sh` reads it, with the value 3; the loop itself uses `MAX_CLAUDE_ROUNDS`, also 3,
  and `landing.py` holds both constants in step by tests. `.github/scripts/tests/pr-automerge.test.mjs` covers the loop, the comment and the hold, and CI and `test.sh` run it.
- A new loop starts at the **first** `review:claude` added by a login with write access after the round that exhausted the loop, not the latest add:
  PR Auto-Merge's own PAT adds the label for a later head in the new loop, and a restart at that add would discard the loop's rounds and make it endless.
  An add counts only where Copilot can't review. Whoever added it is looked up with `repos.getCollaboratorPermissionLevel` (`GITHUB_TOKEN`, a read, once per login a run);
  the repository's owner has write access without a lookup, and a bot never does.
  The rule is a walk over generations: a restart can come before the comment (the comment is posted once the PR is ready), so the comment no longer marks where the loop restarts.
- The workflow reads a PR's label events with `GITHUB_TOKEN` and `issues: read`, so `RELEASE_PR_PAT` needs no Issues access,
  and `pull_request_target` gains the `unlabeled` type so the owner removing the label re-evaluates the PR at once, and `labeled`, so a `review:claude` added while Copilot can review
  is taken off at once (the job's `if:` lets in no other label).
