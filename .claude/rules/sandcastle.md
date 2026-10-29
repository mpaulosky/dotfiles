---
paths:
  - ".sandcastle/**"
  - "package.json"
  - "pnpm-*.yaml"
---

# Sandcastle Rules

`.sandcastle/` is the unattended agent pipeline: TypeScript run with `tsx` on Node, no build step. The design and the
plan of record are in Blazor-Server's `docs/plans/sandcastle-workflow.md`, which this is a port of; each module's header comment says what it owns.
`pnpm run check:sandcastle` (type-check, then every `*.test.mts`) is the check, and `scripts/gate.sh` runs it when these
files change.

## Writing the code

- **Change the Template's copy too.** `main.mts`, `status.mts` and every `lib/` module but `repo-config.mts`, with their tests, are copies of
  the Template's Owned files under `template/owned/.sandcastle/`. Change both, or change one and copy it over; `test.sh` fails
  when they differ. dotfiles' own tests (`repo-config`, `template`, `dockerfile`, `role-prompts` and `owned-paths`, and `main.test.mts`) aren't.
- **Per-repo values go in `lib/repo-config.mts`,** the Seed file each repo fills. `lib/config.mts` holds only what every
  Sandcastle repo shares and never imports it. An Owned test reads a per-repo value from `repo-config.mts`, or the code
  under test takes it as a parameter, and never pins dotfiles' value.
- **Match the module you're in.** Two-space indents, double quotes, semicolons, `.mts` files that import each other with
  the `.mts` extension. `.editorconfig` has no `.mts` section, so the surrounding code is the style guide.
- **Comment the why.** Every exported function and type gets a `//` comment above it in full sentences: what it's for,
  the case it guards against, the incident behind it (`mpaulosky/dotfiles#149`, a request ID). Never a bare `#N`: an
  Owned file is copied into other repos, where it reads as that repo's issue, and `test.sh` refuses it. Inside a
  function, comment only a decision a reader would question.
- **Inject the outside world.** A module that touches git, `gh`, Docker, the clock or the filesystem takes it through a
  host object (`BuildHost` in `lib/build.mts`, `SandboxHost` in `lib/skills.mts`) or through parameters with live
  defaults (`publish` in `lib/build.mts`). The live wiring sits at the bottom of the module; tests pass stubs.
- **Keep dependencies where they are.** `package.json` holds Sandcastle, `zod`, the type-checker and `tsx`. Reach for
  Node's standard library first, and justify any new package in the PR description.
- **Fail closed.** When the code can't tell whether something is safe (an unexpected shape from Sandcastle, an
  unreadable GitHub response), throw or hold the issue back rather than carry on.

## Testing

- Tests sit beside the module as `<module>.test.mts`, written with `node:test` (`describe`, `it`) and
  `node:assert/strict`. No mocking library: stubs are object literals that record their calls.
- Name each test as the behaviour it pins, in plain words (`"retries a push that fails with a GitHub server error"`).
- A test that reads a repo file resolves it from `import.meta.url`, as `lib/role-prompts.test.mts` does.

## Host safety

Agents write the worktree and the shared `.git` directory, and the host later runs git and `gh` over both. These
guardrails keep agent-written code from running on the host. A change keeps every one of them:

- Host git runs with hooks off and `GIT_COMMON_DIR` pinned (`lib/host-safety.mts`), in the main checkout only.
- Each sandbox mounts `.git/config` and `.git/hooks` read-only through the provider's `create()` (`lib/skills.mts`), and an empty read-only
  folder over `.git/review` (the local review's ledgers hold accepted security findings, never published), at every path a mount puts `.git`
  (`protectedGitMounts`, `withCreateMounts`), and one over the main checkout's `.security` (the local security record, never published:
  `protectedRecordMounts`). Every sandbox also sets `GATE_SKIP_REVIEW=1` (`SANDBOX_ENV`): Sandcastle doesn't run that review yet.
- The sandbox gets no GitHub token (`main.mts` refuses one in `.sandcastle/.env`); the host does every GitHub write.
- The host pushes the commit the gate passed on, after the secret scan (`lib/scan.mts`), and posts only
  `publicErrorText` on public issues.

The unit tests stub Docker, so they can't see what Sandcastle or Docker does with a mount or option: a stubbed test
passed while every real run failed (#194). When a change touches a mount, the sandbox provider or how the host runs
git, say in the commit body and the PR description that it needs a run against a real sandbox before merging.
