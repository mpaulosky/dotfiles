#!/usr/bin/env bash
# dotfiles' pre-push gate, run by .github/hooks/pre-push (a copy of the
# Template's) and by Sandcastle in its sandbox. dotfiles isn't a .NET repo, so
# its gate is what its CI runs: the repo-ci-baseline skill's test.sh, which
# also checks that dotfiles' copies of Template files haven't drifted, then
# the Sandcastle check when .sandcastle/ or its packages changed. First of all,
# the local review (/pre-push-review) must have passed the branch.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# Under a hook git sets GIT_DIR (and GIT_INDEX_FILE in a linked worktree), as
# the Template's gate.sh says. test.sh's tests build scratch repos, and with
# these set their git commands write into this repo instead.
# shellcheck disable=SC2046 # one variable name per word, on purpose
unset $(git rev-parse --local-env-vars)

# Where this branch left origin/main; with none, the Sandcastle check runs and
# the local review can't be checked.
base="$(git merge-base origin/main HEAD 2>/dev/null || true)"

# The local review (/pre-push-review) must have passed this branch's diff, with no
# open Critical or Warning finding: scripts/review.sh keeps the record under
# .git/review/. First, so a push it would refuse doesn't wait for the tests.
# GATE_SKIP_REVIEW=1 skips it, for gate runs before the push (the review's own, and
# while iterating), never for a push; Sandcastle's sandboxes set it (lib/skills.mts).
echo
echo "── Local review"
if [[ "${GATE_SKIP_REVIEW:-}" == "1" ]]; then
  echo "Local review check skipped (GATE_SKIP_REVIEW=1)."
elif [[ -z "$base" ]]; then
  echo "No origin/main to diff against, so the review can't be checked: run git fetch origin main." >&2
  exit 1
else
  scripts/review.sh check "$base"
fi

"$ROOT/Support For New Projects/.claude/skills/repo-ci-baseline/test.sh"

# With no origin/main, the Sandcastle check runs.
# dockerfile.test.mts checks the sandbox image's tools against the versions
# the Template's gate.sh and dotfiles' CI pin, so a change to either reruns it.
# repo-config.test.mts reads the Template's .sandcastle/ and test.sh's copy list,
# and template.test.mts type-checks and tests the Template's .sandcastle/.
# review-ledger.test.mts runs scripts/review.sh and pre-push-review-skill.test.mts
# reads the review's skills and agent, and Claude Review's workflow (whose notes step
# it checks against the ledger's markers), here and in the Template's copies.
skill="Support For New Projects/.claude/skills/repo-ci-baseline"
if [[ -z "$base" ]] || ! git diff --quiet --no-renames "$base" HEAD -- .sandcastle package.json ':(glob)pnpm-*.yaml' \
  .github/workflows/repo-ci-baseline.yml "$skill/template/owned/scripts/gate.sh" "$skill/template/owned/.sandcastle" "$skill/template/seed/.sandcastle" "$skill/test.sh" \
  scripts/review.sh .claude/skills/pre-push-review .claude/skills/hardening-review .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml \
  "$skill/template/owned/scripts/review.sh" "$skill/template/owned/.claude" "$skill/template/owned/.github/workflows/claude-review.yml"; then
  echo
  echo "── Sandcastle check"
  pnpm run check:sandcastle
fi
