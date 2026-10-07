#!/usr/bin/env bash
# Re-Apply the repo-ci-baseline Template to one Baseline repo, in its one
# re-Apply PR.
#
#   reapply.sh --brings <prs> <repo>
#
# <repo> is the repo's primary checkout (for example ~/github/TicketManager).
# <prs> names the dotfiles PRs this round brings in, comma-separated; a bare
# number or #number takes the repo named before it, mpaulosky/dotfiles by
# default: --brings mpaulosky/dotfiles#80,#81
#
# Steps, each stopping the run on failure:
#   1. Fetch, then prepare the worktree ../<Repo>-worktrees/chore-reapply-baseline:
#      reuse it while its branch has an open PR; replace it (worktree and local
#      branch) once its work has merged; refuse it with uncommitted work, or with
#      commits no open or merged PR carries.
#   2. Merge origin/chore/reapply-baseline (when it exists), then origin/main,
#      so the push is never non-fast-forward and the pre-push gate's
#      up-to-date check passes.
#   3. Run apply.sh and commit its output alone as the Apply commit. When it
#      changes nothing and nothing is left unpushed (an earlier failed push),
#      stop there and say so.
#   4. git push -u origin HEAD, through the repo's pre-push gate. A failed push
#      prints its log's path and exits 1.
#   5. Open the re-Apply PR (ready, not a draft), or add a line for this Apply
#      commit to the open one's description, then request Copilot's review.
#
# The head it prints and writes into the description comes from the local
# branch after the push, never from the API, which lags behind a push: name
# that head in any thread reply.
set -euo pipefail

branch="chore/reapply-baseline"
worktree_name="chore-reapply-baseline"
commit_subject="chore: Apply repo-ci-baseline Template"
co_author="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
pr_title="chore: Re-apply the repo-ci-baseline Template"
footer="🤖 Generated with [Claude Code](https://claude.com/claude-code)"

usage() {
  echo "usage: reapply.sh --brings <owner/repo#n,#n,...> <repo>" >&2
  exit 2
}
die() { echo "reapply.sh: $*" >&2; exit 1; }

brings_arg=""
target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --brings) [[ $# -ge 2 ]] || usage; brings_arg="$2"; shift 2 ;;
    --brings=*) brings_arg="${1#--brings=}"; shift ;;
    -h|--help) usage ;;
    -*) echo "reapply.sh: unknown option '$1'" >&2; usage ;;
    *) [[ -z "$target" ]] || usage; target="$1"; shift ;;
  esac
done
[[ -n "$target" && -n "$brings_arg" ]] || usage

