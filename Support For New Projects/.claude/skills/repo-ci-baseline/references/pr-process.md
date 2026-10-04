# PR process

Template files (Owned): `docs/PROCESS.md`, `.github/pull_request_template.md`, `.github/workflows/pr-title.yml`,
`scripts/check-pr-title.sh` and its test, and the PR-title section of `.github/instructions/git-commit-instructions.md`.
Seed: `docs/CONTRIBUTING.md` (links to `PROCESS.md`) and `.github/dependabot.yml` (`commit-message`). History: the
2026-10-04 survey of the seven repos, and the grilling that settled one process ([ADR 0003](../docs/adr/0003-github-settings-as-code.md)).

## What it guarantees

- **One written process, the same in every repo.** `docs/PROCESS.md` is Owned, so the next Apply refreshes it everywhere;
  `CONTRIBUTING.md` and `CLAUDE.md` link to it rather than repeat it. Before, each repo's CONTRIBUTING said something
  different (Articles still documented `squad/` branches, and the Seed said maintainers approve and merge, contradicting
  auto-merge), and a Seed is never refreshed.
- **PR titles follow the commit format.** The title is the squash commit's subject and the Release's name. The survey
  found lowercase titles in four repos, so the format is a required check (**PR title**), not a guideline.
- **PR descriptions share one shape.** The template's headings are Why, What changed and Verification, and `Fixes #`.
  It has no hidden comment: GitHub copies the description into the squash commit message, so a comment would land in
  every commit on `main` and in the blog post. `PROCESS.md` says instead that the description is published.

## Design

- **`pr-title.yml`** is its own workflow, so editing a title reruns only it, not the build. It runs on `opened`,
  `edited`, `synchronize` (so the check reports on every head), `reopened` and `ready_for_review`. PR Auto-Merge lists
  it under `workflow_run`, so a fixed title re-checks the merge.
- **`check-pr-title.sh`**: `<type>(<scope>): <Summary>` with the types from `git-commit-instructions.md`, an optional
  non-empty scope and `!`, a summary that doesn't start with a lowercase letter, and no closing period. Length isn't
  checked: the commit rules' 72 characters is guidance, and titles carry markers such as `[skip-release]`.
- **Dependabot is exempt**: its titles can't be edited to the format, so the job is skipped (a skipped required check
  passes). The Seed `dependabot.yml` still gives its commits a `chore(deps)` prefix, so `main`'s history stays
  conventional.
- **Titles the Template writes itself** (`release.yml`'s and `backfill-blog-posts.yml`'s blog PRs) are capitalized, so
  they pass.
- **Duplicate commit rules** (`.copilot-commit-message-instructions.md`, `.claude/rules/git-commit.md`) are an `apply.sh`
  conflict: a second copy drifted in IssueManager and Articles, where it wasn't even conventional commits.

## Tests

`scripts/tests/check-pr-title.test.sh` covers allowed titles (a scope, `!`, a marker, a leading non-letter) and refused
ones (no type, a lowercase summary, a closing period, an unknown type, no space, an empty scope, Dependabot's lowercase
form, an empty title). CI's hook-tests job and `test.sh` run it. `apply.test.sh` covers the duplicate-rules conflict.

## Adapting

- **`CLAUDE.md`:** replace any process text (branches, worktrees, commits, PRs, merging) with a link to
  `docs/PROCESS.md`. Keep the repo's own instructions.
- **`CONTRIBUTING.md`:** the same; its Quick Start and Review Process point at `PROCESS.md`, as the Seed's do.
- **Delete** `.copilot-commit-message-instructions.md` and `.claude/rules/git-commit.md` when `apply.sh` reports them.
- **`dependabot.yml`:** add the Seed's `commit-message` block to each ecosystem.
- Then `github-settings.sh --fix` after the merge adds `PR title` to the required checks.

## Verify live

Open a PR titled `fix: lowercase summary`: **PR title** fails. Edit the title to `fix: Lowercase summary`: it passes
without the build rerunning, and PR Auto-Merge re-checks the PR when it completes.
