# Pre-Push Process Playbook

**Owner:** Boromir (DevOps) + Aragorn (Lead)
**Ref:** `.github/hooks/pre-push`, `CONTRIBUTING.md`
**Last Updated:** 2026-04-13

---

## Overview

The pre-push hook (`.github/hooks/pre-push`) enforces 5 gates that mirror CI. This playbook documents what agents must do before pushing and how to troubleshoot failures.

## Pre-Flight Checklist (Before `git push`)

Before running `git push`, verify:

1. **You are on a `squad/*` branch** — Gate 0 blocks pushes to `main` and `dev`

   ```bash
   git symbolic-ref --short HEAD
   # Must show: squad/{issue}-{slug}
   ```

2. **No untracked `.razor` or `.cs` files** — Gate 1 blocks these (invisible to CI)

   ```bash
   git ls-files --others --exclude-standard -- '*.razor' '*.cs'
   # Must be empty. If files appear, stage them:
   git add <files>
   ```

3. **Release build passes locally** — Gate 2 runs Release (not Debug)

   ```bash
   dotnet build {SolutionFile} --configuration Release
   ```

   If build fails, run `.github/prompts/build-repair.prompt.md` to fix.

4. **Unit tests pass** — Gate 3 runs your test projects

   ```bash
   # Example test projects — adjust to match your solution:
   dotnet test tests/Architecture.Tests/Architecture.Tests.csproj --configuration Release --no-build
   dotnet test tests/Domain.Tests/Domain.Tests.csproj --configuration Release --no-build
   dotnet test tests/Web.Tests.Bunit/Web.Tests.Bunit.csproj --configuration Release --no-build
   # dotnet test tests/{Feature}.Tests/{Feature}.Tests.csproj --configuration Release --no-build
   ```

5. **Docker is running** — Gate 4 requires Docker for integration tests

   ```bash
   docker info &>/dev/null && echo "Docker OK" || echo "Docker NOT running"
   ```

## The 5 Gates (What the Hook Runs)

When you execute `git push`, the hook runs automatically:

| Gate  | What                   | Blocks Push If                                                           |
| ----- | ---------------------- | ------------------------------------------------------------------------ |
| **0** | Branch protection      | Current branch is `main` or `dev`                                        |
| **1** | Untracked source files | `.razor`/`.cs` files not staged (prompts y/N)                            |
| **2** | Release build          | `dotnet build --configuration Release` fails (3 attempts)                   |
| **3** | Unit/Arch/bUnit tests  | Any unit/architecture test projects fail (3 attempts)                        |
| **4** | Integration tests      | Any integration test projects fail; Docker not running (3 attempts)           |

### Gate 3 — Test Projects (Unit)

```text
# Example — adjust to your solution's test projects:
tests/Architecture.Tests/Architecture.Tests.csproj
tests/Domain.Tests/Domain.Tests.csproj
tests/Web.Tests.Bunit/Web.Tests.Bunit.csproj
tests/{Feature}.Tests/{Feature}.Tests.csproj
```

### Gate 4 — Integration Test Projects (Docker Required)

```text
# Example — adjust to your solution's integration test projects:
tests/{Feature}.Tests.Integration/{Feature}.Tests.Integration.csproj
tests/AppHost.Tests/AppHost.Tests.csproj
```

These use Testcontainers and Aspire DCP. Docker daemon MUST be running.

## Retry Behavior

The hook allows **3 attempts** for Gates 2, 3, and 4. Between attempts:

- The hook pauses and prompts "Fix the errors and press Enter to retry, or Ctrl+C to abort"
- Fix the failing code, then press Enter
- The gate re-runs from scratch

## Troubleshooting

### Build Failure (Gate 2)

| Symptom                  | Fix                                                   |
| ------------------------ | ----------------------------------------------------- |
| Warning treated as error | Fix the warning — `TreatWarningsAsErrors=true` is set |
| Missing file reference   | Stage all new `.razor`/`.cs` files (Gate 1 issue)     |
| NuGet restore failure    | Run `dotnet restore` manually first                   |

**Escalation:** Run `.github/prompts/build-repair.prompt.md` for automated fix.

### Test Failure (Gate 3)

| Symptom                   | Fix                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Architecture test failure | Check naming conventions (commands → `Command`, queries → `Query`, handlers → `Handler`, validators → `Validator`) |
| bUnit test failure        | Verify Blazor component rendering; check `Render<T>()` not `RenderComponent<T>()` (bUnit 2.x)                      |
| DateTime equality failure | Assert individual fields, not whole-record equality (UtcNow varies between calls)                                  |

### Integration Test Failure (Gate 4)

| Symptom                   | Fix                                                             |
| ------------------------- | --------------------------------------------------------------- |
| Docker not running        | Start Docker Desktop or `sudo systemctl start docker`           |
| Container startup timeout | Increase Docker resources; check `mongo:7.0` image is pulled    |
| Connection string error   | Set `MONGODB_CONNECTION_STRING` env var if custom config needed |

### Hook Not Installed

The hook must be at `.git/hooks/pre-push`. The repo provides the hook at `.github/hooks/pre-push`. Install:

```bash
cp .github/hooks/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

## Anti-Patterns

- ❌ **Bypassing the hook** with `git push --no-verify` — CI will catch it, wasting time
- ❌ **Running Debug build only** — CI uses Release; Debug hides missing files
- ❌ **Pushing without Docker** — Gate 4 will block; start Docker first
- ❌ **Ignoring untracked files** — They're invisible to CI and will cause failures
- ❌ **Committing to `main` directly** — Gate 0 blocks this; use `squad/{issue}-{slug}` branches

## Related Documents

- **Hook source:** `.github/hooks/pre-push`
- **Build repair:** `.github/prompts/build-repair.prompt.md`
- **Contributing guide:** `CONTRIBUTING.md` (Pre-Push Gates section)
- **Ceremonies:** `.squad/ceremonies.md` (Build Repair Check, Standard Task Workflow Phase 3)
- **Skill:** `.copilot/skills/pre-push-test-gate/SKILL.md`

---

**Use this playbook every time you push.** The hook enforces these gates automatically, but understanding them helps you fix failures faster.
