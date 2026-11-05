#!/usr/bin/env bash
# Tests for apply.sh, against throwaway repos and a copy of the skill with a
# small stand-in Template, so the cases don't depend on the real Template's
# contents.
# check() evals its condition string later, so the single quotes are deliberate
# and the variables it reads look unused to shellcheck.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'command rm -rf "$work"' EXIT

pass=0
failed=0
ok() { pass=$((pass + 1)); }
bad() { echo "FAIL: $1" >&2; failed=$((failed + 1)); }
check() { if eval "$2"; then ok; else bad "$1"; fi; }

# A skill copy whose Template has one Owned and two Seed files, plus a cache
# a local pytest run could leave behind, and a Sandcastle section (an Owned
# tsconfig.json, a Seed role prompt and a Seed package.json).
skill="$work/skill"
mkdir -p "$skill/template/owned/.github/workflows" "$skill/template/owned/.github/scripts/__pycache__" \
  "$skill/template/seed/docs" "$skill/template/seed/.github/ci" \
  "$skill/template/owned/.sandcastle" "$skill/template/seed/.sandcastle/roles" \
  "$skill/template/owned/scripts" "$skill/template/owned/.sandcastle/lib" "$skill/template/owned/.claude/agents" "$skill/template/owned/.claude/skills/pre-push-review" \
  "$skill/template/owned/.claude/skills/other" "$skill/template/seed/.claude/rules"
command cp -f "$skill_dir/apply.sh" "$skill/"
printf 'name: CI\n' > "$skill/template/owned/.github/workflows/ci.yml"
printf 'stale\n' > "$skill/template/owned/.github/scripts/__pycache__/x.pyc"
printf '# {{REPO}} by {{OWNER}}, solution {{SOLUTION}}\n' > "$skill/template/seed/docs/SECURITY.md"
printf '#!/usr/bin/env bash\n' > "$skill/template/seed/.github/ci/prepare.sh"
chmod +x "$skill/template/seed/.github/ci/prepare.sh"
printf '{"compilerOptions": {}}\n' > "$skill/template/owned/.sandcastle/tsconfig.json"
printf '# {{REPO}} architect for issue {{TASK_ID}}\n' > "$skill/template/seed/.sandcastle/roles/architect.md"
printf '{"private": true}\n' > "$skill/template/seed/package.json"
# The local review: its script, agent and skill need the ledger in .sandcastle/lib/, so they are part of the
# Sandcastle section; a neighbouring script and skill are not.
printf '#!/usr/bin/env bash\n' > "$skill/template/owned/scripts/review.sh"
printf '#!/usr/bin/env bash\n' > "$skill/template/owned/scripts/other.sh"
printf '// ledger\n' > "$skill/template/owned/.sandcastle/lib/review-ledger.mts"
printf '// ledger tests\n' > "$skill/template/owned/.sandcastle/lib/review-ledger.test.mts"
printf '// skill tests, which import the ledger\n' > "$skill/template/owned/.sandcastle/lib/pre-push-review-skill.test.mts"
printf 'agent\n' > "$skill/template/owned/.claude/agents/pre-push-reviewer.md"
printf 'skill\n' > "$skill/template/owned/.claude/skills/pre-push-review/SKILL.md"
printf 'lenses\n' > "$skill/template/owned/.claude/skills/pre-push-review/lenses.md"
# The hardening review's skill is part of the Sandcastle section too, with a nested file to show the pattern crosses a folder.
mkdir -p "$skill/template/owned/.claude/skills/hardening-review/scripts"
printf 'hardening\n' > "$skill/template/owned/.claude/skills/hardening-review/SKILL.md"
printf '#!/usr/bin/env python3\n' > "$skill/template/owned/.claude/skills/hardening-review/scripts/mutate.py"
printf 'other\n' > "$skill/template/owned/.claude/skills/other/SKILL.md"
# The Sandcastle workflow and the Seed skills list it reads are part of the Sandcastle section too.
printf 'name: Sandcastle\n' > "$skill/template/owned/.github/workflows/sandcastle.yml"
printf '# skills\n' > "$skill/template/seed/.github/ci/sandcastle-skills.txt"
# The session guidance for handing a pull request off to Sandcastle (an Owned rules file, in the Sandcastle section).
mkdir -p "$skill/template/owned/.claude/rules"
printf '# Hand a pull request off to Sandcastle\n' > "$skill/template/owned/.claude/rules/sandcastle-hand-off.md"
# The security record's README: Owned in every repo, while its entries are left alone by a re-Apply.
mkdir -p "$skill/template/owned/.security"
printf '# The security record\n' > "$skill/template/owned/.security/README.md"
apply="$skill/apply.sh"

