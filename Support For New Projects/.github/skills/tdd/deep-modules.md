## Deep Modules

From "A Philosophy of Software Design":

**Deep module** = small interface + lots of implementation

```text
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│                     │
│                     │
│  Deep Implementation│  ← Complex logic hidden
│                     │
│                     │
└─────────────────────┘
```

**Shallow module** = large interface + little implementation (avoid)

```text
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through
└─────────────────────────────────┘
```

When designing interfaces, ask:

- Can I reduce the number of methods?
- Can I simplify the parameters?
- Can I hide more complexity inside?

In a typical .NET application, prefer seams that hide mapping, caching,
retries, and error translation behind one useful operation.

```csharp
// Deeper
ValueTask<IReadOnlyList<OrderSummaryDto>> GetOrFetchAllAsync(
    Func<Task<IReadOnlyList<OrderSummaryDto>>> fetch,
    CancellationToken cancellationToken);

// Shallower
string BuildCacheKey(string prefix, Guid? id, bool includeArchived);
Task<byte[]?> GetBytesAsync(string key, CancellationToken cancellationToken);
Task SetBytesAsync(string key, byte[] payload, TimeSpan ttl, CancellationToken cancellationToken);
Task<IReadOnlyList<OrderSummaryDto>> MapAsync(IEnumerable<Order> orders, CancellationToken cancellationToken);
```

The first interface gives callers leverage. The second makes every caller know
far too much about how caching and mapping work.
