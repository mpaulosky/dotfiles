---
name: testcontainers-shared-fixture
confidence: high
description: >
  Pattern for sharing a single MongoDbContainer across all test classes in an xUnit collection
  using ICollectionFixture<MongoDbFixture>. Reduces container startup overhead and enables
  parallel test collection execution. Established when optimizing integration tests
  from per-class containers to parallel domain collections.
---

## Testcontainers Shared Fixture Pattern

### Why This Exists

Each test class that owns its own `MongoDbContainer` costs ~2 seconds of startup time.
With many test classes, that overhead adds up quickly. This skill replaces per-class containers
with a shared fixture that starts once per xUnit collection.

### The Pattern

#### 1. MongoDbFixture (shared startup/teardown)

```csharp
// Fixtures/MongoDbFixture.cs
namespace Integration.Fixtures;

public sealed class MongoDbFixture : IAsyncLifetime
{
    private const string MongodbImage = "mongo:latest";
    private readonly MongoDbContainer _mongoContainer = new MongoDbBuilder(MongodbImage)
            .Build();

    public string ConnectionString => _mongoContainer.GetConnectionString();

    public async ValueTask InitializeAsync() => await _mongoContainer.StartAsync();

    public async ValueTask DisposeAsync()
    {
        await _mongoContainer.StopAsync();
        await _mongoContainer.DisposeAsync();
    }
}
```

#### 2. Collection Definitions

```csharp
// Fixtures/IntegrationTestCollection.cs
namespace Integration.Fixtures;

[CollectionDefinition("{EntityName}Integration")]
public class {EntityName}IntegrationCollection : ICollectionFixture<MongoDbFixture> { }

// Add one collection definition per domain entity, e.g.:
// [CollectionDefinition("OrderIntegration")]
// public class OrderIntegrationCollection : ICollectionFixture<MongoDbFixture> { }
```

#### 3. Test Class (receives fixture via constructor injection)

```csharp
[Collection("{EntityName}Integration")]
[ExcludeFromCodeCoverage]
public class Create{EntityName}HandlerIntegrationTests
{
    private readonly I{EntityName}Repository _repository;
    private readonly Create{EntityName}Handler _handler;

    public Create{EntityName}HandlerIntegrationTests(MongoDbFixture fixture)
    {
        // CRITICAL: Use Guid for unique DB per test method
        // xUnit creates a new class instance per test method — each gets a fresh DB
        _repository = new {EntityName}Repository(fixture.ConnectionString, $"T{Guid.NewGuid():N}");
        _handler = new Create{EntityName}Handler(_repository, new Create{EntityName}Validator());
    }

    [Fact]
    public async Task Handle_ValidCommand_Creates{EntityName}()
    {
        // Arrange
        var command = new Create{EntityName}Command { Name = "Test Entity", ... };

        // Act
        var result = await _handler.Handle(command, TestContext.Current.CancellationToken);

        // Assert
        result.Should().NotBeNull();
        result.Name.Should().Be("Test Entity");
    }
}
```

#### 4. xunit.runner.json — Enable parallel collections

```json
{
  "methodDisplay": "method",
  "methodDisplayOptions": "all",
  "parallelizeAssembly": false,
  "parallelizeTestCollections": true
}
```

### Critical Rules

1. **Unique DB per test method:** Use `$"T{Guid.NewGuid():N}"` as the database name.
   - xUnit creates a new class instance per test method
   - Guid in constructor = new DB per method = full isolation within shared container
   - `T` prefix + 32 hex chars = 33 chars (well under MongoDB's 64-char limit)

2. **Domain grouping:** Group test classes by domain entity.
   Classes within the same domain share one container. Different domains run in parallel.

3. **No `IAsyncLifetime` on test class** unless there's OTHER async setup beyond the container.
   The fixture handles container lifecycle. Test setup goes in the constructor.

4. **`parallelizeAssembly: false`** — keep this. We want collection-level parallelism,
   not test-method-level within a collection.

### Domain Mapping (Template)

| Collection | Test Classes |
|---|---|
| `{EntityName}Integration` | Create{EntityName}, Get{EntityName}, List{EntityName}s, Update{EntityName}, {EntityName}Repository |
| `{EntityName2}Integration` | Create{EntityName2}, Get{EntityName2}, List{EntityName2}s, Update{EntityName2} |

> Add one row per domain entity. Group all CRUD handler tests and repository tests for that entity.

### Performance Gain

- **Before:** N containers × ~2s startup = ~(2N)s overhead, all sequential
- **After:** K domain containers starting in parallel = ~2s overhead
- **Expected CI improvement:** significant reduction depending on test count

### GlobalUsings.cs

Add the fixture namespace so test files don't need explicit using statements:

```csharp
global using Integration.Fixtures;
```

**Import ordering:** `Integration.Fixtures` sorts alphabetically between `FluentValidation` and `MongoDB.Bson`. The `dotnet format` tool enforces this — run it before pushing.
