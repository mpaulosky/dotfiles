#!/usr/bin/env bash
# Sandcastle's check for the local gate, called by .github/ci/gate-checks.sh:
# type-check .sandcastle/ and run its tests when it, package.json, the pnpm
# files, or the local review's script, skills and agent and Claude Review's workflow
# (which its tests read) changed since <merge-base> (always, when <merge-base> is empty).
# A repo adds the other files its own tests read in .sandcastle/check-paths.txt (Seed):
# one git pathspec per line, blank lines and lines starting with # ignored.
#
#   .sandcastle/check.sh <merge-base>
set -euo pipefail
# Under a git hook git sets these, and a GATE_COMMAND naming this script runs it without scripts/gate.sh,
# which unsets them before every check: the tests' scratch repos and the diff below would act on the wrong repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
base="${1-}"
paths=(.sandcastle package.json ':(glob)pnpm-*.yaml'
  scripts/review.sh .claude/skills/pre-push-review .claude/skills/hardening-review .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml)
extra="$(dirname "${BASH_SOURCE[0]}")/check-paths.txt"
if [[ -f "$extra" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    paths+=("$line")
  done < "$extra"
fi
if [[ -n "$base" ]] && git diff --quiet --no-renames "$base" HEAD -- "${paths[@]}"; then
  exit 0
fi
echo "── Sandcastle check"
pnpm run check:sandcastle
