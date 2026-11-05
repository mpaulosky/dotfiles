#!/usr/bin/env bash
# Tests for the Owned .sandcastle/check.sh: it runs Sandcastle's check only when a file the
# check reads (the built-in paths, or one listed in .sandcastle/check-paths.txt) changed since
# <merge-base> (always, with no merge base), so the check doesn't stop running when only one of
# those files changes. Each case runs the Owned script in a throwaway repo with a stub pnpm that
# logs its calls.
# Usage: tests/seed-check.test.sh
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$SKILL_DIR/template/owned/.sandcastle/check.sh"
SEED_PATHS="$SKILL_DIR/template/seed/.sandcastle/check-paths.txt"

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

# Every path the script's pathspec names, plus a file it doesn't.
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

run_check
check "with no merge base the check runs" ran_check

run_check "$BASE"
check "with nothing changed it exits 0 and runs nothing" test $STATUS -eq 0
check "with nothing changed pnpm is not called" not ran_check

git -C "$REPO" switch -q -c unrelated
echo more >> "$REPO/docs/unrelated.md"
git -C "$REPO" commit -qam "unrelated"
run_check "$BASE"
check "a change to a file the check doesn't read runs nothing" not ran_check
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
check "with the variables set, the changed-files diff reads the repo it runs in, not GIT_DIR's" not ran_check

git -C "$REPO" switch -q -c hook-touch main
echo more >> "$REPO/package.json"
git -C "$REPO" commit -qam "touch package.json"
run_check_in_hook "$BASE"
check "with the variables set, a change to package.json runs the Sandcastle check" ran_check
check "with the variables set, a change to package.json leaves pnpm none of them" pnpm_saw_no_git_variables
git -C "$REPO" switch -q main

# check.sh is Owned, so Apply refreshes it and a repo can't edit its pathspec; the repo's own watched
# paths (its tests' inputs) are one per line in the Seed .sandcastle/check-paths.txt.
check "check.sh is an Owned file, not a Seed file" test -f "$CHECK" -a ! -e "$SKILL_DIR/template/seed/.sandcastle/check.sh"
check "the Seed has a .sandcastle/check-paths.txt" test -f "$SEED_PATHS"
seed_paths_list_nothing() { [[ -f "$SEED_PATHS" ]] && ! grep -qvE '^[[:space:]]*(#|$)' "$SEED_PATHS"; }
check "the Seed's check-paths.txt lists no path (comments and blank lines only)" seed_paths_list_nothing

EXTRA_FILE=e2e/tests/login.spec.ts
EXTRA_DIR=docs/generated
SPACED="docs/with space/data.json"
for path in "$EXTRA_FILE" "$EXTRA_DIR/page.md" "$SPACED" docs/commented.md; do
  mkdir -p "$REPO/$(dirname "$path")"
  echo start > "$REPO/$path"
done
git -C "$REPO" add .
git -C "$REPO" commit -q -m "extra paths"
BASE2="$(git -C "$REPO" rev-parse HEAD)"

write_paths() { printf '%s' "$1" > "$REPO/.sandcastle/check-paths.txt"; git -C "$REPO" add .; git -C "$REPO" commit -q -m "paths"; }
touch_on_branch() { # touch_on_branch <branch> <start point> <file>
  git -C "$REPO" switch -q -c "$1" "$2"
  echo more >> "$REPO/$3"
  git -C "$REPO" commit -qam "touch $3"
}

# A repo with no check-paths.txt (a Seed file it may have deleted) watches the built-in paths only.
touch_on_branch nopaths-touch main "$EXTRA_FILE"
run_check "$BASE2"
check "with no check-paths.txt a change to $EXTRA_FILE runs nothing and exits 0" not ran_check
check "with no check-paths.txt the check exits 0" test $STATUS -eq 0
git -C "$REPO" switch -q main

git -C "$REPO" switch -q -c withpaths main
write_paths $'# Paths the Sandcastle check also watches, one per line.\n\n'"$EXTRA_FILE"$'\n'"$EXTRA_DIR"$'\n'"$SPACED"$'\n  \n# docs/commented.md\n'
git -C "$REPO" switch -q main

touch_in_paths_repo() { # touch_in_paths_repo <branch> <file>: a branch off withpaths that changes <file>
  git -C "$REPO" switch -q -c "$1" withpaths
  echo more >> "$REPO/$2"
  git -C "$REPO" commit -qam "touch $2"
  run_check "$BASE3"
  git -C "$REPO" switch -q main
}
BASE3="$(git -C "$REPO" rev-parse withpaths)"

