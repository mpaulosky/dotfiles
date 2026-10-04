#!/usr/bin/env bash
# Tests for .github/hooks/pre-commit.
# Each lint case stages Markdown in a linked worktree of a throwaway repo and
# runs the hook; the worktree cases also run it in the primary checkout. A stub
# `markdownlint-cli2` logs the files it is given and applies two rules from the
# .markdownlint-cli2.jsonc it finds in its working directory: "forbid" names a
# word that fails a file, and "ignores" lists "prefix/**" paths it skips. A
# nested config's "forbid" replaces the root's for the files under it. So a
# case can tell whether the hook linted the staged content or the working
# copy, and under which config, without needing the real linter.
# Usage: .github/hooks/tests/pre-commit.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pre-commit"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PRIMARY="$WORK/repo"
# The lint cases run in a linked worktree, where commits are allowed.
REPO="$WORK/repo-worktrees/fix-1-lint"
STUBS="$WORK/bin"
LOG="$WORK/lint.log"

mkdir -p "$STUBS"
cat > "$STUBS/markdownlint-cli2" <<EOF
#!/usr/bin/env bash
echo "markdownlint-cli2 \$*" >> "$LOG"
[[ -f .markdownlint-cli2.jsonc ]] || { echo "no config in \$PWD"; exit 2; }
word=\$(sed -n 's/.*"forbid": *"\\([^"]*\\)".*/\\1/p' .markdownlint-cli2.jsonc)
ignored=\$(sed -n 's/.*"ignores": *\\[ *"\\([^"]*\\)\\*\\*".*/\\1/p' .markdownlint-cli2.jsonc)
status=0
for file in "\$@"; do
  if [[ -n "\$ignored" && "\$file" == "\$ignored"* ]]; then
    continue
  fi
  # A nested config's "forbid" replaces the root's for the files under it.
  file_word="\$word" dir=\$(dirname "\$file")
  while [[ "\$dir" != "." ]]; do
    if [[ -f "\$dir/.markdownlint-cli2.jsonc" ]]; then
      file_word=\$(sed -n 's/.*"forbid": *"\\([^"]*\\)".*/\\1/p' "\$dir/.markdownlint-cli2.jsonc")
      break
    fi
    dir=\$(dirname "\$dir")
  done
  if grep -q "\$file_word" "\$file"; then
    echo "\$file: \$file_word found"
    status=1
  fi
done
exit \$status
EOF
chmod +x "$STUBS/markdownlint-cli2"

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

git init -q -b main "$PRIMARY"
echo '{ "forbid": "BAD", "ignores": ["docs/blogs/**"] }' > "$PRIMARY/.markdownlint-cli2.jsonc"
echo '# Readme' > "$PRIMARY/README.md"
git -C "$PRIMARY" add .
# No hooks here: this is setup, and a global hooksPath would otherwise run.
git -C "$PRIMARY" -c core.hooksPath=/dev/null commit -q -m init
git -C "$PRIMARY" worktree add -q -b fix/1-lint "$REPO"

PASSED=0
FAILED=0
OUTPUT=""
STATUS=0

# run_hook [dir]: run the hook in dir, the lint worktree by default.
run_hook() {
  : > "$LOG"
  OUTPUT="$(cd "${1:-$REPO}" && PATH="$STUBS:$PATH" bash "$HOOK" 2>&1)"
  STATUS=$?
}

pass() {
  PASSED=$((PASSED + 1))
  echo "ok   - $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "FAIL - $1: $2"
  while IFS= read -r line; do echo "       | $line"; done <<< "$OUTPUT"
}

# expect <name> <allowed|refused> <linted|not-linted>
expect() {
  local name="$1" outcome="$2" lint="$3"
  if [[ "$outcome" == allowed && $STATUS -ne 0 ]]; then
    fail "$name" "expected the commit to be allowed, exit $STATUS"
  elif [[ "$outcome" == refused && $STATUS -eq 0 ]]; then
    fail "$name" "expected the commit to be refused"
  elif [[ "$lint" == linted && ! -s "$LOG" ]]; then
    fail "$name" "expected markdownlint-cli2 to run"
  elif [[ "$lint" == not-linted && -s "$LOG" ]]; then
    fail "$name" "expected markdownlint-cli2 not to run"
  else
    pass "$name"
  fi
}

# reset_repo: drop staged and unstaged changes so each case starts clean.
reset_repo() {
  git -C "$REPO" reset -q --hard
  git -C "$REPO" clean -qfd
}

run_hook
expect "with no staged Markdown the hook skips the lint" allowed not-linted

echo 'Some text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
run_hook
expect "clean staged Markdown passes" allowed linted
reset_repo

echo 'BAD text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
run_hook
expect "a violation in staged Markdown refuses the commit" refused linted
reset_repo

