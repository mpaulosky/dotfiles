#!/usr/bin/env bash
# dotfiles' pre-push gate, run by .github/hooks/pre-push (a copy of the
# Template's) and by Sandcastle in its sandbox. dotfiles isn't a .NET repo, so
# its gate is what its CI runs: the repo-ci-baseline skill's test.sh, which
# also checks that dotfiles' copies of Template files haven't drifted, then
# the Sandcastle check when .sandcastle/ or its packages changed.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# Under a hook git sets GIT_DIR (and GIT_INDEX_FILE in a linked worktree), as
# the Template's gate.sh says. test.sh's tests build scratch repos, and with
# these set their git commands write into this repo instead.
# shellcheck disable=SC2046 # one variable name per word, on purpose
unset $(git rev-parse --local-env-vars)

"$ROOT/Support For New Projects/.claude/skills/repo-ci-baseline/test.sh"

# Where this branch left origin/main; with none, the Sandcastle check runs.
# dockerfile.test.mts checks the sandbox image's tools against the versions
# the Template's gate.sh and dotfiles' CI pin, so a change to either reruns it.
base="$(git merge-base origin/main HEAD 2>/dev/null || true)"
if [[ -z "$base" ]] || ! git diff --quiet --no-renames "$base" HEAD -- .sandcastle package.json ':(glob)pnpm-*.yaml' \
  .github/workflows/repo-ci-baseline.yml "Support For New Projects/.claude/skills/repo-ci-baseline/template/owned/scripts/gate.sh"; then
  echo
  echo "── Sandcastle check"
  pnpm run check:sandcastle
fi
