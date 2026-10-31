#!/usr/bin/env bash
# Tests for reapply.sh's local half, against a throwaway repo whose origin is a
# bare repo, a copy of the skill with a small stand-in Template, and a fake gh
# on PATH. The stand-in Template's pre-push hook stands in for the gate: it
# logs each run, and fails while $stub/fail-push exists.
# check() evals its condition string later, so the single quotes are deliberate
# and the variables it reads look unused to shellcheck.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v jq >/dev/null || { echo "reapply.test.sh: jq is not installed; skipped" >&2; exit 0; }
work="$(mktemp -d)"
trap 'command rm -rf "$work"' EXIT

pass=0
failed=0
ok() { pass=$((pass + 1)); }
bad() { echo "FAIL: $1" >&2; failed=$((failed + 1)); }
check() { if eval "$2"; then ok; else bad "$1"; fi; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export TMPDIR="$work/tmp"
mkdir -p "$TMPDIR"

# ── A skill copy with a stand-in Template ───────────────────────────────────
skill="$work/skill"
mkdir -p "$skill/template/owned/.github/hooks" "$skill/template/owned/.github/workflows" "$skill/template/seed/docs"
command cp -f "$skill_dir/apply.sh" "$skill_dir/reapply.sh" "$skill/"
printf 'name: CI\n' > "$skill/template/owned/.github/workflows/ci.yml"
printf '# {{REPO}} security policy\n' > "$skill/template/seed/docs/SECURITY.md"
stub="$work/stub"
mkdir -p "$stub"
cat > "$skill/template/owned/.github/hooks/pre-push" <<EOF
#!/usr/bin/env bash
echo gate >> "$stub/push.log"
if [[ -e "$stub/fail-push" ]]; then echo "gate: the build failed"; exit 1; fi
EOF
chmod +x "$skill/template/owned/.github/hooks/pre-push"
reapply="$skill/reapply.sh"

# ── A fake gh: answers from files in $stub and logs every call ──────────────
# $stub/open is the open PR's number (empty for none), $stub/merged the merged
# PRs' head commits, $stub/body the PR description. `pr view --json ...` serves
# canned JSON and runs the real jq on the --jq argument, so reapply.sh's own
# filters are exercised. Copilot's review request reads back as registered (a
# request by "Copilot") unless $stub/dropped exists (GitHub accepts it and drops
# it); while $stub/request-fails exists, the request call itself fails and
# nothing registers. $stub/requests (one login per line) and $stub/reviews
# (logins of the reviews of the head) override what the PR holds.
# $stub/comments.json holds the PR's comments; `pr comment` appends one by the
# owner (acme) and keeps its body in $stub/comment-body, unless
# $stub/comment-fails exists. While $stub/comments-fail exists, reading the
# comments fails. While $stub/merged-fails exists, listing the merged PRs fails.
# $stub/all-prs is the JSON list of the PRs in any state for the branch name, each
# {headRefOid, isCrossRepository}; the real jq runs on the --jq argument. While
# $stub/all-fails exists, listing them fails. While $stub/open-cross exists, the open PR
# lists as a fork's (isCrossRepository true). $stub/open must hold a number.
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
stub="@STUB@"
printf '%s\n' "$*" >> "$stub/gh.log"
body_from() { while [[ $# -gt 0 ]]; do [[ "$1" == --body-file ]] && cp "$2" "$stub/body"; shift; done; }
arg_after() { local flag="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$flag" ]] && { printf '%s' "$2"; return; }; shift; done; }
logins_json() { jq -Rn '[inputs | select(length > 0)]'; }
case "$1 $2" in
  "pr list")
    case "$*" in
      *"--state open"*)
        # $stub/open is a PR number; it lists as a PR of this repo unless $stub/open-cross exists (a fork's).
        n="$(cat "$stub/open" 2>/dev/null || true)"
        if [[ -n "$n" ]]; then
          cross=false; [[ -e "$stub/open-cross" ]] && cross=true
          jq -nr --argjson n "$n" --argjson c "$cross" "[{number: \$n, isCrossRepository: \$c}] | $(arg_after --jq "$@")"
        fi ;;
      *"--state merged"*)
        if [[ -e "$stub/merged-fails" ]]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
        cat "$stub/merged" 2>/dev/null ;;
      *"--state all"*)
        if [[ -e "$stub/all-fails" ]]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
        if [[ -s "$stub/all-prs" ]]; then jq -r "$(arg_after --jq "$@")" "$stub/all-prs"; fi ;;
    esac ;;
  "pr create") body_from "$@"; echo "https://github.com/acme/Widget/pull/7" ;;
  "pr view")
    if [[ "$*" == *"--json headRefOid,reviewRequests,reviews,url"* ]]; then
      if [[ -e "$stub/requests" ]]; then requests="$(logins_json < "$stub/requests")"
      elif [[ -e "$stub/dropped" || -e "$stub/request-fails" ]]; then requests='[]'
      else requests='["Copilot"]'; fi
      reviews='[]'
      [[ -e "$stub/reviews" ]] && reviews="$(logins_json < "$stub/reviews")"
      json="$(jq -n --argjson rq "$requests" --argjson rv "$reviews" '{
        headRefOid: "abc123", url: "https://github.com/acme/Widget/pull/7",
        reviewRequests: ($rq | map({login: .})),
        reviews: ($rv | map({author: {login: .}, commit: {oid: "abc123"}}))}')"
      jq -r "$(arg_after --jq "$@")" <<< "$json"
    elif [[ "$*" == *"--json comments"* ]]; then
      if [[ -e "$stub/comments-fail" ]]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
      jq -r "$(arg_after --jq "$@")" <<< "{\"comments\": $(cat "$stub/comments.json")}"
    else
      cat "$stub/body"
    fi ;;
  "pr comment")
    if [[ -e "$stub/comment-fails" ]]; then echo "HTTP 403: Resource not accessible" >&2; exit 1; fi
    text="$(arg_after --body "$@")"
    printf '%s' "$text" > "$stub/comment-body"
    jq --arg b "$text" '. + [{author: {login: "acme"}, body: $b}]' "$stub/comments.json" > "$stub/comments.tmp"
    mv "$stub/comments.tmp" "$stub/comments.json" ;;
  "pr edit")
    body_from "$@"
    if [[ "$*" == *"--add-reviewer"* && -e "$stub/already" ]]; then
      echo "reviewer already requested" >&2; exit 1
    fi
    if [[ "$*" == *"--add-reviewer"* && -e "$stub/request-fails" ]]; then
      echo "GraphQL: Could not add requested reviewers to pull request. (requestReviewsByLogin)" >&2; exit 1
    fi ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
