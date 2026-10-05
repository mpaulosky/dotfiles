# Entry points and key files by project type

## Web API / MVC / Razor Pages

- `Program.cs`: top-level statements, `builder.Services` registrations, middleware, `app.Map*` endpoints.
- `appsettings.json`, `appsettings.{Environment}.json`.
- Endpoints: minimal APIs in `Program.cs` or under `Endpoints/`; controllers under `Controllers/`.
- No `Properties/launchSettings.json`: note it runs on default Kestrel settings and suggest adding launch profiles.

## Console

- `Program.cs` (top-level statements or `static void Main`).
- `appsettings.json` if it uses the Generic Host (`IHostBuilder`).

## Worker Service

- `Program.cs` with `builder.Services.AddHostedService<Worker>()`.
- The `BackgroundService` subclass and its `ExecuteAsync`.

## Class Library

- No entry point: summarise the public API surface (public classes and interfaces in the primary namespace).

## Blazor

- `Program.cs` with component registration.
- Root component `App.razor` or `Routes.razor`; `MainLayout.razor` in `Layout/` or `Shared/`.
- Pages: `.razor` files with an `@page` directive.

## MAUI

- `MauiProgram.cs` with `CreateMauiApp()`; `AppShell.xaml` for navigation.
- Pages under `Views/` or `Pages/`; platform code under `Platforms/` (Android, iOS, Windows, MacCatalyst).

## Test

- Test files: `[Fact]`, `[Theory]`, `[Test]` or `[TestMethod]`.
- Fixtures: `IClassFixture<T>` / `ICollectionFixture<T>`.
- Integration tests: `WebApplicationFactory<T>`.
