#!/usr/bin/env bash
# Tests for mpaulosky/dotfiles#333: each Template rule has one full statement, and the copies that must stay self-contained
# (the Seed hand-off rule, which loads in every Baseline repo and can't link to dotfiles' references/, and the label's
# description, which GitHub shows and caps at 100 characters) carry the shortest text that can't drift from it.
#
# Two kinds of check:
#   - agreement: the facts the self-contained copies state (who may add the label, the pass cap, the merge depth, the
#     session marker, the Copilot fallback's 30 seconds) agree with the source (the reference or the code), so a drift
#     fails the gate and doesn't wait for a review;
#   - one source: the other places (SKILL.md's table, CONTEXT.md, code comments) say less or point to references/sandcastle.md.
# Usage: tests/doc-single-source.test.sh
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -I - "$SKILL_DIR" <<'PY'
import re
import sys
from pathlib import Path

skill = Path(sys.argv[1])
owned = skill / "template" / "owned"
lib = owned / ".sandcastle" / "lib"

seed_rule = (skill / "template/owned/.claude/rules/sandcastle-hand-off.md").read_text()
reference = (skill / "references/sandcastle.md").read_text()
skill_md = (skill / "SKILL.md").read_text()
context = (skill / "CONTEXT.md").read_text()
config = (lib / "config.mts").read_text()
follow_up = (lib / "follow-up.mts").read_text()

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"ok   - {name}")
    else:
        failed += 1
        print(f"FAIL - {name}" + (f"\n       | {detail}" if detail else ""))


def flat(text):
    return " ".join(text.split())


def section(text, heading):
    """The body of a `## heading` section, up to the next `## `."""
    match = re.search(rf"(?ms)^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", text)
    return match.group(1) if match else ""


def constant(source, name):
    match = re.search(rf'export const {name}(?::[^=]+)? = (.+?);\s*$', source, re.M)
    return match.group(1) if match else None


NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def number_before(text, pattern):
    """The number (digit or word) written right before `pattern` in `text`, or None."""
    match = re.search(rf"\b(\d+|{'|'.join(NUMBER_WORDS)})\s+(?:{pattern})", text, re.I)
    if not match:
        return None
    word = match.group(1).lower()
    return int(word) if word.isdigit() else NUMBER_WORDS[word]


hand_off_ref = section(reference, "Hand-off PRs")
who = next((b for b in re.split(r"\n(?=- \*\*)", hand_off_ref) if b.lstrip().startswith("- **Who.**")), "")
label_description = (re.search(
    r"export const FOLLOW_UP_LABEL_DEFINITION[^{]*\{.*?description:\s*\"((?:[^\"\\]|\\.)*)\"", config, re.S) or [None, ""])[1]

# ---- The sources exist ----------------------------------------------------------------------------------------------------
check("references/sandcastle.md has a `## Hand-off PRs` section (the one full statement of the hand-off model)", bool(hand_off_ref))
check("that section has a **Who.** bullet", bool(who))
check("FOLLOW_UP_LABEL_DEFINITION has a one-line description in lib/config.mts", bool(label_description))

# ---- Agreement: the self-contained copies state the same facts as the source ----------------------------------------------
label = (constant(config, "FOLLOW_UP_LABEL") or "").strip('"')
check("the Seed rule and the reference both name the label FOLLOW_UP_LABEL gives", bool(label) and label in seed_rule and label in hand_off_ref, label)

marker = (constant(config, "SESSION_REPLY_MARKER") or "").strip('"')
check("the Seed rule and the reference both give SESSION_REPLY_MARKER's text", bool(marker) and marker in seed_rule and marker in hand_off_ref, marker)

cap = constant(config, "FOLLOW_UP_PASS_CAP")
said_cap = number_before(seed_rule, r"(?:follow-up )?passes")
check("the Seed rule's pass cap is FOLLOW_UP_PASS_CAP", cap is not None and said_cap == int(cap), f"code {cap}, Seed rule {said_cap}")

depth = constant(follow_up, "MAX_MAIN_MERGES")
said_depth = number_before(seed_rule, r"merges")
check("the Seed rule's merge depth is MAX_MAIN_MERGES", depth is not None and said_depth == int(depth), f"code {depth}, Seed rule {said_depth}")
check("the reference names MAX_MAIN_MERGES for that depth", "MAX_MAIN_MERGES" in hand_off_ref)

# Who may hand a PR off: the owner, or a session under the owner's token. The Seed rule and the label's description are the copies
# that must stay self-contained, so each says it in its own words, and the phrase they share with the source is pinned here.
check("the reference's Who bullet says the label must come from the owner", "owner" in who.lower())
check("the reference's Who bullet says a session posts under the owner's token", "owner's token" in flat(who))
check("the Seed rule says a session adds the label under the owner's token", "owner's token" in flat(seed_rule))
check("the Seed rule says a label from anyone else does not count", re.search(r"anyone else[^.]*not count|not count[^.]*anyone else", flat(seed_rule)) is not None)
check("the label's description says it counts only from the owner", re.search(r"only from the owner", label_description) is not None, label_description)
check("the label's description stays within GitHub's 100 characters", 0 < len(label_description) <= 100, f"{len(label_description)} characters")
check("the Seed rule doesn't say any login with push access counts (the code counts it, but only the owner's label records a head)",
      "push access" not in seed_rule)
