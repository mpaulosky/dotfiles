# Copilot stops holding the merge after three review rounds; a handed-back PR never auto-merges

**Status:** accepted and implemented in `template/owned/.github/workflows/pr-automerge.yml`, ported from Blazor-Server #94 and #119
(Blazor-Server's ADR 0003 records the cap's original decision).

`pr-automerge.yml` merges a same-repo PR into `main` once its required checks pass, Copilot has reviewed its head commit, and every review thread is resolved.
Copilot re-reviews every push and can raise something new each time, so fixing its comments starts another round, and a PR can chase its reviews without ever merging.

So Copilot's hold on the merge is capped. Once Copilot has reviewed three distinct non-merge commits, the merge no longer waits for its review of the head.
Its unresolved threads still hold the merge (#146, below).
Merges from `main` aren't rounds: the ruleset keeps branches up to date, so counting them would use up the cap without a single fix.
A thread belongs to whoever wrote its first comment.

Separately, a PR labelled `sandcastle:needs-human` never merges while it carries the label, or when someone other than the repository owner last removed it.
Sandcastle (an unattended agent) adds the label when it gives up on a PR and hands it to a person; without the hold, the PR would merge as soon as it went green.
The hold is in the Template, not a per-repo file, because Applying the old Template to Blazor-Server would otherwise silently remove a safety gate. In a repo that never applies the label it does nothing.

## Considered Options

- **No cap**: every Copilot comment is dealt with before merging. Rejected because PRs stalled on a fresh low-severity thread after each fix.
- **Cap the wait for a head review, but keep Copilot's threads blocking**: first rejected because a review that arrives after the last thread is resolved can open a new one and hold the merge again.
  Adopted in #146: dropping the threads too let IssueTracker#236, IssueManager#281 and Articles#314 merge at the cap with Claude's threads open,
  each needing a follow-up PR. A thread can be answered and resolved, so it never stalls a PR the way a missing review can.
- **Count every reviewed commit, merges from `main` included**: rejected because busy days on `main` reached the cap through branch updates alone.
- **A time limit instead of a round count**: rejected because the problem is repeated reviews, not missing ones.
- **Keep the hand-back hold in Blazor-Server only**: rejected because Owned files carry no per-repo values, and the next Apply would revert it.

## Consequences

- Everything else still holds the merge at the cap: every unresolved thread (Copilot's and Claude's included, since #146), Claude's off-diff findings on its review of the head,
  required checks, conflicts and the hand-back label.
- The cap only stops the wait for a review of the head. A review that arrives after a cap merge comes too late: its findings land on a merged PR,
  and the run log says when the cap let a PR through without one.
- Claude's off-diff findings hold past the cap like threads (they are findings that couldn't be threads), but they can't be resolved:
  only a push, which Claude reviews again while `review:claude` is on, or a merge by hand clears them.
  An API error while checking whether the head is a clean merge from main waits for the next event, past the cap too.
  A head the check can't cover (more than five merges from main deep, or a tree listing GitHub truncates) counts as unreviewed:
  past the cap it merges, so an off-diff hold on the commit underneath it doesn't apply. That's accepted: it takes six merges from main in a row.
- A re-Apply PR (`chore/reapply-baseline`) had no cap from #115 to #174. Its rounds come from the re-Apply commits `reapply.sh` adds to it,
  and it changes the Owned CI files and this gate itself: Articles#298 merged past a real Copilot finding on its third round.
  #174 dropped the exemption. With Claude reviewing every re-Apply commit across seven repos, a finding fixed in the Template added a commit to
  every open re-Apply PR and started another review on each, so a round could chase reviews without end (the dotfiles#171 round).
  A finding on a re-Apply PR now goes into the Template and arrives with the next round, as a finding past the cap does on any PR.
- At the cap PR Auto-Merge takes `review:claude` off (#170), once Claude has reviewed since the label was last added (#174),
  so a cap reached on Copilot's reviews alone, or a re-added label, still gets Claude's review. The cost accepted: while Claude Review
  keeps ending without posting a review, the label stays on and each push starts another run. A run that posts nothing holds no merge.
- Claude Review, Copilot's backup ([ADR 0004](0004-claude-review-as-copilots-backup.md)), shares the cap: rounds from both reviewers count toward it,
  and past it neither reviewer's review of the head is waited for; both reviewers' threads still hold the merge.
- The cap is one constant, `COPILOT_REVIEW_CAP`. `.github/scripts/tests/pr-automerge.test.mjs` covers the cap and the hold, and CI and `test.sh` run it.
- The workflow reads a PR's label events with `GITHUB_TOKEN` and `issues: read`, so `RELEASE_PR_PAT` needs no Issues access,
  and `pull_request_target` gains the `unlabeled` type so the owner removing the label re-evaluates the PR at once.
