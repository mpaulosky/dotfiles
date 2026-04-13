# Product Requirements Document: Blazor Web App Starter Template

## 1. Executive Summary

### Problem Statement

Starting a new .NET Blazor Web App project from scratch requires manually assembling a consistent project structure, configuring Aspire orchestration, setting up authentication, wiring theming infrastructure, and establishing CI/CD pipelines. This repetitive setup takes significant effort and risks inconsistency between projects.

### Proposed Solution

A step-by-step scaffolding guide (and future automation target) that creates a production-ready Blazor Web App project template replicating the proven architecture of the IssueTrackerApp. The template uses Blazor Web App with Interactive Server rendering, consolidates MongoDB persistence into the Web project (eliminating separate persistence layers), retains the TailwindCSS v4 theming system with 4-color × 2-brightness themes, and includes Auth0 authentication, Redis distributed caching, Aspire orchestration, and full Squad CI/CD workflows.

### Success Criteria

- **SC-1**: A new project scaffolded from this PRD builds successfully with `dotnet build` on the first attempt (prerequisite: Node.js installed for TailwindCSS build).
- **SC-2**: All test projects (Architecture, Domain, Web unit, Web bUnit, Web integration) compile and their starter tests pass.
- **SC-3**: The Aspire AppHost launches locally with `dotnet run` and the Web project serves the home page with theme switching functional.
- **SC-4**: Architecture tests pass — specifically: Domain has no dependency on Web, `Web.Persistence.*`, `MongoDB.*`, or `Microsoft.AspNetCore.*` namespaces (namespace-based enforcement, not assembly-based).
- **SC-5**: Squad CI/CD workflows are present, valid YAML, and reference the correct project names, solution file, and test project paths for this template.

### Prerequisites

| Prerequisite  | Version                                                            | Purpose                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| .NET SDK      | Pinned in `global.json` (currently `10.0.100-preview.4.25258.110`) | Build and run all projects.                                                                                                                             |
| Node.js + npm | v20+ LTS                                                           | TailwindCSS v4 build (triggered by `dotnet build` via MSBuild targets).                                                                                 |
| Docker        | Latest                                                             | Required for MongoDB TestContainers in integration tests, Redis container in Aspire, and Playwright browser.                                            |
| Auth0 Tenant  | N/A                                                                | A configured Auth0 Web Application (callback URLs, logout URLs, allowed origins) and an Auth0 Machine-to-Machine application for Management API access. |
| Git           | 2.x+                                                               | Version control.                                                                                                                                        |
| Squad CLI     | Latest                                                             | AI team collaboration framework.                                                                                                                        |

---

## 2. User Experience & Functionality

### User Personas

| Persona            | Description                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Solo Developer** | A .NET developer starting a new Blazor Server project who wants a batteries-included template with proven patterns.    |
| **Team Lead**      | A tech lead who wants consistent project structure across multiple team projects with Squad AI collaboration baked in. |

### User Stories

#### US-1: Project Initialization

**As a** developer, **I want to** run the scaffolding process inside an existing project folder with git and Squad initialized and a solution file created, **so that** I have version control, AI team collaboration, and a solution file ready to receive projects from the start.

**Acceptance Criteria:**

- The scaffolder runs inside an existing folder (the folder name becomes the project name, e.g., `MyBlazorApp/` → project name `MyBlazorApp`).
- `git init` is executed (the initial commit happens in Phase 6 after all scaffolding is complete).
- `squad init` is executed and the team is imported from `squad-export.json` (cloned from the dotfiles repository: `https://github.com/{owner}/dotfiles.git`, or copied from a local clone at `~/Repos/dotfiles/`).
- A `{FolderName}.slnx` solution file is created in the project root (e.g., `MyBlazorApp.slnx`). This is the solution file that all source and test projects will be added to in subsequent phases.
- The folder contains `.gitignore`, `.editorconfig`, and `LICENSE` imported from the dotfiles project.

#### US-2: Folder Structure Creation

**As a** developer, **I want** the standard folder structure created automatically, **so that** code organization follows the proven IssueTrackerApp pattern.

**Acceptance Criteria:**

