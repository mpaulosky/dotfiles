---
name: pre-push-test-gate
confidence: high
description: >
  Enforces build cleanliness and test passage before any git push.
  Delegates to the build-repair skill as the authoritative gate.
---

## Pre-Push Test Gate

### Why This Exists

Broken tests pushed directly to `main` without local verification cause CI failures.
This skill enforces a gate that prevents that from recurring.

### The Gate

Before any `git push`, an agent MUST run the **Build Repair Skill**:

> **See the build-repair skill or `.github/prompts/build-repair.prompt.md` if present.**

That prompt already defines the full gate:
1. Restore dependencies (`dotnet restore`)
2. Build the solution (`dotnet build --no-restore`) — zero errors, zero warnings
3. Fix any build errors before continuing
4. Run unit tests — all must pass
5. Fix test failures before continuing

Only push when the build-repair prompt reports **"Build succeeded"** with **zero warnings**
and **all tests pass**.

### Agent Checklist

Before any `git push`, an agent MUST:

- [ ] Execute the build-repair process fully
- [ ] Confirm final output: `Build succeeded. 0 Warning(s). 0 Error(s).`
- [ ] Run ALL test projects — confirm `Passed! Failed: 0` for every suite
- [ ] Only then execute `git push`

**⚠️ E2E tests (if present) are MANDATORY.** They must be run locally before every push,
even though they take longer. Docker must be running for integration/E2E tests.

Do NOT push if any test suite reports failures. Fix first.

### Hook (Local Enforcement)

The `.git/hooks/pre-push` hook enforces all gates locally.
Install once per clone — **Shell (Linux/macOS/Git Bash)**:

```bash
# Copy the full hook from the canonical source:
cp .git/hooks/pre-push .git/hooks/pre-push.bak 2>/dev/null || true
# The hook runs: build → unit tests → integration tests (including E2E)
# All gates must pass. Docker required for integration/E2E.
chmod +x .git/hooks/pre-push
```

**Gate summary (current hook):**
- Gate 0: Block direct push to `main`
- Gate 1: Warn on untracked `.razor`/`.cs` files
- Gate 2: Release build (0 warnings, 0 errors)
- Gate 3: Unit + bUnit + Architecture tests (`tests/{TestCategory}.Tests`, no Docker)
- Gate 4: Integration + E2E tests (Docker required)

**PowerShell (Windows):**
```powershell
@'
#!/usr/bin/env bash
set -euo pipefail
echo "🔎 pre-push: running build-repair gate…"
if dotnet test tests/ --configuration Release --verbosity quiet 2>&1; then
  echo "✅ Gate passed — push allowed."
else
  echo "❌ Gate FAILED. Run build-repair and fix before pushing."
  exit 1
fi
'@ | Set-Content -NoNewline .git/hooks/pre-push
```

> The hook is not committed — install on every fresh clone. The build-repair prompt
> is the authoritative process; the hook is a fast local tripwire.

### Failure Taxonomy (known patterns)

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| `DateTime` equality failure in `*.Empty` tests | `Empty` property calls `DateTime.UtcNow` each time — two calls produce different values | Assert individual fields, not whole-record equality |
| Unexpected trailing `_` in slug tests | `GenerateSlug` appends `_` when string ends with punctuation AND has internal punctuation | Verify actual output against implementation before asserting |
| Record equality fails on nested DTO | Nested DTO `Empty` also uses `UtcNow` — same root cause | Flatten assertions to field-level |
