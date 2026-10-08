#!/usr/bin/env bash
# dotfiles' pre-push gate, run by .github/hooks/pre-push (a copy of the
# Template's). dotfiles isn't a .NET repo, so its gate is what its CI runs:
# the repo-ci-baseline skill's test.sh, which also checks that dotfiles'
# copies of Template files haven't drifted.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# Under a hook git sets GIT_DIR (and GIT_INDEX_FILE in a linked worktree), as
# the Template's gate.sh says. test.sh's tests build scratch repos, and with
# these set their git commands write into this repo instead.
# shellcheck disable=SC2046 # one variable name per word, on purpose
unset $(git rev-parse --local-env-vars)

exec "$ROOT/Support For New Projects/.claude/skills/repo-ci-baseline/test.sh"
