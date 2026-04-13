---
name: build-repair
confidence: high
description: >
  Iterative build repair process for the {ProjectName} .NET solution.
  Run this before any push or when build/tests are broken.
  The authoritative prompt is .github/prompts/build-repair.prompt.md.
---

## Build Repair Skill

### Authoritative Source

The full build repair process is defined in:

> **`.github/prompts/build-repair.prompt.md`**

Always follow that prompt. This skill provides supplementary context.

### Quick Reference

1. `dotnet restore`
2. `dotnet build --no-restore` — must show **0 Error(s), 0 Warning(s)**
3. `dotnet test --configuration Release` — must show **Failed: 0**
4. Fix any error/warning/failure, rebuild/retest until clean
5. Document in `docs/build-log.txt`

### Project-Specific Notes

- **Solution file:** `{SolutionFile}` (in repo root)
- **Test projects:** `tests/Unit.Tests`, `tests/Integration.Tests`, `tests/Architecture.Tests`, `tests/Web.Tests.Bunit`
- **Integration tests require Docker** — TestContainers spins up MongoDB. Ensure Docker is running.
- **Zero warning tolerance** — treat warnings as errors. Fix before pushing.
- **NuGet:** all versions in `Directory.Packages.props`. If a restore fails with version conflict, check there first.

### Common Failures and Fixes

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| `MSB4019` on Linux CI | `%USERPROFILE%` path in NuGet.config | Remove `<config>` block from NuGet.config |
| Port conflict in integration tests | Missing `[Collection("Integration")]` | Add attribute to all integration test classes |
| `{Entity}Dto.Empty` equality failure | `Empty` calls `DateTime.UtcNow` each time | Assert individual fields, not whole record |
| Trailing `_` in slug tests | `GenerateSlug` intentional behavior | Update expected value to include `_` |
