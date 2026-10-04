#!/usr/bin/env bash
# Tests for scripts/check-pr-title.sh.
# Usage: scripts/tests/check-pr-title.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/check-pr-title.sh"

PASSED=0
FAILED=0

# expect <allowed|refused> <title>
expect() {
  local outcome="$1" title="$2" output status
  output="$(bash "$SCRIPT" "$title" 2>&1)"
  status=$?
  if [[ "$outcome" == allowed && $status -eq 0 && -z "$output" ]] \
    || [[ "$outcome" == refused && $status -eq 1 && "$output" == *"'${title}'"* ]]; then
    PASSED=$((PASSED + 1))
    echo "ok   - '$title' is $outcome"
  else
    FAILED=$((FAILED + 1))
    echo "FAIL - '$title' should be $outcome: exit $status"
    while IFS= read -r line; do echo "       | $line"; done <<< "$output"
  fi
}

expect allowed "fix: Return an empty list when a record has no children"
expect allowed "feat(Web): Let users sort the list by date"
expect allowed "ci(automerge)!: Drop the old trigger"
expect allowed "docs: Add release blog for PR #12 [skip-release]"
expect allowed "build: .NET 10 SDK"
expect allowed "chore(deps): Bump the all-actions group"

expect refused "Fix the thing"
expect refused "fix: return an empty list"
expect refused "fix: Return an empty list."
expect refused "fixed: Return an empty list"
expect refused "fix:Return an empty list"
expect refused "fix(): Return an empty list"
expect refused "chore(deps): bump the all-actions group"
expect refused ""

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
