# PR watcher

`scripts/watch-pr.sh` watches one pull request for the session that opened it and exits with the reason when that session has to act.
It is Owned, so every repo gets it, with or without Sandcastle. It needs `gh` and `jq`, and it is read-only: it makes `gh api graphql`
queries and writes only its seen file.

```bash
scripts/watch-pr.sh <pr>                      # poll every 60 s for up to 120 minutes
scripts/watch-pr.sh --once <pr>               # one poll
scripts/watch-pr.sh --interval 120 --timeout 30 <pr>
scripts/watch-pr.sh --would-skip < body.txt   # does the watcher skip this comment body? (exit 0 yes, 1 no)
```

`WATCH_PR_INTERVAL` and `WATCH_PR_TIMEOUT` set the defaults and the flags win. Each poll costs about 1–3 GraphQL points of the owner's allowance
([tokens.md](tokens.md)), which is why the interval defaults to 60 s and shouldn't go lower.

## Reasons

A poll prints one `watch-pr: <code>: <detail>` line for every reason that applies, in this order, and exits 0.

| Code | When |
| --- | --- |
| `merged`, `closed` | The PR is merged or closed. Printed alone. |
| `conflict` | The PR conflicts with its base. |
| `behind` | The base branch moved and the repo's rules require an up-to-date branch. Not reported beside `conflict`. |
| `check-failed` | A check run ended FAILURE, TIMED_OUT, ACTION_REQUIRED or STARTUP_FAILURE, or a status context is FAILURE or ERROR. The names are listed. Cancelled, skipped, neutral and pending checks don't count. |
| `thread` | An unresolved review thread whose last comment is not the session's or Sandcastle's (Copilot's counts). |
| `changes-requested` | A person's review asked for changes. |
| `review` | A person's review with a body. |
| `comment` | A person's comment on the PR, the owner's included when it carries no marker. |

A bot (`__typename` Bot: Copilot, github-actions) is never a person for `changes-requested`, `review` and `comment`; its findings reach the session as threads and checks.
`mergeable` UNKNOWN means GitHub hasn't worked it out yet, so the watcher keeps polling.

**Persistent** states (`conflict`, `behind`, `check-failed`, `thread`) are recomputed every poll and reported until fixed.
**One-shot** events (`changes-requested`, `review`, `comment`) are written to the **seen file**, `watch-pr-<n>.seen` in the git common directory
(`git rev-parse --git-common-dir`, so a linked worktree shares the main checkout's), and the next run doesn't report them again.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The session is needed; the reasons are on stdout. |
| 1 | Quiet until the timeout, or after `--once`. |
| 2 | A usage error, a missing `gh` or `jq`, an unknown repository, or a PR that can't be read. A poll that fails, or answers with something other than a pull request, is retried; five in a row end the watch. Output that isn't GitHub's answer is never read as quiet. |

The timeout is counted in the waits between quiet polls (a failed poll's wait isn't counted; at most four of them run in a row).

## What it skips

Sandcastle and the session post under the owner's token, so the author can't tell them from the owner. Two markers do:

- **The session's.** A body that contains `WATCH_PR_MARKER` anywhere (default `<!-- claude-session -->`, the text `docs/PROCESS.md` has the session put in its replies).
- **Sandcastle's.** A body that *starts* with `<!-- sandcastle:<name> -->`, where the name is lower-case letters and hyphens, with or without data after the name:
  `<!-- sandcastle:approved-head <sha> -->` and `<!-- sandcastle:overlap … -->` are posted on PRs and carry data. A regex that took only a bare name would wake the watcher
  on every push. A quoted marker (`> <!-- sandcastle:pr -->`) or one further down the body is a person's text and still wakes it.

Every PR comment Sandcastle posts opens with a marker: `PR_MARKER`, `FOLLOW_UP_MARKER` (the pass summary), `FOLLOW_UP_REPLY_MARKER`, `APPROVED_HEAD_MARKER`,
`APPROVAL_LAPSED_MARKER`, `OVERLAP_MARKER`, `GIVE_UP_MARKER` and `WORKTREE_TAMPERED_MARKER`, all in `.sandcastle/lib/config.mts`. `config.test.mts` runs `watch-pr.sh --would-skip` on every
string that file exports starting `<!-- sandcastle:`, so a new marker is covered by exporting it from `config.mts`. A new PR comment from Sandcastle needs a marker as its first line.

Anyone who can comment can forge a marker and be unheard by the watcher. That is acceptable: the watcher is a convenience for the session, not a gate.

## Limits

- The lists are read once, not paged: 100 review threads, 100 checks, the last 50 reviews and the last 50 comments. A thread past the 100th isn't seen.
- `behind` appears only where the base branch's rules require an up-to-date branch. PR Auto-Merge also merges `main` into a ready PR, so it may clear before the session acts.
- The Sandcastle workflow's own red `Sandcastle` check counts as `check-failed`.
- The tests run against a fake `gh`; nothing in the Template runs it against live GitHub.

## Who does what

| Tool | Who runs it | What it does |
| --- | --- | --- |
| `scripts/watch-pr.sh` | The session, on its own PR, in every repo | Reads the one PR; tells the session what needs it. Never changes anything. |
| `land.sh`, `status.sh` ([automerge.md](automerge.md#landing-a-round)) | The owner, across every repo in `github/repos.txt` | Decide the landing steps (update the branch, ask Copilot, add `review:claude`, auto-merge); `land.sh` does them. |
| PR Auto-Merge | The workflow | Lands a ready PR once its gates pass. |
| Sandcastle's sweep ([sandcastle.md](sandcastle.md)) | The host | Answers threads and red checks on its own PRs and those the owner handed over. |

They share no code. `land.sh` and `status.sh` are the skill's Python and don't ship to repos; the watcher is an Owned script that does, and
it reads only what the session needs (behind, checks, threads, people's words), not Copilot, `review:claude` or the landing decision.
A test holds that it makes no call but `gh api graphql` and no write.

## Adapting

When to run it is each repo's own rule, so it isn't in the Template. Add a line to the repo's `CLAUDE.md`, for example: after opening a PR, run
`scripts/watch-pr.sh <pr>` in the background and act on what it prints. dotfiles' own line is under its Commands.