- Root contains: `.github/`, `src/`, `tests/`, `docs/`, `scripts/` directories.
- `.github/` contains: `instructions/`, `workflows/`, `hooks/`, `skills/`, `agents/`, `prompts/`, `copilot-instructions.md`, `dependabot.yml`, `codecov.yml`, `pull_request_template.md`, `CODEOWNERS`.
- `docs/` contains imported files: `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `REFERENCES.md`, `SECURITY.md`.
- Root contains: `Directory.Build.props`, `Directory.Packages.props`, `global.json`, `GitVersion.yml`, `AGENTS.md`, `README.md` (the `{FolderName}.slnx` solution file is already present from US-1).
- Root also contains (generated by tooling): `.squad/`, `squad.config.ts` (from `squad init`), `.gitattributes`, `.mcp.json` (MCP server configuration).

#### US-3: Source Projects

**As a** developer, **I want** four source projects created in `src/`, **so that** I have Aspire orchestration, shared service defaults, a clean domain layer, and a Blazor Server web app with integrated MongoDB persistence.

**Acceptance Criteria:**

- `src/AppHost/` — Aspire App Host (exe) referencing ServiceDefaults and Web.
- `src/ServiceDefaults/` — Shared Aspire project with OpenTelemetry, health checks, resilience.
- `src/Domain/` — Class library with MediatR, FluentValidation; CQRS vertical-slice structure under `Features/`.
- `src/Web/` — Blazor Server project referencing Domain and ServiceDefaults; includes MongoDB persistence (DbContext, Repository, Configurations), Auth0, Redis caching, TailwindCSS v4, theming infrastructure, and SignalR hub.

#### US-4: Test Projects

**As a** developer, **I want** test projects created in `tests/`, **so that** I can immediately start writing tests following the established patterns.

**Acceptance Criteria:**

- `tests/Architecture.Tests/` — NetArchTest-based layer dependency and naming convention tests.
- `tests/Domain.Tests/` — xUnit tests for domain logic, commands, queries, validators.
- `tests/Web.Tests/` — xUnit tests for Web services, handlers, helpers.
- `tests/Web.Tests.Bunit/` — bUnit component tests for Blazor components.
- `tests/Web.Tests.Integration/` — Integration tests with `CustomWebApplicationFactory` and MongoDB TestContainers.

#### US-5: TailwindCSS and Theming

**As a** developer, **I want** TailwindCSS v4 and the 4-color theme system pre-configured, **so that** the app has a polished, system-aware dark mode UI from day one.

**Acceptance Criteria:**

- `src/Web/package.json` includes TailwindCSS v4 with `css:build` and `css:watch` scripts.
- `src/Web/Styles/input.css` imports Tailwind and `themes.css` with `@source` directives for Razor components.
- `src/Web/Styles/themes.css` defines 4 color palettes (blue, red, green, yellow) × 2 brightness modes (light, dark) using OKLCH color space — totaling 8 theme variants.
- `src/Web/wwwroot/js/theme.js` provides `themeManager` with `getColor`, `getBrightness`, `setColor`, `setBrightness`, `watchSystemPreference`, and `markInitialized` functions.
- `src/Web/Components/Theme/` contains: `ThemeProvider.razor`, `ThemeProvider.razor.cs`, `ThemeSelector.razor`, `ThemeBrightnessToggleComponent.razor`, `ThemeColorDropdownComponent.razor`.
- The `@custom-variant dark (&:where(.dark, .dark *))` directive is set in `input.css`.
- Theme persists via `localStorage` and respects system `prefers-color-scheme`.

#### US-6: Dotfiles Import

**As a** developer, **I want** shared configuration files imported from the dotfiles repository, **so that** I don't have to manually copy boilerplate across projects.

**Acceptance Criteria:**

- The dotfiles repository is available either as a local clone (`~/Repos/dotfiles/`) or freshly cloned from `https://github.com/{owner}/dotfiles.git`.
- The following files are copied **verbatim** (no modifications needed):
  - `.editorconfig` → project root
  - `.gitignore` → project root
  - `LICENSE` → project root
  - `docs/CODE_OF_CONDUCT.md` → `docs/`
  - `docs/CONTRIBUTING.md` → `docs/`
  - `docs/REFERENCES.md` → `docs/`
  - `docs/SECURITY.md` → `docs/`
- The following are copied from dotfiles `.github/` and **require token replacement** (see Appendix B):
  - `instructions/` → `.github/instructions/`
  - `workflows/` → `.github/workflows/`
  - `skills/` → `.github/skills/`
  - `agents/` → `.github/agents/`
  - `prompts/` → `.github/prompts/`
  - `copilot-instructions.md` → `.github/copilot-instructions.md`
  - `dependabot.yml` → `.github/dependabot.yml`
  - `codecov.yml` → `.github/codecov.yml`
- Files requiring **regeneration** (not copied):
  - `CODEOWNERS` — generated fresh for the new team
  - `UserSecretsId` values — new GUIDs per project
  - `README.md` — generated with new project name and badges

#### US-7: CI/CD Workflows

**As a** developer, **I want** the full Squad CI/CD workflow set included, **so that** automated build, test, and release pipelines work immediately.

**Acceptance Criteria:**

- Workflows from dotfiles `.github/workflows/` are imported:
  - `build-and-test.yml` — Core build and test pipeline
  - `ci-cd.yml` — CI/CD integration
  - `code-quality.yml` — Code quality analysis
- Core Squad workflows (copied from IssueTrackerApp `.github/workflows/`, not dotfiles — these are not yet in dotfiles):
  - `squad-ci.yml` — Squad CI pipeline
  - `squad-test.yml` — Squad test runner
  - `squad-release.yml` — Release workflow
  - `squad-promote.yml` — Promotion workflow
  - `squad-triage.yml` — Issue triage
  - `squad-label-enforce.yml` — Label enforcement
  - `squad-issue-assign.yml` — Issue assignment
  - `squad-docs.yml` — Documentation generation
  - `squad-heartbeat.yml` — Squad health monitoring
  - `squad-insider-release.yml` — Insider release channel
  - `squad-milestone-release.yml` — Milestone-based releases
  - `squad-preview.yml` — Preview deployments
  - `sync-squad-labels.yml` — Label synchronization
  - `codeql-analysis.yml` — Security analysis
  - `code-metrics.yml` — Code metrics collection
  - `static.yml` — Static site deployment (GitHub Pages)
