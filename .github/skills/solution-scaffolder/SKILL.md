---
name: solution-scaffolder
description: 'Create new .NET solutions with complete project structure, configurations, and conventions based on the ArticlesSite architecture. Guides users through interactive prompts to scaffold solutions following SOLID principles, clean architecture, and established coding standards.'
---

# Solution Scaffolder

## Overview

This skill automates the creation of new .NET solutions that follow **Vertical Slice Architecture** along with the conventions and best practices of the ArticlesSite repository. Vertical Slice Architecture organizes code by business features rather than technical layers, resulting in simpler, more maintainable, and feature-focused projects. This skill provides an interactive guided
experience that ensures consistency across projects while respecting custom requirements and project-specific needs.

## When to Use

Use this skill when:

- Creating a new .NET 10 solution from scratch
- Starting a new project that should follow ArticlesSite conventions
- Onboarding team members to consistent project structure
- Establishing standardized folder layouts, configurations, and dependencies
- User asks to "create a new solution", "scaffold a project", or "set up a new .NET application"

---

## Core Principles

1. **Vertical Slice Architecture**: Organize code by business features, not technical layers
2. **Convention Over Configuration**: Use ArticlesSite patterns as defaults, allowing overrides when needed
3. **Interactive Guidance**: Ask targeted questions to understand project requirements before generating scaffolds
4. **Completeness**: Create a production-ready structure with all necessary files and configurations
5. **Standards Compliance**: Enforce C# 14, .NET 10, and established coding guidelines
6. **Minimal Bloat**: Generate only necessary files; avoid boilerplate that's not used

---

## Operational Workflow

### Phase 1: Discovery (Interactive Interview)

Before generating any files, conduct a guided discovery to understand the project. **Ask these questions in order**:

#### Question 1: Solution Name

- **Prompt**: "What is the name of your new solution? (e.g., `MyWebApp`, `DataProcessor`, `ApiService`)"
- **Validation**: Must be PascalCase, no spaces or special characters except hyphens
- **Impact**: Used for folder structure, project names, namespace roots, and solution file

#### Question 2: Destination Folder

- **Prompt**: "Where should the solution folder be created? (provide absolute or relative path, default: current directory)"
- **Validation**: Path must be valid and writable; create parent directories if needed
- **Impact**: Solution will be created at `{path}/{SolutionName}/`
- **Example Responses**:
  - `.` or empty (current directory)
  - `./projects`
  - `~/Development`
  - `C:\Projects` (Windows)
  - `/home/user/repos` (Linux/Mac)

#### Question 3: Solution Type

- **Prompt**: "What type of solution are you building?"
- **Choices**:
  - "Web Application (Blazor Server + API)" - Default. Includes Web, API, Domain, Persistence projects
  - "API-Only (.NET API)" - REST API without UI. Includes API, Domain, Persistence projects
  - "Console Application" - CLI tool or background service. Minimal structure
  - "Class Library" - Reusable library for other projects
  - "Microservice (Aspire-based)" - Distributed system with AppHost, ServiceDefaults
  - "Custom (Manual selection)" - Pick individual components

#### Question 4: Additional Features (Multi-Select)

- **Prompt**: "Which features should be included? (Select all that apply)"
- **Options**:
  - "Authentication & Authorization (Auth0)" - Default if Web Application
  - "Entity Framework Core with MongoDB" - Default if Web/API/Microservice
  - "MediatR for CQRS" - Default if Web/API/Microservice
  - "FluentValidation" - Default if Web/API/Microservice
  - "OpenTelemetry & Application Insights" - Default if API/Microservice
  - "Background Jobs (Hangfire or Quartz)" - Optional
  - "Caching (Redis)" - Optional
  - "API Versioning" - Default if API
  - "Unit & Integration Testing (xUnit)" - Recommended
  - "bUnit Component Testing" - Only if Blazor UI included
  - "Architecture Testing" - Recommended
  - "GitHub Actions CI/CD" - Optional

#### Question 5: Database Selection (If applicable)

- **Prompt**: "Which database will you use?"
- **Choices**:
  - "MongoDB" - Default. Enterprise-ready document store
  - "SQL Server" - Traditional relational database
  - "PostgreSQL" - Open-source relational
  - "None/In-Memory" - For libraries or simple apps
  - "Multiple (add later)" - Defer database selection

#### Question 6: Target Environment

