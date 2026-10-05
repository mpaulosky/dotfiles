# When to Mock (C# / .NET)

Mock at **system boundaries** only:

- External APIs (payment, email, third-party HTTP services)
- Databases (sometimes — prefer a real test database or Testcontainers; see [skill:dotnet-testing-strategy])
- `TimeProvider` / randomness
- File system (sometimes)

Everything you control (your own classes, internal collaborators) runs for real in the test, or as a fake.

## Designing for Mockability

At system boundaries, design interfaces that are easy to substitute.

### 1. Use constructor (dependency) injection

Pass external dependencies in rather than constructing them internally:

```csharp
// Easy to mock
public class PaymentProcessor(IPaymentClient paymentClient)
{
    public Task<PaymentResult> ProcessAsync(Order order) =>
        paymentClient.ChargeAsync(order.Total);
}

// Hard to mock
public class PaymentProcessor
{
    private readonly StripeClient _client = new(Environment.GetEnvironmentVariable("STRIPE_KEY")!);

    public Task<PaymentResult> ProcessAsync(Order order) =>
        _client.ChargeAsync(order.Total);
}
```

### 2. Prefer SDK-style interfaces over one generic gateway

Create a specific method per external operation instead of one generic call with conditional logic:

```csharp
// GOOD: Each member is independently substitutable
public interface IOrdersApi
{
    Task<UserDto> GetUserAsync(string id);
    Task<IReadOnlyList<OrderDto>> GetOrdersAsync(string userId);
    Task<OrderDto> CreateOrderAsync(CreateOrderRequest request);
}

// BAD: Mocking requires conditional logic inside the setup
public interface IApiClient
{
    Task<HttpResponseMessage> SendAsync(string endpoint, HttpMethod method, object? body);
}
```

The SDK approach means:

- Each `Substitute.For<T>()` setup returns one specific shape
- No conditional logic in test setup
- Easier to see which operations a test exercises
- Compile-time type safety per operation

## Mocks vs fakes in the loop

During red→green, reach for the simplest double that lets the current slice compile and assert on behavior:

- **Stub**
  (`Substitute.For<IPriceService>().GetPriceAsync(...).Returns(29.99m)`) when
  the test only needs a canned value to proceed. Arrange the stub's return value
  in the Arrange section, then assert the outcome with FluentAssertions
  (`result.Should().Be(29.99m)`) in Assert.
- **Fake** (a small in-memory `IOrderRepository` implementation) when the
  slice's behavior depends on realistic state across calls — fakes catch bugs
  (duplicate keys, missing records) that stubs and mocks miss.
- **Mock** (`Received(1)`) only when the point of the test *is* that a side effect fired (an email got sent, an event got published) — not as a substitute for asserting on a return value.

If a test's mock setup is longer than its assertions, the seam is wrong or the double should be a fake. Note it and fix it in the review stage after the loop.

See [skill:dotnet-testing-strategy] for the full stub/mock/fake/spy decision tree and anti-patterns (mocking types you don't own, `Thread.Sleep`, hard-coded connection strings).