- IssueTrackerApp-specific workflows **excluded from template** (not applicable to new projects):
  - `blog-readme-sync.yml`, `milestone-blog.yml`, `release-blog.yml`, `sync-readme.yml`, `milestone-release-decision.yml` — blog/readme syncing specific to IssueTrackerApp's documentation site.
- All workflow YAML references are updated: solution file name, project paths, test project paths, Codecov slug, and repository name.
- `scripts/install-hooks.sh` is present and configures the git pre-push hook.
- `.github/hooks/pre-push` hook runs build and test gates referencing the correct 5 test projects.

### Non-Goals

- **NG-1**: Azure Blob Storage persistence — eliminated entirely. File storage defaults to `LocalFileStorageService` (files stored in `wwwroot/uploads/`). Tests use temp directories.
- **NG-2**: Separate `Persistence.MongoDb` project — MongoDB persistence is consolidated into `Web/Persistence/MongoDb/`. The old `Persistence.MongoDb.Tests` and `Persistence.MongoDb.Tests.Integration` test projects are eliminated; their test patterns merge into `Web.Tests` and `Web.Tests.Integration`.
- **NG-3**: Separate `AppHost.Tests` project — Playwright-based E2E tests are a future enhancement.
- **NG-4**: Automated scaffolding CLI tool — this PRD documents the manual process; automation is a future enhancement.
- **NG-5**: Data seeding with sample data — the template includes the seeding infrastructure but no domain-specific seed data.
- **NG-6**: Full IssueTracker domain features — the template provides the structural skeleton, not the business logic.

### Intentional Divergences from IssueTrackerApp

The following table documents deliberate differences between the template and IssueTrackerApp. These are design decisions, not omissions.

| IssueTrackerApp Feature | Template Decision | Rationale |
|------------------------|-------------------|-----------|
| Separate `src/Persistence.MongoDb/` project | Consolidated into `src/Web/Persistence/MongoDb/` | Simplifies project count; namespace-based architecture tests still enforce boundaries. |
| Separate `src/Persistence.AzureStorage/` project | Eliminated entirely | Template uses `LocalFileStorageService` only; Azure Blob not needed. |
| 10 test projects | 5 test projects | Persistence test projects merge into `Web.Tests` and `Web.Tests.Integration`; Azure Storage tests eliminated. |
| `Persistence.MongoDb` namespace | `Web.Persistence.MongoDb` namespace | Requires namespace/using rewrites (see Appendix B). Architecture tests use namespace-based rules instead of assembly-based. |
| Azure Key Vault integration | Not included in template | Add as needed per project. Document in README if required. |
| Application Insights / Azure Monitor | Not included in template | OpenTelemetry is included via ServiceDefaults; cloud-specific exporters added per deployment target. |
| SendGrid email integration | Not included in template | Add as needed per project. Template provides no email service. |
| Chart.js integration | Included as optional (`wwwroot/js/charts.js`) | File present but not wired to components; available for projects that need charting. |
| Blog/readme sync workflows | Excluded | IssueTrackerApp-specific documentation workflows. |
| `Web.Endpoints.*` directly injects `DbContext` | Refactored to use service facades only | Deliberate improvement: cleaner separation via `Web.Components.*` and `Web.Endpoints.*` → service facades → MediatR → repositories. |
| `ARCHITECTURE.md`, `FEATURES.md`, `LIBRARIES.md`, `TESTING.md`, `THEMING.md` in docs | Not copied from IssueTrackerApp | IssueTracker-specific content; `TESTING.md` and `THEMING.md` may be regenerated with template-specific content in a future enhancement. |

---

### Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    AppHost (Aspire)                   │
│  Orchestrates: MongoDB (connection string),          │
│                Redis (container), Web (project)       │
└──────────────┬───────────────────────────────────────┘
               │ References
┌──────────────▼───────────────────────────────────────┐
│                    Web (Blazor Server)                │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────┐ │
│  │  Components  │ │   Services   │ │   Endpoints   │ │
│  │  (Razor UI)  │ │  (Facades)   │ │  (Minimal API)│ │
│  └─────────────┘ └──────┬───────┘ └───────────────┘ │
│                          │ MediatR                    │
│  ┌──────────────────┐   │   ┌─────────────────────┐ │
│  │  Persistence/    │◄──┘   │  Auth/ (Auth0)       │ │
│  │  MongoDb/        │       │  Hubs/ (SignalR)     │ │
│  │  (DbContext,     │       │  Helpers/            │ │
│  │   Repositories)  │       │  wwwroot/js/theme.js │ │
│  └──────────────────┘       └─────────────────────┘ │
│  ┌──────────────────┐                                │
│  │  Components/Theme/│  TailwindCSS v4               │
│  │  (4-color system) │  Styles/themes.css (OKLCH)    │
│  └──────────────────┘                                │
└──────────────┬───────────────────────────────────────┘
               │ References
