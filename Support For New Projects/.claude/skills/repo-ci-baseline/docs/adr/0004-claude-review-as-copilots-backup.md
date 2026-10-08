# Claude reviews a PR when Copilot can't, and the merge gate accepts either review

**Status:** accepted and implemented in `template/owned/.github/workflows/claude-review.yml` and `pr-automerge.yml` (#100).

Every Baseline PR waits on a review of its head before PR Auto-Merge lands it.
Copilot was the only reviewer, and when the account's Copilot code review budget is used up, GitHub drops every review request without a word (#97, #99).
On 2026-10-07 that stranded a whole re-Apply round: nothing merged until the budget reset or a person merged past the gate.

So Claude reviews as a backup: Claude Review runs Opus 5.5 at high effort in CI (Sonnet 5.5 at medium effort until #117; see below)
and posts an ordinary review of the head, with inline threads, under `github-actions[bot]`.
It runs only while a PR carries `review:claude`, which `reapply.sh` and `land.sh` add when Copilot's request didn't register, and a person can add at any time.
PR Auto-Merge accepts a review of the head by either reviewer, holds on either's unresolved threads, and counts both reviewers' rounds toward one cap ([ADR 0002](0002-copilot-review-cap-and-hand-back-hold.md)).
The review body starts with `<!-- claude-review -->`: that marker, not the login alone, is how the gate tells Claude's review from anything else posted as `github-actions[bot]`.

## Considered Options

- **Replace Copilot with Claude**: rejected because rounds the size of #82's come from working out the Baseline process; once work is back on one project, Copilot's budget covers it at no cost.
- **Run both reviewers on every PR**: rejected for the same cost, and because two reviews of every head double the threads to answer.
- **Let Claude post the review itself**: rejected so the model never holds a write token.
  It reviews in a read-only job and answers in a JSON schema; a separate job posts.
- **An advisory review in the local pre-push gate**: rejected as the backup because the merge gate needs a review recorded on the PR.
  It may still come later as its own issue.
- **Count Copilot's and Claude's rounds separately**: rejected because switching reviewer would reset the cap.

## Consequences

- A repo without `CLAUDE_CODE_OAUTH_TOKEN` skips Claude Review with a notice, so the workflow is Applied before every secret is added; `github-settings.sh` reports the missing secret as MANUAL.
- A review posted with `GITHUB_TOKEN` starts no workflows, so PR Auto-Merge follows Claude Review's completion through `workflow_run`.
- Claude Review runs on `pull_request`, so it reviews with the PR's own copy of the workflow: the PR that brings it in lands on the old gate, and the next round is the first to land on Claude's review.
- The marker proves a review came through `github-actions[bot]`, not that Claude wrote it.
  Claude Review runs on `pull_request`, so a branch could change the post step and post a marked review of its own.
  Running the post from `main`'s code wouldn't close that: a branch can add any workflow that asks for `pull-requests: write`,
  and it gets the repo's secrets, `RELEASE_PR_PAT` (which can merge a PR outright) included.
  The merge gate has never guarded against someone who can push a branch; it guards against merging before a review.
  These repos take no fork PRs, and a fork's run gets no secrets and a read-only token, so it can't post.
- A finding outside the diff can't be a thread, so it goes in the review body under a second marker, and PR Auto-Merge holds on it.
  The post job warns instead of failing. A failing check couldn't hold the merge on its own: a later run with its jobs skipped (another label added) replaces it.
  And it would leave the PR `UNSTABLE`, which PR Auto-Merge never merges, so the cap couldn't bypass the hold.
- Dependabot PRs are left out: their own auto-merge path is unchanged, and they get no secrets.
- dotfiles isn't a Baseline repo, so it carries a copy of the two files, which `test.sh` keeps identical to the Template's; its "reviewed" rule is the landing decision's.

## Model, effort and prompt (#117)

Copilot made five findings on Articles#298's three reviewed commits. Four were real bugs that we fixed (#111, #113, #114), and one is a known limit, the marker that proves nothing.
On the same commits, Claude Review as first shipped (Sonnet 5.5, medium effort) found nothing and approved all three.
A PR that landed on Claude's review alone would have merged all of them.

`bench/claude-review-bench.py` replays the Review step with `claude -p` against those commits and scores what it catches (`bench/claude-review-cases.json`).
It also replays three ordinary merged PRs to read for noise. Required findings caught, out of 7 (a finding counts once for each commit that still has the bug):

| Variant | Caught | Per commit |
| --- | --- | --- |
| Sonnet 5.5, medium, original prompt | 0 | ~20 s, ~$0.19 |
| Sonnet 5.5, high | 1 | ~50 s, ~$0.25 |
| Sonnet 5.5, max | 2 | ~16 min, ~$3 |
| Sonnet 5.5, high, thorough prompt (`bench/prompts/thorough-v2.txt`) | 2 | ~2 min, ~$0.47 |
| Opus 5.5, high, thorough prompt v2 | 4 | ~4–7 min, ~$1.20 |
| **Opus 5.5, high, thorough prompt v3 (`thorough-v3.txt`)** | **3** | ~4 min, ~$1.34 |

- **Opus at high effort with the thorough prompt (v3) is what the workflow runs.**
  - With v2 it caught findings 1, 3 and 4, in two runs. With v3 it caught 3 and 4, and missed finding 1 in that one run.
    A point either way is within what one run varies by. It flagged the known marker limit once in the run without WebFetch, and on all three commits in the run with it.
  - Its findings on the benchmark commits were on the right lines, each with a fix, and several were real problems Copilot didn't raise.
  - On the three ordinary PRs, v2 made 2, 3 and 6 findings, where Copilot opened 3, 1 and 2 threads. None were nits,
    but two of the six on Blazor-Server#148 cited lines past the end of an 80-line file, which would hold the merge as off-diff findings (#122).
  - v3 differs from v2 only in where a finding goes: on a line the diff adds or shows, with a problem in unchanged code put on the changed line that depends on it,
    because any other line holds the merge. On the ordinary PRs it made 2, 2 and 4 findings, all on real lines, and on Articles#298 every finding was on a changed line.
    It flagged the known marker limit on all three commits.
- **The review job's `timeout-minutes` is 30.** Opus took up to about 7 minutes on these diffs, and a timed-out job is a failing check that holds the merge.
- **The prompt was the bigger change.**
  - The original said an empty findings list was a good answer and to leave out anything Claude wasn't confident about, and Sonnet then read little beyond the diff.
  - The thorough prompt asks for the files around the diff, untested paths (reruns, skipped jobs, other actors, odd input) and how GitHub itself behaves.
  - It also asks that every line number be checked against the file. An earlier draft produced impossible line numbers, and an off-diff finding holds the merge.
- **No WebFetch.**
  - No run caught finding 5 with it or without it, and Opus scored the same without it.
  - It would also be one more way out for a prompt-injected diff. It isn't the only one: with `Read` unscoped, Claude can read the OAuth token from its own environment,
    and the review it writes is posted publicly. Scoping `Read` and redacting the output are #121.
- **Still missed: finding 5.** Spotting it needs the pinned action's source: Copilot's coding agent acts as `Copilot` with no `[bot]` suffix, so it passes the guard, and the action then refuses it.
  #117 asked for it, so #117 stays open for it. Copilot is still the first reviewer, and a Claude-only landing is still a weaker review than one by both.
- **The benchmark is close to the workflow, not identical.** It runs the local `claude` (2.1.293 for these runs), not the version the pinned action installs,
  and it loads the head's project settings, where the action restores them from the PR's base.
- **Cost:** about $1.20 a review instead of $0.19. That is acceptable, because the backup only runs while a PR carries `review:claude`.
- Matching is by keyword, whole words, on the files a finding is about, and every saved run in `bench/results/` is scored with the current cases file
  (`--rescore` rewrites a file's score after the cases change). Read the findings too: an early, looser matcher counted a finding about skipping `[bot]` actors as finding 5.
- Rerun the benchmark before changing the model, effort, prompt or tools, and add a case whenever Copilot finds something Claude Review missed.
