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
2. **Branch off a protected branch.** Learn the repo's protected branches and
   branch naming from its `CONTRIBUTING.md`, `CLAUDE.md`/`AGENTS.md`, hooks
   (e.g. `.github/hooks/pre-push`), and existing branches; absent any, treat
   the default branch as protected and use `chore/<slug>`. If on a protected
   branch, switch now, before any fixing, to a new branch named by that
   convention, so the whole fix loop stays off it. Stay put on a branch that
   already follows the convention. Skip in dry run or when the worktree is
   clean.
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

6. **Loop** until all four gates are green on the same final state.
7. **Stage the in-scope files by explicit path**, then re-read
   `git status` and `git diff --staged` and confirm only in-scope files are
   staged.
8. **Commit once**: a new commit with a concise conventional-commit message
   giving the _why_. Stop there; pushing is a separate, explicit ask.
9. **Report**: branch (and whether step 2 created it), commit hash and
   message, files committed, exact gate commands and results, and every
   uncommitted file left in the worktree with why.
