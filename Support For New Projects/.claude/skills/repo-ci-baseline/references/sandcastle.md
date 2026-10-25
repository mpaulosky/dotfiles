# Sandcastle

Sandcastle is the unattended agent pipeline that builds a repo's issues in a sandbox (`.sandcastle/`, TypeScript run with `tsx`).
Seven repos carry one, in two generations, and their settings had drifted.
The Template's Sandcastle section gives them one shared set of config, prompts and guardrails, split by the Template's usual rule
([ADR 0006](../docs/adr/0006-sandcastle-section-of-the-template.md)): a file with no per-repo value is Owned, anything else is Seed.

## What it guarantees

- Every Sandcastle repo type-checks with the same `tsconfig.json`, lints its prompts with the same rules, ignores the same run output, and documents the same `.env` settings.
- The intake and critique prompts, and the host-safety guardrails (`lib/host-safety.mts`, `lib/shell.mts`), are identical everywhere.
- A new repo starts from the same role prompts, Dockerfile, check and `package.json` scripts (`sandcastle` and `check:sandcastle`, on `tsx`, with `tsc --noEmit`).

## Owned files

Under `template/owned/.sandcastle/`. dotfiles' own `.sandcastle/` carries each one as a copy, and `test.sh` fails when a copy differs.

| File | Why it's Owned |
| --- | --- |
| `tsconfig.json` | The compiler settings `check:sandcastle` runs with; nothing in it names the repo |
| `.markdownlint-cli2.jsonc` | Merged with the root config: lets the prompts use a heading per section and HTML tags |
| `.gitignore` | Keeps `.env` and a run's `logs/`, `worktrees/`, `work/` and `follow-up.json` out of git; the older repos lacked the last two |
| `.env.example` | The settings Sandcastle reads, documented once; five variants had grown |
| `intake-prompt.md`, `critique-prompt.md` | Judge an issue or a plan against the issue alone, with no repo-specific text |
| `lib/host-safety.mts`, `lib/shell.mts` and their tests | The guardrails that keep agent-written code off the host; they import only each other, so a repo's own code can't break them |

Under `.sandcastle/`, the no-placeholders check refuses only Apply's `{{OWNER}}`, `{{REPO}}` and `{{SOLUTION}}`:
Sandcastle fills its own `{{NAME}}`s (`{{ISSUES_JSON}}`, `{{SHARED_RULES}}` and the rest) when it runs a prompt.

## Seed files

Under `template/seed/`. Each one describes the repo, so it's the repo's once written.

| File | What the repo fills in |
| --- | --- |
| `.sandcastle/roles/*.md` (`architect`, `backend`, `tester`, `scribe`, `gate-fixer`, `follow-up`) | Anything its roles do differently |
| `.sandcastle/roles/shared-rules.md` | The repo's paragraph, its stacks and test commands; the one file every role reads about the repo |
| `.sandcastle/plan-prompt.md`, `.sandcastle/review-prompt.md` | The optional roles' rules and the docs the review follows |
| `.sandcastle/CODING_STANDARDS.md` | The repo's code and test standards, which every role and the review follow |
| `.sandcastle/Dockerfile` | The sandbox image: the gate's linters as `ARG`s with their SHA-256s, and an optional .NET SDK (`INSTALL_DOTNET`, `DOTNET_CHANNEL`) |
| `.sandcastle/check.sh` | Sandcastle's check, which the Seed `.github/ci/gate-checks.sh` runs when it's there |
| `package.json`, `pnpm-workspace.yaml` | Sandcastle's packages and scripts; a repo with its own Node tooling merges them |

The prompts keep every Sandcastle `{{NAME}}` dotfiles' copies have (`lib/role-prompts.test.mts` checks).
`test.sh` keeps dotfiles' own text out of them, and checks that the Dockerfile's linter versions match the Owned `scripts/gate.sh` and its .NET channel matches `global.json`.
There is no `roles/ui.md`: nothing in the Template's files picks that role.

## When Apply adds it

Only to a repo that has a `.sandcastle/` folder, or no commits yet.
In any other repo, Apply leaves out every file under `.sandcastle/`, plus `package.json` and `pnpm-workspace.yaml`, and its report counts them as
"Sandcastle files left out". A repo starts using Sandcastle by creating `.sandcastle/` and Applying again.

## What isn't in it

- **The rest of `lib/` and `main.mts`.** Almost every module imports `lib/config.mts`, which holds per-repo values (labels, root copies, role models).
  They come in once `config.mts` is split into an Owned and a Seed part. Until then, a new repo copies `main.mts` and the rest of `lib/` by hand,
  and `pnpm run sandcastle` fails without them.
- **`.github/workflows/sandcastle*.yml`.** Sandcastle's Actions token can't push a workflow change, so each repo keeps its own.
  To add the workflow to the Template later, file the issue with the `Sandcastle:local` label.

## Migrating a repo

One PR per repo, each its own follow-up issue. The four older repos go first (Articles, IssueManager, IssueTracker, TicketManager), then Blazor-Server and auth0-management-app.

1. Run `apply.sh --dry-run <repo>`. Each `.sandcastle/` Owned file it would overwrite is drift.
   Diff it before dropping it: another repo's `host-safety.mts` may be newer than the Template's, and a real fix moves into the Template first (Template first).
2. Rename the `test:sandcastle` script to `check:sandcastle`, run it with `tsx`, and add `tsc --noEmit`.
3. Diff the repo's role prompts, `Dockerfile` and `package.json` against the Template's Seed files, and bring over what the repo lacks.
4. Run `pnpm install`, then commit `pnpm-lock.yaml` with the change.
5. Leave the older repos' `claude-opus-4-8` pin and missing `ROLE_AGENTS` map alone: they live in the repo's own code, so they're that repo's follow-up.
6. Leave the Sandcastle workflows out of the re-Apply.
