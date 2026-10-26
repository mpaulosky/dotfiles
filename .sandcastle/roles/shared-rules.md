# Shared role rules

## The repo

dotfiles holds the owner's machine configuration and the repo-ci-baseline skill, whose Template every other repo copies its CI, release and git-hook files from. Most issues change
the Template. `<skill>` below is `Support For New Projects/.claude/skills/repo-ci-baseline`; quote the path in shell commands, since it has spaces.

- `<skill>/SKILL.md`, `<skill>/CONTEXT.md` (the domain language: Baseline, Template, Owned file, Seed file, Apply), `<skill>/references/` and `<skill>/docs/adr/` describe the
  Template and the decisions behind it.
- The Template's files are under `<skill>/template/owned/` (Owned: Apply always overwrites a repo's copy) and `<skill>/template/seed/` (Seed: written only when a repo has none).
- dotfiles carries copies of some Owned files at the repo root: `.github/workflows/claude-review.yml`, `.github/workflows/pr-automerge.yml`,
  `.github/workflows/pr-review-submitted.yml`, `.github/workflows/sandcastle.yml`,
  `.github/scripts/post_claude_review.py`, `.github/hooks/*`, `scripts/check-branch-name.sh` and the Owned files under `.sandcastle/`.
  Edit the Template's file, then copy it over the root copy, mode included. The gate fails when a copy differs from the Template's.
- An Owned file is copied into other repos, where a bare `#N` reads as that repo's own issue. Write `mpaulosky/dotfiles#N` (or `<Repo>#N` for another repo's) in Owned files.
- dotfiles' own `scripts/gate.sh` and `.github/workflows/repo-ci-baseline.yml` belong to dotfiles, not the Template.

## Build and tests

Nothing is compiled. Use the test command for each stack the issue touches:

| Stack | Where | Run tests |
| --- | --- | --- |
| Workflow inline scripts (JavaScript) | the `script: \|` of `<skill>/template/owned/.github/workflows/pr-automerge.yml` | `node --test "<skill>/template/owned/.github/scripts/tests/pr-automerge.test.mjs"` |
| Python scripts and workflow `run:` steps (pytest) | `<skill>/template/owned/.github/scripts/`, `<skill>/github/`, `<skill>/bench/` | `python3 -m pytest -q -p no:cacheprovider <tests dir>`, from `<skill>/template/owned` for `.github/scripts/tests`, from `<skill>` for `github/tests` and `bench/tests` |
| Hooks and shell scripts (bash test scripts) | `<skill>/template/owned/.github/hooks/`, `<skill>/template/owned/scripts/`, `<skill>/*.sh` | the `<name>.test.sh` in the `tests/` folder beside the script, run with `bash` |
| Workflows (YAML) | `<skill>/template/owned/.github/workflows/` | `actionlint <file>`, `zizmor --offline --min-severity medium <file>`, `yamllint -c "<skill>/template/owned/.yamllint.yml" <file>` |
| Sandcastle's TypeScript | `.sandcastle/`, `package.json` | `pnpm exec tsc --noEmit -p .sandcastle`, then `pnpm exec tsx --test <file>.test.mts` |
| pnpm workspace | `package.json`, `pnpm-workspace.yaml` | run `pnpm install` after changing `package.json`, and commit `pnpm-lock.yaml` in the same commit |

- The tests read a workflow's inline script or `run:` step out of the YAML and run it against fakes or scratch git repos, so they cover exactly the code the workflow runs. Follow
  the existing tests' helpers rather than copying code out of the workflow.
- Tests must pass by the end of the last developer run, not on every commit.
- Shell scripts pass `shellcheck`. The standards for `.sandcastle/` are in `.claude/rules/sandcastle.md`.

## The gate

`scripts/gate.sh` is the one definition of "ready to push". It runs `<skill>/test.sh` (every Template test, the linters, the copy check and the apply and reapply smoke tests),
then the Sandcastle check when `.sandcastle/`, `package.json` or the pnpm lockfile changed. Run it rather than the individual lint and test commands.

- If you committed anything, run `scripts/gate.sh` once as your last step, before `<promise>COMPLETE</promise>`, and fix what it reports.
- The tester is exempt, because its tests are red on purpose. It still lints the files it changed.
- The architect is exempt too. It commits at most one ADR, and lints that file with `markdownlint-cli2 <file>`.
- After you finish, the host runs the gate itself. Its exit code decides whether the branch is published, not what you report.
- Leave the worktree clean: commit or discard every change before you finish. Only commits are pushed, so the host fails the gate when anything is left uncommitted.

## Commits

Commit in small steps. Each message follows the repo's conventional-commit style:

- Subject: `<type>(<scope>): <Summary>`, with the scope `baseline` for the Template, `sandcastle` for `.sandcastle/` and the folder's name otherwise, for example
  `fix(baseline): Give a notice when PR Auto-Merge won't put review:claude back`
- Body: what changed and why, key decisions, and any blockers for the next run
- Footer: `Refs #<issue number>`

## GitHub

Never push, never run `gh`, and never write to GitHub. The sandbox has no GitHub token. The host publishes the branch and does every GitHub write.
