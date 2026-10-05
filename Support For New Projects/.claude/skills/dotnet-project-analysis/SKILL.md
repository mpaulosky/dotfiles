---
name: dotnet-project-analysis
description: "Map a .NET solution: projects and their types, reference graph, Directory.Build/CPM, NuGet and tool config, entry points. Use before .NET work in an unfamiliar repo, or when asked about solution layout, project references, or build/package configuration."
---

# .NET Project Analysis

```! find . -maxdepth 3 \( -name "*.csproj" -o -name "*.sln" -o -name "*.slnx" \) 2>/dev/null | head -20
```

Produce a **map** of the solution: every project classified, every reference edge drawn, every shared build file located. The map is done when it fills every field of the output template at the bottom.

Not for .NET 10+ single-file apps with no `.csproj`; there is no solution to map.

## Step 1: Find the solution

Search from the current directory up to the repository root for `.sln` / `.slnx`.

- **One solution**: read its project list (`.sln`: the path in each `Project(...)` line; `.slnx`: each `<Project Path>`, with `<Folder>` as logical grouping).
- **Both `.sln` and `.slnx`** for the same solution: use `.slnx`; note the `.sln` is likely kept for older tooling.
- **Several solutions**: list them all and ask the user which to analyse; default to the one at the repository root.
- **No solution**: scan for `.csproj` recursively and suggest `dotnet new sln` + `dotnet sln add`.

Also scan for `.csproj` files no solution includes and report them as **orphaned** (possibly experimental or unused).

Done when every project in scope has a path.

## Step 2: Classify each project

Read every `.csproj`. Classify by `<Project Sdk="...">`:

| SDK | Type |
| --- | --- |
| `Microsoft.NET.Sdk` | By `<OutputType>`: `Exe` console, `WinExe` Windows desktop (WPF/WinForms/WinUI), `Library` or absent class library |
| `Microsoft.NET.Sdk.Web` | Web (API / MVC / Razor Pages) |
| `Microsoft.NET.Sdk.Worker` | Worker Service |
| `Microsoft.NET.Sdk.Razor` | Razor Class Library |
| `Microsoft.NET.Sdk.BlazorWebAssembly` | Blazor WASM (legacy SDK) |
| `Microsoft.Maui.Sdk` | MAUI |
| `Uno.Sdk` / `Uno.Sdk.Private` | Uno Platform |

Then override or refine with these markers (any one suffices):

- **Test**: `<IsTestProject>true</IsTestProject>`; a PackageReference to
  `xunit.v3`, `xunit`, `NUnit`, `MSTest.TestFramework` or
  `Microsoft.NET.Test.Sdk`; or a name ending `.Tests`, `.UnitTests`,
  `.IntegrationTests`, `.TestUtils`. Record the framework.
- **Blazor**: a `Microsoft.AspNetCore.Components.WebAssembly` reference; `.razor` files; or `AddInteractiveServerComponents()` / `AddInteractiveWebAssemblyComponents()` in startup.
- **MAUI**: `<UseMaui>true</UseMaui>`, or platform TFMs (`net*-android`, `-ios`, `-maccatalyst`, `-windows`).
- **Uno**: a `Uno.WinUI` / `Uno.UI` reference, or Uno TFMs (`net*-browserwasm`, `net*-desktop`).

Done when every project has a type and TFM.

## Step 3: Draw the reference graph

Read every `<ProjectReference>` and build the dependency graph (format in the output template). Flag:

- **Circular references** (A -> B -> A): a build failure.
- **Test projects referencing test projects**: unusual; tests should reference production code.
- **Depth beyond 4 levels**: possible over-abstraction.
- **Conditional references** (a `Condition` attribute or inside `<When>`): report the condition, e.g. "MyApp.DevTools (Debug only)".

## Step 4: Shared build configuration

Find every `Directory.Build.props` and `Directory.Build.targets` from each project directory up to the solution root.

- **`.props`**: report its path, the subtree it governs, and the shared
  properties it sets, chiefly `TargetFramework(s)`, `LangVersion`, `Nullable`,
  `ImplicitUsings`, `TreatWarningsAsErrors`, `EnforceCodeStyleInBuild`,
  `AnalysisLevel`, `ManagePackageVersionsCentrally`.
- **`.targets`** (evaluated after the project): summarise it: shared
  PackageReferences such as analysers, project-type conditionals, custom
  targets.
- **Several levels**: show the hierarchy, one line per file with its settings.
  An inner file does **not** import the outer one unless it contains
  `<Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" />`;
  report whether each level chains.

## Step 5: Central Package Management

Search for `Directory.Packages.props` from the solution root **upward** to the
repository (or filesystem) root: NuGet resolves CPM hierarchically, so a
monorepo's parent directory may govern several solutions. CPM can also be
switched on by `ManagePackageVersionsCentrally` in a `Directory.Build.props`.

- **CPM on**: report the file path and the count of `<PackageVersion>`
  entries. Flag every `VersionOverride` in a `.csproj` as an exception. If the
  file sits above the solution root, note CPM is inherited (common in
  monorepos).
- **CPM off**: say each project pins its own versions, and suggest enabling
  CPM for consistency.

## Step 6: Other configuration files

- **`.editorconfig`** (root and nested): whether present; indent style/size, naming rules, severity overrides, `[*.cs]` `dotnet_style_*` / `csharp_style_*` rules.
- **`nuget.config`** (case-insensitive, from solution root upward): every file
  found, its package sources, `<packageSourceMapping>` (supply-chain
  protection) and `<disabledPackageSources>`. User- and machine-level configs
  also merge in; `dotnet nuget list source` shows the effective set.
- **`global.json`** (from solution root upward): `sdk.version`, `sdk.rollForward`, and any `msbuild-sdks`.
- **`.config/dotnet-tools.json`**: each local tool and version (e.g. `dotnet-ef`, `dotnet-format`, `nbgv`).

## Step 7: Entry points and key files

For each project, locate its entry point and key files by type using [ENTRY-POINTS.md](ENTRY-POINTS.md).

## Output

Fill every field; write "none" rather than dropping one.

```text
.NET Project Analysis Results
==============================
Solution:         MyApp.slnx (or MyApp.sln)
Projects:         5 (2 libraries, 1 web API, 1 console, 1 test)
CPM:              enabled (42 packages in Directory.Packages.props)
Shared Config:    Directory.Build.props (Nullable, ImplicitUsings, LangVersion=14)
Code Style:       .editorconfig present
Package Sources:  nuget.org + private feed (packageSourceMapping configured)
Local Tools:      dotnet-ef 10.0.0, nbgv 3.7.0

Project Dependency Graph
------------------------
MyApp.Api (Web API, net10.0) -> entry: src/MyApp.Api/Program.cs
  -> MyApp.Core (Library)
  -> MyApp.Infrastructure (Library)
    -> MyApp.Core (Library)
MyApp.Console (Console, net10.0) -> entry: src/MyApp.Console/Program.cs
  -> MyApp.Core (Library)
MyApp.Tests (Test, xUnit) -> entry: tests/MyApp.Tests/
  -> MyApp.Api (Web API)
  -> MyApp.Core (Library)

Key Files
---------
- Solution root:    /repo/MyApp.slnx
- Shared props:     /repo/Directory.Build.props
- Package versions: /repo/Directory.Packages.props
- API entry point:  /repo/src/MyApp.Api/Program.cs
- API config:       /repo/src/MyApp.Api/appsettings.json
```

Follow it with the flags raised in Steps 1, 3 and 5 (orphans, cycles,
conditional references, version overrides).
