#!/usr/bin/env bash
# Tests for .github/hooks/pre-commit.
# Each case stages Markdown in a throwaway repo and runs the hook. A stub
# `markdownlint-cli2` logs the files it is given and applies two rules from the
# .markdownlint-cli2.jsonc it finds in its working directory: "forbid" names a
# word that fails a file, and "ignores" lists "prefix/**" paths it skips. So a
# case can tell whether the hook linted the staged content or the working
# copy, and under which config, without needing the real linter.
# Usage: .github/hooks/tests/pre-commit.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pre-commit"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
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
  if grep -q "\$word" "\$file"; then
    echo "\$file: \$word found"
    status=1
  fi
done
exit \$status
EOF
chmod +x "$STUBS/markdownlint-cli2"

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

git init -q -b main "$REPO"
echo '{ "forbid": "BAD", "ignores": ["docs/blogs/**"] }' > "$REPO/.markdownlint-cli2.jsonc"
echo '# Readme' > "$REPO/README.md"
git -C "$REPO" add .
# No hooks here: this is setup, and a global hooksPath would otherwise run.
git -C "$REPO" -c core.hooksPath=/dev/null commit -q -m init

PASSED=0
FAILED=0
OUTPUT=""
STATUS=0

run_hook() {
  : > "$LOG"
  OUTPUT="$(cd "$REPO" && PATH="$STUBS:$PATH" bash "$HOOK" 2>&1)"
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

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
