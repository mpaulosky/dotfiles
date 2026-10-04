# Adapt

The work after Apply, in commits on top of the Apply commit.
Done when every item below is resolved for this repo and `scripts/gate.sh` passes locally.

## From the report

- **Drift.** For each overwritten Owned file, read what the Apply commit removed (`git show HEAD -- <file>`).
  Drift goes.
  A real local fix stops the Standardize: move it into the Template first (a dotfiles PR, `test.sh` green), then re-Apply.
  Known in advance: TicketManager's and IssueManager's `pr-automerge.yml` call a tested `automerge-decision.mjs` the Template lacks; move that into the Template before TicketManager's turn.
- **Seed files skipped.** Diff each against `template/seed/` and bring over what the repo lacks.
  The repo's version wins on content.
- **Seed files written.** Check each against what the repo had before: `.github/ci/coverage-threshold` defaults to 80, so set it to the gate the old `ci.yml` enforced (IssueTracker's was 60).
- **Ignores only this repo needs**, such as atelier-store's generated `wwwroot/app.css`, go in a `.gitignore` beside them (`src/AtelierStore.Web/.gitignore`).
  The root `.gitignore` is Owned, so a line added there is reverted by the next Apply.
- **Unfilled placeholders.** Fill each `{{...}}` by hand.
- **Leftovers.** Delete `sync-readme.yml` (`release_post.py` already maintains `docs/README.md`) and `label-enforce.yml` (squad's triage labels).
  Keep repo features such as `generate-blog-posts-json.yml`, and check each kept workflow still passes actionlint and zizmor.
- **Conflicts.** Delete any `.markdownlint.json`; its `{"default": false}` turned Markdown lint off.
  Run `markdownlint-cli2 --fix '**/*.md'`, then fix the rest by hand.
  TicketManager had 263 issues and IssueManager 1036.

## Per-repo CI setup

Move whatever the old `ci.yml` did for this repo alone into `.github/ci/prepare.sh` (`build`, or `test <name>`):

- Tools the build runs: atelier-store's Tailwind build needs pnpm, so `corepack enable` (pnpm's version comes from `packageManager` in `package.json`).
- Test fixtures: IssueTracker's `AppHost.Tests` needs the UI published and the Mongo and Redis images pulled, plus `ConnectionStrings__mongodb=mongodb://localhost:27017` appended to `$GITHUB_ENV`.
- Secrets: `ci.yml` passes only `MONGODB_CONNECTION_STRING` (as `MongoDB__ConnectionString`).
  A repo that needs another secret needs it in the Template's `ci.yml` first.

## Test runner

`global.json` puts `dotnet test` on Microsoft Testing Platform.
Every test project must run on it, as atelier-store's and TicketManager's do: `xunit.v3.mtp-v2` plus `Microsoft.Testing.Extensions.CodeCoverage` (for `--coverage`),
in place of the VSTest pieces `xunit.runner.visualstudio` and `coverlet.collector`.
Done when `grep -rE 'xunit.runner.visualstudio|coverlet.collector' --include='*.csproj' --include='*.props' .` finds nothing and `dotnet test` passes under the new `global.json`.

## GitHub settings

- **Required checks.** The ruleset must require checks that exist: `Build Solution` and `Test Suite` (atelier-store's was `Test Report Summary`).
  Read them with `gh api repos/<r>/rulesets`, and update them in the same sitting as the merge, or the PR can't merge (old name missing) or merges unchecked (new name not required).
- **Labels.** `semver:minor` and `semver:major`; see [gotchas.md](gotchas.md#repo-drift).
- **Secrets.** `RELEASE_PR_PAT` (releases, blog PRs and auto-merge start workflows only with it), and any test secret.
- **Missing blog posts.** Before merging, check which Releases lack a post, as [release-pipeline.md](release-pipeline.md#adapting) describes.

## Repo docs

Point `README.md` or `CONTRIBUTING.md` at the one-time `git config core.hooksPath .github/hooks`,
and list the branch standard from [git-hooks.md](git-hooks.md) wherever the repo lists branch names (`CLAUDE.md`, `CONTRIBUTING.md`).
