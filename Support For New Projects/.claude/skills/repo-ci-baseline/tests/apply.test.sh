#!/usr/bin/env bash
# Tests for apply.sh, against throwaway repos and a copy of the skill with a
# small stand-in Template, so the cases don't depend on the real Template's
# contents.
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

# A skill copy whose Template has one Owned and two Seed files, plus a cache
# a local pytest run could leave behind.
skill="$work/skill"
mkdir -p "$skill/template/owned/.github/workflows" "$skill/template/owned/.github/scripts/__pycache__" \
  "$skill/template/seed/docs" "$skill/template/seed/.github/ci"
command cp -f "$skill_dir/apply.sh" "$skill/"
printf 'name: CI\n' > "$skill/template/owned/.github/workflows/ci.yml"
printf 'stale\n' > "$skill/template/owned/.github/scripts/__pycache__/x.pyc"
printf '# {{REPO}} by {{OWNER}}, solution {{SOLUTION}}\n' > "$skill/template/seed/docs/SECURITY.md"
printf '#!/usr/bin/env bash\n' > "$skill/template/seed/.github/ci/prepare.sh"
chmod +x "$skill/template/seed/.github/ci/prepare.sh"
apply="$skill/apply.sh"

# Hooks off: a global init.templateDir can install hooks (such as a
# post-checkout that sets core.hooksPath) into every throwaway repo.
git_q() { git -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@example.com "$@"; }
new_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" remote add origin "https://github.com/acme/Widget.git"
}
commit_all() { git_q -C "$1" add -A && git_q -C "$1" commit -q -m "$2"; }

# ── An empty repo (no commits) can be Applied on main ───────────────────────
repo="$work/empty repo"
new_repo "$repo"
touch "$repo/Widget.slnx"
check "empty repo: apply succeeds" '"$apply" "$repo" >/dev/null'
check "empty repo: Owned file written" '[[ -f "$repo/.github/workflows/ci.yml" ]]'
check "empty repo: placeholders filled" \
  'grep -qx "# Widget by acme, solution Widget" "$repo/docs/SECURITY.md"'
check "empty repo: Seed file keeps its execute bit" '[[ -x "$repo/.github/ci/prepare.sh" ]]'
check "empty repo: hooksPath set" '[[ "$(git -C "$repo" config --local core.hooksPath)" == .github/hooks ]]'
check "empty repo: caches not copied" '[[ ! -e "$repo/.github/scripts/__pycache__" ]]'

# ── Guards on a repo with history ───────────────────────────────────────────
repo="$work/guarded"
new_repo "$repo"
mkdir -p "$repo/.github/workflows" "$repo/docs"
printf 'name: old CI\n' > "$repo/.github/workflows/ci.yml"
printf 'name: sync\n' > "$repo/.github/workflows/sync-readme.yml"
printf '# our own security policy\n' > "$repo/docs/SECURITY.md"
printf '{"default": false}\n' > "$repo/.markdownlint.json"
mkdir -p "$repo/.claude/rules"
printf 'Add user authentication\n' > "$repo/.copilot-commit-message-instructions.md"
printf '# commit rules\n' > "$repo/.claude/rules/git-commit.md"
commit_all "$repo" "init"

check "guard: refuses main" '! "$apply" "$repo" >/dev/null 2>&1'
git_q -C "$repo" switch -q -c chore/standardize-baseline
echo dirty > "$repo/untracked.txt"
check "guard: refuses an untracked file" '! "$apply" "$repo" >/dev/null 2>&1'
command rm -f "$repo/untracked.txt"
git_q -C "$repo" switch -q --detach
check "guard: refuses a detached HEAD" '! "$apply" "$repo" >/dev/null 2>&1'
git_q -C "$repo" switch -q chore/standardize-baseline

# ── Dry run changes nothing, even on main ───────────────────────────────────
git_q -C "$repo" switch -q main
dry="$("$apply" --dry-run "$repo")"
check "dry run: worktree untouched" '[[ -z "$(git -C "$repo" status --porcelain)" ]]'
check "dry run: hooksPath untouched" '! git -C "$repo" config --local core.hooksPath >/dev/null'
check "dry run: reports the overwrite" 'grep -q "would be overwritten" <<< "$dry"'
git_q -C "$repo" switch -q chore/standardize-baseline

# ── A real Apply on a work branch ───────────────────────────────────────────
out="$("$apply" "$repo")"
check "apply: Owned drift overwritten" 'grep -qx "name: CI" "$repo/.github/workflows/ci.yml"'
check "apply: drift reported" 'grep -A1 "were overwritten" <<< "$out" | grep -q ".github/workflows/ci.yml"'
check "apply: existing Seed file kept" 'grep -qx "# our own security policy" "$repo/docs/SECURITY.md"'
check "apply: kept Seed file reported" 'grep -A1 "Seed files skipped" <<< "$out" | grep -q "docs/SECURITY.md"'
check "apply: leftover kept and reported" \
  '[[ -f "$repo/.github/workflows/sync-readme.yml" ]] && grep -q "sync-readme.yml" <<< "$out"'
check "apply: .markdownlint.json conflict reported" 'grep -q ".markdownlint.json overrides" <<< "$out"'
check "apply: duplicate commit rules reported" \
  'grep -q ".copilot-commit-message-instructions.md duplicates" <<< "$out" && grep -q ".claude/rules/git-commit.md duplicates" <<< "$out"'
check "apply: unfilled placeholders none" 'grep -q "unfilled placeholders (0)" <<< "$out"'

# ── Applying again changes nothing ──────────────────────────────────────────
commit_all "$repo" "apply"
again="$("$apply" "$repo")"
check "re-apply: worktree untouched" '[[ -z "$(git -C "$repo" status --porcelain)" ]]'
check "re-apply: nothing overwritten" 'grep -q "were overwritten.*(0)" <<< "$again"'

# ── An Owned file that lost its execute bit counts as drift ────────────────
printf '#!/usr/bin/env bash\n' > "$skill/template/owned/run.sh"
chmod +x "$skill/template/owned/run.sh"
command cp -f "$skill/template/owned/run.sh" "$repo/run.sh"
chmod -x "$repo/run.sh"
commit_all "$repo" "lose the execute bit"
mode="$("$apply" "$repo")"
check "mode drift: reported" 'grep -A1 "were overwritten" <<< "$mode" | grep -q "run.sh"'
check "mode drift: execute bit restored" '[[ -x "$repo/run.sh" ]]'
command rm -f "$skill/template/owned/run.sh"

# ── Squad still installed ───────────────────────────────────────────────────
repo="$work/squad"
new_repo "$repo"
mkdir -p "$repo/.github/workflows"
printf 'name: squad\n' > "$repo/.github/workflows/squad-ci.yml"
check "squad: conflict reported" '"$apply" --dry-run "$repo" | grep -q "remove-squad"'

# ── No remote and no solution: placeholders left and reported ───────────────
repo="$work/bare"
git init -q -b main "$repo"
out="$("$apply" "$repo")"
check "no remote: placeholder left" 'grep -q "{{REPO}}" "$repo/docs/SECURITY.md"'
check "no remote: unfilled reported" 'grep -A1 "unfilled placeholders (1)" <<< "$out" | grep -q "docs/SECURITY.md"'

echo "apply.test.sh: $pass passed, $failed failed"
[[ $failed -eq 0 ]]