# Hooks off: a global init.templateDir can install hooks (such as a
# post-checkout that sets core.hooksPath) into every throwaway repo.
git_q() { git -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@example.com "$@"; }
new_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" remote add origin "https://github.com/acme/Widget.git"
}
commit_all() { git_q -C "$1" add -A && git_q -C "$1" commit -q -m "$2"; }

# ── An empty repo (no commits) can be Applied on main ───────────────────────
repo="$work/empty repo"
new_repo "$repo"
touch "$repo/Widget.slnx"
check "empty repo: apply succeeds" '"$apply" "$repo" >/dev/null'
check "empty repo: Owned file written" '[[ -f "$repo/.github/workflows/ci.yml" ]]'
check "empty repo: placeholders filled" \
  'grep -qx "# Widget by acme, solution Widget" "$repo/docs/SECURITY.md"'
check "empty repo: Seed file keeps its execute bit" '[[ -x "$repo/.github/ci/prepare.sh" ]]'
check "empty repo: hooksPath set" '[[ "$(git -C "$repo" config --local core.hooksPath)" == .github/hooks ]]'
check "empty repo: caches not copied" '[[ ! -e "$repo/.github/scripts/__pycache__" ]]'

# ── Guards on a repo with history ───────────────────────────────────────────
repo="$work/guarded"
new_repo "$repo"
mkdir -p "$repo/.github/workflows" "$repo/docs"
printf 'name: old CI\n' > "$repo/.github/workflows/ci.yml"
printf 'name: sync\n' > "$repo/.github/workflows/sync-readme.yml"
printf '# our own security policy\n' > "$repo/docs/SECURITY.md"
printf '{"default": false}\n' > "$repo/.markdownlint.json"
mkdir -p "$repo/.claude/rules"
printf 'Add user authentication\n' > "$repo/.copilot-commit-message-instructions.md"
printf '# commit rules\n' > "$repo/.claude/rules/git-commit.md"
commit_all "$repo" "init"

check "guard: refuses main" '! "$apply" "$repo" >/dev/null 2>&1'
git_q -C "$repo" switch -q -c chore/standardize-baseline
echo dirty > "$repo/untracked.txt"
check "guard: refuses an untracked file" '! "$apply" "$repo" >/dev/null 2>&1'
command rm -f "$repo/untracked.txt"
git_q -C "$repo" switch -q --detach
check "guard: refuses a detached HEAD" '! "$apply" "$repo" >/dev/null 2>&1'
git_q -C "$repo" switch -q chore/standardize-baseline

# ── Dry run changes nothing, even on main ───────────────────────────────────
git_q -C "$repo" switch -q main
dry="$("$apply" --dry-run "$repo")"
check "dry run: worktree untouched" '[[ -z "$(git -C "$repo" status --porcelain)" ]]'
check "dry run: hooksPath untouched" '! git -C "$repo" config --local core.hooksPath >/dev/null'
check "dry run: reports the overwrite" 'grep -q "would be overwritten" <<< "$dry"'
git_q -C "$repo" switch -q chore/standardize-baseline

# ── A real Apply on a work branch ───────────────────────────────────────────
out="$("$apply" "$repo")"
check "apply: Owned drift overwritten" 'grep -qx "name: CI" "$repo/.github/workflows/ci.yml"'
check "apply: drift reported" 'grep -A1 "were overwritten" <<< "$out" | grep -q ".github/workflows/ci.yml"'
check "apply: existing Seed file kept" 'grep -qx "# our own security policy" "$repo/docs/SECURITY.md"'
check "apply: kept Seed file reported" 'grep -A1 "Seed files skipped" <<< "$out" | grep -q "docs/SECURITY.md"'
check "apply: leftover kept and reported" \
  '[[ -f "$repo/.github/workflows/sync-readme.yml" ]] && grep -q "sync-readme.yml" <<< "$out"'
check "apply: .markdownlint.json conflict reported" 'grep -q ".markdownlint.json overrides" <<< "$out"'
check "apply: duplicate commit rules reported" \
  'grep -q ".copilot-commit-message-instructions.md duplicates" <<< "$out" && grep -q ".claude/rules/git-commit.md duplicates" <<< "$out"'
check "apply: unfilled placeholders none" 'grep -q "unfilled placeholders (0)" <<< "$out"'

