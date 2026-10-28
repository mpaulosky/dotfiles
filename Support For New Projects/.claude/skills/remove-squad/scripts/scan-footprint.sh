#!/usr/bin/env bash
# Read-only inventory of the squad-team footprint in the current git repo.
# Usage: scan-footprint.sh [term]   (term defaults to "squad")
# Run it at step 0 to scope the removal and again at the end to prove it's gone.
set -euo pipefail

term="${1:-squad}"
root="$(git rev-parse --show-toplevel)"
cd "$root"
url="$(git remote get-url upstream 2>/dev/null || git remote get-url origin 2>/dev/null || true)"
repo="${GITHUB_REPOSITORY:-${url%.git}}"
repo="${repo#*github.com[:/]}"
# Anything but OWNER/REPO (an SSH host alias, a GHES host, a port) can't tell gh its repository.
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || repo=""

section() { printf '\n== %s ==\n' "$1"; }

section "Framework directories"
find . -path ./.git -prune -o -type d -iname ".${term}*" -print 2>/dev/null || true

section "Workflows named after the framework"
find .github/workflows -maxdepth 1 -type f -iname "*${term}*" 2>/dev/null | grep . || echo "(none)"

section "Workflows mentioning the framework"
git grep -il "$term" -- '.github/workflows/*' 2>/dev/null || echo "(none)"

section "Agent definitions mentioning the framework"
git grep -il "$term" -- '.github/agents/*' '.claude/agents/*' '.copilot/agents/*' '*.agent.md' '*.prompt.md' 2>/dev/null || echo "(none)"

section "Skill directories mentioning the framework"
git grep -il "$term" -- '*/skills/*' 2>/dev/null | sed -E 's#(.*/skills/[^/]+)/.*#\1#' | sort -u || echo "(none)"

section "MCP, lint and ignore configs mentioning the framework"
git grep -il "$term" -- '.mcp.json' '*/mcp*.json' '.vscode/*' '.gitignore' '.gitattributes' '.yamllint*' '.markdownlint*' 2>/dev/null || echo "(none)"

section "Hooks and scripts mentioning the framework"
echo "core.hooksPath: $(git config --get core.hooksPath || echo '(unset)')"
git grep -il "$term" -- '.github/hooks/*' '.githooks/*' 'scripts/*' '*.sh' '*.ps1' 2>/dev/null || echo "(none)"

section "Every other tracked file mentioning the framework"
git grep -il "$term" -- . \
  ':!.github/workflows/*' ':!.github/agents/*' ':!.claude/agents/*' ':!*/skills/*' \
  ':!.github/hooks/*' ':!.githooks/*' ':!scripts/*' ":!.${term}/*" 2>/dev/null || echo "(none)"

section "Untracked or ignored files mentioning the framework (runtime state)"
git ls-files --others --exclude-standard --ignored -z 2>/dev/null \
  | xargs -0 -r grep -il "$term" 2>/dev/null | head -50 || true
find . -path ./.git -prune -o -iname "*${term}*" -print 2>/dev/null \
  | while read -r f; do git ls-files --error-unmatch "$f" >/dev/null 2>&1 || echo "$f"; done

section "Branches carrying the framework's prefix"
git branch -a --format='%(refname:short)' | grep -iE "(^|/)(${term}|sprint)/" || echo "(none)"

section "Issue-tracker labels"
if [ -z "$repo" ]; then
  echo "(couldn't read OWNER/REPO from the remote; check labels by hand)"
elif command -v gh >/dev/null 2>&1; then # gh-repo: ok
  if labels="$(GH_REPO="${repo:?}" gh label list --limit 500 --json name --jq '.[].name')"; then
    matching="$(grep -i "$term" <<<"$labels" || true)"
    echo "${matching:-(none)}"
    echo "-- open issues/PRs carrying those labels --"
    while IFS= read -r l; do
      [ -n "$l" ] || continue
      n="$(GH_REPO="${repo:?}" gh issue list --state open --label "$l" --json number --jq 'length' 2>/dev/null || echo '?')"
      echo "$l: $n open"
    done <<<"$matching"
  else
    echo "(gh couldn't list the labels of $repo; check labels by hand)"
  fi
else
  echo "(gh not installed; check labels by hand)" # gh-repo: ok
fi
