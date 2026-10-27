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
bash "$owned/scripts/tests/sync-copilot-review.test.sh" || fail "sync-copilot-review.test.sh"
# Both places that enforce the sync run the script's --check, which skips a repo without the code-review skill.
grep -qF 'scripts/sync-copilot-review.sh --check' "$owned/scripts/gate.sh" || fail "the Owned gate.sh must run scripts/sync-copilot-review.sh --check"
grep -qF 'scripts/sync-copilot-review.sh --check' "$owned/.github/workflows/copilot-review-sync.yml" \
  || fail "the Owned copilot-review-sync.yml must run scripts/sync-copilot-review.sh --check"
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
  "$skill_dir/tests/seed-check.test.sh"
  "$owned/scripts/gate.sh" "$owned/scripts/check-branch-name.sh" "$owned/scripts/tests/check-branch-name.test.sh"
  "$owned/scripts/check-pr-title.sh" "$owned/scripts/tests/check-pr-title.test.sh"
  "$owned/scripts/sync-copilot-review.sh" "$owned/scripts/tests/sync-copilot-review.test.sh"
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
# PR Review Submitted, the Sandcastle workflow, the git hooks and Sandcastle's Owned files as copies of
# the Template's files, which must not drift from them. Its scripts/gate.sh is
# its own: it runs this script. Sandcastle's lib/repo-config.mts reads this list.
dotfiles="$(cd "$skill_dir/../../../.." && pwd)"
for file in .github/workflows/claude-review.yml .github/workflows/pr-automerge.yml .github/workflows/pr-review-submitted.yml \
  .github/workflows/sandcastle.yml \
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
  .sandcastle/lib/skills.mts .sandcastle/lib/skills.test.mts .sandcastle/lib/ui-role-fixture.mts .sandcastle/lib/ui-role-fixture.test.mts .sandcastle/lib/umbrella.mts .sandcastle/lib/umbrella.test.mts \
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

step "Sandcastle workflow"
# A repo without the SANDCASTLE_GH_TOKEN secret doesn't run Sandcastle in Actions, and its cron would fail every two hours if the workflow
# didn't skip: the first step reports whether the secret is set, and every later step waits for it. The skills step reads the repo's list as
# data, before the PAT is wired into git, and runs none of the repo's code; the CI workflow names it follows are the real ones.
if python3 -I -c 'import yaml' &>/dev/null; then
  yaml_py=(python3 -I)
else
  need uvx
  yaml_py=(uvx --with pyyaml python -I)
fi
secrets_script="$md_tmp/sandcastle-secrets.sh"
skills_script="$md_tmp/sandcastle-skills.sh"
"${yaml_py[@]}" - "$owned/.github/workflows/sandcastle.yml" "$owned/.github/workflows/ci.yml" "$owned/.github/workflows/claude-review.yml" \
  "$secrets_script" "$skills_script" <<'PY' || fail "the Owned sandcastle.yml must skip every step but the secret check when SANDCASTLE_GH_TOKEN is unset"
import sys, yaml
workflow, ci, review, secrets_out, skills_out = sys.argv[1:6]
doc = yaml.safe_load(open(workflow))
steps = doc["jobs"]["sandcastle"]["steps"]
gate = "steps.secrets.outputs.enabled == 'true'"
names = [step["name"] for step in steps]
assert steps[0]["name"] == "Check the secrets" and steps[0]["id"] == "secrets", "the first step must be the secret check, with id secrets"
for step in steps[1:]:
    assert step.get("if") in (gate, "always() && " + gate), f"step '{step['name']}' must wait for the secret check, exactly: {step.get('if')!r}"
