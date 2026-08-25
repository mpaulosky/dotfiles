---
name: merged-pr-guard
description: "Guardrail to avoid committing to merged squad branches by checking merged PR state and switching to dev before committing. Use this skill to apply consistent, proven patterns and reduce regressions across related tasks. WHEN: \"merged-pr-guard\", \"run merged-pr-guard\", \"merged-pr-guard skill\"."
confidence: high
---

# Skill: Merged-PR Branch Guard

## Problem

When a branch has already been merged, commits should not be left stranded there.

## Solution

Before committing on a squad branch, verify whether the related PR is already merged. If it is, switch to `dev` and continue there.
