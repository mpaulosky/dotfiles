---
name: review-changes
description: Review, lint, build, test, and commit the current git worktree. Use when the user asks to review changes or a branch, clean up and commit work in progress, or wants a dry run of that.
---

# Review Changes

The **review surface** is the whole worktree unless the user narrows it. Every
file you were not asked about is **out-of-scope work**: name it in the report,
leave it exactly as found (reach for explicit-path staging, never
`git checkout`/`restore`/`reset`/`clean`/`add -A`). This session's own
artifacts, such as `build-log.txt`, are the only exception.

The **gates** (lint, build, tests) always run against the whole branch state,
however narrow the approved scope.

**Dry run** ("dry run", `--dry-run`): do every inspection and gate, but leave
the working tree, index, and history untouched. End by reporting what _would_
be staged, the commit message that _would_ be used, and gate results, marking
any gate you did not actually run as not run.

## Workflow

1. **Inspect.** Run `git status --short`, note the branch, and read all of
   `git diff` and `git diff --staged`.
2. **Get onto a working branch.** When the repo has
   `scripts/check-branch-name.sh`, it is the branch standard: run
   `bash scripts/check-branch-name.sh <branch>` from the repo root, as its
   pre-push hook does, on the current branch and on any name you pick, and
   use a name only once it exits 0. Otherwise learn the standard from the
   repo's `CONTRIBUTING.md`, `CLAUDE.md`/`AGENTS.md` and existing branches;
   absent any, treat the default branch as protected and use `chore/<slug>`.
   Stay put when the branch already follows the standard and this checkout
   accepts commits. Otherwise, before any fixing, move:
   - **Worktree rule** (the repo's `.github/hooks/pre-commit` refuses commits
     in the primary checkout, as Baseline repos' does), in the primary
     checkout: set the in-scope files aside with
     `git stash push --include-untracked -- <paths>`. On a branch that
     follows the standard, `git switch <default branch>`, then
     `git worktree add ../<Repo>-worktrees/<branch with / as -> <branch>`;
     otherwise `git worktree add -b <branch> ../<Repo>-worktrees/<folder>
     HEAD` with a new name by the standard. Then `git stash pop --index`
     inside the new worktree. Out-of-scope work stays in the primary
     checkout, and every later step runs in the worktree.
   - **Otherwise:** `git switch -c <branch>`, named by the standard.

   Skip in dry run or when the worktree is clean. Done when you are on a
   branch that passes the standard, in a checkout where the hooks accept a
   commit.
3. **Fix scope.** Default is the full worktree; narrow only to files or areas
   the user named. If scope is genuinely ambiguous, ask before staging.
4. **Review the in-scope diff** for correctness bugs, regressions, security
   (secrets, injection, auth bypass), and missing focused tests. For a heavier
   pass, invoke the `code-review` skill instead.
5. **Run the gates in order**, fixing each one's findings before the next:

   **a. YAML lint**, if `.yml`/`.yaml` changed. With a repo config
   (`.yamllint`, `.yamllint.yaml`, `.yamllint.yml`), run
   `yamllint <changed files>`; otherwise use this skill's
   [`yamllint.yaml`](yamllint.yaml):

   ```bash
   yamllint -c ~/.claude/skills/review-changes/yamllint.yaml <changed files>
   ```

   Without a local `yamllint`, use Docker:

   ```bash
   docker run --rm -v "$PWD:/work" -w /work \
     -v ~/.claude/skills/review-changes/yamllint.yaml:/yamllint.yaml:ro \
     cytopia/yamllint:latest -c /yamllint.yaml <files>
   ```

   **b. Markdown lint**, if `.md` changed:
   `pnpm dlx markdownlint-cli2 <changed files>` (picks up the repo's
   `.markdownlint*` config when present).

   **c. Build repair loop.** `dotnet restore <solution>`, then
   `dotnet build <solution> --no-restore --configuration Release` (the
   configuration the tests run in), where `<solution>` is the
   `.sln`/`.slnx` at the repo root (affected projects are fine for the inner
   loop; finish on a full solution build with `--no-incremental`, since an
   incremental build hides up-to-date projects' warnings). For each error or
   warning: locate it, understand the rule, fix, rebuild. Done when the full
   build shows zero errors and every new warning is fixed or explicitly
   triaged. Read which
   warnings are errors and which are already suppressed, and why, from
   `Directory.Build.props` (`TreatWarningsAsErrors`, `NoWarn`) and
   `.editorconfig`. Log findings and fixes to `build-log.txt` at the repo
   root.

   **d. Tests.** Run each test project (find them in the solution, e.g. under
   `tests/`) separately: the Microsoft.Testing.Platform runner can report
   `Zero tests ran` at the solution level on a healthy suite.

   ```bash
   dotnet test <test project>.csproj --configuration Release
   ```

   If a project reports a runner-level error rather than a pass/fail count,
   run its assembly directly, once per target framework in the project's
   `TargetFramework` or `TargetFrameworks`, asking MSBuild for the path:

   ```bash
   dotnet msbuild <test project>.csproj -getProperty:TargetPath \
     -p:Configuration=Release -p:TargetFramework=<tfm>
   dotnet <TargetPath>
   ```

   Green only when every project reports its tests passed.

   **e. Repo gate.** When the repo has `scripts/gate.sh` (the pre-push gate,
   which runs what CI runs), finish on it; a-d are its inner loop. A repo
   with no .NET solution and no `gate.sh` runs its documented check (a
   `test.sh`, or its CI workflow's commands) in place of c and d.

6. **Loop** until every gate that applies is green on the same final state.
7. **Stage the in-scope files by explicit path**, then re-read
   `git status` and `git diff --staged` and confirm only in-scope files are
   staged.
8. **Commit once**: a new commit with a concise conventional-commit message
   giving the _why_. Stop there; pushing is a separate, explicit ask.
9. **Report**: branch and worktree path (and whether step 2 created them),
   commit hash and message, files committed, exact gate commands and results,
   and every uncommitted file left behind with why. Say plainly that the
   commit is local, unpushed and has no PR, and give the commands that would
   push it and open the PR (title in the commit format; the repo's
   `docs/PROCESS.md` when present), and offer to run them; they run only
   on the user's yes, never in a dry run. Where the repo's pre-push hook
   refuses a branch behind its default branch (the Baseline's does), they
   start with `git fetch origin <default branch>` and, when the branch is
   behind, `git merge origin/<default branch>` and a rerun of step 5's
   gates, on a clean tree only. A merge that won't start, a conflict
   (`git merge --abort` when `MERGE_HEAD` exists) or a red gate goes back
   to the user unpushed.

   Close with any **prune candidates**: linked worktrees safe to remove, with
   their `git worktree remove <path>` and `git branch -D <branch>` commands.
   Removing one is the user's call, and `-D` deletes unmerged commits, so
   list a worktree only when every test holds; a command that errors means
   unknown, so skip that worktree:
   - `git ls-remote --exit-code --heads origin refs/heads/<branch>` exits 2
     (gone from the remote);
   - `gh pr list --head <branch> --state merged --json headRefOid` has a PR
     whose `headRefOid` equals `git rev-parse refs/heads/<branch>` (the tip
     itself merged, whatever PRs once shared the name);
   - `git -C <path> status --porcelain --untracked-files=all` succeeds and
     prints nothing;
   - it is neither the worktree this run created nor the one it runs in.

   `git worktree remove` also deletes ignored files, so flag anything in
   `git -C <path> status --porcelain --ignored` (one line per ignored
   folder) beyond build output (a `.env`, `*.user`). A worktree
   `git worktree list` marks `prunable` (its folder is gone) gets
   `git worktree prune` instead.
