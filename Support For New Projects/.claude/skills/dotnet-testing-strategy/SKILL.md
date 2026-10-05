---
name: dotnet-testing-strategy
description: "Test strategy for .NET code. Use when choosing unit vs integration vs E2E vs bUnit component tests, picking a test double (stub, mock, fake, spy), or laying out and naming test projects and test methods."
---

# dotnet-testing-strategy

Pick the right test type, test double, and layout for .NET code. Before
designing a strategy, run [skill:dotnet-project-analysis] to see the existing
solution and test structure, so you extend it rather than duplicate it
(duplicated test infrastructure causes build conflicts).

Related skills: [skill:dotnet-add-testing] scaffolds test projects (layout, xUnit project, coverlet); [skill:dotnet-xunit] covers xUnit v3 features; [skill:dotnet-tdd] covers the test-first loop.

## Choosing a test type

Start at the top and follow the first matching branch:

```text
Does the code under test depend on external infrastructure?
  (database, HTTP service, file system, message broker)
|
+-- YES --> Is the infrastructure behavior critical to correctness?
|           |
|           +-- YES --> Does it need the full application stack (middleware, auth, routing)?
|           |           |
|           |           +-- YES --> E2E / Functional Test
|           |           |           (WebApplicationFactory or Playwright)
|           |           |
|           |           +-- NO  --> Integration Test
|           |                       (WebApplicationFactory or Testcontainers)
|           |
|           +-- NO  --> Unit Test with test doubles
|                        (mock the infrastructure boundary)
|
+-- NO  --> Is this pure logic (calculations, transformations, validation)?
            |
            +-- YES --> Unit Test (no test doubles needed)
            |
            +-- NO  --> Unit Test with test doubles
                        (mock collaborator interfaces)
```

A Razor/Blazor component (markup, parameter binding, event callbacks, cascading
state) gets a **Component Test with bUnit**, in addition to any E2E coverage of
its critical flows. Read [COMPONENT-TESTING.md](COMPONENT-TESTING.md) before
writing one.

| Test Type | Infrastructure | Speed | Scope | When to Use |
| --- | --- | --- | --- | --- |
| **Unit** | None (mocked/faked) | <10ms per test | Single class/method | Pure logic, domain rules, value objects, transformations, validators |
| **Component** | None (renders in-memory) | 10-100ms per test | Single Blazor component | Component markup, parameter binding, event callbacks, cascading state (bUnit) |
| **Integration** | Real (DB, HTTP) | 100ms-5s per test | Multiple components | Repository queries, API contract verification, serialization round-trips, middleware behavior |
| **E2E / Functional** | Full stack | 1-30s per test | Entire request pipeline | Critical user flows, auth + routing + middleware combined, cross-cutting concern verification |

- **Prefer unit tests** for business logic: fast, precise failures, no infrastructure.
- **Test infrastructure boundaries against real infrastructure.** A mocked
  `DbContext` proves nothing about whether your LINQ translates to valid SQL;
  use a real database via Testcontainers, or `WebApplicationFactory` for
  in-process HTTP. The same goes for `HttpClient` and other framework types you
  don't own: substitute real infrastructure rather than mocking them.
- **Use E2E tests sparingly**, for critical paths only: the happy path plus one or two critical failure scenarios. They are slow, brittle, and expensive to maintain.
- **Match test type to risk.** High-risk code (payments, auth) deserves integration and E2E coverage; low-risk code (simple mapping) needs only unit tests.
- **The testing pyramid is a guideline.** CRUD APIs with minimal logic may warrant more integration than unit tests; match the application's complexity profile.

## Choosing a test double

| Double | Behavior | Verification | Use When |
| --- | --- | --- | --- |
| **Stub** | Returns canned data | None | A dependency must return specific values so the code under test can proceed |
| **Mock** | Verifies interactions | Interaction | You must verify the code under test called a dependency in a specific way |
| **Fake** | Working implementation | State | You need a lightweight functional substitute (in-memory repository, in-memory message bus) |
| **Spy** | Records calls for later assertion | Interaction | You must verify calls happened without prescribing them upfront |

