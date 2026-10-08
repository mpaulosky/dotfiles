# Copilot stops holding the merge after three review rounds; a handed-back PR never auto-merges

**Status:** accepted and implemented in `template/owned/.github/workflows/pr-automerge.yml`, ported from Blazor-Server #94 and #119
(Blazor-Server's ADR 0003 records the cap's original decision).

`pr-automerge.yml` merges a same-repo PR into `main` once its required checks pass, Copilot has reviewed its head commit, and every review thread is resolved.
Copilot re-reviews every push and can raise something new each time, so fixing its comments starts another round, and a PR can chase its reviews without ever merging.

So Copilot's hold on the merge is capped. Once Copilot has reviewed three distinct non-merge commits, the merge no longer waits for its review of the head, and its unresolved threads no longer count.
Merges from `main` aren't rounds: the ruleset keeps branches up to date, so counting them would use up the cap without a single fix.
A thread belongs to whoever wrote its first comment.

Separately, a PR labelled `sandcastle:needs-human` never merges while it carries the label, or when someone other than the repository owner last removed it.
Sandcastle (an unattended agent) adds the label when it gives up on a PR and hands it to a person; without the hold, the PR would merge as soon as it went green.
The hold is in the Template, not a per-repo file, because Applying the old Template to Blazor-Server would otherwise silently remove a safety gate. In a repo that never applies the label it does nothing.

## Considered Options

- **No cap**: every Copilot comment is dealt with before merging. Rejected because PRs stalled on a fresh low-severity thread after each fix.
- **Cap the wait for a head review, but keep Copilot's threads blocking**: rejected because a review that arrives after the last thread is resolved can open a new one and hold the merge again.
- **Count every reviewed commit, merges from `main` included**: rejected because busy days on `main` reached the cap through branch updates alone.
- **A time limit instead of a round count**: rejected because the problem is repeated reviews, not missing ones.
- **Keep the hand-back hold in Blazor-Server only**: rejected because Owned files carry no per-repo values, and the next Apply would revert it.

## Consequences

- Everything else still holds the merge at the cap: threads anyone else opens (including other bots, and threads whose author no longer exists), required checks, conflicts and the hand-back label.
- Copilot comments from round three on can merge unaddressed. They stay on the merged PR, and the run log says when the cap let a PR through.
- Claude Review, Copilot's backup ([ADR 0004](0004-claude-review-as-copilots-backup.md)), shares the cap: rounds from both reviewers count toward it,
  and past it neither reviewer's threads hold the merge.
- The cap is one constant, `COPILOT_REVIEW_CAP`. `.github/scripts/tests/pr-automerge.test.mjs` covers the cap and the hold, and CI and `test.sh` run it.
- The workflow reads a PR's label events with `GITHUB_TOKEN` and `issues: read`, so `RELEASE_PR_PAT` needs no Issues access,
  and `pull_request_target` gains the `unlabeled` type so the owner removing the label re-evaluates the PR at once.
