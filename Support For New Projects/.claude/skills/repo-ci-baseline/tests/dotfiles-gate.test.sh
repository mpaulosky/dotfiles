#!/usr/bin/env bash
# Tests for dotfiles' own scripts/gate.sh: its "Local review" step (before test.sh,
# refusing a push the local review hasn't passed) and when it runs the Sandcastle
# check. Each case runs a copy of the gate in a throwaway repo, with stub
# scripts/review.sh, test.sh and pnpm that log their calls, so nothing real runs.
# Usage: tests/dotfiles-gate.test.sh
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$(cd "$SKILL_DIR/../../../.." && pwd)/scripts/gate.sh"
SKILL_REL="Support For New Projects/.claude/skills/repo-ci-baseline"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
STUBS="$WORK/bin"
LOG="$WORK/calls.log"

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
# The caller may be iterating with the review check skipped; the cases set what they need.
unset GATE_SKIP_REVIEW FAIL_REVIEW
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

mkdir -p "$STUBS"
cat > "$STUBS/pnpm" <<EOF
#!/usr/bin/env bash
echo "pnpm \$*" >> "$LOG"
EOF
chmod +x "$STUBS/pnpm"

git init -q -b main "$REPO"
mkdir -p "$REPO/scripts" "$REPO/$SKILL_REL" "$REPO/.claude/skills/pre-push-review" "$REPO/other"
cp "$GATE" "$REPO/scripts/gate.sh"
cat > "$REPO/scripts/review.sh" <<EOF
#!/usr/bin/env bash
echo "review.sh \$*" >> "$LOG"
[[ -z "\${FAIL_REVIEW:-}" ]]
EOF
cat > "$REPO/$SKILL_REL/test.sh" <<EOF
#!/usr/bin/env bash
echo "test.sh" >> "$LOG"
EOF
chmod +x "$REPO/scripts/review.sh" "$REPO/$SKILL_REL/test.sh" "$REPO/scripts/gate.sh"
echo skill > "$REPO/.claude/skills/pre-push-review/SKILL.md"
echo other > "$REPO/other/file.txt"
git -C "$REPO" add .
git -C "$REPO" commit -q -m init
git -C "$REPO" update-ref refs/remotes/origin/main main
MAIN="$(git -C "$REPO" rev-parse main)"

PASSED=0
FAILED=0
OUTPUT=""
STATUS=0

run_gate() {
  : > "$LOG"
  OUTPUT="$(cd "$REPO" && PATH="$STUBS:$PATH" bash scripts/gate.sh 2>&1)"
  STATUS=$?
}
pass() { PASSED=$((PASSED + 1)); echo "ok   - $1"; }
fail() {
  FAILED=$((FAILED + 1)); echo "FAIL - $1"
  echo "       | exit $STATUS; calls: $(tr '\n' ';' < "$LOG")"
  while IFS= read -r line; do echo "       | $line"; done <<< "$OUTPUT"
}
called() { grep -q -- "$1" "$LOG"; }
check() { # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}
not() { ! "$@"; }
first_before_second() { # the first pattern's line comes before the second's
  local a b
  a="$(grep -n -m1 -- "$1" "$LOG" | cut -d: -f1)"
  b="$(grep -n -m1 -- "$2" "$LOG" | cut -d: -f1)"
  [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]]
}

# A branch that changed only an unrelated file.
git -C "$REPO" switch -q -c work origin/main
echo change >> "$REPO/other/file.txt"
git -C "$REPO" commit -qam "unrelated change"

run_gate
check "a passing review check lets the gate run test.sh" test $STATUS -eq 0
check "the review check gets the merge base" called "review.sh check $MAIN"
check "the review check runs before test.sh" first_before_second "review.sh" "test.sh"
check "an unrelated change skips the Sandcastle check" not called "pnpm run check:sandcastle"

FAIL_REVIEW=1 run_gate
check "a failing review check refuses the push" test $STATUS -ne 0
check "a failing review check stops the gate before test.sh" not called "test.sh"

GATE_SKIP_REVIEW=1 FAIL_REVIEW=1 run_gate
check "GATE_SKIP_REVIEW=1 skips the review check" test $STATUS -eq 0
check "GATE_SKIP_REVIEW=1 doesn't call review.sh" not called "review.sh"
check "GATE_SKIP_REVIEW=1 still runs test.sh" called "test.sh"

GATE_SKIP_REVIEW=true FAIL_REVIEW=1 run_gate
check "GATE_SKIP_REVIEW with any other value doesn't skip it" test $STATUS -ne 0

git -C "$REPO" update-ref -d refs/remotes/origin/main
run_gate
check "without an origin/main the review can't be checked, so the gate fails" test $STATUS -ne 0
check "it says to fetch main" grep -q "No origin/main" <<< "$OUTPUT"
check "and it doesn't run test.sh" not called "test.sh"
git -C "$REPO" update-ref refs/remotes/origin/main "$MAIN"

# The Sandcastle check runs when a file its tests read changes, not only under .sandcastle/.
for path in scripts/review.sh .claude/skills/pre-push-review/SKILL.md; do
  git -C "$REPO" switch -q -c "touch-$(basename "$path")" origin/main
  echo "# change" >> "$REPO/$path"
  git -C "$REPO" commit -qam "touch $path"
  run_gate
  check "a change to $path runs the Sandcastle check" called "pnpm run check:sandcastle"
done

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
