#!/usr/bin/env bash
# Apply the repo-ci-baseline Template to a repo: the first step of Standardize.
#
#   apply.sh [--dry-run] <target-repo>
#
# Owned files (template/owned) always overwrite the repo's copy, mode included. Seed files
# (template/seed) are written only where the repo has none, with {{OWNER}},
# {{REPO}} and {{SOLUTION}} filled in. Then core.hooksPath is pointed at
# .github/hooks. Nothing is ever deleted. Sandcastle's files (.sandcastle/, and
# the package.json and pnpm-workspace.yaml it runs with) go only into a repo
# with a .sandcastle/ folder or no commits yet (docs/adr/0006).
#
# The report lists what Adapt has to look at: Owned files whose local copy
# differed (drift to drop, or a local fix to move into the Template first),
# Seed files left alone, leftovers the Template doesn't cover, and known
# conflicts.
#
# --dry-run prints the same report and changes nothing, on any branch.
# A real run needs a clean worktree on a branch other than main, preview or
# dev, or a repo with no commits yet.
set -euo pipefail

usage() {
  echo "usage: apply.sh [--dry-run] <target-repo>" >&2
  exit 2
}

dry_run=false
target=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    -h|--help) usage ;;
    -*) echo "apply.sh: unknown option '$arg'" >&2; usage ;;
    *) [[ -z "$target" ]] || usage; target="$arg" ;;
  esac
done
[[ -n "$target" ]] || usage

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
owned_dir="$skill_dir/template/owned"
seed_dir="$skill_dir/template/seed"

if ! git -C "$target" rev-parse --is-inside-work-tree &>/dev/null; then
  echo "apply.sh: '$target' is not a git work tree" >&2
  exit 1
fi
target="$(git -C "$target" rev-parse --show-toplevel)"

# ── Guards ──────────────────────────────────────────────────────────────────
if ! $dry_run; then
  if git -C "$target" rev-parse --verify --quiet HEAD >/dev/null; then
    branch="$(git -C "$target" symbolic-ref --quiet --short HEAD || true)"
    case "$branch" in
      "") echo "apply.sh: HEAD is detached; check out a work branch first" >&2; exit 1 ;;
      main|preview|dev)
        echo "apply.sh: refusing to apply on '$branch'; create a branch such as chore/standardize-baseline" >&2
        exit 1 ;;
    esac
    if [[ -n "$(git -C "$target" status --porcelain)" ]]; then
      echo "apply.sh: the worktree has uncommitted or untracked changes; commit or stash them first" >&2
      exit 1
    fi
  fi
fi

