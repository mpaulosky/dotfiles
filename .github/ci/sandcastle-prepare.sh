#!/usr/bin/env bash
# This repo's own setup for the Sandcastle workflow's run, called by
# .github/workflows/sandcastle.yml after it checks out main and before it sets
# up git for the PAT and installs the packages. It runs on the hosted runner,
# never in the sandbox, with none of the workflow's secrets in its environment
# and no credential in git, so what it fetches is sent nothing private.
#
# It is still code on the runner, and the steps after it run with the PAT and the
# Claude credential and trust whatever it leaves behind: the workspace and
# .git/config, the home directory (~/.npmrc, ~/.claude/skills), PATH, GITHUB_ENV,
# GITHUB_PATH and the global git config. Change none of those, never run anything
# unpinned, and have a person review every change to this file.
#
# The Seed does nothing. Put here what the run needs and the runner lacks, such
# as the skills .sandcastle/lib/repo-config.mts's SANDBOX_SKILLS mounts from the
# runner's ~/.claude/skills (pin what you fetch to a commit), then exit non-zero
# on anything the run can't do without.
#
# The workflow is Owned by the repo-ci-baseline Template and is overwritten on
# every Apply; this file is Seed, so it belongs to the repo.
set -euo pipefail

exit 0
