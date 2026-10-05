# Test Doubles: Examples and Anti-Patterns

## Stub vs Mock vs Fake

```csharp
// STUB: Returns canned data -- verifying the code under test's logic
var priceService = Substitute.For<IPriceService>();
priceService.GetPriceAsync("SKU-001").Returns(29.99m);  // canned return

var total = await calculator.CalculateTotalAsync(items);
Assert.Equal(59.98m, total);  // assert on the result, not the call

// MOCK: Verifies interaction -- ensuring a side effect happened
var emailSender = Substitute.For<IEmailSender>();

await orderService.CompleteAsync(order);

await emailSender.Received(1).SendAsync(             // assert on the call
    Arg.Is<string>(to => to == order.CustomerEmail),
    Arg.Any<string>(),
    Arg.Any<string>());

// FAKE: In-memory implementation -- realistic behavior without infrastructure
public class FakeOrderRepository : IOrderRepository
{
    public Dictionary<Guid, Order> Orders { get; } = new();

    public Task<Order?> GetByIdAsync(Guid id, CancellationToken ct = default)
        => Task.FromResult(Orders.GetValueOrDefault(id));

    public Task SaveAsync(Order order, CancellationToken ct = default)
    {
        Orders[order.Id] = order;
        return Task.CompletedTask;
    }
}
```

## When to prefer fakes over mocks

- **Domain-heavy applications:** fakes give more realistic behavior for complex interactions. An in-memory repository catches bugs mocks miss (e.g. duplicate key violations).
- **More mock setup than assertions is a test smell.** Consider whether a fake would be clearer and more maintainable.

## Anti-pattern: verifying the call sequence

```csharp
// BAD: Breaks when refactoring internals
repository.Received(1).GetByIdAsync(Arg.Is<Guid>(id => id == orderId));
repository.Received(1).SaveAsync(Arg.Any<Order>());
// ... five more Received() calls verifying the exact call sequence

// GOOD: Test the observable outcome
var result = await service.ProcessAsync(orderId);
Assert.Equal(OrderStatus.Completed, result.Status);
```

## Anti-pattern: excessive mock setup

```csharp
// BAD: Mock setup is longer than the actual test
var repo = Substitute.For<IOrderRepository>();
var pricing = Substitute.For<IPricingService>();
var inventory = Substitute.For<IInventoryService>();
var shipping = Substitute.For<IShippingService>();
var notification = Substitute.For<INotificationService>();
var audit = Substitute.For<IAuditService>();
// ... 20 lines of .Returns() setup

// BETTER: Use a builder or fake that encapsulates setup
var fixture = new OrderServiceFixture()
    .WithOrder(testOrder)
    .WithPrice("SKU-001", 29.99m);
var result = await fixture.Service.ProcessAsync(testOrder.Id);
```

See the [NSubstitute documentation](https://nsubstitute.github.io/help/getting-started/) for API details.
