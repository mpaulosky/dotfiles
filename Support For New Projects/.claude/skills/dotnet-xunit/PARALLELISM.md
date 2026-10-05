# Parallel execution

**Default:** classes within one collection run sequentially; different collections run in parallel. A class with no `[Collection]` is its own implicit collection, so by default classes run in parallel.

**Tests sharing mutable state:** put them in one collection with parallelization disabled, leaving the rest of the assembly parallel.

```csharp
[CollectionDefinition("Sequential", DisableParallelization = true)]
public class SequentialCollection { }

[Collection("Sequential")]
public class StatefulServiceTests { /* run sequentially */ }
```

**Assembly-level:** `xunit.runner.json` in the test project root.

```json
{
    "$schema": "https://xunit.net/schema/current/xunit.runner.schema.json",
    "parallelizeAssembly": false,
    "parallelizeTestCollections": true,
    "maxParallelThreads": 4
}
```

It only takes effect when copied to output:

```xml
<ItemGroup>
  <Content Include="xunit.runner.json" CopyToOutputDirectory="PreserveNewest" />
</ItemGroup>
```

[Configuring xUnit with JSON](https://xunit.net/docs/configuration-files)
