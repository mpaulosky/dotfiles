# Skill: Merged-PR Branch Guard

## Confidence
`high`

## Problem
When an agent or Scribe attempts to commit to a `squad/*` branch whose PR has already been merged, the commit either targets a deleted/stale branch or diverges from `main`. This causes stranded commits and orphaned history.

## Solution
Before any `git commit` on a `squad/*` branch, check whether that branch's PR has been merged. If merged, sync to `main` first.

## Pattern

```bash
CURRENT_BRANCH=$(git branch --show-current)
MERGED=$(gh pr list --head "$CURRENT_BRANCH" --state merged --json number --limit 1)

if [ -n "$MERGED" ] && [ "$MERGED" != "[]" ]; then
  # PR is already merged — move to main
  git checkout main
  git pull origin main
  # now commit here instead
fi

# proceed with commit on whichever branch is now active
git add .squad/
git commit -F "$COMMIT_MSG_FILE"
```

## When to Apply
- **Scribe** — always apply before Step 6 (GIT COMMIT) in its responsibilities
- **Any agent** that does its own `git commit` at the end of issue work

## Why It Works
`gh pr list --head {branch} --state merged` returns an empty array `[]` when no merged PR exists for that branch, and a populated array when one does. Non-empty + non-`[]` means the PR is merged.

## Observed In
- Session where Scribe committed `.squad/` changes to `squad/unit-tests-split` after PR #95 was merged — commit stranded on a re-created branch instead of flowing to `main`
- Established as a standing process rule after PR #95/PR #96 session
