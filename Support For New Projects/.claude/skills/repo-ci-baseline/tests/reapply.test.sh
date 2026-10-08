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
# PRs' head commits, $stub/body the PR description. Copilot's review request
# reads back as registered unless $stub/dropped exists (GitHub accepts it and
# drops it). While $stub/request-fails exists, the request call itself fails
# and nothing registers. Adding a label fails while $stub/label-fails exists.
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<EOF
#!/usr/bin/env bash
stub="$stub"
printf '%s\n' "\$*" >> "\$stub/gh.log"
body_from() { while [[ \$# -gt 0 ]]; do [[ "\$1" == --body-file ]] && cp "\$2" "\$stub/body"; shift; done; }
case "\$1 \$2" in
  "pr list")
    case "\$*" in
      *"--state open"*) cat "\$stub/open" 2>/dev/null ;;
      *"--state merged"*) cat "\$stub/merged" 2>/dev/null ;;
    esac ;;
  "pr create") body_from "\$@"; echo "https://github.com/acme/Widget/pull/7" ;;
  "pr view")
    if [[ "\$*" == *"--json headRefOid,reviewRequests,reviews,url"* ]]; then
      if [[ -e "\$stub/dropped" || -e "\$stub/request-fails" ]]; then echo "0 https://github.com/acme/Widget/pull/7"; else echo "1 https://github.com/acme/Widget/pull/7"; fi
    else
      cat "\$stub/body"
    fi ;;
  "pr edit")
    body_from "\$@"
    if [[ "\$*" == *"--add-reviewer"* && -e "\$stub/already" ]]; then
      echo "reviewer already requested" >&2; exit 1
    fi
    if [[ "\$*" == *"--add-reviewer"* && -e "\$stub/request-fails" ]]; then
      echo "GraphQL: Could not add requested reviewers to pull request. (requestReviewsByLogin)" >&2; exit 1
    fi
    if [[ "\$*" == *"--add-label"* && -e "\$stub/label-fails" ]]; then
      echo "could not add label: 'review:claude' not found" >&2; exit 1
    fi ;;
  *) echo "fake gh: unexpected \$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

# Hooks off for the test's own git calls.
git_q() { git -c core.hooksPath=/dev/null "$@"; }
reset_gh() { : > "$stub/gh.log"; : > "$stub/open"; : > "$stub/merged"; command rm -f "$stub/already" "$stub/dropped" "$stub/request-fails" "$stub/label-fails"; }

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
message="$(printf 'chore: Apply repo-ci-baseline Template\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
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

# ── Copilot's request dropped: Claude Review is called in, and the run passes
reset_gh
echo 7 > "$stub/open"
touch "$stub/dropped"
printf 'name: CI v5\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "dropped: exits 0" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "dropped: adds review:claude" 'grep -qx "pr edit 7 --add-label review:claude" "$stub/gh.log"'
check "dropped: warns that Copilot wasn't requested and Claude was called in" \
  'grep -q "warning: Copilot.s review request didn.t register on #7 (GitHub drops it once the Copilot code review budget is used up); added review:claude, so Claude Review reviews https://github.com/acme/Widget/pull/7 instead" <<< "$out"'
check "dropped: does not claim Copilot was requested" '! grep -q "Copilot requested" <<< "$out"'
check "dropped: says Claude was requested" 'grep -q "Claude Review requested" <<< "$out"'
check "dropped: the Apply commit is pushed and the PR updated" \
  '[[ "$(git -C "$origin" rev-parse chore/reapply-baseline)" == "$(git -C "$wt" rev-parse HEAD)" ]] && grep -q "^pr edit 7 --body-file" "$stub/gh.log"'

# ── Copilot's request dropped and the label can't be added: the run fails ──
reset_gh
echo 7 > "$stub/open"
touch "$stub/dropped" "$stub/label-fails"
printf 'name: CI v6\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "label fails: exits non-zero" '[[ $rc -ne 0 ]]'
check "label fails: says neither reviewer was requested, with the PR to request one on" \
  'grep -q "adding review:claude to #7 failed" <<< "$out" && grep -q "https://github.com/acme/Widget/pull/7" <<< "$out"'

# ── Copilot's request call fails outright: Claude Review is called in ───────
reset_gh
echo 7 > "$stub/open"
touch "$stub/request-fails"
printf 'name: CI v7\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "request fails: exits 0" '[[ $rc -eq 0 ]] || { echo "$out" >&2; false; }'
check "request fails: adds review:claude" 'grep -qx "pr edit 7 --add-label review:claude" "$stub/gh.log"'
check "request fails: warns with gh's message" \
  'grep -q "warning: requesting Copilot.s review on #7 failed: GraphQL: Could not add requested reviewers" <<< "$out"'
check "request fails: says Claude was requested" 'grep -q "Claude Review requested" <<< "$out"'

# ── Request fails and the label can't be added: the run fails ───────────────
reset_gh
echo 7 > "$stub/open"
touch "$stub/request-fails" "$stub/label-fails"
printf 'name: CI v8\n' > "$skill/template/owned/.github/workflows/ci.yml"
out="$("$reapply" --brings '#85' "$repo" 2>&1)" && rc=0 || rc=$?
check "request and label fail: exits non-zero" '[[ $rc -ne 0 ]]'
check "request and label fail: names the PR to request a review on" \
  'grep -q "adding review:claude to #7 failed" <<< "$out" && grep -q "https://github.com/acme/Widget/pull/7" <<< "$out"'

# ── An unmerged branch with no open PR: refused ─────────────────────────────
reset_gh
printf 'local\n' > "$wt/local.txt"
git_q -C "$wt" add -A && git_q -C "$wt" commit -q -m "chore: local work"
tip="$(git -C "$wt" rev-parse HEAD)"
out="$("$reapply" --brings '#84' "$repo" 2>&1)" && rc=0 || rc=$?
check "unmerged: refused" '[[ $rc -ne 0 ]] && grep -q "commits no open or merged PR carries" <<< "$out"'
check "unmerged: branch kept" '[[ "$(git -C "$wt" rev-parse HEAD)" == "$tip" ]]'

# ── Bad arguments ───────────────────────────────────────────────────────────
check "args: --brings required" '! "$reapply" "$repo" >/dev/null 2>&1'
check "args: unreadable --brings refused" '! "$reapply" --brings "dotfiles 80" "$repo" >/dev/null 2>&1'

echo "reapply.test.sh: $pass passed, $failed failed"
[[ $failed -eq 0 ]]
