# Sandcastle

Sandcastle is the unattended agent pipeline that builds a repo's issues in a sandbox (`.sandcastle/`, TypeScript run with `tsx`).
Seven repos carry one, in two generations, and their settings had drifted.
The Template's Sandcastle section gives them one shared set of code, config, prompts and guardrails, split by the Template's usual rule
([ADR 0006](../docs/adr/0006-sandcastle-section-of-the-template.md)): a file with no per-repo value is Owned, anything else is Seed.
The pipeline's per-repo values sit in one Seed file, `lib/repo-config.mts`, so the rest of its code is Owned
([ADR 0007](../docs/adr/0007-sandcastle-code-is-owned-with-a-seed-repo-config.md)).

## What it guarantees

- Every Sandcastle repo type-checks with the same `tsconfig.json`, lints its prompts with the same rules, ignores the same run output, and documents the same `.env` settings.
- The pipeline's code (`main.mts` and every `lib/` module but `repo-config.mts`), the intake and critique prompts, and the host-safety
  guardrails (`lib/host-safety.mts`, `lib/shell.mts`) are identical everywhere.
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
| `main.mts` | The run's phases and round loop; it reads its round cap from `lib/repo-config.mts` |
| `lib/config.mts` and its test | What every Sandcastle repo shares: the role names (`ROLES`, plus the opt-in `ui` as `OptInRole`), limits, labels, markers, the Copilot reviewer settings, and the queue-scope and budget parsing |
| The other `lib/` modules and their tests, `lib/errors.mts`, `lib/git-sandbox-fake.mts` and `lib/ui-role-fixture.mts` (the test helper for the opt-in `ui` role) | They import each other as one cluster, so they're Owned together; their tests pin no per-repo value |

The Owned modules read only the names `lib/repo-config.mts` exports (below), and `config.mts` imports nothing from it.
A change to an Owned module that reads a new name breaks every repo until it adds that name, and `tsc --noEmit` reports it in the repo's own check.