```text
Do you need to verify HOW a dependency was called?
|
+-- YES --> Do you need a working implementation too?
|           |
|           +-- YES --> Spy (record calls on a fake)
|           +-- NO  --> Mock (NSubstitute / Moq)
|
+-- NO  --> Do you need the dependency to DO something realistic?
            |
            +-- YES --> Fake (in-memory implementation)
            +-- NO  --> Stub (return canned values)
```

When writing tests with doubles, read [TEST-DOUBLES.md](TEST-DOUBLES.md) for stub/mock/fake examples, when to prefer fakes, and the over-mocking anti-patterns.

## Test organization

Mirror `src/` under `tests/`, suffixing each project with its test type:

```text
MyApp/
  src/
    MyApp.Domain/
    MyApp.Application/
    MyApp.Api/
    MyApp.Infrastructure/
  tests/
    MyApp.Domain.UnitTests/
    MyApp.Application.UnitTests/
    MyApp.Api.IntegrationTests/
    MyApp.Api.FunctionalTests/
    MyApp.Infrastructure.IntegrationTests/
    MyApp.Web.ComponentTests/
```

- `*.UnitTests`: isolated, no external dependencies
- `*.ComponentTests`: Blazor components via bUnit
- `*.IntegrationTests`: real infrastructure (database, HTTP, file system)
- `*.FunctionalTests`: full application stack via `WebApplicationFactory`

One test class per production class, in a namespace mirroring the production
namespace. Group tests by method, then by scenario. Split a large production
class's tests by method (`OrderService_CreateTests.cs`,
`OrderService_CancelTests.cs`).

```csharp
// Production: src/MyApp.Domain/Orders/OrderService.cs
// Test:       tests/MyApp.Domain.UnitTests/Orders/OrderServiceTests.cs
namespace MyApp.Domain.UnitTests.Orders;
```

## Test naming and structure

Name tests `Method_Scenario_ExpectedBehavior`, so a failing test name says what broke without reading the body:

```csharp
public void CalculateTotal_WithDiscountCode_AppliesPercentageDiscount()
public void CalculateTotal_WithExpiredDiscount_ThrowsInvalidOperationException()
public async Task SubmitOrder_WhenInventoryInsufficient_ReturnsOutOfStockError()
```

If a project already uses another style, follow it; use one style per project:

| Style | Example |
| --- | --- |
| `Method_Scenario_Expected` | `CalculateTotal_EmptyCart_ReturnsZero` |
| `Should_Expected_When_Scenario` | `Should_ReturnZero_When_CartIsEmpty` |
| `Given_When_Then` | `GivenEmptyCart_WhenCalculatingTotal_ThenReturnsZero` |

Every test has visibly separated `// Arrange`, `// Act`, `// Assert` sections. If you can't label all three, the test is doing too much: split it.

## Principles

- **Test behavior.** Assert on observable outcomes (return values, state
  changes, published events), never on internal call sequences. Test private
  methods through the public API; if one needs its own tests, extract it into
  its own class.
- **One logical assertion per test.** Several `Assert` calls verifying one concept (e.g. all properties of a returned object) are fine; unrelated assertions mean the test should be split.
- **Keep tests independent.** Each test uses fresh fixtures and passes regardless of execution order.
- **Keep tests deterministic.** Inject abstractions for the clock, randomness,
  and network. For time, use `TimeProvider` (.NET 8+) rather than a custom
  `IClock`, and advance time with `FakeTimeProvider.Advance()` in place of
  `Thread.Sleep`:

  ```csharp
  // Production
  public bool IsExpired(TimeProvider time) => ExpiresAt < time.GetUtcNow();

  // Test
  var fakeTime = new FakeTimeProvider(new DateTimeOffset(2025, 6, 15, 0, 0, 0, TimeSpan.Zero));
  Assert.True(order.IsExpired(fakeTime));
  ```

- **Get infrastructure from Testcontainers or `WebApplicationFactory`**, never from hard-coded connection strings in integration tests.

## References

- [.NET Testing Best Practices](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-best-practices)
- [Integration tests in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- [TimeProvider in .NET 8](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider)
