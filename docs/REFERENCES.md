# References Used In AINotesApp

## Technologies & Frameworks

- [.NET 10](https://dotnet.microsoft.com/download/dotnet/10.0) – Main platform
- [C# 14.0](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-14) – Latest C# language features
- [Blazor Web App](https://learn.microsoft.com/aspnet/core/blazor/) – Interactive server-side rendering UI framework
- [ASP.NET Core Identity](https://learn.microsoft.com/aspnet/core/security/authentication/identity) – Authentication and authorization
- [Entity Framework Core 10.0](https://learn.microsoft.com/ef/core/) – ORM for database access with code-first migrations
- [SQL Server Express](https://www.microsoft.com/sql-server/sql-server-downloads) – Local database for data persistence
- [MediatR](https://github.com/jbogard/MediatR) – Mediator pattern implementation for CQRS
- [Blazored.TextEditor](https://github.com/Blazored/TextEditor) – Rich text editor component
- [OpenAI SDK](https://github.com/openai/openai-dotnet) – AI integration capabilities

## Testing Tools

- [xUnit](https://xunit.net/) – Unit and integration test framework (`tests/`)
- [FluentAssertions](https://fluentassertions.com/) – Fluent assertion library for all tests
- [NSubstitute](https://nsubstitute.github.io/) – Mocking library for unit tests
- [BUnit](https://bunit.dev/) – Blazor component testing framework for rendering and interaction tests
- [AngleSharp](https://anglesharp.github.io/) – HTML parser used by BUnit for DOM assertions
- [NetArchTest.Rules](https://github.com/BenMorris/NetArchTest) – Architecture testing (`tests/AINotesApp.Tests.Architecture`)

- [Microsoft.EntityFrameworkCore.InMemory](https://learn.microsoft.com/ef/core/providers/in-memory/) – In-memory database for unit tests
- [Microsoft.AspNetCore.Mvc.Testing](https://learn.microsoft.com/aspnet/core/test/integration-tests) – Integration testing support
- [Coverlet](https://github.com/coverlet-coverage/coverlet) – Code coverage collection

## Workflows & Actions

- [GitHub Actions](https://github.com/features/actions) – CI/CD for build, test, and deploy (planned)

## Development Tools

- [Visual Studio 2022](https://visualstudio.microsoft.com/) – Primary IDE
- [JetBrains Rider](https://www.jetbrains.com/rider/) – Alternative IDE
- [Visual Studio Code](https://code.visualstudio.com/) – Lightweight editor, cross-platform

## Architecture & Patterns

- [Vertical Slice Architecture](https://www.jimmybogard.com/vertical-slice-architecture/) – Features organized by business capability rather than technical concerns
- [CQRS Pattern](https://learn.microsoft.com/azure/architecture/patterns/cqrs) – Command Query Responsibility Segregation for separating read and write operations
- [Dependency Injection](https://learn.microsoft.com/aspnet/core/fundamentals/dependency-injection) – Built-in ASP.NET Core DI container
- [Records](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) – Immutable DTOs for Commands, Queries, and Responses