Outside `.sandcastle/`, the Owned Sandcastle section also has `.github/workflows/sandcastle.yml` ([The workflow](#the-workflow)), a root copy in dotfiles like the rest.

Under `.sandcastle/`, the no-placeholders check refuses only Apply's `{{OWNER}}`, `{{REPO}}` and `{{SOLUTION}}`:
Sandcastle fills its own `{{NAME}}`s (`{{ISSUES_JSON}}`, `{{SHARED_RULES}}` and the rest) when it runs a prompt.

## Seed files

Under `template/seed/`. Each one describes the repo, so it's the repo's once written.

| File | What the repo fills in |
| --- | --- |
| `.sandcastle/roles/*.md` (`architect`, `backend`, `tester`, `scribe`, `gate-fixer`, `follow-up`, and `ui`, which stays unused until the repo opts in) | Anything its roles do differently |
| `.sandcastle/roles/shared-rules.md` | The repo's paragraph, its stacks and test commands; the one file every role reads about the repo |
| `.sandcastle/plan-prompt.md`, `.sandcastle/review-prompt.md` | The optional roles' rules and the docs the review follows |
| `.sandcastle/CODING_STANDARDS.md` | The repo's code and test standards, which every role and the review follow |
| `.sandcastle/Dockerfile` | The sandbox image: the gate's linters as `ARG`s with their SHA-256s, and an optional .NET SDK (`INSTALL_DOTNET`, `DOTNET_CHANNEL`) |
| `.sandcastle/check.sh` | Sandcastle's check, which the Seed `.github/ci/gate-checks.sh` runs when it's there |
| `package.json`, `pnpm-workspace.yaml` | Sandcastle's packages and scripts; a repo with its own Node tooling merges them |
| `.github/ci/sandcastle-prepare.sh` | The repo's own setup for the Sandcastle workflow's run, such as the skills it mounts; does nothing until filled ([The workflow](#the-workflow)) |
| `.sandcastle/lib/repo-config.mts` | `REPO_SLUG` and `NOT_OWNED_BASELINE_PATHS` for the local review ([pre-push-review.md](pre-push-review.md)), `ROLE_AGENTS` (each role's model, effort, iterations and timeout), `MAX_ITERATIONS`, the sandbox `hooks`, `copyToWorktree`, the host skills to mount (`SANDBOX_SKILLS`), the CI jobs `scripts/gate.sh` reproduces (`GATE_COVERED_CHECKS`, `Build Solution` in the Seed), the command the host runs as the gate in the sandbox (`GATE_COMMAND`, `scripts/gate.sh` in the Seed), the committed file it runs, which a branch may not change (`GATE_SCRIPT`), the paths whose changed files a PR's body lists for the reviewer (`CHECK_PATHS`), and `TEMPLATE_OWNED_DIR` and `TEMPLATE_ROOT_COPIES`, empty except in dotfiles |

The prompts keep every Sandcastle `{{NAME}}` dotfiles' copies have (`lib/role-prompts.test.mts` checks).
`test.sh` keeps dotfiles' own text out of them, and checks that the Dockerfile's linter versions match the Owned `scripts/gate.sh` and its .NET channel matches `global.json`.
`roles/ui.md` is the UI developer's prompt, the one role a repo opts into. Apply writes it into every repo that gets `.sandcastle/`, where it stays unused. To opt in, add a `ui` entry to
`ROLE_AGENTS` in `lib/repo-config.mts` (the Seed carries it commented out) and add this bullet to `plan-prompt.md`'s ROLES list, so the planner can pick the role:
`` - `ui`: the issue adds or changes Blazor components or pages (`.razor` files, their code-behind, layout or styling). Leave it out when the issue changes no markup. ``
`config.test.mts` fails when a repo has the entry but lacks `roles/ui.md`, `backend.md`'s `{{UI_DEVELOPER}}` or that bullet.
`ui` is not in `ROLES`, so a `repo-config.mts` written before it existed still type-checks; without the entry
`lib/agents.mts#uiEnabled` is false, and the planner's `ui` pick and the fallback "every optional role" both leave it out.
With it, the role runs after the backend developer,
and `backend.md`'s `{{UI_DEVELOPER}}` tells the backend developer to leave the Blazor components and pages to it.

**Skills.** `SANDBOX_SKILLS` in `lib/repo-config.mts` names the host skills the sandbox mounts read-only from `~/.claude/skills` (a name the host lacks is logged and skipped).
It is empty in the Seed: a Seed prompt can't promise a skill a host may lack, and not every repo is .NET. A .NET repo opts in by listing the skills there:

```ts
export const SANDBOX_SKILLS: readonly string[] = [
  "dotnet-tdd", "dotnet-add-testing", "dotnet-xunit", "dotnet-testing-strategy", "dotnet-project-analysis", "dotnet-inspect",
];
```

and by adding this section to the `tester`, `backend` and `ui` prompts (before `# EXECUTION`), one bullet for each skill:

```markdown
# SKILLS

For .NET work, these skills are mounted into the sandbox from the host's `~/.claude/skills/`. Use them where they apply:

- `dotnet-tdd`: the red-green-refactor loop with xUnit v3
- `dotnet-add-testing`: scaffolding a new test project
- `dotnet-xunit`: xUnit v3 conventions
- `dotnet-testing-strategy`: choosing unit, integration, or E2E tests
- `dotnet-project-analysis`: solution, project, and Central Package Management wiring
- `dotnet-inspect`: checking a NuGet package's API surface
```

Other roles may list the skills they need the same way. `lib/skills.test.mts` keeps the two in step: no prompt lists a skill that isn't mounted, and the `tester`, `backend`
and (when opted in) `ui` prompts each list every mounted skill.

## When Apply adds it

Only to a repo that has a `.sandcastle/` folder, or no commits yet.
In any other repo, Apply leaves out every file under `.sandcastle/`, plus `package.json`, `pnpm-workspace.yaml`, the Sandcastle workflow,
`.github/ci/sandcastle-prepare.sh` and the local review's files ([pre-push-review.md](pre-push-review.md)), and its report counts them as
"Sandcastle files left out". A repo starts using Sandcastle by creating `.sandcastle/` and Applying again.

## What isn't in it

- **dotfiles' own tests:** `lib/repo-config.test.mts` (dotfiles' per-repo values and root copies), `lib/template.test.mts` (type-checks the
  Template's `.sandcastle/` as Apply writes it and runs its Owned tests there), `lib/dockerfile.test.mts`, `lib/role-prompts.test.mts`,
  `lib/owned-paths.test.mts` (keeps `OWNED_PATHS` in `lib/review-ledger.mts` equal to `template/owned/`) and `main.test.mts`, which read dotfiles' own files.
- **Other `.github/workflows/sandcastle*.yml` files.** Only `sandcastle.yml` is the Template's (below); a repo's own extra Sandcastle workflow stays its own.

## The workflow

`.github/workflows/sandcastle.yml` is Owned ([ADR 0009](../docs/adr/0009-sandcastle-workflow-is-owned.md)): it runs the host unattended on a schedule and on the events that
start a follow-up, and Sandcastle can't change it (its token has no Workflows permission), so a change comes from a Template PR and reaches the repos by re-Apply.
Apply writes it, and `.github/ci/sandcastle-prepare.sh`, only into a repo that runs Sandcastle (it has a `.sandcastle/` folder, or is new).

- **A repo opts in with the `SANDCASTLE_GH_TOKEN` secret** (a fine-grained PAT with Contents, Issues, Pull requests and Actions read and write, and no Workflows permission),
  and a Claude credential (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`). Without the token every step but the first is skipped, so a repo that runs Sandcastle only
  locally gets a green run with a notice on every trigger the job's `if:` lets through, not a failure every two hours. With the token but no Claude credential the run fails.
- **`.github/ci/sandcastle-prepare.sh` is the repo's own setup (Seed).** It runs on the runner after the checkout and before git holds the PAT, with none of the
  workflow's secrets in its environment. The Seed does nothing. A .NET repo that mounts the `dotnet-*` skills puts here the step that fetches them from the dotfiles
  repository at a pinned commit, as Blazor-Server's workflow did, since a hosted runner has no `~/.claude/skills`.
- **The CI workflows it follows are listed by name** (`workflow_run` can't read a variable): `Build and Test Suite` (the Template's `ci.yml`),
  `repo-ci-baseline Template` (the workflow that tests the Template, in dotfiles) and `Claude Review`. A name the repo lacks matches nothing.
- **A repo with its own `sandcastle.yml`** drops it from `NOT_OWNED_BASELINE_PATHS` in its re-Apply and moves anything repo-specific into `sandcastle-prepare.sh`.
  The Template's workflow reads no repository variable, so a variable the old one read (auth0-management-app's follow-up switches) does nothing after the re-Apply.
  A repo whose own workflow has triggers the Template lacks (auth0-management-app's follow-up-only and hand-off ones, mpaulosky/dotfiles#313 and #314) keeps its file in
  `NOT_OWNED_BASELINE_PATHS` until those land, or its re-Apply drops them.
- **The prepare script can change what later steps trust.** It runs outside the sandbox, so what it writes to `GITHUB_ENV`, `GITHUB_PATH` or the global git config reaches the steps
  that hold the PAT and the Claude credential. Pin what it fetches, never write to those, and have a person review every change to it.

## Migrating a repo

One PR per repo, each its own follow-up issue. The four older repos go first (Articles, IssueManager, IssueTracker, TicketManager), then Blazor-Server and auth0-management-app.

1. Run `apply.sh --dry-run <repo>`. Each `.sandcastle/` Owned file it would overwrite is drift.
   Diff it before dropping it: another repo's `host-safety.mts` may be newer than the Template's, and a real fix moves into the Template before the re-Apply (Template first).
   Before dropping the old `lib/config.mts`, move its role models (`ROLE_AGENTS`), `MAX_ITERATIONS`, `hooks` and `copyToWorktree`,
   the `SANDBOX_SKILLS` from `lib/skills.mts` and the `GATE_COVERED_CHECKS` from `lib/follow-up-pass.mts` into `lib/repo-config.mts`.
2. Rename the `test:sandcastle` script to `check:sandcastle`, run it with `tsx`, and add `tsc --noEmit`.
3. Diff the repo's role prompts, `Dockerfile` and `package.json` against the Template's Seed files, and bring over what the repo lacks.
4. Run `pnpm install`, then commit `pnpm-lock.yaml` with the change.
5. Keep the older repos' `claude-opus-4-8` pin by setting it in `lib/repo-config.mts`'s `ROLE_AGENTS`; moving off it is that repo's follow-up.
6. Take the Template's `sandcastle.yml` and drop the repo's own from `NOT_OWNED_BASELINE_PATHS`; move its repo-specific steps into `.github/ci/sandcastle-prepare.sh` ([The workflow](#the-workflow)).
7. The sandbox has no Docker daemon. A repo whose test projects start containers sets `GATE_COMMAND` in `lib/repo-config.mts` to a script that leaves
   those out and keeps the lints (its `.sandcastle/check.sh`), and points the gate-fixer and follow-up roles' instructions at it.
8. Set `GATE_SCRIPT` in `lib/repo-config.mts` to the committed file `GATE_COMMAND` runs (`.sandcastle/check.sh` for the step above), and list in `CHECK_PATHS` every place
   the gate reads its checks from: its scripts and tests, `.github/workflows/` and `package.json`. A gate whose branch changes `GATE_SCRIPT`, or a `GATE_SCRIPT` that isn't a file at the
   branch's base, fails without running.

9. Add `REPO_SLUG` and `NOT_OWNED_BASELINE_PATHS` to `lib/repo-config.mts` as one-line `export const` lines, and the settings deny rules, as [pre-push-review.md](pre-push-review.md#adapting) says.

Blazor-Server keeps its UI developer role by carrying its `ui` entry into the `ROLE_AGENTS` it moves to `lib/repo-config.mts`, adding the `ui` bullet to `plan-prompt.md`'s ROLES
list and the `{{UI_DEVELOPER}}` line to `roles/backend.md`; its own `roles/ui.md` stays, and
`lib/config.test.mts` fails while the repo has the `ui` entry but lacks the bullet or the `{{UI_DEVELOPER}}` line.
