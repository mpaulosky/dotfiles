#!/usr/bin/env bash
# Tests for the Seed's .sandcastle/check.sh: it runs Sandcastle's check only when a file the
# check reads changed since <merge-base> (always, with no merge base), so a repo that copies it
# doesn't stop checking when only one of those files changes. Each case runs the Seed script in
# a throwaway repo with a stub pnpm that logs its calls.
# Usage: tests/seed-check.test.sh
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$SKILL_DIR/template/seed/.sandcastle/check.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
STUBS="$WORK/bin"
LOG="$WORK/calls.log"

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

mkdir -p "$STUBS"
cat > "$STUBS/pnpm" <<STUB
#!/usr/bin/env bash
echo "pnpm \$*" >> "$LOG"
STUB
chmod +x "$STUBS/pnpm"

# Every path the script's pathspec names, plus a file it doesn't.
PATHS=(.sandcastle/lib/x.mts package.json pnpm-workspace.yaml pnpm-lock.yaml scripts/review.sh
  .claude/skills/pre-push-review/SKILL.md .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml)

git init -q -b main "$REPO"
mkdir -p "$REPO/.sandcastle"
cp "$CHECK" "$REPO/.sandcastle/check.sh"
for path in "${PATHS[@]}" docs/unrelated.md; do
  mkdir -p "$REPO/$(dirname "$path")"
  echo start > "$REPO/$path"
done
git -C "$REPO" add .
git -C "$REPO" commit -q -m init
BASE="$(git -C "$REPO" rev-parse HEAD)"

PASSED=0
FAILED=0
STATUS=0
OUTPUT=""

run_check() { # run_check [<merge-base>]
  : > "$LOG"
  OUTPUT="$(cd "$REPO" && PATH="$STUBS:$PATH" bash .sandcastle/check.sh "$@" 2>&1)"
  STATUS=$?
}
pass() { PASSED=$((PASSED + 1)); echo "ok   - $1"; }
fail() {
  FAILED=$((FAILED + 1)); echo "FAIL - $1"
  echo "       | exit $STATUS; calls: $(tr '\n' ';' < "$LOG")"
  while IFS= read -r line; do echo "       | $line"; done <<< "$OUTPUT"
}
ran_check() { grep -q -- "pnpm run check:sandcastle" "$LOG"; }
check() { # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}
not() { ! "$@"; }

run_check
check "with no merge base the check runs" ran_check

run_check "$BASE"
check "with nothing changed it exits 0 and runs nothing" test $STATUS -eq 0
check "with nothing changed pnpm is not called" not ran_check

git -C "$REPO" switch -q -c unrelated
echo more >> "$REPO/docs/unrelated.md"
git -C "$REPO" commit -qam "unrelated"
run_check "$BASE"
check "a change to a file the check doesn't read runs nothing" not ran_check
check "a change to a file the check doesn't read exits 0" test $STATUS -eq 0
git -C "$REPO" switch -q main

n=0
for path in "${PATHS[@]}"; do
  n=$((n + 1))
  git -C "$REPO" switch -q -c "touch-$n" main
  echo more >> "$REPO/$path"
  git -C "$REPO" commit -qam "touch $path"
  run_check "$BASE"
  check "a change to $path runs the Sandcastle check" ran_check
  git -C "$REPO" switch -q main
done

echo
echo "seed-check.test.sh: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
