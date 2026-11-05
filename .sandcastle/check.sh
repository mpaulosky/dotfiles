#!/usr/bin/env bash
# Sandcastle's check for the local gate, called by .github/ci/gate-checks.sh:
# type-check .sandcastle/ and run its tests when it, package.json, the pnpm
# files, or the local review's script, skills and agent and Claude Review's workflow
# (which its tests read) changed since <merge-base> (always, when <merge-base> is empty).
# A repo adds the other files its own tests read in .sandcastle/check-paths.txt (Seed):
# one git pathspec per line (LF, CRLF or a lone CR ends one), surrounding whitespace ignored, blank lines and lines starting
# with # skipped (a # after a path is part of it). The list only adds to the built-in paths:
# the two are diffed separately, so an :(exclude) or :^ line can't remove one of them. An exclude
# line only trims the list's other lines; git reads a list of exclude lines alone as "everything
# else", so such a list is treated as empty rather than watching the whole repo. A line that matches no file in the repo (a mistyped
# path, a glob git reads differently) can never make a change run the check, since git diff is silent for a pathspec with no match: each
# such line is named on stderr on every run, and the check still runs or skips as before.
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
root="$(git -C "$here" rev-parse --show-toplevel)"
cd "$root"

paths=(.sandcastle package.json ':(glob)pnpm-*.yaml'
  scripts/review.sh .claude/skills/pre-push-review .claude/skills/hardening-review .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml)
listed=()
positive=0
exclude='^:(\(([^),]*,)*exclude(,[^)]*)?\)|/?[!^])'
if [[ -f "$extra" ]]; then
  # Read the file first: a list that can't be read stops the script (set -e) rather than reading as empty.
  extra_text="$(tr '\r' '\n' < "$extra")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#$'\xef\xbb\xbf'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    listed+=("$line")
    [[ "$line" =~ $exclude ]] || positive=$((positive + 1))
  done <<< "$extra_text"
fi
[[ $positive -gt 0 ]] || listed=()
# A positive line that matches no tracked file watches nothing: say so, instead of silently dropping that coverage. An exclude line only trims, so it is
# not asked. A pathspec git rejects matches nothing here too, and still makes the diff below fail, so the check runs.
for line in ${listed[@]+"${listed[@]}"}; do
  [[ "$line" =~ $exclude ]] && continue
  [[ -n "$(git ls-files -- "$line" 2>/dev/null || true)" ]] ||
    printf '⚠ .sandcastle/check-paths.txt: %s matches no file in this repo, so a change to it will not run the Sandcastle check\n' "${line//[[:cntrl:]]/?}" >&2
done

unchanged() { git diff --quiet --no-renames "$base" HEAD -- "$@"; }
# A pathspec git rejects makes unchanged fail, so the check runs rather than being skipped.
if [[ -n "$base" ]] && unchanged "${paths[@]}" && { [[ ${#listed[@]} -eq 0 ]] || unchanged "${listed[@]}"; }; then
  exit 0
fi
echo "── Sandcastle check"
pnpm run check:sandcastle
