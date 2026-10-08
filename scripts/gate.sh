#!/usr/bin/env bash
# dotfiles' pre-push gate, run by .github/hooks/pre-push (a copy of the
# Template's). dotfiles isn't a .NET repo, so its gate is what its CI runs:
# the repo-ci-baseline skill's test.sh, which also checks that dotfiles'
# copies of Template files haven't drifted.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
exec "$ROOT/Support For New Projects/.claude/skills/repo-ci-baseline/test.sh"