- **Prompt**: "Where will this solution primarily run?"
- **Choices**:
  - "Local Development Only" - Minimal cloud configuration
  - "Cloud (Docker/Kubernetes)" - Include containerization and orchestration
  - "Azure" - Azure-specific settings and integrations
  - "Multiple Environments (Dev/Staging/Prod)" - Full environment configuration

#### Question 7: Team & Compliance

- **Prompt**: "Are there any special requirements?"
- **Options**:
  - "Code Coverage Requirements (minimum %)" - Input number if selected
  - "HIPAA/SOC2 Compliance" - Add security headers and audit logging
  - "Multi-tenant Architecture" - Add tenant isolation patterns
  - "None" - Standard requirements only

### Phase 2: Analysis & Planning

Process user input:

1. **Validate** solution name and format
2. **Determine** which projects need to be created based on solution type and features
3. **Map** NuGet package requirements from `Directory.Packages.props` standards
4. **Calculate** .gitignore rules needed
5. **Identify** configuration files needed (appsettings.json, .editorconfig, etc.)
6. **Review** with user before proceeding: "I'm ready to create X projects with Y features. Ready to proceed?"

### Phase 3: Scaffolding & Generation

Create the **Vertical Slice Architecture** structure with complete .github folder based on selections:

1. **Create root directories**: `src/`, `tests/`, `docs/`, `scripts/`, `.github/`
2. **Generate .github structure** (see ".github Folder Structure & Contents" section):
   - Workflow files (CI/CD, code quality, security scanning)
   - Issue and PR templates
   - Dependabot configuration
   - CODEOWNERS file
   - Instructions folder with solution-specific coding standards
   - **Copy agents/, prompts/, and skills/ folders** from source repository if they exist
3. **Generate projects** based on solution type and features
4. **Generate configuration files** (.editorconfig, Directory.Build.props, Directory.Packages.props, global.json)
5. **Generate feature folder templates** (sample feature structure for reference)
6. **Generate solution file** (.sln)
7. **Generate root documentation** (README.md, CONTRIBUTING.md, LICENSE.txt)

The `.github` folder ensures all workflows, standards, procedures, agents, prompts, and skills are included from the start, enabling consistent AI-assisted development immediately.

```text
MyWebApp/                                    (Solution Root)
├── .github/
│   ├── workflows/
│   │   ├── ci-cd.yml                       (If GitHub Actions selected)
│   │   ├── code-quality.yml                (If testing selected)
│   │   └── security-scan.yml               (If security scanning enabled)
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug.md                          (Bug report template)
│   │   ├── feature.md                      (Feature request template)
│   │   └── config.yml
│   ├── pull_request_template.md            (PR description template)
│   ├── dependabot.yml                      (Automated dependency updates)
│   ├── CODEOWNERS                          (Code ownership rules)
│   └── instructions/
│       ├── copilot-instructions.md         (Solution-specific Copilot rules)
│       ├── blazor.instructions.md          (If Blazor UI selected)
│       ├── git-commit-instructions.md      (Commit message conventions)
│       └── markdown.instructions.md        (Documentation standards)
├── docs/                                   (README, architecture diagrams)
├── scripts/                                (Setup and utility scripts)
├── src/
│   ├── MyWebApp.AppHost/                  (If Aspire selected)
│   ├── MyWebApp.ServiceDefaults/          (If microservice)
│   ├── MyWebApp.Api/                      (API entry point, Program.cs, middleware)
│   ├── MyWebApp.Web/                      (Blazor UI entry point, layout, shared components)
│   ├── MyWebApp.Common/                   (Shared abstractions, interfaces, extensions)
│   ├── MyWebApp.Persistence/              (Data access context, repositories, configurations)
│   └── MyWebApp.Features/
│       ├── Articles/                      (Articles feature vertical slice)
│       │   ├── CreateArticle/
│       │   │   ├── CreateArticleCommand.cs
│       │   │   ├── CreateArticleHandler.cs
│       │   │   ├── CreateArticleValidator.cs
│       │   │   └── CreateArticlePage.razor  (If Blazor UI)
│       │   ├── GetArticles/
│       │   │   ├── GetArticlesQuery.cs
│       │   │   ├── GetArticlesHandler.cs
│       │   │   └── ArticlesListComponent.razor
│       │   ├── GetArticleById/
│       │   └── UpdateArticle/
│       ├── Users/                         (Users feature vertical slice)
│       │   ├── Register/
│       │   ├── Login/
│       │   └── GetProfile/
│       └── Comments/                      (Comments feature vertical slice)
│           ├── CreateComment/
│           ├── GetComments/
│           └── DeleteComment/
├── tests/
│   ├── MyWebApp.Tests.Unit/               (Unit tests organized by feature)
│   │   └── Features/
│   │       ├── Articles/
│   │       └── Users/
│   ├── MyWebApp.Tests.Integration/        (Integration tests)
│   │   └── Features/
│   │       └── Articles/
│   ├── MyWebApp.Tests.Architecture/       (Architecture tests, if selected)
│   ├── MyWebApp.Tests.Bunit/              (Blazor component tests, if selected)
│   │   └── Features/
│   │       └── Articles/
│   └── MyWebApp.Tests.E2E/                (End-to-end tests, if selected)
├── .editorconfig                          (Copy from ArticlesSite)
├── .gitignore                             (Customized for selections)
├── Directory.Build.props                  (C# 14, .NET 10 config)
├── Directory.Packages.props                (Centralized versions)
├── global.json                            (SDK version lock)
├── MyWebApp.sln                           (Solution file)
├── NuGet.config                           (Private feeds if needed)
├── README.md                              (Getting started guide)
├── LICENSE.txt                            (Default: MIT)
└── CONTRIBUTING.md                       (Development guidelines)
```

