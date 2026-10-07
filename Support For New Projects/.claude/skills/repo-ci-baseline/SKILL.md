---
name: repo-ci-baseline
description: The CI, release and git-hook Baseline for mpaulosky's .NET repos, kept as a Template that apply.sh copies into a repo. Use when standardizing a repo or setting up a new one, changing any part of the Baseline (hooks, branch names, CI, releases, blog posts, auto-merge), or when one of those misbehaves.
---

# Repo CI baseline

Every repo carries one Baseline.
Its single source of truth is `template/`: `apply.sh` copies it into a repo, and the repo's own work happens afterwards.
The vocabulary (Baseline, Template, Owned, Seed, Apply, Adapt, Standardize, Drift, Leftover) is in [CONTEXT.md](CONTEXT.md).
Why it works this way is in [ADR 0001](docs/adr/0001-standardize-by-copying-a-template.md).

- **Owned files** (`template/owned/`) are overwritten on every Apply, mode included.
  They carry no per-repo values.
- **Seed files** (`template/seed/`) are written only where the repo has none, with `{{OWNER}}`, `{{REPO}}` and `{{SOLUTION}}` filled in.
  Per-repo CI setup goes in the Seed `.github/ci/prepare.sh`, which `ci.yml` calls; per-repo gate checks go in the Seed `.github/ci/gate-checks.sh`, which `scripts/gate.sh` calls.

**Template first.**
A fix to an Owned file is made in `template/`, then Applied to the repo that needed it.
A fix made only in a repo is reverted by its next Apply.

## The parts

| Part | What it guarantees | Reference |
| --- | --- | --- |
| Git hooks, branch names and worktrees | One branch-name standard, checked by the hook and by CI; every change is committed in a worktree under `../<Repo>-worktrees/`; pushes are gated on the pushed commit | [git-hooks.md](references/git-hooks.md) |
| Staged-content pre-commit | Commits are linted as they'll be committed | [pre-commit.md](references/pre-commit.md) |
| Auto-merge after review | A PR merges on its own only once checks pass, Copilot reviewed its head and every thread is resolved, until Copilot's three-round cap; never while handed back with `sandcastle:needs-human` | [automerge.md](references/automerge.md) |
| Serialized releases | Versions follow merge order, a missed release is retried, one blog PR per run | [release-pipeline.md](references/release-pipeline.md) |
| PR process | One written process (`docs/PROCESS.md`), a PR template, and PR titles in the commit format, checked by **PR title** | [pr-process.md](references/pr-process.md) |
| Docs-only CI skip | Docs PRs skip the build and tests while required checks still pass | [docs-only-ci.md](references/docs-only-ci.md) |
| Per-project test matrix | Each test project runs in its own job on Microsoft Testing Platform | [test-matrix.md](references/test-matrix.md) |
| Release labels | `semver:minor` and `semver:major` exist, because `release.yml` reads them | [release-pipeline.md](references/release-pipeline.md) |
| GitHub settings | One standard for merge settings, the `main-rules` ruleset and required checks, labels, Actions and security, checked and applied by `github-settings.sh` | [github-settings.md](references/github-settings.md) |

Read a part's reference before changing it: each holds the design, the review findings behind it, and its live check.
Lessons that cut across parts are in [gotchas.md](references/gotchas.md).
Claude Code settings (`.claude/settings.json`) are not part of the Template: permissions are set per user, so don't add the file back.
A repo that got it from an earlier Apply deletes it by hand, since `apply.sh` never deletes.

## Standardize a repo

One repo, one PR, following the repo's branch, worktree and commit rules.
With squad still installed (`.squad/` or `squad-*` workflows), run the `remove-squad` skill first.

1. **Survey.** Run `apply.sh --dry-run <repo>` from any branch, and read the report as [apply.md](references/apply.md) explains.
   Done when every line of the report has a planned action.
2. **Apply.** In a fresh worktree on `chore/standardize-baseline`, run `apply.sh <worktree>` and commit its output alone, as `chore: apply repo-ci-baseline Template`.
   Done when that commit is exactly the script's output.
3. **Adapt**, in further commits, working through [adapt.md](references/adapt.md).
   Done when every item there is resolved and the repo's local gate (`scripts/gate.sh`) passes.
4. **Land.** Push once and open the PR **as a draft**: the repo's old auto-merge workflow would otherwise merge it the moment its checks pass.
   While it's a draft, run the docs-only probe from [docs-only-ci.md](references/docs-only-ci.md#verify-live), then land it by hand as [automerge.md](references/automerge.md#adapting) describes.
   Run `github-settings.sh --fix` on the repo while it's a draft and again right after the merge ([github-settings.md](references/github-settings.md#when-to-run-it)),
   and merge while nothing else is in flight: the merge is the new `release.yml`'s first live run.
   Done when the PR *and* its release-blog PR have merged.
5. **Verify live**, each part as its reference describes.
   A part counts only once its live check passes on the repo.
6. **Record.** A lesson goes into the matching reference; a fix to an Owned file goes into `template/` (Template first).
   Done when the next Standardize wouldn't hit the same surprise.

Order across repos (`github/repos.txt`): TicketManager first, as the live check of each Template change, then IssueTracker, atelier-store, Blazor-Server,
IssueManager and Articles. TinyTicket is retired and not Standardized.

## Change the Baseline

1. Edit `template/` (and the part's reference) in a dotfiles worktree.
2. Run `test.sh`: the hook suites, the auto-merge script tests, the release-script tests, the renderer oracle, the GitHub settings script's tests,
   actionlint, zizmor, yamllint, shellcheck, markdownlint, the no-placeholders-in-Owned check and the `apply.sh` tests.
   dotfiles CI runs the same script.
   Done when it passes.
3. After the dotfiles PR merges, re-Apply to each repo in its own PR; the overwritten Owned files are the change.
   Open it ready, not as a draft: the repo's own auto-merge lands it ([automerge.md](references/automerge.md#landing)).
   A change to `github/` (a new required check or label) is applied with `github-settings.sh --fix` once the repo reports the check.

## Start a new repo

Follow `Support For New Projects/Instructions.md`: `git init`, then `apply.sh` on the empty repo, whose output is the first commit on `main`,
then `github-settings.sh --fix` once it's pushed.
