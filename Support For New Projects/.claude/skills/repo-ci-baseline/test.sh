#!/usr/bin/env bash
# Validate the repo-ci-baseline Template before it's Applied anywhere.
#
#   test.sh
#
# Runs the Template's own tests (hook suites, auto-merge script tests,
# release-script pytest), the renderer oracle and the GitHub scripts' tests
# (settings, the landing decision, status, land and rollout), the Claude Review
# benchmark's tests, lints its workflows, YAML, shell
# and Markdown with the Template's configs, checks that
# Owned files carry no {{PLACEHOLDER}} and that the Owned scripts tell every gh
# command its repository, checks dotfiles' copies of Owned files (its
# .sandcastle/ included) and the Seed Sandcastle files, and smoke-tests apply.sh and
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
bash "$owned/scripts/tests/check-git-hooks.test.sh" || fail "check-git-hooks.test.sh"

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

step "GitHub scripts tests (settings, landing decision, status, land, rollout)"
(cd "$skill_dir" && "${pytest_cmd[@]}" -q -p no:cacheprovider github/tests) || fail "github scripts pytest"

step "Claude Review benchmark tests (scoring, arguments, config swap, the workflow it reads)"
# PyYAML lets the test that reads the Template's claude-review.yml run instead of skipping.
if python3 -c 'import pytest, yaml' &>/dev/null; then
  bench_cmd=(python3 -m pytest)
else
  need uvx
  bench_cmd=(uvx --with pyyaml pytest)
fi
(cd "$skill_dir" && "${bench_cmd[@]}" -q -p no:cacheprovider -rs bench/tests) || fail "benchmark pytest"

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
  "$skill_dir/land.sh" "$skill_dir/rollout.sh"
  "$skill_dir/tests/apply.test.sh" "$skill_dir/tests/reapply.test.sh" "$skill_dir/tests/dotfiles-gate.test.sh"
  "$owned/scripts/gate.sh" "$owned/scripts/check-branch-name.sh" "$owned/scripts/tests/check-branch-name.test.sh"
  "$owned/scripts/check-pr-title.sh" "$owned/scripts/tests/check-pr-title.test.sh"
  "$owned/scripts/check-git-hooks.sh" "$owned/scripts/tests/check-git-hooks.test.sh" "$owned/scripts/review.sh"
  "$seed/.github/ci/prepare.sh" "$seed/.github/ci/gate-checks.sh" "$seed/.sandcastle/check.sh"
  "$owned/.github/hooks/pre-commit" "$owned/.github/hooks/pre-push" "$owned/.github/hooks/post-checkout"
  "$owned/.github/hooks/tests/pre-commit.test.sh" "$owned/.github/hooks/tests/pre-push.test.sh"
)
shellcheck "${shell_files[@]}" || fail "shellcheck"

step "markdownlint"
# The skill's and the Template's Markdown, linted with the config the Template
# Applies. --config needs a file name ending in .markdownlint-cli2.jsonc.
command cp -f "$owned/.markdownlint-cli2.jsonc" "$md_tmp/template.markdownlint-cli2.jsonc"
(cd "$skill_dir" && markdownlint-cli2 --config "$md_tmp/template.markdownlint-cli2.jsonc" \
  '*.md' 'references/*.md' 'docs/**/*.md' 'template/**/*.md' 'template/**/.*/**/*.md' '!template/seed/.sandcastle/**') || fail "markdownlint"
# The Seed Sandcastle prompts, as an Applied repo lints them: beside the Owned
# .sandcastle/.markdownlint-cli2.jsonc, which markdownlint-cli2 merges with --config.
mkdir -p "$md_tmp/seed-sandcastle/.sandcastle"
(cd "$seed/.sandcastle" && find . -name '*.md' -exec cp --parents {} "$md_tmp/seed-sandcastle/.sandcastle/" \;)
command cp -f "$owned/.sandcastle/.markdownlint-cli2.jsonc" "$md_tmp/seed-sandcastle/.sandcastle/"
(cd "$md_tmp/seed-sandcastle" && markdownlint-cli2 --config "$md_tmp/template.markdownlint-cli2.jsonc" '.sandcastle/**/*.md') \
  || fail "markdownlint (Seed .sandcastle/)"

step "No placeholders in Owned files"
# Under .sandcastle/ only Apply's own three: Sandcastle fills its prompts'
# {{NAME}}s ({{SHARED_RULES}}, {{ISSUES_JSON}} and the rest) when it runs them.
if grep -rnE '\{\{[A-Z_]+\}\}' --exclude-dir=.sandcastle "$owned" \
  || grep -rnE '\{\{(OWNER|REPO|SOLUTION)\}\}' "$owned/.sandcastle"; then
  fail "Owned files must not carry {{PLACEHOLDER}}s; per-repo values belong in Seed files"
fi

