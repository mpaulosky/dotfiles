#!/usr/bin/env bash
# Tests for the Seed .sandcastle/Dockerfile's optional Playwright step: INSTALL_PLAYWRIGHT_DEPS (default false, like
# INSTALL_DOTNET) installs Chromium's system libraries, as root, and nothing else (the test fixture installs the
# browser at run time), and references/sandcastle.md documents it.
# Usage: tests/seed-dockerfile.test.sh
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -I - "$SKILL_DIR/template/seed/.sandcastle/Dockerfile" "$SKILL_DIR/references/sandcastle.md" <<'PY'
import re
import sys

dockerfile = open(sys.argv[1]).read().splitlines()
doc = open(sys.argv[2]).read()

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"ok   - {name}")
    else:
        failed += 1
        print(f"FAIL - {name}" + (f"\n       | {detail}" if detail else ""))


def index(pattern, lines=dockerfile):
    return next((i for i, l in enumerate(lines) if re.search(pattern, l)), None)


# The instruction starting at line i, with its backslash continuations joined.
def instruction(i):
    parts = []
    while i < len(dockerfile):
        parts.append(dockerfile[i].rstrip())
        if not parts[-1].endswith("\\"):
            break
        i += 1
    return "\n".join(parts)


arg_at = index(r"^ARG INSTALL_PLAYWRIGHT_DEPS=false\s*$")
check("INSTALL_PLAYWRIGHT_DEPS is an ARG that defaults to false", arg_at is not None,
      "no `ARG INSTALL_PLAYWRIGHT_DEPS=false` line")
check("INSTALL_PLAYWRIGHT_DEPS is declared once", sum(bool(re.match(r"ARG INSTALL_PLAYWRIGHT_DEPS\b", l)) for l in dockerfile) == 1)
check("INSTALL_DOTNET still defaults to true", index(r"^ARG INSTALL_DOTNET=true\s*$") is not None)

version_at = index(r"^ARG PLAYWRIGHT_VERSION=\S+")
check("PLAYWRIGHT_VERSION is an ARG with a default", version_at is not None, "no `ARG PLAYWRIGHT_VERSION=<version>` line")

run_at = index(r'INSTALL_PLAYWRIGHT_DEPS"? = true') if arg_at is not None else None
if run_at is not None:
    while run_at > 0 and not dockerfile[run_at].startswith("RUN"):
        run_at -= 1
step = instruction(run_at) if run_at is not None else ""
check("a RUN step is guarded by INSTALL_PLAYWRIGHT_DEPS = true, as INSTALL_DOTNET's is", run_at is not None and step.startswith("RUN if [ "), step)
check("the step installs Chromium's libraries with pnpm dlx playwright@${PLAYWRIGHT_VERSION} install-deps chromium",
      "pnpm dlx playwright@${PLAYWRIGHT_VERSION} install-deps chromium" in step, step)
check("the step doesn't install the browser itself (the test fixture does, so a Playwright bump needs no image change)",
      bool(step) and not re.search(r"playwright(@\S+)?\s+install(?!-deps)\b", step) and not re.search(r"\binstall\s+chromium", step), step)
check("the step clears root's caches (apt lists and the pnpm and dlx caches under /root)",
      "/var/lib/apt/lists" in step and re.search(r"rm -rf[^\n]*/root/", step) is not None, step)

# install-deps needs root and pnpm, so the step comes after corepack enables pnpm and before USER drops root.
corepack_at = index(r"^RUN corepack enable pnpm")
user_at = index(r"^USER ")
check("the step runs after pnpm is enabled and before USER drops root",
      None not in (run_at, corepack_at, user_at) and corepack_at < run_at < user_at, f"corepack {corepack_at}, step {run_at}, USER {user_at}")
check("PLAYWRIGHT_VERSION is declared before the step uses it", None not in (version_at, run_at) and version_at < run_at)

# A comment right above the ARG (or the block starting with it) says why only the libraries.
comment = []
if arg_at is not None:
    start = arg_at
    while start > 0 and dockerfile[start - 1].startswith("#"):
        start -= 1
    comment = [l.lstrip("#").strip() for l in dockerfile[start:arg_at]]
words = " ".join(comment).lower()
check("a comment above the ARG says why only the libraries are installed (the browser is the fixture's, at run time)",
      "librar" in words and "browser" in words and "run time" in words, repr(comment))

# The docs.
check("sandcastle.md names INSTALL_PLAYWRIGHT_DEPS", "INSTALL_PLAYWRIGHT_DEPS" in doc)
row = next((l for l in doc.splitlines() if l.startswith("| `.sandcastle/Dockerfile` |")), "")
check("the Seed files table's Dockerfile row names INSTALL_PLAYWRIGHT_DEPS", "INSTALL_PLAYWRIGHT_DEPS" in row, row)
paragraph = next((p for p in re.split(r"\n\s*\n", doc) if "INSTALL_PLAYWRIGHT_DEPS" in p and "install-deps" in p), "")
flat = " ".join(paragraph.split())
check("sandcastle.md has a paragraph saying what INSTALL_PLAYWRIGHT_DEPS runs (install-deps chromium)", bool(paragraph))
check("that paragraph names PLAYWRIGHT_VERSION", "PLAYWRIGHT_VERSION" in flat, flat)
check("that paragraph says it's off by default", re.search(r"default|off", flat) is not None and "false" in flat, flat)
check("that paragraph says the browser itself is left to the test fixture", "browser" in flat and "fixture" in flat, flat)
check("that paragraph says a repo with Playwright in its Directory.Packages.props sets it", "Directory.Packages.props" in flat or "Microsoft.Playwright" in flat, flat)
check("sandcastle.md tells an existing repo (a Seed file is written once) to add the step by hand",
      re.search(r"existing repo[^\n]*INSTALL_PLAYWRIGHT_DEPS|INSTALL_PLAYWRIGHT_DEPS[^\n]*existing repo", " ".join(doc.split())) is not None
      or re.search(r"(?s)INSTALL_PLAYWRIGHT_DEPS.{0,600}by hand", doc) is not None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
PY
