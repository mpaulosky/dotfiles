---
mode: 'agent'
tools: ['edit', 'search', 'new', 'runCommands', 'runTasks', 'playwright/*', 'microsoft.docs.mcp/*', 'mongodb/*', 'usages', 'vscodeAPI', 'think', 'problems', 'changes', 'testFailure', 'openSimpleBrowser', 'fetch', 'githubRepo', 'extensions', 'todos']
description: "Guidance and examples for writing robust C# xUnit integration tests (hosts, fixtures, Playwright, DB, and environment setup)"
---

# XUnit Integration Testing Best Practices

You are an expert test developer and yourur goal is to help me write robust integration tests for a .NET web application
using xUnit v3 and related tooling. Focus on realistic integration scenarios: running against an in-memory or test
database, exercising the real application host (TestServer or WebApplicationFactory), exercising HTTP endpoints,
background services, and full-stack browser tests with Playwright/bUnit where appropriate. Provide clear examples,
idiomatic patterns, and reusable fixtures.

## Quick Tips

- Use a dedicated integration test project named `[ProjectName].Tests.Integration`.
- Keep integration tests isolated and repeatable: reset or recreate test data between tests, use transactions with
  rollbacks, or run against ephemeral databases (SQLite in-memory, LocalDB, or containers).
- Prefer `WebApplicationFactory<TEntryPoint>` / `TestServer` or `WebApplicationFactory`-derived factories to host the
  app in-process.
- Use explicit environment configuration (e.g., `ASPNETCORE_ENVIRONMENT=Integration`) and separate
  `appsettings.Integration.json` when needed.
- Use `IAsyncLifetime` / fixtures for setup and teardown of expensive resources (database, message brokers, Playwright
  browser). Use `CollectionFixture` to share expensive setup across tests.

## Project Setup

- Use the .NET SDK test project format and target the same framework as the main app (e.g., `net7.0`).
- Recommended package references:
  ```xml
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="*" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
    <PackageReference Include="xunit.v3" />
    <PackageReference Include="xunit.v3.runner.visualstudio" />
    <PackageReference Include="FluentAssertions" />
  <PackageReference Include="Playwright" /> <!-- optional: for E2E browser tests -->
  <PackageReference Include="Respawn" /> <!-- optional: for DB reset between tests -->
  <PackageReference Include="DotNet.Testcontainers" /> <!-- use Testcontainers to spin up real DBs for integration tests -->
  </ItemGroup>
  ```

## Hosting the App In-Process

- Derive from `WebApplicationFactory<TEntryPoint>` to customize configuration and DI for tests. Override
  `ConfigureWebHost` to replace real services with test doubles or add test-only configuration.
- Example factory pattern:

````csharp
public class TestAppFactory : WebApplicationFactory<Program>
{
  protected override void ConfigureWebHost(IWebHostBuilder builder)
  {
    builder.ConfigureAppConfiguration((context, config) =>
    {
      // add test configuration files or in-memory settings
    });

    builder.ConfigureServices(services =>
    {
      // replace DB context with in-memory or test connection
      // remove hosted services you don't want running during tests
    });
  }
}
````

## Database Strategies (Testcontainers-first)

- Use real database instances running in containers for full fidelity and fewer surprises between test and production
  environments. Prefer `DotNet.Testcontainers` to spin up ephemeral containers during test setup.
- Recommended approach:
  - Spin up a database container (Postgres, SQL Server, MySQL) in a shared collection fixture using
    `DotNet.Testcontainers`.
  - Run EF Core migrations against the container database at fixture initialization.
  - Use `Respawn` (or manual cleanup) between tests to ensure a clean state, or recreate the database/schema per test
    collection if faster.
- Advantages:
  - Tests run against a real engine, catching engine-specific behaviors (SQL nuances, collations, extensions).
  - Works consistently in CI when Docker is available.
- CI notes: ensure the CI runner supports Docker or use a self-hosted runner; alternatively run the DB container as a
  service in the pipeline.

### Example: Testcontainers Database Fixture (Postgres)

````csharp
public class TestPostgresFixture : IAsyncLifetime
{
  public string ConnectionString { get; private set; }
  private readonly TestcontainersContainer _container;

