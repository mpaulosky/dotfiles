#!/usr/bin/env bash
# Tests for scripts/sync-copilot-review.sh, run in throwaway git repositories.
# Usage: scripts/tests/sync-copilot-review.test.sh
set -uo pipefail

# Hooks that run this file set GIT_* variables that would aim git init and rev-parse at the outer repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/sync-copilot-review.sh"
work="$(mktemp -d)"
trap 'command rm -rf "$work"' EXIT
# No template directory: a global init.templateDir could install hooks into the throwaway repositories.
mkdir "$work/no-template"
export GIT_TEMPLATE_DIR="$work/no-template"

PASSED=0
FAILED=0
out=""
status=0
n=0
repo=""

# A repository with the code-review skill holding $1, or none when $1 is "<none>".
new_repo() {
  repo="$work/repo $((++n))"
  git init -q -b main "$repo"
  if [[ "$1" != "<none>" ]]; then
    mkdir -p "$repo/.claude/skills/code-review"
    printf '%s' "$1" > "$repo/.claude/skills/code-review/SKILL.md"
  fi
}
run() { out="$(cd "$repo" && bash "$SCRIPT" "$@" 2>&1)"; status=$?; }
# The same, from a folder inside the repository.
run_in_subfolder() { mkdir -p "$repo/src/deep"; out="$(cd "$repo/src/deep" && bash "$SCRIPT" "$@" 2>&1)"; status=$?; }
# check <description> <command...>: passes when the command succeeds.
check() {
  local description="$1"
  shift
  if "$@"; then
    PASSED=$((PASSED + 1)); echo "ok   - $description"
  else
    FAILED=$((FAILED + 1)); echo "FAIL - $description (exit $status)"
    while IFS= read -r line; do echo "       | $line"; done <<< "$out"
  fi
}
target() { echo "$repo/.github/copilot-instructions.md"; }
status_is() { [[ $status -eq $1 ]]; }
out_has() { [[ $out == *"$1"* ]]; }
target_exists() { [[ -e "$(target)" ]]; }
target_has_line() { grep -qxF -- "$1" "$(target)"; }
target_lacks() { ! grep -q -- "$1" "$(target)"; }
target_is() { [[ "$(<"$(target)")" == "$1" ]]; }
first_line_is() { [[ "$(head -1 "$(target)")" == "$1" ]]; }
not() { ! "$@"; }

expected_header=$'<!-- Generated from .claude/skills/code-review/SKILL.md by scripts/sync-copilot-review.sh.\n     Edit the skill and rerun the script; scripts/gate.sh and CI fail when this file drifts. -->'
skill=$'---\nname: code-review\ndescription: Review rules\n---\n\n# Rules\n\n- Check the thing.\n'

# No skill: nothing to sync, whatever the mode, and a hand-written file stays.
new_repo "<none>"
run --check
check "no skill: --check passes and says there is nothing to sync" status_is 0
check "no skill: --check names the missing skill" out_has "no Copilot review instructions to sync"
run
check "no skill: writing passes" status_is 0
check "no skill: writing creates nothing" not target_exists
mkdir -p "$repo/.github" && echo "hand-written" > "$(target)"
run --check
check "no skill: a hand-written instructions file passes --check" status_is 0
run
check "no skill: a hand-written instructions file is left as it is" target_is "hand-written"

# With the skill.
new_repo "$skill"
run --check
check "skill, no instructions file: --check fails" status_is 1
run
check "skill: writing succeeds" status_is 0
check "skill: writing creates the file" target_exists
check "the file opens with the generated header" first_line_is "<!-- Generated from .claude/skills/code-review/SKILL.md by scripts/sync-copilot-review.sh."
check "the skill's front matter is dropped (name)" target_lacks "^name: code-review"
check "the skill's front matter is dropped (description)" target_lacks "^description:"
check "the skill's body is kept" target_has_line "- Check the thing."
# The exact text is the contract the repos that already carry the file rely on: Blazor-Server's and auth0-management-app's are byte-identical to it.
check "the whole file is the header, a blank line, then the body without front matter or its blank line" \
  target_is "$expected_header"$'\n\n# Rules\n\n- Check the thing.'
run --check
check "--check passes once written" status_is 0
echo "hand edit" >> "$(target)"
run --check
check "a hand edit fails --check" status_is 1
check "a hand edit's failure says it drifted" out_has "drifted"
check "a hand edit's failure names the fix" out_has "scripts/sync-copilot-review.sh"
run
run --check
check "writing again repairs the drift" status_is 0
printf '%s\n- A new rule.\n' "$skill" > "$repo/.claude/skills/code-review/SKILL.md"
run --check
check "an edited skill fails --check" status_is 1

# The same from a folder inside the repository.
run_in_subfolder
check "from a subfolder: writing succeeds" status_is 0
run_in_subfolder --check
check "from a subfolder: --check passes" status_is 0
echo "hand edit" >> "$(target)"
run_in_subfolder --check
check "from a subfolder: a hand edit fails --check" status_is 1

# A skill without front matter is used whole, and a --- rule in the body is kept.
new_repo $'# Rules\n\n- Whole.\n\n---\n\n- After the rule.\n'
run
check "no front matter: the heading is kept" target_has_line "# Rules"
check "no front matter: the body is kept" target_has_line "- Whole."
check "a --- rule in the body is kept" target_has_line "---"
check "a --- rule in the body keeps what follows it" target_has_line "- After the rule."

# A CRLF skill, as a Windows checkout with core.autocrlf makes one, generates the same file as an LF skill.
new_repo "${skill//$'\n'/$'\r\n'}"
run
check "a CRLF skill is written without carriage returns" not grep -q $'\r' "$(target)"
check "a CRLF skill gives the file an LF skill gives" target_is "$expected_header"$'\n\n# Rules\n\n- Check the thing.'
# A CRLF working copy of the generated file still matches.
awk '{ printf "%s\r\n", $0 }' "$(target)" > "$work/crlf" && command mv -f "$work/crlf" "$(target)"
run --check
check "a CRLF copy of the generated file passes --check" status_is 0

# A skill whose front matter never closes is refused, and the existing file is left alone.
new_repo $'---\nname: code-review\n\n# Rules\n'
mkdir -p "$repo/.github" && echo "kept" > "$(target)"
run
check "unterminated front matter: writing is refused" status_is 1
check "unterminated front matter: the message says why" out_has "never closes"
check "unterminated front matter: the existing file is kept" target_is "kept"
run --check
check "unterminated front matter: --check is refused too" status_is 1

# Anything else is a usage error, with or without the skill.
new_repo "<none>"
run --nope
check "no skill: an unknown argument is refused" status_is 2
check "no skill: the usage is printed" out_has "Usage"
new_repo "$skill"
run --nope
check "skill: an unknown argument is refused" status_is 2
check "skill: an unknown argument writes nothing" not target_exists
run --check extra
check "a second argument is refused" status_is 2

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
