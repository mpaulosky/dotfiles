#!/usr/bin/env bash
# Checks a PR title against the commit format in
# .github/instructions/git-commit-instructions.md.
#
#   scripts/check-pr-title.sh "<title>"
#
# The PR title becomes the squash commit's subject on main and the Release's
# name, so it follows the same rules as a commit: a type, an optional scope,
# then a summary that starts with a capital and doesn't end with a period.
# .github/workflows/pr-title.yml runs it on every PR but Dependabot's.
# Exits 0 when the title is allowed, 1 (with the reason) when it isn't.
set -euo pipefail

title="${1:-}"
types="feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert"

if ! [[ "$title" =~ ^($types)(\([^\)]+\))?!?:\ (.+)$ ]]; then
  echo "PR title '${title}' doesn't follow the commit format."
  echo "Expected: <type>(<scope>): <Summary>, with <type> one of ${types//|/, }; the scope is optional."
  exit 1
fi
summary="${BASH_REMATCH[3]}"
if [[ "$summary" =~ ^[a-z] ]]; then
  echo "PR title '${title}' starts its summary with a lowercase letter."
  echo "Expected: a capital, as in 'fix: Return an empty list'."
  exit 1
fi
if [[ "$summary" == *. ]]; then
  echo "PR title '${title}' ends with a period."
  exit 1
fi
