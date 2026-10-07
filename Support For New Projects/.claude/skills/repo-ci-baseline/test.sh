#!/usr/bin/env bash
# Validate the repo-ci-baseline Template before it's Applied anywhere.
#
#   test.sh
#
# Runs the Template's own tests (hook suites, auto-merge script tests,
# release-script pytest), the renderer oracle and the GitHub scripts' tests
# (settings, the landing decision, status and land), lints its workflows, YAML, shell
# and Markdown with the Template's configs, checks that
# Owned files carry no {{PLACEHOLDER}}, and smoke-tests apply.sh and
# reapply.sh against throwaway repos. dotfiles CI runs this on every change
# under the skill, and it's the check to run before committing a Template
# change.
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
owned="$skill_dir/template/owned"
seed="$skill_dir/template/seed"

# A local pytest run must not leave caches in the Template for Apply to copy.
export PYTHONDONTWRITEBYTECODE=1
# The tests build throwaway repos. A global init.templateDir would install this
# machine's own hooks into each of them and block their commits.
GIT_TEMPLATE_DIR="$(mktemp -d)"
export GIT_TEMPLATE_DIR
md_tmp="$(mktemp -d)"
trap 'command rm -rf "$GIT_TEMPLATE_DIR" "$md_tmp"' EXIT

failures=0
step() { echo; echo "── $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }
need() {
  command -v "$1" &>/dev/null || { echo "test.sh: $1 is required" >&2; exit 2; }
}
for tool in actionlint zizmor yamllint shellcheck markdownlint-cli2 git; do need "$tool"; done

step "Hook tests"
bash "$owned/.github/hooks/tests/pre-push.test.sh" || fail "pre-push.test.sh"
bash "$owned/.github/hooks/tests/pre-commit.test.sh" || fail "pre-commit.test.sh"
bash "$owned/scripts/tests/check-branch-name.test.sh" || fail "check-branch-name.test.sh"
bash "$owned/scripts/tests/check-pr-title.test.sh" || fail "check-pr-title.test.sh"

step "Auto-merge script tests"
need node
node --test "$owned/.github/scripts/tests/pr-automerge.test.mjs" || fail "pr-automerge.test.mjs"

step "Release script tests"
if python3 -c 'import pytest' &>/dev/null; then
  pytest_cmd=(python3 -m pytest)
else
  need uvx
  pytest_cmd=(uvx pytest)
fi
(cd "$owned" && "${pytest_cmd[@]}" -q -p no:cacheprovider .github/scripts/tests) || fail "pytest"

step "Renderer oracle"
# release_post.py's output rendered by cmark-gfm (GitHub) and kramdown (GitHub
# Pages); kramdown runs from a local Ruby with its pinned gems, else Docker.
if python3 -c 'import cmarkgfm, pytest' &>/dev/null; then
  oracle_cmd=(python3 -m pytest)
else
  need uvx
  oracle_cmd=(uvx --with cmarkgfm==2025.10.22 pytest)
fi
(cd "$skill_dir/tests/render_oracle" && "${oracle_cmd[@]}" -q -p no:cacheprovider .) || fail "renderer oracle"

step "GitHub scripts tests (settings, landing decision, status, land)"
(cd "$skill_dir" && "${pytest_cmd[@]}" -q -p no:cacheprovider github/tests) || fail "github scripts pytest"

step "actionlint"
mapfile -t workflows < <(find "$owned/.github/workflows" -name '*.yml' | sort)
actionlint "${workflows[@]}" || fail "actionlint"

step "zizmor"
zizmor --offline --min-severity medium "$owned/.github" || fail "zizmor"

step "yamllint"
mapfile -t yaml_files < <(find "$owned" "$seed" -name '*.yml' -o -name '*.yaml' | sort)
yamllint -c "$owned/.yamllint.yml" "${yaml_files[@]}" || fail "yamllint"

step "shellcheck"
shell_files=(
  "$skill_dir/apply.sh" "$skill_dir/reapply.sh" "$skill_dir/test.sh" "$skill_dir/github-settings.sh" "$skill_dir/status.sh"
  "$skill_dir/land.sh"
  "$skill_dir/tests/apply.test.sh" "$skill_dir/tests/reapply.test.sh"
  "$owned/scripts/gate.sh" "$owned/scripts/check-branch-name.sh" "$owned/scripts/tests/check-branch-name.test.sh"
  "$owned/scripts/check-pr-title.sh" "$owned/scripts/tests/check-pr-title.test.sh"
  "$seed/.github/ci/prepare.sh" "$seed/.github/ci/gate-checks.sh"
  "$owned/.github/hooks/pre-commit" "$owned/.github/hooks/pre-push" "$owned/.github/hooks/post-checkout"
  "$owned/.github/hooks/tests/pre-commit.test.sh" "$owned/.github/hooks/tests/pre-push.test.sh"
)
shellcheck "${shell_files[@]}" || fail "shellcheck"

step "markdownlint"
# The skill's and the Template's Markdown, linted with the config the Template
# Applies. --config needs a file name ending in .markdownlint-cli2.jsonc.
command cp -f "$owned/.markdownlint-cli2.jsonc" "$md_tmp/template.markdownlint-cli2.jsonc"
(cd "$skill_dir" && markdownlint-cli2 --config "$md_tmp/template.markdownlint-cli2.jsonc" \
  '*.md' 'references/*.md' 'docs/**/*.md' 'template/**/*.md' 'template/**/.*/**/*.md') || fail "markdownlint"

step "No placeholders in Owned files"
if grep -rnE '\{\{[A-Z_]+\}\}' "$owned"; then
  fail "Owned files must not carry {{PLACEHOLDER}}s; per-repo values belong in Seed files"
fi

step ".gitignore keeps secrets out"
# Repos keep Auth0 and other secrets in .env, and the Template's .gitignore
# replaces theirs on every Apply.
ignore_repo="$md_tmp/ignore-repo"
git init -q "$ignore_repo"
command cp -f "$owned/.gitignore" "$ignore_repo/.gitignore"
for path in .env .env.local .sandcastle/.env src/App/.env.local; do
  git -C "$ignore_repo" check-ignore -q "$path" || fail ".gitignore must ignore $path"
done
if git -C "$ignore_repo" check-ignore -q .env.example; then
  fail ".gitignore must not ignore .env.example"
fi

step "apply.sh smoke test"
"$skill_dir/tests/apply.test.sh" || fail "apply.test.sh"

step "reapply.sh smoke test"
"$skill_dir/tests/reapply.test.sh" || fail "reapply.test.sh"

echo
if [[ $failures -gt 0 ]]; then
  echo "test.sh: $failures check(s) failed"
  exit 1
fi
echo "test.sh: all checks passed"