# Sandcastle's files (.sandcastle/, its workflow and the hook that workflow calls, and the package.json and pnpm-workspace.yaml it runs
# with) go only into a repo that runs Sandcastle, or a new one (ADR 0006): a repo starts using it by creating .sandcastle/ and Applying again.
with_sandcastle=false
if [[ -d "$target/.sandcastle" ]] || ! git -C "$target" rev-parse --verify --quiet HEAD >/dev/null; then with_sandcastle=true; fi
# The local review's skill, agent and script too: its ledger is .sandcastle/lib/review-ledger.mts.
sandcastle_path() {
  [[ "$1" == .sandcastle/* || "$1" == package.json || "$1" == pnpm-workspace.yaml || "$1" == scripts/review.sh \
    || "$1" == .github/workflows/sandcastle.yml || "$1" == .github/ci/sandcastle-prepare.sh \
    || "$1" == .claude/agents/pre-push-reviewer.md || "$1" == .claude/skills/pre-push-review/* ]]
}

# The ledger imports REPO_SLUG and NOT_OWNED_BASELINE_PATHS from the repo's
# .sandcastle/lib/repo-config.mts, a Seed file Apply never rewrites. A repo whose own
# copy lacks them would fail at link time (every push, its re-Apply's too), so its
# ledger (and the tests that import it) wait until they are on its main, each as a
# one-line `export const NAME` or `export let NAME`. With no repo-config.mts yet,
# the Seed brings them.
ledger_path() {
  [[ "$1" == scripts/review.sh || "$1" == .sandcastle/lib/review-ledger.mts || "$1" == .sandcastle/lib/review-ledger.test.mts \
    || "$1" == .sandcastle/lib/pre-push-review-skill.test.mts ]]
}
ledger_ready=true
if $with_sandcastle && [[ -f "$target/.sandcastle/lib/repo-config.mts" ]] \
  && ! { grep -qE '^export[[:space:]]+(const|let)[[:space:]]+REPO_SLUG\b' "$target/.sandcastle/lib/repo-config.mts" \
    && grep -qE '^export[[:space:]]+(const|let)[[:space:]]+NOT_OWNED_BASELINE_PATHS\b' "$target/.sandcastle/lib/repo-config.mts"; }; then
  ledger_ready=false
fi

# ── Placeholder values ──────────────────────────────────────────────────────
owner=""
repo=""
remote_url="$(git -C "$target" remote get-url origin 2>/dev/null || true)"
if [[ "$remote_url" =~ github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
  owner="${BASH_REMATCH[1]}"
  repo="${BASH_REMATCH[2]%.git}"
fi
solution=""
mapfile -t slnx < <(find "$target" -maxdepth 1 -name '*.slnx' -printf '%f\n')
if [[ ${#slnx[@]} -eq 1 && "${slnx[0]}" =~ ^([A-Za-z0-9_.-]+)\.slnx$ ]]; then
  solution="${BASH_REMATCH[1]}"
fi

fill_placeholders() {
  local file="$1"
  [[ -n "$owner" ]] && sed -i "s/{{OWNER}}/$owner/g" "$file"
  [[ -n "$repo" ]] && sed -i "s/{{REPO}}/$repo/g" "$file"
  [[ -n "$solution" ]] && sed -i "s/{{SOLUTION}}/$solution/g" "$file"
  return 0
}

# Template files, minus caches a local test run may have left behind.
list_files() {
  (cd "$1" && find . -type f \
    -not -path '*/__pycache__/*' -not -path '*/.pytest_cache/*' -not -name '*.pyc' \
    -printf '%P\n' | LC_ALL=C sort)
}

# Content alone isn't enough: a hook that lost its execute bit never runs.
same_exec_bit() {
  if [[ -x "$1" ]]; then [[ -x "$2" ]]; else [[ ! -x "$2" ]]; fi
}

owned_added=()
owned_changed=()
owned_same=0
seed_written=()
seed_skipped=()
unfilled=()
sandcastle_left=()
ledger_left=()

# ── Owned ───────────────────────────────────────────────────────────────────
while IFS= read -r rel; do
  if ! $with_sandcastle && sandcastle_path "$rel"; then sandcastle_left+=("$rel"); continue; fi
  if ! $ledger_ready && ledger_path "$rel"; then ledger_left+=("$rel"); continue; fi
  src="$owned_dir/$rel"
  dst="$target/$rel"
  if [[ ! -e "$dst" ]]; then
    owned_added+=("$rel")
  elif cmp -s "$src" "$dst" && same_exec_bit "$src" "$dst"; then
    owned_same=$((owned_same + 1))
    continue
  else
    owned_changed+=("$rel")
  fi
  if ! $dry_run; then
    mkdir -p "$(dirname "$dst")"
    command cp -f --preserve=mode "$src" "$dst"
  fi
done < <(list_files "$owned_dir")

# ── Seed ────────────────────────────────────────────────────────────────────
while IFS= read -r rel; do
  if ! $with_sandcastle && sandcastle_path "$rel"; then sandcastle_left+=("$rel"); continue; fi
  src="$seed_dir/$rel"
  dst="$target/$rel"
  if [[ -e "$dst" ]]; then
    seed_skipped+=("$rel")
    continue
  fi
  seed_written+=("$rel")
  if ! $dry_run; then
    mkdir -p "$(dirname "$dst")"
    command cp -f --preserve=mode "$src" "$dst"
    fill_placeholders "$dst"
    # Only Apply's own three: Sandcastle fills its prompts' {{NAME}}s when it runs them.
    grep -qE '\{\{(OWNER|REPO|SOLUTION)\}\}' "$dst" && unfilled+=("$rel")
  elif { [[ -z "$owner" ]] && grep -q '{{OWNER}}' "$src"; } \
    || { [[ -z "$repo" ]] && grep -q '{{REPO}}' "$src"; } \
    || { [[ -z "$solution" ]] && grep -q '{{SOLUTION}}' "$src"; }; then
    unfilled+=("$rel")
  fi
done < <(list_files "$seed_dir")

if ! $dry_run; then
  git -C "$target" config core.hooksPath .github/hooks
fi

# ── Leftovers: files in the Template's directories that it doesn't carry ────
declare -A in_template=()
while IFS= read -r rel; do in_template["$rel"]=1; done < <(list_files "$owned_dir"; list_files "$seed_dir")
leftovers=()
for dir in .github/workflows .github/hooks .github/scripts; do
  [[ -d "$target/$dir" ]] || continue
  while IFS= read -r rel; do
    [[ -n "${in_template[$rel]:-}" ]] || leftovers+=("$rel")
  done < <(list_files "$target/$dir" | sed "s|^|$dir/|")
done

# ── Known conflicts ─────────────────────────────────────────────────────────
conflicts=()
for f in .markdownlint.json .markdownlint.jsonc .markdownlint.yaml .markdownlint.yml .markdownlintrc; do
  [[ -e "$target/$f" ]] && conflicts+=("$f overrides the rules in .markdownlint-cli2.jsonc; delete it, then run markdownlint-cli2 --fix")
done
# A second copy of the commit rules drifts from the Owned one (IssueManager's and
# Articles' weren't even conventional commits); CLAUDE.md links docs/PROCESS.md instead.
for f in .copilot-commit-message-instructions.md .claude/rules/git-commit.md; do
  [[ -e "$target/$f" ]] && conflicts+=("$f duplicates .github/instructions/git-commit-instructions.md; delete it, and point CLAUDE.md at docs/PROCESS.md")
done
if [[ -d "$target/.squad" ]] || compgen -G "$target/.github/workflows/squad-*" >/dev/null; then
  conflicts+=("squad is still installed (.squad/ or squad-* workflows); run the remove-squad skill before Applying")
fi

# ── Report ──────────────────────────────────────────────────────────────────
section() {
  local title="$1"; shift
  echo
  echo "$title ($#)"
  local item
  for item in "$@"; do echo "  $item"; done
}

if $dry_run; then
  echo "Dry run: nothing was changed in $target"
  verb="would be"
else
  echo "Applied the Template to $target"
  verb="were"
fi
echo "Placeholders: OWNER=${owner:-?} REPO=${repo:-?} SOLUTION=${solution:-?}"
section "Owned files that $verb added" "${owned_added[@]}"
section "Owned files that $verb overwritten (drift: drop it, or move a local fix into the Template first)" "${owned_changed[@]}"
echo
echo "Owned files already identical: $owned_same"
echo "Sandcastle files left out (the repo has no .sandcastle/; create it and Apply again to add them): ${#sandcastle_left[@]}"
if [[ ${#ledger_left[@]} -gt 0 ]]; then
  section "Local review files left out: the repo's .sandcastle/lib/repo-config.mts lacks REPO_SLUG or NOT_OWNED_BASELINE_PATHS as a one-line export const. Add both on main in a PR of its own (references/pre-push-review.md, Adapting step 1), then Apply again" "${ledger_left[@]}"
fi
section "Seed files that $verb written" "${seed_written[@]}"
section "Seed files skipped because the repo has its own (review against the Template in Adapt)" "${seed_skipped[@]}"
section "Seed files with unfilled placeholders" "${unfilled[@]}"
section "Leftovers the Template doesn't carry (delete, keep as repo-specific, or move into the Template)" "${leftovers[@]}"
section "Conflicts" "${conflicts[@]}"