step "Issue references in Owned files name their repo"
# Applied into a repo, a bare #N reads as that repo's own issue or PR
# (mpaulosky/dotfiles#186): write mpaulosky/dotfiles#N, or <Repo>#N for
# another repo's. A citation in parentheses is checked everywhere, tests
# included; elsewhere every #N is, outside the tests' fixture data, except
# HTML entities (&#9;) and the exact examples in EXAMPLES, so an example
# hides nothing else on its line. A Sandcastle *.test.mts carries fixture
# data in its strings, so only its // comment lines are checked for a bare
# #N. Python, not grep -P, which BSD grep lacks.
python3 -I - "$owned" <<'PY' || fail "write issue references in Owned files as mpaulosky/dotfiles#N (or <Repo>#N), not a bare #N"
import pathlib, re, sys

CITATION = re.compile(r"\((?:[^()]*, )?#\d+\)")
BARE = re.compile(r"(?<![\w/&])#\d+\b")
# Examples, not references: the exact text each one sits in.
EXAMPLES = ("`Fixes #123`", "`Refs #456`", "Fixes #42", '"1, #3"', '("Fixes #16.")', "so PR #1 doesn't", "release for #10.")
root = pathlib.Path(sys.argv[1])
found = []
for path in sorted(p for p in root.rglob("*") if p.is_file()):
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        continue
    in_tests = "tests" in path.relative_to(root).parts
    is_ts_test = path.name.endswith(".test.mts")
    for number, line in enumerate(lines, 1):
        text = line
        for example in EXAMPLES:
            # Not followed by a digit, so "Fixes #42" leaves "Fixes #421" whole.
            text = re.sub(re.escape(example) + r"(?!\d)", "", text)
        if CITATION.search(line) or (
            BARE.search(text) and not in_tests and (not is_ts_test or line.lstrip().startswith("//"))
        ):
            found.append(f"{path.relative_to(root)}:{number}: {line.strip()}")
if found:
    print("\n".join(found))
sys.exit(1 if found else 0)
PY

step "gh commands in Owned scripts are told their repository"
# A Baseline repo's gate refuses a gh command under scripts/ that reaches gh's
# default repository, a fork in a fork's clone (auth0-management-app's
# .github/ci/gate-checks.sh), and the repo can't edit Owned files, so a
# re-Apply that brings one would fail every gate there (mpaulosky/dotfiles#267).
# check_gh_repo.py holds the rule; its tests run first, so a check that stopped
# refusing anything can't pass the scripts.
(cd "$skill_dir/tests/gh_repo" && "${pytest_cmd[@]}" -q -p no:cacheprovider .) || fail "gh_repo pytest"
python3 -I "$skill_dir/tests/gh_repo/check_gh_repo.py" "$owned/scripts" \
  || fail "export GH_REPO before an Owned script's first gh command, and give gh repo's subcommands their repository"

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
# Sandcastle's own .gitignore: its secrets, and the logs, worktrees and notes a run leaves.
mkdir -p "$ignore_repo/.sandcastle"
command cp -f "$owned/.sandcastle/.gitignore" "$ignore_repo/.sandcastle/.gitignore"
for path in .env logs/x worktrees/x work/x follow-up.json; do
  git -C "$ignore_repo" check-ignore -q ".sandcastle/$path" || fail ".sandcastle/.gitignore must ignore $path"
done
if git -C "$ignore_repo" check-ignore -q .sandcastle/.env.example; then
  fail ".sandcastle/.gitignore must not ignore .env.example"
fi

