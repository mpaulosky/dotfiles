#!/usr/bin/env bash
# Sandcastle's check for the local gate, called by .github/ci/gate-checks.sh:
# type-check .sandcastle/ and run its tests when it, package.json or the pnpm
# files changed since <merge-base> (always, when <merge-base> is empty).
#
#   .sandcastle/check.sh <merge-base>
set -euo pipefail
base="${1-}"
if [[ -n "$base" ]] && git diff --quiet --no-renames "$base" HEAD -- .sandcastle package.json ':(glob)pnpm-*.yaml'; then
  exit 0
fi
echo "── Sandcastle check"
pnpm run check:sandcastle