sed -i "s|@STUB@|$stub|" "$work/bin/gh"
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

# Hooks off for the test's own git calls.
git_q() { git -c core.hooksPath=/dev/null "$@"; }
reset_gh() {
  : > "$stub/gh.log"; : > "$stub/open"; : > "$stub/merged"; : > "$stub/all-prs"; echo '[]' > "$stub/comments.json"
  command rm -f "$stub/already" "$stub/dropped" "$stub/request-fails" "$stub/requests" "$stub/reviews" \
    "$stub/comment-fails" "$stub/comments-fail" "$stub/comment-body" "$stub/merged-fails" "$stub/all-fails" "$stub/open-cross"
}

# ── The repo: a bare origin, its primary checkout on main, and a helper clone
# that plays GitHub (squash merges, update-branch) ──────────────────────────
origin="$work/origin.git"
git init -q --bare -b main "$origin"
repo="$work/Widget"
git_q clone -q "$origin" "$repo" 2>/dev/null
git -C "$repo" switch -q -c main 2>/dev/null || true
printf '# Widget\n' > "$repo/README.md"
git_q -C "$repo" add -A
git_q -C "$repo" commit -q -m "init"
git_q -C "$repo" push -q origin main
hub="$work/hub"
git_q clone -q "$origin" "$hub"
wt="$work/Widget-worktrees/chore-reapply-baseline"

# ── A first run: a fresh worktree, the Apply commit, a new PR ───────────────
reset_gh
out="$("$reapply" --brings mpaulosky/dotfiles#80,#81 "$repo" 2>&1)" && rc=0 || rc=$?
check "first run: succeeds" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "first run: worktree on the branch" \
  '[[ "$(git -C "$wt" symbolic-ref --short HEAD)" == chore/reapply-baseline ]]'
check "first run: primary checkout stays on main" '[[ "$(git -C "$repo" symbolic-ref --short HEAD)" == main ]]'
message="$(printf 'chore: Apply repo-ci-baseline Template\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>')"
check "first run: Apply commit message" '[[ "$(git -C "$wt" log -1 --format=%B)" == "$message" ]]'
check "first run: Apply commit sits on main" '[[ "$(git -C "$wt" rev-parse HEAD~1)" == "$(git -C "$repo" rev-parse origin/main)" ]]'
check "first run: Apply commit is apply.sh output alone" \
  '[[ "$(git -C "$wt" show --name-only --format= HEAD | LC_ALL=C sort | tr "\n" " ")" == ".github/hooks/pre-push .github/workflows/ci.yml docs/SECURITY.md " ]]'
check "first run: pushed through the gate" '[[ "$(cat "$stub/push.log")" == gate ]]'
check "first run: pushed to origin" \
  '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]]'
head="$(git -C "$wt" rev-parse --short=7 HEAD)"
check "first run: PR opened ready, with the title" \
  'grep -q "^pr create .*--title chore: Re-apply the repo-ci-baseline Template" "$stub/gh.log" && ! grep -q -- "--draft" "$stub/gh.log"'
check "first run: body names the dotfiles PRs" 'grep -q "mpaulosky/dotfiles#80 and mpaulosky/dotfiles#81" "$stub/body"'
check "first run: body names the local head" 'grep -q "\`$head\` Apply commit" "$stub/body"'
check "first run: body has its sections and footer" \
  'grep -q "^## Why" "$stub/body" && grep -q "^## What changed" "$stub/body" && grep -q "^## Verification" "$stub/body" && [[ "$(tail -n1 "$stub/body")" == "🤖 Generated with [Claude Code](https://claude.com/claude-code)" ]]'
