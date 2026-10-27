#!/usr/bin/env bash
# Tests for the Seed .github/dependabot.yml: every repo that runs Sandcastle has a root package.json and
# a pnpm lockfile, so the Seed watches the npm ecosystem like its other ecosystems (weekly on Sunday,
# a "chore" commit prefix, a 7-day cooldown with its comment, and an all-npm group).
# Usage: tests/seed-dependabot.test.sh
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPENDABOT="$SKILL_DIR/template/seed/.github/dependabot.yml"

if python3 -I -c 'import yaml' &>/dev/null; then
  yaml_py=(python3 -I)
elif command -v uvx &>/dev/null; then
  yaml_py=(uvx --with pyyaml python -I)
else
  echo "seed-dependabot.test.sh: needs PyYAML or uvx" >&2
  exit 1
fi

"${yaml_py[@]}" - "$DEPENDABOT" <<'PY'
import json
import sys
import yaml

path = sys.argv[1]
text = open(path).read()
doc = yaml.safe_load(text)
updates = {u["package-ecosystem"]: u for u in doc["updates"]}

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"ok   - {name}")
    else:
        failed += 1
        print(f"FAIL - {name}" + (f"\n       | {detail}" if detail else ""))


npm = updates.get("npm")
check("the Seed has an npm ecosystem block", npm is not None, f"ecosystems: {sorted(updates)}")
if npm is None:
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1)

check("npm: there is exactly one npm block", sum(u["package-ecosystem"] == "npm" for u in doc["updates"]) == 1)
check("npm: watches the root directory (the root package.json and pnpm lockfile)", npm.get("directory") == "/", repr(npm.get("directory")))
check("npm: targets main", npm.get("target-branch") == "main", repr(npm.get("target-branch")))
check("npm: runs weekly on Sunday", npm.get("schedule", {}).get("interval") == "weekly" and npm["schedule"].get("day") == "sunday", repr(npm.get("schedule")))
check("npm: has the 7-day cooldown", npm.get("cooldown", {}).get("default-days") == 7, repr(npm.get("cooldown")))
check("npm: uses the chore commit prefix, with the scope", npm.get("commit-message") == {"prefix": "chore", "include": "scope"}, repr(npm.get("commit-message")))
check("npm: labels the PR dependencies and npm", {"dependencies", "npm"} <= set(npm.get("labels", [])), repr(npm.get("labels")))
check(
    "npm: has an all-npm group that takes every dependency",
    npm.get("groups", {}).get("all-npm", {}).get("patterns") == ["*"],
    repr(npm.get("groups")),
)

# One shape: the npm block matches the Seed's other ecosystems wherever they agree on a setting.
for key in ("schedule", "open-pull-requests-limit", "commit-message", "cooldown"):
    others = [u.get(key) for eco, u in updates.items() if eco != "npm"]
    check(f"npm: {key} matches the other ecosystems' ({len(others)} blocks)", all(npm.get(key) == o for o in others), f"npm {npm.get(key)!r}; others {others!r}")

# The comment on the cooldown, as in the other blocks, sits right above the key.
lines = text.splitlines()
start = next((i for i, l in enumerate(lines) if l.strip() == '- package-ecosystem: "npm"'), None)
check("npm: the block is written with a quoted package-ecosystem like the others", start is not None)
if start is not None:
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("  - package-ecosystem") or lines[i].startswith("  # Maintain")), len(lines))
    block = lines[start:end]
    cooldown_at = next((i for i, l in enumerate(block) if l.strip() == "cooldown:"), None)
    comment = []
    if cooldown_at is not None:
        for l in reversed(block[:cooldown_at]):
            if not l.strip().startswith("#"):
                break
            comment.insert(0, l.strip().lstrip("#").strip())
    check("npm: a comment above the cooldown says why (a week; caught upstream first)", bool(comment) and "week" in " ".join(comment) and "upstream" in " ".join(comment), repr(comment))

# The header no longer sends a pnpm project off to write the npm block itself.
header = text.split("---", 1)[0]
check("the header no longer suggests adding npm by hand", "such as npm" not in " ".join(header.split()), header)
header_text = " ".join(header.split())
check("the header says a repo without a root package.json drops the npm block", "package.json" in header_text and "drops the block" in header_text, header)
check("the header says the npm block covers pnpm", "covers pnpm" in header_text, header)
labels_path = sys.argv[1].replace("template/seed/.github/dependabot.yml", "github/labels.json")
labels = [l["name"] for l in json.load(open(labels_path))]

# Dependabot doesn't create labels, so every label in every ecosystem block must be in labels.json.
for eco, u in updates.items():
    missing = sorted(set(u.get("labels", [])) - set(labels))
    check(f"{eco}: labels.json creates every label the {eco} block uses", not missing, f"missing from labels.json: {missing}")
check("labels.json creates nuget and dotnet-sdk", {"nuget", "dotnet-sdk"} <= set(labels), repr(labels))

# The Labels row of references/github-settings.md lists every label in labels.json.
doc_path = sys.argv[1].replace("template/seed/.github/dependabot.yml", "references/github-settings.md")
row = next((l for l in open(doc_path).read().splitlines() if l.startswith("| Labels |")), "")
undocumented = sorted(n for n in labels if f"`{n}`" not in row)
check("github-settings.md's Labels row lists every label in labels.json", bool(row) and not undocumented, f"not in the row: {undocumented}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
PY