step "dotfiles' copies of Template files"
# dotfiles isn't a Baseline repo, so it carries Claude Review, PR Auto-Merge,
# PR Review Submitted, the git hooks and Sandcastle's Owned files as copies of
# the Template's files, which must not drift from them. Its scripts/gate.sh is
# its own: it runs this script. Sandcastle's lib/repo-config.mts reads this list.
dotfiles="$(cd "$skill_dir/../../../.." && pwd)"
for file in .github/workflows/claude-review.yml .github/workflows/pr-automerge.yml .github/workflows/pr-review-submitted.yml \
  .github/scripts/post_claude_review.py \
  .github/hooks/pre-commit .github/hooks/pre-push .github/hooks/post-checkout scripts/check-branch-name.sh \
  scripts/review.sh .claude/agents/pre-push-reviewer.md .claude/skills/pre-push-review/SKILL.md \
  .claude/skills/pre-push-review/lenses.md .claude/skills/pre-push-review/review-bar.md \
  .sandcastle/.env.example .sandcastle/.gitignore .sandcastle/.markdownlint-cli2.jsonc .sandcastle/critique-prompt.md \
  .sandcastle/intake-prompt.md .sandcastle/lib/agents.mts .sandcastle/lib/agents.test.mts .sandcastle/lib/branches.mts \
  .sandcastle/lib/branches.test.mts .sandcastle/lib/build.mts .sandcastle/lib/build.test.mts .sandcastle/lib/building.mts \
  .sandcastle/lib/building.test.mts .sandcastle/lib/checkpoint.mts .sandcastle/lib/checkpoint.test.mts .sandcastle/lib/config.mts \
  .sandcastle/lib/config.test.mts .sandcastle/lib/critique.mts .sandcastle/lib/critique.test.mts .sandcastle/lib/errors.mts \
  .sandcastle/lib/follow-up-pass.mts .sandcastle/lib/follow-up-pass.test.mts .sandcastle/lib/follow-up.mts \
  .sandcastle/lib/follow-up.test.mts .sandcastle/lib/gate.mts .sandcastle/lib/gate.test.mts .sandcastle/lib/git-sandbox-fake.mts \
  .sandcastle/lib/github.mts .sandcastle/lib/github.test.mts .sandcastle/lib/handback.mts .sandcastle/lib/handback.test.mts \
  .sandcastle/lib/host-safety.mts .sandcastle/lib/host-safety.test.mts .sandcastle/lib/intake.mts .sandcastle/lib/intake.test.mts \
  .sandcastle/lib/limits.mts .sandcastle/lib/limits.test.mts .sandcastle/lib/overlap.mts .sandcastle/lib/overlap.test.mts \
  .sandcastle/lib/plain-text.mts .sandcastle/lib/plain-text.test.mts .sandcastle/lib/plan.mts .sandcastle/lib/plan.test.mts .sandcastle/lib/pre-push-review-skill.test.mts .sandcastle/lib/prompts.mts .sandcastle/lib/prompts.test.mts \
  .sandcastle/lib/queue.mts .sandcastle/lib/queue.test.mts .sandcastle/lib/report.mts .sandcastle/lib/report.test.mts \
  .sandcastle/lib/review-ledger.mts .sandcastle/lib/review-ledger.test.mts \
  .sandcastle/lib/round.mts .sandcastle/lib/round.test.mts .sandcastle/lib/sandbox-env.mts .sandcastle/lib/sandbox-env.test.mts \
  .sandcastle/lib/scan.mts .sandcastle/lib/scan.test.mts .sandcastle/lib/shell.mts .sandcastle/lib/shell.test.mts \
  .sandcastle/lib/skills.mts .sandcastle/lib/skills.test.mts .sandcastle/lib/umbrella.mts .sandcastle/lib/umbrella.test.mts \
  .sandcastle/lib/work.mts .sandcastle/lib/work.test.mts .sandcastle/main.mts .sandcastle/tsconfig.json; do
  cmp -s "$owned/$file" "$dotfiles/$file" || fail "dotfiles' $file differs from the Template's; copy it over"
  # The mode too: a hook that isn't executable doesn't run.
  owned_x=no; dotfiles_x=no
  [[ -x "$owned/$file" ]] && owned_x=yes
  [[ -x "$dotfiles/$file" ]] && dotfiles_x=yes
  [[ "$owned_x" == "$dotfiles_x" ]] || fail "dotfiles' $file is executable: $dotfiles_x, the Template's: $owned_x"
done
# Every Owned Sandcastle file, so a new one is checked before anyone lists it above.
while IFS= read -r rel; do
  cmp -s "$owned/.sandcastle/$rel" "$dotfiles/.sandcastle/$rel" \
    || fail "dotfiles' .sandcastle/$rel differs from the Template's; copy it over"
done < <(cd "$owned/.sandcastle" && find . -type f -printf '%P\n' | sort)

step "Seed Sandcastle files"
# Written from dotfiles' copies, so none of dotfiles' own text may stay behind.
if grep -rnE 'dotfiles|repo-ci-baseline|Support For New Projects' "$seed/.sandcastle" "$seed/package.json"; then
  fail "the Seed Sandcastle files describe dotfiles; describe any Baseline repo instead"
fi
# The sandbox runs the gate, so its linters are the versions the Owned gate.sh pins.
for name in ACTIONLINT_VERSION ZIZMOR_VERSION SHELLCHECK_VERSION MARKDOWNLINT_CLI2_VERSION; do
  pinned="$(sed -nE "s/^$name=\"([^\"]+)\".*/\1/p" "$owned/scripts/gate.sh")"
  image="$(sed -nE "s/^ARG $name=([^ ]+).*/\1/p" "$seed/.sandcastle/Dockerfile")"
  [[ -n "$pinned" && "$image" == "$pinned" ]] \
    || fail "the Seed .sandcastle/Dockerfile's $name is '$image', gate.sh's '$pinned'; set it, and its SHA-256s, to gate.sh's"
done
# And the .NET SDK channel global.json pins.
sdk="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["sdk"]["version"])' "$owned/global.json")"
channel="$(sed -nE 's/^ARG DOTNET_CHANNEL=([^ ]+).*/\1/p' "$seed/.sandcastle/Dockerfile")"
[[ "$channel" == "$(cut -d. -f1-2 <<< "$sdk")" ]] \
  || fail "the Seed .sandcastle/Dockerfile's DOTNET_CHANNEL is '$channel'; global.json's SDK is $sdk"

step "apply.sh smoke test"
"$skill_dir/tests/apply.test.sh" || fail "apply.test.sh"
"$skill_dir/tests/dotfiles-gate.test.sh" || fail "dotfiles-gate.test.sh"

step "reapply.sh smoke test"
"$skill_dir/tests/reapply.test.sh" || fail "reapply.test.sh"

echo
if [[ $failures -gt 0 ]]; then
  echo "test.sh: $failures check(s) failed"
  exit 1
fi
echo "test.sh: all checks passed"
