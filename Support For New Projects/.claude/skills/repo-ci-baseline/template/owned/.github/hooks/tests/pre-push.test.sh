#!/usr/bin/env bash
# Tests for .github/hooks/pre-push.
# Each case runs the hook in a throwaway repo, holding a copy of
# scripts/gate.sh, with the refs git would pass on stdin. Stub `dotnet`, `npx`,
# `markdownlint-cli2`, `yamllint`, `actionlint`, `zizmor` and `shellcheck`
# binaries log each call, and fail when the call matches the FAIL glob, so no
# real build or network access is needed.
# Usage: .github/hooks/tests/pre-push.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pre-push"
GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/gate.sh"
ZERO="0000000000000000000000000000000000000000"
SHA="1111111111111111111111111111111111111111"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/repo"
STUBS="$WORK/bin"
LOG="$WORK/gates.log"

mkdir -p "$STUBS"
for tool in dotnet npx markdownlint-cli2 yamllint actionlint zizmor shellcheck; do
  cat > "$STUBS/$tool" <<EOF
#!/usr/bin/env bash
call="$tool \$*"
echo "\$call" >> "$LOG"
[[ -z "\${FAIL:-}" || "\$call" != \$FAIL ]]
EOF
  chmod +x "$STUBS/$tool"
done

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

git init -q -b main "$REPO"
mkdir -p "$REPO/tests/Fake.Tests" "$REPO/scripts"
echo '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>' \
  > "$REPO/tests/Fake.Tests/Fake.Tests.csproj"
# A helper library under tests/: not a test project, so the gate never tests it.
mkdir -p "$REPO/tests/Fake.Support"
echo '<Project />' > "$REPO/tests/Fake.Support/Fake.Support.csproj"
cp "$GATE" "$REPO/scripts/gate.sh"
git -C "$REPO" add .
git -C "$REPO" commit -q -m init
git -C "$REPO" update-ref refs/remotes/origin/main main
# An annotated tag, so a tag pushed to a branch has a tag object to peel.
git -C "$REPO" tag -a v1.0.0 -m v1.0.0

PASSED=0
FAILED=0
OUTPUT=""
STATUS=0

# switch_to <branch>: check out the branch, creating it from origin/main if new.
# Existing branches keep their commits.
switch_to() {
  git -C "$REPO" switch -q "$1" 2>/dev/null || git -C "$REPO" switch -q -c "$1" origin/main
}

# run_hook <checked-out branch> <stdin>
# In <stdin>, @HEAD@ becomes the checked-out commit and @TAG@ the v1.0.0 tag
# object, so a case can push exactly what is checked out.
run_hook() {
  switch_to "$1"
  : > "$LOG"
  local stdin="${2//@HEAD@/$(git -C "$REPO" rev-parse HEAD)}"
  stdin="${stdin//@TAG@/$(git -C "$REPO" rev-parse v1.0.0)}"
  OUTPUT="$(cd "$REPO" && PATH="$STUBS:$PATH" bash "$HOOK" <<< "$stdin" 2>&1)"
  STATUS=$?
}