┌──────────────▼───────────────────────────────────────┐
│              Domain (Class Library)                   │
│  Abstractions/ DTOs/ Models/ Events/ Mappers/        │
│  Features/{Feature}/Commands/ Queries/ Validators/   │
│  Behaviors/ (MediatR pipeline behaviors)             │
└──────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────┐
│           ServiceDefaults (Aspire Shared)             │
│  OpenTelemetry, Health Checks, Resilience,           │
│  Service Discovery                                   │
└──────────────────────────────────────────────────────┘
```

### Project Dependency Graph

```waterfall
AppHost ──► Web ──► Domain
  │          │
  │          └──► ServiceDefaults
  └──────────────► ServiceDefaults
```

**Key constraints** (enforced by Architecture.Tests via namespace-based rules):

- Domain MUST NOT reference `Web.*`, `Web.Persistence.*`, `MongoDB.Driver.*`, or any `Microsoft.AspNetCore.*` packages.
- `Web.Persistence.MongoDb` may reference Domain (for `IRepository<T>`, models).
- `Web.Components.*` and `Web.Endpoints.*` MUST NOT directly reference `IssueTrackerDbContext` or MongoDB driver types — they go through service facades only.
- Domain handlers MUST receive `IRepository<T>` abstractions, never `IssueTrackerDbContext` or MongoDB-specific types.

### Technology Stack

| Component          | Technology                  | Version                                       |
| ------------------ | --------------------------- | --------------------------------------------- |
| Runtime            | .NET                        | Pinned in `global.json` (currently `10.0.100-preview.4`) |
| Language           | C#                          | 14                                            |
| UI Framework       | Blazor Web App              | Interactive Server render mode                |
| Orchestration      | .NET Aspire                 | 13.x                                          |
| Database           | MongoDB                     | 7.0+ (via Aspire connection string)           |
| Cache              | Redis                       | Via Aspire container                          |
| Authentication     | Auth0                       | ASP.NET Core Authentication + Management API  |
| CSS Framework      | TailwindCSS                 | v4.2+                                         |
| CQRS/Mediator      | MediatR                     | Latest                                        |
| Validation         | FluentValidation            | Latest                                        |
| ORM                | MongoDB.EntityFrameworkCore | Latest                                        |
| Testing            | xUnit + bUnit 2.x           | Latest                                        |
| Mocking            | NSubstitute                 | Latest                                        |
| Architecture Tests | NetArchTest                 | Latest                                        |
| Architecture       | Vertical Slice Architecture | CQRS feature folders under `Domain/Features/` |
| Package Management | Central Package Management  | `Directory.Packages.props` at repo root       |
| Versioning         | GitVersion                  | ContinuousDelivery mode                       |

### Integration Points

| Integration     | Details                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB**     | Connection string via Aspire (`ConnectionStrings:mongodb`). Fallback: `MongoDB:ConnectionString`.                                                     |
| **Redis**       | Aspire-managed container. `DistributedCacheHelper` wraps `IDistributedCache` with typed JSON get/set/remove.                                          |
| **Auth0**       | Configured in `Program.cs`. Claims transformation in `Auth/Auth0ClaimsTransformation.cs`. Management API via `Auth0Management` env vars from AppHost. |
| **SignalR**     | `IssueHub` for real-time notifications.                                                                                                               |
| **TailwindCSS** | NPM build integrated into `.csproj` — auto-runs `npm install` + `npm run css:build` on build.                                                         |
| **GitVersion**  | `GitVersion.yml` with `main`/`dev`/`feature`/`insider`/`pull-request` branch config. Tag prefix `[vV]`.                                               |

### Security & Privacy

- Auth0 secrets stored in User Secrets (development) and environment variables (CI/production).
- `UserSecretsId` configured in both `AppHost.csproj` and `Web.csproj`.
- HTTPS enforced for all web communication.
- `TreatWarningsAsErrors=true` enforced via `Directory.Build.props`.
- Centralized package management via `Directory.Packages.props`.

---

## 4. Phased Scaffolding Process

### Phase 1: Project Initialization

| Step | Command / Action                           | Details                                                                                                                                                   |
| ---- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | `cd {ExistingFolder}`                      | Navigate into the existing project folder. The folder name becomes the project name (e.g., `MyBlazorApp/` → `{ProjectName}` = `MyBlazorApp`).             |
| 1.2  | `git init`                                 | Initialize git repository.                                                                                                                                |
| 1.3  | `squad init`                               | Initialize Squad AI team framework.                                                                                                                       |
| 1.4  | Clone or locate dotfiles                   | `git clone https://github.com/{owner}/dotfiles.git /tmp/dotfiles` or use existing `~/Repos/dotfiles/`. The `DOTFILES` variable below refers to this path. |
| 1.5  | `squad import $DOTFILES/squad-export.json` | Import the team roster from dotfiles.                                                                                                                     |
| 1.6  | `dotnet new slnx -n {FolderName}`          | Create the `{FolderName}.slnx` solution file. All source and test projects created in subsequent phases will be added to this solution.                   |

### Phase 2: Root Configuration Files

Create these **before** any projects, so `dotnet new` picks up the correct SDK and framework settings.