check "first run: Copilot requested" 'grep -qx "pr edit 7 --add-reviewer @copilot" "$stub/gh.log"'
check "first run: Copilot's request read back" 'grep -q "^pr view 7 --json headRefOid,reviewRequests,reviews,url" "$stub/gh.log"'
check "first run: reports the local head" 'grep -q "head $head" <<< "$out"'

# ── Nothing new in the Template: stops without a commit or a push ───────────
reset_gh
echo 7 > "$stub/open"
before="$(git -C "$wt" rev-parse HEAD)"
out="$("$reapply" --brings '#82' "$repo" 2>&1)" && rc=0 || rc=$?
check "no change: succeeds and says so" '[[ $rc -eq 0 ]] && grep -q "already matches the Template" <<< "$out"'
check "no change: no commit" '[[ "$(git -C "$wt" rev-parse HEAD)" == "$before" ]]'
check "no change: no push" '[[ "$(wc -l < "$stub/push.log")" -eq 1 ]]'

# ── Uncommitted work: refused, nothing touched ──────────────────────────────
echo wip > "$wt/wip.txt"
out="$("$reapply" --brings '#82' "$repo" 2>&1)" && rc=0 || rc=$?
check "uncommitted: refused" '[[ $rc -ne 0 ]] && grep -q "uncommitted work" <<< "$out"'
check "uncommitted: work kept" '[[ -f "$wt/wip.txt" ]]'
command rm -f "$wt/wip.txt"

# ── Open PR: main moved and the remote branch was updated on GitHub ─────────
reset_gh
echo 7 > "$stub/open"
printf 'pr #7 description\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n' > "$stub/body"
git_q -C "$hub" pull -q origin main
printf 'feature\n' > "$hub/feature.txt"
git_q -C "$hub" add -A && git_q -C "$hub" commit -q -m "feat: other work"
git_q -C "$hub" push -q origin main
git_q -C "$hub" fetch -q origin
git_q -C "$hub" switch -q -c chore/reapply-baseline origin/chore/reapply-baseline
git_q -C "$hub" merge -q --no-edit main   # gh pr update-branch
git_q -C "$hub" push -q origin chore/reapply-baseline
printf 'name: CI v2\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings mpaulosky/dotfiles#82 "$repo" 2>&1)" && rc=0 || rc=$?
check "open PR: succeeds" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "open PR: worktree reused" 'grep -q "reusing" <<< "$out"'
check "open PR: remote branch merged" \
  'git -C "$wt" merge-base --is-ancestor "$(git -C "$hub" rev-parse HEAD)" HEAD'
check "open PR: main merged" 'git -C "$wt" merge-base --is-ancestor "$(git -C "$hub" rev-parse main)" HEAD'
check "open PR: Apply commit is apply.sh output alone" \
  '[[ "$(git -C "$wt" show --name-only --format= HEAD)" == .github/workflows/ci.yml ]]'
check "open PR: push fast-forwarded the remote branch" \
  '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]]'
head="$(git -C "$wt" rev-parse --short=7 HEAD)"
check "open PR: no second PR" '! grep -q "^pr create" "$stub/gh.log"'
check "open PR: description gains the Apply line before the footer" \
  '[[ "$(grep -n "\`$head\` Apply commit.*mpaulosky/dotfiles#82" "$stub/body" | cut -d: -f1)" -lt "$(grep -n "Generated with" "$stub/body" | cut -d: -f1)" ]]'
check "open PR: earlier description kept" 'grep -q "pr #7 description" "$stub/body"'
check "open PR: Copilot requested" 'grep -qx "pr edit 7 --add-reviewer @copilot" "$stub/gh.log"'

# ── A failed push: the log is named, no PR is touched ───────────────────────
reset_gh
echo 7 > "$stub/open"
touch "$stub/fail-push"
printf 'name: CI v3\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#83' "$repo" 2>&1)" && rc=0 || rc=$?
log="$(sed -n 's/.*push failed for Widget; log: //p' <<< "$out")"
check "push fails: exits non-zero" '[[ $rc -ne 0 ]]'
check "push fails: names its log" '[[ -n "$log" && -f "$log" ]] && grep -q "the build failed" "$log"'
check "push fails: PR untouched" '! grep -q "^pr \(create\|edit\)" "$stub/gh.log"'
command rm -f "$stub/fail-push"
# The unpushed Apply commit goes out with the next run.
reset_gh
echo 7 > "$stub/open"
touch "$stub/already"
left="$(git -C "$wt" rev-parse HEAD)"
out="$("$reapply" --brings '#83' "$repo" 2>&1)" && rc=0 || rc=$?
check "push retry: Copilot already requested is tolerated" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "push retry: the left-behind Apply commit is pushed" \
  '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]]'
check "push retry: no second Apply commit" '[[ "$(git -C "$wt" rev-parse HEAD)" == "$left" ]]'

