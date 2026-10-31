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
  The gate itself refuses a `gh` command in a repo's own scripts and skills that isn't told its repository (`check_gh_repo.py --repo`).

**Template first.**
A fix to an Owned file is made in `template/`, then Applied to the repo that needed it.
A fix made only in a repo is reverted by its next Apply.

## The parts

| Part | What it guarantees | Reference |
| --- | --- | --- |
| Git hooks, branch names and worktrees | One branch-name standard, checked by the hook and by CI; every change is committed in a worktree under `../<Repo>-worktrees/`; pushes are gated on the pushed commit | [git-hooks.md](references/git-hooks.md) |
| Staged-content pre-commit | Commits are linted as they'll be committed | [pre-commit.md](references/pre-commit.md) |
| Auto-merge after review | A PR merges on its own only once checks pass, Copilot (or Claude, its `review:claude` backup) reviewed its head and every thread is resolved, until three dirty review rounds in a row exhaust the loop (then one comment lists what is open and the PR merges, unless a person's thread is open); Claude reviews only where Copilot can't, so `review:claude` is ignored while Copilot can review; never while handed back with `sandcastle:needs-human` | [automerge.md](references/automerge.md) |
| Serialized releases | Versions follow merge order, a missed release is retried, one blog PR per run | [release-pipeline.md](references/release-pipeline.md) |
| PR process | One written process (`docs/PROCESS.md`), a PR template, and PR titles in the commit format, checked by **PR title** | [pr-process.md](references/pr-process.md) |
| Docs-only CI skip | Docs PRs skip the build and tests while required checks still pass | [docs-only-ci.md](references/docs-only-ci.md) |
| Per-project test matrix | Each test project runs in its own job on Microsoft Testing Platform | [test-matrix.md](references/test-matrix.md) |
| Release labels | `semver:minor` and `semver:major` exist, because `release.yml` reads them | [release-pipeline.md](references/release-pipeline.md) |
| Review before the push | In a repo with Sandcastle, `/pre-push-review` reviews the branch's whole diff locally, grades each finding, fixes the real ones and records a ledger; `scripts/gate.sh` refuses a push without a clean one, so GitHub's reviewers are a backstop; `/hardening-review` repeats it as full passes, with each reviewer's example input run, a mutation check on every batch of fixes and a stop when a pass finds nothing new, for a large or risky branch | [pre-push-review.md](references/pre-push-review.md) |
| Copilot review instructions | A repo with a code-review skill generates `.github/copilot-instructions.md` from it, and the gate and CI fail when it drifts; a repo without the skill passes | [copilot-review-sync.md](references/copilot-review-sync.md) |
| Sandcastle | Repos that run Sandcastle share its code, prompts, workflow, guardrails and the session guidance for handing a PR off (Owned) and start from the same per-repo values (Seed); Apply adds them only to a repo with a `.sandcastle/` folder or no commits | [sandcastle.md](references/sandcastle.md) |
| PR watcher | `scripts/watch-pr.sh <pr>` polls one PR read-only and exits with the reason the session that opened it must act (merged, conflict, a failed check, a thread, a person's words), skipping what the session and Sandcastle post by their markers | [watch-pr.md](references/watch-pr.md) |
| GitHub settings | One standard for merge settings, the `main-rules` ruleset and required checks, labels, Actions and security, checked and applied by `github-settings.sh` | [github-settings.md](references/github-settings.md) |

Read a part's reference before changing it: each holds the design, the review findings behind it, and its live check.
Lessons that cut across parts are in [gotchas.md](references/gotchas.md).
Which token each workflow call uses, and the allowance they share, is in [tokens.md](references/tokens.md).
Claude Code settings (`.claude/settings.json`) are not part of the Template: permissions are set per user, so don't add the file back.
The one rule worth adding to it, denying Claude Code the local review's ledgers and credential files, is in [pre-push-review.md](references/pre-push-review.md#adapting).
The one hook worth adding by hand, `scripts/check-git-hooks.sh`, is in [git-hooks.md](references/git-hooks.md#session-start-check).
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

Order across repos: `github/repos.txt`'s, the one list of the repos (retiring one is deleting its line), with TicketManager first as the live check of each Template change.

## Change the Baseline

1. Edit `template/` (and the part's reference) in a dotfiles worktree.
2. Run `test.sh`: the hook suites, the auto-merge script tests, the release-script tests, the renderer oracle, the GitHub scripts' tests
   (settings, the landing decision, status, land, rollout), the Claude Review benchmark's tests, actionlint, zizmor, yamllint, shellcheck, markdownlint, the no-placeholders-in-Owned
   check, the check that the Owned scripts' `gh` commands are told their repository, the Sandcastle copy and Seed checks, and the `apply.sh` and `reapply.sh` tests.
   dotfiles CI runs the same script.
   Done when it passes.
3. After the dotfiles PR merges, re-Apply to each repo in its own PR; the overwritten Owned files are the change.
   Open it ready, not as a draft: the repo's own auto-merge lands it ([automerge.md](references/automerge.md#landing)).
   - **Roll out:** `rollout.sh --brings mpaulosky/dotfiles#<n>,#<n>` runs `reapply.sh` on TicketManager and holds the rest until its re-Apply PR has merged.
     Land that PR, fix any finding Template first, then run `rollout.sh` again: once it has merged,
     it re-Applies the other repos in order, one pre-push gate at a time, reports a repo that fails and goes on.
     Start with `--dry-run`. It ends with the `land.sh` command for the PRs it left open.
   - **One repo:** `reapply.sh --brings mpaulosky/dotfiles#<n>,#<n> <repo>` (what `rollout.sh` runs, and the way to retry a repo that failed)
     prepares the `chore/reapply-baseline` worktree, merges the remote branch and `main`, commits `apply.sh`'s output alone,
     pushes through the gate, opens the re-Apply PR ready (or adds the commit to the open one) and requests Copilot;
     it records Copilot's ask on the PR when the request doesn't register, so Claude Review runs (a first re-Apply PR has the old PR Auto-Merge).
     Its header comment has the details; name the head it prints in thread replies.
   - **Land:** `land.sh <owner/repo#n>...` watches the PRs and acts on the landing decision until each PR and its release-blog PR land
     ([automerge.md](references/automerge.md#landing-a-round)); start with `land.sh --once --dry-run`.
   - **Check:** `status.sh` prints one line per open PR across `github/repos.txt` with its next landing action, for a status update
     at any point ([automerge.md](references/automerge.md#status-and-the-landing-decision)).
   A change to `github/` (a new required check or label) is applied with `github-settings.sh --fix` once the repo reports the check.

## Start a new repo

Follow `Support For New Projects/Instructions.md`: `git init`, then `apply.sh` on the empty repo, whose output is the first commit on `main`,
then `github-settings.sh --fix` once it's pushed.