# ── Applying again changes nothing ──────────────────────────────────────────
commit_all "$repo" "apply"
again="$("$apply" "$repo")"
check "re-apply: worktree untouched" '[[ -z "$(git -C "$repo" status --porcelain)" ]]'
check "re-apply: nothing overwritten" 'grep -q "were overwritten.*(0)" <<< "$again"'

# ── An Owned file that lost its execute bit counts as drift ────────────────
printf '#!/usr/bin/env bash\n' > "$skill/template/owned/run.sh"
chmod +x "$skill/template/owned/run.sh"
command cp -f "$skill/template/owned/run.sh" "$repo/run.sh"
chmod -x "$repo/run.sh"
commit_all "$repo" "lose the execute bit"
mode="$("$apply" "$repo")"
check "mode drift: reported" 'grep -A1 "were overwritten" <<< "$mode" | grep -q "run.sh"'
check "mode drift: execute bit restored" '[[ -x "$repo/run.sh" ]]'
command rm -f "$skill/template/owned/run.sh"

# ── Squad still installed ───────────────────────────────────────────────────
repo="$work/squad"
new_repo "$repo"
mkdir -p "$repo/.github/workflows"
printf 'name: squad\n' > "$repo/.github/workflows/squad-ci.yml"
check "squad: conflict reported" '"$apply" --dry-run "$repo" | grep -q "remove-squad"'

# ── No remote and no solution: placeholders left and reported ───────────────
repo="$work/bare"
git init -q -b main "$repo"
out="$("$apply" "$repo")"
check "no remote: placeholder left" 'grep -q "{{REPO}}" "$repo/docs/SECURITY.md"'
check "no remote: unfilled reported" \
  'grep -A2 "unfilled placeholders (2)" <<< "$out" | grep -q "docs/SECURITY.md" && grep -A2 "unfilled placeholders (2)" <<< "$out" | grep -q ".sandcastle/roles/architect.md"'

# ── Sandcastle's files go only into a repo that runs Sandcastle (ADR 0006) ──
sandcastle_files=(.sandcastle/tsconfig.json .sandcastle/roles/architect.md package.json scripts/review.sh .claude/agents/pre-push-reviewer.md \
  .claude/skills/pre-push-review/SKILL.md .claude/skills/pre-push-review/lenses.md \
  .claude/skills/hardening-review/SKILL.md .claude/skills/hardening-review/scripts/mutate.py \
  .sandcastle/lib/review-ledger.mts .sandcastle/lib/review-ledger.test.mts .sandcastle/lib/pre-push-review-skill.test.mts \
  .github/workflows/sandcastle.yml .github/ci/sandcastle-skills.txt .claude/rules/sandcastle-hand-off.md)

# An empty repo gets them. Sandcastle's own {{TASK_ID}} stays and isn't reported as unfilled.
repo="$work/sandcastle empty"
new_repo "$repo"
touch "$repo/Widget.slnx"
out="$("$apply" "$repo")"
check "sandcastle, empty repo: Owned file written" '[[ -f "$repo/.sandcastle/tsconfig.json" ]]'
check "sandcastle, empty repo: Seed role prompt written" '[[ -f "$repo/.sandcastle/roles/architect.md" ]]'
check "sandcastle, empty repo: Seed package.json written" '[[ -f "$repo/package.json" ]]'
check "sandcastle, empty repo: {{REPO}} filled and {{TASK_ID}} kept" \
  'grep -qx "# Widget architect for issue {{TASK_ID}}" "$repo/.sandcastle/roles/architect.md"'
check "sandcastle, empty repo: Sandcastle placeholders not reported as unfilled" 'grep -q "unfilled placeholders (0)" <<< "$out"'
check "sandcastle, empty repo: nothing left out" 'grep -q "Sandcastle files left out.*: 0" <<< "$out"'
check "sandcastle, empty repo: the Sandcastle workflow written" '[[ -f "$repo/.github/workflows/sandcastle.yml" ]]'

# A repo with history and no .sandcastle/ gets none of them, and its other files as before.
repo="$work/sandcastle absent"
new_repo "$repo"
printf '# readme\n' > "$repo/README.md"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
for f in "${sandcastle_files[@]}"; do
  check "sandcastle, no .sandcastle/: $f not written" '[[ ! -e "$repo/$f" ]]'
