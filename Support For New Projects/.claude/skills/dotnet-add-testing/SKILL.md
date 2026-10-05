---
name: dotnet-add-testing
description: "Scaffolding tests into an existing .NET solution: xUnit v3 test projects, tests/ layout, CPM test packages, coverlet coverage. Use when adding a unit or integration test project, or setting up code coverage."
---

# .NET Add Testing

Scaffolding only: test projects, packages, build settings, coverage. For how
to write and structure the tests themselves, see [skill:dotnet-testing-strategy]
and [skill:dotnet-xunit]. Run [skill:dotnet-project-analysis] first to learn
the solution layout, SDK/TFM, and whether it uses Central Package Management
(CPM).

## Layout

Mirror each `src/` project under `tests/`, one project per test kind:

```text
MyApp/
├── src/
│   ├── Core/
│   ├── Api/
│   └── UI/
└── tests/
    ├── Core.Unit.Tests/
    ├── Api.Unit.Tests/
    ├── Api.Integration.Tests/
    ├── UI.Unit.Tests/
    ├── UI.BUnit.Tests/
    ├── UI.Integration.Tests/
    └── Directory.Build.props          # Test-specific build settings
```

Suffixes:

- `*.Unit.Tests`: isolated, no external dependencies
- `*.BUnit.Tests`: Blazor component tests
- `*.Integration.Tests`: real infrastructure (database, HTTP, file system)
- `*.E2E.Tests`: through the full application stack

## Step 1: Create the test project

```bash
dotnet new xunit -n Core.Unit.Tests -o tests/Core.Unit.Tests
dotnet sln add tests/Core.Unit.Tests/Core.Unit.Tests.csproj
dotnet add tests/Core.Unit.Tests/Core.Unit.Tests.csproj \
  reference src/Core/Core.csproj
```

Trim the generated `.csproj` to package and project references. Properties
come from `Directory.Build.props` (Step 2); under CPM, versions come from
`Directory.Packages.props` (Step 3), so strip every `Version` attribute:

```xml
<!-- tests/Core.Unit.Tests/Core.Unit.Tests.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
    <PackageReference Include="xunit.v3" />
    <PackageReference Include="xunit.runner.visualstudio" />
    <PackageReference Include="coverlet.collector" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\..\src\Core\Core.csproj" />
  </ItemGroup>
</Project>
```

## Step 2: Add `tests/Directory.Build.props`

Import the root props (shared `Nullable`, `ImplicitUsings`, `LangVersion`) and override for tests:

```xml
<!-- tests/Directory.Build.props -->
<Project>
  <Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />
  <PropertyGroup>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
    <!-- Microsoft.Testing.Platform v2 runner (requires Microsoft.NET.Test.Sdk 17.13+/18.x) -->
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

## Step 3: Register test packages in CPM

```xml
<!-- Directory.Packages.props -->
<ItemGroup>
  <PackageVersion Include="Microsoft.NET.Test.Sdk" Version="18.0.1" />
  <PackageVersion Include="xunit.v3" Version="3.2.2" />
  <PackageVersion Include="xunit.runner.visualstudio" Version="3.1.5" />
  <PackageVersion Include="coverlet.collector" Version="8.0.0" />
</ItemGroup>
```

Only if the project needs them: `NSubstitute` `5.3.0` for test doubles, `FluentAssertions` `8.0.1` for assertions.

## Step 4: Relax analyzers for tests

In the root `.editorconfig`:

```ini
[tests/**.cs]
# Underscores in test method names (Method_Condition_ExpectedResult)
dotnet_diagnostic.CA1707.severity = none
# Test parameters are validated by the framework
dotnet_diagnostic.CA1062.severity = none
# ConfigureAwait not relevant in tests
dotnet_diagnostic.CA2007.severity = none
# Intentionally unused variables in assertions
dotnet_diagnostic.IDE0059.severity = suggestion
```

## Step 5: Replace `UnitTest1.cs` with a starter test

Name tests `Method_Condition_ExpectedResult` (`GetById_WhenNotFound_ReturnsNull`) and lay them out Arrange/Act/Assert:

```csharp
namespace Core.Unit.Tests;

public class SampleServiceTests
{
    [Fact]
    public void DoWork_WithDefaultState_ReturnsResult()
    {
        // Arrange
        var sut = new SampleService();

        // Act
        var result = sut.DoWork();

        // Assert
        Assert.NotNull(result);
    }

    [Theory]
    [InlineData(1, 2, 3)]
    [InlineData(0, 0, 0)]
    [InlineData(-1, 1, 0)]
    public void Add_TwoNumbers_ReturnsSum(int a, int b, int expected)
    {
        Assert.Equal(expected, Calculator.Add(a, b));
    }
}
```

## Step 6: Verify

```bash
dotnet restore                              # regenerates CPM lock files
dotnet build --no-restore
dotnet test --no-build
dotnet test --collect:"XPlat Code Coverage" # writes TestResults/*/coverage.cobertura.xml
```

Done when the build has zero errors, every new test project runs and passes,
and a `coverage.cobertura.xml` exists for each. `coverlet.collector` needs no
further configuration for this. For CI coverage thresholds or HTML reports, see
[COVERAGE.md](COVERAGE.md).

## Integration test projects

Same steps, with the `Integration.Tests` suffix and a reference to the app under test:

```bash
dotnet new xunit -n Api.Integration.Tests -o tests/Api.Integration.Tests
dotnet sln add tests/Api.Integration.Tests/Api.Integration.Tests.csproj
dotnet add tests/Api.Integration.Tests/Api.Integration.Tests.csproj \
  reference src/Api/Api.csproj
```

Add to CPM. The `Microsoft.AspNetCore.Mvc.Testing` major version must match the target framework (`8.x` for `net8.0`, `9.x` for `net9.0`, `10.x` for `net10.0`):

```xml
<PackageVersion Include="Microsoft.AspNetCore.Mvc.Testing" Version="10.0.0" />
<PackageVersion Include="Testcontainers" Version="4.3.0" />
```
