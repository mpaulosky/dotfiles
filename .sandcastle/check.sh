#!/usr/bin/env bash
# Sandcastle's check for the local gate, called by .github/ci/gate-checks.sh:
# type-check .sandcastle/ and run its tests when it, package.json, the pnpm
# files, or the local review's script, skills and agent and Claude Review's workflow
# (which its tests read) changed since <merge-base> (always, when <merge-base> is empty).
# A repo adds the other files its own tests read in .sandcastle/check-paths.txt (Seed):
# one git pathspec per line, surrounding whitespace ignored, blank lines and lines starting
# with # skipped (a # after a path is part of it). The list only adds to the built-in paths:
# the two are diffed separately, so an :(exclude) or :^ line can't remove one of them.
#
#   .sandcastle/check.sh <merge-base>
set -euo pipefail
# Under a git hook git sets these, and a GATE_COMMAND naming this script runs it without scripts/gate.sh,
# which unsets them before every check: the tests' scratch repos and the diff below would act on the wrong repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
base="${1-}"
here="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
extra="$here/check-paths.txt"
# Pathspecs and `pnpm run` are relative to the repo root, wherever this is run from.
cd "$(git -C "$here" rev-parse --show-toplevel)"

paths=(.sandcastle package.json ':(glob)pnpm-*.yaml'
  scripts/review.sh .claude/skills/pre-push-review .claude/skills/hardening-review .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml)
listed=()
if [[ -f "$extra" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#$'\xef\xbb\xbf'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    listed+=("$line")
  done < "$extra"
fi

unchanged() { git diff --quiet --no-renames "$base" HEAD -- "$@"; }
# A pathspec git rejects makes unchanged fail, so the check runs rather than being skipped.
if [[ -n "$base" ]] && unchanged "${paths[@]}" && { [[ ${#listed[@]} -eq 0 ]] || unchanged "${listed[@]}"; }; then
  exit 0
fi
echo "── Sandcastle check"
pnpm run check:sandcastle
