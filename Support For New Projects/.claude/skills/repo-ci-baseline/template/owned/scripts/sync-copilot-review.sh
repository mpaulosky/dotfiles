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
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SKILL="$ROOT/.claude/skills/code-review/SKILL.md"
TARGET="$ROOT/.github/copilot-instructions.md"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'

case "${1:-}" in
  --check | "") ;;
  *)
    echo "Usage: scripts/sync-copilot-review.sh [--check]" >&2
    exit 2
    ;;
esac

if [[ ! -f "$SKILL" ]]; then
  echo -e "${GREEN}✅ No ${SKILL#"$ROOT"/}, so there are no Copilot review instructions to sync.${RESET}"
  exit 0
fi

# expected: the header, then the skill with its leading front matter block removed.
expected() {
  cat <<'EOF'
<!-- Generated from .claude/skills/code-review/SKILL.md by scripts/sync-copilot-review.sh.
     Edit the skill and rerun the script; scripts/gate.sh and CI fail when this file drifts. -->

EOF
  awk '
    NR == 1 && $0 == "---" { in_front = 1; next }
    in_front && $0 == "---" { in_front = 0; skip_blank = 1; next }
    in_front { next }
    skip_blank && $0 == "" { next }
    { skip_blank = 0; print }
  ' "$SKILL"
}

case "${1:-}" in
  --check)
    if ! diff -u --label "${TARGET#"$ROOT"/}" --label "expected from ${SKILL#"$ROOT"/}" \
      "$TARGET" <(expected); then
      echo -e "${RED}❌ .github/copilot-instructions.md has drifted from the code-review skill.${RESET}"
      echo -e "   Edit ${CYAN}.claude/skills/code-review/SKILL.md${RESET}, then run ${CYAN}scripts/sync-copilot-review.sh${RESET}."
      exit 1
    fi
    echo -e "${GREEN}✅ Copilot review instructions match the code-review skill.${RESET}"
    ;;
  "")
    mkdir -p "$(dirname "$TARGET")"
    expected > "$TARGET"
    echo -e "${GREEN}✅ Wrote ${TARGET#"$ROOT"/}.${RESET}"
    ;;
  *)
    echo "Usage: scripts/sync-copilot-review.sh [--check]" >&2
    exit 2
    ;;
esac