assert names.index("Install the skills") < names.index("Set up git for the PAT"), "the skills must be installed before git holds the PAT"
skills = steps[names.index("Install the skills")]
assert "secrets" not in str(skills.get("env", {})).lower() and "token" not in str(skills.get("env", {})).lower(), "the skills step must get no secret"
assert "sandcastle-prepare" not in open(workflow).read() and ".github/ci/sandcastle-skills.txt" in skills["run"], "the skills step reads the data file and runs no repo script"
workflows = doc["on"]["workflow_run"]["workflows"]
for name in (yaml.safe_load(open(ci))["name"], yaml.safe_load(open(review))["name"], "repo-ci-baseline Template"):
    assert name in workflows, f"workflow_run doesn't follow {name}"
open(secrets_out, "w").write(steps[0]["run"])
open(skills_out, "w").write(skills["run"])
PY
# The secret check's own script, run like a run: step with no shell: set (bash -e), with a temp GITHUB_OUTPUT.
run_secrets() {
  local out; out="$(mktemp)"; secrets_rc=0
  env -i PATH="$PATH" SANDCASTLE_GH_TOKEN="$1" ANTHROPIC_API_KEY="$2" CLAUDE_CODE_OAUTH_TOKEN="$3" GITHUB_OUTPUT="$out" \
    bash --noprofile --norc -e "$secrets_script" &>/dev/null || secrets_rc=$?
  secrets_out="$(<"$out")"; rm -f "$out"
}
run_secrets "" "" ""
[[ $secrets_rc -eq 0 && $secrets_out == "enabled=false" ]] || fail "sandcastle.yml: no token must end green with enabled=false (exit $secrets_rc, output '$secrets_out')"
run_secrets token "" ""
[[ $secrets_rc -ne 0 && $secrets_out != *enabled=true* ]] || fail "sandcastle.yml: a token with no Claude credential must fail (exit $secrets_rc, output '$secrets_out')"
run_secrets token key ""
[[ $secrets_rc -eq 0 && $secrets_out == "enabled=true" ]] || fail "sandcastle.yml: a token and ANTHROPIC_API_KEY must give enabled=true (exit $secrets_rc, output '$secrets_out')"
run_secrets token "" oauth
[[ $secrets_rc -eq 0 && $secrets_out == "enabled=true" ]] || fail "sandcastle.yml: a token and CLAUDE_CODE_OAUTH_TOKEN must give enabled=true (exit $secrets_rc, output '$secrets_out')"
# The skills step, run for real against a local repository standing in for dotfiles. The workspace holds the repo's list; HOME is empty.
fixture="$md_tmp/skills-fixture"
fixture_skills="Support For New Projects/.claude/skills"
fixture_git() { git -C "$1" -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@example.com "${@:2}"; }
fixture_repo() { git init -q -b main "$1"; git -C "$1" config uploadpack.allowFilter true; git -C "$1" config uploadpack.allowAnySHA1InWant true; }
fixture_repo "$fixture"
long_name="$(printf 'a%.0s' {1..64})"
max_names=(); for i in {1..32}; do max_names+=("s$i"); done
for name in alpha beta linked "$long_name" "${max_names[@]}"; do
  mkdir -p "$fixture/$fixture_skills/$name"
  echo "$name" > "$fixture/$fixture_skills/$name/SKILL.md"
