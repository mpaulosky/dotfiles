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
#      reuse it while its branch has an open PR, or was never pushed (no
#      origin/<branch>, no upstream of its own and no PR of this repo whose head
#      it carries, as after a refused first push: a branch pushed once keeps its
#      upstream, and one a PR carries is not new, even when its remote branch is
#      deleted; the earlier rounds' PRs, which share the name, don't count);
#      replace it (worktree and local branch) once its work has merged: main
#      carries its tip, or else a merged PR's head does, read from GitHub (a
#      failed read ends the run); refuse it with uncommitted work, or with
#      commits no open or merged PR carries.
#   2. Merge origin/chore/reapply-baseline (when it exists), then origin/main,
#      so the push is never non-fast-forward and the pre-push gate's
#      up-to-date check passes.
#   3. Run apply.sh and commit its output alone as the Apply commit. When it
#      changes nothing and nothing is left unpushed (an earlier failed push),
#      stop there and say so.
#   4. git push -u origin HEAD, through the repo's pre-push gate. A failed push
#      prints its log's path and exits 1. The gate lets a re-Apply through without
#      a review only when every file is Owned text; when Apply writes the coverage
#      threshold, the hand-off rules or an issue template, the gate asks for one
#      (its message names them): run /pre-push-review in the worktree, then run
#      this again.
#   5. Open the re-Apply PR (ready, not a draft), or add a line for this Apply
#      commit to the open one's description, then request Copilot's review and
#      read the request back: gh exits 0 even when GitHub drops it. A request
#      that didn't register (as when the Copilot code review budget is used up),
#      or that GitHub refused outright, is warned about, and the run still
#      passes. It never adds review:claude: the PR's checks have only just
#      started, and a Claude review costs money. land.sh asks Copilot again
#      and adds the label once the head's checks are green and Copilot can't
#      review it (its quota note, or a request that didn't register); the
#      warning prints its command. Copilot is the exact bot (a request by
#      "Copilot", a review by copilot-pull-request-reviewer[bot]), never a login
#      that merely contains "copilot". A request that didn't register also gets
#      the ask record, a PR comment from the owner's gh login, unless the PR
#      already has one (by github-actions or the owner): a PR runs its base
#      branch's workflows, and a repo's first re-Apply PR has the previous PR
#      Auto-Merge, which never posts it, so without the record Claude Review
#      would skip the PR for ever while it takes review:claude for "Copilot
#      hasn't been asked yet" (mpaulosky/dotfiles#384). A request that
#      registers needs none, and a re-run finds the record, so it is posted once.
#      A failed post only warns, and a comment list it can't read counts as no record.
#
# The head it prints and writes into the description comes from the local
# branch after the push, never from the API, which lags behind a push: name
# that head in any thread reply.
set -euo pipefail

branch="chore/reapply-baseline"
worktree_name="chore-reapply-baseline"
commit_subject="chore: Apply repo-ci-baseline Template"
co_author="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
pr_title="chore: Re-apply the repo-ci-baseline Template"
footer="🤖 Generated with [Claude Code](https://claude.com/claude-code)"
# PR Auto-Merge's COPILOT_ASKED_MARKER and landing.py's COPILOT_ASKED_COMMENT, word for word (a test holds them equal).
asked_marker="<!-- pr-automerge:copilot-asked -->"
asked_comment="Copilot's review was requested for this PR. It is asked once per PR; if GitHub drops the request, review:claude calls in Claude instead. mpaulosky/dotfiles#360"$'\n\n'"$asked_marker"
# "<n> <url>": n counts Copilot's review requests and its reviews of the head. Copilot is the exact
# bot: the Bot user "Copilot" or copilot-pull-request-reviewer, with or without gh's [bot] suffix.
# shellcheck disable=SC2016 # jq, not shell, expands $h
copilot_jq='.headRefOid as $h | "\([(.reviewRequests[] | .login // .name // ""), (.reviews[] | select(.commit.oid == $h) | .author.login)] | map(select(test("^(Copilot|copilot-pull-request-reviewer)(\\[bot\\])?$"))) | length) \(.url)"'

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
    # Read before the loop, so a gh failure ends the run (set -e) rather than reading as "no merged PR".
    merged_heads="$(gh_ pr list --head "$branch" --state merged --limit 100 --json headRefOid --jq '.[].headRefOid')"
    while IFS= read -r oid; do
      [[ -n "$oid" ]] || continue
      if g merge-base --is-ancestor "$tip" "$oid" 2>/dev/null; then merged=true; break; fi
    done <<< "$merged_heads"
  fi
  # A branch that was never pushed (the gate refused the first push, before any PR existed) has no
  # origin/<branch>, no upstream of its own (push -u sets branch.<b>.merge to refs/heads/<b>; the
  # branch below is created with --no-track, and one made another way that tracks main doesn't
  # count), and no PR that carries it. A missing origin/<branch> alone doesn't say so, since fetch
  # --prune drops it after a merge or a close deletes the remote branch, and a push without -u sets no
  # upstream. What tells those apart is a PR of this repo (not a fork's) whose head the branch carries
  # and main doesn't. The branch name is the same every round, so a PR by name alone would match the
  # earlier rounds' merged ones: heads that main has, or this branch was never built on, don't count.
  # A never-pushed branch is kept and carried on: its commits are not lost, and the push below sends
  # them. The PR lookup, like the merged one, ends the run when gh fails.
  never_pushed=false
  if ! $merged \
    && ! g rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null \
    && [[ "$(g config --get "branch.$branch.merge" || true)" != "refs/heads/$branch" ]]; then
    pr_heads="$(gh_ pr list --head "$branch" --state all --limit 100 --json headRefOid,isCrossRepository --jq '.[] | select(.isCrossRepository == false) | .headRefOid')"
    carried=false
    while IFS= read -r oid; do
      [[ -n "$oid" ]] || continue
      if g merge-base --is-ancestor "$oid" "$tip" 2>/dev/null && ! g merge-base --is-ancestor "$oid" origin/main 2>/dev/null; then carried=true; break; fi
    done <<< "$pr_heads"
    $carried || never_pushed=true
  fi
  $merged || $never_pushed || die "$branch has commits no open or merged PR carries (tip $(g rev-parse --short=7 "$tip")); land or delete them first"
  if $merged; then
    if [[ -n "$existing" ]]; then
      echo "── $repo_name: replacing $worktree, whose work has merged"
      g worktree remove "$existing"
    fi
    g branch -D "$branch" >/dev/null
    existing=""
  else
    echo "── $repo_name: $branch was never pushed; carrying it on"
  fi
