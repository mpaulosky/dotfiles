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

- **Change the Template's copy too.** `check.sh`, `main.mts`, `status.mts`, every `lib/` module but `repo-config.mts` (with their tests),
  `plan-prompt.md`, `review-prompt.md` and the role prompts under `roles/` are copies of
  the Template's Owned files under `template/owned/.sandcastle/`. Change both, or change one and copy it over; `test.sh` fails
  when they differ. dotfiles' own tests (`repo-config`, `template`, `dockerfile`, `role-prompts` and `owned-paths`, and `main.test.mts`) aren't,
  nor are `roles/shared-rules.md` and `roles/skills.md`: dotfiles' text for the roles lives there.
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
- **Give every sandbox command a limit.** `createCheckedSandbox` hands back a sandbox whose `exec` runs under `timeout` (`lib/step-limit.mts`):
  `GATE_LIMIT_MINUTES` (the Seed's `lib/repo-config.mts`) for the gate and `COMMAND_LIMIT_MINUTES` for any other command. The host kills a step that runs over. Run a command
  in a sandbox through that `exec`, and keep a role run on its own `timeoutMinutes`, with the host giving up on a role run in a sandbox
  `ROLE_RUN_GRACE_MINUTES` later. The gate that runs over is a red gate (exit 124, its name in the output); a command other than the gate that runs over,
  or one the host gives up on, stalls the sandbox: it throws `StalledStepError` naming it, as does every later `exec` and every role start
  (`runRoleInSandbox`), never an exit code a caller could read as a git answer. `main.mts` ends the run red on one (`stallStop`).
  A follow-up pass that stalls is only that PR's failed pass: the phase records the stall and carries on, and later rounds skip that PR, so one stalled PR cannot stop the run.
  After a timeout the command's process group is killed, so a descendant that ignores TERM can't run beside the next step. The `timeout` probe
  in `createCheckedSandbox` runs under a one-minute limit of its own.
  So does the sandbox-state probe (`lib/diagnostics.mts`, `PROBE_SECONDS`), since a probe that hung would otherwise stall the sandbox for `COMMAND_LIMIT_MINUTES`.
  `lib/step-limit.test.mts` also runs the real `timeout` and `sh`, so it needs GNU coreutils
  on this machine and skips those tests without it;
  the sandbox image needs `timeout` too, which `createCheckedSandbox` checks.
- **Give the host's own waits a limit.** Every `gh`, `git` and `docker info` call the host makes goes through `hostExecFileSync` (`lib/host-limit.mts`), which kills
  one that runs past `HOST_COMMAND_LIMIT_MINUTES`, so it fails like any failed call. Only `lib/host-limit.mts` imports `node:child_process` as a value
  (a type import for `typeof execFileSync` is fine; only `git-sandbox-fake`, a test helper, is exempt, since `review-ledger` and `security-record` run on the host too), and a `run` parameter defaults
  to `hostExecFileSync`: `lib/host-limit.test.mts` scans for both. Creating and closing a sandbox go through `withinDockerLimit` and `closeWithinLimit`
  (`DOCKER_CALL_LIMIT_MINUTES`): a call Docker never answers is a `StalledStepError`, and a sandbox created too late is closed once its worktree passes the check (a worktree gone from the path the
  host expects counts as passing; one that fails it, whose check throws, or that is at any other path, is left in place with a warning). The call itself can't be cancelled, so a container
  Docker never answered for may stay running until a person removes it. A call the host gave up on (a Docker create or close, a role's run in a sandbox, or a sandbox exec in
  `lib/step-limit.mts`) is recorded by `markHostCallAbandoned`, and `main.mts` ends with `exitAfterStall()` after its report and cleanup: the process
  exits with the run's code `STALL_EXIT_GRACE_SECONDS` later, naming the abandoned calls, because process.exitCode doesn't force an exit and the call
  may keep Node alive. The same warning is printed once when the process exits for any reason, so a run that crashes before `exitAfterStall` names them too.
  A close the host gave up on, in a build's or a pass's `finally` or after `createCheckedSandbox` refuses a sandbox, is logged and ends the run red (`closeAfterWork`; `exitAfterStall` sets exit
  code 1), but it never discards the pull request or the error that ended the work. Role runs through `sandcastle.run()` rely on the role's own
  `timeoutMinutes`; a role run in a sandbox (`runRoleInSandbox`, a build's and a follow-up pass's) is also given up on `ROLE_RUN_GRACE_MINUTES`
  after that timeout, which stalls the sandbox like a command that never returned. The host-side review as a whole stops starting steps after
  `REVIEW_WALL_CLOCK_MINUTES` (checked before each round, reviewer and fixer run) and ends as failed at its last gated commit.
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
  `protectedRecordMounts`). Every sandbox also sets `GATE_SKIP_REVIEW=1` (`SANDBOX_ENV`): the host runs that review's rounds itself after checkpoint 2
  (`lib/host-review.mts`), recording in the main checkout through `prepareRound` and `recordReview`, never by running the worktree's `scripts/review.sh`. The reviewers
  get Read, Grep and Glob only (`restrictedClaudeCode`), and no agent's prompt names a shell on the ledger, a token or `.git/review`.
  In the `subagents` reviewer mode (`SANDCASTLE_REVIEWERS`) the `pre-push-review-lead` run holds Read, Grep and Glob and an `Agent(lens-1,lens-2,…)` allowlist of the round's lens agents.
  `leadTools` builds the list and it is written as the `tools` of the lead's own `--agents` definition, `pre-push-review-lead`, started with `--agent` and no `--tools`
  (in `--tools` the allowlist would leave the lead no `Agent` tool). `restrictedClaudeCode` enforces it: it refuses a bare `Agent`, any tool beyond Read, Grep and Glob,
  and a lead whose `denied` lacks any of `LEAD_DENIED_TOOLS` or that lacks `strictMcp` or `userSettingsOnly`.
  The name `pre-push-review-lead` is reserved, and `LEAD_DENIED_TOOLS` denies the ledger rules, every known built-in subagent type and the known tools that run commands, write files, reach the network,
  load skills or enter worktrees (not `Task` or a bare `Agent`, which may alias the lead's Agent tool) as further layers (a deny list can't name a later release's tool).
  It starts the reviewers as subagents defined on its command line, which hold Read, Grep and Glob only; the lead holds Agent, Read, Grep and Glob and nothing else:
  no shell, no network and no write tool, by its definition's tools and those denials. In a local probe (`claude` 2.1.317, `--agent`) the lead had no Bash tool, with and without
  the deny list, and a real run's log shows it calling only Agent; what the probes did not cover is listed as still open in
  [`references/pre-push-review.md`](<../../Support For New Projects/.claude/skills/repo-ci-baseline/references/pre-push-review.md>).
- The sandbox gets no GitHub token (`main.mts` refuses one in `.sandcastle/.env`); the host does every GitHub write.
- The run report artifact is downloadable by any signed-in user of a public repository and GitHub doesn't mask secrets in it, so it never holds a role's log whole:
  `lib/role-logs.mts` copies only the reviewers' allowlisted view (three sorted sets of fixed lines: the host status lines that appeared with their numbers masked,
  the known tool names without arguments, an MCP tool only as `mcp__(...)`, and the error words that appeared, each only as a fixed `[error line: <word>]` message,
  never the line's text; no order, count or number), only for the builds this run started and at most 20, written as `reviewer-<n>.log`
  (never under the source's name, which an agent chose), checked for the sandbox's secrets and token shapes. Beside them `index.txt` says which issue's build wrote
  each numbered log, in host-made text only (an issue number and fixed words, never a name taken from a log). `summary.md`'s tool-call timing
  (`lib/role-timeline.mts`) is allowlisted the same way: counts, seconds and a tool's name only when it is in `KNOWN_TOOLS`, never its arguments. On Actions the whole report folder
  (`summary.md`, `handbacks.json`, `reviewer-logs/`) is `$RUNNER_TEMP/sandcastle-report/` (`lib/report.mts#reportDir`), outside the checkout: a head-mode
  sandbox mounts the checkout read-write and one the host gave up on may still run, so a file under `.sandcastle/logs/` could be rewritten before the upload
  or before the `Fail on hand-backs` step reads `handbacks.json`. The workflow uploads and reads from that folder.
- The host pushes the commit the gate passed on, after the secret scan (`lib/scan.mts`), and posts only
  `publicErrorText` on public issues.

The unit tests stub Docker, so they can't see what Sandcastle or Docker does with a mount or option: a stubbed test
passed while every real run failed (#194). When a change touches a mount, the sandbox provider or how the host runs
git, say in the commit body and the PR description that it needs a run against a real sandbox before merging.
