#!/usr/bin/env bash
# Tests for scripts/check-git-hooks.sh, the Claude Code SessionStart hook that
# warns when core.hooksPath isn't .github/hooks. Wiring it in (.claude/settings.json)
# is each repo's own.
# Usage: scripts/tests/check-git-hooks.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/check-git-hooks.sh"
BASH_BIN="$(command -v bash)"

# python3 is what the gate already requires (discover_tests.py), so the JSON
# checks use it rather than adding jq to the gate's prerequisites.
command -v python3 > /dev/null 2>&1 || { echo "check-git-hooks.test.sh needs python3" >&2; exit 1; }

PASSED=0
FAILED=0

WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2> /dev/null; rm -rf "$WORK"' EXIT

# Keep the developer's git config out of every git call here, the setup ones
# included: commit signing or a global core.hooksPath would break or pollute them.
export HOME="$WORK" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

pass() {
  PASSED=$((PASSED + 1))
  echo "ok   - $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "FAIL - $1"
  shift
  local line
  for line in "$@"; do echo "       | $line"; done
}

# run_hook <dir> [PATH]: runs the script from <dir> with git's global and
# system config out of the way, no inherited repository variables and no
# CLAUDE_CODE_REMOTE or GITHUB_ACTIONS (CI sets the latter), plus the
# assignments in HOOK_ENV. Sets OUTPUT and STATUS.
HOOK_ENV=(HOOK_TEST=1)
run_hook() {
  local dir="$1" path="${2:-$PATH}"
  OUTPUT="$(cd "$dir" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX \
    -u CLAUDE_CODE_REMOTE -u GITHUB_ACTIONS \
    HOME="$WORK" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_CEILING_DIRECTORIES="$WORK" PATH="$path" "${HOOK_ENV[@]}" "$BASH_BIN" "$SCRIPT" 2>&1)"
  STATUS=$?
}