# run_hook_without_stdin <checked-out branch>
run_hook_without_stdin() {
  switch_to "$1"
  : > "$LOG"
  OUTPUT="$(cd "$REPO" && PATH="$STUBS:$PATH" bash "$HOOK" < /dev/null 2>&1)"
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

# expect <name> <allowed|refused> <tests-ran|tests-skipped|any> [message]
expect() {
  local name="$1" verdict="$2" tests="$3" message="${4:-}"

  if [[ "$verdict" == "allowed" && $STATUS -ne 0 ]]; then
    fail "$name" "expected the push to be allowed, exit $STATUS"
    return
  fi
  if [[ "$verdict" == "refused" && $STATUS -eq 0 ]]; then
    fail "$name" "expected the push to be refused"
    return
  fi
  if [[ "$tests" == "tests-ran" ]] && ! grep -q '^dotnet test ' "$LOG"; then
    fail "$name" "expected the tests to run"
    return
  fi
  if [[ "$tests" == "tests-skipped" && -s "$LOG" ]]; then
    fail "$name" "expected the lint and test gates to be skipped, but ran: $(tr '\n' ' ' < "$LOG")"
    return
  fi
  if [[ -n "$message" ]] && ! grep -qF -- "$message" <<< "$OUTPUT"; then
    fail "$name" "expected output to contain '$message'"
    return
  fi
  pass "$name"
}

# expect_log <name> <ran|not-ran> <glob>: whether any logged call matches <glob>.
expect_log() {
  local name="$1" want="$2" glob="$3" call found=false
  while IFS= read -r call; do
    # shellcheck disable=SC2053 # $glob is a pattern on purpose
    [[ "$call" == $glob ]] && found=true
  done < "$LOG"
  if [[ "$want" == "ran" && "$found" == false ]]; then
    fail "$name" "expected a call matching '$glob', got: $(tr '\n' ' ' < "$LOG")"
  elif [[ "$want" == "not-ran" && "$found" == true ]]; then
    fail "$name" "expected no call matching '$glob', got: $(tr '\n' ' ' < "$LOG")"
  else
    pass "$name"
  fi
}

# commit_on <branch> <path> <content>: a new branch from origin/main with one
# commit adding <path>.
commit_on() {
  git -C "$REPO" switch -q -c "$1" origin/main
  mkdir -p "$(dirname "$REPO/$2")"
  printf '%s\n' "$3" > "$REPO/$2"
  git -C "$REPO" add "$2"
  git -C "$REPO" commit -q -m "add $2"
}

# push_stdin <branch>: the refs line for pushing the checked-out <branch>.
push_stdin() {
  echo "refs/heads/$1 @HEAD@ refs/heads/$1 $ZERO"
}

run_hook main "(delete) $ZERO refs/heads/feature/1-x $SHA"
expect "deleting a feature branch from main skips the gates" allowed tests-skipped

run_hook main "(delete) $ZERO refs/heads/main $SHA"
expect "deleting main is refused" refused tests-skipped "Deleting 'main' is not allowed."

run_hook feature/1-x "(delete) $ZERO refs/heads/preview $SHA"
expect "deleting preview is refused" refused tests-skipped "Deleting 'preview' is not allowed."

run_hook main "refs/heads/main $SHA refs/heads/main $ZERO"
expect "pushing main is refused" refused tests-skipped "Direct pushes to 'main' are not allowed."

run_hook feature/1-x "refs/heads/feature/1-x @HEAD@ refs/heads/feature/1-x $ZERO"
expect "pushing a feature branch runs the gates" allowed tests-ran
expect_log "the gate tests a project marked IsTestProject" ran 'dotnet test tests/Fake.Tests/Fake.Tests.csproj*'
expect_log "the gate skips a helper library under tests/" not-ran 'dotnet test tests/Fake.Support/*'

run_hook main "refs/heads/feature/1-x $SHA refs/heads/feature/1-x $ZERO"
expect "pushing a branch that isn't checked out is refused" refused tests-skipped "is not the checked-out commit"

run_hook feature/1-x "HEAD $SHA refs/heads/bad-name $ZERO"
expect "pushing to a badly named branch is refused" refused tests-skipped "Branch name 'bad-name' does not match"

# The branch standard: feature/, fix/ and hotfix/ carry an issue number;
# chore/ doesn't. squad/ and sprint/ are retired.
for branch in fix/2-fix-a-thing hotfix/3-urgent chore/tidy-up chore/upgrade-net10 feature/8-oauth2-login; do
  run_hook "$branch" "refs/heads/$branch @HEAD@ refs/heads/$branch $ZERO"
  expect "pushing a $branch branch runs the gates" allowed tests-ran
done

# Slugs are lowercase, and a chore/ slug starts with a letter, so it can't pass
# for an issue-linked name.
for branch in squad/4-old-style sprint/5-old-style feature/no-issue fix/no-issue hotfix/no-issue feature/9-Upper chore/tidy-Up chore/7-cleanup; do
  run_hook feature/1-x "HEAD $SHA refs/heads/$branch $ZERO"
  expect "pushing to $branch is refused" refused tests-skipped "Branch name '$branch' does not match"
done

run_hook feature/1-x "refs/heads/main $SHA refs/heads/dev $ZERO"
expect "pushing to dev from a feature branch is refused" refused tests-skipped "Direct pushes to 'dev' are not allowed."

run_hook feature/1-x "refs/tags/v1.0.0 $SHA refs/tags/v1.0.0 $ZERO"
expect "a tag-only push skips the gates" allowed tests-skipped "No branch updates"

run_hook feature/1-x "refs/tags/v1.0.0 $SHA refs/tags/v1.0.0 $ZERO
refs/heads/feature/1-x @HEAD@ refs/heads/feature/1-x $ZERO"
expect "a mixed tag and branch push gates the branch" allowed tests-ran

run_hook feature/1-x "refs/tags/v1.0.0 $SHA refs/tags/v1.0.0 $ZERO
refs/heads/feature/1-x $SHA refs/heads/bad-name $ZERO"
expect "a mixed tag and badly named branch push is refused" refused tests-skipped "Branch name 'bad-name' does not match"

run_hook feature/1-x "refs/tags/v1.0.0 $SHA refs/heads/main $ZERO"
expect "pushing a tag to main is refused" refused tests-skipped "Direct pushes to 'main' are not allowed."

run_hook feature/1-x "refs/tags/v1.0.0 @TAG@ refs/heads/feature/1-x $ZERO"
expect "pushing a tag of the checked-out commit to a feature branch runs the gates" allowed tests-ran

run_hook main "(delete) $ZERO refs/tags/v1.0.0 $SHA"
expect "deleting a tag skips the gates" allowed tests-skipped

run_hook_without_stdin main
expect "without stdin, a main checkout is refused" refused tests-skipped "Direct pushes to 'main' are not allowed."

run_hook_without_stdin feature/1-x
expect "without stdin, a feature checkout runs the gates" allowed tests-ran

git -C "$REPO" switch -q -c feature/2-two-commits origin/main
echo '# First' > "$REPO/first.md"
git -C "$REPO" add first.md
git -C "$REPO" commit -q -m first
echo 'second' > "$REPO/second.txt"
git -C "$REPO" add second.txt
git -C "$REPO" commit -q -m second
FAIL='markdownlint-cli2*first.md*' run_hook feature/2-two-commits \
  "refs/heads/feature/2-two-commits @HEAD@ refs/heads/feature/2-two-commits $ZERO"
expect "a lint error in the first of two unpushed commits refuses the push" refused any

FAIL='dotnet build*' run_hook feature/1-x "refs/heads/feature/1-x @HEAD@ refs/heads/feature/1-x $ZERO"
expect "a failing build refuses the push" refused any

# Workflow and shell linters run only when their files change.
run_hook feature/1-x "$(push_stdin feature/1-x)"
expect_log "a push with no workflow or shell changes skips actionlint" not-ran 'actionlint*'
expect_log "a push with no workflow or shell changes skips zizmor" not-ran 'zizmor*'
expect_log "a push with no workflow or shell changes skips shellcheck" not-ran 'shellcheck*'

commit_on feature/3-workflow .github/workflows/ci.yml 'name: ci'
run_hook feature/3-workflow "$(push_stdin feature/3-workflow)"
expect "a changed workflow is allowed when the linters pass" allowed tests-ran
expect_log "a changed workflow runs actionlint" ran 'actionlint*'
expect_log "a changed workflow runs zizmor over the repo" ran 'zizmor *--min-severity medium .'
expect_log "a changed workflow skips shellcheck" not-ran 'shellcheck*'

FAIL='actionlint*' run_hook feature/3-workflow "$(push_stdin feature/3-workflow)"
expect "an actionlint failure refuses the push" refused any

FAIL='zizmor*' run_hook feature/3-workflow "$(push_stdin feature/3-workflow)"
expect "a zizmor failure refuses the push" refused any

commit_on feature/4-dependabot .github/dependabot.yml 'version: 2'
run_hook feature/4-dependabot "$(push_stdin feature/4-dependabot)"
expect_log "a changed dependabot.yml runs zizmor" ran 'zizmor*'

commit_on feature/5-hook .github/hooks/pre-rebase '#!/usr/bin/env bash'
run_hook feature/5-hook "$(push_stdin feature/5-hook)"
expect_log "a changed git hook runs shellcheck on it" ran 'shellcheck*.github/hooks/pre-rebase*'
expect_log "a changed git hook skips actionlint" not-ran 'actionlint*'

FAIL='shellcheck*' run_hook feature/5-hook "$(push_stdin feature/5-hook)"
expect "a shellcheck failure refuses the push" refused any

commit_on feature/6-script scripts/tool.sh '#!/usr/bin/env bash'
FAIL='shellcheck*scripts/tool.sh*' run_hook feature/6-script "$(push_stdin feature/6-script)"
expect "a shellcheck failure in a changed script refuses the push" refused any

commit_on feature/7-hook-readme .github/hooks/README.md '# Hooks'
run_hook feature/7-hook-readme "$(push_stdin feature/7-hook-readme)"
expect_log "a non-hook file under .github/hooks skips shellcheck" not-ran 'shellcheck*'

switch_to feature/1-x
echo 'uncommitted' > "$REPO/stray.cs"
run_hook feature/1-x "refs/heads/feature/1-x @HEAD@ refs/heads/feature/1-x $ZERO"
expect "an untracked file refuses the push before the gates" refused tests-skipped "uncommitted or untracked changes"
rm "$REPO/stray.cs"

switch_to feature/1-x
echo '<!-- edited -->' >> "$REPO/tests/Fake.Tests/Fake.Tests.csproj"
run_hook feature/1-x "refs/heads/feature/1-x @HEAD@ refs/heads/feature/1-x $ZERO"
expect "an unstaged edit refuses the push before the gates" refused tests-skipped "uncommitted or untracked changes"
git -C "$REPO" checkout -q -- tests/Fake.Tests/Fake.Tests.csproj

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