done
check "sandcastle, no .sandcastle/: other Owned file written" '[[ -f "$repo/.github/workflows/ci.yml" ]]'
check "sandcastle, no .sandcastle/: other Seed file written" '[[ -f "$repo/docs/SECURITY.md" ]]'
check "sandcastle, no .sandcastle/: a neighbouring script is written" '[[ -f "$repo/scripts/other.sh" ]]'
check "sandcastle, no .sandcastle/: a neighbouring skill is written" '[[ -f "$repo/.claude/skills/other/SKILL.md" ]]'
check "sandcastle, no .sandcastle/: the fifteen are reported as left out" 'grep -q "Sandcastle files left out.*: 15" <<< "$out"'
check "sandcastle, no .sandcastle/: the report says how to add them" 'grep -q "create it and Apply again" <<< "$out"'
check "sandcastle, no .sandcastle/: no .sandcastle/ folder made" '[[ ! -e "$repo/.sandcastle" ]]'

# A dry run of the same repo reports the same fifteen and writes nothing.
repo="$work/sandcastle dry"
new_repo "$repo"
printf '# readme\n' > "$repo/README.md"
commit_all "$repo" "init"
dry="$("$apply" --dry-run "$repo")"
check "sandcastle, dry run: the fifteen are reported as left out" 'grep -q "Sandcastle files left out.*: 15" <<< "$dry"'
check "sandcastle, dry run: the left-out files aren't listed as added" '! grep -q "^  .sandcastle/tsconfig.json" <<< "$dry"'
check "sandcastle, dry run: nothing written" '[[ -z "$(git -C "$repo" status --porcelain)" ]]'

# A repo with history and a .sandcastle/ folder gets them.
repo="$work/sandcastle present"
new_repo "$repo"
touch "$repo/Widget.slnx"
mkdir -p "$repo/.sandcastle"
printf 'x\n' > "$repo/.sandcastle/.gitkeep"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
for f in "${sandcastle_files[@]}"; do
  check "sandcastle, .sandcastle/ present: $f written" '[[ -f "$repo/$f" ]]'
done
check "sandcastle, .sandcastle/ present: the hand-off guidance is written" '[[ -f "$repo/.claude/rules/sandcastle-hand-off.md" ]]'
check "sandcastle, .sandcastle/ present: nothing left out" 'grep -q "Sandcastle files left out.*: 0" <<< "$out"'
check "sandcastle, .sandcastle/ present: Sandcastle placeholders not reported as unfilled" 'grep -q "unfilled placeholders (0)" <<< "$out"'

# The hand-off guidance is an Owned file: a repo's own version is overwritten, and the report says it changed.
repo="$work/sandcastle own hand-off guidance"
new_repo "$repo"
mkdir -p "$repo/.sandcastle" "$repo/.claude/rules"
printf 'x\n' > "$repo/.sandcastle/.gitkeep"
printf '# our own hand-off rule\n' > "$repo/.claude/rules/sandcastle-hand-off.md"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
check "sandcastle, own hand-off guidance: overwritten" 'grep -qx "# Hand a pull request off to Sandcastle" "$repo/.claude/rules/sandcastle-hand-off.md"'
check "sandcastle, own hand-off guidance: reported as a changed Owned file" 'grep -q "sandcastle-hand-off.md" <<< "$out" && ! grep -A3 "Seed files skipped" <<< "$out" | grep -q "sandcastle-hand-off.md"'

# The ledger imports REPO_SLUG and NOT_OWNED_BASELINE_PATHS from the repo's own repo-config.mts (Seed, never
# rewritten), and Sandcastle's build.mts imports the ledger: a repo whose copy lacks them is refused, with nothing written.
ledger_files=(scripts/review.sh .sandcastle/lib/review-ledger.mts .sandcastle/lib/review-ledger.test.mts .sandcastle/lib/pre-push-review-skill.test.mts)
repo="$work/ledger waits"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib"
printf 'export const ROLE_AGENTS = {};\n' > "$repo/.sandcastle/lib/repo-config.mts"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
rc=0
out="$("$apply" "$repo" 2>&1)" || rc=$?
check "ledger prerequisite: Apply refuses (exit 1)" '[[ $rc -eq 1 ]]'
check "ledger prerequisite: it names the missing exports" 'grep -q "REPO_SLUG or NOT_OWNED_BASELINE_PATHS" <<< "$out"'
for f in "${ledger_files[@]}"; do
  check "ledger prerequisite: $f not written" '[[ ! -e "$repo/$f" ]]'
done
check "ledger prerequisite: nothing else is written" '[[ ! -e "$repo/.sandcastle/tsconfig.json" && ! -e "$repo/.claude/agents/pre-push-reviewer.md" ]]'
check "ledger prerequisite: the repo's repo-config.mts is untouched" 'grep -qx "export const ROLE_AGENTS = {};" "$repo/.sandcastle/lib/repo-config.mts"'