done
ln -s /etc "$fixture/$fixture_skills/linked/escape"
ln -s alpha "$fixture/rootlink"  # a symlink the skills don't touch, which must not matter
fixture_git "$fixture" add -A
fixture_git "$fixture" commit -q -m skills
good_sha="$(git -C "$fixture" rev-parse HEAD)"
# A commit that is not in main, as a fork's commit served by hash would be.
fixture_git "$fixture" checkout -q -b fork
echo forked > "$fixture/$fixture_skills/alpha/SKILL.md"
fixture_git "$fixture" commit -q -am forked
fork_sha="$(git -C "$fixture" rev-parse HEAD)"
fixture_git "$fixture" checkout -q main
# A skill folder that is itself a symlink, beside the others.
ln -s alpha "$fixture/$fixture_skills/dirlink"
fixture_git "$fixture" add -A
fixture_git "$fixture" commit -q -m "a symlinked skill folder"
dirlink_sha="$(git -C "$fixture" rev-parse HEAD)"
# A folder above the skills that is a symlink: the skill's own folder and the files in it are real.
fixture2="$md_tmp/skills-fixture-ancestor"
fixture_repo "$fixture2"
mkdir -p "$fixture2/real/.claude/skills/alpha"
echo alpha > "$fixture2/real/.claude/skills/alpha/SKILL.md"
ln -s real "$fixture2/Support For New Projects"
fixture_git "$fixture2" add -A
fixture_git "$fixture2" commit -q -m ancestor
ancestor_sha="$(git -C "$fixture2" rev-parse HEAD)"
skills_url="file://$fixture"
run_skills() { # the list's text; sets skills_rc, skills_log, skills_home
  local ws="$md_tmp/skills-ws" log
  rm -rf "$ws" "$md_tmp/skills-home" "$md_tmp/skills-runner"
  mkdir -p "$ws/.github/ci" "$md_tmp/skills-home" "$md_tmp/skills-runner"
  [[ $1 == "<none>" ]] || printf '%s' "$1" > "$ws/.github/ci/sandcastle-skills.txt"
  [[ -z ${skills_preexisting:-} ]] || mkdir -p "$md_tmp/skills-home/.claude/skills/$skills_preexisting"
  skills_home="$md_tmp/skills-home"; skills_rc=0; log="$md_tmp/skills.log"
  (cd "$ws" && env -i PATH="$PATH" HOME="$skills_home" RUNNER_TEMP="$md_tmp/skills-runner" DOTFILES_URL="$skills_url" \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bash --noprofile --norc -e "$skills_script") &>"$log" || skills_rc=$?
  skills_log="$(<"$log")"
  # No line of the list is ever run as a command, whatever the outcome.
  [[ ! -e "$ws/pwned" ]] || fail "sandcastle.yml: the skills list was run as a command (list '$1')"
}
skills_installed() { [[ -e "$skills_home/.claude/skills/$1/SKILL.md" ]]; }
for list in "<none>" "" $'# only a comment\n\n'; do
  run_skills "$list"
  [[ $skills_rc -eq 0 && ! -e "$skills_home/.claude" ]] || fail "sandcastle.yml: a skills list without entries must install nothing and pass (exit $skills_rc, list '$list')"
done
run_skills $'# pinned\ndotfiles-sha '"$good_sha"$'\nskill alpha\nskill beta\n'
{ [[ $skills_rc -eq 0 ]] && skills_installed alpha && skills_installed beta && [[ ! -e "$skills_home/.claude/skills/linked" ]]; } \
  || fail "sandcastle.yml: the listed skills, and only those, must be installed (exit $skills_rc): $skills_log"
run_skills "dotfiles-sha $good_sha"$'\nskill alpha'
{ [[ $skills_rc -eq 0 ]] && skills_installed alpha; } || fail "sandcastle.yml: a list with no trailing newline must install its skills (exit $skills_rc)"
run_skills "dotfiles-sha $dirlink_sha"$'\n \t \nskill alpha\n'
{ [[ $skills_rc -eq 0 ]] && skills_installed alpha && [[ ! -e "$skills_home/.claude/skills/dirlink" ]]; } \
  || fail "sandcastle.yml: a symlink beside the listed skills, and a whitespace-only line, must not matter (exit $skills_rc): $skills_log"
