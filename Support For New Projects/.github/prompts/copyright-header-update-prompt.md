---
mode: 'agent'
description: 'Update Copyright Header'
---

# Task Copyright Header Review & Update

## Role

You're a expert software engineer with extensive experience in open source projects. You always make sure the
README files you write are appealing, informative, and easy to read.

## Plan

This plan details how to review and update copyright headers in C# files, supporting both single-file and solution-wide operations.
It ensures every file has the correct header, preserves the original/earliest existing copyright year when normalizing an existing header,
and collapses duplicate header blocks into one canonical header.

**Header Example (as required):**

```text
//=======================================================
//Copyright (c) ${File.CreatedYear}. All rights reserved.
//File Name :     ${File.FileName}
//Company :       mpaulosky
//Author :        Matthew Paulosky
//Solution Name : ${File.SolutionName}
//Project Name :  ${File.ProjectName}
//=======================================================

```

**Steps:**

1. Identify all target `.cs` files, excluding those in `bin/` and `obj/` folders.
2. For each file, check for one or more existing header-like comment blocks at the very first line.
3. If one or more header blocks exist, treat the entire leading header region as a single unit: preserve the original/earliest copyright year already present,
   normalize the metadata to the canonical format, and replace the region with exactly one header block.
4. If no header exists, insert the new header at the very first line of the file, with every line C# line commented (start with `//`).
   When there is no existing year to preserve, use the file's creation year.
5. Validate that exactly one canonical header is present, correctly formatted, and at the top of each file after editing.
6. Output a summary of the files reviewed and the files changed.

**Open Questions:**

1. Should the header update logic support additional file types, or strictly `.cs` files?
2. If metadata is unavailable and no existing header year is present, is there a preferred fallback year source?
3. Should the solution/project name be parsed from the `.sln`/`.csproj` files or hardcoded?