# Each name is checked on its own, as a whole word, on a line of its own that isn't a comment.
n=0
for config in 'export const REPO_SLUG = "o/r";' \
  $'export const REPO_SLUG_OLD = 1;\nexport const NOT_OWNED_BASELINE_PATHS = [];' \
  $'// export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];' \
  $'  export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];' \
  $'export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS_OLD = [];' \
  $'export const REPO_SLUG = "o/r";\n  export const NOT_OWNED_BASELINE_PATHS = [];' \
  $'export const REPO_SLUG = "o/r";\n// export let NOT_OWNED_BASELINE_PATHS = [];'; do
  n=$((n + 1))
  repo="$work/ledger waits $n"
  new_repo "$repo"
  mkdir -p "$repo/.sandcastle/lib"
  printf '%s\n' "$config" > "$repo/.sandcastle/lib/repo-config.mts"
  commit_all "$repo" "init"
  git_q -C "$repo" switch -q -c chore/standardize-baseline
  rc=0
  "$apply" "$repo" >/dev/null 2>&1 || rc=$?
  check "ledger prerequisite ($n): Apply refuses and the ledger is not written" '[[ $rc -eq 1 && ! -e "$repo/.sandcastle/lib/review-ledger.mts" ]]'
done

# One-line exports with a `let`, or with extra spaces, count: the same forms review.sh takes.
repo="$work/ledger ready forms"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib"
printf 'export  let   REPO_SLUG = "o/r";\nexport   const   NOT_OWNED_BASELINE_PATHS: string[] = [];\n' > "$repo/.sandcastle/lib/repo-config.mts"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
check "ledger ready (let, extra spaces): the ledger is written" '[[ -f "$repo/.sandcastle/lib/review-ledger.mts" ]]'

repo="$work/ledger ready"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib"
printf 'export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS: string[] = [];\n' > "$repo/.sandcastle/lib/repo-config.mts"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
for f in "${ledger_files[@]}"; do
  check "ledger ready: $f written" '[[ -f "$repo/$f" ]]'
done

# A Seed file with an Apply placeholder still counts as unfilled under .sandcastle/ (no remote, so {{REPO}} stays).
repo="$work/sandcastle unfilled"
git init -q -b main "$repo"
out="$("$apply" --dry-run "$repo")"
check "sandcastle, dry run without a remote: {{REPO}} in a Sandcastle Seed file is unfilled" \
  'grep -A3 "unfilled placeholders" <<< "$out" | grep -q ".sandcastle/roles/architect.md"'

# ── The security record: README is Owned, entries left alone ───
repo="$work/security record"
new_repo "$repo"
touch "$repo/Widget.slnx"
printf '.security/*\n!.security/README.md\n' > "$repo/.gitignore"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
"$apply" "$repo" >/dev/null
check "security record: the README is written from the Template" 'grep -qx "# The security record" "$repo/.security/README.md"'
printf 'Our own note.\n' >> "$repo/.security/README.md"
printf '# 0001: An entry\n\n- Status: fixed\n' > "$repo/.security/0001-an-entry.md"
commit_all "$repo" "apply"
dry="$("$apply" --dry-run "$repo")"
check "security record: dry run lists no .security entry as overwritten or added" \
  '! awk "/^Owned files that would be (added|overwritten)/ {on = 1; next} /^\$/ {on = 0} on" <<< "$dry" | grep -q "\.security/0001"'
check "security record: dry run lists the edited README as an Owned file it would overwrite" \
  'awk "/^Owned files that would be overwritten/ {on = 1; next} /^\$/ {on = 0} on" <<< "$dry" | grep -q "\.security/README.md"'
check "security record: dry run lists the entry nowhere" '! grep -q "0001-an-entry" <<< "$dry"'
"$apply" "$repo" >/dev/null
check "security record: a re-Apply restores the README" 'grep -qx "# The security record" "$repo/.security/README.md" && ! grep -q "Our own note" "$repo/.security/README.md"'
check "security record: a re-Apply leaves the entry alone" '[[ "$(cat "$repo/.security/0001-an-entry.md")" == "$(printf "# 0001: An entry\n\n- Status: fixed")" ]]'

