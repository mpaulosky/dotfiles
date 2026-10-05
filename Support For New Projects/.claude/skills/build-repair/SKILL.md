---
name: build-repair
description: Restore, build, and test loop that fixes a .NET solution until it is green, with no lint, staging, or commit. Use when the user asks to fix the build, get the tests passing, or run build-repair.
---

# Build Repair

The narrow repair loop: restore, build, test, fix, repeat until **green**.
Leave the worktree unstaged and uncommitted. For the full review, lint and
commit workflow, use the `review-changes` skill instead.

**Green** means all of these hold on the same final state:

- `dotnet restore` succeeds.
- The full solution build shows zero errors, and every warning is fixed or
  explicitly triaged.
- Every test project reports its tests passed, with zero failures.

## Workflow

1. **Locate the solution**: the `.sln` or `.slnx` at the repo root, or the
   nearest one above the current directory.
2. **Restore** with `dotnet restore`. Fix any restore failure (project or
   tooling) before building.
3. **Build loop.** Run
   `dotnet build <solution> --no-restore --configuration Release`, the
   configuration the tests run in, so the build you clean is the one they
   use. For each error or warning: go to the file and line, understand the
   rule, apply the minimal fix, rebuild. Done when the build output is clean or every
   remaining warning is triaged. Before adding a suppression, read the
   existing policy and its reasons in `Directory.Build.props`
   (`TreatWarningsAsErrors`, `CodeAnalysisTreatWarningsAsErrors`, `NoWarn`)
   and `.editorconfig` (including any test-only sections), and follow it.
4. **Test loop**, once the build is clean. Find the test projects in the
   solution (often under `tests/`) and run each one separately: the
   Microsoft.Testing.Platform runner can report `Zero tests ran` at the
   solution level on a healthy suite.

   ```bash
   dotnet test <test project>.csproj --configuration Release
   ```

   Pass only the arguments above: the xUnit v3 / Microsoft.Testing.Platform
   runner rejects VSTest options such as `--logger` and `--nologo`. If a
   project reports a runner-level error rather than a pass/fail count, run
   its assembly directly:
   `dotnet <project dir>/bin/Release/<tfm>/<Project>.dll`, reading `<tfm>`
   from the project's `TargetFramework`.

   For each failing test, find the root cause and fix the code under test;
   change the test only when the test itself is wrong. Rerun that project.
   Done when every test project passes.
5. **Re-verify.** If any test fix touched non-test code, return to step 3,
   and finish on a full build plus a full test run of the same state.
6. **Report**: what was broken, each fix with `file:line` references, every
   warning you triaged rather than fixed and why, and the final build and
   test results.
