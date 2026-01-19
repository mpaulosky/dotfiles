# Copilot Instructions

**Last updated:** June 12, 2025

These instructions define the required coding, architecture, and project rules for all .NET code in this repository.
They are based on the actual practices and conventions in the TailwindBlogApp solution. For more details,
see [CONTRIBUTING.md](../docs/CONTRIBUTING.md).

---

## Technology Stack (Required)

### Framework and Language Versions

- **.NET Version:** `10.0` (latest stable)
    - All projects must target .NET 10
    - Use the latest stable runtime and SDK
- **C# Language Version:** `14.0` (latest stable)
    - Leverage latest language features when appropriate
    - Configure via `<LangVersion>14.0</LangVersion>` in project files or Directory.Build.props
- **API Documentation:** `Scalar` with `OpenAPI 3.0+`
    - Use Scalar for interactive API documentation
    - All REST APIs must expose OpenAPI specifications
    - See Documentation section for additional requirements

### Platform Requirements

- **Minimum SDK:** `.NET 10 SDK`
- **Target Framework:** `net10.0`
- **Runtime:** `.NET 10 Runtime` (latest stable patch version)

---

## C# (Required)

### Style

- **Use .editorconfig:** `true`
- **Use Tailwindcss:** `true`
- **Preferred Modifier Order:** `public`, `private`, `protected`, `internal`, `static`, `readonly`, `const`
    - _Example:_
      ```csharp
      public static readonly int MY_CONST = 42;
      ```
- **Use Explicit Type:** `true` (except where `var` improves clarity)
- **Use Var:** `true` (when the type is obvious)
- **Prefer Null Check:**
    - Use `is null`: `true`
    - Use `is not null`: `true`
- **Prefer Primary Constructors:** `false`
- **Prefer Records:** `true`
- **Prefer Minimal APIs:** `true`
- **Prefer File Scoped Namespaces:** `true`
- **Use Global Usings:** `true` (see `GlobalUsings.cs` in each project)
- **Use Nullable Reference Types:** `true`
- **Use Pattern Matching:** `true`
- **Max Line Length:** `120`
- **Indent Style:** `tab`
- **Indent Size:** `2`
- **End of Line:** `lf`
- **Trim Trailing Whitespace:** `true`
- **Insert Final Newline:** `true`
- **Charset:** `utf-8`

### Naming

- **Interface Prefix:** `I` (e.g., `IService`)
- **Async Suffix:** `Async` (e.g., `GetDataAsync`)
- **Private Field Prefix:** `_` (e.g., `_myField`)
- **Constant Case:** `UPPER_CASE` (e.g., `MAX_SIZE`)
- **Component Suffix:** `Component` (for Blazor components)
- **Blazor Page Suffix:** `Page` (for Blazor pages)

### Security (Required)

- **Require HTTPS:** `true` (see `Web/Program.cs`)
- **Require Authentication:** `true` (Auth0 integration, see `README.md`)
- **Require Authorization:** `true`
- **Use Antiforgery Tokens:** `true` (see `Web/Program.cs`)
- **Use CORS:** `true`
- **Use Secure Headers:** `true`

### Architecture (Required)

- **Enforce Aspire:** `true` (see `AppHost/`, `README.md`)
- **Enforce SOLID:** `true` (see `Domain/`, `ServiceDefaults/`)
- **Enforce Dependency Injection:** `true` (see `Web/Program.cs`, `ServiceDefaults/`)
- **Enforce Async/Await:** `true` (async methods and tests)
- **Enforce Strongly Typed Config:** `true`
- **Enforce CQRS:** `true` (see `Domain/Abstractions/`, `MediatR` usage)
- **Enforce Unit Tests:** `true` (see `Tests/`)
- **Enforce Integration Tests:** `true` (see `Tests/`)
- **Enforce Architecture Tests:** `true` (see `Tests/Architecture.Tests/`)
- **Enforce Vertical Slice Architecture:** `true`
- **Centralize NuGet Package Versions:** `true` (all package versions must be managed in `Directory.Packages.props` at
  the repo root; do not specify versions in individual project files)

