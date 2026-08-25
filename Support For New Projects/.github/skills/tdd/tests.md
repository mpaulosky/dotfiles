## Good and Bad Tests

Examples below use a modern .NET stack: C#, xUnit v3,
FluentAssertions, NSubstitute, and bUnit.

### Good Tests

**Behavior-first**: test through a public interface or visible UI surface and
assert the outcome a caller actually cares about.

```csharp
[Fact]
public void OrdersPage_WhenNoOrdersExist_ShowsEmptyState()
{
    // Arrange
    var sender = Substitute.For<ISender>();
    sender.Send(Arg.Any<GetOrdersQuery>(), Arg.Any<CancellationToken>())
        .Returns(Task.FromResult(
            Result.Ok<IReadOnlyList<OrderSummaryDto>>(Array.Empty<OrderSummaryDto>())));
    Services.AddSingleton(sender);

    // Act
    var cut = RenderComponent<OrdersPage>();

    // Assert
    cut.Markup.Should().Contain("No orders yet.");
}
```

Characteristics:

- Tests behavior users and callers care about
- Uses the public API or rendered UI surface only
- Survives internal refactors
- Describes WHAT, not HOW
- Keeps assertions focused on the observable outcome

### Bad Tests

**Implementation-detail tests**: coupled to internal structure or obsessed with
the mechanics instead of the result.

```csharp
[Fact]
public async Task Handle_CallsRepositoryBeforeReturning()
{
    // Arrange
    var repo = Substitute.For<IOrderRepository>();
    var cache = Substitute.For<IOrderCacheService>();
    var sut = new GetOrdersHandler(repo, cache);

    cache.GetOrFetchAllAsync(
            Arg.Any<Func<Task<IReadOnlyList<OrderSummaryDto>>>>(),
            Arg.Any<CancellationToken>())
        .Returns(new ValueTask<IReadOnlyList<OrderSummaryDto>>(
            Array.Empty<OrderSummaryDto>()));

    // Act
    await sut.Handle(new GetOrdersQuery(), CancellationToken.None);

    // Assert
    await repo.Received(1).GetAllAsync(Arg.Any<CancellationToken>());
}
```

Red flags:

- Mocking internal collaborators instead of proving behavior
- Testing private methods
- Asserting on call counts or order as the primary outcome
- Test breaks when refactoring without behavior change
- Test name describes HOW, not WHAT
- Verifying persistence details directly instead of going back through the
  feature interface

```csharp
[Fact]
public async Task CreateOrder_WritesRowToDatabase()
{
    // Arrange
    var command = new CreateOrderCommand("ORD-1001", 125m);

    // Act
    var created = await createHandler.Handle(command, CancellationToken.None);

    // Assert
    var saved = await dbContext.Orders
        .SingleOrDefaultAsync(order => order.Id == created.Value, cancellationToken);
    saved.Should().NotBeNull();
}

[Fact]
public async Task CreateOrder_MakesOrderRetrievableThroughTheFeature()
{
    // Arrange
    var command = new CreateOrderCommand("ORD-1001", 125m);

    // Act
    var created = await createHandler.Handle(command, CancellationToken.None);
    var fetched = await getByIdHandler.Handle(
        new GetOrderByIdQuery(created.Value),
        CancellationToken.None);

    // Assert
    fetched.Value!.Number.Should().Be("ORD-1001");
}
```