echo 'BAD text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" show HEAD:README.md > "$REPO/README.md"
run_hook
expect "a violation that is staged but fixed only in the working copy refuses the commit" refused linted
reset_repo

echo 'Some text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
echo 'BAD text.' >> "$REPO/README.md"
run_hook
expect "a violation only in the unstaged working copy doesn't refuse the commit" allowed linted
reset_repo

mkdir -p "$REPO/docs/sub dir"
echo 'BAD text.' > "$REPO/docs/sub dir/my notes.md"
git -C "$REPO" add "docs/sub dir/my notes.md"
run_hook
expect "a staged file whose path has spaces is linted" refused linted
reset_repo

git -C "$REPO" rm -q README.md
run_hook
expect "deleting a Markdown file skips the lint" allowed not-linted
reset_repo

# Enough unchanged lines that git reports a rename (R), not an add.
printf '# Notes\n\n%s\n' line1 line2 line3 line4 line5 line6 line7 line8 > "$REPO/NOTES.md"
git -C "$REPO" add NOTES.md
git -C "$REPO" -c core.hooksPath=/dev/null commit -q -m notes
git -C "$REPO" mv NOTES.md GUIDE.md
echo 'BAD text.' >> "$REPO/GUIDE.md"
git -C "$REPO" add GUIDE.md
# The case only proves something if git reports a rename; fail it otherwise.
OUTPUT="$(git -C "$REPO" diff --cached --name-status)"
if [[ "$OUTPUT" == R* ]]; then
  run_hook
  expect "a violation in a renamed Markdown file refuses the commit" refused linted
else
  fail "a violation in a renamed Markdown file refuses the commit" "setup: git didn't report a staged rename"
fi
git -C "$REPO" reset -q --hard HEAD~1

# The stub linter fails without a config, so an unstaged config shows up here.
git -C "$REPO" rm -q --cached .markdownlint-cli2.jsonc
echo 'Some text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
run_hook
expect "a config that isn't staged isn't used" refused linted
git -C "$REPO" add .markdownlint-cli2.jsonc
reset_repo

# The staged config forbids STAGED; the working copy's forbids WORKING instead.
echo '{ "forbid": "STAGED", "ignores": ["docs/blogs/**"] }' > "$REPO/.markdownlint-cli2.jsonc"
git -C "$REPO" add .markdownlint-cli2.jsonc
echo '{ "forbid": "WORKING", "ignores": ["docs/blogs/**"] }' > "$REPO/.markdownlint-cli2.jsonc"
echo 'STAGED text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
run_hook
expect "the staged config's rules apply" refused linted
reset_repo

echo '{ "forbid": "STAGED", "ignores": ["docs/blogs/**"] }' > "$REPO/.markdownlint-cli2.jsonc"
git -C "$REPO" add .markdownlint-cli2.jsonc
echo '{ "forbid": "WORKING", "ignores": ["docs/blogs/**"] }' > "$REPO/.markdownlint-cli2.jsonc"
echo 'WORKING text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
run_hook
expect "the working copy's config rules don't apply" allowed linted
reset_repo

mkdir -p "$REPO/docs/blogs"
echo 'BAD text.' > "$REPO/docs/blogs/post.md"
git -C "$REPO" add docs/blogs/post.md
run_hook
expect "a staged file under an ignored path passes" allowed linted
reset_repo

# A nested config (here allowing BAD under vendor/) applies to its directory,
# as it does in CI, but only once it's staged.
mkdir -p "$REPO/vendor"
echo '{ "forbid": "NESTED" }' > "$REPO/vendor/.markdownlint-cli2.jsonc"
echo 'BAD text.' > "$REPO/vendor/notes.md"
git -C "$REPO" add vendor
run_hook
expect "a staged nested config's rules apply under its directory" allowed linted
reset_repo

mkdir -p "$REPO/vendor"
echo '{ "forbid": "NESTED" }' > "$REPO/vendor/.markdownlint-cli2.jsonc"
echo 'BAD text.' > "$REPO/vendor/notes.md"
git -C "$REPO" add vendor/notes.md
run_hook
expect "a nested config that isn't staged isn't used" refused linted
reset_repo

# ── Commits only in a linked worktree ──

echo 'Some text.' >> "$PRIMARY/README.md"
git -C "$PRIMARY" add README.md
run_hook "$PRIMARY"
expect "a commit in the primary checkout is refused before the lint" refused not-linted

# The message's paths are absolute, so they work from wherever git commit ran.
# pwd -P, as git resolves symlinks in the top level (macOS's /var).
WORKTREES_ABS="$(cd "$WORK" && pwd -P)/repo-worktrees/<folder>"
expect_folder() {
  if [[ "$OUTPUT" == *"git worktree add -b <branch> \"$WORKTREES_ABS\" origin/main"* ]]; then
    pass "$1"
  else
    fail "$1" "expected the absolute folder \"$WORKTREES_ABS\""
  fi
}
expect_folder "the refusal gives the absolute worktree folder"