  public TestPostgresFixture()
  {
    _container = new TestcontainersBuilder<TestcontainersContainer>()
      .WithImage("postgres:15-alpine")
      .WithEnvironment("POSTGRES_PASSWORD", "test")
      .WithEnvironment("POSTGRES_USER", "test")
      .WithEnvironment("POSTGRES_DB", "testdb")
      .WithPortBinding(5432, assignRandomHostPort: true)
      .WithWaitStrategy(Wait.ForUnixContainer().UntilPortIsAvailable(5432))
      .Build();
  }

  public async Task InitializeAsync()
  {
    await _container.StartAsync();

    var hostPort = _container.GetMappedPublicPort(5432);
    ConnectionString = $"Host=localhost;Port={hostPort};Username=test;Password=test;Database=testdb";

    // Run EF Core migrations here using the ConnectionString to prepare schema
  }

  public async Task DisposeAsync()
  {
    await _container.StopAsync();
    await _container.DisposeAsync();
  }
}
````

### Wiring Testcontainers into WebApplicationFactory

- In your `WebApplicationFactory` override, replace the application's DB connection string with the fixture-provided
  `ConnectionString` and ensure migrations run before tests execute.
- Example in `ConfigureServices`:

````csharp
builder.ConfigureServices(services =>
{
  // remove existing DbContext registration and add one that uses fixture.ConnectionString
});
````

### Resetting DB state

- Use `Respawn` against the Testcontainers database to truncate/reset between tests if you need to reuse the same DB
  instance.
- For absolute isolation, consider creating a new schema or new database per test and dropping it afterwards (costlier
  but eliminates cross-test interference).

## Reusable Fixtures and Lifetimes

- For expensive shared resources, implement `IAsyncLifetime` in a fixture class and use `CollectionFixture<T>` to share
  across tests.
- Example: shared `TestAppFactory` and `TestDatabaseFixture` used via a collection:

````csharp
[CollectionDefinition("IntegrationTests")]
public class IntegrationTestsCollection : ICollectionFixture<TestAppFactory>, ICollectionFixture<TestDatabaseFixture>
{
}

/// <summary>
/// Unit tests for the <see cref="Article"/> class.
/// </summary>
[ExcludeFromCodeCoverage]
[TestSubject(typeof(Article))]
[Collection("IntegrationTests")]
public class ArticleTests
{
  private readonly TestAppFactory _factory;
  private readonly TestDatabaseFixture _db;

  public SomeIntegrationTests(TestAppFactory factory, TestDatabaseFixture db)
  {
    _factory = factory;
    _db = db;
  }

  [Fact]
  public async Task Get_Endpoint_ReturnsOk()
  {
    // Arrange
    var client = _factory.CreateClient();

    // Act
    var response = await client.GetAsync("/api/values");

    // Assert
    response.EnsureSuccessStatusCode();
  }
}
````

## Playwright and Browser-based E2E

- For full-browser tests use Playwright; manage the browser lifecycle in a shared fixture to avoid expensive repeated
  startup.
- Use `Playwright.CreateAsync()` and `IBrowser` shared across tests or per-collection. Close/dispose in fixture
  teardown.
- Protect credentials and secrets: use CI-provided secrets and do not commit sensitive data.

## Environment and Configuration

- Use explicit environment variables for integration tests (database connection strings, external service endpoints).
- Provide a sample `appsettings.Integration.json` and a mechanism in the test factory to load it when
  `ASPNETCORE_ENVIRONMENT=Integration`.

## Example: Database-backed Integration Test (EF Core)

````csharp
[Collection("IntegrationTests")]
public class ArticlesEndpointTests
{
  private readonly HttpClient _client;

  public ArticlesEndpointTests(TestAppFactory factory)
  {
    _client = factory.CreateClient();
  }

  [Fact]
  public async Task GetArticle_ReturnsArticleDto()
  {
    // Arrange: seed DB (via fixture or helper)

    // Act
    var res = await _client.GetAsync("/api/articles/1");
    res.EnsureSuccessStatusCode();

    var dto = await res.Content.ReadFromJsonAsync<ArticleDto>();

    // Assert
    dto.Should().NotBeNull();
    dto.Id.Should().Be(1);
  }
}
````

