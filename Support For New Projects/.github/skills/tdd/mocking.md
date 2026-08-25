## When to Mock

Examples below use C#, xUnit, FluentAssertions, and NSubstitute.

Mock at **system boundaries** and infrastructure seams:

- External HTTP APIs and SDKs, such as identity-provider or partner API calls
  behind `IHttpClientFactory`
- Repository and cache abstractions used by handlers, such as
  `IOrderRepository` and `IOrderCacheService`
- Configuration, time, randomness, and other nondeterministic inputs
- UI-facing service seams in bUnit tests, such as `ISender`

Prefer real implementations for:

- Domain entities and value objects such as `Order`
- The class under test
- Internal behavior that can be exercised through the public API
- Real infrastructure in integration tests, when that gives better confidence
  than deep mock setups

The key distinction is practical: unit tests substitute interfaces that
represent infrastructure boundaries, but they do not mock the domain model
just to make tests easier to write.

## Designing for Mockability

At those boundaries, design abstractions that are easy to substitute and easy
to reason about.

### 1. Use constructor injection

Pass dependencies in rather than creating them internally:

```csharp
// Easy to substitute in tests
public sealed class UserDirectoryHandler
{
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;

  public UserDirectoryHandler(
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory)
    {
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;
    }
}

// Hard to substitute in tests
public sealed class UserDirectoryHandler
{
    public async Task<Result> Handle(
    GetUsersQuery request,
        CancellationToken cancellationToken)
    {
        var configuration = new ConfigurationBuilder().Build();
        using var client = new HttpClient();

        // ... real network and configuration setup hidden inside ...
        return Result.Ok();
    }
}
```

Well-factored .NET applications often follow this pattern by creating
substitutes as readonly fields and instantiating the system under test in the
test class constructor.

### 2. Prefer narrow, intention-revealing interfaces

Give each dependency a small surface area with methods that express real use
cases. This keeps test setup focused and avoids giant conditional substitutes.

```csharp
public interface IOrderCacheService
{
  ValueTask<IReadOnlyList<OrderSummaryDto>> GetOrFetchAllAsync(
    Func<Task<IReadOnlyList<OrderSummaryDto>>> fetch,
        CancellationToken cancellationToken);

    Task InvalidateAllAsync(CancellationToken cancellationToken);
    Task InvalidateByIdAsync(Guid id, CancellationToken cancellationToken);
}

public interface IRemoteGateway
{
    Task<object?> ExecuteAsync(
        string operation,
        object payload,
        CancellationToken cancellationToken);
}
```

`IOrderCacheService` is easy to substitute because each method has one clear
purpose. `IRemoteGateway.ExecuteAsync(...)` pushes branching and type-casting
into the test setup, which usually leads to brittle tests and confused future
you. Future you already has enough hobbies.

### 3. Assert behavior first; verify interactions only at the boundary

In many .NET codebases, interaction assertions are acceptable when the
interaction itself is
the boundary behavior you care about. Keep those assertions narrow and avoid
turning tests into call-count archaeology.

```csharp
[Fact]
public async Task Handle_CacheMiss_CallsRepoAndReturnsDtos()
{
    // Arrange
  var repo = Substitute.For<IOrderRepository>();
  var cache = Substitute.For<IOrderCacheService>();
  var sut = new GetOrdersHandler(repo, cache);
  var order = Order.Create("ORD-1001", 125m);

    repo.GetAllAsync(Arg.Any<CancellationToken>())
    .Returns([order]);

    cache.GetOrFetchAllAsync(
      Arg.Any<Func<Task<IReadOnlyList<OrderSummaryDto>>>>(),
            Arg.Any<CancellationToken>())
        .Returns(ci =>
        {
      var fetch = ci.Arg<Func<Task<IReadOnlyList<OrderSummaryDto>>>>();
      return new ValueTask<IReadOnlyList<OrderSummaryDto>>(fetch());
        });

    // Act
  var result = await sut.Handle(new GetOrdersQuery(), CancellationToken.None);

    // Assert
    result.Success.Should().BeTrue();
  result.Value.Should().ContainSingle(dto => dto.Number == "ORD-1001");
    await repo.Received(1).GetAllAsync(Arg.Any<CancellationToken>());
}
```

Good boundary assertions usually look like:

- `Received(1)` or `DidNotReceive()` on repository, cache, mediator, or HTTP
  factory substitutes
- `Arg.Is<T>(...)` when the payload matters, especially for commands in bUnit
  tests
- A behavior assertion first, followed by the minimum useful interaction check

Avoid asserting call order, every intermediate method call, or implementation
details that would change during a harmless refactor.

### 4. Prefer test seams over framework-specific mocking hacks

If a framework type is awkward to substitute, wrap it in a small abstraction
first. That is exactly why well-factored applications more often substitute
`IOrderCacheService` than `IMemoryCache` directly.

If you do need to mock `IMemoryCache`, remember:

- `Set<T>` is an extension method, so NSubstitute cannot intercept it directly
- mock `CreateEntry()` instead
- `TryGetValue()` requires the out-parameter pattern

```csharp
var cache = Substitute.For<IMemoryCache>();
var cacheEntry = Substitute.For<ICacheEntry>();
cache.CreateEntry(Arg.Any<object>()).Returns(cacheEntry);

object? cached = null;
cache.TryGetValue(Arg.Any<object>(), out cached)
    .Returns(call =>
    {
        call[1] = new OrderSummaryDto(
            Guid.NewGuid(),
      "ORD-1001",
      125m,
      "Pending");
        return true;
    });
```

The same principle applies to `HttpClient`: prefer `IHttpClientFactory` or a
small stub `HttpMessageHandler` rather than hiding network calls inside the
class under test.

## Common .NET Usage

In a typical .NET codebase, mocking often follows a few clear patterns:

- **Handler or service unit tests** substitute infrastructure-facing
  dependencies such as repositories, caches, configuration, and outbound HTTP
- **bUnit component tests** register substitutes in the test `Services`
  collection, often `ISender`, `IMediator`, or view-model services
- **Domain tests** usually construct real domain types and assert state changes
  directly instead of mocking them
- **Integration tests** prefer real infrastructure and end-to-end behavior over
  mocked persistence when confidence matters most

Representative examples:

- `GetOrdersHandlerTests` substitutes repository and cache seams
- `UserDirectoryHandlerTests` substitutes configuration and HTTP factory, then
  uses a stub `HttpMessageHandler` to shape HTTP responses
- `OrdersPageTests` registers a substitute `ISender` and verifies the correct
  command payload is dispatched from a Blazor component

## Quick Rules

- Mock boundaries, not the thing you are trying to prove works
- Prefer small interfaces over generic gateways
- Use constructor injection so substitutes are easy to provide
- In unit tests, substitute repository, cache, configuration, mediator, and
  outbound HTTP seams when needed
- In integration tests, prefer a real database or dependable local stand-in
  instead of simulating everything with mocks
- Keep assertions behavior-focused and use `Received()` only where the boundary
  interaction matters
