# Test output

`ITestOutputHelper` is constructor-injected per test instance; text written to it appears in the test results.

```csharp
public class DiagnosticTests(ITestOutputHelper output)
{
    [Fact]
    public async Task ProcessBatch_LargeDataset_CompletesWithinTimeout()
    {
        var sw = Stopwatch.StartNew();
        var result = await processor.ProcessBatchAsync(largeDataset);
        sw.Stop();

        output.WriteLine($"Processed {result.Count} items in {sw.ElapsedMilliseconds}ms");
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));
    }
}
```

## Bridging `ILogger`

For code under test that logs via `Microsoft.Extensions.Logging`, add a small provider that writes to `ITestOutputHelper` (needs `Microsoft.Extensions.Logging` for `LoggerFactory`):

```csharp
public class XunitLoggerProvider(ITestOutputHelper output) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new XunitLogger(output, categoryName);
    public void Dispose() { }
}

public class XunitLogger(ITestOutputHelper output, string category) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    {
        output.WriteLine($"[{logLevel}] {category}: {formatter(state, exception)}");
        if (exception is not null)
            output.WriteLine(exception.ToString());
    }
}
```