### Blazor (Required)

- **Enforce State Management:** `true` (see use of `@code` blocks and parameters)
- **Use Interactive Server Rendering:** `true` (see `Web/Program.cs`)
- **Use Stream Rendering:** `true`
- **Enforce Component Lifecycle:** `true` (see `OnInitialized`, `OnParametersSet` in components)
- **Use Cascading Parameters:** `true` (see shared layout/components)
- **Use Render Fragments:** `true` (see component parameters)
- **Use Virtualization:** `true` (see use of `Web.Virtualization`)
- **Use Error Boundaries:** `true` (see `MainLayout.razor` error UI)
- **Component Suffix:** `Component` (e.g., `FooterComponent`)
- **Page Suffix:** `Page` (e.g., `AboutPage`)

### Documentation (Required)

- **Require XML Docs:** `true` (see `<summary>` in test and code files)
- **Require Scalar:** `true` (Scalar is the required API documentation tool; use instead of Swagger UI)
- **Require OpenAPI:** `true` (OpenAPI 3.0+ specifications must be provided for all REST APIs)
- **Use Scalar for API Explorer:** `true` (interactive API documentation via Scalar, not Swagger UI)
- **Require Component Documentation:** `true` (see `<summary>` in Blazor tests)
- **Require README:** `true` (see `README.md`, `docs/README.md`)
- **Require CONTRIBUTING.md:** `true` (see `docs/CONTRIBUTING.md`)
- **Require LICENSE:** `true` (see `LICENSE`)
- **Require Code of Conduct:** `true` (see `CODE_OF_CONDUCT.md`)
- **Require File Copyright Headers:** `true`

### Logging (Required)

- **Require Structured Logging:** `true`
- **Require Health Checks:** `true`
- **Use OpenTelemetry:** `true`
- **Use Application Insights:** `true`

### Database (Required)

- **Use Entity Framework Core:** `true`
- **Use MongoDB:** `true` (see `Persistence.MongoDb/`)
- **Use MongoDB.Driver:** `true`
- **Use MongoDB.EntityFrameworkCore:** `true`
- **Prefer Async Operations:** `true`
- **Use TestContainers:** `true` (for Integration testing, see `Tests/`)
- **Use Change Tracking:** `true`
- **Use DbContext Pooling:** `true`
- **Use DbContext Factory:** `true`
- **Use In-Memory Database:** `false`

### Versioning (Required)

- **Require API Versioning:** `true`
- **Use Semantic Versioning:** `true`

### Caching (Required)

- **Require Caching Strategy:** `true`
- **Use Distributed Cache:** `true`
- **Use Output Caching:** `true` (see `Web/Program.cs`)

### Middleware (Required)

- **Require Cross-Cutting Concerns:** `true`
- **Use Exception Handling:** `true` (see `Web/Program.cs`)
- **Use Request Logging:** `true`

### Background Services (Required)

- **Require Background Service:** `true`

### Environment (Required)

- **Require Environment Config:** `true`
- **Use User Secrets:** `true`
- **Use Key Vault:** `true`

### Validation (Required)

- **Require Model Validation:** `true`
- **Use FluentValidation:** `true`

### Testing (Required)

- **Require Unit Tests:** `true` (see `Tests/`)
- **Require Integration Tests:** `true` (see `Tests/`)
- **Require Architecture Tests:** `true` (see `Tests/Architecture.Tests/`)
- **Use xUnit:** `true` (see `Tests/`)
- **Use FluentAssertions:** `true` (see `Tests/`)
- **Use NSubstitute:** `true`
- **Use bUnit:** `true` (see `Tests/Web.Tests.Bunit/`)
- **Use Playwright:** `true` (see `README.md`)

---

**Note:** These rules are enforced via `.editorconfig`, StyleCop, and other tooling where possible. For questions or
clarifications, see [CONTRIBUTING.md](../docs/CONTRIBUTING.md).