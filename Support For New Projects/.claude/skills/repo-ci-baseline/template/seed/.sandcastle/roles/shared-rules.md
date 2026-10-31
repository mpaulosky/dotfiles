# Shared role rules

## The repo

{{REPO}} is the .NET solution `{{SOLUTION}}.slnx`, set up from the Baseline Template. Replace this paragraph with what the repo is for, its projects under `src/` and `tests/`,
and anything every role must know before changing it.

- `CLAUDE.md` says how the repo is built and laid out, `docs/PROCESS.md` how a change reaches `main`, and `docs/adr/` (where present) the decisions behind it.
- `.sandcastle/CODING_STANDARDS.md` holds the code standards every role follows.
- The Baseline Template owns some files: Apply overwrites them, so a change to one here is undone by the next re-Apply. They include `scripts/gate.sh`, the workflows and
  scripts under `.github/`, `.github/hooks/`, `.github/instructions/` and `docs/PROCESS.md`. Don't change them; say in your commit body when an issue needs one changed.

## Build and tests

Use the commands for each stack the issue touches:

| Stack | Where | Build | Run tests |
| --- | --- | --- | --- |
| C# | `src/`, `tests/` | `dotnet build {{SOLUTION}}.slnx` | `dotnet test <test project>` |
| Sandcastle's TypeScript | `.sandcastle/`, `package.json` | `pnpm exec tsc --noEmit -p .sandcastle` | `pnpm exec tsx --test <file>.test.mts` |
| pnpm workspace | `package.json`, `pnpm-workspace.yaml` | run `pnpm install` after changing `package.json` | commit `pnpm-lock.yaml` in the same commit |

- Tests must pass by the end of the last developer run, not on every commit.
- A test that needs a string shaped like a secret (a GitHub token, an API key) builds it at run time, splitting the prefix from the body: `` `${"gh"}p_${"A".repeat(36)}` ``.
  Never write the whole shape in a source line, a fixture or a comment. The host scans every commit's added lines, and a match stops the issue from being published.
  A later commit does not clear it, because the scan reads each commit.
- Shell scripts pass `shellcheck`. The code standards are in `.sandcastle/CODING_STANDARDS.md`.

## The gate

`scripts/gate.sh` is the one definition of "ready to push". It lints the Markdown, YAML, workflow and shell files the branch changed, runs the repo's own checks in
`.github/ci/gate-checks.sh` (Sandcastle's check among them, when `.sandcastle/` or its packages changed), builds the solution with warnings as errors, then runs every test
project. Run it rather than the individual lint and test commands.

- If you committed anything, run `scripts/gate.sh` once as your last step, before `<promise>COMPLETE</promise>`, and fix what it reports.
- The tester is exempt, because its tests are red on purpose. It still lints the files it changed.
- The architect is exempt too. It commits at most one ADR, and lints that file with `markdownlint-cli2 <file>`.
- After you finish, the host runs the gate itself. Its exit code decides whether the branch is published, not what you report.
- Leave the worktree clean: commit or discard every change before you finish. Only commits are pushed, so the host fails the gate when anything is left uncommitted.

## Commits

Commit in small steps. Each message follows `.github/instructions/git-commit-instructions.md`:

- Subject: `<type>(<scope>): <Summary>`, imperative, with a capital and no closing period, for example `fix(api): Return 404 for an order that doesn't exist`
- Body: what changed and why, key decisions, and any blockers for the next run
- Footer: `Refs #<issue number>`

## GitHub

Never push, never run `gh`, and never write to GitHub. The sandbox has no GitHub token. The host publishes the branch and does every GitHub write.