# The caps' boundaries: 32 skills and a 64-character name pass.
max_list="dotfiles-sha $good_sha"; for name in "${max_names[@]}"; do max_list+=$'\nskill '"$name"; done
run_skills "$max_list"
{ [[ $skills_rc -eq 0 ]] && skills_installed s1 && skills_installed s32; } || fail "sandcastle.yml: 32 skills must be installed (exit $skills_rc): $skills_log"
run_skills "dotfiles-sha $good_sha"$'\nskill '"$long_name"
{ [[ $skills_rc -eq 0 ]] && skills_installed "$long_name"; } || fail "sandcastle.yml: a 64-character skill name must be installed (exit $skills_rc): $skills_log"
over_list="dotfiles-sha $good_sha"; for i in {1..33}; do over_list+=$'\nskill s'"$i"; done
bad_lists=(
  $'skill alpha\n' "dotfiles-sha $good_sha"$'\n'
  "dotfiles-sha ${good_sha:0:39}"$'\nskill alpha\n' "dotfiles-sha ${good_sha^^}"$'\nskill alpha\n'
  "dotfiles-sha $good_sha"$'\ndotfiles-sha '"$good_sha"$'\nskill alpha\n'
  "dotfiles-sha $good_sha"$'\nskill Alpha\n' "dotfiles-sha $good_sha"$'\nskill ../alpha\n' "dotfiles-sha $good_sha"$'\nskill alpha beta\n'
  "dotfiles-sha $good_sha"$'\nskill alpha\nskill alpha\n' "dotfiles-sha $good_sha"$'\nskill\n' "dotfiles-sha $good_sha"$'\nskill -alpha\n'
  "dotfiles-sha $good_sha"$'\nplugin alpha\n' "dotfiles-sha $good_sha"$'\nskill alpha # trailing\n'
  "dotfiles-sha $good_sha"$'\nskill alpha\n$(touch pwned)\n' "dotfiles-sha $good_sha"$'\nskill alpha;touch pwned\n'
  "dotfiles-sha $good_sha"$'\nskill alpha\n`touch pwned`\n'
  "dotfiles-sha ${good_sha//[0-9a-f]/0}"$'\nskill alpha\n' "dotfiles-sha $good_sha"$'\nskill missing\n' "dotfiles-sha $good_sha"$'\nskill linked\n'
  "dotfiles-sha $good_sha"$'\r\nskill alpha\r\n' "dotfiles-sha $good_sha"$'\n  # indented\nskill alpha\n'
  "dotfiles-sha $fork_sha"$'\nskill alpha\n' "dotfiles-sha $dirlink_sha"$'\nskill dirlink\n' "$over_list"
  "dotfiles-sha $good_sha"$'\nskill '"${long_name}a"
)
for list in "${bad_lists[@]}"; do
  run_skills "$list"
  [[ $skills_rc -ne 0 && ! -e "$skills_home/.claude" ]] || fail "sandcastle.yml: a bad skills list must fail and install nothing (exit $skills_rc, list '$list')"
