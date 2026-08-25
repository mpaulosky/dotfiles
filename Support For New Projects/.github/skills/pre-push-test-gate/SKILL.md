---
name: pre-push-test-gate
description: "Before any push, the agent must run the full local test suite and ensure zero failures. This skill gates pushes to prevent broken builds and maintain code quality. Use this skill to apply consistent, proven patterns and reduce regressions across related tasks. WHEN: \"pre-push-test-gate\", \"run pre-push-test-gate\", \"pre-push-test-gate skill\"."
confidence: high
---

## Steps

- Run `dotnet test Articles.slnx --nologo` and ensure all tests pass with zero failures before push.
- If any test fails, fix the issue before pushing.