# ── The PR merged: worktree and branch replaced from main ───────────────────
git_q -C "$hub" fetch -q origin
git_q -C "$hub" switch -q main
git_q -C "$hub" merge -q --ff-only origin/main
old_tip="$(git -C "$origin" rev-parse chore/reapply-baseline)"
git_q -C "$hub" merge -q --squash origin/chore/reapply-baseline >/dev/null
git_q -C "$hub" commit -q -m "chore: Re-apply the repo-ci-baseline Template (#7)"
git_q -C "$hub" push -q origin main
git_q -C "$hub" push -q origin --delete chore/reapply-baseline
git_q -C "$hub" branch -q -D chore/reapply-baseline
reset_gh
echo "$old_tip" > "$stub/merged"
printf 'name: CI v4\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#84' "$repo" 2>&1)" && rc=0 || rc=$?
check "merged: succeeds" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "merged: worktree replaced" 'grep -q "replacing" <<< "$out"'
check "merged: new branch starts at main" \
  '[[ "$(git -C "$wt" rev-parse HEAD~1)" == "$(git -C "$hub" rev-parse main)" ]]'
check "merged: old branch gone from its history" '! git -C "$wt" merge-base --is-ancestor "$old_tip" HEAD'
check "merged: Apply commit is apply.sh output alone" \
  '[[ "$(git -C "$wt" show --name-only --format= HEAD)" == .github/workflows/ci.yml ]]'
check "merged: new PR opened" 'grep -q "^pr create" "$stub/gh.log"'

# ── Copilot's request dropped: no label from reapply.sh; land.sh adds review:claude once checks are green
reset_gh
echo 7 > "$stub/open"
touch "$stub/dropped"
printf 'name: CI v5\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "dropped: exits 0" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "dropped: never adds review:claude" '! grep -q -- "--add-label" "$stub/gh.log"'
check "dropped: warns that Copilot wasn't requested and land.sh adds review:claude once checks are green" \
  'grep -q "warning: Copilot.s review request didn.t register on #7 (GitHub drops it once the Copilot code review budget is used up); land.sh adds review:claude once its checks are green: land.sh acme/Widget#7" <<< "$out"'
check "dropped: does not claim Copilot was requested" '! grep -q "Copilot requested" <<< "$out"'
check "dropped: names land.sh as the next step" 'grep -q "no reviewer yet; next: land.sh acme/Widget#7" <<< "$out"'
check "dropped: the Apply commit is pushed and the PR updated" \
  '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]] && grep -q "^pr edit 7 --body-file" "$stub/gh.log"'

# ── Copilot's request call fails outright: warned, no label ─────────────────
reset_gh
echo 7 > "$stub/open"
touch "$stub/request-fails"
printf 'name: CI v7\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "request fails: exits 0" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "request fails: never adds review:claude" '! grep -q -- "--add-label" "$stub/gh.log"'
check "request fails: warns with gh's message" \
  'grep -q "warning: requesting Copilot.s review on #7 failed: GraphQL: Could not add requested reviewers" <<< "$out"'
check "request fails: names land.sh as the next step" 'grep -q "next: land.sh acme/Widget#7" <<< "$out"'

# ── The ask record (mpaulosky/dotfiles#384) ─────────────────────────────────
# A re-Apply PR runs its base's workflows, which are the previous PR Auto-Merge
# and never record that Copilot was asked. So when the request doesn't register,
# reapply.sh posts the record as the owner (Claude Review ignores review:claude
# until the PR carries it); land.sh then adds review:claude. A request that
# registers needs none.
marker='<!-- pr-automerge:copilot-asked -->'
expected_comment="$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import landing; sys.stdout.write(landing.COPILOT_ASKED_COMMENT)' "$skill_dir/github")"
ci_round=0
# Another Template change (so the run isn't "nothing to commit") against the PR
# and the stub as they are; sets out and rc.
rerun() {
  ci_round=$((ci_round + 1))
  printf 'name: CI ask %s\n' "$ci_round" > "$skill/template/owned/.github/workflows/ci.yml"
  : > "$stub/gh.log"
  out="$("$reapply" --brings '#90' "$repo" 2>&1)" && rc=0 || rc=$?
}
# A fresh PR state, then rerun.
scenario() { reset_gh; echo 7 > "$stub/open"; rerun; }
comments_posted() { grep -c '^pr comment ' "$stub/gh.log" || true; }
marker_comments() { jq '[.[] | select(.body | contains("<!-- pr-automerge:copilot-asked -->"))] | length' "$stub/comments.json"; }

# Criterion 1: a request that registers needs no record.
scenario
check "ask record, request registers: exits 0 and says Copilot requested" '[[ $rc -eq 0 ]] && grep -q "Copilot requested" <<< "$out"'
check "ask record, request registers: no comment posted" '[[ "$(comments_posted)" -eq 0 ]]'
scenario_reg() { # registers as: $1
  reset_gh; echo 7 > "$stub/open"; printf '%s\n' "$1" > "$stub/requests"; rerun
}
scenario_reg copilot-pull-request-reviewer[bot]
check "ask record, request by copilot-pull-request-reviewer[bot] registers: no comment posted" '[[ $rc -eq 0 && "$(comments_posted)" -eq 0 ]]'
reset_gh; echo 7 > "$stub/open"; : > "$stub/requests"; echo copilot-pull-request-reviewer[bot] > "$stub/reviews"; rerun
check "ask record, a review of the head by copilot-pull-request-reviewer[bot] counts as registered: no comment posted" \
  '[[ $rc -eq 0 && "$(comments_posted)" -eq 0 ]]'

