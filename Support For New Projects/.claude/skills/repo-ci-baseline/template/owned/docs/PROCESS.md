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
  (docs, comments, conventions) never block: one that needs a person goes to one follow-up issue per branch. For a large or
  risky branch that one review and a round of fixes won't settle, `/hardening-review` (`.claude/skills/hardening-review/`) repeats full
  passes until one fixes nothing, then records once: the gate asks for that one record all the same.
- **Before a push**, the pre-push hook refuses a branch that is behind `origin/main` (it fetches main first), because
  the PR couldn't merge until it's up to date: bring main in with `git merge origin/main`. Then it runs
  `scripts/gate.sh`: the lints, the local review's check (a clean record for the diff; a clean merge of `main` keeps
  it, a new commit needs a new one), the build and the tests CI runs. `GATE_SKIP_REVIEW=1` skips the review check for
  gate runs while iterating, never for a push. Sandcastle's sandboxes set it: its own reviewer role stands in there.
- **Required checks:** Build Solution, Test Suite, Branch name, PR title, actionlint, zizmor, shellcheck, markdownlint
  and yamllint. A docs-only PR skips the build and tests, and so does a Dependabot GitHub Actions bump; a skipped check
  counts as passing.
- **Copilot reviews every push**, drafts included. Fix a thread you agree with, push the fix, then reply naming the fixing
  commit by its short SHA (7 characters) and saying what changed (`Fixed in 1a2b3c4: <what changed>.`), so the PR documents
  its fixes. Resolve it if Copilot or Claude Review opened it; leave a person's thread for them. A Copilot or Claude Review
  thread resolved without a reply is flagged, in PR Auto-Merge's log and in `status.sh` and `land.sh`, but it doesn't hold the merge. Don't resolve a thread
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
  thread is resolved. It asks Copilot for a review of the PR once; where Copilot can't review a head (a quota note, or a request that didn't
  register, which it reads back, or 30 seconds after the ask with no review or request showing), it adds `review:claude` itself and accepts Claude's review instead.
  Copilot isn't asked again for that PR.
  A round is a review of a commit of yours (a merge of `main` into the PR is never one), and it is dirty when it raised
  a thread or a finding outside the diff. Every new commit nobody reviewed gets a review, until three dirty rounds in a
  row exhaust the loop (a clean round starts the count over). Then PR Auto-Merge takes `review:claude` off, posts one
  comment on the PR (once it is ready) saying whether its head was reviewed and listing every thread and finding still
  open, and merges the PR once its required checks pass and it has no conflict. The threads Copilot and Claude Review
  opened don't hold it, so answer them on the merged PR in a follow-up; a thread opened by a person still does, and the
  comment says which. Re-Apply PRs are bounded the same way. To start a new loop on a PR that is still open and where
  Copilot can't review the head, add `review:claude` again, as a login with write access to the repository
  (mpaulosky/dotfiles#375, mpaulosky/dotfiles#378); PR Auto-Merge never adds it while that comment is the newest word.
  `review:claude` is ignored while Copilot can review: it calls Claude in only where Copilot can't (its quota note
  is on the head, or its request didn't register), and PR Auto-Merge takes the label off at once otherwise, whoever
  added it.
- **A ready PR is kept up to date.** When `main` moves on, PR Auto-Merge merges `main` into a PR that is otherwise ready
  (Dependabot rebases its own on request). The merge from `main` needs no new review when it is exactly what merging
  `main` gives and no file was changed on both sides; otherwise (a conflict resolved, a file both sides changed, or a
  change of its own) it waits for a new review: Copilot's, or `review:claude` where Copilot can't review it. If the label
  is already on, Claude reviews the push itself, unless a bot or app pushed it; then remove and re-add the label.
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