| Step | File                       | Content                                                                                                                                                   |
| ---- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `global.json`              | Pin SDK version (e.g., `10.0.100-preview.4...`) with `rollForward: latestMinor`.                                                                       |
| 2.2  | `Directory.Build.props`    | Set `TargetFramework`, `LangVersion`, `Nullable`, `ImplicitUsings`, `TreatWarningsAsErrors`, `EnforceCodeStyleInBuild`, `ManagePackageVersionsCentrally`. |
| 2.3  | `Directory.Packages.props` | Centralized NuGet package versions. Remove Azure Blob Storage packages from IssueTrackerApp source.                                                       |
| 2.4  | `GitVersion.yml`           | ContinuousDelivery mode with main/dev/feature/insider/PR branch configs.                                                                                  |
| 2.5  | `README.md`                | Project overview with build/run instructions (use `{ProjectName}` throughout).                                                                            |
| 2.6  | `AGENTS.md`                | AI agent instructions with architecture map.                                                                                                              |

### Phase 3: Import Dotfiles

| Step | Command / Action                                                                         | Details                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | Copy `.editorconfig` from `$DOTFILES/`                                                   | UTF-8, LF line endings, tab-based for web/razor, space-based for markdown/yaml.                                             |
| 3.2  | Copy `.gitignore` from `$DOTFILES/`                                                      | Visual Studio + .NET comprehensive ignore patterns.                                                                         |
| 3.3  | Copy `LICENSE` from `$DOTFILES/`                                                         | MIT license.                                                                                                                |
| 3.4  | `mkdir docs`                                                                             | Create docs directory.                                                                                                      |
| 3.5  | Copy `docs/{CODE_OF_CONDUCT,CONTRIBUTING,REFERENCES,SECURITY}.md` from `$DOTFILES/docs/` | Standard community health files.                                                                                            |
| 3.6  | `mkdir -p .github/{instructions,workflows,hooks,skills,agents,prompts}`                  | Create GitHub configuration structure.                                                                                      |
| 3.7  | Copy `.github/` contents from `$DOTFILES/.github/`                                       | Instructions, workflows, skills, agents, prompts, copilot-instructions, dependabot, codecov.                                |
| 3.8  | Copy `pull_request_template.md` from IssueTrackerApp `.github/`                          | Not in dotfiles; source from IssueTrackerApp or generate fresh for the new project.                                         |
| 3.9  | Generate `.github/CODEOWNERS`                                                            | Generate fresh with the new project's owner/team entries (not copied from dotfiles or IssueTrackerApp).                     |
| 3.10 | Run token replacement (see Appendix B)                                                   | Replace `{OldProjectName}`, solution file refs, test project paths, Codecov slug, repo name in all copied `.github/` files. |

### Phase 4: Create Source Projects

#### 4.1 — ServiceDefaults (`src/ServiceDefaults/`)

```waterfall
src/ServiceDefaults/
├── ServiceDefaults.csproj    (IsAspireSharedProject=true)
├── GlobalUsings.cs
└── Extensions.cs             (OpenTelemetry, health checks, resilience, /health + /alive)
```

- **References**: `Microsoft.Extensions.Http.Resilience`, `Microsoft.Extensions.ServiceDiscovery`, OpenTelemetry packages, health check packages (MongoDB, Redis).

#### 4.2 — Domain (`src/Domain/`)

```waterfall
src/Domain/
├── Domain.csproj
├── DomainMarker.cs           (Assembly marker for MediatR scanning)
├── GlobalUsings.cs
├── Abstractions/             (Result<T>, IRepository<T>, ResultErrorCode)
├── Behaviors/                (MediatR pipeline behaviors: ValidationBehavior)
├── DTOs/                     (Record types for data transfer)
├── Events/                   (Domain event records)
├── Features/                 (Vertical slices — one folder per feature)
│   └── {Feature}/
│       ├── Commands/
│       ├── Queries/
│       └── Validators/
├── Mappers/                  (Extension methods for DTO ↔ Model mapping)
├── Models/                   (Domain entities)
└── README.md
```

- **Packages**: MediatR, FluentValidation.DependencyInjectionExtensions, MongoDB.Bson, Microsoft.Extensions.Logging.Abstractions.
- **Constraint**: MUST NOT reference Web, ASP.NET Core, or any persistence-specific packages beyond MongoDB.Bson.

#### 4.3 — Web (`src/Web/`)

