#!/usr/bin/env bash
# Watch a round's PRs and act on the landing decision until they land: update a
# branch that's BEHIND and re-request Copilot, mark a draft ready (--ready),
# arm auto-merge where the decision says so (dotfiles, an unarmed release-blog
# PR), and leave a Baseline repo's reviewed PR to its PR Auto-Merge. Prints only
# changes. The logic is github/land.py and github/landing.py; see
# references/automerge.md#landing-a-round.
#
#   land.sh [--once] [--dry-run] [--ready] [--interval s] [--timeout min] [--blog-wait min] [<owner/repo>|<owner/repo#n>]...
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/github/land.py" "$@"
