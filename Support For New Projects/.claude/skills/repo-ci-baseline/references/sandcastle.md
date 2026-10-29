# Sandcastle

Sandcastle is the unattended agent pipeline that builds a repo's issues in a sandbox (`.sandcastle/`, TypeScript run with `tsx`).
Seven repos carry one, in two generations, and their settings had drifted.
The Template's Sandcastle section gives them one shared set of code, config, prompts and guardrails, split by the Template's usual rule
([ADR 0006](../docs/adr/0006-sandcastle-section-of-the-template.md)): a file with no per-repo value is Owned, anything else is Seed.
The pipeline's per-repo values sit in one Seed file, `lib/repo-config.mts`, so the rest of its code is Owned
([ADR 0007](../docs/adr/0007-sandcastle-code-is-owned-with-a-seed-repo-config.md)).

## What it guarantees

- Every Sandcastle repo type-checks with the same `tsconfig.json`, lints its prompts with the same rules, ignores the same run output, and documents the same `.env` settings.
- The pipeline's code (`main.mts`, `status.mts` and every `lib/` module but `repo-config.mts`), the intake and critique prompts, and the host-safety
  guardrails (`lib/host-safety.mts`, `lib/shell.mts`) are identical everywhere.
- A new repo starts from the same role prompts, Dockerfile, check and `package.json` scripts (`sandcastle`, `sandcastle:status` and `check:sandcastle`, on `tsx`, with `tsc --noEmit`).

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
| `status.mts`, `lib/status.mts` and their tests | The read-only `sandcastle:status` command ([Status](#status)); it shares the sweep's decision code (`sweepContext`, `admitToSweep`, `decide`) so it can't disagree with it |
| `lib/config.mts` and its test | What every Sandcastle repo shares: the role names (`ROLES`, plus the opt-in `ui` as `OptInRole`), limits, labels (`SANDCASTLE_LABELS`, and `FOLLOW_UP_LABEL` kept apart from them, with `HOST_LABELS` the host creates), markers (`SESSION_REPLY_MARKER` too), the Copilot reviewer settings, and the queue-scope (`isDefaultQueueScope`) and budget parsing |
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
| `.sandcastle/Dockerfile` | The sandbox image: the gate's linters as `ARG`s with their SHA-256s, an optional .NET SDK (`INSTALL_DOTNET`, `DOTNET_CHANNEL`), and optional Chromium libraries for Playwright (`INSTALL_PLAYWRIGHT_DEPS`, `PLAYWRIGHT_VERSION`) |
| `.sandcastle/check.sh` | Sandcastle's check, which the Seed `.github/ci/gate-checks.sh` runs when it's there |
| `package.json`, `pnpm-workspace.yaml` | Sandcastle's packages and scripts; a repo with its own Node tooling merges them |
| `.claude/rules/sandcastle-hand-off.md` | The session guidance for handing a pull request off to Sandcastle with `sandcastle:follow-up` ([Hand-off PRs](#hand-off-prs)); it loads in every session, and a repo can keep or reword it |
| `.github/ci/sandcastle-skills.txt` | The skills the Sandcastle workflow installs on the runner for the run (a pinned dotfiles commit and skill names, read as data); empty until filled ([The workflow](#the-workflow)) |
| `.sandcastle/lib/repo-config.mts` | `REPO_SLUG` and `NOT_OWNED_BASELINE_PATHS` for the local review ([pre-push-review.md](pre-push-review.md)), `ROLE_AGENTS` (each role's model, effort, iterations and timeout), `MAX_ITERATIONS`, the sandbox `hooks`, `copyToWorktree`, the host skills to mount (`SANDBOX_SKILLS`), the CI jobs `scripts/gate.sh` reproduces (`GATE_COVERED_CHECKS`, `Build Solution` in the Seed), the command the host runs as the gate in the sandbox (`GATE_COMMAND`, `scripts/gate.sh` in the Seed), the committed file it runs, which a branch may not change (`GATE_SCRIPT`), the paths whose changed files a PR's body lists for the reviewer (`CHECK_PATHS`), and `TEMPLATE_OWNED_DIR` and `TEMPLATE_ROOT_COPIES`, empty except in dotfiles |

The prompts keep every Sandcastle `{{NAME}}` dotfiles' copies have (`lib/role-prompts.test.mts` checks).
`test.sh` keeps dotfiles' own text out of them, and checks that the Dockerfile's linter versions match the Owned `scripts/gate.sh` and its .NET channel matches `global.json`.
A repo with `Microsoft.Playwright` in its `Directory.Packages.props` sets `INSTALL_PLAYWRIGHT_DEPS=true` in the Dockerfile (it is `false` by default, where `INSTALL_DOTNET` is `true`),
so its E2E tests find Chromium's system libraries in the sandbox. The step runs `pnpm dlx playwright@${PLAYWRIGHT_VERSION} install-deps chromium` as root and clears root's caches;
keep `PLAYWRIGHT_VERSION` near the repo's `Microsoft.Playwright` version. It installs only the libraries: the browser itself is left to the test fixture at run time,
so a Playwright bump needs no image change.
A Seed file is written once, so an existing repo keeps its own Dockerfile and adds the step by hand.
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

**Run modes.** `SANDCASTLE_MODE` (commented out in `.env.example`) picks what a run does; `runModeFrom` in `lib/config.mts` reads it. Unset, blank or `full` is a full run: intake, builds and rounds.
`follow-up` is a follow-up-only run (`followUpOnlyRun` in `lib/follow-up-run.mts`): it sweeps the open PRs once, runs one follow-up pass when the sweep flagged something, and exits,
so a review or a red check on a PR is answered while a full run is still busy building. Any other value fails with `RunModeError` and exit code 2.
The two runs stay off each other's PRs through `sandcastle:building`: the sweep skips a PR whose issue carries that label,
or, for a hand-off PR, a PR that carries it itself. A follow-up-only run also leaves closed PRs alone
and keeps its own Sandcastle check out of the head checks it reads.
The workflow side (the `mode` input, `SANDCASTLE_FOLLOW_UP_JOB` and the run's own concurrency group) is not in the Template's `sandcastle.yml` yet.

## Status

`pnpm run sandcastle:status` (`tsx .sandcastle/status.mts`) shows why Sandcastle is holding each open PR, so the answer isn't spread over the PR's checks, its threads, its labels and its comments.
With no variable set it reads the default queue (the issues labelled `Sandcastle`, hand-offs included), which is what GitHub Actions' scope would do;
`SANDCASTLE_ISSUE=<n>` or `SANDCASTLE_LABEL=<label>` narrow it as they do for a run (`statusScopeFrom` in `lib/status.mts`).
It lists every open PR into `main` that Sandcastle opened and every same-repo one the owner labelled `sandcastle:follow-up`,
whether or not that label counts, and says how many other open PRs it left out.

```text
#101 feat: Add search
  branch:   feature/42-add-search (BLOCKED), labels: review:claude
  for:      issue #42
  passes:   1 of 3
  held:     flagged for a pass: check build is red (a pass may still skip it: nothing it can re-run or fix, a thread author it can't identify, or a moved head)
  threads:  bot 0, owner 0, other 0
```

`for:` is `issue #n`, `hand-off`, `not swept`, or `unknown` when the read that decides it failed. A draft PR is listed too, as `skipped: isn't swept: it's a draft`.

- **`passes`.** The follow-up passes used since `sandcastle:needs-human` was last removed, against `FOLLOW_UP_PASS_CAP`:
  counted by `followUpPassCount` in `lib/github.mts`, the count the pass checks.
- **`held`.** The sweep's own answer: `sweepContext`, `admitToSweep` (`sweepSubject` and the hand-off approval), `labelOriginHold` and `decide`
  in `lib/follow-up.mts`, which the sweep calls too, on the PR without the threads the host answered.
  The state is `skipped` (not swept, with the sweep's reason, or a read or the decision failed, with the cause), `waiting`, `flagged for a pass`,
  `flagged for a hand-back` (the passes are used up, so a pass that has something to act on hands it back),
  `act next sweep` (Copilot will be asked, or the branch updated) or `settled`.
  A flag is `decide`'s answer, not a promise that a pass runs: `planPass` skips a flagged PR that has no needed merge, no red check with
  an Actions run behind it and no thread for the role, or whose head moved, or whose thread author it can't check, and the reason says so.
  Text from GitHub (a title, a branch, a reason, gh's error text on stderr, a warning a read prints and the log lines) is printed through `terminalText`: whitespace
  becomes one space, and control, format (bidi, zero-width, tag), default-ignorable, surrogate, noncharacter, filler and
  supplementary-plane private-use characters are dropped, so it can't overwrite or fake a line of the report. Three joiners stay where
  they do their work: a zero-width joiner between two assigned pictographs (an emoji sequence, with a skin tone or variation selector in it),
  that variation selector right after an assigned pictograph, and a zero-width non-joiner between two letters of Arabic (Persian too), Syriac,
  Thaana or an Indic script. At most eight survive in one text, so a few invisible bits can ride on them and no more. Keycap and
  flag-tag emoji fall apart, and in the Indic scripts only the non-joiner survives: a zero-width joiner between two letters (Sinhala's
  "Sri", a Devanagari half-form) is dropped. A private-use code point of the Basic Multilingual Plane (an icon glyph) or an unassigned
  one stays, since it draws a glyph or a box, but only eight of them per text, and no more than three combining marks in a row
  (text that stacks more, as Tibetan and Hebrew with cantillation can, loses the extras).
  `plainStderr` cleans what a read warns on stderr, joining the arguments as data, never as a format string.
  On the status's path, gh's and git's own stderr never reach the terminal themselves: the reads that run them (every gh read through
  `ghWithStderr`, `repoName()`, `protectHostGit`'s `git config`) capture it and put it in the thrown message (when gh printed nothing, a reason built from the error's code, signal or exit
  status, never its command line, which quotes titles), which the entry file
  prints through `terminalText`. Elsewhere in the pipeline `sh()` and `commentOnIssue` still let it through.
  Why: [ADR 0010](../docs/adr/0010-status-text-is-sanitised-and-stderr-is-captured.md).
- **`threads`.** The unresolved threads by who opened them: `bot`, `owner` (confirmed as the owner)
  and `other` (anyone else, or an owner check that couldn't answer),
  and `answered` for those the host replied to, which now wait on the owner. A thread read that failed shows `unknown (why)`, for a
  conflicting PR too, which the sweep flags whatever its threads say.
- **The workflow's runs.** The latest ten runs of `sandcastle.yml` (`sandcastleWorkflowRuns`):
  how each ended, what started it, the branch, the time and the link.
- **Unreadable parts.** A read that fails for one PR prints `unknown (why)` for that line and the other PRs still print;
  so does the list of runs. A PR whose decision can't be made (`decide` throws on a time GitHub returned that doesn't parse, as it
  does in the sweep) shows `skipped: couldn't decide: …`, and one whose admission read failed shows `for: unknown` and
  `skipped: couldn't read what decides whether it is swept: …`.

It is read-only: no comment, label or push, no sandbox, no model call. `StatusGitHub` has only reads, `loadQueue`'s label fixes and the hand-off head record the sweep posts are switched off,
and `lib/status.test.mts` and `status.test.mts` pin the imports. It can differ from the next sweep by what changes between the two reads (a check that finishes, a head the sweep would record).
Exit codes: `0` once the report is printed, whatever is held; `1` when the host's login, the in-scope issues, the open PRs or the repository
name can't be read, or host git is unsafe (`protectHostGit`), with the cause on stderr; `2` for a bad scope variable, before any `gh` call.

## Hand-off PRs

The sweep follows up a pull request Sandcastle didn't open when the repository owner puts the `sandcastle:follow-up` label on it
(`FOLLOW_UP_LABEL` in `lib/config.mts`). Without it, a pull request opened by a person or a Claude Code session gets no help with review threads,
red checks or falling behind `main`, and PR Auto-Merge holds it on every unresolved thread.

- **Which.** `sweepSubject` in `lib/follow-up.mts` accepts a labelled pull request that isn't a Sandcastle issue's (host-authored, marked, on an issue's branch, in this run's scope or not) when it is
  from the same repository, into `main`, not a draft, and its branch name passes `scripts/check-branch-name.sh` (`isHandOffBranch` in `lib/branches.mts`).
  A Sandcastle pull request carrying the label is never a hand-off:
  it is swept as its issue's when `sweepSkipReason` lets it through, and skipped otherwise. Only the default queue scope (`isDefaultQueueScope`: the `Sandcastle` label,
  what GitHub Actions always runs) follows hand-offs.
- **Who.** The label must come from the owner, checked from the pull request's events and its title and description edits (`handOffApproval`, built on `lib/queue.mts#approval`):
  the latest `labeled` event must be an owner's (`isOwner`: the host login or any login with push access, as for `sandcastle:ready`), and a rename or description edit by anyone else at or after it
  voids it until the owner adds the label again. In practice only the repository owner's own label counts, because only that label records a head (next bullet):
  a label from another login with push access passes this check and is never followed up.
  The pull request must also have been opened by the repository's owner (a session posts under the owner's token) or by the host login,
  so a collaborator can't hand off a pull request of their own (`isOwner` counts every login with push access, so it can't tell them apart;
  `handOffApproval` compares the author with the account the repository belongs to).
- **The head.** The label is bound to the commits the owner labelled. When the repository owner adds it, the `record-head` job of `sandcastle.yml` (a `pull_request_target` run on `labeled`,
  for a same-repository pull request, first attempt only) comments `<!-- sandcastle:approved-head {sha} -->` with the head from the event itself (`APPROVED_HEAD_MARKER`),
  and records nothing when the pull request's head has already moved on. `handOffApproval` follows the pull request up only when its head is in such a comment
  from the host login, posted at or after the latest `labeled` event and never edited (a login with push access can edit a comment).
  A head the host pushed counts too: a pass records the commit it pushed. So does a merge of `main` that GitHub made for the host on top of a head that counts,
  up to `MAX_MAIN_MERGES` deep (`mainMergeOf` in `lib/github.mts`: committed by web-flow with a verified signature, authored by the host login, two parents, the second a commit `main` contains).
  That covers an update made under the host's login (PR Auto-Merge when its `RELEASE_PR_PAT` is the account of `SANDCASTLE_GH_TOKEN`,
  the Update branch button when the owner is that account), but not a merge a collaborator makes, nor one made by `GITHUB_TOKEN` or
  another account. The sweep records a head it reached through such merges, so the walk starts from there next time;
  more than `MAX_MAIN_MERGES` merges since the last posted record end the follow-up, with the reason in the run log.
  A commit anyone else pushes after the label, a force-push, or a record that couldn't be made (the job couldn't read the pull request's head, or its post failed three times) leaves the head unapproved,
  and the pull request is not followed up until the owner removes and re-adds the label.
  The record needs the Sandcastle workflow in Actions with `SANDCASTLE_GH_TOKEN` set, and that token must belong to the account the sweep runs as (`signedInHostLogin`):
  a repo that runs Sandcastle only locally, or whose token is another account's, can't hand a pull request off.
  A pull request labelled before a repo got this job has no record and stops being followed up (the log says why): remove the label and add it again.
  An update-branch made under any other account than `SANDCASTLE_GH_TOKEN`'s ends the follow-up the same way, so a repo whose `RELEASE_PR_PAT` is another account's should expect to re-add the label
  after PR Auto-Merge updates a branch.
  Two behaviours of GitHub are assumed and not checked here. One: `update-branch` makes a two-parent commit that web-flow signs and the calling account authors,
  and no API lets another account produce one with the host as author. Two: a fresh comment's `updated_at` equals its `created_at`
  (`handOffApproval` counts a record only then, so a change in GitHub would stop every hand-off, and the log would say the head isn't recorded).
  The Seed `.claude/rules/sandcastle-hand-off.md` is never overwritten, so a repo that has it keeps the older text (which says a push after the label isn't checked) until it deletes the file and re-Applies.
  A repository an organisation owns, which has no owner login to match, follows no hand-off.
- **The claim.** A hand-off pull request has no issue to carry `sandcastle:building`, so the pass puts it on the pull request itself, and startup clears a stale one.
  When its branch names an issue (`feature/{n}-…`), the pass claims that issue too, since a build of the issue pushes to the same branch.
  That claim is best effort: a number that names no issue, or the pull request's own number, is passed on without it, and only a build already holding the issue makes the pass skip.
- **The label.** `FOLLOW_UP_LABEL` is created at startup with `SANDCASTLE_LABELS` and `Sandcastle:local` (`HOST_LABELS`), but it is not one of `SANDCASTLE_LABELS`:
  a person adds and removes it, and `SANDCASTLE_LABEL` can't name it as a queue.
- **A session's reply.** A Claude Code session posts under the owner's token and ends every reply with `<!-- claude-session -->` (`SESSION_REPLY_MARKER`,
  [PROCESS.md](../template/owned/docs/PROCESS.md)). A thread whose last bot, host or owner comment carries it, posted under the host's login or another owner's, counts as answered,
  and the follow-up role is not shown it. The marker counts anywhere in the comment's body, so a host or owner comment that quotes it is taken for a session's reply too.
- **The prompt.** The follow-up role gets the pull request's number, title and description in the place of an issue's, under a note saying it is not an issue.
- **The session guidance** is the Seed `.claude/rules/sandcastle-hand-off.md`: a rules file has no `paths:` and loads in every session, like a `CLAUDE.md`,
  which Apply can't edit. It is the repo's once written, so Apply never overwrites it.

The workflow's `pull_request_target` `labeled` trigger starts only the `record-head` job, never a Sandcastle run: the schedule and the existing triggers pick a labelled pull request up,
and `chore/` branches are not in the `workflow_run` and review lists.

## When Apply adds it

Only to a repo that has a `.sandcastle/` folder, or no commits yet.
In any other repo, Apply leaves out every file under `.sandcastle/`, plus `package.json`, `pnpm-workspace.yaml`, the Sandcastle workflow,
`.github/ci/sandcastle-skills.txt`, `.claude/rules/sandcastle-hand-off.md` and the local review's files ([pre-push-review.md](pre-push-review.md)), and its report counts them as
"Sandcastle files left out". A repo starts using Sandcastle by creating `.sandcastle/` and Applying again.

## What isn't in it

- **dotfiles' own tests:** `lib/repo-config.test.mts` (dotfiles' per-repo values and root copies), `lib/template.test.mts` (type-checks the
  Template's `.sandcastle/` as Apply writes it and runs its Owned tests there), `lib/dockerfile.test.mts`, `lib/role-prompts.test.mts`,
  `lib/owned-paths.test.mts` (keeps `OWNED_PATHS` in `lib/review-ledger.mts` equal to `template/owned/`) and `main.test.mts`, which read dotfiles' own files.
- **Other `.github/workflows/sandcastle*.yml` files.** Only `sandcastle.yml` is the Template's (below); a repo's own extra Sandcastle workflow stays its own.

## The workflow

`.github/workflows/sandcastle.yml` is Owned ([ADR 0009](../docs/adr/0009-sandcastle-workflow-is-owned.md)): it runs the host unattended on a schedule and on the events that
start a follow-up, and Sandcastle can't change it (its token has no Workflows permission), so a change comes from a Template PR and reaches the repos by re-Apply.
Apply writes it, and `.github/ci/sandcastle-skills.txt`, only into a repo that runs Sandcastle (it has a `.sandcastle/` folder, or is new).

- **A second job, `record-head`, runs on `pull_request_target` `labeled`.** It posts the approved-head comment for the owner's `sandcastle:follow-up` label
  (permissions `{}`, no checkout, no action, a no-op with a warning when the secret is unset), so a hand-off is followed up only in a repo that runs Sandcastle in Actions.
  `pull_request_target`, not `pull_request`, so the job is the one on `main`, not the pull request branch's. `test.sh` pins its guards.
- **A repo opts in with the `SANDCASTLE_GH_TOKEN` secret** (a fine-grained PAT with Contents, Issues, Pull requests and Actions read and write, and no Workflows permission),
  and a Claude credential (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`). Without the token every step but the first is skipped, so a repo that runs Sandcastle only
  locally gets a green run with a notice on every trigger the sandcastle job's `if:` lets through, not a failure every two hours. With the token but no Claude credential the run fails.
- **`.github/ci/sandcastle-skills.txt` lists the skills the run mounts (Seed).** A hosted runner has no `~/.claude/skills`, which `lib/skills.mts` mounts
  the `SANDBOX_SKILLS` from. The file is data: a `dotfiles-sha` line (the commit of mpaulosky/dotfiles' `main` to take them from, 40 lowercase hex digits, pinned like an action)
  and a `skill` line per skill name; the Seed has neither, and installs nothing.
  The Owned step "Install the skills" rejects any line that isn't blank, a `#` comment in column 0 or one of those two (and prints none of the file),
  fetches the commit before git holds the PAT and with no secret in its environment, refuses a commit that isn't in dotfiles' `main`,
  a missing skill and a symlink in a listed skill or above it, and links only the listed skills.
  The step runs no script of the repo's, so its file can't change what the steps that hold the PAT and the Claude credential trust;
  those steps still run the repo's `package.json` scripts and `.sandcastle/` code from `main`, which a PR to `main` reviews.
- **The CI workflows it follows are listed by name** (`workflow_run` can't read a variable): `Build and Test Suite` (the Template's `ci.yml`),
  `repo-ci-baseline Template` (the workflow that tests the Template, in dotfiles) and `Claude Review`. A name the repo lacks matches nothing.
- **A repo with its own `sandcastle.yml`** has it overwritten by its re-Apply (`apply.sh` can't skip an Owned file; `NOT_OWNED_BASELINE_PATHS` only tells the local review
  which files are the repo's own). It drops the file from that list in the same PR and moves the skills it installs into `sandcastle-skills.txt`.
  Anything else its workflow does that the Template's doesn't needs a Template change first.
  The Template's workflow reads no repository variable, so a variable the old one read (auth0-management-app's follow-up switches) does nothing after the re-Apply.
  A repo whose own workflow has triggers the Template lacks (auth0-management-app's follow-up-run and hand-opened-PR ones;
  the run mode (mpaulosky/dotfiles#313) and the hand-off code (mpaulosky/dotfiles#314) are in the Template, and so is the hand-off label's own
  trigger, the `record-head` job on `pull_request_target`; the follow-up-run and hand-opened-PR workflow triggers are not) must not be
  re-Applied until those land, or its re-Apply drops them. `rollout.sh` re-Applies every repo in `github/repos.txt` and can't leave one out
  (once TicketManager's re-Apply PR has merged, a run re-Applies all the others, auth0-management-app included), so until then don't run it:
  re-Apply each repo except auth0-management-app one at a time with `reapply.sh`, TicketManager first.
- **A change to the skills list needs a person's review.** The skills become the agents' instructions. The step refuses a commit outside dotfiles' `main`
  (GitHub serves a fork's commit by hash), but any older commit of `main` passes, so check the pin is the one meant.

## Migrating a repo

One PR per repo, each its own follow-up issue. The four older repos go first (Articles, IssueManager, IssueTracker, TicketManager), then Blazor-Server and auth0-management-app.

1. Run `apply.sh --dry-run <repo>`. Each `.sandcastle/` Owned file it would overwrite is drift.
   Diff it before dropping it: another repo's `host-safety.mts` may be newer than the Template's, and a real fix moves into the Template before the re-Apply (Template first).
   Before dropping the old `lib/config.mts`, move its role models (`ROLE_AGENTS`), `MAX_ITERATIONS`, `hooks` and `copyToWorktree`,
   the `SANDBOX_SKILLS` from `lib/skills.mts` and the `GATE_COVERED_CHECKS` from `lib/follow-up-pass.mts` into `lib/repo-config.mts`.
2. Rename the `test:sandcastle` script to `check:sandcastle`, run it with `tsx`, and add `tsc --noEmit`, and add `sandcastle:status` (`tsx .sandcastle/status.mts`).
   A Seed `package.json` is written once, so a repo that already has one adds the script by hand.
3. Diff the repo's role prompts, `Dockerfile` and `package.json` against the Template's Seed files, and bring over what the repo lacks.
4. Run `pnpm install`, then commit `pnpm-lock.yaml` with the change.
5. Keep the older repos' `claude-opus-4-8` pin by setting it in `lib/repo-config.mts`'s `ROLE_AGENTS`; moving off it is that repo's follow-up.
6. Take the Template's `sandcastle.yml` and drop the repo's own from `NOT_OWNED_BASELINE_PATHS`; move the skills it installs into `.github/ci/sandcastle-skills.txt` ([The workflow](#the-workflow)).
7. The sandbox has no Docker daemon. A repo whose test projects start containers sets `GATE_COMMAND` in `lib/repo-config.mts` to a script that leaves
   those out and keeps the lints (its `.sandcastle/check.sh`), and points the gate-fixer and follow-up roles' instructions at it.
8. Set `GATE_SCRIPT` in `lib/repo-config.mts` to the committed file `GATE_COMMAND` runs (`.sandcastle/check.sh` for the step above), and list in `CHECK_PATHS` every place
   the gate reads its checks from: its scripts and tests, `.github/workflows/`, `.github/scripts/check_gh_repo.py`, `.claude/skills/` (the gate's `gh` check reads them)
   and `package.json`. A gate whose branch changes `GATE_SCRIPT`, or a `GATE_SCRIPT` that isn't a file at the
   branch's base, fails without running.

9. Add `REPO_SLUG` and `NOT_OWNED_BASELINE_PATHS` to `lib/repo-config.mts` as one-line `export const` lines, and the settings deny rules, as [pre-push-review.md](pre-push-review.md#adapting) says.

Apply writes `.sandcastle/check.sh` only where a repo has none, as it does for every Seed file, so an existing repo keeps its old copy and Apply does not refresh it. An old copy
doesn't run `check:sandcastle` for an edit that touches only `.claude/skills/hardening-review/`: an existing repo copies the new pathspec by hand from the Seed's `check.sh`
(`.claude/skills/pre-push-review`, `.claude/skills/hardening-review`, `.claude/agents/pre-push-reviewer.md` and `.github/workflows/claude-review.yml`).

Blazor-Server keeps its UI developer role by carrying its `ui` entry into the `ROLE_AGENTS` it moves to `lib/repo-config.mts`, adding the `ui` bullet to `plan-prompt.md`'s ROLES
list and the `{{UI_DEVELOPER}}` line to `roles/backend.md`; its own `roles/ui.md` stays, and
`lib/config.test.mts` fails while the repo has the `ui` entry but lacks the bullet or the `{{UI_DEVELOPER}}` line.