**Vertical Slice Organization:**

- Each feature lives in its own folder under `Features/`
- Each endpoint/operation (Command/Query) is self-contained within the feature
- Shared abstractions go in `Common/`
- Data access and persistence layer stays centralized in `Persistence/`
- Each feature folder can contain: handlers, validators, DTOs, models, and UI components (if Blazor)
- **.github folder** contains all workflow, template, and instruction files for the repository

### Phase 4: Post-Scaffolding

After generation:

1. **Verify** all files created successfully
2. **Run** `dotnet restore` to validate project structure
3. **Provide** next steps:
   - Running tests: `dotnet test`
   - Building: `dotnet build`
   - Running development: `dotnet run` or `dotnet watch` (if applicable)
   - Adding first entity/API endpoint
4. **Create** a quick start guide tailored to the selected features

---

## File Generation Standards

### Project Files (.csproj)

All `.csproj` files must include:

- Target framework: `<TargetFramework>net10.0</TargetFramework>`
- Language version: `<LangVersion>14.0</LangVersion>`
- Nullable reference types: `<Nullable>enable</Nullable>`
- ImplicitUsings: `<ImplicitUsingsScope>global</ImplicitUsingsScope>`
- XML documentation: `<GenerateDocumentationFile>true</GenerateDocumentationFile>`

### Configuration Files

- **.editorconfig**: Copy from ArticlesSite (enforces style rules)
- **Directory.Build.props**: Centralized build configuration
- **Directory.Packages.props**: Pinned NuGet versions from ArticlesSite standards
- **global.json**: Lock .NET SDK to 10.x
- **.gitignore**: Extended with project-specific ignores
- **appsettings.json**: Environment-specific configs (Development, Staging, Production)

### Documentation Files

- **README.md**: Quick start, tech stack, running instructions
- **CONTRIBUTING.md**: Development setup, code style, PR process
- **LICENSE.txt**: Default MIT (customizable)
- **docs/ARCHITECTURE.md**: High-level architecture overview

### Global Usings File

Each project should include `GlobalUsings.cs`:

```csharp
global using System;
global using System.Collections.Generic;
global using System.Linq;
global using System.Text;
global using System.Threading.Tasks;
global using Microsoft.Extensions.DependencyInjection;
// ... project-specific usings
```

---

## NuGet Package Defaults

Use ArticlesSite `Directory.Packages.props` as the baseline. Include only what's selected:

### Core (Always)

- `Microsoft.Extensions.Configuration.*`
- `Microsoft.Extensions.DependencyInjection`
- `Microsoft.Extensions.Logging`

### Web/API

- `MediatR`
- `FluentValidation`
- `Scalar.AspNetCore` (API docs)

### Database

- `MongoDB.Driver`
- `MongoDB.EntityFrameworkCore`
- OR `Microsoft.EntityFrameworkCore.SqlServer`
- OR `Npgsql.EntityFrameworkCore.PostgreSQL`

### Testing

- `xUnit`
- `FluentAssertions`
- `NSubstitute`
- `Microsoft.NET.Test.Sdk`

