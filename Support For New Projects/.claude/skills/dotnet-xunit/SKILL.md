---
name: dotnet-xunit
description: "xUnit v3 test authoring for .NET. Use when writing or fixing xUnit tests (Fact/Theory, data sources, assertions), setting up fixtures or async setup/teardown, controlling parallelism, or migrating from xUnit v2."
---
# xUnit v3 Test Authoring

xUnit v3 is the target (.NET 8+ or .NET Framework 4.7.2+; confirm the test
project's `TargetFramework`). v2 is still common, so check the project's package
reference (`xunit` = v2, `xunit.v3` = v3) before writing code, and match it.

Elsewhere: project scaffolding and package references live in
[skill:dotnet-add-testing]; what to test and which test type in
[skill:dotnet-testing-strategy]. Integration-test plumbing
(WebApplicationFactory, Testcontainers) is out of scope.

Disclosed reference, read when the branch fires:

- Project is on v2, or migrating to v3: [V2-MIGRATION.md](V2-MIGRATION.md)
- Tests share mutable state, or tuning `xunit.runner.json`: [PARALLELISM.md](PARALLELISM.md)
- Writing diagnostic output or bridging `ILogger` to test output: [TEST-OUTPUT.md](TEST-OUTPUT.md)
- An `xUnit1xxx`/`xUnit2xxx` analyzer diagnostic, or suppressing one: [ANALYZERS.md](ANALYZERS.md)

## Rules

- **One fact per `[Fact]`, one concept per `[Theory]`.** A theory whose rows test fundamentally different scenarios becomes separate facts. A method carries one of the two attributes, never both.
- **Async tests return `Task` or `ValueTask`.** v3 fails `async void` tests outright (v2 tolerated them; analyzer `xUnit1048` flags them).
- **Async setup/teardown goes through `IAsyncLifetime`**, since constructors cannot be async and `IDisposable.Dispose()` does not await. In v3 both methods return `ValueTask`.
- **Fixture classes have exactly one public constructor.** Its parameters may
  only be `IMessageSink`, `ITestContextAccessor`, or fixtures from a wider scope
  (a class fixture can take collection and assembly fixtures; a collection
  fixture can take assembly fixtures); anything else fails the tests.
- **Every `[Collection("X")]` has a matching `[CollectionDefinition("X")]` on a
  `public` class in the test assembly.** An unmatched name, or a non-public
  definition class, is silently ignored: the collection gets default behaviour
  and no fixtures.
- **`ITestOutputHelper` lives in an instance field**: it is per-test-instance, so static members cannot use it.
- **Keep test data close to the test**: `[InlineData]` for simple values; `[MemberData]`/`[ClassData]` only when data is complex or shared.
- **Keep parallelism on.** Group tests that share mutable state into a named collection rather than disabling it globally (see [PARALLELISM.md](PARALLELISM.md)).
- **Keep xUnit analyzers enabled** in every test project; they catch false-passing and flaky tests.

## Theory data

`[InlineData(100, 10, 90)]` for simple value types. For complex or shared data, `[MemberData]` with `TheoryData<T>`:

```csharp
public static TheoryData<Order, bool> ValidationCases => new()
{
    { new Order { Items = [new("SKU-1", 1)], CustomerId = "C1" }, true },
    { new Order { Items = [], CustomerId = "C1" }, false },              // no items
};

[Theory]
[MemberData(nameof(ValidationCases))]
public void IsValid_VariousOrders_ReturnsExpected(Order order, bool expected)
    => Assert.Equal(expected, new OrderValidator().IsValid(order));
```

`[ClassData]` for data shared across test classes. v3 rows are strongly typed via `TheoryDataRow<T>`:

```csharp
public class CurrencyConversionData : IEnumerable<TheoryDataRow<string, string, decimal>>
{
    public IEnumerator<TheoryDataRow<string, string, decimal>> GetEnumerator()
    {
        yield return new("USD", "EUR", 0.92m);
        yield return new("GBP", "USD", 1.27m);
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

[Theory]
[ClassData(typeof(CurrencyConversionData))]
public void Convert_KnownPairs_ReturnsExpectedRate(string from, string to, decimal expectedRate)
    => Assert.Equal(expectedRate, new CurrencyConverter().GetRate(from, to), precision: 2);
```

## Fixtures

Pick by sharing scope:

- **`IClassFixture<T>`**: one instance shared by the tests in a single class.
- **`ICollectionFixture<T>`**: one instance shared across several classes in a collection.
- **`IAsyncLifetime` on the test class itself**: per-test async setup/teardown, no sharing (e.g. a temp directory created and deleted around each test).

```csharp
public class DatabaseFixture : IAsyncLifetime
{
    public string ConnectionString { get; private set; } = "";

    public ValueTask InitializeAsync()
    {
        ConnectionString = $"Host=localhost;Database=test_{Guid.NewGuid():N}";
        // Create database, run migrations, etc.
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask; // Drop database
}

// Single class: implement IClassFixture<DatabaseFixture> and take it in the constructor.
public class OrderRepositoryTests(DatabaseFixture db) : IClassFixture<DatabaseFixture> { /* ... */ }

// Several classes: define the collection once (marker class, no code)...
[CollectionDefinition("Database")]
public class DatabaseCollection : ICollectionFixture<DatabaseFixture> { }

// ...then tag each class; the fixture is constructor-injected.
[Collection("Database")]
public class CustomerRepositoryTests(DatabaseFixture db) { /* ... */ }
```

## Custom assertions

Wrap domain checks in a static `XxxAssert` class for cleaner tests; throw xUnit's own exceptions so failures read like built-in ones:

```csharp
public static class OrderAssert
{
    public static void HasStatus(Order order, OrderStatus expected)
    {
        Assert.NotNull(order);
        if (order.Status != expected)
            throw Xunit.Sdk.EqualException.ForMismatchedValues(expected.ToString(), order.Status.ToString());
    }

    public static void ContainsItem(Order order, string sku, int quantity)
    {
        var item = Assert.Single(order.Items, i => i.Sku == sku);
        Assert.Equal(quantity, item.Quantity);
    }
}
```

`Assert.Multiple(() => ..., () => ...)` (v2 2.4.2+ and v3) evaluates every grouped assertion and reports all failures, instead of stopping at the first.

## Docs

- [xUnit documentation](https://xunit.net/)
- [Shared context (fixtures)](https://xunit.net/docs/shared-context)
