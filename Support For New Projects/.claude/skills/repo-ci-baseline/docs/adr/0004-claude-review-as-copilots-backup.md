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
  Someone who can push workflow changes can still post a marked review of their own: a branch can add any workflow that
  asks for `pull-requests: write`, and it gets the repo's secrets, `RELEASE_PR_PAT` (which can merge a PR outright) included.
  The post job runs the base's script (below), so a push that changes only `.github/scripts`, without the workflow
  permission, can't. The merge gate guards against merging before a review, not against someone who can push workflow changes.
- A push without the workflow permission can still steer what Claude answers, and so what gets posted under the marker.
  The review job checks out the PR's head and the prompt has Claude follow the repo's conventions (AGENTS.md, CLAUDE.md,
  `docs/`), so a push that edits those files, or puts instructions in the diff, can steer Claude to answer with no findings,
  which the base's script posts as an ordinary review of the head (Claude Review, IssueTracker#227). This is an accepted
  limit: such a push can't change the code that checks or posts the answer, but the marker shows that a review of the head
  was posted, not that the PR was reviewed in good faith.
  A fork PR can't use it: its run gets no secrets and a read-only token, so it can't post, and PR Auto-Merge never merges a fork PR; the maintainer does.
- A finding outside the diff can't be a thread, so it goes in the review body under a second marker, and PR Auto-Merge holds on it.
  A finding on a changed file at a line the file doesn't have (past its end) is a wrong line number, not unchanged code,
  so it goes on the file's nearest line in the diff as a thread, with a note (#122). When the file's length can't be read, it holds as before.
  The post job warns instead of failing. A failing check couldn't hold the merge on its own: a later run with its jobs skipped (another label added) replaces it.
  And it would leave the PR `UNSTABLE`, which PR Auto-Merge never merges. The review's marker holds past the review cap too (#146).
