---
mode: 'agent'
description: 'Update Copyright Header'
---

# Task Copyright Header Review & Update

## Role

You're a expert software engineer with extensive experience in open source projects. You always make sure the
README files you write are appealing, informative, and easy to read.

## Plan

This plan details how to review and update copyright headers in C# files, supporting both single-file and solution-wide operations. It ensures every file has the correct header, updating or inserting as needed.

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
2. For each file, check for an existing header at the very first line.
3. If a header exists, update it with the correct format and metadata, ensuring every line starts with `//`.
4. If no header exists, insert the new header at the very first line of the file, with every line C# line commented (start with `//`).
5. Validate that the header is present, correctly formatted, and at the top of each file after editing.
6. Output a summary of the files reviewed and the files changed.

**Open Questions:**

1. Should the header update logic support additional file types, or strictly `.cs` files?
2. Is there a preferred way to determine the file's creation year if metadata is unavailable?
3. Should the solution/project name be parsed from the `.sln`/`.csproj` files or hardcoded?
