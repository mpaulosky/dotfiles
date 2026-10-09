# Git hooks and branch names

Template files (Owned): `.github/hooks/` (`pre-commit`, `pre-push`, `post-checkout`), `.github/hooks/tests/`,
`scripts/gate.sh`, `scripts/check-branch-name.sh` with its test, and the `branch-name` job in `ci.yml`. History: IssueTracker #182 (the branch standard).

## Branch-name standard

Every repo enforces the same rule twice, with one script, `scripts/check-branch-name.sh`: the pre-push hook checks
each pushed branch, and `ci.yml`'s **Branch name** job, a required status check, checks a PR's head branch.

| Branch | Use |
| --- | --- |
| `feature/{issue}-{slug}` | New behaviour |
| `fix/{issue}-{slug}` | A bug fix |
| `hotfix/{issue}-{slug}` | An urgent fix |
| `chore/{slug}` | Work without an issue |

`{slug}` is lowercase letters and digits in words joined by `-` (`upgrade-net10`, `oauth2-login`). A `chore/` slug
starts with a letter, so it can't pass for an issue-linked name (`chore/7-cleanup` is refused). The check:

```bash
[[ "$branch" =~ ^(feature|fix|hotfix)/[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$ ]] || [[ "$branch" =~ ^chore/[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]]
```

`squad/` and `sprint/` are retired.

**CI is the gate; the hook is the early warning.** A push can skip the hook: a Claude cloud session (claude.ai/code)
pushes `claude/...` branches from a sandbox where `core.hooksPath` was never set, and so do GitHub's web editor and any
clone without the one-time setup. Before the CI check, such branches reached PRs in four repos (Blazor-Server #113,
TicketManager #95, IssueManager #222, Articles #272, all `claude/project-thread-ot9sjt`). The CI job refuses them
until the branch is renamed. Rename it on GitHub (the repo's Branches page, or
`gh api -X POST repos/<owner>/<repo>/branches/<branch>/rename -f new_name=fix/42-null-children`, with `/` in the old
name written as `%2F`) and the open PR follows the new name. Then close and reopen the PR (`gh pr close <n>` and
`gh pr reopen <n>`): a rename makes no new commit, so no check runs, and re-running the failed check reuses the old
name. The reopened run checks the new one. A repo's `CLAUDE.md` can ask cloud sessions to name the branch to the
standard in the first place.

The check guards the process, not against a hostile PR. Under `pull_request` the job runs the PR's own copy of the
script and of `ci.yml`, so a PR can change either, as it can for `Build Solution`; such an edit shows in its review.

The CI job also accepts the branches that only Actions and Dependabot create, which no hook sees:
`docs/release-notes` (`release.yml`), `docs/backfill-blog-posts` (`backfill-blog-posts.yml`) and `dependabot/*`.
Fork PRs skip the job, which a required check counts as passing.

## Worktree standard

Every change is made in its own linked worktree, never in the primary checkout. The primary checkout stays on `main`
for pulls and dry-run surveys. A branch's worktree lives beside the repo, in `../<Repo>-worktrees/`, named after the
branch with `/` turned into `-`:

```bash
git fetch origin
git worktree add -b fix/42-null-children ../<Repo>-worktrees/fix-42-null-children origin/main
```

Remove it once the PR merges: `git worktree remove ../<Repo>-worktrees/fix-42-null-children`. `pre-commit` enforces
the rule. Claude Code's own `.claude/worktrees/` (ignored by the Template's `.gitignore`) also passes the check, since
any linked worktree does, but people use `../<Repo>-worktrees/`.

## The hooks

Hooks live in `.github/hooks/` and are switched on once per clone with `git config core.hooksPath .github/hooks`.
`apply.sh` sets it in the clone it Applies to; the repo's README or CONTRIBUTING tells everyone else.

- **`post-checkout`** repairs `core.hooksPath` and the hooks' execute bits after checkouts. Git only runs it once
  `core.hooksPath` already points at `.github/hooks`, so it can't bootstrap a fresh clone: its header comment says this,
  and names the one-time command.
- **`pre-commit`** first refuses a commit made in the primary checkout (its git dir is the common one), naming the
  commands to use instead: `git worktree add -b` for a new branch, or, when the primary checkout is already on its
  own branch, `git switch main` and `git worktree add` to move that branch into a worktree. Two cases are exempt: a
  repo with no commits on any branch (an orphan branch in a repo with history is not), so a new repo's Apply can be
  its first commit on `main`, and a clone with `git config baseline.allowPrimaryCommits true`, for a clone that can't
  use worktrees (a sandbox or a one-off). Hooks don't run in Actions, so the release workflow's commits are unaffected.
  Then it lints the staged content of Markdown files; see [pre-commit.md](pre-commit.md).
