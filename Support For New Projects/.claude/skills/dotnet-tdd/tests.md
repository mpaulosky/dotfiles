# Good and Bad Tests (C# / xUnit v3)

Structure every test with explicit `// Arrange` / `// Act` / `// Assert` comments and assert with FluentAssertions (`result.Should().Be(...)`) rather than `Assert.*`.

## Good Tests

**Integration-style**: test through real interfaces and the real objects behind them.

```csharp
// GOOD: Tests observable behavior
[Fact]
public async Task Checkout_ValidCart_ReturnsConfirmed()
{
    // Arrange
    var cart = Cart.Empty();
    cart.Add(product);

    // Act
    var result = await checkoutService.CheckoutAsync(cart, paymentMethod);

    // Assert
    result.Status.Should().Be(OrderStatus.Confirmed);
}
```

Characteristics:

- Tests behavior callers care about
- Uses public API / injected interfaces only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test (or `Should().BeEquivalentTo(...)` / chained `.And` for one concept spanning several properties)

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```csharp
// BAD: Tests implementation details
[Fact]
public async Task Checkout_CallsPaymentServiceProcess()
{
    // Arrange
    var paymentService = Substitute.For<IPaymentService>();
    var sut = new CheckoutService(paymentService);

    // Act
    await sut.CheckoutAsync(cart, payment);

    // Assert
    await paymentService.Received(1).ProcessAsync(cart.Total);
}
```

It asserts on a call count instead of an outcome, and its name describes HOW, not WHAT. The full list of red flags is under Anti-patterns in [SKILL.md](SKILL.md).

```csharp
// BAD: Bypasses interface to verify
[Fact]
public async Task CreateUser_SavesToDatabase()
{
    // Arrange & Act
    await userService.CreateAsync(new CreateUserRequest("Alice"));

    // Assert
    var row = await db.QueryFirstOrDefaultAsync<UserRow>(
        "SELECT * FROM Users WHERE Name = @Name", new { Name = "Alice" });

    row.Should().NotBeNull();
}

// GOOD: Verifies through interface
[Fact]
public async Task CreateUser_MakesUserRetrievable()
{
    // Arrange
    var user = await userService.CreateAsync(new CreateUserRequest("Alice"));

    // Act
    var retrieved = await userService.GetAsync(user.Id);

    // Assert
    retrieved!.Name.Should().Be("Alice");
}
```

**Tautological tests**: Expected value restates the implementation, so the test passes by construction.

```csharp
// BAD: Expected value is recomputed the way the code computes it
[Fact]
public void CalculateTotal_SumsLineItems()
{
    // Arrange
    var items = new[] { new LineItem(Price: 10m), new LineItem(Price: 5m) };
    var expected = items.Sum(i => i.Price);

    // Act
    var total = calculator.CalculateTotal(items);

    // Assert
    total.Should().Be(expected);
}

// GOOD: Expected value is an independent, known literal
[Fact]
public void CalculateTotal_SumsLineItems()
{
    // Arrange
    var items = new[] { new LineItem(Price: 10m), new LineItem(Price: 5m) };

    // Act
    var total = calculator.CalculateTotal(items);

    // Assert
    total.Should().Be(15m);
}
```

## Naming and structure

Use `Method_Scenario_ExpectedBehavior` (see [skill:dotnet-testing-strategy] for
the full convention and alternatives) and keep Arrange-Act-Assert sections
visibly separate. If you can't label the three sections, the test is doing too
much — split it.

```csharp
[Fact]
public async Task SubmitOrder_WhenInventoryInsufficient_ReturnsOutOfStockError()
{
    // Arrange
    var order = OrderBuilder.WithItem("SKU-1", quantity: 5).Build();

    // Act
    var result = await orderService.SubmitAsync(order);

    // Assert
    result.Error.Should().Be(OrderError.OutOfStock);
}
```