# A subfolder of the primary checkout is still the primary checkout.
mkdir -p "$PRIMARY/docs"
run_hook "$PRIMARY/docs"
expect "a commit from a subfolder of the primary checkout is refused" refused not-linted
expect_folder "the refusal from a subfolder gives the same absolute worktree folder"

git -C "$PRIMARY" config baseline.allowPrimaryCommits true
run_hook "$PRIMARY"
expect "baseline.allowPrimaryCommits allows a commit in the primary checkout" allowed linted
git -C "$PRIMARY" config --unset baseline.allowPrimaryCommits
git -C "$PRIMARY" reset -q --hard

echo 'Some text.' >> "$REPO/README.md"
git -C "$REPO" add README.md
run_hook
expect "a commit in a linked worktree is allowed" allowed linted
reset_repo

FRESH="$WORK/fresh"
git init -q -b main "$FRESH"
echo '{ "forbid": "BAD" }' > "$FRESH/.markdownlint-cli2.jsonc"
echo '# Readme' > "$FRESH/README.md"
git -C "$FRESH" add .
run_hook "$FRESH"
expect "a repo's first commit is allowed in the primary checkout" allowed linted

# On a branch of its own in the primary checkout, the refusal's commands move
# that branch, with its staged and untracked changes, into a worktree, and
# what was staged is still staged there (README.md), the rest still not (new.md).
git -C "$PRIMARY" switch -q -c fix/2-moved
echo 'Staged.' >> "$PRIMARY/README.md"
git -C "$PRIMARY" add README.md
echo 'Untracked.' > "$PRIMARY/new.md"
run_hook "$PRIMARY"
expect "a commit on its own branch in the primary checkout is refused" refused not-linted
# The command lines, without their colour codes.
RECOVERY="$(sed -e 's/\x1b\[[0-9;]*m//g' -n -e 's/^      \(git .*\|cd .*\)$/\1/p' <<< "$OUTPUT")"
MOVED="$(cd "$WORK" && pwd -P)/repo-worktrees/fix-2-moved"
if [[ "$RECOVERY" != *"git switch main"* ]]; then
  fail "the refusal's commands move the branch into a worktree" "no git switch main in the message"
elif ! (cd "$PRIMARY" && set -e && eval "$RECOVERY") &>/dev/null; then
  fail "the refusal's commands move the branch into a worktree" "the commands failed"
elif [[ "$(git -C "$MOVED" branch --show-current)" != fix/2-moved ]] \
  || ! grep -q Staged "$MOVED/README.md" || [[ ! -f "$MOVED/new.md" ]] \
  || ! git -C "$MOVED" diff --cached --quiet --exit-code -- new.md \
  || git -C "$MOVED" diff --cached --quiet -- README.md \
  || ! git -C "$MOVED" diff --quiet -- README.md \
  || [[ "$(git -C "$PRIMARY" branch --show-current)" != main ]] \
  || [[ -n "$(git -C "$PRIMARY" status --porcelain)" ]]; then
  fail "the refusal's commands move the branch into a worktree" "the worktree or primary checkout isn't as expected"
else
  pass "the refusal's commands move the branch into a worktree"
fi

# An orphan branch has no HEAD commit, but the repo has history.
git -C "$PRIMARY" checkout -q --orphan fresh-start
run_hook "$PRIMARY"
expect "a commit on an orphan branch in the primary checkout is refused" refused not-linted
git -C "$PRIMARY" checkout -q -f main

# End to end through git commit, which runs the hook with GIT_DIR and
# GIT_INDEX_FILE set, and in a worktree points GIT_DIR at .git/worktrees/<name>.
HOOKS_DIR="$(dirname "$HOOK")"
echo 'Some text.' >> "$PRIMARY/README.md"
if PATH="$STUBS:$PATH" git -C "$PRIMARY" -c core.hooksPath="$HOOKS_DIR" commit -q -am primary &>/dev/null; then
  fail "git commit in the primary checkout is refused" "the commit was made"
  git -C "$PRIMARY" reset -q --hard HEAD~1
else
  pass "git commit in the primary checkout is refused"
fi
git -C "$PRIMARY" reset -q --hard
echo 'Some text.' >> "$REPO/README.md"
if OUTPUT="$(PATH="$STUBS:$PATH" git -C "$REPO" -c core.hooksPath="$HOOKS_DIR" commit -q -am worktree 2>&1)"; then
  pass "git commit in a linked worktree is allowed"
else
  fail "git commit in a linked worktree is allowed" "the commit was refused"
fi

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
