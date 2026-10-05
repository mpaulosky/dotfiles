# xUnit v2 compatibility and migration

Read when the project references `xunit` (2.x) or is moving to `xunit.v3`. Most `[Fact]` and `[Theory]` tests work unchanged after swapping the package; the effort concentrates in the rows below.

| Area | v2 | v3 |
| --- | --- | --- |
| Package | `xunit` (2.x) | `xunit.v3` |
| Runner | `xunit.runner.visualstudio` 2.x | `xunit.runner.visualstudio` 3.x |
| Assert package | `xunit.assert` (pulled in by `xunit`) | `xunit.v3.assert` (pulled in by `xunit.v3`; `xunit.v3.assert.source` for extensibility) |
| Project type | Class library | Stand-alone executable: `<OutputType>Exe</OutputType>` |
| `ITestOutputHelper` | `Xunit.Abstractions` namespace | `Xunit` namespace; adds `Write` methods |
| `IAsyncLifetime` | `InitializeAsync`/`DisposeAsync` return `Task` | Return `ValueTask`; inherits `IAsyncDisposable`, so `Dispose` is not also called |
| `[ClassData]`/`[MemberData]` rows | `object[]` (or `TheoryData<T>`) | Also `TheoryDataRow<T>` (strongly typed, per-row `Skip`/metadata) and tuples |
| Parallelism | Per-collection; `parallelizeAssembly` | Same, plus `ParallelAlgorithm` (conservative default, or aggressive) |
| `async void` tests | Supported | Fail; return `Task`/`ValueTask` |

Unchanged: `xunit.runner.json` and assembly attributes for configuration; `Assert.Multiple` (since 2.4.2); the optional message on `Assert.True`/`Assert.False` (the only assertions that take one).

v2 `[ClassData]` shape:

```csharp
public class CurrencyConversionData : IEnumerable<object[]>
{
    public IEnumerator<object[]> GetEnumerator()
    {
        yield return new object[] { "USD", "EUR", 0.92m };
    }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
```

[v3 migration guide](https://xunit.net/docs/getting-started/v3/migration)
