#!/usr/bin/env bash
# Check, and with --fix apply, the Baseline's GitHub settings on a repo.
# The logic is github/settings.py; see references/github-settings.md.
#
#   github-settings.sh <owner/repo>...       report; exit 1 on any drift
#   github-settings.sh --fix <owner/repo>... apply the standard
#   github-settings.sh --all                 every repo in github/repos.txt
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/github/settings.py" "$@"
