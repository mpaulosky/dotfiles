#!/usr/bin/env bash
# Keeps .github/copilot-instructions.md, the guidance GitHub's Copilot code
# review reads, in step with the code-review skill Claude Code uses. The skill
# is the source: the instructions file is its body (the skill's front matter
# dropped) under a generated-file header.
#   scripts/sync-copilot-review.sh          rewrite the instructions file
#   scripts/sync-copilot-review.sh --check  fail if it has drifted from the skill
# A repo without the skill has nothing to sync: both modes then say so and
# succeed, leaving any hand-written instructions file as it is. A repo opts in
# by adding .claude/skills/code-review/SKILL.md. Owned by the repo-ci-baseline
# Template (references/copilot-review-sync.md).
#
# Line endings: the skill's carriage returns are dropped, so a Windows checkout
# with core.autocrlf produces the file CI generates, and --check ignores a
# trailing carriage return in the committed file. A skill whose front matter
# opens with --- and never closes is refused rather than written as an empty file.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SKILL="$ROOT/.claude/skills/code-review/SKILL.md"
TARGET="$ROOT/.github/copilot-instructions.md"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'

# Refused before looking for the skill, so a bad call fails in every repo.
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--check" ) ]]; then
  echo "Usage: scripts/sync-copilot-review.sh [--check]" >&2
  exit 2
fi

if [[ ! -f "$SKILL" ]]; then
  echo -e "${GREEN}✅ No ${SKILL#"$ROOT"/}, so there are no Copilot review instructions to sync.${RESET}"
  exit 0
fi

# expected: the header, then the skill with its leading front matter block removed.
expected() {
  cat <<'HEADER'
<!-- Generated from .claude/skills/code-review/SKILL.md by scripts/sync-copilot-review.sh.
     Edit the skill and rerun the script; scripts/gate.sh and CI fail when this file drifts. -->

HEADER
  awk '
    { sub(/\r$/, "") }
    NR == 1 && $0 == "---" { in_front = 1; next }
    in_front && $0 == "---" { in_front = 0; skip_blank = 1; next }
    in_front { next }
    skip_blank && $0 == "" { next }
    { skip_blank = 0; print }
    END { if (in_front) exit 3 }
  ' "$SKILL"
}

# Built before anything is written, so a skill that cannot be read leaves the instructions file as it was.
generated="$(mktemp)"
trap 'command rm -f "$generated"' EXIT
if ! expected > "$generated"; then
  echo -e "${RED}❌ ${SKILL#"$ROOT"/} opens with --- but its front matter never closes.${RESET}" >&2
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  if [[ ! -f "$TARGET" ]] || ! diff -u --strip-trailing-cr --label "${TARGET#"$ROOT"/}" --label "expected from ${SKILL#"$ROOT"/}" \
    "$TARGET" "$generated"; then
    echo -e "${RED}❌ .github/copilot-instructions.md has drifted from the code-review skill.${RESET}"
    echo -e "   Edit ${CYAN}.claude/skills/code-review/SKILL.md${RESET}, then run ${CYAN}scripts/sync-copilot-review.sh${RESET}."
    exit 1
  fi
  echo -e "${GREEN}✅ Copilot review instructions match the code-review skill.${RESET}"
else
  mkdir -p "$(dirname "$TARGET")"
  cat "$generated" > "$TARGET"
  echo -e "${GREEN}✅ Wrote ${TARGET#"$ROOT"/}.${RESET}"
fi
