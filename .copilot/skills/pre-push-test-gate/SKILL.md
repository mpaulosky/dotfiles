---
name: "pre-push-test-gate"
description: "Before any push, the agent must run the full local test suite and ensure zero failures. This skill gates pushes to prevent broken builds and maintain code quality."
---

## Steps

- Run `dotnet test tests/Unit.Tests` and ensure all tests pass with zero failures.
- Run `dotnet test tests/Blazor.Tests` and ensure all tests pass with zero failures.
- Run `dotnet test tests/Architecture.Tests` and ensure all tests pass with zero failures.
- If any test fails, fix the issue before pushing. CI must never be the first place test failures are discovered.