# Runs of newlines for the window cases (a command substitution would strip them).
printf -v NL10 '%*s' 10 ''; NL10="${NL10// /$'\n'}"
printf -v NL11 '%*s' 11 ''; NL11="${NL11// /$'\n'}"
printf -v NL12 '%*s' 12 ''; NL12="${NL12// /$'\n'}"
# .sandcastle/check.sh is Owned, but a repo whose GATE_COMMAND or GATE_SCRIPT names it uses it as its sandbox gate (the three older
# repos did): Apply keeps that copy and says to rename it, since the Owned script would pass the gate without its lints and tests.
printf '#!/usr/bin/env bash\necho owned\n' > "$skill/template/owned/.sandcastle/check.sh"
chmod +x "$skill/template/owned/.sandcastle/check.sh"
n=0
for config in 'export const GATE_COMMAND = ".sandcastle/check.sh";' 'export const GATE_SCRIPT = ".sandcastle/check.sh";' \
  'export  let GATE_COMMAND = "bash .sandcastle/check.sh";' 'export var GATE_COMMAND = "bash .sandcastle/check.sh";' \
  $'export const GATE_COMMAND =\n  "bash .sandcastle/check.sh";' 'export const GATE_COMMAND = "pnpm lint; export CI=1; bash .sandcastle/check.sh";' \
  'export const GATE_SCRIPT: string = ".sandcastle/check.sh";' 'export const GATE_COMMAND = "cd .sandcastle && ./check.sh";' \
  'export const A = "x"; export const GATE_SCRIPT = ".sandcastle/check.sh";' 'export const GATE_COMMAND = "pnpm run export && bash .sandcastle/check.sh";' \
  'export const GATE_COMMAND = `bash ${DIR}/check.sh`;' 'export const GATE_COMMAND = "bash $DIR/check.sh";' 'export const GATE_COMMAND = "bash ../check.sh";' \
  'export const GATE_SCRIPT = "check.sh";' "export const GATE_SCRIPT = 'check.sh';" 'export const GATE_SCRIPT = `check.sh`;' 'export const GATE_COMMAND = "cd .sandcastle && bash check.sh";' \
  $'/* the gate */ export const GATE_COMMAND = ".sandcastle/check.sh"; /* x */' $'export const GATE_COMMAND = ".sandcastle/check.sh"\nexport const A = 1' \
  $'export const WATCH = ["src/*.ts", "**/*"];\nexport const GATE_COMMAND = "eslint \'src/**/*.ts\' && .sandcastle/check.sh"; /** The gate. */' \
  $'/* see // here */ export const GATE_COMMAND = ".sandcastle/check.sh";' $'// a note\nexport const GATE_COMMAND = ".sandcastle/check.sh";' \
  $'// export const GATE_SCRIPT = ".sandcastle/check.sh";' 'export const GATE_COMMAND = "x"; // formerly .sandcastle/check.sh' \
  $'export const GATE_COMMAND = "x";\nexport const CHECKS = [".sandcastle/check.sh"];\nexport const B = 1' \
  $'export const GATE_COMMAND = `\ncheck.sh --fast\n`;' $'export const GATE_COMMAND = `bash check.sh\n`;' \
  $'export const GATE_COMMAND = [\n  "pnpm lint",\n  /* the sandbox gate */ ".sandcastle/check.sh",\n].join(" && ");' \
  $'export const GATE_COMMAND = [\n  "pnpm lint",\n  /**\n   * the sandbox gate\n   */ ".sandcastle/check.sh",\n].join(" && ");' \
  $'export const GATE_COMMAND = [\n  "pnpm lint",\n  */ ".sandcastle/check.sh",\n].join(" && ");' \
  $'export const GATE_COMMAND = [\n  /* gate */ ".sandcastle/check.sh", /* trailing */\n].join(" && ");' \
  $'export const GATE_COMMAND = [\n  /* a */ ".sandcastle/check.sh" /* b */,\n].join(" && ");' \
  $'export const GATE_COMMAND = "x";\n'"$NL12"$'export const GATE_SCRIPT = ".sandcastle/check.sh";' \
  $'export const GATE_COMMAND = "x";'"$NL10"$'export const CHECKS = [".sandcastle/check.sh"];' \
  $'export const GATE_COMMAND = [\n  "pnpm lint",\n  "pnpm build",\n  "pnpm test",\n  "pnpm e2e",\n  ".sandcastle/check.sh",\n].join(" && ");'; do
  n=$((n + 1))
  repo="$work/gate check $n"
  new_repo "$repo"
  mkdir -p "$repo/.sandcastle/lib"
  printf '%s\nexport const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];\n' "$config" > "$repo/.sandcastle/lib/repo-config.mts"
  printf '#!/usr/bin/env bash\necho sandbox gate\n' > "$repo/.sandcastle/check.sh"
  commit_all "$repo" "init"
  git_q -C "$repo" switch -q -c chore/standardize-baseline
  out="$("$apply" "$repo")"
  check "gate check ($n): the repo's sandbox gate is kept" 'grep -q "sandbox gate" "$repo/.sandcastle/check.sh"'
  check "gate check ($n): the report says to rename it" 'grep -q "check.sh is Owned.*rename" <<< "$out"'
  dry="$("$apply" --dry-run "$repo")"
  check "gate check ($n): a dry run says it too" 'grep -q "check.sh is Owned.*rename" <<< "$dry"'