```waterfall
src/Web/
├── Web.csproj                (Blazor Server SDK project)
├── Program.cs                (Composition root: DI, Auth0, MediatR, endpoints, SignalR)
├── package.json              (TailwindCSS v4 tooling)
├── appsettings.json
├── appsettings.Development.json
├── appsettings.Staging.json
├── appsettings.Production.json
├── Properties/
│   └── launchSettings.json   (HTTPS port pinned to 7043)
├── GlobalUsings.cs
├── Auth/                     (Auth0ClaimsTransformation, policies, constants)
├── Components/
│   ├── Layout/               (MainLayout, NavMenu, etc.)
│   ├── Pages/                (Blazor pages)
│   └── Theme/                (ThemeProvider, ThemeSelector, brightness toggle, color dropdown)
├── Data/                     (DataSeeder for startup seeding)
├── Endpoints/                (Minimal API route groups)
├── Features/                 (Feature-specific endpoints)
├── Helpers/                  (ObjectIdJsonConverter, CsvExportHelper)
├── Hubs/                     (SignalR hubs)
├── Persistence/
│   └── MongoDb/              (Consolidated from separate project)
│       ├── IssueTrackerDbContext.cs
│       ├── IIssueTrackerDbContext.cs
│       ├── Configurations/   (EF Core Mongo entity configurations)
│       ├── Repositories/     (Generic Repository<T> implementation)
│       ├── Services/         (MongoDB-specific services)
│       └── ServiceCollectionExtensions.cs
├── Services/                 (Service facades, DistributedCacheHelper)
├── Testing/                  (Test infrastructure: FakeRepository, FakeSeedData, test login endpoint — active only in Testing environment)
├── Styles/
│   ├── input.css             (Tailwind entry point with @source directives)
│   └── themes.css            (OKLCH color palettes: 4 colors × 2 brightness)
└── wwwroot/
    ├── css/app.css            (Generated by Tailwind build)
    └── js/
        ├── theme.js           (themeManager: localStorage, system preference)
        └── charts.js          (Chart.js integration if needed)
```

- **Project References**: Domain, ServiceDefaults.
- **Key Packages**: Auth0.AspNetCore.Authentication, Auth0.ManagementApi, Aspire.MongoDB.Driver, Aspire.StackExchange.Redis, Microsoft.Extensions.Caching.StackExchangeRedis, SendGrid, SixLabors.ImageSharp, Microsoft.AspNetCore.SignalR.Client.
- **Build Integration**: TailwindCSS auto-build via MSBuild targets (`CheckNodeModules` → `BuildTailwindCSS`).
- **InternalsVisibleTo**: `Web.Tests` for testing internal members.
- **File Storage**: `LocalFileStorageService` is the permanent implementation of `IFileStorageService` — files stored to `wwwroot/uploads/`. No Azure Blob Storage conditional.

#### 4.4 — AppHost (`src/AppHost/`)

```waterfall
src/AppHost/
├── AppHost.csproj            (Aspire.AppHost.Sdk, ManagePackageVersionsCentrally=false)
├── AppHost.cs                (MongoDB connection string, Redis container, Web project wiring)
└── Properties/
    └── launchSettings.json
```

- **Wires**: MongoDB (connection string from User Secrets), Redis (container with RedisCommander in Development), Web project with health check at `/health`.
- **Auth0 Parameters**: `auth0MgmtClientId` and `auth0MgmtClientSecret` as secret parameters.

### Phase 5: Create Test Projects

#### 5.1 — Architecture.Tests (`tests/Architecture.Tests/`)

- **Namespace-based** layer dependency enforcement (not assembly-based, since MongoDB persistence is in Web):
  - Domain types MUST NOT reference types in `Web.*`, `Web.Persistence.*`, `MongoDB.Driver.*`, or `Microsoft.AspNetCore.*`.
  - `Web.Persistence.MongoDb.*` types MAY reference `Domain.*`.
  - `Web.Components.*` and `Web.Endpoints.*` MUST NOT reference `IssueTrackerDbContext` or MongoDB driver types directly — access goes through service facades.
- Naming conventions: Commands end with `Command`, Queries with `Query`, Validators with `Validator`, Handlers with `Handler` and should be `sealed`.
- CQRS types under `Domain.Features.*`; DTOs in `Domain.DTOs` should be records.

#### 5.2 — Domain.Tests (`tests/Domain.Tests/`)

- xUnit tests for command/query handlers, validators, domain logic.
- Uses NSubstitute for mocking `IRepository<T>`.

#### 5.3 — Web.Tests (`tests/Web.Tests/`)

- xUnit tests for service facades, helpers, handlers.
- Uses `MemoryDistributedCache` for cache testing (requires both `Microsoft.Extensions.Caching.Distributed` and `Microsoft.Extensions.Caching.Memory` usings).

#### 5.4 — Web.Tests.Bunit (`tests/Web.Tests.Bunit/`)

- bUnit 2.x component tests using `Render<T>()` (not the deprecated `RenderComponent<T>()`).
- Tests for Theme components, Layout, Pages.

#### 5.5 — Web.Tests.Integration (`tests/Web.Tests.Integration/`)

- `CustomWebApplicationFactory` with MongoDB TestContainers (mongo:7.0, replica set `rs0`).
- Overridable via `MONGODB_CONNECTION_STRING` environment variable.
- `ClearDatabaseAsync` uses `IMemoryCache.Compact(1.0)` to clear all cache entries.

### Phase 6: Final Configuration

