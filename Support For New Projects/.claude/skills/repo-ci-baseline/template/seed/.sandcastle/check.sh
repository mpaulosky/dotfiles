#!/usr/bin/env bash
# Sandcastle's check for the local gate, called by .github/ci/gate-checks.sh:
# type-check .sandcastle/ and run its tests when it, package.json, the pnpm
# files, or the local review's script, skill and agent and Claude Review's workflow
# (which its tests read) changed since <merge-base> (always, when <merge-base> is empty).
#
#   .sandcastle/check.sh <merge-base>
set -euo pipefail
base="${1-}"
if [[ -n "$base" ]] && git diff --quiet --no-renames "$base" HEAD -- .sandcastle package.json ':(glob)pnpm-*.yaml' \
  scripts/review.sh .claude/skills/pre-push-review .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml; then
  exit 0
fi
echo "── Sandcastle check"
pnpm run check:sandcastle
