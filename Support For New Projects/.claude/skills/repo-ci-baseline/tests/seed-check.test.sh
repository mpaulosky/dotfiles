#!/usr/bin/env bash
# Tests for the Owned .sandcastle/check.sh: it runs Sandcastle's check only when a file the
# check reads changed since <merge-base> (always, with no merge base): its built-in paths, or
# one a repo lists in the Seed .sandcastle/check-paths.txt, so the check doesn't stop when only
# one of those files changes. Each case runs the Template's script in a throwaway repo with a
# stub pnpm that logs its calls.
# Usage: tests/seed-check.test.sh
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$SKILL_DIR/template/owned/.sandcastle/check.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"
STUBS="$WORK/bin"
LOG="$WORK/calls.log"
ENVLOG="$WORK/env.log"

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

mkdir -p "$STUBS"
cat > "$STUBS/pnpm" <<STUB
#!/usr/bin/env bash
echo "pnpm \$*" >> "$LOG"
echo "GIT_DIR=\${GIT_DIR-unset} GIT_WORK_TREE=\${GIT_WORK_TREE-unset} GIT_INDEX_FILE=\${GIT_INDEX_FILE-unset} GIT_PREFIX=\${GIT_PREFIX-unset}" >> "$ENVLOG"
STUB
chmod +x "$STUBS/pnpm"

# Every path the script's built-in pathspec names, plus a file it doesn't.
PATHS=(.sandcastle/lib/x.mts package.json pnpm-workspace.yaml pnpm-lock.yaml scripts/review.sh
  .claude/skills/pre-push-review/SKILL.md .claude/skills/hardening-review/SKILL.md .claude/agents/pre-push-reviewer.md .github/workflows/claude-review.yml)

git init -q -b main "$REPO"
mkdir -p "$REPO/.sandcastle"
cp "$CHECK" "$REPO/.sandcastle/check.sh"
for path in "${PATHS[@]}" docs/unrelated.md; do
  mkdir -p "$REPO/$(dirname "$path")"
  echo start > "$REPO/$path"
done
git -C "$REPO" add .
git -C "$REPO" commit -q -m init
BASE="$(git -C "$REPO" rev-parse HEAD)"

PASSED=0
FAILED=0
STATUS=0
OUTPUT=""