done
# The rules are the step's own, not git's or the file system's: each bad list is refused for its reason.
check_refused() { # the list's text, the part of the error it must give
  run_skills "$1"
  [[ $skills_rc -ne 0 && $skills_log == *"$2"* ]] || fail "sandcastle.yml: a skills list '$1' must be refused with '$2' (exit $skills_rc): $skills_log"
}
check_refused "dotfiles-sha ${good_sha^^}"$'\nskill alpha' "40-digit"
check_refused "dotfiles-sha ${good_sha:0:39}"$'\nskill alpha' "40-digit"
check_refused "dotfiles-sha $good_sha"$'\r\nskill alpha\r\n' "40-digit"
check_refused "dotfiles-sha $good_sha"$'\nskill Alpha' "lowercase name"
check_refused "dotfiles-sha $good_sha"$'\nskill ../alpha' "lowercase name"
check_refused "dotfiles-sha $good_sha"$'\nskill -alpha' "lowercase name"
check_refused "dotfiles-sha $good_sha"$'\nskill '"${long_name}a" "up to 64"
check_refused "$over_list" "at most 32"
check_refused "dotfiles-sha $good_sha"$'\nskill alpha\nskill alpha' "listed once"
check_refused "dotfiles-sha $good_sha"$'\nplugin alpha' "starts with"
check_refused "dotfiles-sha $good_sha"$'\n  # indented\nskill alpha' "starts with"
check_refused "dotfiles-sha $good_sha"$'\nskill alpha beta' "a key and one value"
check_refused "dotfiles-sha $good_sha" "needs a dotfiles-sha line"
check_refused "skill alpha" "needs a dotfiles-sha line"
check_refused "dotfiles-sha $good_sha"$'\nskill missing' "has no missing skill"
check_refused "dotfiles-sha $good_sha"$'\nskill linked' "holds a symlink"
check_refused "dotfiles-sha $dirlink_sha"$'\nskill dirlink' "holds a symlink"
check_refused "dotfiles-sha $fork_sha"$'\nskill alpha' "main branch"
skills_url="file://$fixture2"
check_refused "dotfiles-sha $ancestor_sha"$'\nskill alpha' "holds a symlink"
skills_url="file://$fixture"
skills_preexisting=alpha
check_refused "dotfiles-sha $good_sha"$'\nskill alpha' "File exists"
[[ ! -e "$skills_home/.claude/skills/alpha/alpha" ]] || fail "sandcastle.yml: a skill linked itself inside an existing folder"
skills_preexisting=
# A line is never printed, whichever rule rejects it: one starting with :: would otherwise run as a workflow command from the log.
for list in "::add-mask::secretvalue" "::add-mask::secretvalue x" "skill ::add-mask::secretvalue" "dotfiles-sha ::add-mask::secretvalue" \
  "dotfiles-sha $good_sha"$'\nskill alpha ::add-mask::secretvalue' "dotfiles-sha $good_sha"$'\nbogus ::add-mask::secretvalue'; do
  run_skills "$list"
  [[ $skills_rc -ne 0 && $skills_log != *add-mask* && $skills_log != *secretvalue* ]] \
    || fail "sandcastle.yml: a rejected skills line must not be echoed (exit $skills_rc, list '$list'): $skills_log"
done
[[ ! -e "$seed/.github/ci/sandcastle-prepare.sh" ]] || fail "the Seed carries a repo script the Owned sandcastle.yml would run; the skills list replaced it (ADR 0009)"
run_skills "$(<"$seed/.github/ci/sandcastle-skills.txt")"
[[ $skills_rc -eq 0 && ! -e "$skills_home/.claude" ]] || fail "the Seed .github/ci/sandcastle-skills.txt must install nothing"
if grep -vF 'mpaulosky/dotfiles.git' "$owned/.github/workflows/sandcastle.yml" | grep -qE 'sandcastle:dotfiles|Blazor-Server|TicketManager|IssueTracker|IssueManager|Articles|auth0'; then
  grep -nE 'sandcastle:dotfiles|Blazor-Server|TicketManager|IssueTracker|IssueManager|Articles|auth0' "$owned/.github/workflows/sandcastle.yml"
  fail "the Owned sandcastle.yml names a repo; it carries no per-repo values"
fi

# The skills step's claims stay limited to what it does, and its ancestor test names the branch, not a ref git could resolve to a tag.
grep -qF 'refs/heads/main:refs/remotes/dotfiles/main' "$owned/.github/workflows/sandcastle.yml" \
  || fail "the Owned sandcastle.yml must fetch dotfiles' main as refs/heads/main, never a bare main"
for file in "$owned/.github/workflows/sandcastle.yml" "$skill_dir/references/sandcastle.md"; do
  grep -qF "still run the repo's" "$file" \
    || fail "${file#"$skill_dir"/} must say the later steps still run the repo's own code from main, so the skills step's claim stays limited to that step"
done

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
"$skill_dir/tests/seed-check.test.sh" || fail "seed-check.test.sh"

step "reapply.sh smoke test"
"$skill_dir/tests/reapply.test.sh" || fail "reapply.test.sh"

echo
if [[ $failures -gt 0 ]]; then
  echo "test.sh: $failures check(s) failed"
  exit 1
fi
echo "test.sh: all checks passed"