| Step | Action                             | Details                                                                                                         |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 6.1  | Create `scripts/install-hooks.sh`  | Script to install pre-push git hook.                                                                            |
| 6.2  | Create `.github/hooks/pre-push`    | Build gate + test gates (Architecture, Domain, Web unit, bUnit, integration). Reference the 5-project test set. |
| 6.3  | Update `.slnx`                     | Ensure all 4 src + 5 test projects are referenced.                                                              |
| 6.4  | Configure `launchSettings.json`    | Pin HTTPS port to `7043` for stable Auth0 callback URLs.                                                        |
| 6.5  | Configure `appsettings.json`       | Auth0 section with Domain, ClientId placeholders. `BlobStorage` section removed (no Azure).                     |
| 6.6  | Register `LocalFileStorageService` | In `Program.cs`, register as the permanent `IFileStorageService` implementation (no Azure Blob conditional).    |
| 6.7  | Run `npm install` in `src/Web/`    | Install TailwindCSS tooling (requires Node.js ≥ 20).                                                            |
| 6.8  | Run `dotnet restore`               | Restore all NuGet packages.                                                                                     |
| 6.9  | Run `dotnet build`                 | Verify clean build with zero warnings (`TreatWarningsAsErrors=true`).                                           |
| 6.10 | Run `dotnet test`                  | Verify all starter tests pass.                                                                                  |
| 6.11 | Run Appendix C verification        | Confirm no stale references to eliminated components.                                                           |
| 6.12 | Initial commit                     | `git add . && git commit -m "Initial project scaffold"`.                                                        |

---

## 5. Risks & Mitigation

| Risk                                                          | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB persistence consolidation breaks layer boundaries** | Medium     | High   | Architecture.Tests enforce namespace-based rules: Domain MUST NOT reference `Web.Persistence.*` or `MongoDB.Driver.*`. Domain handlers receive only `IRepository<T>` abstractions. Review Architecture.Tests first when modifying persistence. |
| **TailwindCSS build fails on machines without Node.js**       | Medium     | Medium | Document Node.js ≥ 20 LTS as a prerequisite. `.csproj` conditionally runs `npm install` only when `node_modules` is missing. SC-1 includes Node.js in prerequisites verification.                                                              |
| **.NET preview SDK version mismatch**                         | Medium     | Low    | `global.json` pins exact SDK version with `rollForward: latestMinor`. Phase 2.1 documents the pinned version.                                                                                                                                  |
| **Auth0 configuration complexity for new projects**           | Low        | Medium | Template includes placeholder `appsettings.json` with Auth0 section structure. Port pinned to 7043 in `launchSettings.json` for stable Auth0 callback URLs. Document required Auth0 tenant setup in README.                                    |
| **Squad workflow YAML references stale project names**        | High       | Low    | Phase 3.8 and Appendix B document exact tokens to replace. SC-5 verifies no stale references.                                                                                                                                                  |
| **Redis unavailable in development**                          | Low        | Low    | AppHost provisions Redis container. Fallback to `DistributedMemoryCache` in test environments.                                                                                                                                                 |
| **Auth0 callback URL port mismatch**                          | Medium     | Medium | Pin HTTPS port to `7043` in `launchSettings.json` (matching IssueTrackerApp). Auth0 web app callback URLs must include `https://localhost:7043/callback`.                                                                                      |
| **Copied files contain stale project references**             | High       | Medium | Appendix C provides a Removed-Components Cleanup Checklist to verify no Azure Blob, old `Persistence.MongoDb` project, or `Persistence.AzureStorage` references remain.                                                                        |

### Future Enhancements (Out of Scope)

- **v1.1**: Automated CLI scaffolder (e.g., `dotnet new` template or shell script).
- **v1.2**: Optional feature flags for Auth0, Redis, SignalR (include/exclude at scaffold time).
- **v2.0**: Interactive `squad scaffold` command that reads this PRD and generates the project.

---

## Appendix A: Key Files Reference

### Theme Infrastructure Files (Copy from IssueTrackerApp)

| Source File                   | Target Location                      |
| ----------------------------- | ------------------------------------ |
| `src/Web/Styles/themes.css`   | `src/Web/Styles/themes.css`          |
| `src/Web/Styles/input.css`    | `src/Web/Styles/input.css`           |
| `src/Web/wwwroot/js/theme.js` | `src/Web/wwwroot/js/theme.js`        |
| `src/Web/Components/Theme/*`  | `src/Web/Components/Theme/`          |
| `src/Web/package.json`        | `src/Web/package.json` (update name) |

### Root Configuration Files (Adapt from IssueTrackerApp)

| Source File                | Target Location | Adaptation Needed                                        |
| -------------------------- | --------------- | -------------------------------------------------------- |
| `Directory.Build.props`    | Root            | None — use as-is.                                        |
| `Directory.Packages.props` | Root            | Remove packages for eliminated projects (Azure Storage). |
| `global.json`              | Root            | None — use as-is.                                        |
| `GitVersion.yml`           | Root            | None — use as-is.                                        |
| `.editorconfig`            | Root            | Imported from dotfiles.                                  |

### Namespace Convention for Consolidated Persistence

When MongoDB persistence moves into the Web project, the namespace should be:

```csharp
namespace Web.Persistence.MongoDb;
// or
namespace {ProjectName}.Web.Persistence.MongoDb;
```

This keeps the code physically co-located but logically separated, and architecture tests can still enforce that `Domain` does not reference `Web.Persistence.*`.

---

### Appendix B: Rename/Retokenize Checklist

When copying files from dotfiles or IssueTrackerApp, the following tokens MUST be replaced with the new project's values:

