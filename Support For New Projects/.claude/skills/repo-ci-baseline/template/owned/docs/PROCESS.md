# How changes reach `main`

This is the process every one of these repos follows, and the hooks, CI and GitHub settings enforce it.
It comes from the shared Baseline, so it's the same in every repo and is overwritten when the Baseline is applied:
change it there, not here. `CONTRIBUTING.md` and `CLAUDE.md` link here rather than repeat it.

## One-time setup

Switch on the repository's git hooks, once per clone:

```bash
git config core.hooksPath .github/hooks
```

## Branches and worktrees

Every change is made on its own branch, in its own **worktree** beside the clone. The clone itself stays on `main`, and
the pre-commit hook refuses a commit made there:

```bash
git fetch origin
git worktree add -b fix/42-null-children ../<Repo>-worktrees/fix-42-null-children origin/main
```

The folder is the branch name with `/` turned into `-`. Remove the worktree once its PR merges:
`git worktree remove ../<Repo>-worktrees/fix-42-null-children`.

| Branch | Use |
| --- | --- |
| `feature/{issue}-{slug}` | New behaviour |
| `fix/{issue}-{slug}` | A bug fix |
| `hotfix/{issue}-{slug}` | An urgent fix |
| `chore/{slug}` | Work without an issue |

`{slug}` is lowercase letters and digits in words joined by `-` (`upgrade-net10`, `oauth2-login`). A `chore/` slug
starts with a letter, so `chore/7-cleanup` is refused. The pre-push hook refuses any other name, and so does the
required **Branch name** check, which also catches a push that skipped the hook (a Claude cloud session's `claude/...`
branch, GitHub's web editor). To fix one, rename the branch on GitHub, then close and reopen the PR.

## Commits and PR titles

Commits follow [git-commit-instructions.md](../.github/instructions/git-commit-instructions.md):
`<type>(<scope>): <Summary>`, imperative, with a capital and no closing period.

The **PR title follows the same format**: it becomes the squash commit's subject on `main` and the Release's name.
The required **PR title** check enforces it on every PR but Dependabot's.

## The PR description

Use the template's headings: **Why**, **What changed** and **Verification**, and `Fixes #n` when the branch names an
issue. Write it for a reader who wasn't there.

**The description is published.** It becomes the squash commit's message, the Release's notes and the release blog
post, word for word. Keep it current: after every follow-up commit, update it so it describes the final change.

## Checks, review and merging

- **Before a push**, the pre-push hook refuses a branch that is behind `origin/main` (it fetches main first), because
  the PR couldn't merge until it's up to date: bring main in with `git merge origin/main`. Then it runs
  `scripts/gate.sh`: the lints, the build and the tests CI runs.
- **Required checks:** Build Solution, Test Suite, Branch name, PR title, actionlint, zizmor, shellcheck, markdownlint
  and yamllint. A docs-only PR skips the build and tests, and so does a Dependabot GitHub Actions bump; a skipped check
  counts as passing.
- **Copilot reviews every push**, drafts included. Resolve each thread: fix it, or reply with why not.
- **PR Auto-Merge squash-merges** a same-repo PR once its checks pass, Copilot has reviewed its latest commit and every
  thread is resolved. After three Copilot review rounds it stops waiting for Copilot, so a PR can't chase reviews forever;
  threads anyone else opens still hold it.
- **A ready PR is kept up to date.** When `main` moves on, PR Auto-Merge merges `main` into a PR that is otherwise ready
  (Dependabot rebases its own on request). The merge from `main` needs no new review when no file was changed on both
  sides; otherwise (a conflict resolved, or a file both sides changed) it waits for a new review: add `review:claude`
  if Copilot doesn't review it.
- **A draft is never merged.** Open a PR as a draft to hold it back, and mark it ready when it is.
- **Merging is squash only.** Nobody merges by hand except a fork's PR, which the maintainer merges, and a Baseline
  Standardize PR.

## Releases

Every merged PR is released, oldest first, by `release.yml`: a GitHub Release named after the PR title, and a blog post
from its description.

- **Version:** a patch by default; label the PR `semver:minor` or `semver:major` before it merges for more.
- **`[skip-release]`** in the title merges a PR without a release (the release-blog PRs carry it).
- **Dependabot bumps** merge on their own and are folded into the next Release: no Release or blog post of their own,
  but that Release contains them and its notes list them. NuGet and SDK bumps are built and tested like any PR.
