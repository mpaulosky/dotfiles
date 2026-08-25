---
name: build-repair
description: "Iterative build repair process for the IssueManager .NET solution. Run this before any push or when build is broken. The authoritative prompt is .github/prompts/build-repair.prompt.md. Use this skill to apply consistent, proven patterns and reduce regressions across related tasks. WHEN: \"build-repair\", \"run build-repair\", \"build-repair skill\"."
confidence: high
---

## Build Repair Skill

1. Reproduce the failure locally.
2. Read the failing output and isolate the root cause.
3. Apply the minimal fix.
4. Re-run the relevant build/test commands.
5. Repeat until the failure is resolved.
