---
applyTo: "**"
---

# .NET Project Instructions

## Technology Stack (Required)

### Framework and Language Versions

- Policy target is **.NET 10** and **C# 14**.
- Source of truth for versioning is, in order:
  1. `Directory.Build.props`
  2. `global.json` (if present)
  3. Project files for approved exceptions
- If documentation and repository configuration differ, repository configuration is authoritative.
- Leverage latest language features when appropriate.
- All public API and class members require XML doc comments (`/// <summary>`).

---

## Style

- **Use .editorconfig:** `true`
- **Use Tailwind CSS (UI files only):** `true` (v4, CSS-first config — see `src/Web/Styles/app.tailwind.css`)

## Testing

- Use xUnit.v3 with FluentAssertions and NSubstitute where appropriate and interfaces exist.
- Use TDD (Test-Driven Development) approach for new features and bug fixes.
- Every test method must have `// Arrange`, `// Act`, `// Assert` comment markers.
- During iteration, run the smallest targeted tests that cover the change.
- Use `dotnet test --filter FullyQualifiedName~{Namespace}.{ClassName}.{MethodName}` to run a single test method.
- Use `dotnet test --filter FullyQualifiedName~{Namespace}.{ClassName}` to run all tests in a class.
- Before push or PR-ready handoff, run all enforced repository validation gates (including required full test runs).

## Security

- Always flag any place where user input is used without validation or sanitization.

## Response Style

- Lead each code response with a one-sentence decision rationale.
- If there is a simpler alternative approach, mention it after the primary answer.

## Guardrails

Copilot must follow these guardrails:

- **NuGet changes** — new package additions/updates may be made autonomously when required to complete the task; keep changes minimal and include explicit rationale in the final summary/PR text.
- **No secrets in code** — never hardcode connection strings, API keys, or passwords. Use `IConfiguration` or environment variables.
- **No empty catch blocks** — `catch (Exception e) {}` is never acceptable. At minimum, log and re-throw.
- **No `Thread.Sleep` in production code** — flag as a concern if encountered.
- **Schema changes** — database/schema changes may be made autonomously when required; keep scope minimal and include explicit rationale in the final summary/PR text.

## Verification Checklist

Before presenting any generated code, Copilot should confirm:

- [ ] No obvious syntax errors
- [ ] Style guide followed
- [ ] No guardrails violated
- [ ] At least one test covers the change
- [ ] All tests must pass before code is presented