# Criterion 1: a request that doesn't register gets the record, once.
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped"; rerun
check "ask record, request dropped: exits 0" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "ask record, request dropped: one comment posted on #7" '[[ "$(comments_posted)" -eq 1 ]] && grep -q "^pr comment 7 --body " "$stub/gh.log"'
check "ask record, request dropped: the comment is landing.py's ask comment, marker included" \
  '[[ "$(cat "$stub/comment-body" 2>/dev/null)" == "$expected_comment" && "$expected_comment" == *"$marker" ]]'
check "ask record, request dropped: the record is by the owner and counts once" '[[ "$(marker_comments)" -eq 1 ]]'
check "ask record, request dropped: still never adds review:claude" '! grep -q -- "--add-label" "$stub/gh.log"'
check "ask record, request dropped: the warning says the ask is recorded and land.sh adds review:claude" \
  'grep -q "didn.t register on #7" <<< "$out" && grep -qi "recorded" <<< "$out" && grep -q "land.sh acme/Widget#7" <<< "$out"'
# Same PR, run again with the record in place: not posted twice.
rerun
check "ask record, re-run: exits 0, still warns the request didn't register" '[[ $rc -eq 0 ]] && grep -q "didn.t register on #7" <<< "$out"'
check "ask record, re-run: no second comment" '[[ "$(comments_posted)" -eq 0 && "$(marker_comments)" -eq 1 ]]'
check "ask record, re-run: says the record was already there" 'grep -qi "already recorded" <<< "$out"'

reset_gh; echo 7 > "$stub/open"; touch "$stub/request-fails"; rerun
check "ask record, request refused: exits 0 and posts one comment, the ask comment" \
  '[[ $rc -eq 0 && "$(comments_posted)" -eq 1 && "$(cat "$stub/comment-body" 2>/dev/null)" == "$expected_comment" ]]'
rerun
check "ask record, request refused, re-run: no second comment" '[[ "$(comments_posted)" -eq 0 && "$(marker_comments)" -eq 1 ]]'

# Only a record by github-actions or the owner counts, as in claude-review.yml.
seed_comment() { # login, body
  jq --arg l "$1" --arg b "$2" '. + [{author: {login: $l}, body: $b}]' "$stub/comments.json" > "$stub/comments.tmp"
  mv "$stub/comments.tmp" "$stub/comments.json"
}
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped"; seed_comment mallory "$marker"; rerun
check "ask record: a marker comment by a stranger is no record, so one is posted" '[[ "$(comments_posted)" -eq 1 ]]'
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped"; seed_comment "github-actions[bot]" "$marker"; rerun
check "ask record: a record by github-actions[bot] counts, so none is posted" '[[ $rc -eq 0 && "$(comments_posted)" -eq 0 ]]'
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped"; seed_comment github-actions "$marker"; rerun
check "ask record: a record by github-actions counts, so none is posted" '[[ "$(comments_posted)" -eq 0 ]]'
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped"; seed_comment acme "$marker"; rerun
check "ask record: a record by the owner counts, so none is posted" '[[ "$(comments_posted)" -eq 0 ]]'
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped"; seed_comment acme "a comment with no marker"; rerun
check "ask record: an owner comment without the marker is no record, so one is posted" '[[ "$(comments_posted)" -eq 1 ]]'

# Copilot is the exact bot: a login that merely contains "copilot" is nobody's request.
reset_gh; echo 7 > "$stub/open"; echo copilot-x > "$stub/requests"; rerun
check "ask record: a request by copilot-x is not Copilot's, so the record is posted" '[[ "$(comments_posted)" -eq 1 ]]'
reset_gh; echo 7 > "$stub/open"; : > "$stub/requests"; echo copilot-x > "$stub/reviews"; rerun
check "ask record: a review of the head by copilot-x is not Copilot's, so the record is posted" '[[ "$(comments_posted)" -eq 1 ]]'
reset_gh; echo 7 > "$stub/open"; : > "$stub/requests"; echo not-copilot-pull-request-reviewer[bot] > "$stub/reviews"; rerun
check "ask record: a review by not-copilot-pull-request-reviewer[bot] is not Copilot's, so the record is posted" '[[ "$(comments_posted)" -eq 1 ]]'
reset_gh; echo 7 > "$stub/open"; echo myCopilotFork > "$stub/requests"; rerun
check "ask record: a request by myCopilotFork is not Copilot's, so the record is posted" '[[ "$(comments_posted)" -eq 1 ]]'

# A failing gh never fails the run.
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped" "$stub/comment-fails"; rerun
check "ask record: a failed post exits 0" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "ask record: a failed post warns with gh's message" \
  'grep -q "warning: recording the ask for Copilot.s review on #7 failed: HTTP 403: Resource not accessible" <<< "$out"'
