# Claude reviews a PR when Copilot can't, and the merge gate accepts either review

**Status:** accepted and implemented in `template/owned/.github/workflows/claude-review.yml` and `pr-automerge.yml` (#100).

Every Baseline PR waits on a review of its head before PR Auto-Merge lands it.
Copilot was the only reviewer, and when the account's Copilot code review budget is used up, GitHub drops every review request without a word (#97, #99).
On 2026-10-07 that stranded a whole re-Apply round: nothing merged until the budget reset or a person merged past the gate.

So Claude reviews as a backup: Claude Review runs Sonnet 5.5 at medium effort in CI and posts an ordinary review of the head, with inline threads, under `github-actions[bot]`.
It runs only while a PR carries `review:claude`, which `reapply.sh` and `land.sh` add when Copilot's request didn't register, and a person can add at any time.
PR Auto-Merge accepts a review of the head by either reviewer, holds on either's unresolved threads, and counts both reviewers' rounds toward one cap ([ADR 0002](0002-copilot-review-cap-and-hand-back-hold.md)).
The review body starts with `<!-- claude-review -->`: that marker, not the login alone, is how the gate tells Claude's review from anything else posted as `github-actions[bot]`.

## Considered Options

- **Replace Copilot with Claude**: rejected because rounds the size of #82's come from working out the Baseline process; once work is back on one project, Copilot's budget covers it at no cost.
- **Run both reviewers on every PR**: rejected for the same cost, and because two reviews of every head double the threads to answer.
- **Let Claude post the review itself**: rejected so the model never holds a write token. It reviews in a read-only job and answers in a JSON schema; a separate job posts.
- **An advisory review in the local pre-push gate**: rejected as the backup because the merge gate needs a review recorded on the PR. It may still come later as its own issue.
- **Count Copilot's and Claude's rounds separately**: rejected because switching reviewer would reset the cap.

## Consequences

- A repo without `CLAUDE_CODE_OAUTH_TOKEN` skips Claude Review with a notice, so the workflow is Applied before every secret is added; `github-settings.sh` reports the missing secret as MANUAL.
- A review posted with `GITHUB_TOKEN` starts no workflows, so PR Auto-Merge follows Claude Review's completion through `workflow_run`.
- Claude Review runs on `pull_request`, so it reviews with the PR's own copy of the workflow: the PR that brings it in lands on the old gate, and the next round is the first to land on Claude's review.
- Dependabot PRs are left out: their own auto-merge path is unchanged, and they get no secrets.
- dotfiles isn't a Baseline repo, so it carries a copy of the two files, which `test.sh` keeps identical to the Template's; its "reviewed" rule is the landing decision's.