fi

if [[ -n "$existing" ]]; then
  echo "── $repo_name: reusing $worktree${open_pr:+ for open PR #$open_pr}"
else
  base=origin/main
  if [[ -n "$open_pr" ]] && g rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
    base="origin/$branch"
  fi
  mkdir -p "$(dirname "$worktree")"
  if g rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    g worktree add --quiet "$worktree" "$branch"
    base="the local branch"
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

# A request GitHub refuses outright is no worse than one it drops: the
# read-back below finds no request, and the warning says so.
if ! out="$(gh_ pr edit "$pr" --add-reviewer @copilot 2>&1)"; then
  grep -qi 'already' <<< "$out" || echo "reapply.sh: warning: requesting Copilot's review on #$pr failed: $out" >&2
fi
read -r copilot url < <(gh_ pr view "$pr" --json headRefOid,reviewRequests,reviews,url --jq "$copilot_jq")
if [[ "${copilot:-0}" -gt 0 ]]; then
  echo "reapply.sh: $repo_name PR #$pr, head $head, Copilot requested"
  exit 0
fi
# Not review:claude: CI has only just started on this head, a Claude review
# costs money. land.sh adds the label once the head's checks are green if that
# request didn't register.
ref="${url#https://github.com/}"
repo_path="${ref%/pull/*}"
ref="$repo_path#$pr"
# The request didn't register, so the PR needs the ask record, or Claude Review
# ignores review:claude (mpaulosky/dotfiles#384). The base's PR Auto-Merge may be
# the previous one, which never posts it. Only a record by github-actions or the
# owner counts, as in claude-review.yml; an unreadable list counts as none, since
# a second record is harmless and a missing one stalls the PR.
owner="${repo_path%%/*}"
[[ "$owner" =~ ^[A-Za-z0-9-]+$ ]] || die "can't read the repository owner from '$url'"
records_jq=".comments | map(select((.body // \"\") | contains(\"$asked_marker\")) | select((.author.login // \"\") | ascii_downcase | sub(\"\\\\[bot\\\\]$\"; \"\") | . == \"github-actions\" or . == \"${owner,,}\")) | length"
records="$(gh_ pr view "$pr" --json comments --jq "$records_jq" 2>/dev/null || true)"
if [[ "${records:-0}" =~ ^[0-9]+$ && "${records:-0}" -gt 0 ]]; then
  echo "reapply.sh: the ask for Copilot's review is already recorded on #$pr" >&2
elif post_out="$(gh_ pr comment "$pr" --body "$asked_comment" 2>&1)"; then
  echo "reapply.sh: recorded the ask for Copilot's review on #$pr, so Claude Review can run" >&2
else
  echo "reapply.sh: warning: recording the ask for Copilot's review on #$pr failed: $post_out" >&2
fi
echo "reapply.sh: warning: Copilot's review request didn't register on #$pr (GitHub drops it once the Copilot code" \
  "review budget is used up); land.sh adds review:claude once its checks are green: land.sh $ref" >&2
echo "reapply.sh: $repo_name PR #$pr, head $head, no reviewer yet; next: land.sh $ref"
