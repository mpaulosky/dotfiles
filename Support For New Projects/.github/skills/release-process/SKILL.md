---
name: release-process
description: "Step-by-step release checklist for Squad — prevents v0.8.22-style disasters. Use this skill to apply consistent, proven patterns and reduce regressions across related tasks. WHEN: \"release-process\", \"run release-process\", \"release-process skill\"."
domain: release-management
confidence: high
source: team-decision
---

> ⚠️ **Squad CLI Only** — This skill documents the npm release runbook for Squad CLI. It is NOT applicable to the workflow-standard repository.

## Context

This is the release runbook for Squad. Follow it before any release.

## Pre-Release Validation

1. Validate version semantics.
2. Verify authentication tokens.
3. Ensure the release branch is correct and clean.
4. Run the normal validation suite.
5. Create the release only after checks pass.