done
n=0
for config in 'export const GATE_SCRIPT = ".sandcastle/sandbox-gate.sh";' 'export const ROLE_AGENTS = {};' \
  'export const GATE_COMMAND = ".sandcastle/check.sh.bak";' 'export const GATE_COMMAND = ".sandcastle/my-check.sh";' \
  'export const GATE_COMMAND = ".sandcastle/check.shx";' 'export const GATE_COMMAND = ".sandcastle/check.sh-old";' 'export const GATE_COMMAND = ".sandcastle/check.sh_old";' \
  $'// .sandcastle/check.sh\nexport const GATE_COMMAND = "x";' 'export const NOTE = ".sandcastle/check.sh";' \
  $'export const GATE_COMMAND = "x";'"$NL11"$'export const CHECKS = [".sandcastle/check.sh"];' \
  $'// The command the host runs in the sandbox as the gate.\nexport const GATE_COMMAND = "scripts/gate.sh";\n\n// The committed file GATE_COMMAND runs. It is written in the worktree by the\n// agents whose work it judges, so a gate whose branch changes it fails without\n// running (lib/checkpoint.mts#gateScriptChange); a file that isn\'t committed at\n// the branch\'s base fails too. Name the script, not the interpreter or\n// arguments: `.sandcastle/check.sh` for `bash .sandcastle/check.sh`.\nexport const GATE_SCRIPT = "scripts/gate.sh";' \
  $'export const GATE_COMMAND = "scripts/gate.sh";\n/**\n * Name the script: `.sandcastle/check.sh` for `bash .sandcastle/check.sh`.\n */\nexport const GATE_SCRIPT = "scripts/gate.sh";' \
  $'export const GATE_COMMAND = "scripts/gate.sh";\n/** e.g. .sandcastle/check.sh */\nexport const GATE_SCRIPT = "scripts/gate.sh";' \
  $'export const GATE_COMMAND = "scripts/gate.sh";\n/**\n * e.g. .sandcastle/check.sh */\nexport const GATE_SCRIPT = "scripts/gate.sh";' \
  $'export const GATE_COMMAND = "scripts/gate.sh";\n\t// e.g. .sandcastle/check.sh\n\t * e.g. .sandcastle/check.sh\nexport const GATE_SCRIPT = "scripts/gate.sh";'; do
  n=$((n + 1))
  repo="$work/gate check other $n"
  new_repo "$repo"
  mkdir -p "$repo/.sandcastle/lib"
  printf '%s\nexport const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];\n' "$config" > "$repo/.sandcastle/lib/repo-config.mts"
  printf '#!/usr/bin/env bash\necho old copy\n' > "$repo/.sandcastle/check.sh"
  commit_all "$repo" "init"
  git_q -C "$repo" switch -q -c chore/standardize-baseline
  out="$("$apply" "$repo")"
  check "gate check other ($n): the Owned check.sh replaces the copy" 'grep -q "echo owned" "$repo/.sandcastle/check.sh"'
  check "gate check other ($n): no rename warning" '! grep -q "check.sh is Owned" <<< "$out"'
done

# An older repo has no repo-config.mts yet (the Seed brings it) and names its sandbox gate in lib/config.mts: kept too.
repo="$work/gate check old config"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib"
printf 'export const GATE_COMMAND = "bash .sandcastle/check.sh";\n' > "$repo/.sandcastle/lib/config.mts"
printf '#!/usr/bin/env bash\necho sandbox gate\n' > "$repo/.sandcastle/check.sh"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
check "gate check (old config.mts): the repo's sandbox gate is kept" 'grep -q "sandbox gate" "$repo/.sandcastle/check.sh"'
check "gate check (old config.mts): the report says to rename it" 'grep -q "check.sh is Owned.*rename" <<< "$out"'

# A config that names check.sh in a repo with no .sandcastle/check.sh keeps nothing: the Owned script is written, with no conflict.
repo="$work/gate check absent"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib"
printf 'export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];\nexport const GATE_COMMAND = "bash .sandcastle/check.sh";\n' > "$repo/.sandcastle/lib/repo-config.mts"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
check "gate check (no check.sh in the repo): the Owned check.sh is written" 'grep -q "echo owned" "$repo/.sandcastle/check.sh"'
check "gate check (no check.sh in the repo): no rename warning" '! grep -q "check.sh is Owned" <<< "$out"'

