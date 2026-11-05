#!/usr/bin/env bash
# Sandcastle's check for the local gate, called by .github/ci/gate-checks.sh:
# type-check .sandcastle/ and run its tests when it, package.json, the pnpm
# files, or the local review's script, skills and agent and Claude Review's workflow
# (which its tests read) changed since <merge-base> (always, when <merge-base> is empty).
# A repo adds the paths its own tests read, one per line, to .sandcastle/check-paths.txt
# (blank lines and lines starting with # are ignored); this script is Owned, so it isn't edited.
#
#   .sandcastle/check.sh <merge-base>
set -euo pipefail
# Under a git hook git sets these, and a GATE_COMMAND naming this script runs it without scripts/gate.sh,
# which unsets them before every check: the tests' scratch repos and the diff below would act on the wrong repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
base="${1-}"
extra=()
if [[ -f .sandcastle/check-paths.txt ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == '#'* ]] && continue
    extra+=(":(literal)$line")
  done < .sandcastle/check-paths.txt
fi
if [[ -n "$base" ]] && git diff --quiet --no-renames "$base" HEAD -- .sandcastle package.json ':(glob)pnpm-*.yaml' \
  scripts/review.sh .claude/skills/pre-push-review .claude/skills/hardening-review .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml \
  ${extra[@]+"${extra[@]}"}; then
  exit 0
fi
echo "── Sandcastle check"
pnpm run check:sandcastle
