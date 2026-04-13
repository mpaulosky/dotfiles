---
name: testcontainers-shared-fixture
confidence: high
description: >
  Pattern for sharing a single MongoDbContainer across all test classes in an xUnit collection
  using ICollectionFixture<MongoDbFixture>. Reduces container startup overhead and enables
  parallel test collection execution. Established when optimizing Api.Tests.Integration
  from 23 per-class containers to 4 parallel domain collections.
---

## Testcontainers Shared Fixture Pattern

### Why This Exists

Each test class that owns its own `MongoDbContainer` costs ~2 seconds of startup time.
With 23 test classes, that's ~46 seconds wasted. This skill replaces per-class containers
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

[CollectionDefinition("CategoryIntegration")]
public class CategoryIntegrationCollection : ICollectionFixture<MongoDbFixture> { }

[CollectionDefinition("IssueIntegration")]
public class IssueIntegrationCollection : ICollectionFixture<MongoDbFixture> { }

[CollectionDefinition("CommentIntegration")]
public class CommentIntegrationCollection : ICollectionFixture<MongoDbFixture> { }

[CollectionDefinition("StatusIntegration")]
public class StatusIntegrationCollection : ICollectionFixture<MongoDbFixture> { }
```

#### 3. Test Class (receives fixture via constructor injection)

```csharp
[Collection("CategoryIntegration")]
[ExcludeFromCodeCoverage]
public class CreateCategoryHandlerIntegrationTests
{
    private readonly ICategoryRepository _repository;
    private readonly CreateCategoryHandler _handler;

    public CreateCategoryHandlerIntegrationTests(MongoDbFixture fixture)
    {
        // CRITICAL: Use Guid for unique DB per test method
        // xUnit creates a new class instance per test method — each gets a fresh DB
        _repository = new CategoryRepository(fixture.ConnectionString, $"T{Guid.NewGuid():N}");
        _handler = new CreateCategoryHandler(_repository, new CreateCategoryValidator());
    }

    [Fact]
    public async Task Handle_ValidCommand_CreatesCategory()
    {
        // Arrange
        var command = new CreateCategoryCommand { CategoryName = "New Category", ... };

        // Act
        var result = await _handler.Handle(command, TestContext.Current.CancellationToken);

        // Assert
        result.Should().NotBeNull();
        result.CategoryName.Should().Be("New Category");
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

2. **Domain grouping:** Group test classes by domain entity (Category, Issue, Comment, Status).
   Classes within the same domain share one container. Different domains run in parallel.

3. **No `IAsyncLifetime` on test class** unless there's OTHER async setup beyond the container.
   The fixture handles container lifecycle. Test setup goes in the constructor.

4. **`parallelizeAssembly: false`** — keep this. We want collection-level parallelism,
   not test-method-level within a collection.

### Domain Mapping (IssueManager)

| Collection | Test Classes |
|---|---|
| `CategoryIntegration` | CreateCategory, GetCategory, ListCategories, UpdateCategory, CategoryRepository |
| `IssueIntegration` | CreateIssue, DeleteIssue (×2), GetIssue, ListIssues, UpdateIssue, UpdateIssueStatus, IssueRepositorySearch, IssueRepository |
| `CommentIntegration` | CreateComment, DeleteComment, GetComment, ListComments, UpdateComment |
| `StatusIntegration` | CreateStatus, GetStatus, ListStatuses, UpdateStatus |

### Performance Gain

- **Before:** 23 containers × ~2s startup = ~46s overhead, all sequential
- **After:** 4 containers starting in parallel = ~2s overhead
- **Expected CI improvement:** 5–10 min → ~2–3 min

### GlobalUsings.cs

Add the fixture namespace so test files don't need explicit using statements:

```csharp
global using Integration.Fixtures;
```

**Import ordering:** `Integration.Fixtures` sorts alphabetically between `FluentValidation` and `MongoDB.Bson`. The `dotnet format` tool enforces this — run it before pushing.