git -C "$REPO" switch -q withpaths
run_check "$BASE3"
check "with a check-paths.txt and nothing changed since, the check exits 0 and runs nothing" not ran_check
check "with a check-paths.txt and nothing changed since, it exits 0" test $STATUS -eq 0
git -C "$REPO" switch -q main

touch_in_paths_repo extra-file "$EXTRA_FILE"
check "a file listed in check-paths.txt runs the Sandcastle check when it changes" ran_check
touch_in_paths_repo extra-dir "$EXTRA_DIR/page.md"
check "a folder listed in check-paths.txt runs the Sandcastle check when a file in it changes" ran_check
touch_in_paths_repo extra-spaced "$SPACED"
check "a listed path with a space in it runs the Sandcastle check when it changes" ran_check
touch_in_paths_repo extra-comment docs/commented.md
check "a commented-out line of check-paths.txt isn't watched" not ran_check
touch_in_paths_repo extra-unlisted docs/unrelated.md
check "with a check-paths.txt, a change to a path it doesn't list runs nothing" not ran_check
check "with a check-paths.txt, a change to a path it doesn't list exits 0" test $STATUS -eq 0
touch_in_paths_repo extra-builtin package.json
check "with a check-paths.txt, the built-in paths are still watched" ran_check

# A comment or blank line must not become a pathspec: '#' alone or an empty one would match every file.
git -C "$REPO" switch -q main
git -C "$REPO" switch -q -c onlycomments main
write_paths $'# nothing here\n\n   \n'
ONLYCOMMENTS_BASE="$(git -C "$REPO" rev-parse HEAD)"
echo more >> "$REPO/docs/unrelated.md"
git -C "$REPO" commit -qam "touch unrelated"
run_check "$ONLYCOMMENTS_BASE"
check "a check-paths.txt of comments and blank lines watches nothing extra" not ran_check
git -C "$REPO" switch -q main

# Extra paths never replace the rule that no merge base means the check runs.
git -C "$REPO" switch -q withpaths
run_check
check "with a check-paths.txt and no merge base the check runs" ran_check
git -C "$REPO" switch -q main

# A change to check-paths.txt itself is a change under .sandcastle/, which is always watched.
git -C "$REPO" switch -q -c edit-paths withpaths
echo "docs/other" >> "$REPO/.sandcastle/check-paths.txt"
git -C "$REPO" commit -qam "edit check-paths.txt"
run_check "$BASE3"
check "a change to check-paths.txt itself runs the Sandcastle check" ran_check
git -C "$REPO" switch -q main

# The paths are read under a git hook too (the four variables set).
git -C "$REPO" switch -q -c hook-extra withpaths
echo more >> "$REPO/$EXTRA_FILE"
git -C "$REPO" commit -qam "touch extra"
run_check_in_hook "$BASE3"
check "with the variables set, a file listed in check-paths.txt runs the Sandcastle check" ran_check
git -C "$REPO" switch -q main

# How check.sh reads check-paths.txt. Every line is a literal path (`:(literal)`), so a comment that is also a
# real file name, a name with glob characters and a line that looks like pathspec magic are all pinned with real files.
# Each case writes a list on a branch off main, touches a file on a branch off that, and runs the check.
LIT_FILES=("#notes.md" "# indented" "lit/[x].md" "lit/x.md" 'lit/*.md' lit/a.md "lit/a*b.md" lit/aXb.md)
for path in "${LIT_FILES[@]}"; do
  mkdir -p "$REPO/$(dirname "$path")"
  echo start > "$REPO/$path"
done
git -C "$REPO" switch -q main
git -C "$REPO" add .
git -C "$REPO" commit -q -m "literal-path files"

case_n=0
list_case() { # list_case <list content> <file to touch>: runs the check after <file> changes, with <content> as check-paths.txt
  case_n=$((case_n + 1))
  git -C "$REPO" switch -q -c "list-$case_n" main
  write_paths "$1"
  local base
  base="$(git -C "$REPO" rev-parse HEAD)"
  echo more >> "$REPO/$2"
  git -C "$REPO" commit -qam "touch $2"
  run_check "$base"
  git -C "$REPO" switch -q main
}

