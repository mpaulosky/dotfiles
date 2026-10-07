#!/usr/bin/env bash
# One line per open PR across the repos in github/repos.txt, ending with the
# landing decision's next action. Read-only. The logic is github/status.py
# (and github/landing.py); see references/automerge.md#status-and-the-landing-decision.
#
#   status.sh                   every repo in github/repos.txt
#   status.sh <owner/repo>...   just these
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/github/status.py" "$@"