check "ask record: a failed post still names land.sh as the next step" 'grep -q "next: land.sh acme/Widget#7" <<< "$out"'
reset_gh; echo 7 > "$stub/open"; touch "$stub/dropped" "$stub/comments-fail"; rerun
check "ask record: an unreadable comment list counts as no record, so the record is posted" '[[ $rc -eq 0 && "$(comments_posted)" -eq 1 ]]'
check "ask record: an unreadable comment list never adds review:claude" '! grep -q -- "--add-label" "$stub/gh.log"'

# A new PR whose request is dropped gets the record too (the first PR of a repo).
# (the old branch's work counts as merged, so this run starts a new branch and PR)
reset_gh; touch "$stub/dropped"; git -C "$origin" rev-parse chore/reapply-baseline > "$stub/merged"; rerun
check "ask record: a PR opened by this run with the request dropped gets one comment on #7" \
  '[[ $rc -eq 0 ]] && grep -q "^pr create" "$stub/gh.log" && [[ "$(comments_posted)" -eq 1 ]] && grep -q "^pr comment 7 --body " "$stub/gh.log"'

# ── An unmerged branch with no open PR, pushed to the remote: refused ───────
reset_gh
printf 'local\n' > "$wt/local.txt"
git_q -C "$wt" add -A && git_q -C "$wt" commit -q -m "chore: local work"
tip="$(git -C "$wt" rev-parse HEAD)"
out="$("$reapply" --brings '#84' "$repo" 2>&1)" && rc=0 || rc=$?
check "unmerged: refused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out"'
check "unmerged: branch kept" '[[ "$(git -C "$wt" rev-parse HEAD)" == "$tip" ]]'

# ── A branch pushed once whose remote branch is gone: still refused ─────────
# `fetch --prune` drops origin/<branch> after a merge or a close deletes it, so a missing remote ref
# alone can't mean "never pushed": the branch keeps the upstream `push -u` set, and its unmerged
# commits are refused.
reset_gh
git -C "$origin" branch -D chore/reapply-baseline >/dev/null
pushed_tip="$(git -C "$wt" rev-parse HEAD)"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "pushed, remote branch deleted: refused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out"'
check "pushed, remote branch deleted: branch kept" '[[ "$(git -C "$wt" rev-parse HEAD)" == "$pushed_tip" ]]'
check "pushed, remote branch deleted: nothing pushed" '! git -C "$origin" rev-parse --verify --quiet chore/reapply-baseline >/dev/null'

# ── A never-pushed branch when the merged-PR lookup fails: refused ──────────
# The lookup is what tells a merged branch from a new one, so its failure ends the run.
git -C "$repo" config --unset branch.chore/reapply-baseline.merge
git -C "$repo" config --unset branch.chore/reapply-baseline.remote
touch "$stub/merged-fails"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "merged lookup fails: refused" \
  '[[ $rc -ne 0 ]] && grep -q "HTTP 502" <<< "$out" && ! grep -q "carrying it on\|commits no open or merged PR carries" <<< "$out" && ! grep -q "^pr create" "$stub/gh.log"'
check "merged lookup fails: branch kept" '[[ "$(git -C "$wt" rev-parse HEAD)" == "$pushed_tip" ]]'
command rm -f "$stub/merged-fails"

# ── A refused first push leaves a never-pushed branch and no PR: the rerun carries on ─
# The gate refuses a re-Apply that writes a file it reviews, before any PR exists, so the branch has
# no origin/<branch>, no upstream of its own and no PR whose head it carries: the documented recovery (review, then run this
# again) must not stop at "commits no open or merged PR carries".
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "never pushed: the rerun succeeds" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "never pushed: says it carries the branch on" 'grep -q "was never pushed; carrying it on" <<< "$out"'
check "never pushed: the reuse line names no open PR" 'grep -q "reusing" <<< "$out" && ! grep -q "for open PR" <<< "$out"'
check "never pushed: the local commits are pushed" '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]]'
check "never pushed: no commit is lost" 'git -C "$wt" merge-base --is-ancestor "$pushed_tip" HEAD'
check "never pushed: the PR is opened" 'grep -q "^pr create" "$stub/gh.log"'

# The same with the worktree gone and the local branch kept.
reset_gh
git -C "$repo" worktree remove "$wt"
git -C "$origin" branch -D chore/reapply-baseline >/dev/null
git -C "$repo" config --unset branch.chore/reapply-baseline.merge
git -C "$repo" config --unset branch.chore/reapply-baseline.remote
kept_tip="$(git -C "$repo" rev-parse refs/heads/chore/reapply-baseline)"
out="$("$reapply" --brings '#86' "$repo" 2>&1)" && rc=0 || rc=$?
check "never pushed, no worktree: the rerun succeeds" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "never pushed, no worktree: the local branch is checked out, not recreated from main" \
  'git -C "$wt" merge-base --is-ancestor "$kept_tip" HEAD && grep -q "on chore/reapply-baseline from the local branch" <<< "$out" && ! grep -q "from origin/main" <<< "$out"'
check "never pushed, no worktree: the local commits are pushed" '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]]'

