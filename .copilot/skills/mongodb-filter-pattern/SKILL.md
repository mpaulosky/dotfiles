# MongoDB Filter Pattern Skill

## Overview
Pattern for adding conditional filters to MongoDB repository queries using the `Builders<T>.Filter` API.

## When to Use
- Adding search/filter capabilities to existing paginated queries
- Implementing case-insensitive text searches
- Combining multiple optional filter conditions
- Extending repository methods with new filter parameters

## Pattern

### 1. Repository Interface
Add optional parameters to the interface method:

```csharp
Task<Result<(IReadOnlyList<TDto> Items, long Total)>> GetAllAsync(
    int page, 
    int pageSize, 
    string? searchTerm = null,
    string? authorName = null,
    CancellationToken cancellationToken = default);
```

**Key principles:**
- Interface defines the contract (update interface first)
- Optional parameters use `= null` defaults
- Document parameters with XML comments

### 2. Repository Implementation
Build filters conditionally using `Builders<T>.Filter`:

```csharp
var filterBuilder = Builders<TEntity>.Filter;
var filters = new List<FilterDefinition<TEntity>>
{
    filterBuilder.Eq(x => x.Archived, false)  // Base filter(s)
};

// Add optional filters conditionally
if (!string.IsNullOrWhiteSpace(searchTerm))
{
    var searchFilter = filterBuilder.Or(
        filterBuilder.Regex(x => x.Title, new BsonRegularExpression(searchTerm, "i")),
        filterBuilder.Regex(x => x.Description, new BsonRegularExpression(searchTerm, "i"))
    );
    filters.Add(searchFilter);
}

if (!string.IsNullOrWhiteSpace(authorName))
{
    filters.Add(filterBuilder.Regex(x => x.Author.Name, new BsonRegularExpression(authorName, "i")));
}

// Combine all filters
var filter = filterBuilder.And(filters);

// Apply to query
var total = await _collection.CountDocumentsAsync(filter, cancellationToken: cancellationToken);
var entities = await _collection
    .Find(filter)
    .Skip((page - 1) * pageSize)
    .Limit(pageSize)
    .ToListAsync(cancellationToken);
```

**Key principles:**
- Start with a list of base filters (always required)
- Add optional filters conditionally using `if` statements
- Use `BsonRegularExpression(pattern, "i")` for case-insensitive regex
- Use `Filter.Or()` to search multiple fields
- Use `Filter.And()` to combine all filters
- Apply the combined filter to both count and find operations

### 3. Query Validator
Add validation rules for new optional parameters:

```csharp
RuleFor(x => x.SearchTerm)
    .MaximumLength(200)
    .When(x => !string.IsNullOrWhiteSpace(x.SearchTerm))
    .WithMessage("Search term must not exceed 200 characters.");

RuleFor(x => x.AuthorName)
    .MaximumLength(200)
    .When(x => !string.IsNullOrWhiteSpace(x.AuthorName))
    .WithMessage("Author name must not exceed 200 characters.");
```

**Key principles:**
- Use `.When()` for conditional validation (only when value is provided)
- Set reasonable max lengths (200 chars is typical for search terms)

### 4. Minimal API Endpoint
Add query parameters to the endpoint:

```csharp
group.MapGet("", async (
    int? page, 
    int? pageSize, 
    string? searchTerm, 
    string? authorName, 
    THandler handler) =>
{
    var query = new TQuery 
    { 
        Page = page ?? 1, 
        PageSize = pageSize ?? 20,
        SearchTerm = searchTerm,
        AuthorName = authorName
    };
    var result = await handler.Handle(query);
    return Results.Ok(result);
})
```

**Key principles:**
- Nullable parameters allow them to be optional in the query string
- Pass parameters to query object
- Handler receives the populated query

### 5. HTTP Client
Build query string with conditional parameters:

