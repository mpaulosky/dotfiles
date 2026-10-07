#!/usr/bin/env bash
# Roll a re-Apply round out across the Baseline repos: reapply.sh on
# TicketManager first, the rest only once its re-Apply PR has merged, one at a
# time so one pre-push gate runs at a time. Run it again after TicketManager
# lands. The logic is github/rollout.py; see SKILL.md's Change the Baseline.
#
#   rollout.sh --brings <owner/repo#n,#n,...> [--root dir] [--dry-run]
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/github/rollout.py" "$@"
