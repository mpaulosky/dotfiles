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

- **Review before you push** (in a repo with Sandcastle, where `.sandcastle/lib/review-ledger.mts` exists: the review and its gate
  step are added only there). `/pre-push-review` (`.claude/skills/pre-push-review/`) reviews the branch's whole diff
  against `origin/main` with parallel read-only reviewers, fixes each Critical and Warning finding behind a regression test and each
  Advisory one in the review, reviews the fixes again until a round fixes nothing, and records the result under `.git/review/`. GitHub's
  reviewers are then a backstop that finds little. A Critical or Warning finding left open blocks the push until it is
  fixed or the person accepts it with `scripts/review.sh accept R3 "<reason>"`, never on their behalf. Advisory findings
  (docs, comments, conventions) never block: one that needs a person goes to one follow-up issue per branch.
- **Before a push**, the pre-push hook refuses a branch that is behind `origin/main` (it fetches main first), because
  the PR couldn't merge until it's up to date: bring main in with `git merge origin/main`. Then it runs
  `scripts/gate.sh`: the lints, the local review's check (a clean record for the diff; a clean merge of `main` keeps
  it, a new commit needs a new one), the build and the tests CI runs. `GATE_SKIP_REVIEW=1` skips the review check for
  gate runs while iterating, never for a push. Sandcastle's sandboxes set it: its own reviewer role stands in there.
- **Required checks:** Build Solution, Test Suite, Branch name, PR title, actionlint, zizmor, shellcheck, markdownlint
  and yamllint. A docs-only PR skips the build and tests, and so does a Dependabot GitHub Actions bump; a skipped check
  counts as passing.
- **Copilot reviews every push**, drafts included. Fix a thread you agree with, push the fix, then reply saying what
  changed. Resolve it if Copilot or Claude Review opened it; leave a person's thread for them. Don't resolve a thread
  before the push: PR Auto-Merge merges once the last thread is resolved, fix or not. On every other thread, whoever
  opened it (one you decline, one raising a finding someone accepted, one waiting on a person's decision), reply only
  "Left for the owner." and leave it unresolved, so the hold keeps it for the owner. The same reply on all of them
  doesn't say which thread an accepted security finding is on. (This is for people and Claude Code sessions; Sandcastle's follow-up
  pass keeps replying with its reason.) A Claude Code session ends every reply and comment it
  posts with `<!-- claude-session -->`: it posts with the owner's token, so nothing else tells its comments from the
  owner's. When a reviewer on GitHub finds a problem the local review missed, fix it with a lesson, so the next branch
  catches it locally: a test, a check in `.github/ci/gate-checks.sh`, or a sharper lens in the repo's `code-review` skill. The review's own
  `lenses.md` and `review-bar.md` are Owned, so a lesson for them goes to the Template first.
- **PR Auto-Merge squash-merges** a same-repo PR once its checks pass, Copilot has reviewed its latest commit and every
  thread is resolved. After three review rounds it stops waiting for a review of the latest commit, so a PR can't chase
  reviews forever, but every unresolved thread still holds it, Copilot's and Claude's included. At that point, once
  Claude has reviewed since `review:claude` was last added, it also takes the label off, so Claude stops reviewing new
  pushes. Re-Apply PRs are capped too. Adding the label again past the cap gets one more Claude review, but the merge
  doesn't wait for it: if the PR is otherwise ready it can merge first. A review that arrives after a merge comes too
  late, so answer its findings on the merged PR in a follow-up.
- **A ready PR is kept up to date.** When `main` moves on, PR Auto-Merge merges `main` into a PR that is otherwise ready
  (Dependabot rebases its own on request). The merge from `main` needs no new review when it is exactly what merging
  `main` gives and no file was changed on both sides; otherwise (a conflict resolved, a file both sides changed, or a
  change of its own) it waits for a new review: add `review:claude` if Copilot doesn't review it. If the label is already
  on, Claude reviews the push itself, unless a bot or app pushed it; then remove and re-add the label.
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