# ── The dotfiles PRs this round brings in ───────────────────────────────────
brings=()
prefix="mpaulosky/dotfiles"
IFS=',' read -ra items <<< "$brings_arg"
for item in "${items[@]}"; do
  item="${item//[[:space:]]/}"
  [[ -n "$item" ]] || continue
  if [[ "$item" =~ ^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([0-9]+)$ ]]; then
    prefix="${BASH_REMATCH[1]}"
    brings+=("$prefix#${BASH_REMATCH[2]}")
  elif [[ "$item" =~ ^#?([0-9]+)$ ]]; then
    brings+=("$prefix#${BASH_REMATCH[1]}")
  else
    die "can't read '$item' in --brings; use owner/repo#n or #n"
  fi
done
[[ ${#brings[@]} -gt 0 ]] || die "--brings names no PR"
brings_text="${brings[0]}"
for ((i = 1; i < ${#brings[@]}; i++)); do
  if [[ $i -eq $((${#brings[@]} - 1)) ]]; then brings_text+=" and ${brings[i]}"; else brings_text+=", ${brings[i]}"; fi
done

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
apply="$skill_dir/apply.sh"

git -C "$target" rev-parse --is-inside-work-tree &>/dev/null || die "'$target' is not a git work tree"
# The primary checkout, even when <repo> names one of its linked worktrees.
common_dir="$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)"
primary="$(dirname "$common_dir")"
repo_name="$(basename "$primary")"
worktree="$(dirname "$primary")/$repo_name-worktrees/$worktree_name"

g() { git -C "$primary" "$@"; }
# The worktree a branch is checked out in, if any.
worktree_of() {
  g worktree list --porcelain | awk -v ref="refs/heads/$1" '
    /^worktree / { path = substr($0, 10) }
    $0 == "branch " ref { print path; exit }'
}
# gh runs in the primary checkout, so it picks the repo from origin.
gh_() { (cd "$primary" && gh "$@"); }

echo "── $repo_name: fetching"
g fetch --prune --quiet origin
g rev-parse --verify --quiet origin/main >/dev/null || die "origin/main not found in $primary"
g worktree prune

open_pr="$(gh_ pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"

# ── 1. The worktree ─────────────────────────────────────────────────────────
existing="$(worktree_of "$branch")"
if [[ -n "$existing" && "$existing" != "$worktree" ]]; then
  die "$branch is checked out in $existing, not $worktree; move it with git worktree move"
fi
if [[ -z "$existing" && -e "$worktree" ]]; then
  die "$worktree exists but isn't the worktree of $branch; remove it first"
fi
if [[ -n "$existing" && -n "$(git -C "$existing" status --porcelain)" ]]; then
  die "$existing has uncommitted work; commit or stash it, then run again"
fi

if g rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && [[ -z "$open_pr" ]]; then
  # No open PR: the local branch is replaced only when nothing on it is lost,
  # that is, when a merged PR's head carries its tip or main already does.
  tip="$(g rev-parse "refs/heads/$branch")"
  merged=false
  if g merge-base --is-ancestor "$tip" origin/main; then
    merged=true
  else
    while IFS= read -r oid; do
      [[ -n "$oid" ]] || continue
      if g merge-base --is-ancestor "$tip" "$oid" 2>/dev/null; then merged=true; break; fi
    done < <(gh_ pr list --head "$branch" --state merged --limit 100 --json headRefOid --jq '.[].headRefOid')
  fi
  $merged || die "$branch has commits no open or merged PR carries (tip $(g rev-parse --short=7 "$tip")); land or delete them first"
  if [[ -n "$existing" ]]; then
    echo "── $repo_name: replacing $worktree, whose work has merged"
    g worktree remove "$existing"
  fi
  g branch -D "$branch" >/dev/null
  existing=""
fi

if [[ -n "$existing" ]]; then
  echo "── $repo_name: reusing $worktree for open PR #$open_pr"
else
  base=origin/main
  if [[ -n "$open_pr" ]] && g rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
    base="origin/$branch"
  fi
  mkdir -p "$(dirname "$worktree")"
  if g rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    g worktree add --quiet "$worktree" "$branch"
  else
    g worktree add --quiet --no-track -b "$branch" "$worktree" "$base"
  fi
  echo "── $repo_name: worktree $worktree on $branch from $base"
fi

w() { git -C "$worktree" "$@"; }

# ── 2. Up to date with the remote branch and main ───────────────────────────
for ref in "origin/$branch" origin/main; do
  w rev-parse --verify --quiet "refs/remotes/$ref" >/dev/null || continue
  w merge-base --is-ancestor "$ref" HEAD && continue
  echo "── $repo_name: merging $ref"
  if ! w merge --quiet --no-edit "$ref"; then
    w merge --abort 2>/dev/null || true
    die "merging $ref into $branch conflicts; resolve it in $worktree by hand"
  fi
done

# ── 3. The Apply commit ─────────────────────────────────────────────────────
echo "── $repo_name: apply.sh"
"$apply" "$worktree"
w add -A
if ! w diff --cached --quiet; then
  w commit --quiet -m "$commit_subject" -m "$co_author"
else
  # Nothing new, but an Apply commit a failed push left behind still goes out.
  pushed=origin/main
  w rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null && pushed="origin/$branch"
  if w merge-base --is-ancestor HEAD "$pushed"; then
    echo "reapply.sh: $repo_name already matches the Template; nothing to commit or push"
    exit 0
  fi
  echo "── $repo_name: apply.sh changed nothing; pushing the commits $pushed lacks"
fi

# ── 4. Push through the pre-push gate ───────────────────────────────────────
log="$(mktemp "${TMPDIR:-/tmp}/reapply-$repo_name.XXXXXX.log")"
echo "── $repo_name: pushing through the pre-push gate (log: $log)"
if ! w push -u origin HEAD > "$log" 2>&1; then
  echo "reapply.sh: push failed for $repo_name; log: $log" >&2
  tail -n 20 "$log" >&2
  exit 1
fi
# The pushed head, from the local branch: the API lags behind the push.
head="$(w rev-parse --short=7 HEAD)"
changed="$(w show --name-status --format= HEAD | awk '{ printf "  - `%s` %s\n", $NF, ($1 == "A" ? "(added)" : "") }' | sed 's/ $//')"

# ── 5. The re-Apply PR ──────────────────────────────────────────────────────
body_file="$(mktemp)"
trap 'command rm -f "$body_file"' EXIT
apply_line="- \`$head\` Apply commit, \`apply.sh\` output alone: brings $brings_text."
if [[ -z "$open_pr" ]]; then
  cat > "$body_file" <<EOF
## Why

Re-Apply the repo-ci-baseline Template so this repo carries the Template changes from $brings_text.

## What changed

$apply_line
$changed

## Verification

- The Apply commit is exactly \`apply.sh\`'s output on a branch up to date with \`main\`.
- The pre-push gate (\`scripts/gate.sh\`) passed on \`$head\`.

$footer
EOF
  url="$(gh_ pr create --base main --head "$branch" --title "$pr_title" --body-file "$body_file")"
  pr="${url##*/}"
  [[ "$pr" =~ ^[0-9]+$ ]] || die "gh pr create printed '$url', not a PR URL"
  echo "── $repo_name: opened PR #$pr ($url)"
else
  pr="$open_pr"
  gh_ pr view "$pr" --json body --jq .body > "$body_file.old"
  # The new line goes before the Claude Code footer, or at the end.
  awk -v line="$apply_line" -v footer="$footer" '
    $0 == footer && !done { print line; print ""; done = 1 }
    { print }
    END { if (!done) { print ""; print line } }' "$body_file.old" > "$body_file"
  command rm -f "$body_file.old"
  gh_ pr edit "$pr" --body-file "$body_file" >/dev/null
  echo "── $repo_name: added $head to PR #$pr's description"
fi

if ! out="$(gh_ pr edit "$pr" --add-reviewer @copilot 2>&1)"; then
  grep -qi 'already' <<< "$out" || die "requesting Copilot's review on #$pr failed: $out"
fi
echo "reapply.sh: $repo_name PR #$pr, head $head, Copilot requested"