run_check() { # run_check [<merge-base>]
  : > "$LOG"
  OUTPUT="$(cd "$REPO" && PATH="$STUBS:$PATH" bash .sandcastle/check.sh "$@" 2>&1)"
  STATUS=$?
}
pass() { PASSED=$((PASSED + 1)); echo "ok   - $1"; }
fail() {
  FAILED=$((FAILED + 1)); echo "FAIL - $1"
  echo "       | exit $STATUS; calls: $(tr '\n' ';' < "$LOG")"
  while IFS= read -r line; do echo "       | $line"; done <<< "$OUTPUT"
}
ran_check() { grep -q -- "pnpm run check:sandcastle" "$LOG"; }
check() { # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}
not() { ! "$@"; }
# A skipped check is a clean exit that never called pnpm: a script that crashed before pnpm would pass `not ran_check` alone.
not_ran() { ! ran_check && [[ $STATUS -eq 0 ]]; }

run_check
check "with no merge base the check runs" ran_check

run_check "$BASE"
check "with nothing changed it exits 0 and runs nothing" test $STATUS -eq 0
check "with nothing changed pnpm is not called" not_ran

git -C "$REPO" switch -q -c unrelated
echo more >> "$REPO/docs/unrelated.md"
git -C "$REPO" commit -qam "unrelated"
run_check "$BASE"
check "a change to a file the check doesn't read runs nothing" not_ran
check "a change to a file the check doesn't read exits 0" test $STATUS -eq 0
git -C "$REPO" switch -q main

n=0
for path in "${PATHS[@]}"; do
  n=$((n + 1))
  git -C "$REPO" switch -q -c "touch-$n" main
  echo more >> "$REPO/$path"
  git -C "$REPO" commit -qam "touch $path"
  run_check "$BASE"
  check "a change to $path runs the Sandcastle check" ran_check
  git -C "$REPO" switch -q main
done

# Under a git hook, git sets GIT_DIR (and GIT_INDEX_FILE in a linked worktree). check.sh can run
# outside scripts/gate.sh (a repo's GATE_COMMAND may name it), which unsets them before every check,
# so check.sh unsets them itself: a test that builds a scratch repo would otherwise act on the real
# one, and so would the script's own git diff.
DECOY="$WORK/decoy"
git init -q -b main "$DECOY"
git -C "$DECOY" commit -q --allow-empty -m decoy

run_check_in_hook() { # run_check_in_hook [<merge-base>]: the four variables set, as under a hook
  : > "$LOG"; : > "$ENVLOG"
  OUTPUT="$(cd "$REPO" && PATH="$STUBS:$PATH" GIT_DIR="$DECOY/.git" GIT_WORK_TREE="$DECOY" \
    GIT_INDEX_FILE="$DECOY/.git/index" GIT_PREFIX="decoy/" bash .sandcastle/check.sh "$@" 2>&1)"
  STATUS=$?
}
pnpm_saw_no_git_variables() {
  [[ -s "$ENVLOG" ]] && [[ "$(cat "$ENVLOG")" == "GIT_DIR=unset GIT_WORK_TREE=unset GIT_INDEX_FILE=unset GIT_PREFIX=unset" ]]
}

run_check_in_hook
check "with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and GIT_PREFIX set the check still runs" ran_check
check "pnpm run check:sandcastle doesn't inherit GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_PREFIX" pnpm_saw_no_git_variables

run_check_in_hook "$BASE"
check "with the variables set and nothing changed it exits 0" test $STATUS -eq 0
check "with the variables set, the changed-files diff reads the repo it runs in, not GIT_DIR's" not_ran

git -C "$REPO" switch -q -c hook-touch main
echo more >> "$REPO/package.json"
git -C "$REPO" commit -qam "touch package.json"
run_check_in_hook "$BASE"
check "with the variables set, a change to package.json runs the Sandcastle check" ran_check
check "with the variables set, a change to package.json leaves pnpm none of them" pnpm_saw_no_git_variables
git -C "$REPO" switch -q main

# A repo lists the other files its tests read in .sandcastle/check-paths.txt (Seed). Each case writes the list with printf
# (so a CRLF, a missing final newline or odd whitespace is exact), commits it on main, and changes one file on a branch.
mkdir -p "$REPO/docs/guides/sub"
for path in CLAUDE.md docs/guides/sub/a.md '#notes.md' -dashed.md; do echo start > "$REPO/$path"; done
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "files the lists name"

LISTBASE=""
BRANCHES=0
set_list() { # set_list <printf %b text>: the list on main, and LISTBASE its commit
  git -C "$REPO" switch -q main
  printf '%b' "$1" > "$REPO/.sandcastle/check-paths.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q --allow-empty -m "list"
  LISTBASE="$(git -C "$REPO" rev-parse HEAD)"
}
touch_file() { # touch_file <path>: change it on a new branch and run the check from the list's commit
  BRANCHES=$((BRANCHES + 1))
  git -C "$REPO" switch -q -c "list-$BRANCHES" main
  mkdir -p "$REPO/$(dirname -- "$1")"
  echo more >> "$REPO/$1"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "touch $1"
  run_check "$LISTBASE"
  git -C "$REPO" switch -q main
}

set_list '# a comment, then a blank line\n\nCLAUDE.md\n:(glob)docs/guides/**\n'
run_check "$LISTBASE"
check "with a paths list and nothing changed since it, nothing runs" not_ran
touch_file CLAUDE.md
check "a change to CLAUDE.md, listed in check-paths.txt, runs the Sandcastle check" ran_check
touch_file docs/guides/sub/a.md
check "a change under a listed :(glob) path runs the Sandcastle check" ran_check
touch_file docs/unrelated.md
check "a file the list doesn't name runs nothing" not_ran

set_list '# crlf\r\nCLAUDE.md\r\n'
touch_file CLAUDE.md
check "a list with CRLF line endings still watches CLAUDE.md" ran_check

set_list 'docs/guides/sub/a.md'
touch_file docs/guides/sub/a.md
check "a last line with no trailing newline is read" ran_check

set_list '   CLAUDE.md \t\n'
touch_file CLAUDE.md
check "a path with leading and trailing whitespace is trimmed, not silently dropped" ran_check

set_list '\xef\xbb\xbfCLAUDE.md\n'
touch_file CLAUDE.md
check "a UTF-8 byte order mark before the first path is ignored" ran_check

set_list '  #*\n\t\n   \n-dashed.md\n'
touch_file '#notes.md'
check "an indented comment names no path (#* would otherwise match #notes.md)" not_ran
touch_file docs/unrelated.md
check "whitespace-only lines name no path (an empty pathspec would run the check)" not_ran
touch_file -dashed.md
check "a path beginning with - is watched" ran_check

set_list ':(exclude).sandcastle\n:^package.json\n'
touch_file .sandcastle/lib/x.mts
check "an :(exclude) line can't switch off the .sandcastle/ check" ran_check
touch_file package.json
check "a :^ line can't switch off the package.json check" ran_check
touch_file .sandcastle/check-paths.txt
check "a change to the list itself runs the check" ran_check

# A list of exclude lines alone is "everything else" to git: it must not widen the watch to the whole repo.
for only in ':(exclude)docs\n' ':^docs\n' ':!docs\n' ':(top,exclude)docs\n' ':(exclude,top)docs\n' '# note\n:(exclude)CLAUDE.md\n:^docs\n'; do
  set_list "$only"
  touch_file -dashed.md
  check "a list of only exclude lines (${only%%\\n*}) watches nothing, so a change outside the excluded paths runs nothing" not_ran
  touch_file package.json
  check "a list of only exclude lines (${only%%\\n*}) leaves the built-in package.json check on" ran_check
done
set_list 'CLAUDE.md\n:(exclude)docs\n'
touch_file docs/unrelated.md
check "an exclude line beside a positive one still runs nothing for an unrelated change" not_ran
touch_file CLAUDE.md
check "an exclude line beside a positive one still watches the positive path" ran_check

set_list ':(bogus)x\n'
touch_file docs/unrelated.md
check "an invalid pathspec runs the check rather than skipping it" ran_check

rm "$REPO/.sandcastle/check-paths.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "no list"
LISTBASE="$(git -C "$REPO" rev-parse HEAD)"
touch_file docs/unrelated.md
check "with no check-paths.txt a file the check doesn't read runs nothing" not_ran
touch_file package.json
check "with no check-paths.txt package.json still runs the check" ran_check

# The script finds the repo itself: run from a subfolder, or by absolute path from elsewhere, it still diffs the repo's files.
set_list '# empty\n'
BRANCHES=$((BRANCHES + 1))
git -C "$REPO" switch -q -c "list-$BRANCHES" main
echo more >> "$REPO/package.json"
git -C "$REPO" commit -qam "touch package.json"
run_check_from() { # run_check_from <dir> <script> <merge-base>
  : > "$LOG"
  OUTPUT="$(cd "$1" && PATH="$STUBS:$PATH" bash "$2" "$3" 2>&1)"
  STATUS=$?
}
run_check_from "$REPO/docs" ../.sandcastle/check.sh "$LISTBASE"
check "run from a subfolder, a change to package.json runs the check" ran_check
run_check_from "$WORK" "$REPO/.sandcastle/check.sh" "$LISTBASE"
check "run by absolute path from outside the repo, a change to package.json runs the check" ran_check
git -C "$REPO" switch -q main

# When git can't say where the repo's top is, the script stops rather than diffing and running pnpm in the caller's folder.
mkdir -p "$WORK/failbin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/failbin/git"
chmod +x "$WORK/failbin/git"
: > "$LOG"
OUTPUT="$(cd "$WORK" && PATH="$WORK/failbin:$STUBS:$PATH" bash "$REPO/.sandcastle/check.sh" "$LISTBASE" 2>&1)"
STATUS=$?
check "when git can't find the repo's top the script fails" test $STATUS -ne 0
check "when git can't find the repo's top pnpm is not called" not ran_check

# The Seed list ships with comments only: a pathspec there would widen every repo's watch list.
SEED_LIST="$SKILL_DIR/template/seed/.sandcastle/check-paths.txt"
check "the Seed check-paths.txt exists" test -f "$SEED_LIST"
seed_list_is_comments_only() { ! grep -Evq '^[[:space:]]*(#.*)?$' "$SEED_LIST"; }
check "the Seed check-paths.txt holds comments and blank lines only" seed_list_is_comments_only

echo
echo "seed-check.test.sh: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
