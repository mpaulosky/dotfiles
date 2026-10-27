# Which token each call uses

Template files (Owned): `.github/workflows/pr-automerge.yml` and its tests in `.github/scripts/tests/pr-automerge.test.mjs`,
`.github/workflows/release.yml`, `.github/workflows/backfill-blog-posts.yml`, `.github/workflows/code-metrics.yml` and `.github/workflows/sandcastle.yml`,
with the blog PR steps' tests in `.github/scripts/tests/test_pat_calls.py`.
History: mpaulosky/dotfiles#231 moved PR Auto-Merge's and the blog PR steps' reads from `RELEASE_PR_PAT` to `GITHUB_TOKEN`.

## The allowances

A personal access token acts as its owner's account, and every token of one account shares that account's rate limit:
5,000 REST requests an hour, and separately 5,000 GraphQL points an hour.
For the owner, that one allowance is shared by:

- local `gh`: `land.sh`, `status.sh`, `rollout.sh`, `reapply.sh` and local Sandcastle runs;
- `RELEASE_PR_PAT` in every repo's PR Auto-Merge, release, backfill and code-metrics workflows;
- `SANDCASTLE_GH_TOKEN`, Sandcastle's token in GitHub Actions.

A workflow's own `GITHUB_TOKEN` has a separate allowance for each repository: 1,000 REST requests an hour and, separately, 1,000 GraphQL points an hour.
So one busy repo can't stall the others.

On 2026-10-18 the owner's account used up its REST allowance: 0 requests were left from about 20:53 to 21:29 UTC.
Every PR Auto-Merge run in every Baseline repo then failed with `HTTP 403: API rate limit exceeded`, so no PR merged until the limit reset.
PR Auto-Merge starts on every push, review, label and finished CI run in seven repos, and each run reads the open PRs' checks, reviews and threads,
so its load grows with the number of open PRs. With every read on the PAT, it was most of the load.

## The rule

Use the PAT only where GitHub must start another workflow, or must see a person: a push, merge or label that CI, the release or Claude Review has to see,
and a comment Dependabot takes only from a person. Everything else goes through `GITHUB_TOKEN`.
A change made with `GITHUB_TOKEN` starts no workflow (other than `workflow_dispatch` and `repository_dispatch`), which is what a read, or a label removal, wants.

`GITHUB_TOKEN`'s allowances are smaller, and PR Auto-Merge, Claude Review and CI's `gh` calls in one repo share them.
Two buckets matter, and the GraphQL one is the likelier to run out:

- **REST (1,000 requests an hour):** each push to a PR starts about ten PR Auto-Merge runs of a few requests each,
  and a sweep costs about four per open PR, well under 1,000 an hour for these repos.
- **GraphQL (1,000 points an hour):** `MergeReadiness` is most of PR Auto-Merge's load. It has seven connections (the head's checks, two review lists,
  threads and labels, and the review commits' parents), so it costs about 1 point, and at most a few when both review lists are full.
  A run evaluating a PR makes at least two queries (the first snapshot and a fresh one), up to four more retries while GitHub reports `UNKNOWN`,
  and one more in `noRequiredCheckState`: 2 to 7 queries, so about 2 to 7 points.
  A push starts about ten runs, so it costs roughly 20 to 30 points, and a sweep costs 2 to 7 points per open PR.
  Between 30 and 50 pushes an hour, or a sweep over a few dozen open PRs, would use up the 1,000, so a repo with many open PRs and frequent pushes is the one to watch.

When it is hit, PR Auto-Merge's `endsRun` ends the run on the 403 or 429 (or GraphQL's `RATE_LIMITED`) from either client, and only that repo waits.
On a run started by a PR event, that's a failed check on the PR's head, so the PR is `UNSTABLE`, which PR Auto-Merge never merges,
until a later event on the PR, such as a push, runs the check again.
That's accepted (mpaulosky/TicketManager#233): with the PAT, one busy repo could use up the allowance every other repo and Sandcastle share,
as on 2026-10-18, while `GITHUB_TOKEN`'s run out only in the repo that spent it, and only past the load estimated above.

