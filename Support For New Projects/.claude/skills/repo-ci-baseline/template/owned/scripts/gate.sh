#!/usr/bin/env bash
# Local quality gate, run by .github/hooks/pre-push and safe to run by hand.
# Lints the Markdown, YAML, workflow and shell files changed since origin/main
# (every unpushed commit, with the same configs as CI), builds the solution,
# then runs each test project under tests/. Exits non-zero on the first
# failing gate.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'

step() { echo -e "\n${CYAN}▶ $1${RESET}"; }

# Files added, copied, modified or renamed since this branch left origin/main.
# Without an origin/main (a fresh clone of a fork, say) lint every tracked file.
if BASE="$(git merge-base HEAD origin/main 2>/dev/null)"; then
  CHANGED="$(git diff --name-only --diff-filter=ACMR "$BASE" HEAD)"
else
  CHANGED="$(git ls-files)"
fi

mapfile -t MD_FILES < <(grep -E '\.md$' <<< "$CHANGED" | grep -Ev '^docs/blogs/' || true)
mapfile -t YAML_FILES < <(grep -E '\.ya?ml$' <<< "$CHANGED" || true)
mapfile -t WORKFLOW_FILES < <(grep -E '^\.github/(workflows/[^/]+\.ya?ml|dependabot\.ya?ml|actionlint\.ya?ml|zizmor\.ya?ml)$' <<< "$CHANGED" || true)
# Shell scripts, plus extensionless scripts and git hooks.
mapfile -t SHELL_FILES < <(grep -E '\.sh$|^scripts/[^/.]+$|^\.github/hooks/((pre|post)-[a-z-]+|(prepare-)?commit-msg)$' <<< "$CHANGED" || true)

# An installed markdownlint-cli2 (as the pre-commit hook uses) when there is
# one; otherwise this pinned version, never whatever the registry serves at push time.
MARKDOWNLINT_CLI2_VERSION="0.23.3"
# The same for the workflow and shell linters. The fallbacks run through uvx or
# docker, so an installed tool only needs to be on PATH to be preferred. Keep
# these in step with .github/workflows/lint-actions.yml.
ACTIONLINT_VERSION="1.7.12"
ZIZMOR_VERSION="1.30.1"
SHELLCHECK_VERSION="v0.11.0"

# Fallback probes: can the fallback actually run here? A docker binary with a
# stopped daemon can't, and must skip rather than fail the gate.
have_docker() { docker info &>/dev/null; }
have_uvx() { command -v uvx &>/dev/null; }

# Runs an installed tool, else its fallback command, else warns that the check
# is skipped locally (CI's Lint Actions workflow still runs it).
# Usage: run_tool <name> <install hint> <probe function> <fallback command...> -- <args...>
run_tool() {
  local name="$1" hint="$2" probe="$3"; shift 3
  local fallback=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do fallback+=("$1"); shift; done
  if [[ $# -eq 0 ]]; then
    echo "run_tool ${name}: missing -- before the tool arguments" >&2
    exit 2
  fi
  shift
  if command -v "$name" &>/dev/null; then
    "$name" "$@"
  elif "$probe"; then
    "${fallback[@]}" "$@"
  else
    echo -e "${YELLOW}⚠️  ${name} not found — skipping. CI's Lint Actions workflow still runs it.${RESET}"
    echo -e "   To enable: ${CYAN}${hint}${RESET}"
  fi
}

step "Markdown lint (${#MD_FILES[@]} changed file(s))"
if [[ ${#MD_FILES[@]} -gt 0 ]]; then
  if [[ -x "$ROOT/node_modules/.bin/markdownlint-cli2" ]]; then
    "$ROOT/node_modules/.bin/markdownlint-cli2" "${MD_FILES[@]}"
  elif command -v markdownlint-cli2 &>/dev/null; then
    markdownlint-cli2 "${MD_FILES[@]}"
  else
    npx --yes "markdownlint-cli2@${MARKDOWNLINT_CLI2_VERSION}" "${MD_FILES[@]}"
  fi
fi

step "YAML lint (${#YAML_FILES[@]} changed file(s))"
if [[ ${#YAML_FILES[@]} -gt 0 ]]; then
  if command -v yamllint &>/dev/null; then
    YAMLLINT_ARGS=()
    [[ -f .yamllint.yml ]] && YAMLLINT_ARGS=(-c .yamllint.yml)
    yamllint "${YAMLLINT_ARGS[@]}" "${YAML_FILES[@]}"
  else
    echo -e "${YELLOW}⚠️  yamllint not found — skipping. CI's Lint YAML workflow still checks these files.${RESET}"
    echo -e "   To enable: ${CYAN}pipx install yamllint${RESET}"
  fi
fi

# actionlint checks workflow syntax, expressions and contexts, and lints
# every run: block with shellcheck. zizmor audits the workflows for security
# problems: script injection, over-broad permissions, unpinned actions.
step "Workflow lint (${#WORKFLOW_FILES[@]} changed file(s))"
if [[ ${#WORKFLOW_FILES[@]} -gt 0 ]]; then
  # No file arguments: actionlint finds every workflow, and zizmor audits the
  # whole repo (workflows and dependabot.yml), as CI does.
  run_tool actionlint "install actionlint (github.com/rhysd/actionlint), or Docker" have_docker \
    docker run --rm -v "$ROOT:/repo" -w /repo "rhysd/actionlint:${ACTIONLINT_VERSION}" \
    --
  # --offline: no GitHub token needed locally. CI also runs the online audits.
  run_tool zizmor "pipx install zizmor, or install uv" have_uvx \
    uvx "zizmor@${ZIZMOR_VERSION}" \
    -- --offline --min-severity medium .
fi

step "Shell lint (${#SHELL_FILES[@]} changed file(s))"
if [[ ${#SHELL_FILES[@]} -gt 0 ]]; then
  run_tool shellcheck "install shellcheck, or Docker" have_docker \
    docker run --rm -v "$ROOT:/mnt" -w /mnt "koalaman/shellcheck:${SHELLCHECK_VERSION}" \
    -- "${SHELL_FILES[@]}"
fi

step "Build"
mapfile -t SOLUTIONS < <(find . -maxdepth 1 -name '*.slnx')
dotnet build "${SOLUTIONS[@]}" --configuration Release -warnaserror

step "Tests"
# The rule ci.yml's discover-tests job uses: a project is a test project when
# its .csproj says <IsTestProject>true</IsTestProject>. Helper libraries such as
# TestingSupport.Library don't, and dotnet test on Microsoft Testing Platform
# fails on them ("No test projects were found").
mapfile -t TEST_PROJECTS < <(find tests -mindepth 2 -maxdepth 2 -name '*.csproj' -print0 2>/dev/null \
  | xargs -0 -r grep -l '<IsTestProject>true</IsTestProject>' | sort)
if [[ ${#TEST_PROJECTS[@]} -eq 0 ]]; then
  echo -e "${YELLOW}No test projects under tests/ — skipping.${RESET}"
fi
for project in "${TEST_PROJECTS[@]}"; do
  dotnet test "$project" --configuration Release
done

echo -e "\n${GREEN}✅ Gate passed.${RESET}"