### Blazor UI

- `bunit`
- `bunit.web`

### Observability

- `OpenTelemetry.Exporter.ApplicationInsights`
- `OpenTelemetry.Instrumentation.AspNetCore`

### Authentication

- `Auth0.AspNetCore.Authentication`

---

## Customization & Overrides

While this skill follows ArticlesSite conventions, allow customization in:

1. **Namespace Prefix**: Default to solution name, but allow override (e.g., `Company.Product`)
2. **Project Structure**: Offer different folder layouts (flat vs. grouped)
3. **Package Versions**: Use ArticlesSite versions by default, but allow newer stable versions
4. **CI/CD Strategy**: GitHub Actions by default, but allow GitLab CI, Azure Pipelines, etc.
5. **License Type**: MIT by default, but allow Apache 2.0, GPL, custom, or none

---

## Example: Creating "BlogEngine" Web Application

### Interview Flow

```csharp
Q1: Solution name? → "BlogEngine"
Q2: Destination folder? → "~/Projects"
Q3: Solution type? → "Web Application (Blazor Server + API)"
Q4: Features? → Authentication, EF Core + MongoDB, MediatR, FluentValidation, 
                  Testing, bUnit, Architecture Testing, GitHub Actions
Q5: Database? → "MongoDB"
Q6: Environment? → "Azure"
Q7: Special requirements? → "None"
```

### Generated Structure (Vertical Slice Architecture)

```text
BlogEngine/
├── .github/
│   ├── workflows/
│   │   ├── ci-cd.yml
│   │   ├── code-quality.yml
│   │   └── security-scan.yml
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug.md
│   │   ├── feature.md
│   │   └── config.yml
│   ├── pull_request_template.md
│   ├── dependabot.yml
│   ├── CODEOWNERS
│   ├── instructions/
│   │   ├── copilot-instructions.md
│   │   ├── blazor.instructions.md
│   │   ├── git-commit-instructions.md
│   │   └── markdown.instructions.md
│   ├── agents/                          (Copied from source if available)
│   │   ├── solution-scaffolder.agent.md
│   │   ├── code-reviewer.agent.md
│   │   └── ...
│   ├── prompts/                         (Copied from source if available)
│   │   ├── code-review-checklist.md
│   │   ├── test-generation.md
│   │   └── ...
│   └── skills/                          (Copied from source if available)
│       ├── solution-scaffolder/
│       ├── nuget-manager/
│       ├── refactor/
│       └── ...
├── src/
│   ├── BlogEngine.Api/
│   ├── BlogEngine.Web/
│   ├── BlogEngine.Common/
│   ├── BlogEngine.Persistence/
│   └── BlogEngine.Features/
│       ├── Articles/
│       │   ├── CreateArticle/
│       │   │   ├── CreateArticleCommand.cs
│       │   │   ├── CreateArticleHandler.cs
│       │   │   ├── CreateArticleValidator.cs
│       │   │   └── CreateArticlePage.razor
│       │   ├── GetArticles/
│       │   │   ├── GetArticlesQuery.cs
│       │   │   ├── GetArticlesHandler.cs
│       │   │   └── ArticlesListComponent.razor
│       │   └── GetArticleById/
│       └── Comments/
│           ├── CreateComment/
│           └── GetComments/
├── tests/
│   ├── BlogEngine.Tests.Unit/
│   │   └── Features/Articles/
│   ├── BlogEngine.Tests.Integration/
│   │   └── Features/Articles/
│   ├── BlogEngine.Tests.Architecture/
│   ├── BlogEngine.Tests.Bunit/
│   │   └── Features/Articles/
│   └── BlogEngine.Tests.E2E/
├── docs/
│   ├── ARCHITECTURE.md
│   └── README.md
├── scripts/
│   └── setup.sh
├── .editorconfig
├── .gitignore
├── Directory.Build.props
├── Directory.Packages.props
├── global.json
├── BlogEngine.sln
├── NuGet.config
├── README.md
├── LICENSE.txt
└── CONTRIBUTING.md
```

### Next Steps Provided