list_case $'docs/generated\r\n\r\n# docs/commented.md\r\n'"$EXTRA_FILE"$'\r\n' "$EXTRA_FILE"
check "a CRLF check-paths.txt: its last listed file runs the check when it changes" ran_check
list_case $'docs/generated\r\n\r\n# docs/commented.md\r\n'"$EXTRA_FILE"$'\r\n' "$EXTRA_DIR/page.md"
check "a CRLF check-paths.txt: its first listed folder runs the check when a file in it changes" ran_check
list_case $'docs/generated\r\n\r\n# docs/commented.md\r\n'"$EXTRA_FILE"$'\r\n' docs/commented.md
check "a CRLF check-paths.txt: a commented-out path isn't watched" not ran_check
list_case $'docs/generated\n'"$EXTRA_FILE" "$EXTRA_FILE"
check "a check-paths.txt whose last line has no trailing newline watches that last path" ran_check
list_case $'docs/generated\n'"$EXTRA_FILE" "$EXTRA_DIR/page.md"
check "a check-paths.txt whose last line has no trailing newline still watches the earlier path" ran_check
list_case $'docs/generated\n   ' docs/unrelated.md
check "a check-paths.txt whose last line is blank with no trailing newline watches nothing extra" not ran_check
list_case $'docs/generated\n'"$EXTRA_FILE"$'\r' "$EXTRA_FILE"
check "a last line ending in a lone CR with no newline is watched without the CR" ran_check
list_case $'\t'"$EXTRA_FILE"$' \t\n' "$EXTRA_FILE"
check "a listed path with leading and trailing tabs and spaces is watched" ran_check
list_case "   $SPACED   "$'\n' "$SPACED"
check "surrounding spaces are trimmed but a space inside a path is kept" ran_check
list_case $'  # docs/commented.md\n' docs/commented.md
check "an indented comment line isn't watched" not ran_check

# A comment that names a real file must be skipped, not watched: under :(literal) a '#' line that isn't skipped
# matches that file, so these fail if the '#' skip is removed.
list_case $'#notes.md\n' "#notes.md"
check "a line starting with # is a comment even when a file is named that" not ran_check
list_case $'   # indented\n' "# indented"
check "an indented line starting with # is a comment even when a file is named that" not ran_check
list_case $'# \n   \n\t\n' docs/unrelated.md
check "blank and whitespace-only lines watch nothing, not every file" not ran_check

# :(literal) keeps a line from being read as a glob or as pathspec magic.
list_case $'lit/[x].md\n' 'lit/[x].md'
check "a listed name with glob brackets is watched as that literal file" ran_check
list_case $'lit/[x].md\n' lit/x.md
check "a listed name with glob brackets doesn't match the file the glob would" not ran_check
list_case $'lit/*.md\n' 'lit/*.md'
check "a listed name with * is watched as that literal file" ran_check
list_case $'lit/*.md\n' lit/a.md
check "a listed glob like lit/*.md isn't expanded: a file it would match runs nothing" not ran_check
list_case $'lit/a*b.md\n' lit/aXb.md
check "a * in the middle of a listed name isn't a wildcard" not ran_check
list_case $':(exclude)package.json\n' package.json
check "a :(exclude) line doesn't exclude a built-in path: package.json still runs the check" ran_check
check "a :(exclude) line doesn't make the script fail" test $STATUS -eq 0
list_case $':(glob)lit/*.md\n' lit/a.md
check "a :(glob) line is a literal name, so a file the glob would match runs nothing" not ran_check
check "a :(glob) line doesn't make the script fail" test $STATUS -eq 0
list_case $':!.sandcastle\n' .sandcastle/lib/x.mts
check "a :! line isn't a pathspec: it doesn't exclude a built-in path" ran_check

# The Seed's header and the docs must say entries are literal paths, not globs.
mentions_literal() { grep -qi 'literal' "$1" && grep -qi 'globs are not expanded' "$1"; }
check "the Seed check-paths.txt says entries are literal paths, not globs" mentions_literal "$SEED_PATHS"
check "check.sh's header says entries are literal paths, not globs" mentions_literal "$CHECK"
doc_row_mentions_literal() {
  local row
  row="$(grep -F "| \`.sandcastle/check-paths.txt\`" "$SKILL_DIR/references/sandcastle.md")"
  grep -qi 'literal' <<< "$row" && grep -qi 'globs are not expanded' <<< "$row"
}
check "references/sandcastle.md's check-paths.txt row says entries are literal, not globs" doc_row_mentions_literal

echo
echo "seed-check.test.sh: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