```csharp
var url = $"/api/v1/resource?page={page}&pageSize={pageSize}";
if (!string.IsNullOrWhiteSpace(searchTerm))
{
    url += $"&searchTerm={Uri.EscapeDataString(searchTerm)}";
}
if (!string.IsNullOrWhiteSpace(authorName))
{
    url += $"&authorName={Uri.EscapeDataString(authorName)}";
}

var result = await _httpClient.GetFromJsonAsync<TResponse>(url, cancellationToken);
```

**Key principles:**
- Build base URL with required parameters
- Conditionally append optional parameters
- Always use `Uri.EscapeDataString()` to encode parameter values
- Only include parameters that have values

### 6. Test Mocks
Update test mocks to match new interface signature:

```csharp
_repository.GetAllAsync(1, 20, null, null, Arg.Any<CancellationToken>())
    .Returns(((IReadOnlyList<TDto>)items, total));
```

**Key principles:**
- Pass `null` for new optional parameters in existing tests
- This keeps existing tests focused on their original scenarios
- Add new tests specifically for filter scenarios (Gimli's responsibility)

## MongoDB Regex Options
Common regex flags for `BsonRegularExpression`:
- `"i"` - Case-insensitive matching
- `"m"` - Multi-line mode
- `"s"` - Dot matches newlines
- `"x"` - Extended format (ignore whitespace)

Combine flags: `"im"` for case-insensitive multi-line

## Common Filter Patterns

### Exact match
```csharp
filterBuilder.Eq(x => x.Status, "Active")
```

### Text search (case-insensitive)
```csharp
filterBuilder.Regex(x => x.Title, new BsonRegularExpression(searchTerm, "i"))
```

### Multi-field search (OR)
```csharp
filterBuilder.Or(
    filterBuilder.Regex(x => x.Title, new BsonRegularExpression(term, "i")),
    filterBuilder.Regex(x => x.Description, new BsonRegularExpression(term, "i"))
)
```

### Nested field search
```csharp
filterBuilder.Regex(x => x.Author.Name, new BsonRegularExpression(name, "i"))
```

### Date range
```csharp
filterBuilder.And(
    filterBuilder.Gte(x => x.CreatedAt, startDate),
    filterBuilder.Lte(x => x.CreatedAt, endDate)
)
```

### Array contains
```csharp
filterBuilder.AnyEq(x => x.Tags, tagValue)
```

## Gotchas
1. **Always update interface first** - The interface is the contract; implementations conform to it
2. **Update ALL implementations** - Repository implementations and test mocks must match the interface
3. **Use null for optional params in tests** - Existing tests should pass `null` for new parameters
4. **Escape query strings** - Always use `Uri.EscapeDataString()` when building URLs
5. **Case-insensitive by default** - Use `"i"` flag for user-facing searches
6. **Combine with And** - When you have multiple filters, use `Filter.And(filters)` not `&` operator

## Files Modified (typical)
1. `src/Shared/Validators/[Query].cs` - Add filter properties
2. `src/Shared/Validators/[Query]Validator.cs` - Add validation rules
3. `src/Api/Data/I[Resource]Repository.cs` - Update interface signature
4. `src/Api/Data/[Resource]Repository.cs` - Implement filter logic
5. `src/Api/Handlers/[Resource]/List[Resource]Handler.cs` - Pass filters to repository
6. `src/Api/Handlers/[Resource]/[Resource]Endpoints.cs` - Add query parameters
7. `src/Web/Services/[Resource]ApiClient.cs` - Build query string
8. `tests/Unit.Tests/Handlers/[Resource]/List[Resource]HandlerTests.cs` - Update mocks

## Related Patterns
- **Result<T> Pattern**: Repository methods return `Result<T>` for error handling
- **CQRS**: Queries are separate from commands
- **Pagination**: Filters apply before skip/limit operations
- **Validation**: FluentValidation rules for all query parameters

## See Also
- Sam's history: `.squad/agents/sam/history.md` (Search/Filter implementation section)
- Team decision: `.squad/decisions/inbox/sam-search-filter.md`
- MongoDB Filter Builders: https://www.mongodb.com/docs/drivers/csharp/current/fundamentals/builders/