# A branch pushed without -u has no upstream; once a PR for it closed unmerged and its remote branch
# was deleted, it still isn't new: a PR whose head the branch carries (and main doesn't) refuses it.
reset_gh
git -C "$origin" branch -D chore/reapply-baseline >/dev/null
git -C "$repo" config --unset branch.chore/reapply-baseline.merge
git -C "$repo" config --unset branch.chore/reapply-baseline.remote
closed_tip="$(git -C "$wt" rev-parse HEAD)"
printf '[{"headRefOid":"%s","isCrossRepository":false}]\n' "$closed_tip" > "$stub/all-prs"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "closed PR, no upstream, remote branch deleted: refused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out"'
check "closed PR, no upstream, remote branch deleted: nothing pushed" \
  '! git -C "$origin" rev-parse --verify --quiet chore/reapply-baseline >/dev/null && [[ "$(git -C "$wt" rev-parse HEAD)" == "$closed_tip" ]]'

# A PR head strictly behind the tip (a later local commit sits on top of the closed PR's work) still
# counts: the test is "the branch carries the head", not "the head is the tip".
reset_gh
behind_head="$(git -C "$wt" rev-parse HEAD^)"
check "behind-the-tip setup: HEAD^ is on the branch and not in main" \
  'git -C "$repo" merge-base --is-ancestor "$behind_head" "$closed_tip" && ! git -C "$repo" merge-base --is-ancestor "$behind_head" origin/main'
printf '[{"headRefOid":"%s","isCrossRepository":false}]\n' "$behind_head" > "$stub/all-prs"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "a PR head behind the tip: refused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out"'

# The PR list is read in full: heads that don't count come first, and a later one that does still refuses.
# A real commit this clone has that isn't in the tip (an earlier round, squash-merged) doesn't count.
side_commit="$(git -C "$repo" commit-tree -m "an earlier round, squash-merged" "$(git -C "$repo" rev-parse 'origin/main^{tree}')")"
reset_gh
printf '[{"headRefOid":"%s","isCrossRepository":false},{"headRefOid":"%s","isCrossRepository":false},{"headRefOid":"%s","isCrossRepository":false}]\n' \
  "$(git -C "$repo" rev-parse origin/main)" "$side_commit" "$closed_tip" > "$stub/all-prs"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "several PRs, the last one carried: refused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out"'

# A head that isn't a commit id never reaches git: the run ends, in either lookup.
reset_gh
printf '[{"headRefOid":"--upload-pack=x","isCrossRepository":false}]\n' > "$stub/all-prs"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "a PR head that isn't a commit id: the run ends" '[[ $rc -ne 0 ]] && grep -q "not a commit id" <<< "$out" && ! grep -q "carrying it on" <<< "$out"'
reset_gh
echo "--upload-pack=x" > "$stub/merged"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "a merged PR head that isn't a commit id: the run ends" '[[ $rc -ne 0 ]] && grep -q "not a commit id" <<< "$out" && ! grep -q "carrying it on" <<< "$out"'
check "bad PR heads: nothing pushed" '! git -C "$origin" rev-parse --verify --quiet chore/reapply-baseline >/dev/null'

# The branch name is the same every round, so the PRs of earlier rounds (merged, or with a head main
# already has, or one this clone never saw, or a real commit the tip doesn't carry) say nothing about a
# new branch: it is still carried on.
reset_gh
check "earlier-rounds setup: main is behind the tip" 'git -C "$repo" merge-base --is-ancestor origin/main refs/heads/chore/reapply-baseline'
printf '[{"headRefOid":"%s","isCrossRepository":false},{"headRefOid":"%s","isCrossRepository":false},{"headRefOid":"%s","isCrossRepository":false}]\n' \
  "$side_commit" "$(git -C "$repo" rev-parse origin/main)" "$(printf 'a%.0s' {1..40})" > "$stub/all-prs"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "earlier rounds' PRs: the never-pushed branch is carried on" '[[ $rc -eq 0 ]] && grep -q "was never pushed; carrying it on" <<< "$out"'
check "earlier rounds' PRs: the local commits are pushed" '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]]'

# A PR from a fork with this branch name is not this repo's: it can't refuse the carry-on.
reset_gh
git -C "$origin" branch -D chore/reapply-baseline >/dev/null
git -C "$repo" config --unset branch.chore/reapply-baseline.merge
git -C "$repo" config --unset branch.chore/reapply-baseline.remote
fork_tip="$(git -C "$wt" rev-parse HEAD)"
printf '[{"headRefOid":"%s","isCrossRepository":true}]\n' "$fork_tip" > "$stub/all-prs"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "a fork's PR of the same name: ignored, the branch is carried on" '[[ $rc -eq 0 ]] && grep -q "was never pushed; carrying it on" <<< "$out"'

# The PR lookup, like the merged one, ends the run when gh fails.
reset_gh
git -C "$origin" branch -D chore/reapply-baseline >/dev/null
git -C "$repo" config --unset branch.chore/reapply-baseline.merge
git -C "$repo" config --unset branch.chore/reapply-baseline.remote
touch "$stub/all-fails"
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "PR lookup fails: refused" \
  '[[ $rc -ne 0 ]] && grep -q "HTTP 502" <<< "$out" && ! grep -q "carrying it on\|commits no open or merged PR carries" <<< "$out" && ! grep -q "^pr create" "$stub/gh.log"'
