#!/usr/bin/env bash
# The local review's ledger: what /pre-push-review found on this branch's diff
# and what became of each finding. The gate refuses a diff without a clean
# review (the "Local review" step of scripts/gate.sh).
#   scripts/review.sh report                 the review of HEAD's diff
#   scripts/review.sh accept R3 "<reason>"   the person accepts a finding (never on their behalf)
#   scripts/review.sh notes                  the PR description's "## Review notes"
#   scripts/review.sh advisory               the follow-up issue's open Advisory findings
#   scripts/review.sh body <in> <out>        the PR description in <in> with those notes put in, written to <out>
#                                            (the only way they go into a description: see the skill's step 9)
# The logic and the other commands are in .sandcastle/lib/review-ledger.mts. It
# works on the repository of the current directory, with the tsx this checkout
# installed (`pnpm install`).
set -euo pipefail

# CDPATH cleared: with it set, cd prints the directory and ROOT gets two lines.
ROOT="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
# The ledger imports REPO_SLUG and NOT_OWNED_BASELINE_PATHS from the repo's own
# repo-config.mts; without them tsx stops at link time with an error that doesn't say why.
CONFIG="$ROOT/.sandcastle/lib/repo-config.mts"
if [[ ! -f "$CONFIG" ]]; then
  echo "❌ $CONFIG doesn't exist: the ledger needs it (the repo-ci-baseline skill's references/pre-push-review.md, Adapting step 1)." >&2
  exit 1
fi
for name in REPO_SLUG NOT_OWNED_BASELINE_PATHS; do
  if ! grep -qE "^export[[:space:]]+(const|let)[[:space:]]+$name\b" "$CONFIG"; then
    echo "❌ $CONFIG has no export of $name. Add REPO_SLUG and NOT_OWNED_BASELINE_PATHS to it, each as a one-line export const (the repo-ci-baseline skill's references/pre-push-review.md, Adapting step 1)." >&2
    exit 1
  fi
done
# A fresh worktree (the Baseline's re-Apply makes one) has no packages yet:
# install them. Its output goes to stderr, since callers read what every
# command prints.
if [[ ! -x "$TSX" ]]; then
  if ! command -v pnpm > /dev/null 2>&1; then
    echo "❌ $TSX not found, and pnpm isn't installed: run corepack enable pnpm, then pnpm install." >&2
    exit 1
  fi
  if ! pnpm --dir "$ROOT" install --frozen-lockfile >&2 || [[ ! -x "$TSX" ]]; then
    echo "❌ $TSX not found after pnpm install --frozen-lockfile." >&2
    exit 1
  fi
fi
exec "$TSX" "$ROOT/.sandcastle/lib/review-ledger.mts" "$@"
