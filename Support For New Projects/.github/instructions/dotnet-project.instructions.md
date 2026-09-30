---
applyTo: "**"
---

# .NET Project Instructions

`CLAUDE.md` at the repository root describes the project and wins where this file disagrees.

## Versions

- Target **.NET 10** and **C# 14**. Use current language features where they make the code clearer.
- The sources of truth are, in order: `global.json` (the pinned SDK), the project files (`TargetFramework`), and
  `Directory.Packages.props` (package versions). When documentation and repository configuration differ, the
  configuration wins.

## Style

- Follow `.editorconfig`: tabs, file-scoped namespaces, explicit types rather than `var`, `System` usings first.
- Start every `.cs` file with the repository's copyright header block, filling in the file and project names.
- Give public types and members XML doc comments (`/// <summary>`).

## Testing

- Use xUnit with FluentAssertions, and NSubstitute or Moq for interfaces, matching the test project you're in.
- Write the failing test first for new features and bug fixes.
- Every test method has `// Arrange`, `// Act` and `// Assert` markers.
- While iterating, run the smallest set of tests that covers the change:
  `dotnet test tests/{Project} --filter "FullyQualifiedName~{ClassName}"`.
- Before pushing, run the full gate: `scripts/gate.sh`, which the pre-push hook also runs.

## Security

- Flag any place where user input reaches MongoDB, a redirect, or markup without validation.
- Never hardcode connection strings, API keys or passwords. Read them through `IConfiguration`.

## Guardrails

- **Packages:** add or update a NuGet package only when the task needs it, in `Directory.Packages.props`, and say why in
  the PR description.
- **Warnings:** the build treats warnings as errors. Fix a warning rather than suppressing it; a `NoWarn` needs a comment
  saying why and when it goes away.
- **No empty catch blocks.** At minimum, log and rethrow.
- **No `Thread.Sleep`** in production code.
- **Layering:** CoreBusiness references no other project. In the UI, only `Extensions/` (the composition root) and
  `Helpers/MongoHealthCheck.cs` (the MongoDB health probe) use `IssueTracker.PlugIns`; pages and components go through
  services. `Architecture.Tests` only checks part of this.

## Before handing off

- The build is clean with `-warnaserror`.
- A test covers the change, and the affected test projects pass.
- No guardrail above is broken.
