# dotfiles

Configuration and support files for quickly bootstrapping .NET projects and developer environments.

> **Purpose:** This repository is a **template and support-file library** — it holds
> reusable configurations, starter projects, shell profiles, CI workflows, and
> documentation templates that can be quickly copied into new repositories.

---

## Repository Structure

```text
BaseNewProject/          Starter template for new .NET Blazor projects
  docs/                  Project-specific docs (PRDs, specs)
Bashrc/                  Linux shell profile templates (.bashrc, .profile)
PowerShell 7/            PowerShell profile template
Posh-Git Themes/         Posh-Git theme files for PowerShell prompt
docs/                    Documentation templates (CONTRIBUTING, SECURITY, etc.)
.devcontainer/           Dev Container definition (.NET 10)
.github/
  instructions/          Copilot instruction files (Blazor, MongoDB DBA)
  workflows/             CI workflows (Squad automation, linting)
  agents/                GitHub Copilot agent definitions
.copilot/                Copilot CLI configuration and skills
.squad/                  Squad AI team orchestration
```

## Quick Start

### Using a Starter Template

1. Copy the `BaseNewProject/` folder contents into your new repository
2. Copy relevant files from `docs/` for project documentation
3. Copy `.github/instructions/copilot-instructions.md` for Copilot guidance
4. Adjust to your project's specifics

### Shell Profiles

- **Bash:** Copy files from `Bashrc/` to your home directory
- **PowerShell:** Copy the profile from `PowerShell 7/` to your PowerShell profile path
- **Posh-Git:** Copy theme files from `Posh-Git Themes/`

### Dev Container

The `.devcontainer/` folder provides a ready-to-use development container targeting
**.NET 10** with Aspire support. Copy it to your project for consistent dev environments.

### Copilot Instructions

Files in `.github/instructions/` are reusable Copilot instruction templates:

