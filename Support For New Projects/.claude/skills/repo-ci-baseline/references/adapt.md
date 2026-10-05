# Adapt

The work after Apply, in commits on top of the Apply commit.
Done when every item below is resolved for this repo and `scripts/gate.sh` passes locally.

## From the report

- **Drift.** For each overwritten Owned file, read what the Apply commit removed (`git show HEAD -- <file>`).
  Drift goes.
  A real local fix stops the Standardize: move it into the Template first (a dotfiles PR, `test.sh` green), then re-Apply.
- **Seed files skipped.** Diff each against `template/seed/` and bring over what the repo lacks.
  The repo's version wins on content.
- **Seed files written.** Check each against what the repo had before: `.github/ci/coverage-threshold` defaults to 80, so set it to the gate the old `ci.yml` enforced (IssueTracker's was 60).
  A repo that deleted a Seed on purpose gets it back from Apply: IssueManager's #237 had removed a security policy that
  described another project, and the Seed `docs/SECURITY.md` was that same policy until it was made generic.
- **Ignores only this repo needs**, such as atelier-store's generated `wwwroot/app.css`, go in a `.gitignore` beside them (`src/AtelierStore.Web/.gitignore`).
  The root `.gitignore` is Owned, so a line added there is reverted by the next Apply.
- **Analyzer settings only this repo needs** go in an `.editorconfig` beside the code they cover, for the same reason: the root one is Owned.
  IssueManager's root file turned off xUnit1030 and xUnit1051 for `tests/**` and IDE0044 for Razor code-behind; Apply dropped them and
  the build failed, so they moved to `tests/.editorconfig` (`[*.cs]`) and `src/.editorconfig` (`[*.razor.cs]`).
- **Unfilled placeholders.** Fill each `{{...}}` by hand.
- **Leftovers.** Delete `sync-readme.yml` (`release_post.py` already maintains `docs/README.md`) and `label-enforce.yml` (squad's triage labels).
  Delete `automerge-decision.mjs`, its test and `automerge-tests.yml` (TicketManager, IssueManager): the Template's `pr-automerge.yml` keeps its decision inline, see [automerge.md](automerge.md).
  Keep repo features such as `generate-blog-posts-json.yml`, and check each kept workflow still passes actionlint and zizmor.
- **Conflicts.** Delete any `.markdownlint.json`; its `{"default": false}` turned Markdown lint off.
  Run `markdownlint-cli2 --fix '**/*.md'`, then fix the rest by hand.
  TicketManager had 263 issues and IssueManager 1036.

## Per-repo CI setup

Move whatever the old `scripts/gate.sh` checked for this repo alone into `.github/ci/gate-checks.sh`, guarded by the paths each check covers.

Move whatever the old `ci.yml` did for this repo alone into `.github/ci/prepare.sh` (`build`, or `test <name>`):

- Tools the build runs: atelier-store's Tailwind build needs pnpm, so `corepack enable` (pnpm's version comes from `packageManager` in `package.json`).
- Test fixtures: IssueTracker's `AppHost.Tests` needs the UI published and the Mongo and Redis images pulled, plus `ConnectionStrings__mongodb=mongodb://localhost:27017` appended to `$GITHUB_ENV`.
- Secrets: the test jobs get only the repo's optional `TEST_ENV` secret, one `NAME=value` line per variable
  (`MongoDB__ConnectionString=...`), masked and exported by `load_test_env.py`.
  Move any secret the old `ci.yml` passed to the tests into it (`gh secret set TEST_ENV < file`), and delete the old secret once CI passes.
  Check the names as well as the values: the old `ci.yml` may have mapped a secret to a different variable name. Articles' old CI
  exported `AUTH0_ADMIN_USERNAME` as `Auth0__E2E__Admin__Username`, while `TEST_ENV` held `Auth0__Admin__Username`, so 9 of 10 E2E tests
  skipped, which still passes. Compare each test job's skipped count with the old CI's, not just its result.

## Test runner

`global.json` puts `dotnet test` on Microsoft Testing Platform.
Every test project must run on it, as atelier-store's and TicketManager's do: `xunit.v3.mtp-v2` plus `Microsoft.Testing.Extensions.CodeCoverage` (for `--coverage`),
in place of the VSTest pieces `xunit.runner.visualstudio` and `coverlet.collector`.
Done when `grep -rE 'xunit.runner.visualstudio|coverlet.collector' --include='*.csproj' --include='*.props' .` finds nothing and `dotnet test` passes under the new `global.json`.
Under central package management with transitive pinning, raise any `Microsoft.Testing.*` pin below what `xunit.v3.mtp-v2` needs, or restore fails with NU1109 (IssueManager went from 2.3.3 to 2.4.0).

## Warnings as errors

`scripts/gate.sh` and `ci.yml` build with MSBuild's `-warnaserror` switch, which promotes every warning, analyzer warnings included.
`CodeAnalysisTreatWarningsAsErrors=false` keeps CA warnings out of the `TreatWarningsAsErrors` property's reach, not out of the switch's:
with it set, IssueManager's `AnalysisMode=all` still turned 1,488 CA warnings (CA1707, CA2007, …) into a failed build.
Before Apply, build with `-warnaserror` to count them. Then fix them, or drop to the default `AnalysisMode` and raise it again in a follow-up.
An Aspire AppHost may also report ASPIRE010 (`AspireUseCliBundle=false`). Set `AspireUseCliBundle` to `true` where the AppHost uses the
Aspire CLI bundle's features; where it doesn't, suppress the warning with `<NoWarn>$(NoWarn);ASPIRE010</NoWarn>`, as TicketManager,
IssueTracker and IssueManager do.

## GitHub settings

- **`github-settings.sh --fix mpaulosky/<repo>`, twice**: while the PR is a draft, and right after it merges ([github-settings.md](github-settings.md)).
  It sets the merge settings, security features, Actions permissions, the `main-rules` ruleset and its required checks, and the labels.
  The first run can't require the checks `main` doesn't report yet (`Branch name`, `PR title`, and `Test Suite` where it's new), and keeps the repo's
  old test gate required meanwhile; the second requires them and drops the old one. Done when `github-settings.sh mpaulosky/<repo>` reports no DRIFT, MANUAL or LEGACY.
  Between the two, the Standardize PR can't merge while the old gate is required, since the new `ci.yml` never reports it: remove it by hand first
  ([github-settings.md](github-settings.md)).
  It deletes `squad*` labels itself; add `--remove-legacy` once its LEGACY list (squad-era rulesets, classic protection) is understood.
  Squad's other labels (Articles' `go:yes`, `go:no`, `go:needs-research`) are left alone: delete them by hand after the merge.
  Until the merge, the old `squad-pr-auto-label` workflow on `main` re-creates `squad` on every PR, the docs-only probe included;
  the second run deletes it again.
- **Secrets.** The script checks `RELEASE_PR_PAT` exists (releases, blog PRs and auto-merge start workflows only with it); add it, and any test secret, by hand.
  The PAT needs **Workflows: Read and write** (fine-grained) or the `workflow` scope (classic), as well as contents and
  pull requests: the Standardize itself changes the workflows, so the next release that tags an older commit (a missed
  release the queue retries, such as a Dependabot PR merged just before) is refused without it. Blazor-Server's first
  release after #127 failed this way.
- **Missing blog posts.** Before merging, check which Releases lack a post, as [release-pipeline.md](release-pipeline.md#adapting) describes.

## Repo docs

The process (hooks, branches, worktrees, commits, PR titles and descriptions, merging, releases) is written once, in the
Owned `docs/PROCESS.md`. Replace the repo's own copies of it in `CLAUDE.md`, `CONTRIBUTING.md` and the README with a link
there, as [pr-process.md](pr-process.md#adapting) lists; that also drops any other worktree convention or branch list.
Move existing worktrees as [git-hooks.md](git-hooks.md#adapting) says.