# A repo-config.mts that ends with a comment and no final newline is still scanned, and so is the older config.mts.
repo="$work/gate check no newline"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib"
printf 'export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];\n// last line, no newline' > "$repo/.sandcastle/lib/repo-config.mts"
printf 'export const GATE_COMMAND = "bash .sandcastle/check.sh";\n' > "$repo/.sandcastle/lib/config.mts"
printf '#!/usr/bin/env bash\necho sandbox gate\n' > "$repo/.sandcastle/check.sh"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
out="$("$apply" "$repo")"
check "gate check (no final newline): the repo's sandbox gate is kept" 'grep -q "sandbox gate" "$repo/.sandcastle/check.sh"'

# A config with a byte that is not UTF-8 (a Latin-1 accent in a comment) must not hide the gate: grep would otherwise print a
# "binary file matches" notice instead of the line in a UTF-8 locale.
repo="$work/gate check latin1"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib"
printf 'export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];\nexport const GATE_COMMAND = "bash .sandcastle/check.sh"; // caf\xe9\n' > "$repo/.sandcastle/lib/repo-config.mts"
printf '#!/usr/bin/env bash\necho sandbox gate\n' > "$repo/.sandcastle/check.sh"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
if [[ "$(printf 'caf\xe9 GATE_COMMAND\n' | LC_ALL=C.utf8 grep -h GATE_COMMAND 2>&1)" == *inary* ]]; then
  out="$(LC_ALL=C.utf8 "$apply" "$repo")"
  check "gate check (Latin-1 byte): the repo's sandbox gate is kept" 'grep -q "sandbox gate" "$repo/.sandcastle/check.sh"'
else
  echo "skip - gate check (Latin-1 byte): this machine's grep does not treat the byte as binary under C.utf8"
fi

# A grep that fails (exit 2, as on an unreadable config) when scanning for the gate stops Apply before it writes anything: a stub
# grep stands in, since Apply refuses a worktree git can't read before it gets that far.
repo="$work/gate check grep error"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib" "$work/grep-stub"
printf 'export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];\nexport const GATE_COMMAND = "x";\n' > "$repo/.sandcastle/lib/repo-config.mts"
printf '#!/usr/bin/env bash\necho sandbox gate\n' > "$repo/.sandcastle/check.sh"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
real_grep="$(command -v grep)"
printf '#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == *GATE_* ]] && exit 2; done\nexec %s "$@"\n' "$real_grep" > "$work/grep-stub/grep"
chmod +x "$work/grep-stub/grep"
status=0
out="$(PATH="$work/grep-stub:$PATH" "$apply" "$repo" 2>&1)" || status=$?
check "gate check (grep error): Apply stops" '[[ $status -ne 0 ]]'
check "gate check (grep error): it says which file it can't read" 'grep -q "can.t read .*repo-config.mts" <<< "$out"'
check "gate check (grep error): the repo's check.sh is untouched" 'grep -q "sandbox gate" "$repo/.sandcastle/check.sh"'
check "gate check (grep error): nothing else was written" '[[ -z "$(git -C "$repo" status --porcelain)" ]]'

# The same for an awk that fails (exit 2) while matching the window.
repo="$work/gate check awk error"
new_repo "$repo"
mkdir -p "$repo/.sandcastle/lib" "$work/awk-stub"
printf 'export const REPO_SLUG = "o/r";\nexport const NOT_OWNED_BASELINE_PATHS = [];\nexport const GATE_COMMAND = "x";\n' > "$repo/.sandcastle/lib/repo-config.mts"
printf '#!/usr/bin/env bash\necho sandbox gate\n' > "$repo/.sandcastle/check.sh"
commit_all "$repo" "init"
git_q -C "$repo" switch -q -c chore/standardize-baseline
printf '#!/usr/bin/env bash\nexit 2\n' > "$work/awk-stub/awk"
chmod +x "$work/awk-stub/awk"
status=0
out="$(PATH="$work/awk-stub:$PATH" "$apply" "$repo" 2>&1)" || status=$?
check "gate check (awk error): Apply stops" '[[ $status -ne 0 ]]'
check "gate check (awk error): it says which file it can't read" 'grep -q "can.t read .*repo-config.mts" <<< "$out"'
check "gate check (awk error): nothing was written" '[[ -z "$(git -C "$repo" status --porcelain)" ]]'

echo "apply.test.sh: $pass passed, $failed failed"
[[ $failed -eq 0 ]]