| Token / Pattern                                               | Replace With                       | Files Affected                                                                   |
| ------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `IssueTrackerApp`                                             | `{ProjectName}`                    | `.slnx`, `.csproj` files, `AGENTS.md`, `README.md`, workflow YAML, pre-push hook |
| `IssueTrackerApp.slnx`                                        | `{ProjectName}.slnx`               | Workflow YAML, pre-push hook, `AGENTS.md`                                        |
| Solution file references                                      | Updated project paths              | `.slnx`, workflow YAML                                                           |
| Test project paths (e.g., `tests/Persistence.MongoDb.Tests/`) | Removed / updated to 5-project set | Workflow YAML, pre-push hook                                                     |
| `namespace Persistence.MongoDb`                               | `namespace Web.Persistence.MongoDb` | All files moved from `src/Persistence.MongoDb/` into `src/Web/Persistence/MongoDb/` |
| `using Persistence.MongoDb`                                   | `using Web.Persistence.MongoDb`    | `Program.cs`, test files, any file that referenced the old namespace             |
| Codecov slug (e.g., `mpaulosky/IssueTrackerApp`)              | `{owner}/{ProjectName}`            | `.github/codecov.yml`, workflow YAML                                             |
| Repository name in badge URLs                                 | `{owner}/{ProjectName}`            | `README.md`                                                                      |
| `UserSecretsId` GUIDs                                         | Generate new GUIDs                 | `AppHost.csproj`, `Web.csproj`                                                   |
| `package.json` `"name"` field                                 | `{project-name-kebab}`             | `src/Web/package.json`                                                           |
| CODEOWNERS entries                                            | Updated owner/team names           | `.github/CODEOWNERS`                                                             |
| Auth0 domain/clientId in `appsettings.json`                   | New Auth0 app values               | `src/Web/appsettings.json`, `src/AppHost/` user secrets                          |

---

### Appendix C: Removed-Components Cleanup Checklist

After scaffolding, verify that **none** of the following eliminated components appear anywhere in the new project:

| Component                                     | Where to Check                                                     | Expected State                                                       |
| --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `Persistence.MongoDb` (as a separate project) | `.slnx`, `Directory.Packages.props`, workflow YAML                 | No references — persistence is in `Web/Persistence/MongoDb/`         |
| `Persistence.AzureStorage` (project)          | `.slnx`, `.csproj` files, `Directory.Packages.props`, `Program.cs` | Completely absent                                                    |
| Azure Blob Storage NuGet packages             | `Directory.Packages.props`, `.csproj` files                        | Removed (e.g., `Azure.Storage.Blobs`, `Aspire.Azure.Storage.Blobs`)  |
| `IFileStorageService` Azure implementation    | `Program.cs`, `Services/`                                          | Only `LocalFileStorageService` registered; no Azure Blob conditional |
| `Persistence.MongoDb.Tests` (test project)    | `.slnx`, workflow YAML, pre-push hook                              | Absent — merged into `Web.Tests`                                     |
| `Persistence.MongoDb.Tests.Integration`       | `.slnx`, workflow YAML, pre-push hook                              | Absent — merged into `Web.Tests.Integration`                         |
| `Persistence.AzureStorage.Tests`              | `.slnx`, workflow YAML, pre-push hook                              | Completely absent                                                    |
| `AppHost.Tests` / `AppHost.Tests.Integration` | `.slnx`, workflow YAML, pre-push hook                              | Absent (future enhancement per NG-3). Note: only `AppHost.Tests` exists in IssueTrackerApp; `AppHost.Tests.Integration` does not. |
| Old 10-project test matrix                    | Workflow YAML, pre-push hook                                       | Updated to 5-project set                                             |

### Appendix D: Test Matrix Mapping

| IssueTrackerApp Test Project            | Template Equivalent                   | Migration Notes                                                |
| --------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `Architecture.Tests`                    | `Architecture.Tests`                  | Update to namespace-based enforcement                          |
| `Domain.Tests`                          | `Domain.Tests`                        | Direct port                                                    |
| `Web.Tests`                             | `Web.Tests`                           | Absorbs `Persistence.MongoDb.Tests` patterns                   |
| `Web.Tests.Bunit`                       | `Web.Tests.Bunit`                     | Direct port (bUnit 2.x, `Render<T>()`)                         |
| `Web.Tests.Integration`                 | `Web.Tests.Integration`               | Absorbs `Persistence.MongoDb.Tests.Integration` patterns       |
| `Persistence.MongoDb.Tests`             | *(merged into Web.Tests)*             | Repository tests move to `Web.Tests/Persistence/`              |
| `Persistence.MongoDb.Tests.Integration` | *(merged into Web.Tests.Integration)* | Integration tests move to `Web.Tests.Integration/Persistence/` |
| `Persistence.AzureStorage.Tests`        | *(eliminated)*                        | Not applicable; `LocalFileStorageService` tests are in `Web.Tests/Services/` |
| `AppHost.Tests`                         | *(eliminated)*                        | Future enhancement (NG-3)                                      |
| `AppHost.Tests.Integration`             | *(eliminated)*                        | Does not exist in IssueTrackerApp; listed for future reference |