| File | Purpose |
|------|---------|
| `copilot-instructions.md` | .NET project coding standards (C# 14, Blazor, MongoDB, testing) |
| `blazor-web-app.instructions.md` | Blazor component and application patterns |
| `mongodb-dba.agent.md` | MongoDB DBA chat mode instructions |

## Adding Sandcastle to a Repo

[Sandcastle](https://www.npmjs.com/package/@ai-hero/sandcastle) runs Claude Code agents in a Docker sandbox. It
picks up open GitHub issues labelled `Sandcastle`, plans them, implements and reviews each one in its own git
worktree, then pushes the branch and opens a pull request that closes the issue. The reference setup is
[Blazor-Server's `.sandcastle/`](https://github.com/mpaulosky/Blazor-Server/tree/main/.sandcastle); copy from it
rather than starting from the stock template.

### 1. Prerequisites

- Docker running on the host, and your user able to run `docker` without `sudo`.
- Node 22 and pnpm (enable it with `corepack enable pnpm`, and pin it with `packageManager` in `package.json`).
- The `gh` CLI, logged in on the host (`gh auth status`). The host uses this auth for every GitHub call.
- Claude Code installed on the host, for `claude setup-token`.
- The repo-ci-baseline applied to the repo (see the `repo-ci-baseline` skill under
  `Support For New Projects/.claude/skills/`). Sandcastle relies on its pre-push hook, `scripts/gate.sh`, the
  `sandcastle:needs-human` label and the auto-merge hand-back hold.

### 2. Install the packages

```bash
pnpm add -D @ai-hero/sandcastle tsx typescript @types/node
pnpm add zod   # the planner templates validate their <plan> output with it
```

### 3. Scaffold `.sandcastle/`

```bash
pnpm exec sandcastle init \
  --agent claude-code --sandbox docker \
  --template parallel-planner-with-review \
  --issue-tracker github-issues --create-label true \
  --build-image false --install-template-deps true
```

`init` refuses to run if `.sandcastle/` already exists. `--create-label true` creates the `Sandcastle` label on
GitHub. Leave the image build until the Dockerfile is adapted (step 4).

Make sure `.sandcastle/.gitignore` ignores the secrets and the run output:

```text
.env
logs/
worktrees/
```

### 4. Adapt the Dockerfile for .NET

The stock image has Node, git, curl, jq and `gh` only. Add what the agents and the gate need (see Blazor-Server's
`.sandcastle/Dockerfile`):

- `libicu72` (needed by .NET), plus `yamllint` and anything else `scripts/gate.sh` calls.
- `RUN corepack enable pnpm` and `ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, before switching to the agent user.
- The .NET SDK through `dotnet-install.sh --version <sdk.version> --install-dir /home/agent/.dotnet`, with the
  exact version from the repo's `global.json`, which satisfies any `rollForward` policy. Blazor-Server uses
  `--channel 10.0`, which works only because its `rollForward` is `latestMinor`. Symlink it into
  `/home/agent/.local/bin`, with `DOTNET_ROOT`, `DOTNET_CLI_TELEMETRY_OPTOUT=1` and `DOTNET_NOLOGO=1` set.
- `/home/agent/.dotnet` and `/home/agent/.dotnet/tools` on `PATH`, so `dotnet` works in login and non-login shells.

Then build the image (it defaults to `sandcastle:<repo-dir-name>` and matches the host's UID/GID):

```bash
pnpm exec sandcastle docker build-image
```

Rebuild it whenever the Dockerfile changes.

### 5. Set up the secrets

`init` writes a blank `GH_TOKEN=` into `.env.example`. Replace the file with Blazor-Server's `.env.example` (Claude
token only) before copying it:

```bash
cp .sandcastle/.env.example .sandcastle/.env
claude setup-token   # paste the token into CLAUDE_CODE_OAUTH_TOKEN in .sandcastle/.env
```

Put only the Claude token (or `ANTHROPIC_API_KEY`) in `.env`. **Don't add `GH_TOKEN` or `GITHUB_TOKEN`**, not even
blank: Sandcastle passes every key in `.env` into the sandbox, filling blanks from the host's environment, which
would hand your GitHub token to the agents. Blazor-Server's `main.mts` refuses to start while either key is there.

### 6. Adapt the prompts

Edit `.sandcastle/plan-prompt.md`, `implement-prompt.md` and `review-prompt.md` for the repo:

- Use the repo's build and test commands (`dotnet build <Solution>.slnx`, the test projects) instead of `npm`.
- Point the agents at `CONTEXT.md`, `docs/adr/` and the coding standards, and have them work test-first.
- Use the repo's commit format, `<type>(<scope>): <Summary>` with `Refs #<id>`.
- Tell the implementer not to push, open a pull request or close the issue; the host does that.
- Have the planner skip issues whose branch already has an open pull request.
- Copy any skills the agents need into the repo's `.claude/skills/`. The sandbox can't see `~/.claude/skills`.

### 7. Adapt the orchestration

The stock template merges into your checked-out branch and closes the issue with no pull request. Replace that
with Blazor-Server's `main.mts` and `lib/` (gate, plan, critique, build, branches, GitHub, config), plus the
`critique-prompt.md` and `roles/` that `lib/` loads. Adapt those two as in step 6: `roles/shared-rules.md` goes
into every role's prompt and names Blazor-Server's solution, gate and commit rules. The orchestration:

- Hold back issues whose blockers haven't landed or that already have an open pull request.
- Run `scripts/gate.sh` in the sandbox after the implementer and again after the reviewer, with a gate-fixer
  role for a red gate, and comment on the issue when it still fails.
- Record the commit that passed in `git config sandcastle.gatedHead`, so the pre-push hook doesn't run the gate a
  second time.
- Push each branch from its own worktree (the pre-push hook refuses a commit other than the checkout's `HEAD`,
  since its gate tests the working tree) and open a pull request that says `Closes #<id>`.

Set each role's model, effort and budget in `lib/config.mts` (`ROLE_AGENTS`), and keep the
`onSandboxReady` hook (`pnpm install --frozen-lockfile --config.confirm-modules-purge=false`) and
`copyToWorktree = ["node_modules"]`.

### 8. Gate the Sandcastle code

Add a `tsconfig.json` to `.sandcastle/` (strict, `nodenext`, excluding `worktrees` and `logs`) and a script to
`package.json`:

```json
"scripts": {
  "check:sandcastle": "tsc --noEmit -p .sandcastle && tsx --test \".sandcastle/**/*.test.mts\""
}
```

Run it from `.github/ci/gate-checks.sh` (the repo's own Seed file, which `scripts/gate.sh` calls) when the
Sandcastle files change:

```bash
if ! git diff --quiet "$base" HEAD -- .sandcastle package.json ':(glob)pnpm-*.yaml'; then
  pnpm run check:sandcastle
fi
```

### 9. Configure GitHub

- Run `github-settings.sh --fix mpaulosky/<repo>` from the repo-ci-baseline skill to create the
  `sandcastle:needs-human` label and the rest of the standard settings.
- If Sandcastle gets its own required check, add it to `github/repos/<repo>.json` in that skill.

### 10. Run it

```bash
pnpm exec tsx .sandcastle/main.mts
```

Label the issues you want worked `Sandcastle`. Each round prints the issues it holds back, the branches it works
and the pull requests it opens, and stops when a round opens no pull request. A red gate gets a comment on the
issue and no pull request. A failed review still opens one, flagged as unreviewed in its body, if the second
gate passes. Sandcastle doesn't label anything `sandcastle:needs-human`: add it to hand a pull request to a
person, and it won't auto-merge until the owner removes it.

Finally, mention `.sandcastle/` and the `check:sandcastle` command in the repo's `README.md` and `CLAUDE.md`.

## Documentation Templates

The `docs/` folder contains **template documentation** meant to be copied into other projects:

- `CONTRIBUTING.md` — contribution guidelines template
- `SECURITY.md` — security policy template
- `REFERENCES.md` — project references template
- `CODE_OF_CONDUCT.md` — code of conduct template

> **Note:** These are templates — do not modify them for this repository specifically.

## Squad AI Team

This repository uses [Squad](https://github.com/bradygaster/squad-cli) for AI-assisted
development orchestration. See `.squad/team.md` for the current team roster.

## License

See [LICENSE](LICENSE) for details.