```csharp
✅ Solution created successfully!

📦 Vertical Slice Architecture structure:
  - BlogEngine.Api: API entry point with minimal configuration
  - BlogEngine.Web: Blazor Server UI entry point
  - BlogEngine.Common: Shared abstractions, interfaces, extensions
  - BlogEngine.Persistence: Data access context, repositories, EF configuration
  - BlogEngine.Features: Business features organized in vertical slices
    - Each feature (Articles, Comments, Users) is self-contained
    - Includes Commands/Queries, Handlers, Validators, and Blazor components

🚀 Quick Start:
  1. cd BlogEngine
  2. dotnet restore
  3. dotnet build
  4. dotnet test
  5. dotnet run --project src/BlogEngine.Web

📚 Vertical Slice Architecture Guide:
  - Read docs/ARCHITECTURE.md for detailed structure overview
  - Each feature folder contains everything needed for that feature
  - Shared code goes in Common/ (interfaces, extensions, utilities)
  - Data layer stays in Persistence/ (DbContext, repositories)
  - New features: Create Features/{FeatureName}/{Operation}/ folders

🔐 Configure Auth0 in appsettings.json
🗄️  Set MongoDB connection string in appsettings.Production.json

Happy coding! 🎉
```

---

## Copying From Source Repository

### agents/, prompts/, and skills/ Folders

When scaffolding a new solution, the skill will automatically copy these folders from the source repository if they exist:

