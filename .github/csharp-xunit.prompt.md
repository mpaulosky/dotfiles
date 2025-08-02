---
mode: "agent"
tools: ["changes", "codebase", "editFiles", "problems", "search"]
description: "Get best practices for XUnit unit testing, including data-driven tests"
---

# XUnit Best Practices

Your goal is to help me write effective unit tests with XUnit v3, covering both standard and data-driven testing approaches.

## Project Setup

- Use a separate test project with naming convention `[ProjectName].Tests.Unit`
- Reference XUnit v3 packages: `xunit.v3.core`, `xunit.v3.assert`, and `xunit.v3.runner.visualstudio`
- Also reference `Microsoft.NET.Test.Sdk` and `FluentAssertions` packages
- Create test classes that match the classes being tested (e.g., `CalculatorTests` for `Calculator`)
- Use .NET SDK test commands: `dotnet test` for running tests
- Add appropriate package references to your project file:
  ```xml
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
  	<PackageReference Include="xunit.v3" />
    <PackageReference Include="xunit.v3.core" />
    <PackageReference Include="xunit.v3.commo9n" />
    <PackageReference Include="xunit.v3.runner.visualstudio" />
  	<PackageReference Include="xunit.v3.extensibility.core" />
    <PackageReference Include="FluentAssertions" />
    <PackageReference Include="NSubstitute" />
  	<PackageReference Include="NSubstitute.Analyzers.CSharp" />
  	<PackageReference Include="Moq" />
  </ItemGroup>
  ```

## Test Structure

- No test class attributes required (unlike MSTest/NUnit)
- Use fact-based tests with `[Fact]` attribute for simple tests
- Strictly follow the Arrange-Act-Assert (AAA) pattern
  - **Arrange**: Set up test prerequisites and inputs
  - **Act**: Call the method or operation being tested
  - **Assert**: Verify the expected outcome using FluentAssertions
- Use blank lines to separate each section of the AAA pattern for clarity
- Name tests using the pattern `MethodName_Scenario_ExpectedBehavior`
- Use constructor for setup and `IDisposable.Dispose()` for teardown
- Use `IClassFixture<T>` for shared context between tests in a class
- Use `ICollectionFixture<T>` for shared context between multiple test classes

## XUnit v3 Features

- Use `[Test]` attribute instead of `[Fact]` (though `[Fact]` is still supported for backward compatibility)
- Use `[Theory]` for data-driven tests (same as in XUnit v2)
- Use the new `[Observation]` attribute for specification-style tests
- Use `TestOutput` property for writing to test output (replaces `ITestOutputHelper`)
- Leverage the improved assertion failure messages in XUnit v3
- Take advantage of improved parallelization and performance in test runs
- Use built-in asynchronous test methods with `async`/`await` support

## Standard Tests

- Keep tests focused on a single behavior
- Avoid testing multiple behaviors in one test method
- Use clear assertions that express intent
- Include only the assertions needed to verify the test case
- Make tests independent and idempotent (can run in any order)
- Avoid test interdependencies

## Data-Driven Tests

- Use `[Theory]` combined with data source attributes
- Use `[InlineData]` for inline test data
- Use `[MemberData]` for method-based test data
- Use `[ClassData]` for class-based test data
- Create custom data attributes by implementing `DataAttribute`
- Use meaningful parameter names in data-driven tests

## Assertions with FluentAssertions

- Use FluentAssertions for more readable and expressive assertions
- Value equality: `result.Should().Be(expected)`
- Reference equality: `result.Should().BeSameAs(expected)`
- Boolean conditions: `result.Should().BeTrue()` or `result.Should().BeFalse()`
- Collections:
  - `collection.Should().Contain(item)`
  - `collection.Should().NotContain(item)`
  - `collection.Should().HaveCount(count)`
  - `collection.Should().BeEmpty()`
- Strings:
  - `string.Should().Contain("substring")`
  - `string.Should().StartWith("prefix")`
  - `string.Should().Match("regex pattern")`
- Exceptions:
  - `Action act = () => methodThatThrows();`
  - `act.Should().Throw<ExpectedException>().WithMessage("*expected message*")`
  - For async: `Func<Task> act = async () => await asyncMethodThatThrows();`
  - `await act.Should().ThrowAsync<ExpectedException>()`
- Types:
  - `obj.Should().BeOfType<ExpectedType>()`
  - `obj.Should().BeAssignableTo<ExpectedInterface>()`
- Nullability:
  - `obj.Should().NotBeNull()`
  - `obj.Should().BeNull()`
- Chain assertions for complex verifications:
  - `person.Should().NotBeNull().And.BeOfType<Customer>().Which.Name.Should().StartWith("J")`

## Mocking and Isolation

- Use NSubstitute alongside XUnit (preferred over Moq in this project)
- Mock dependencies to isolate units under test
- Use interfaces to facilitate mocking
- Consider using a DI container for complex test setups

## Test Organization

- Group tests by feature or component
- Use `[Trait("Category", "CategoryName")]` for categorization
- Use collection fixtures to group tests with shared dependencies
- Skip tests conditionally with `Skip = "reason"` in test attributes
- Use XUnit v3's improved test discovery and filtering capabilities

## Example with AAA Pattern

```csharp
[Test]
public void Add_TwoPositiveNumbers_ReturnsCorrectSum()
{
    // Arrange
    var calculator = new Calculator();
    int a = 2;
    int b = 3;

    // Act
    int result = calculator.Add(a, b);

    // Assert
    result.Should().Be(5);
}

[Theory]
[InlineData(0, 0, 0)]
[InlineData(1, 2, 3)]
[InlineData(-1, 1, 0)]
public void Add_VariousInputs_ReturnsExpectedResults(int a, int b, int expected)
{
    // Arrange
    var calculator = new Calculator();

    // Act
    int result = calculator.Add(a, b);

    // Assert
    result.Should().Be(expected);
}

// Example using new Observation attribute
[Observation]
public void Calculator_ShouldExist()
{
    // Arrange & Act
    var calculator = new Calculator();

    // Assert
    calculator.Should().NotBeNull();
}

// Example with test output
[Test]
public void Add_WithLogging_ReturnsCorrectSum()
{
    // Arrange
    var calculator = new Calculator();
    int a = 2;
    int b = 3;

    // Log test information
    TestOutput.WriteLine($"Testing addition with values {a} and {b}");

    // Act
    int result = calculator.Add(a, b);

    // Assert
    result.Should().Be(5);
    TestOutput.WriteLine($"Result was {result} as expected");
}
```
