#!/usr/bin/env bash
# Apply the repo-ci-baseline Template to a repo: the first step of Standardize.
#
#   apply.sh [--dry-run] <target-repo>
#
# Owned files (template/owned) always overwrite the repo's copy. Seed files
# (template/seed) are written only where the repo has none, with {{OWNER}},
# {{REPO}} and {{SOLUTION}} filled in. Then core.hooksPath is pointed at
# .github/hooks. Nothing is ever deleted.
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

owned_added=()
owned_changed=()
owned_same=0
seed_written=()
seed_skipped=()
unfilled=()

# ── Owned ───────────────────────────────────────────────────────────────────
while IFS= read -r rel; do
  src="$owned_dir/$rel"
  dst="$target/$rel"
  if [[ ! -e "$dst" ]]; then
    owned_added+=("$rel")
  elif cmp -s "$src" "$dst"; then
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
    grep -q '{{[A-Z_]*}}' "$dst" && unfilled+=("$rel")
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
section "Seed files that $verb written" "${seed_written[@]}"
section "Seed files skipped because the repo has its own (review against the Template in Adapt)" "${seed_skipped[@]}"
section "Seed files with unfilled placeholders" "${unfilled[@]}"
section "Leftovers the Template doesn't carry (delete, keep as repo-specific, or move into the Template)" "${leftovers[@]}"
section "Conflicts" "${conflicts[@]}"