**agents/** - Custom AI agents that extend Copilot's capabilities

- These agents automate complex workflows and analysis tasks
- Copied so new solutions inherit the same AI automation
- Examples: code reviewer, architecture analyzer, test generator

**prompts/** - Pre-built prompt templates for consistent results

- Standardized prompts for common development tasks
- Ensures consistent AI-assisted workflows across projects
- Examples: code review checklists, test generation patterns, documentation templates

**skills/** - Specialized Copilot skill modules

- Custom skills that solve project-specific problems
- Enable guided workflows for complex operations
- Examples: solution scaffolder (this skill), nuget manager, refactoring assistance

### Copy Process

1. **Detection**: Skill checks if `agents/`, `prompts/`, and `skills/` folders exist in source repository
2. **Validation**: Ensures folders contain valid .md or .agent.md files
3. **Recursive Copy**: Copies entire folder structures with all nested files
4. **Preservation**: Maintains original file structure and content exactly as-is
5. **Reporting**: Informs user what was copied (e.g., "Copied 3 agents, 5 prompts, 6 skills")

### Benefits

✅ **Immediate AI Assistance**: New solutions start with all custom agents and skills  
✅ **Consistent Automation**: All projects use the same AI-assisted workflows  
✅ **Knowledge Sharing**: Team standards and practices built into every solution  
✅ **Easy Onboarding**: New developers inherit proven patterns and tools  
✅ **Template Reuse**: Prompt templates ensure consistent output quality

### Example Copy Result

If the source repository has:

```text
.github/agents/             (3 agents)
.github/prompts/            (5 prompts)
.github/skills/             (6 skills)
```

The new BlogEngine solution will have:

```text
BlogEngine/.github/agents/   (Same 3 agents)
BlogEngine/.github/prompts/  (Same 5 prompts)
BlogEngine/.github/skills/   (Same 6 skills)
```

All ready to use immediately in the new solution.

---

## Quality Checks

After scaffolding, verify:

1. ✅ All `.csproj` files compile without errors
2. ✅ All test projects reference correct test frameworks
3. ✅ No circular dependencies between projects
4. ✅ GlobalUsings.cs exists in each project
5. ✅ .editorconfig rules are consistent
6. ✅ README.md contains setup instructions
7. ✅ Package versions are consistent across projects

---

## Limitations & Future Enhancements

### Current Scope

- Creates .NET 10 solutions only
- Focuses on ArticlesSite patterns
- Interactive CLI-based generation only

### Out of Scope (For Future)

- Visual Studio project template generation
- Web-based scaffolding UI
- Direct GitHub repository creation
- Automated CI/CD pipeline deployment

---

## .github Folder Structure & Contents

### Purpose

The `.github` folder contains all repository-level configuration, documentation, and automation. It ensures consistent workflows, clear contribution guidelines, and automated processes.

### Folder Organization

```text
.github/
├── workflows/              CI/CD pipelines and automated workflows
├── ISSUE_TEMPLATE/         Issue templates for bug reports and feature requests
├── pull_request_template.md PR submission guidelines
├── dependabot.yml          Automated dependency updates configuration
├── CODEOWNERS              Code ownership and review routing
├── instructions/           Coding standards and guidelines (solution-specific)
├── agents/                 Custom Copilot agents (if they exist)
├── prompts/                Copilot prompt templates (if they exist)
└── skills/                 Custom Copilot skills (if they exist)
```

### Files & Their Purpose

#### **workflows/** - Continuous Integration & Deployment

**ci-cd.yml** (If GitHub Actions selected)

- Builds the solution on push/PR
- Runs unit and integration tests
- Generates coverage reports
- Publishes to artifact registry or deployment environment

```yaml
name: CI/CD
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-dotnet@v3
        with:
          dotnet-version: '10.0.x'
      - run: dotnet restore
      - run: dotnet build
      - run: dotnet test --logger trx
```

**code-quality.yml** (If testing selected)

- Runs linters (.editorconfig validation)
- Performs static code analysis
- Checks code coverage thresholds
- Enforces style compliance

**security-scan.yml** (Optional)

- OWASP dependency scanning
- Secret detection
- Vulnerability scanning in NuGet packages

#### **ISSUE_TEMPLATE/** - Issue & PR Templates

**bug.md**

```markdown
---
name: Bug Report
about: Report a bug
---

## Description
Clear description of the bug.

## Steps to Reproduce
1. Step one
2. Step two

## Expected Behavior
What should happen.

## Actual Behavior
What actually happens.

## Environment
- OS: [e.g., Windows 11]
- .NET Version: 10.0
```

**feature.md**

```markdown
---
name: Feature Request
about: Suggest a feature
---

## Feature Description
What should be added.

## Motivation
Why this is needed.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
```

**config.yml**

```yaml
blank_issues_enabled: false
contact_links:
  - name: Documentation
    url: https://github.com/yourorg/yourrepo/blob/main/README.md
```

#### **pull_request_template.md** - PR Description

Guides contributors on what to include in PRs:

```markdown
## Description
Brief description of changes.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests added
- [ ] Integration tests added
- [ ] Manual testing completed

## Checklist
- [ ] Code follows .editorconfig style
- [ ] Comments explain complex logic
- [ ] Documentation updated
- [ ] No new warnings introduced
```

#### **dependabot.yml** - Dependency Updates

Automated security and version updates:

```yaml
version: 2
updates:
  - package-ecosystem: "nuget"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    reviewers:
      - "devops-team"
    assignees:
      - "maintainer"
```

#### **CODEOWNERS** - Code Ownership Rules

Routes PRs to appropriate reviewers:

```markdown
# Global
* @maintainer

# Feature teams
/src/MyWebApp.Features/Articles/ @articles-team
/src/MyWebApp.Features/Users/ @users-team
/src/MyWebApp.Persistence/ @data-team
/tests/ @qa-team
```

#### **instructions/** - Coding Standards (Solution-Specific)

Customized versions of ArticlesSite guidelines:

**copilot-instructions.md**

- Technology stack requirements
- Architecture rules
- SOLID principles enforcement
- Naming conventions
- Security requirements
- Testing requirements

**blazor.instructions.md** (If Blazor UI selected)

- Blazor component structure
- State management patterns
- Performance optimization guidelines
- Event handling best practices

**git-commit-instructions.md**

- Commit message format
- Branch naming conventions
- Conventional commits (feat:, fix:, etc.)
- Squash/rebase policies

**markdown.instructions.md**

- Documentation formatting standards
- README structure
- Code example formatting
- Link validation rules

#### **agents/** - Custom Copilot Agents

Contains custom AI agents for specialized tasks (copied from source repository if available):

**Example agents:**

- `solution-scaffolder.agent.md` - This agent for creating new solutions
- `code-reviewer.agent.md` - AI-powered code review assistant
- `architecture-analyzer.agent.md` - Architecture validation and analysis

Each agent file defines:

- Purpose and scope
- Available tools and capabilities
- Decision-making rules
- Interaction patterns

#### **prompts/** - Copilot Prompt Templates

Pre-built prompt templates for common development tasks (copied from source repository if available):

**Example prompts:**

- `code-review-checklist.md` - Code review guidelines
- `test-generation.md` - Unit test generation patterns
- `documentation-template.md` - API documentation template
- `refactoring-checklist.md` - Refactoring best practices

Prompts can be invoked via Copilot CLI for consistent results.

#### **skills/** - Custom Copilot Skills

Specialized skill modules extending Copilot capabilities (copied from source repository if available):

**Example skills:**

- `solution-scaffolder/` - Create new solutions (this skill)
- `nuget-manager/` - Manage NuGet packages
- `test-migrator/` - Migrate tests to new frameworks
- `refactor/` - Code refactoring assistance
- `prd/` - Generate Product Requirements Documents

Each skill folder contains:

- `SKILL.md` - Skill definition, capabilities, and usage examples
- Optional supporting files or templates

Skills provide guided workflows for complex tasks.

### What is Vertical Slice Architecture?

Instead of organizing code by technical layers (Controllers, Services, Repositories, Models), Vertical Slice Architecture organizes code by **business features**. Each feature is a "vertical slice" that contains everything needed to implement that feature—from the API endpoint down to the database query.

### Key Benefits

- **Feature Isolation**: Changes to one feature don't affect others
- **Easier Onboarding**: New developers can understand an entire feature by looking at one folder
- **Reduced Coupling**: Features are loosely coupled; shared code is minimal and explicit
- **Scalability**: Easy to add new features without modifying existing ones
- **Testing**: Each feature can be tested independently
- **Navigation**: Developers spend less time jumping between folders

### Project Organization

**BlogEngine.Features/ Structure:**

```text
Features/
├── Articles/
│   ├── CreateArticle/              Command operation
│   │   ├── CreateArticleCommand.cs
│   │   ├── CreateArticleHandler.cs
│   │   ├── CreateArticleValidator.cs
│   │   └── CreateArticlePage.razor
│   ├── GetArticles/                Query operation (list)
│   ├── GetArticleById/             Query operation (single)
│   ├── UpdateArticle/              Command operation
│   └── DeleteArticle/              Command operation
├── Users/
│   ├── Register/
│   ├── Login/
│   └── GetProfile/
└── Comments/
    ├── CreateComment/
    ├── GetComments/
    └── DeleteComment/
```

**BlogEngine.Common/ (Shared Code):**

- Interfaces: `IRepository<T>`, `IUnitOfWork`, `ICommand<T>`, `IQuery<T>`
- Exceptions: Custom exceptions used across features
- Extensions: Utility methods, DI registration helpers
- Models: Shared enums, constants, validation rules

**BlogEngine.Persistence/ (Data Layer):**

- `BlogEngineDbContext` - Entity Framework DbContext
- Repository implementations
- Migration files
- MongoDB/SQL configurations

### Naming Conventions for Features

Each operation folder follows this pattern:

- **Commands** (Write operations): `CreateArticleCommand`, `UpdateArticleCommand`, `DeleteArticleCommand`
- **Queries** (Read operations): `GetArticlesQuery`, `GetArticleByIdQuery`
- **Handlers**: `CreateArticleHandler` (implements `ICommandHandler<CreateArticleCommand>`)
- **Validators**: `CreateArticleValidator` (FluentValidation rules)
- **Blazor Pages**: `CreateArticlePage.razor` (Blazor page for the operation)
- **Components**: `ArticlesListComponent.razor` (Reusable component)

### MediatR Integration

With MediatR, operations are dispatched as commands/queries:

```csharp
// In API endpoint or Blazor component
var result = await mediator.Send(new CreateArticleCommand { Title = "...", Content = "..." });

// In the handler
public class CreateArticleHandler : ICommandHandler<CreateArticleCommand, ArticleDto>
{
    private readonly IRepository<Article> _repository;
    
    public async Task<ArticleDto> Handle(CreateArticleCommand request, CancellationToken cancellationToken)
    {
        var article = new Article { Title = request.Title, Content = request.Content };
        await _repository.AddAsync(article, cancellationToken);
        return article.ToDto();
    }
}
```

### Test Organization

Tests mirror the feature structure:

```text
tests/
├── BlogEngine.Tests.Unit/
│   └── Features/
│       ├── Articles/
│       │   ├── CreateArticleHandlerTests.cs
│       │   └── CreateArticleValidatorTests.cs
│       └── Users/
├── BlogEngine.Tests.Integration/
│   └── Features/Articles/ArticleRepositoryTests.cs
└── BlogEngine.Tests.Bunit/
    └── Features/Articles/CreateArticlePageTests.cs
```

This skill should:

1. Use `ask_user` tool for interactive questions (not plain text)
2. Validate all inputs before generating files
3. Create files using the `create` tool (avoid bash file generation)
4. Run `dotnet restore` after scaffolding to verify
5. Provide clear, actionable next steps
6. Reference ArticlesSite instructions (copilot-instructions.md, blazor.instructions.md, etc.) as generation rules