## The calls

PAT means `RELEASE_PR_PAT`. Every workflow below falls back to `GITHUB_TOKEN` when the secret isn't set, and then warns that what the PAT would start won't start.

| Workflow | Call | Client | Why |
| --- | --- | --- | --- |
| pr-automerge | `graphql` (`MergeReadiness` in `getPullRequestStatus`: one or two a PR, up to four retries while GitHub reports `UNKNOWN`, one more in `noRequiredCheckState`) | GITHUB_TOKEN | A read. Its `statusCheckRollup` reads check runs and commit statuses, hence the job's `checks: read` and `statuses: read` |
| pr-automerge | `repos.getBranchRules` (once a run) | GITHUB_TOKEN | A read: the checks `main-rules` requires |
| pr-automerge | `pulls.list` (a sweep) | GITHUB_TOKEN | A read: the open PRs |
| pr-automerge | `repos.listPullRequestsAssociatedWithCommit` (a `workflow_run` event) | GITHUB_TOKEN | A read: the PR the finished run's commit belongs to |
| pr-automerge | `pulls.listCommits` (a Dependabot PR) | GITHUB_TOKEN | A read: whether someone else pushed to the PR |
| pr-automerge | `git.getCommit` | GITHUB_TOKEN | A read, for the clean-merge-from-main check |
| pr-automerge | `git.getTree` | GITHUB_TOKEN | A read, for the clean-merge-from-main check |
| pr-automerge | `repos.compareCommitsWithBasehead` | GITHUB_TOKEN | A read, for the clean-merge-from-main check |
| pr-automerge | `issues.listEvents` | GITHUB_TOKEN | A read: who removed `sandcastle:needs-human`, and when `review:claude` was added or removed (`issues: read`) |
| pr-automerge | `issues.listComments` | GITHUB_TOKEN | A read: whether Dependabot was already asked to rebase this head (`issues: read`) |
| pr-automerge | `actions.listWorkflowRuns` | GITHUB_TOKEN | A read: Claude Review's runs for the head (`actions: read`) |
| pr-automerge | `actions.listWorkflowRunsForRepo` | GITHUB_TOKEN | A read: the head's runs when no check is required (`actions: read`) |
| pr-automerge | `issues.removeLabel` (`review:claude`, at the review cap and at MAX_CLAUDE_ROUNDS) | GITHUB_TOKEN | The removal should start no workflow. `pull-requests: write` covers a PR's labels |
| pr-automerge | `pulls.merge` | PAT | release.yml (`pull_request: closed`) and the push to main (CI, the next sweep) must start |
| pr-automerge | `pulls.updateBranch` | PAT | The merge from main must start CI |
| pr-automerge | `issues.addLabels` (`review:claude`) | PAT | Claude Review's `labeled` run must start, so the PAT needs Pull requests (or Issues) write |
| pr-automerge | `issues.createComment` (`@dependabot rebase`) | PAT | Dependabot acts only on a person's comment |
| pr-automerge | `users.getAuthenticated` | PAT | The PAT's own login, which tells its rebase markers apart from anyone else's. `GITHUB_TOKEN` can't read `/user`. Once a run, only when asking Dependabot |
| release, "Open or update the blog PR" | `gh pr list` (twice: before opening or editing the PR, and before labelling it) | GITHUB_TOKEN (`GH_TOKEN="$JOB_TOKEN"`) | A read |
| release, "Open or update the blog PR" | `gh api -X POST …/labels` (`docs-only`) | GITHUB_TOKEN (`GH_TOKEN="$JOB_TOKEN"`) | For visibility only: no workflow has to start, and Claude Review's `labeled` run ignores other labels |
| release, "Open or update the blog PR" | `gh pr edit` | PAT | PR Title has to re-check the edited title, and an edit made with `GITHUB_TOKEN` starts no workflow |
| release, "Open or update the blog PR" | `gh pr create` | PAT | A PR a person authored starts its `pull_request` runs without "Approve and run" |
| release, "Open or update the blog PR" | `gh pr merge --auto --squash` | PAT | GitHub merges as whoever armed auto-merge, and a merge made with `GITHUB_TOKEN` starts nothing on main |
| release, "Open or update the blog PR" | `git push --force` (the checkout's credential) | PAT | The push must start the PR's checks. Git over HTTPS, not the REST allowance |
| release, release job | `git push` of the tag (the checkout's credential) | PAT | Git, not the REST allowance. The tag push needs the PAT's Workflows access when the tagged commit changes a workflow |
| backfill-blog-posts, "Open or update the backfill PR" | `gh pr list` (twice) | GITHUB_TOKEN (`GH_TOKEN="$JOB_TOKEN"`) | A read |
| backfill-blog-posts, "Open or update the backfill PR" | `gh api -X POST …/labels` (`docs-only`) | GITHUB_TOKEN (`GH_TOKEN="$JOB_TOKEN"`) | For visibility only, as in release.yml |
| backfill-blog-posts, "Open or update the backfill PR" | `gh pr create` | PAT | As in release.yml |
| backfill-blog-posts, "Open or update the backfill PR" | `gh pr merge --auto --squash` | PAT | As in release.yml |
| backfill-blog-posts, "Open or update the backfill PR" | `git push --force` (the checkout's credential) | PAT | As in release.yml |
| code-metrics | `peter-evans/create-pull-request` | PAT | The action makes its reads and writes with one token, so they can't be split, and the PR must be a person's. Runs only on a manual publish |

In PR Auto-Merge, `github` is the `GITHUB_TOKEN` client and `patClient` the PAT's, so a PAT call has to say `patClient.`.
`pr-automerge.test.mjs` pins the five PAT calls and the thirteen `GITHUB_TOKEN` ones, and runs scenarios against a fake of each client that refuses the other's calls.
`test_tokens_doc.py` fails when the script makes a call this table doesn't list.

What's left on the PAT is writes only, plus one `users.getAuthenticated` a run when Dependabot is asked to rebase.
Moving the bots to a GitHub App, whose installation tokens have an allowance of their own, is a possible follow-up.

## land.sh and the shared allowance

`land.sh` runs as the owner's `gh` login, so what it spends comes out of the account's allowances that the PAT and Sandcastle share.
Almost all of it is GraphQL points (its poll, and `gh pr update-branch`, `edit`, `view`, `ready` and `merge`, are GraphQL), out of the account's 5,000 an hour.
The 5,000 REST requests an hour, the allowance that ran out on 2026-10-18, are left to the PAT's and Sandcastle's REST calls.

- **Interval:** it polls every 60 s by default (`--interval`).
- **A quiet round** costs one `gh api graphql` per repo: status.py's `QUERY`, about 3 GraphQL points
  (50 PRs, each with five nested lists and the head's check list: 301 requests, divided by 100).
  With `github/repos.txt`'s seven repos that's 420 queries and about 1,260 of the account's 5,000 GraphQL points an hour.
- **Actions** cost more, once per PR head: updating a branch is `gh pr update-branch`, `gh pr edit --add-reviewer @copilot` and a read-back `gh pr view`;
  requesting Copilot is one `gh pr edit` and one read-back; adding `review:claude`, marking a PR ready and arming auto-merge are one call each.
- **A watched PR that left the open list** costs one `gh pr view` a round until it reads MERGED or CLOSED.
- Each `gh pr` command can make a request or two of its own on top.

On a long watch during a busy round, raise `--interval` (say `--interval 300`), and check what's left with `gh api rate_limit`.

## Not split

Sandcastle's `SANDCASTLE_GH_TOKEN` is listed here but not split. `sandcastle.yml` is an Owned Template workflow ([ADR 0009](../docs/adr/0009-sandcastle-workflow-is-owned.md)).
Every host `gh` call Sandcastle makes, reads and writes alike, goes through its one `GH_TOKEN`, across `.sandcastle/lib/github.mts`, `gate.mts`, `intake.mts` and the rest,
so splitting them means threading a second token through all of those call sites. A local run has only the owner's `gh` login anyway.
Splitting its reads onto the workflow's `GITHUB_TOKEN` is a possible follow-up, next to the GitHub App.