check("the label's description doesn't say any login with push access counts", "push access" not in label_description)
check("the Seed rule says the pull request must be opened by the repository's owner or a session",
      "opened by the repository's owner" in flat(seed_rule))
check("the Seed rule names the token the repository's Actions runs need (SANDCASTLE_GH_TOKEN), as the reference does",
      "SANDCASTLE_GH_TOKEN" in seed_rule and "SANDCASTLE_GH_TOKEN" in hand_off_ref)

# The Copilot fallback: PR Auto-Merge asks Copilot once and falls back to Claude after COPILOT_ASK_SETTLE_MS. Each doc that
# states the wait states the workflow's number.
workflow = (owned / ".github/workflows/pr-automerge.yml").read_text()
settle = re.search(r"const COPILOT_ASK_SETTLE_MS = (\d+) \* 1000;", workflow)
seconds = int(settle.group(1)) if settle else None
check("pr-automerge.yml sets COPILOT_ASK_SETTLE_MS in whole seconds", seconds is not None)
for doc in ("references/automerge.md", "docs/adr/0004-claude-review-as-copilots-backup.md"):
    text = flat((skill / doc).read_text())
    said = {int(n) for n in re.findall(r"\b(\d+)[ -]seconds?\b", text)}
    check(f"{doc} states the Copilot fallback's wait as COPILOT_ASK_SETTLE_MS's {seconds} seconds", seconds in said, f"seconds named: {sorted(said)}")
process = flat((owned / "docs/PROCESS.md").read_text())
said = {int(n) for n in re.findall(r"\b(\d+)[ -]seconds?\b", process)}
check(f"docs/PROCESS.md states the Copilot fallback's wait as COPILOT_ASK_SETTLE_MS's {seconds} seconds", seconds in said, f"seconds named: {sorted(said)}")

# ---- One source: the other places say less or point to the reference ------------------------------------------------------
check("the Seed rule stays short (at most 3000 characters): the model is in the reference", len(seed_rule) <= 3000, f"{len(seed_rule)} characters")
check("the Seed rule doesn't walk through how the head is recorded (RELEASE_PR_PAT, the workflow comment): the reference does",
      "RELEASE_PR_PAT" not in seed_rule and "workflow comment" not in seed_rule)
check("the Seed rule doesn't mention dotfiles or link to references/ (it loads in every Baseline repo)",
      not re.search(r"dotfiles|repo-ci-baseline|Support For New Projects|references/", seed_rule))

row = next((l for l in skill_md.splitlines() if l.startswith("| Sandcastle |")), "")
check("SKILL.md has a Sandcastle row in its table of parts", bool(row))
check("SKILL.md's Sandcastle row links to references/sandcastle.md", "references/sandcastle.md" in row)
check("SKILL.md's Sandcastle row stays short (at most 400 characters)", 0 < len(row) <= 400, f"{len(row)} characters")
listed = [name for name in ("sandcastle-hand-off.md", "repo-config.mts", "sandcastle-skills.txt", "main.mts", "status.mts", "Dockerfile") if name in row]
check("SKILL.md's Sandcastle row doesn't list the Template's files one by one (the reference's tables do)", not listed, ", ".join(listed))

check("CONTEXT.md keeps a Sandcastle section entry", "**Sandcastle section**" in context)
check("CONTEXT.md links to the reference's Hand-off PRs section for the model (references/sandcastle.md#hand-off-prs)",
      "references/sandcastle.md#hand-off-prs" in context)
check("CONTEXT.md doesn't restate who may hand a PR off",
      not re.search(r"push access|owner's token|collaborator|force-push|merges of `?main", context))

# Code comments say what the code beside them does, and point to the reference for the model.
header = []
lines = follow_up.splitlines()
at = next((i for i, l in enumerate(lines) if l.startswith("export function handOffApproval(")), None)
if at is not None:
    i = at - 1
    while i >= 0 and lines[i].startswith("//"):
        header.insert(0, lines[i])
        i -= 1
header_text = flat(" ".join(header))
check("handOffApproval has a comment block in lib/follow-up.mts", bool(header))
check("handOffApproval's comment points to references/sandcastle.md for the model", "references/sandcastle.md" in header_text)
check("handOffApproval's comment is at most 8 lines (the reference's Who and The head bullets hold the rest)", 0 < len(header) <= 8, f"{len(header)} lines")
check("handOffApproval's comment doesn't restate the update-branch accounts (PR Auto-Merge's RELEASE_PR_PAT, the Update branch button)",
      "RELEASE_PR_PAT" not in header_text and "Update branch" not in header_text)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
PY