- Dependabot PRs are left out: their own auto-merge path is unchanged, and they get no secrets.
- A Review step that fails, times out (its own 25 minutes, under the job's 30) or is refused at the usage limit doesn't fail the job either (#123):
  `continue-on-error` lets a warning step say so, and the post job skips when there's nothing to post (an empty output would fail it as malformed).
  The PR then has no Claude review of its head, so PR Auto-Merge waits for Copilot's or a rerun, instead of the PR going `UNSTABLE`.
  The prompt also asks Claude to skim generated files, lockfiles, snapshots and recorded data, so a big PR is less likely to run out of time.
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
| Sonnet 5.5, high, thorough prompt v2 (`bench/prompts/thorough-v2.txt`), with WebFetch | 2 | ~2 min, ~$0.47 |
| Opus 5.5, high, thorough prompt v2 | 4 | ~4–7 min, ~$1.20 |
| Opus 5.5, high, thorough prompt v3 (`thorough-v3.txt`, one sentence edited since) | 3 | ~4 min, ~$1.34 |
| Opus 5.5, high, the workflow's prompt, reads scoped, pinned actions' source readable (#121, #117) | 4 | ~4–5 min, ~$1.68 |
| Opus 5.5, high, one turn of reads, `--max-turns 3` (#153), Articles#298 4b90c96 only | 0 of 4 | ~3 min, ~$0.78 |

- **Opus at high effort, held to one turn of reads, on the split diff, is what the workflow runs** (see [One turn of reads](#one-turn-of-reads-153-154)).
  Everything below until that section is how the model, effort and prompt were chosen, uncapped.

- **Opus at high effort with the thorough prompt (v3, edited as below) was chosen, before the turn cap.**
  - With v2 it caught findings 1, 3 and 4, in two runs. With v3 it caught 3 and 4, and missed finding 1 in that one run.
    A point either way is within what one run varies by. It flagged the known marker limit once in the run without WebFetch, and on all three commits in the run with it.
  - Its findings on the benchmark commits were on the right lines, each with a fix, and several were real problems Copilot didn't raise.
  - On the three ordinary PRs, v2 made 2, 3 and 6 findings, where Copilot opened 3, 1 and 2 threads. None were nits,
    but two of the six on Blazor-Server#148 cited lines past the end of an 80-line file, which would hold the merge as off-diff findings (#122).
  - v3 differs from v2 only in where a finding goes: on a line the diff adds or shows, with a problem in unchanged code put on the changed line that depends on it,
    because any other line holds the merge. On the ordinary PRs it made 2, 2 and 4 findings, all on real lines, and on Articles#298 every finding was on a changed line.
    It flagged the known marker limit on all three commits.
- After the benchmark, one sentence of v3 changed: it had asked Claude to read a pinned action's source or GitHub's documentation, which it had no way to do.
  Now the runner's `_actions` (the source of the actions the review job pins) is an `--add-dir`, and the prompt points Claude at it;
  for anything else it says what it's relying on. The benchmark copies the case head's pinned actions into the same layout.
  In that run (`v4-scoped-actions`) Claude caught finding 5 for the first time, from the action's `checkHumanActor`, along with 3 and 4 and the marker limit;
  it missed finding 1, which the v2 runs caught. The same run is the check that scoping reads (#121) cost nothing.
- **The review job's `timeout-minutes` is 30**, and the Review step's 25. Opus took up to about 7 minutes on these diffs; a step that times out now warns instead of failing the check (#123).
  `review:claude` goes mostly on re-Apply PRs, which carry only the Owned files that changed: 2 to 8 files and under 800 lines in the #116 and #82 rounds,
  the largest being Articles#298, the benchmark's own case.
- **The prompt was the bigger change.**
  - The original said an empty findings list was a good answer and to leave out anything Claude wasn't confident about, and Sonnet then read little beyond the diff.
  - The thorough prompt asks for the files around the diff, untested paths (reruns, skipped jobs, other actors, odd input) and how GitHub itself behaves.
  - It also asks that every line number be checked against the file. An earlier draft produced impossible line numbers, and an off-diff finding holds the merge.
- **No WebFetch.**
  - No run caught finding 5 with it, and Opus scored the same without it.
  - It would also be one more way out for a prompt-injected diff. See [Keeping the token out of the review](#keeping-the-token-out-of-the-review-121) for the others.
- **Finding 5 needed the pinned action's source**: Copilot's coding agent acts as `Copilot` with no `[bot]` suffix, so it passes the guard, and the action then refuses it.
  Only an action this review job itself runs is on the runner, so a finding about another workflow's pinned action still rests on what Claude says it's relying on.
  Copilot is still the first reviewer, and a Claude-only landing is still a weaker review than one by both.
- **The benchmark is close to the workflow, not identical.** It runs the local `claude`, not the version the pinned action installs.
  Results files record the version from `noise-v2-opus-high` on (2.1.293 there, 2.1.294 for the v3 and v4 runs); the earlier files predate that, and the CLI updated during these runs.
- **Cost:** about $1.20 to $1.70 a review uncapped, instead of $0.19 at API prices; about $0.30 to $1.10 under the turn cap.
  That is acceptable, because the backup only runs while a PR carries `review:claude`.
  In CI, though, the review runs on a subscription token (`claude setup-token`), so it uses the plan's Opus allowance, and the plan has to include Opus in Claude Code.
  A run refused at the usage limit posts nothing and warns, and the PR waits for Copilot's review or a rerun after the reset (#123).
- Matching is by keyword, whole words, on the files a finding is about, and every saved run in `bench/results/` is scored with the current cases file
  (`--rescore` rewrites a file's score after the cases change). Read the findings too: an early, looser matcher counted a finding about skipping `[bot]` actors as finding 5.
- Each results file keeps the exact prompt and arguments it ran with, which is what reproduces its score; a prompt file may have changed since.
- The workflow's header records the accepted marker limit, because the prompt asks for problems "a maintainer would want fixed or knowingly accepted",
  and this ADR isn't in the Baseline repos: without it, every re-Apply PR that touches the workflow would get the same thread.
- The benchmark runs Claude on the maintainer's machine against the cases' commits.
  It takes the root `.claude/`, `.mcp.json`, `CLAUDE.md` and `CLAUDE.local.md` from the base, as the action does, loads no settings at all
  (`--setting-sources ""`, for the runner's empty user level), starts no MCP servers and runs git with hooks off.
  So no settings, hooks or servers run, the head's, the base's or the maintainer's own (#125); the base's hooks used to, against the head's scripts.
  Nested `CLAUDE.md` files still come from the head, as the diff does. Only trusted commits become cases, and a results file is read before it's committed.
- Rerun the benchmark before changing the model, effort, prompt or tools, and add a case whenever Copilot finds something Claude Review missed.

### One turn of reads (#153, #154)

The owner's limit is 3 turns a review: one turn of reads, then the answer. The prompt holds a review to it:
it asks for every Read in one turn of parallel calls, because with `--json-schema` the answer takes a turn of its own,
so a second turn of reads leaves none for the answer.

- **`--max-turns` is the action's backstop, not the limit**, because two tools read the same number differently.
  Claude Code stops after that many API round-trips, but claude-code-action compares it with the result's `num_turns`,
  which counts messages (about one for each tool call, so each parallel Read is one), and rejects a result above it after it has run.
  - #153 set `--max-turns 3`, and every review that followed the prompt was rejected ("reported a successful result after 6 turns, exceeding the configured maximum of 3").
  - #154 set 7, which a review of 3 or 4 reads reports. That held for small diffs only: a review that reads more files reports more.
  - With the diff split into pieces (below) a review reads more files by design: on Blazor-Server#190 it read 14 in its one turn and reported 16.
    So the cap is now 30, and the prompt allows at most 24 Reads (about 26 reported). At 30, a review that ignored the prompt could make up to 30 round-trips,
    so `--max-budget-usd 3` caps what one review can spend instead.
- **Cost under the cap: about $0.30 to $1.10 a review**, against about $1.70 uncapped. On the bench: IssueTracker#197 $0.29, Articles#298 $0.78, Blazor-Server#190 (2,600 lines) $0.93.
- **Recall under the cap is unmeasured, beyond one run.** On Articles#298 4b90c96, capped at one turn of reads,
  Claude caught 0 of the 4 required findings (`bench/results/20261009T072452-maxturns3-opus-high.json`; it flagged the optional marker limit), against 2 to 4 uncapped.
  #117 stays open until the capped recall on Articles#298 is recorded on all three commits, with the split diff.

#### The split diff

Every review of the ~2,600-line re-Apply PRs of 2026-10-09 said the diff was cut off after about 1,030 lines, so the workflow files late in it went unreviewed.
A Read of a file over 25,000 tokens returns only its first page, and the one turn of reads leaves no turn for the next.
Those are the Read tool's limits in Claude Code 2.1.293 (what the action pin installs) and 2.1.295, read from the CLI's own code:
25,000 tokens (counted by the API), 2,000 lines when no limit is given, and no whole-file Read over 256 KiB.

- **The "Write the PR's diff" step also writes the diff in pieces** under `$RUNNER_TEMP/claude-review/diff/`, each under 40,000 bytes and 1,500 lines
  (about 10,000 tokens of code), so one Read returns a whole piece.
  - Each file's diff is packed whole into the current piece in read order: workflows, scripts, source, tests, docs, then deleted files, each kind in diff order.
    Pieces are few and full, because each Read counts against `--max-turns`.
  - A file's diff too big for a piece is split into parts between hunks. Each part repeats the file's header, and a part that starts inside a hunk
    opens with `@@ -old +new @@ (continued)`, so line numbers still follow. A line over 10,000 bytes is cut into chunks at character boundaries.
  - Lockfiles go in pieces of their own that the prompt never asks for.
    They don't hold the merge when unread: a dependency change shows in the manifest.
  - Generated files (`*.g.cs`, `*.min.js`, snapshots) can hold compiled code, so they come last and are asked for while they fit.
    Past the budget they hold the merge like any code.
  - The prompt asks for at most 8 pieces and 300,000 bytes (about 80,000 tokens), leaving room for source files; the rest are listed as not read,
    and the summary must name them. A code piece among them adds a finding outside the diff, which holds the merge for a person.
- **Pieces are named by number only (`001.diff`), and the prompt lists them by name, line count and kind.**
  A PR's paths are its author's: none becomes a file name or reaches the prompt. The list reaches the prompt as a step output,
  since Claude can't read an index before its one turn of reads. `diff/INDEX` maps each piece to its files' paths, as git prints them (quoted when unusual, one per line),
  and Claude reads it in the same turn.
- **The split is inline in the workflow**, like the answer check: it runs in the job that later hands Claude the token, so a PR's own script mustn't run there.
  The Template's tests (`test_claude_review_split_diff.py`) and the benchmark run the heredoc as it is.
- **On the bench** (`bench/results/20261009T084333-split-diff-packed-large-opus-high.json`, the `large` case, Blazor-Server#190):
  Claude read INDEX, all five pieces, AGENTS.md and CLAUDE.md in one turn, then answered: 10 turns reported, ~3 min, $0.93, three findings,
  and a summary that says every piece was read. An earlier run with one piece per file (`20261009T083504-split-diff-large-opus-high.json`)
  read all eleven and made a finding on `pr-automerge.yml`, the last file in the diff, but reported 16 turns, which the action would have rejected at 7.
  The benchmark now records each turn's tool calls and flags a run whose `num_turns` the action would reject.

## Keeping the token out of the review (#121)

The Claude process holds `CLAUDE_CODE_OAUTH_TOKEN`, it reads untrusted PR content, and the review it writes is posted publicly.
A prompt-injected diff (or text an agent copied into a PR) could ask Claude to read the token and quote it.
Since Claude Review first shipped, `--allowedTools "Read,Glob,Grep"` granted those tools on every path, so nothing stopped it.

- **No tool is granted outright.** Read, Glob and Grep are then allowed only in the working directory and the `--add-dir` directories:
  the checkout, `$RUNNER_TEMP/claude-review` (the diff alone, not the rest of `RUNNER_TEMP`) and the runner's `_actions`.
  Checked with Claude Code 2.1.293 (the version the pinned action installs) and 2.1.294 in `-p` mode with the workflow's flags:
  reads, Greps and Globs of `/etc`, a sibling of the diff's directory and `/proc/self/environ`
  are refused, and so are `/dev/fd/../environ` and a symlink in the checkout pointing at `/proc/self/environ` or `/etc/hostname`: Claude Code resolves the path before it checks.
  With `--allowedTools "Glob,Grep"`, Grep searched outside the workspace and Glob listed `/etc`, which is why nothing is granted.
- **`Read(//proc/**)` stays denied**, in case a later change grants a tool again.
- **`Read(**/.git/**)` is denied.** In agent mode the pinned action sets the checkout's origin URL to
  `https://x-access-token:<GITHUB_TOKEN>@github.com/...`, so `.git/config` holds the job's token inside the workspace, whatever
  `persist-credentials` says (found by Claude Review on TicketManager#145, which read it there). Checked with Claude Code 2.1.293:
  without the rule Read returned `.git/config`; with it, Read (directly, through `..` and through a symlink), Glob and Grep were all refused or empty.
  The token is read-only and expires with the job. The redaction's GitHub pattern also covers today's `ghs_<digits>_<JWT>` form.
- **`--setting-sources user`.** The action already replaces the PR's `.claude/` and `.mcp.json` with the base's;
  this also keeps the base's project settings from granting `Read` again. The runner's user level has no settings.
- **An answer that quotes a secret is withheld, exactly.** A step in the review job, inline in `claude-review.yml`, reads
  Claude's answer from the action's execution file and drops it when it holds 16 characters in a row of the secret part of
  `CLAUDE_CODE_OAUTH_TOKEN` or the job's `GITHUB_TOKEN`, passed to it as masked secrets. That catches a near-miss quote GitHub's
  masking would let through, and never fires on a sample token from the PR. The secret part is a token's body after its public
  prefix, or a JWT's signature: the first round checked the whole stored value, and failed every review in the #132 re-Apply
  round, most likely on a part every review quotes: a stored value can hold more than the token, and a JWT's header is the same
  in every job's token. It compares letters and digits only, across the answer's strings as Claude wrote them, so a secret
  quoted in pieces split by backticks or newlines is caught too, and so is one in look-alike characters (fullwidth,
  mathematical). It compares the answer after NFKC and after NFKD: NFKC alone let through a mark after each letter,
  composing each pair into a non-ASCII letter that was stripped (Claude Review, IssueTracker#227), and NFKD alone let
  through pieces joined by accented letters, keeping the base letter between them (Claude Review, dotfiles #137). Pieces
  split by letters or digits aren't caught, an accepted limit.
- **Only the schema's fields are passed on.** The check drops every key but the summary and each finding's path, line and
  body, and the schema sets `additionalProperties: false`, so an extra field, never posted but printed by the post job's log,
  is gone (Claude Review, IssueManager#274). An answer of the wrong shape, judged as `parse_findings` judges it, becomes a fixed
  placeholder holding none of it, so nothing the check didn't compare reaches the log, and `post_claude_review.py` still
  rejects it rather than posting "No findings". The check prints why as an error, since the post job's message can't
  name it; the reason is fixed text with at most a finding's index (Claude Review, IssueTracker#227). Each finding's `line` must be 0 to 1000000, so no single line
  carries a token as one big number, and is checked, read as a character code, with the strings.
- **Accepted limits of the check.** It catches a quote of 16 characters in a row, after NFKC or NFKD and with everything but ASCII
  letters and digits taken out. A quote changed any other way still gets through, and each of these was raised in review
  and accepted rather than closed, since closing one leaves the next:
  - pieces split by letters or digits, or by characters NFKC and NFKD map to them (fullwidth, ligatures, circled or
    superscript: Claude Review, dotfiles #137), including pieces in separate fields or findings, where the text between
    them is the other fields' (Copilot, Blazor-Server#176);
  - look-alikes NFKC doesn't map, such as Cyrillic or Greek letters, which are taken out and leave gaps (Claude Review,
    atelier-store#130), and a reversed quote;
  - a swap-cased quote, since the comparison doesn't fold case, and base64, hex or ROT13 of the token (Claude Review,
    TicketManager#147 and dotfiles #136);
  - a quote mixing Unicode tricks, since each window must match in one form: accented letters at some joins and combining
    marks at others, or a mark after each letter with accented letters between pieces (Claude Review, dotfiles #137);
  - character codes written as digits in the summary or a body, or packed several to a `line`.

  The check is a backstop. Claude's read restrictions above, which keep it from reading the token at all, are the defence;
  a gap here matters only if those fail. The workflow's comment lists these limits too, since this ADR isn't in the Baseline repos.
- **No answer in the execution file fails the review job.** The check step runs only when Claude answered, so an empty or
  unreadable execution file is its own error, not a quoted secret, and the post job doesn't run.
- **No review in a debug run.** At the pinned action, debug logging turns `show_full_output` on, and the runner logs step outputs,
  so a debug rerun would publish Claude's answer before the check above. The Review step is skipped when `runner.debug` is set,
  with a warning to rerun without it, and sets `ACTIONS_STEP_DEBUG` to `false` for the action.
- **The check is inline in the workflow, not in `.github/scripts`.** It holds `CLAUDE_CODE_OAUTH_TOKEN`, and a token without
  the workflow permission (an app's, or a coding agent's that a prompt injection could steer) can push a change to a PR's
  scripts but not to its workflows. #133 ran the PR's copy of the script and called write access the boundary; Claude Review
  on Blazor-Server#176 showed that boundary is the workflow permission, and on atelier-store#130 that an older PR's script
  lacked the option the merged workflow called. `pull_request` runs the workflow from the PR's merge commit, so the check is
  always the workflow's own. The post job runs the base's `post_claude_review.py`, taken from the merge commit's first parent,
  since it holds a token that can post a review under the marker: a changed script in the PR could otherwise post a marked
  review Claude never wrote, which PR Auto-Merge would accept (Claude Review on #134). The first parent is the base the
  workflow was merged against; the event's `base.sha` can be older. A PR that changes the script is posted by the base's
  copy until it merges, so a PR that changes the script's interface together with the workflow's call fails its own post
  job: land such a change in two steps, the script accepting both first. A base with no script yet warns and posts nothing.
- **A quoted secret can't skip the post job.** A withheld answer, by that check or by GitHub withholding a job output that holds a
  masked secret, reaches the post job as empty findings. The post job is gated on a `reviewed` flag that can't hold a secret,
  not on the findings, so it still runs, and `post_claude_review.py` fails on empty findings with an error to rotate the token.
- **Credential-shaped text is redacted and warns.** The same step replaces anything shaped like an Anthropic key or OAuth token,
  a GitHub token or a JWT, in the formats they're issued in, before the answer becomes the job output the post job's log prints.
  The post step redacts again, notes the count in the review, and warns.
  It first failed the step instead, so a person would look. On the first re-Apply round that carried it, the PR Auto-Merge hold
  that failure caused fired on atelier-store#130 and IssueManager#274 for a snake_case name and for this script's own test
  fixtures, and a re-run posts a duplicate review: matches that reach this point are public text far more often than leaks,
  and the exact check above already covers the real secrets. The tests build their sample tokens at runtime.
- The pinned action runs on the Claude Agent SDK `^0.3.293` and passes `--allowedTools`, `--disallowedTools` and `--add-dir` through (its `parse-sdk-options.ts`).
- Someone who can push workflow changes to a branch is out of scope here, as for the marker: they can change the workflow
  itself. Someone who can push only other files reaches neither `CLAUDE_CODE_OAUTH_TOKEN` nor the post job's script,
  though they can steer Claude's verdict (the marker limit above).