## Edge Cases and Guidance

- Network/timeouts: set generous timeouts for integration tests but fail fast on obvious configuration errors.
- Flaky external services: stub or run a local emulator where possible. Use service virtualization for dependencies like
  SMTP, queues, or external APIs.
- Parallelization: run independent tests in parallel, but for shared resources (e.g., a single test DB) use collections
  to serialize tests when necessary.

## Test Naming and Structure

- Use clear names: `Endpoint_Action_ExpectedResult` (e.g., `GetArticles_WhenExists_Returns200WithList`).
- Keep tests focused on single behaviors; don't combine many assertions testing distinct behavior.

## Example: Playwright E2E Test Fixture

````csharp
public class PlaywrightFixture : IAsyncLifetime
{
  public IPlaywright Playwright { get; private set; }
  public IBrowser Browser { get; private set; }

  public async Task InitializeAsync()
  {
    Playwright = await Playwright.CreateAsync();
    Browser = await Playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions { Headless = true });
  }

  public async Task DisposeAsync()
  {
    await Browser?.CloseAsync();
    Playwright?.Dispose();
  }
}
````

## CI Considerations

- Use Docker Compose for reproducible services (DB, Redis, etc.) in CI and tear them down after tests.
- Cache Playwright browsers in CI to reduce setup time.
- Run integration tests in a separate pipeline stage so failures do not block quick CI feedback from unit tests.

## Useful Libraries

- `Microsoft.AspNetCore.Mvc.Testing` – host app in tests
- `Respawn` – reset DB state between tests
- `Playwright` – browser E2E tests
- `DotNet.Testcontainers` – run ephemeral containers for DBs and services

## Small Checklist

- [ ] Use `WebApplicationFactory` or TestServer to host the app
- [ ] Use deterministic/ephemeral DB strategy
- [ ] Seed test data in fixtures
- [ ] Use `CollectionFixture` for shared resources
- [ ] Add `appsettings.Integration.json` and explicit environment settings
- [ ] Add CI job/stage for integration tests

Project setup (packages & templates)

- Recommended packages: xunit, xunit.runner.visualstudio, Microsoft.NET.Test.Sdk, Microsoft.AspNetCore.Mvc.Testing,
  DotNet.Testcontainers, Npgsql.EntityFrameworkCore.PostgreSQL, FluentAssertions, Respawn (optional).
- Recommended project template: create a new test project using the xUnit template (e.g.,
  `dotnet new xunit -n Web.Tests.Integration`) and add the packages above.

# Aspire projects

- If the solution is using the Aspire framework, create the integration test project from the "aspire-xunit" project
  template (e.g., `dotnet new aspire-xunit -n Web.Tests.Integration`) instead of the default xunit template. The "
  aspire-xunit" template ensures Aspire-specific test helpers, DI wiring, and conventions are present so the
  Testcontainers fixture and WebApplicationFactory integrate cleanly with the application's Aspire wiring.

# Database strategy (Testcontainers-first)

- Use DotNet.Testcontainers to run a real Postgres (or other) container per suite and a unique database name per
  factory/test to isolate state.

name: Integration Tests

on:
workflow_dispatch:
push:
paths:
- 'tests/Web.Tests.Integration/**'
- '.github/workflows/integration-tests.yml'

jobs:
integration:
runs-on: ubuntu-latest
env:
DOTNET_CLI_TELEMETRY_OPTOUT: '1'
steps:
- name: Checkout repo
uses: actions/checkout@v4

      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '9.0.x'

      - name: Ensure Docker is available
        run: docker version

      - name: Restore
        run: dotnet restore

      - name: Build
        run: dotnet build --configuration Release --no-restore

      - name: Run integration tests
        run: dotnet test tests/Web.Tests.Integration/Web.Tests.Integration.csproj --logger "trx;LogFileName=integration.trx" --verbosity normal --no-build
        env:
          DOTNET_TEST_CONTAINER_OVERRIDE: 'true'

``````