check "PR lookup fails: nothing pushed" '! git -C "$origin" rev-parse --verify --quiet chore/reapply-baseline >/dev/null'

# A branch that tracks main (made with `git checkout -b ... origin/main`) has an upstream, but not its own:
# with no origin/<branch> and no PR whose head it carries it is still a never-pushed branch.
reset_gh
git -C "$repo" config branch.chore/reapply-baseline.remote origin
git -C "$repo" config branch.chore/reapply-baseline.merge refs/heads/main
out="$("$reapply" --brings '#87' "$repo" 2>&1)" && rc=0 || rc=$?
check "never pushed, tracking main: carried on" '[[ $rc -eq 0 ]] && grep -q "was never pushed; carrying it on" <<< "$out"'
check "never pushed, tracking main: the local commits are pushed" '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]]'

# An open PR from a fork with this branch name is not this repo's: it isn't reused or edited. The branch
# is pushed, with no PR of this repo, so the run refuses it like any unmerged pushed branch.
reset_gh
echo 7 > "$stub/open"
touch "$stub/open-cross"
out="$("$reapply" --brings '#88' "$repo" 2>&1)" && rc=0 || rc=$?
check "a fork's open PR of the same name: not reused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out" && ! grep -q "^pr edit 7" "$stub/gh.log" && ! grep -q "reusing" <<< "$out"'
# The fork filter runs after gh's cut, so the lookup asks for the same 100 the others do: with gh's default
# of 30, enough forks' PRs of that name would push this repo's own open PR out of the list.
check "the open-PR lookup asks for 100, as the others do" \
  'grep "^pr list .*--state open" "$stub/gh.log" | grep -q -- "--limit 100"'

# ── The merged PRs' heads: the tip must be carried BY the head, not the other way round ──
# A head strictly behind the tip (a local commit sits on top of what merged) carries nothing of it.
reset_gh
cur_tip="$(git -C "$repo" rev-parse refs/heads/chore/reapply-baseline)"
cur_behind="$(git -C "$repo" rev-parse "$cur_tip^")"
check "merged-direction setup: the head behind the tip is not in main" \
  '! git -C "$repo" merge-base --is-ancestor "$cur_tip" origin/main && git -C "$repo" merge-base --is-ancestor "$cur_behind" "$cur_tip" && ! git -C "$repo" merge-base --is-ancestor "$cur_tip" "$cur_behind"'
echo "$cur_behind" > "$stub/merged"
out="$("$reapply" --brings '#89' "$repo" 2>&1)" && rc=0 || rc=$?
check "a merged head behind the tip: refused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out"'
check "a merged head behind the tip: branch kept" '[[ "$(git -C "$repo" rev-parse refs/heads/chore/reapply-baseline)" == "$cur_tip" ]]'

# A git failure that is neither "ancestor" nor "not" ends the run. A commit whose parent this clone lacks
# makes the walk fail (status 128) while both commits exist.
reset_gh
missing_parent="$(printf 'b%.0s' {1..40})"
broken="$(printf 'tree %s\nparent %s\nauthor T <t@example.com> 1 +0000\ncommitter T <t@example.com> 1 +0000\n\nbroken\n' \
  "$(git -C "$repo" rev-parse 'origin/main^{tree}')" "$missing_parent" | git -C "$repo" hash-object -t commit -w --literally --stdin)"
echo "$broken" > "$stub/merged"
out="$("$reapply" --brings '#89' "$repo" 2>&1)" && rc=0 || rc=$?
check "a git failure in the ancestor test: the run ends" \
  '[[ $rc -ne 0 ]] && grep -q "is-ancestor failed (status" <<< "$out" && ! grep -q "carrying it on\|replacing" <<< "$out"'
check "a git failure in the ancestor test: branch kept" '[[ "$(git -C "$repo" rev-parse refs/heads/chore/reapply-baseline)" == "$cur_tip" ]]'

# A merged head strictly ahead of the tip (the PR got more commits after the tip) carries it: replaced.
reset_gh
ahead="$(git -C "$repo" commit-tree -p "$cur_tip" -m "added in the PR after the tip" "$(git -C "$repo" rev-parse "$cur_tip^{tree}")")"
echo "$ahead" > "$stub/merged"
out="$("$reapply" --brings '#89' "$repo" 2>&1)" && rc=0 || rc=$?
check "a merged head ahead of the tip: the branch is replaced" '[[ $rc -eq 0 ]] && grep -q "replacing" <<< "$out"'

# ── Bad arguments ───────────────────────────────────────────────────────────
check "args: --brings required" '! "$reapply" "$repo" >/dev/null 2>&1'
check "args: unreadable --brings refused" '! "$reapply" --brings "dotfiles 80" "$repo" >/dev/null 2>&1'

echo "reapply.test.sh: $pass passed, $failed failed"
[[ $failed -eq 0 ]]
