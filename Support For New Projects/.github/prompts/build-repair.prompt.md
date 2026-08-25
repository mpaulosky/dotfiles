---
name: build-repair-prompt
description: Build and repair Prompt
model: Claude Sonnet 4.5 (copilot)
agent: Squad
---

# Copilot Build Prompt: Universal .NET Solution Build & Error Resolution

## Instructions

1. **Locate Solution File**

- Check for `*.slnx` file in the current directory.
- If found, continue to the next step.
- If not found, run `cd ..` and check again.
- Repeat until a `*.slnx` file is found.

2. **Restore Dependencies**

- Run `dotnet restore`.
- If restore fails, fix the project or tooling issue before continuing.

3. **Run Lint Gates Before Final Build**

- Run YAML lint against the repo and fix all findings before build completion.
- Run Markdown lint against the repo and fix all findings before build completion.
- If lint tooling is not installed, install the repo-supported tooling and then rerun the lint commands.
- The build-repair loop is not complete until both lint passes succeed with zero issues.

4. **Build Solution**

- Run `dotnet build <solution-file> --no-restore`.
- Capture all build output, including errors and warnings.
- If warnings are treated as errors by repo configuration or the project gate, fix them too.

5. **Run Solution Tests**

- Run `dotnet test <solution-file> --no-restore`.
- Use the solution-level `.slnx` file, not a project file, so the full repo test set executes.
- Do not add `--nologo` or `--logger` to `dotnet test` in this repository; the xUnit v3 / Microsoft.Testing.Platform runner rejects both flags.
- If tests fail, fix the root cause and rerun the solution test command until the suite passes.

6. **Error & Warning Resolution Loop**

- For each error or warning in the build output:
  - Identify the affected file and line number.
  - Research the warning/error code and message.
  - Apply the recommended fix to the codebase.
  - Re-run the relevant lint and build commands to verify the fix.
  - Repeat until the final build completes with zero errors and zero blocking warnings.
- Do not stop after the first fix. Continue until the repo passes the validation gate.

7. **Verification**

- Ensure the final build output shows `Build succeeded` and no warnings or errors.
- Ensure the solution test run completes with zero failed tests.
- Document every change made to resolve issues.

8. **Testing**

- Run the smallest relevant unit tests for the change set.
- If tests fail, identify and fix the issues in the codebase.
- Rebuild and retest until the relevant tests pass.
- Prefer the solution-level `dotnet test <solution-file>` command when validating the repo after a repair pass.

9. **Documentation**

- Create a `build-log.txt` file in the solution directory.
- Log the lint output, build output, error resolutions, and changes made.

## Success Requirement

This prompt must continue until all repository validation gates pass. It must never stop after a partial fix or after a subset of files appears clean. In practical terms, the session is not complete until:

- YAML lint succeeds with no findings.
- Markdown lint succeeds with no findings.
- `dotnet restore` succeeds.
- `dotnet build <solution-file> --no-restore` succeeds.
- `dotnet test <solution-file> --no-restore` succeeds with zero failed tests.
- Relevant tests pass.
- The final result is a clean, successful build path without unresolved errors or required lint issues.

## Notes

- These steps apply to any .NET solution (`*.slnx`).
- Use PowerShell or the default shell for commands.
- Always re-run lint and build after each fix to confirm resolution.
- If the issue is repository configuration rather than code, fix the config or workflow in the smallest safe way that preserves project intent.

---

**Use this prompt to automate building, linting, testing, and repairing any .NET solution until the repo is fully green and the build succeeds without leaving unresolved lint or build issues.**
