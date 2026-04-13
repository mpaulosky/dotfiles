# NewProject

A modern issue tracking application built with .NET Aspire, Blazor, and MongoDB.

[![.NET 10](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet)](https://dotnet.microsoft.com/)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![xUnit Tests](https://img.shields.io/badge/Tests-xUnit-blueviolet?logo=github)](https://github.com/mpaulosky/NewProject/actions/workflows/squad-ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/mpaulosky/NewProject?logo=github&color=blue&label=Release)](https://github.com/mpaulosky/NewProject/releases/latest)

[![CI/CD](https://github.com/mpaulosky/NewProject/actions/workflows/squad-ci.yml/badge.svg)](https://github.com/mpaulosky/NewProject/actions/workflows/squad-ci.yml)
[![Test Suite](https://github.com/mpaulosky/NewProject/actions/workflows/squad-test.yml/badge.svg)](https://github.com/mpaulosky/NewProject/actions/workflows/squad-test.yml)

[![CodeCov Coverage](https://codecov.io/gh/mpaulosky/NewProject/branch/main/graph/badge.svg)](https://codecov.io/gh/mpaulosky/NewProject)
[![Coverage Trend](https://img.shields.io/badge/Coverage-Trend-blue?logo=codecov)](https://codecov.io/gh/mpaulosky/NewProject/commits/main)
[![Coverage Gate](https://img.shields.io/badge/Coverage%20Gate-≥80%25-brightgreen?logo=codecov)](https://github.com/mpaulosky/NewProject/actions/workflows/squad-test.yml)

[![Open Issues](https://img.shields.io/github/issues/mpaulosky/NewProject?color=0366d6)](https://github.com/mpaulosky/NewProject/issues?q=is%3Aopen+is%3Aissue)
[![Closed Issues](https://img.shields.io/github/issues-closed/mpaulosky/NewProject?color=6f42c1)](https://github.com/mpaulosky/NewProject/issues?q=is%3Aclosed+is%3Aissue)
[![Open PRs](https://img.shields.io/github/issues-pr/mpaulosky/NewProject?color=28a745)](https://github.com/mpaulosky/NewProject/pulls?q=is%3Aopen+is%3Apr)
[![Closed PRs](https://img.shields.io/github/issues-pr-closed/mpaulosky/NewProject?color=6f42c1)](https://github.com/mpaulosky/NewProject/pulls?q=is%3Aclosed+is%3Apr)

## Overview

NewProject is a full-stack web application for managing issues and tracking project progress. It demonstrates modern .NET development practices using the latest technologies and architectural patterns.

## Features

### Core Functionality

- **Issue Management**: Full CRUD operations (create, read, update, delete) for issues with validation
- **Commenting System**: Add, edit, and delete comments on issues with embedded user information
- **Status Tracking**: Track issues through configurable status workflows
- **Category Organization**: Organize issues by customizable categories
- **User Dashboard**: Personal analytics with stats cards, recent issues, and quick actions
- **Labels**: Free-form tags (up to 10 per issue) for quick categorization. Add or remove labels via the `LabelInput` tag-input component on the create and edit forms; autocomplete suggestions are served by `GET /api/labels/suggestions?prefix={prefix}&max={max}`. Filter the issue list by one or more labels using the chip selectors on the index page or the `?label=bug,v2` URL parameter.
- **Search & Filtering**: Debounced search, multi-filter support, pagination, and bookmarkable URLs

### Administration

- **Category Management**: Admin pages to create, edit, and archive categories
- **Status Management**: Admin pages to create, edit, and archive statuses
- **User Management**: Admin interface to view users, assign and remove Auth0 roles, and review a complete role-change audit log
- **Admin Dashboard**: Centralized administration panel

### Security

- **Auth0 Authentication**: Secure login with Authorization Code + PKCE flow
- **Role-Based Authorization**: Admin and User policies for fine-grained access control
- **Security Hardening**: Protection against open redirect and CSRF attacks

### User Interface

- **Dark Mode**: System-aware dark mode with manual override (light/dark/system)
- **Color Schemes**: 4 built-in themes (Blue, Red, Green, Yellow)
- **Responsive Design**: TailwindCSS v4 for modern, responsive UI
- **Theme Persistence**: User preferences saved to localStorage

## Technology Stack

### Backend

- **.NET 10** with **C# 14**
- **.NET Aspire** for orchestration and service management
- **MongoDB Atlas** with **MongoDB.EntityFrameworkCore** for data persistence
- **Redis** for distributed caching
- **MediatR** for CQRS pattern implementation
- **FluentValidation** for robust data validation

### Frontend

- **Blazor Interactive Server Rendering** for responsive UI
- **TailwindCSS v4** with `@tailwindcss/cli` for styling
- **MSBuild Integration** for automatic CSS compilation

### Observability

- **OpenTelemetry** for distributed tracing and metrics
- **Azure Application Insights** integration
- **Health Checks** for MongoDB and Redis connectivity

### DevOps

- **14 GitHub Workflows** for CI/CD automation
- **DocFX** for API documentation generation
- **CodeCov** for test coverage reporting

## Project Structure

```
NewProject/
├── src/
│   ├── AppHost/                  # .NET Aspire orchestration
│   ├── ServiceDefaults/          # Cross-cutting concerns (OpenTelemetry, health checks)
│   ├── Web/                      # Blazor Interactive Server application
│   │   ├── Components/Theme/     # ThemeProvider, ThemeToggle components
│   │   ├── Styles/               # TailwindCSS source files
│   │   └── Auth/                 # Authentication endpoints
│   ├── Domain/                   # Business logic and entities
│   │   ├── Models/               # Issue, Category, Status, Comment, User
│   │   ├── DTOs/                 # Data transfer objects
│   │   └── Abstractions/         # Result<T> pattern, IRepository<T>
│   └── Persistence.MongoDb/      # Data access layer with MongoDB EF Core
├── tests/                        # Unit, integration, and E2E tests
├── docs/                         # Documentation
└── Directory.Packages.props      # Centralized package versioning
```

## Getting Started

### Prerequisites

- .NET 10 SDK or later
- Node.js 18+ (for TailwindCSS compilation)
- MongoDB Atlas cluster (or local MongoDB)
- Redis instance (for caching)
- Auth0 tenant configuration

### Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/mpaulosky/NewProject.git
   cd NewProject
   ```

2. **Restore .NET dependencies**

   ```bash
   dotnet restore
   ```

3. **Install npm dependencies** (for TailwindCSS)

   ```bash
   cd src/Web
   npm install
   cd ../..
   ```

4. **Build the solution** (includes CSS compilation via MSBuild)

   ```bash
   dotnet build
   ```

5. **Run tests**

   ```bash
   dotnet test
   ```

6. **Run the application** (via Aspire AppHost)

   ```bash
   cd src/AppHost
   dotnet run
   ```

### TailwindCSS Development

For active CSS development with hot reload:

```bash
cd src/Web
npm run css:watch
```

This watches for changes in Razor components and automatically recompiles CSS.

### Configuration

#### User Secrets Setup

```bash
cd src/Web
dotnet user-secrets init
dotnet user-secrets set "Auth0:Domain" "your-tenant.auth0.com"
dotnet user-secrets set "Auth0:ClientId" "your-client-id"
dotnet user-secrets set "Auth0:ClientSecret" "your-client-secret"
```

#### Auth0 Configuration

1. Create an Auth0 Application (Regular Web Application)
2. Configure Allowed Callback URLs: `https://localhost:7xxx/callback`
3. Configure Allowed Logout URLs: `https://localhost:7xxx/`
4. Enable Authorization Code Flow with PKCE
5. Create roles: `Admin`, `User`

#### Environment Variables

| Variable | Description |
|----------|-------------|
| `Auth0__Domain` | Auth0 tenant domain |
| `Auth0__ClientId` | Auth0 application client ID |
| `Auth0__ClientSecret` | Auth0 application client secret |
| `ConnectionStrings__mongodb` | MongoDB connection string |
| `ConnectionStrings__redis` | Redis connection string |

## Theming

NewProject supports dark mode and multiple color schemes. See [docs/THEMING.md](docs/THEMING.md) for details.

### Quick Start

- **Toggle Theme**: Click the theme toggle button in the header
- **Change Color**: Select from Blue, Red, Green, or Yellow schemes
- **System Mode**: Follows your OS dark/light preference

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - Solution architecture overview
- [FEATURES.md](docs/FEATURES.md) - Detailed feature documentation
- [THEMING.md](docs/THEMING.md) - Theming and customization guide
- [LIBRARIES.md](docs/LIBRARIES.md) - NuGet and npm package references
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) - Contribution guidelines
- [SECURITY.md](docs/SECURITY.md) - Security guidelines
- [CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) - Community standards

## Architecture

### Domain Layer

- **Result&lt;T&gt; Pattern**: Explicit success/failure handling with `ResultErrorCode` enum
- **Models**: `Issue`, `Category`, `Status`, `Comment`, `User` (embedded document)
- **DTOs**: Strongly-typed data transfer objects for API boundaries
- **Repository Interface**: Generic `IRepository<T>` for data access abstraction

### Persistence Layer

- **IssueTrackerDbContext**: MongoDB EF Core context with configuration
- **Entity Configurations**: Fluent API configuration for MongoDB mapping
- **Change Tracking**: Automatic persistence with async operations

### Web Layer

- **Authentication Endpoints**: `/login`, `/logout` with security hardening
- **Theme Components**: `ThemeProvider` cascading parameter, `ThemeToggle` UI
- **JavaScript Interop**: `themeManager` for localStorage persistence

## Testing

The project includes multiple testing layers:

- **Unit Tests**: Business logic validation with NSubstitute mocks
- **Integration Tests**: Full application testing with TestContainers
- **Blazor Component Tests**: bUnit for UI component verification
- **E2E Tests**: Playwright for browser-based testing
- **Architecture Tests**: Verify project dependencies and conventions

## API Documentation

API endpoints are documented with OpenAPI 3.0+ specifications via Scalar:

- Navigate to `/api/docs` to view interactive API documentation
- All REST endpoints include XML documentation comments
- Request/response schemas are auto-generated from models

## Dev Blog

<!-- BLOG_START -->
| Date | Title | Tags |
|------|-------|------|
| 2026-03-30 | [Release v0.2.0 — Features, Fixes & Developer Tooling](docs/blog/2026-03-30-release-v0-2-0.md) | release, v0.2.0 |
| 2026-03-27 | [Adding AppHost.Tests — Aspire Integration + Playwright E2E Tests](docs/blog/2026-03-27-apphost-aspire-playwright-e2e-tests.md) | tests, aspire, playwright, e2e |
<!-- BLOG_END -->

View all posts → [docs/blog/index.md](docs/blog/index.md)

## License

Licensed under the MIT License. See [LICENSE](LICENSE) file for details.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines.

---

**Status**: Active Development | **Latest Release**: .NET 10 | **Maintained By**: @mpaulosky
