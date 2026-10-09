#!/usr/bin/env bash
# Fast-forward the primary checkout of every git repo under ~/github to its
# origin's default branch, so a PR that merges on GitHub shows up locally.
#
#   sync-github-repos.sh            sync every repo directly under $GITHUB_ROOT
#
# sync-github-repos.timer runs it every few minutes. It only ever runs
# `git merge --ff-only`: a checkout that is on another branch, has local
# changes (untracked files included), has commits of its own, or is in the
# middle of a merge or rebase is skipped and logged, never merged, stashed or
# reset. Worktrees (whose .git is a file) are left alone. A repo that is
# already up to date logs nothing, so the journal only shows real work.
set -uo pipefail

ROOT="${GITHUB_ROOT:-$HOME/github}"

log() { printf '%s: %s\n' "$1" "$2"; }

for dir in "$ROOT"/*/; do
  dir=${dir%/}
  name=${dir##*/}
  [ -d "$dir/.git" ] || continue
  g() { git -C "$dir" "$@"; }
  g remote get-url origin >/dev/null 2>&1 || continue

  if ! g fetch --quiet --prune origin 2>/dev/null; then
    log "$name" "skipped: fetch failed"
    continue
  fi
  default=$(g symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  default=${default#origin/}
  if [ -z "$default" ]; then
    log "$name" "skipped: origin/HEAD isn't set (run: git -C '$dir' remote set-head origin --auto)"
    continue
  fi

  behind=$(g rev-list --count "HEAD..origin/$default" 2>/dev/null || echo 0)
  [ "$behind" = 0 ] && continue

  branch=$(g branch --show-current)
  if [ "$branch" != "$default" ]; then
    log "$name" "skipped: on '${branch:-detached HEAD}', not $default ($behind behind)"
    continue
  fi
  gitdir=$(g rev-parse --absolute-git-dir)
  busy=""
  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
    [ -e "$gitdir/$marker" ] && busy=$marker
  done
  if [ -n "$busy" ]; then
    log "$name" "skipped: an operation is in progress ($busy)"
    continue
  fi
  if [ -n "$(g status --porcelain)" ]; then
    log "$name" "skipped: local changes ($behind behind)"
    continue
  fi
  ahead=$(g rev-list --count "origin/$default..HEAD")
  if [ "$ahead" != 0 ]; then
    log "$name" "skipped: $ahead local commit(s) not on origin/$default ($behind behind)"
    continue
  fi

  if g merge --ff-only --quiet "origin/$default" 2>/dev/null; then
    log "$name" "fast-forwarded $behind commit(s) to $(g rev-parse --short HEAD)"
  else
    log "$name" "skipped: fast-forward failed"
  fi
done
