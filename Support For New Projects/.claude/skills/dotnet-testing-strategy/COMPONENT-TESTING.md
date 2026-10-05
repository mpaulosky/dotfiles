# Component Testing (bUnit)

For Blazor components, use [bUnit](https://bunit.dev/docs/getting-started/). It
renders components in-memory against the Blazor render tree, so tests run at
unit-test speed (10-100ms) while still exercising real Razor markup, parameter
binding, event callbacks, and cascading values.

## When to use bUnit

- Markup renders correctly given a set of parameters
- An event callback (`onclick`, `@bind`, custom `EventCallback<T>`) fires with the right arguments
- Conditional rendering, cascading parameters, or lifecycle (`OnInitializedAsync`, `OnParametersSetAsync`)
- The component reacts correctly to injected service state (stub the service, assert on rendered output)

**bUnit is additive to Playwright/E2E.** It never loads a browser, so JS
interop, CSS layout, focus/scroll, routing, and multi-page navigation are
invisible to it. Critical user flows keep their Playwright/E2E coverage
regardless of how much bUnit coverage the components have; add bUnit tests for
edge cases and parameter permutations where the component's risk warrants it.

## Example

```csharp
public class CounterTests : TestContext
{
    [Fact]
    public void Counter_ClickIncrementButton_IncrementsCount()
    {
        // Arrange
        var cut = RenderComponent<Counter>();

        // Act
        cut.Find("button").Click();

        // Assert
        cut.Find("p").TextContent.Should().Be("Current count: 1");
    }

    [Fact]
    public void UserBadge_GivenAdminRole_RendersAdminLabel()
    {
        // Arrange
        var cut = RenderComponent<UserBadge>(parameters => parameters
            .Add(p => p.Role, UserRole.Admin));

        // Act & Assert
        cut.Find("[data-testid='badge']").TextContent.Should().Be("Admin");
    }
}
```

Inherit the test class from bUnit's `TestContext` (or use
`IClassFixture<TestContext>` if the class already has another base). Register
stubbed services on `Services` in Arrange, the same way you would configure a DI
container:

```csharp
// Arrange
Services.AddSingleton(Substitute.For<IUserService>());
var cut = RenderComponent<ProfilePanel>();
```

Put these tests in a `*.ComponentTests` project (e.g. `MyApp.Web.ComponentTests`).

## Gotchas

- Assert on rendered markup (`cut.Find(...)`, `cut.Markup`), the way a user or a Playwright test observes it, rather than on internal component state or private fields.
- `RenderComponent<T>` throws if a required cascading parameter or injected service isn't registered. Register everything the component actually resolves, and only that.
- Re-render after changing parameters with `cut.SetParametersAndRender(...)`. A
  second `RenderComponent` call is a fresh render and doesn't exercise
  `OnParametersSetAsync` the way a real re-render does.
