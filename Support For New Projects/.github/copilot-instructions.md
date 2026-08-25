# Articles Copilot Instructions

## Project context

- This repository is a .NET 10 application and workflow-standard distribution repository.
- Treat repository configuration as authoritative. Check `Directory.Build.props`, `global.json`, `Directory.Packages.props`, and the relevant project file before making framework or package assumptions.
- The main implementation is under `src/`; tests are under `tests/`; repository automation and agent guidance are under `.github/`.
- Review `ARCHITECTURE.md` and the relevant documentation under `docs/` when a change crosses project or policy boundaries.

## Working agreements

- Start from the smallest concrete code path that owns the requested behavior.
- Keep changes focused. Preserve existing user changes and do not reset, clean, checkout, amend, or overwrite unrelated work.
- Inspect `git status --short` and the relevant staged and unstaged diffs before editing when the worktree may be dirty.
- Do not commit, push, or change repository history unless the user explicitly asks.
- Never add secrets, credentials, connection strings, or tokens to source, configuration, tests, or documentation. Use configuration and environment variables instead.
- Flag user input that is used without validation or sanitization.
- Prefer existing abstractions, project patterns, and shared configuration over new infrastructure.
- Keep public APIs and class members documented with XML `/// <summary>` comments.

## .NET and C#

- Target .NET 10 and use the repository's configured latest C# language version.
- Nullable reference types, analyzers, code style enforcement, and warnings-as-errors are enabled by `Directory.Build.props`.
- Use central package management through `Directory.Packages.props`; make the smallest justified package change.
- Follow the repository `.editorconfig`, including tabs for C# and Razor files and two-space Markdown indentation.
- Avoid empty catch blocks and `Thread.Sleep` in production code.
- Keep exception handling explicit: log meaningful context and rethrow or handle the error deliberately.

## Blazor and UI

- Follow the Blazor-specific guidance in `.github/instructions/blazor.instructions.md` for Razor components, code-behind, and component CSS.
- Use Tailwind CSS v4 and the existing CSS-first styles under `src/Web/Styles/` for UI changes.
- Reuse existing components, tokens, and accessibility patterns before introducing new UI primitives.
- Keep user-facing states complete, including loading, empty, validation, error, and authorization states where applicable.

## Data and backend

- Follow the existing domain, CQRS, repository, and dependency-injection boundaries instead of bypassing them from UI code.
- Keep MongoDB access behind the established infrastructure abstractions and compose filters with typed driver APIs.
- Treat schema or persistence changes as compatibility-sensitive; include focused tests and document migration or rollout implications.

## Testing and validation

- Use xUnit v3 with FluentAssertions and NSubstitute where appropriate, following nearby test conventions.
- Use TDD for new behavior and bug fixes when practical. Test methods should retain the repository's `// Arrange`, `// Act`, and `// Assert` markers.
- Follow the repository's lint rules for test method naming and organization.
- Never change the object under test code to make a test pass. Instead, fix the implementation or the test to reflect the intended behavior.
- Run the narrowest relevant test or validation command during iteration. Typical commands are:

  ```bash
  dotnet test Articles.slnx
  dotnet build Articles.slnx --configuration Release
  npx --yes markdownlint-cli2 "**/*.md"
  ```

- For a focused .NET test, use `dotnet test --filter FullyQualifiedName~{Namespace}.{ClassName}.{MethodName}` or filter to the test class.
- Before a push or PR-ready handoff, run the repository's full required validation. The local pre-push hook also checks branch naming, changed YAML/Markdown files, and every `.slnx` solution it discovers.
- Report exactly which validation commands ran and whether they passed. Do not claim tests or builds that were not run.

## Documentation and automation

- Use the Markdown guidance in `.github/instructions/markdown.instructions.md` for documentation changes.
- Keep workflow YAML compatible with the repository's lint rules and preserve existing security permissions and triggers unless the task requires a change.
- Update documentation when behavior, setup, validation, or public workflow changes.
- Do not modify generated release-review sections manually unless the task specifically concerns that generator output.

## Response expectations

- Lead implementation responses with a one-sentence decision rationale.
- Summarize the files changed, behavior changed, and validation performed.
- Mention relevant limitations, failed checks, or remaining risks plainly.
- If the requested scope is ambiguous or a change could affect unrelated user work, ask before staging or committing.