- **`pre-push`**, in order (step 3 runs `scripts/check-branch-name.sh`):
  1. Read the refs from stdin, and gate the refs being pushed, not the checked-out branch. Classify by the *remote* ref,
     so a tag pushed onto a branch still counts as a branch push.
  2. Refuse pushes to, and deletions of, the protected branches (`main`, `preview`, `dev`).
  3. Refuse a branch name outside the standard.
  4. Refuse a pushed commit that isn't the checked-out `HEAD`, because the gate only tests the working tree.
  5. Refuse a working tree with uncommitted or untracked changes, for the same reason. Ignored files don't count.
  6. A push with no branch updates (tags only, or deletions only) skips the gate.
  7. Refuse a branch behind `origin/main`: `main-rules` requires a PR to be up to date before it merges, so its PR
     couldn't merge as pushed (it would sit at `BEHIND`), and the gate would test it against an old main. The hook
     fetches main first; offline it compares with the last fetched copy, and with no `origin/main` it skips the
     check. The fix it names is `git merge origin/main`, which needs no force push; squash merges drop the merge
     commit. From Articles' unmerged `chore/pre-push-main-sync-gate`, written after a branch kept being pushed once an earlier push had auto-merged.
  8. Run `scripts/gate.sh`. No config key skips it any more: the old `sandcastle.gatedHead` skip (Blazor-Server #93)
     was removed after Blazor-Server #188's review, because a Sandcastle sandbox can write `.git/config`. That
     doesn't make the hook a defence against a writable `.git/config`. The hook only runs because the clone's
     config sets `core.hooksPath`, so anything that can write that file can point it elsewhere and turn the hook
     off. The hook is a local convenience; the ruleset and CI are the gate. A Sandcastle repo must keep agents
     from writing the clone's `.git/config` and `.git/hooks`; see step 7 of the Sandcastle setup in the README.
- **`scripts/gate.sh`**, also safe to run by hand: lint the Markdown, YAML, workflow and shell files changed since
  `origin/main`, using CI's configs, and prefer installed tools with pinned fallbacks. Then build and run each test
  project, where the stack allows it locally. Which steps it runs depends on the repo; what's standard is that
  everything it checks, CI checks too.
  Between the lints and the build it runs the Seed `.github/ci/gate-checks.sh <merge-base>` when the repo has one:
  checks only that repo needs, such as Blazor-Server's Sandcastle TypeScript check and Copilot review sync. The merge
  base is empty without an `origin/main`.

## Tests

`.github/hooks/tests/pre-push.test.sh` runs the hook in a throwaway repo with stub tools that log each call, so no real
build runs. It needs cases for:

- each protected-branch rule and deletion
- the tag and mixed pushes
- a push that isn't the checked-out commit
- an untracked or unstaged file
- `.github/ci/gate-checks.sh` running with the merge base, and failing the push before the build
- a `sandcastle.gatedHead` marker for `HEAD` not skipping the gate (pushed and by hand)
- a branch behind `origin/main` refused before the gate (pushed and by hand) with the `git merge origin/main` fix,
  the same branch running the gate once it has merged main, no `origin/main` skipping the check, and a stale local
  `origin/main` refreshed by the hook's fetch
- **each accepted branch prefix** (including slugs with digits), and each retired or malformed name (`squad/`,
  `sprint/`, a prefix missing its issue number, a `chore/` slug starting with a digit, and an uppercase letter in an
  otherwise valid name such as `chore/tidy-Up`). Each bad name must break exactly one rule, or it can't catch a
  regression in that rule.

`pre-commit.test.sh` runs its lint cases in a linked worktree. Its worktree cases cover a commit in the primary
checkout and from a subfolder of it (refused, before the lint), the opt-out, a linked worktree, a repo's first commit,
and `git commit` end to end, which runs the hook with `GIT_DIR` set.

`scripts/tests/check-branch-name.test.sh` covers the script's `--pr` form, which the CI job uses: the Actions and
Dependabot branches allowed only there, a `claude/...` branch refused, and other `docs/` names refused.

CI's hook-tests job runs this suite, `pre-commit.test.sh` and `check-branch-name.test.sh`.

## Adapting

- A repo's own gate steps go in the Seed `.github/ci/gate-checks.sh`, each guarded by the paths it covers. A step
  added to `gate.sh` itself is drift, reverted by the next Apply.
- Update every doc that lists branch names (`CLAUDE.md`, `CONTRIBUTING.md`, the README).
- The Standardize branch is pushed through the *new* hook, because `core.hooksPath` is relative to the worktree. Its
  name, `chore/standardize-baseline`, passes both the old rules and the new one.
- **Move existing worktrees** into `../<Repo>-worktrees/` with `git worktree move`, and update any doc that names
  another folder (IssueManager used `../IssueManager.worktrees/`). Once the Apply is merged, anything still
  uncommitted in the primary checkout moves to a worktree through a stash, as the hook's message shows.
- **Run one pre-push gate at a time.** A gate that runs Aspire or Testcontainers tests starts fixed-name containers, so
  two pushes gated in parallel (one per worktree) collide and fail each other.

## Verify live

Push a branch named under a retired prefix (`git push --dry-run` still runs the hook): it's refused with the standard's
message. Push a `fix/{issue}-{slug}` branch: the gate runs. Open a PR from a branch outside the standard (pushed with
`--no-verify`): the **Branch name** check fails. Rename the branch, close and reopen the PR: it passes. Stage a change in the primary checkout and commit: it's
refused with the `git worktree add` command.
