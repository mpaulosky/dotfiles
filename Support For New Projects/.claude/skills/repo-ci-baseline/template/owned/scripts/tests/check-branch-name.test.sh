#!/usr/bin/env bash
# Tests for scripts/check-branch-name.sh. pre-push.test.sh covers the standard
# itself through the hook; these cover the --pr form ci.yml's "Branch name"
# job uses, and the exit codes and message both callers rely on.
# Usage: scripts/tests/check-branch-name.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/check-branch-name.sh"

PASSED=0
FAILED=0

# expect <allowed|refused> <args...>
expect() {
  local outcome="$1" output status
  shift
  output="$(bash "$SCRIPT" "$@" 2>&1)"
  status=$?
  if [[ "$outcome" == allowed && $status -eq 0 && -z "$output" ]] \
    || [[ "$outcome" == refused && $status -eq 1 && "$output" == *"'${*: -1}' does not match"* ]]; then
    PASSED=$((PASSED + 1))
    echo "ok   - $* is $outcome"
  else
    FAILED=$((FAILED + 1))
    echo "FAIL - $* should be $outcome: exit $status"
    while IFS= read -r line; do echo "       | $line"; done <<< "$output"
  fi
}

expect allowed fix/42-null-children
expect allowed chore/tidy-docs
expect allowed --pr feature/7-oauth2-login
expect refused claude/project-thread-ot9sjt
expect refused --pr claude/project-thread-ot9sjt
expect refused --pr patch-1
expect refused ""

# Branches Actions and Dependabot create are allowed only as a PR's head.
for branch in docs/release-notes docs/backfill-blog-posts dependabot/nuget/all-nuget-1a2b3c; do
  expect allowed --pr "$branch"
  expect refused "$branch"
done
# Only those exact names: another docs/ branch is still refused.
expect refused --pr docs/release-notes-pr-12
expect refused --pr docs/fix-typo

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