# new_repo <name> [hooksPath]: a fresh repository with a .github/hooks
# directory, with core.hooksPath set only when a value is given.
new_repo() {
  local dir="$WORK/$1"
  mkdir -p "$dir/.github/hooks"
  git init --quiet "$dir"
  if [[ $# -ge 2 ]]; then
    git -C "$dir" config core.hooksPath "$2"
  fi
  echo "$dir"
}

# has_warning_json <output>: true when the output is JSON with systemMessage
# and hookSpecificOutput.additionalContext.
has_warning_json() {
  python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("systemMessage") and d["hookSpecificOutput"].get("additionalContext") else 1)' "$1" > /dev/null 2>&1
}

# expect_warning <label> <dir>: exit 0 and a warning that says the pre-push
# gate won't run and names the fix. Claude Code shows systemMessage to the
# person only when the output parses as JSON.
expect_warning() {
  run_hook "$2"
  local problems=()
  [[ $STATUS -eq 0 ]] || problems+=("exit $STATUS, want 0")
  has_warning_json "$OUTPUT" \
    || problems+=("output isn't JSON with systemMessage and hookSpecificOutput.additionalContext")
  [[ "$OUTPUT" == *"pre-push"* ]] || problems+=("output doesn't mention the pre-push gate")
  [[ "$OUTPUT" == *"won't run"* ]] || problems+=("output doesn't say the gate won't run")
  [[ "$OUTPUT" == *"git config core.hooksPath .github/hooks"* ]] || problems+=("output doesn't name the fix")
  if [[ ${#problems[@]} -eq 0 ]]; then
    pass "$1"
  else
    fail "$1" "${problems[@]}" "output: $OUTPUT"
  fi
}

# expect_silent <label> <dir> [PATH]: exit 0 and no output.
expect_silent() {
  run_hook "$2" "${3:-$PATH}"
  if [[ $STATUS -eq 0 && -z "$OUTPUT" ]]; then
    pass "$1"
  else
    fail "$1" "exit $STATUS and output: $OUTPUT" "want exit 0 and no output"
  fi
}

# --- the hook's behaviour ---

expect_warning "hooksPath unset warns" "$(new_repo unset)"
expect_warning "hooksPath empty warns" "$(new_repo empty "")"
expect_warning "hooksPath .githooks warns" "$(new_repo wrong-value .githooks)"
expect_warning "hooksPath .git/hooks warns" "$(new_repo default-dir .git/hooks)"
expect_silent "hooksPath .github/hooks prints nothing" "$(new_repo correct .github/hooks)"
expect_silent "hooksPath .github/hooks/ (trailing slash) prints nothing" "$(new_repo trailing-slash .github/hooks/)"
expect_silent "hooksPath ./.github/hooks prints nothing" "$(new_repo dot-slash ./.github/hooks)"
repo="$(new_repo absolute)"
git -C "$repo" config core.hooksPath "$repo/.github/hooks"
expect_silent "hooksPath as an absolute path to .github/hooks prints nothing" "$repo"

# The setting is shared by a repository's worktrees, and the session may
# start in a subdirectory.
repo="$(new_repo subdir)"
mkdir -p "$repo/src/deep"
expect_warning "hooksPath unset warns from a subdirectory" "$repo/src/deep"
git -C "$repo" config core.hooksPath .github/hooks
expect_silent "hooksPath .github/hooks prints nothing from a subdirectory" "$repo/src/deep"

# git writes config.lock and renames it over config, so a config file whose mode
# lacks write permission can still take the setting, and the warning stays.
repo="$(new_repo read-only-config-mode)"
chmod a-w "$repo/.git/config"
expect_warning "a .git/config without write permission still warns, since git can replace it" "$repo"
chmod u+w "$repo/.git/config"
if [[ -n "$(cd "$repo" && git config --local --get sandcastle.hooksProbe)" ]]; then
  fail "the writability probe leaves no key behind in .git/config"
else
  pass "the writability probe leaves no key behind in .git/config"
fi

# Where git can't write its config, as in Sandcastle's sandbox, the warning
# can't be acted on, so the hook stays silent. A git directory without write
# permission is the same for git: it can't create config.lock.
repo="$(new_repo read-only-git-dir)"
chmod a-w "$repo/.git"
if [[ -w "$repo/.git" ]]; then
  echo "skip - running as a user who can write a read-only directory, so the read-only git directory case can't be set up"
else
  expect_silent "a git directory git can't write to prints nothing" "$repo"
fi
chmod u+w "$repo/.git"

# Linked worktrees are where pushes come from (docs/PROCESS.md). The setting is
# shared, and git resolves a relative core.hooksPath against the worktree's own
# top level, while the config to write is the main repository's.
repo="$(new_repo worktree-main)"
git -C "$repo" -c user.name=t -c user.email=t@example.com commit --quiet --allow-empty -m init
mkdir -p "$repo/.github/hooks"
git -C "$repo" worktree add --quiet -b linked "$WORK/worktree-linked"
mkdir -p "$WORK/worktree-linked/.github/hooks" "$WORK/worktree-linked/src"
expect_warning "hooksPath unset warns from a linked worktree" "$WORK/worktree-linked"
expect_warning "hooksPath unset warns from a linked worktree's subdirectory" "$WORK/worktree-linked/src"
git -C "$repo" config core.hooksPath .github/hooks
expect_silent "hooksPath .github/hooks prints nothing from a linked worktree" "$WORK/worktree-linked"
git -C "$repo" config --unset core.hooksPath
chmod a-w "$repo/.git"
if [[ -w "$repo/.git" ]]; then
  echo "skip - running as a user who can write a read-only directory, so the read-only common git directory case can't be set up"
else
  expect_silent "a common git directory git can't write to prints nothing from a linked worktree" "$WORK/worktree-linked"
fi
chmod u+w "$repo/.git"

# Cloud sessions and CI runs of Claude Code keep the hooks off on purpose.
repo="$(new_repo remote-session)"
HOOK_ENV=(CLAUDE_CODE_REMOTE=true)
expect_silent "a Claude Code cloud session (CLAUDE_CODE_REMOTE=true) prints nothing" "$repo"
HOOK_ENV=(GITHUB_ACTIONS=true)
expect_silent "a GitHub Actions run (GITHUB_ACTIONS set) prints nothing" "$repo"
HOOK_ENV=(CLAUDE_CODE_REMOTE=false)
expect_warning "CLAUDE_CODE_REMOTE=false still warns" "$repo"
HOOK_ENV=(HOOK_TEST=1)

# Never fails the session.
mkdir -p "$WORK/not-a-repo"
expect_silent "outside a git repository exits 0 without output" "$WORK/not-a-repo"
mkdir -p "$WORK/no-git-bin"
expect_silent "git missing exits 0 without output" "$(new_repo no-git)" "$WORK/no-git-bin"

if [[ -x "$SCRIPT" ]]; then
  pass "scripts/check-git-hooks.sh is executable"
else
  fail "scripts/check-git-hooks.sh is executable"
fi

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
