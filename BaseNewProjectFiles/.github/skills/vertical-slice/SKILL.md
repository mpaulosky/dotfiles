---
name: vertical-slice
description: "Scaffold a complete vertical slice for a feature using CQRS, MediatR, MongoDB, best practices, and a full Blazor UI. Generates: domain model, Create/Update/Delete commands with validators, GetById/GetList queries, MongoDB repository, MediatR pipeline behavior, DI extension, and a complete Blazor UI with a list table page, separate Add page, separate Edit page, separate Details page, and delete confirmation dialog. Use when: adding a new feature, creating CRUD operations, full UI for a feature, list table, add page, edit page, details page, delete confirmation, implementing CQRS handlers, wiring MongoDB repositories, vertical slice architecture, feature slices."
argument-hint: '<FeatureName> e.g. "BlogPost" or "Comment"'
---

# Vertical Slice — CQRS + MediatR + MongoDB + Full Blazor UI

Scaffolds a **complete, self-contained feature slice** following vertical slice architecture (VSA).

**Backend:**

- CQRS — separate Commands and Queries
- MediatR — decoupled request/handler pipeline
- MongoDB — async repository with the official .NET driver
- FluentValidation — pipeline behavior validation
- Result pattern — no exceptions for expected failures
- DI registration — single `Add<Feature>Feature()` extension

**Frontend (Blazor):**

- `/features` — List page with a data table and delete confirmation modal
- `/features/add` — Add page with a form
- `/features/{id}/edit` — Edit page with a form pre-filled
- `/features/{id}` — Details (read-only) page
- Shared `<Feature>Form.razor` component reused by Add and Edit pages
- Tailwind CSS classes consistent with project theme

---

## Step 1 — Gather requirements

Before generating any code, determine:

1. **Feature name** — PascalCase singular noun (e.g. `BlogPost`, `Comment`, `Tag`)
2. **Properties** — name, type, required/optional. Always include `Id` (MongoDB ObjectId string).
3. **URL prefix** — kebab-case plural (e.g. `blog-posts`, `comments`)
4. **Existing project structure** — run discovery in Step 2

If any of the above are missing, **ask the user before generating code**.

---

## Step 2 — Discover project structure

```bash
# Find the web project
find . -name "*.csproj" | grep -v obj

# Check for existing packages
grep -r "MediatR\|MongoDB\|FluentValidation" --include="*.csproj" -l

# Check existing feature folder conventions
find . -type d -name "Features" | grep -v obj

# Check existing shared infrastructure
find . -name "Result.cs" -o -name "ValidationBehavior.cs" | grep -v obj

# Check existing _Imports.razor files
find . -name "_Imports.razor" | grep -v obj

# Check Program.cs for existing DI patterns
cat $(find . -name "Program.cs" | grep -v obj | head -1)
```

Adapt all generated paths to match the actual project structure.

---

## Step 3 — Install required packages

Check the `.csproj` first. Only install packages that are missing.

```bash
cd <WebProject>
dotnet add package MediatR
dotnet add package MongoDB.Driver
dotnet add package FluentValidation
dotnet add package FluentValidation.DependencyInjectionExtensions
```

---

## Step 4 — Ensure shared infrastructure exists

These files are shared across all slices. **Create only if they do not already exist.**

### `Web/Shared/Result.cs`

```csharp
namespace Web.Shared;

public class Result
{
    public bool IsSuccess { get; }
    public string? Error { get; }

    protected Result(bool isSuccess, string? error)
    {
        IsSuccess = isSuccess;
        Error = error;
    }

    public static Result Success() => new(true, null);
    public static Result Failure(string error) => new(false, error);
    public static Result<T> Success<T>(T value) => new(value, true, null);
    public static Result<T> Failure<T>(string error) => new(default, false, error);
}

public class Result<T> : Result
{
    public T? Value { get; }

    public Result(T? value, bool isSuccess, string? error)
        : base(isSuccess, error) => Value = value;
}
```

### `Web/Shared/ValidationBehavior.cs`

```csharp
using FluentValidation;
using MediatR;

namespace Web.Shared;

public class ValidationBehavior<TRequest, TResponse>(IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        if (!validators.Any())
            return await next(ct);

        var context = new ValidationContext<TRequest>(request);
        var failures = validators
            .Select(v => v.Validate(context))
            .SelectMany(r => r.Errors)
            .Where(f => f is not null)
            .ToList();

        if (failures.Count != 0)
            throw new ValidationException(failures);

        return await next(ct);
    }
}
```

---

## Step 5 — Create feature folder structure

```
Web/Features/<Feature>/
├── <Feature>.cs                              # Domain model
├── <Feature>Repository.cs                    # IBlogPostRepository + MongoDB impl
├── <Feature>Extensions.cs                    # AddFeatureFeature() DI extension
├── Commands/
│   ├── Create<Feature>/
│   │   ├── Create<Feature>Command.cs
│   │   ├── Create<Feature>Handler.cs
│   │   └── Create<Feature>Validator.cs
│   ├── Update<Feature>/
│   │   ├── Update<Feature>Command.cs
│   │   ├── Update<Feature>Handler.cs
│   │   └── Update<Feature>Validator.cs
│   └── Delete<Feature>/
│       ├── Delete<Feature>Command.cs
│       └── Delete<Feature>Handler.cs
├── Queries/
│   ├── Get<Feature>ById/
│   │   ├── Get<Feature>ByIdQuery.cs
│   │   └── Get<Feature>ByIdHandler.cs
│   └── Get<Feature>List/
│       ├── Get<Feature>ListQuery.cs
│       └── Get<Feature>ListHandler.cs
└── Pages/
    ├── <Feature>ListPage.razor      # /url-prefix — table + delete confirm modal
    ├── <Feature>AddPage.razor       # /url-prefix/add — add form
    ├── <Feature>EditPage.razor      # /url-prefix/{id}/edit — edit form
    ├── <Feature>DetailsPage.razor   # /url-prefix/{id} — read-only details
    └── <Feature>Form.razor          # Shared form component (reused by Add + Edit)
```

Also ensure `Web/Features/_Imports.razor` exists (create if missing).

---

## Step 6 — Generate domain model

```csharp
// Web/Features/<Feature>/<Feature>.cs
using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace Web.Features.<Feature>;

public class <Feature>
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();

    // Add domain properties here, e.g.:
    // public string Title { get; set; } = string.Empty;
    // public string Description { get; set; } = string.Empty;
    // public bool IsActive { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}
```

---

## Step 7 — Generate repository

```csharp
// Web/Features/<Feature>/<Feature>Repository.cs
using MongoDB.Driver;
using Web.Shared;

namespace Web.Features.<Feature>;

public interface I<Feature>Repository
{
    Task<Result<<Feature>?>> GetByIdAsync(string id, CancellationToken ct = default);
    Task<Result<List<<Feature>>>> GetAllAsync(CancellationToken ct = default);
    Task<Result<string>> CreateAsync(<Feature> entity, CancellationToken ct = default);
    Task<Result> UpdateAsync(<Feature> entity, CancellationToken ct = default);
    Task<Result> DeleteAsync(string id, CancellationToken ct = default);
}

public class <Feature>Repository(IMongoDatabase database) : I<Feature>Repository
{
    private readonly IMongoCollection<<Feature>> _collection =
        database.GetCollection<<Feature>>("<feature>s"); // camelCase plural, e.g. "blogPosts"

    public async Task<Result<<Feature>?>> GetByIdAsync(string id, CancellationToken ct = default)
    {
        var item = await _collection.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Result.Success<<Feature>?>(item);
    }

    public async Task<Result<List<<Feature>>>> GetAllAsync(CancellationToken ct = default)
    {
        var items = await _collection.Find(_ => true)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync(ct);
        return Result.Success(items);
    }

    public async Task<Result<string>> CreateAsync(<Feature> entity, CancellationToken ct = default)
    {
        await _collection.InsertOneAsync(entity, null, ct);
        return Result.Success(entity.Id);
    }

    public async Task<Result> UpdateAsync(<Feature> entity, CancellationToken ct = default)
    {
        entity.UpdatedAt = DateTime.UtcNow;
        var result = await _collection.ReplaceOneAsync(x => x.Id == entity.Id, entity, cancellationToken: ct);
        return result.ModifiedCount > 0
            ? Result.Success()
            : Result.Failure($"<Feature> with id '{entity.Id}' not found.");
    }

    public async Task<Result> DeleteAsync(string id, CancellationToken ct = default)
    {
        var result = await _collection.DeleteOneAsync(x => x.Id == id, ct);
        return result.DeletedCount > 0
            ? Result.Success()
            : Result.Failure($"<Feature> with id '{id}' not found.");
    }
}
```

---

## Step 8 — Generate commands

### Create command

```csharp
// Commands/Create<Feature>/Create<Feature>Command.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Commands.Create<Feature>;

public record Create<Feature>Command(
    // Include all required properties, e.g.:
    // string Title,
    // string Description,
    // bool IsActive = false
) : IRequest<Result<string>>;
```

```csharp
// Commands/Create<Feature>/Create<Feature>Handler.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Commands.Create<Feature>;

public class Create<Feature>Handler(I<Feature>Repository repository)
    : IRequestHandler<Create<Feature>Command, Result<string>>
{
    public async Task<Result<string>> Handle(Create<Feature>Command request, CancellationToken ct)
    {
        var entity = new <Feature>
        {
            // Map from request properties
        };
        return await repository.CreateAsync(entity, ct);
    }
}
```

```csharp
// Commands/Create<Feature>/Create<Feature>Validator.cs
using FluentValidation;

namespace Web.Features.<Feature>.Commands.Create<Feature>;

public class Create<Feature>Validator : AbstractValidator<Create<Feature>Command>
{
    public Create<Feature>Validator()
    {
        // Add rules for each required property, e.g.:
        // RuleFor(x => x.Title).NotEmpty().MaximumLength(200);
        // RuleFor(x => x.Description).NotEmpty();
    }
}
```

### Update command

```csharp
// Commands/Update<Feature>/Update<Feature>Command.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Commands.Update<Feature>;

public record Update<Feature>Command(
    string Id
    // Include the same editable properties as Create
) : IRequest<Result>;
```

```csharp
// Commands/Update<Feature>/Update<Feature>Handler.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Commands.Update<Feature>;

public class Update<Feature>Handler(I<Feature>Repository repository)
    : IRequestHandler<Update<Feature>Command, Result>
{
    public async Task<Result> Handle(Update<Feature>Command request, CancellationToken ct)
    {
        var existing = await repository.GetByIdAsync(request.Id, ct);
        if (!existing.IsSuccess || existing.Value is null)
            return Result.Failure($"<Feature> with id '{request.Id}' not found.");

        var entity = existing.Value;
        // Map updated fields from request
        return await repository.UpdateAsync(entity, ct);
    }
}
```

```csharp
// Commands/Update<Feature>/Update<Feature>Validator.cs
using FluentValidation;

namespace Web.Features.<Feature>.Commands.Update<Feature>;

public class Update<Feature>Validator : AbstractValidator<Update<Feature>Command>
{
    public Update<Feature>Validator()
    {
        RuleFor(x => x.Id).NotEmpty();
        // Same rules as Create validator
    }
}
```

### Delete command

```csharp
// Commands/Delete<Feature>/Delete<Feature>Command.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Commands.Delete<Feature>;

public record Delete<Feature>Command(string Id) : IRequest<Result>;
```

```csharp
// Commands/Delete<Feature>/Delete<Feature>Handler.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Commands.Delete<Feature>;

public class Delete<Feature>Handler(I<Feature>Repository repository)
    : IRequestHandler<Delete<Feature>Command, Result>
{
    public Task<Result> Handle(Delete<Feature>Command request, CancellationToken ct)
        => repository.DeleteAsync(request.Id, ct);
}
```

---

## Step 9 — Generate queries

```csharp
// Queries/Get<Feature>ById/Get<Feature>ByIdQuery.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Queries.Get<Feature>ById;

public record Get<Feature>ByIdQuery(string Id) : IRequest<Result<<Feature>?>>;
```

```csharp
// Queries/Get<Feature>ById/Get<Feature>ByIdHandler.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Queries.Get<Feature>ById;

public class Get<Feature>ByIdHandler(I<Feature>Repository repository)
    : IRequestHandler<Get<Feature>ByIdQuery, Result<<Feature>?>>
{
    public Task<Result<<Feature>?>> Handle(Get<Feature>ByIdQuery request, CancellationToken ct)
        => repository.GetByIdAsync(request.Id, ct);
}
```

```csharp
// Queries/Get<Feature>List/Get<Feature>ListQuery.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Queries.Get<Feature>List;

public record Get<Feature>ListQuery : IRequest<Result<List<<Feature>>>>;
```

```csharp
// Queries/Get<Feature>List/Get<Feature>ListHandler.cs
using MediatR;
using Web.Shared;

namespace Web.Features.<Feature>.Queries.Get<Feature>List;

public class Get<Feature>ListHandler(I<Feature>Repository repository)
    : IRequestHandler<Get<Feature>ListQuery, Result<List<<Feature>>>>
{
    public Task<Result<List<<Feature>>>> Handle(Get<Feature>ListQuery request, CancellationToken ct)
        => repository.GetAllAsync(ct);
}
```

---

## Step 10 — Generate DI extension

```csharp
// Web/Features/<Feature>/<Feature>Extensions.cs
using FluentValidation;
using MediatR;
using Microsoft.Extensions.DependencyInjection;
using Web.Shared;

namespace Web.Features.<Feature>;

public static class <Feature>Extensions
{
    public static IServiceCollection Add<Feature>Feature(this IServiceCollection services)
    {
        services.AddScoped<I<Feature>Repository, <Feature>Repository>();

        services.AddMediatR(cfg =>
            cfg.RegisterServicesFromAssembly(typeof(<Feature>Repository).Assembly));

        services.AddValidatorsFromAssemblyContaining<<Feature>Repository>();

        services.AddTransient(typeof(IPipelineBehavior<,>), typeof(ValidationBehavior<,>));

        return services;
    }
}
```

---

## Step 11 — Wire up Program.cs and appsettings.json

### appsettings.json — add if not present

```json
{
  "ConnectionStrings": {
    "MongoDB": "mongodb://localhost:27017"
  },
  "MongoDB": {
    "DatabaseName": "MyAppDb"
  }
}
```

### Program.cs — add if not already registered

```csharp
using MongoDB.Driver;
using Web.Features.<Feature>;

// MongoDB singleton + scoped database
builder.Services.AddSingleton<IMongoClient>(_ =>
    new MongoClient(builder.Configuration.GetConnectionString("MongoDB") ?? "mongodb://localhost:27017"));
builder.Services.AddScoped(sp =>
    sp.GetRequiredService<IMongoClient>()
      .GetDatabase(builder.Configuration["MongoDB:DatabaseName"] ?? "MyAppDb"));

// Feature slices
builder.Services.Add<Feature>Feature();
```

---

## Step 12 — Generate Blazor UI

### 12a. Shared `_Imports.razor` for Features folder

Create `Web/Features/_Imports.razor` if not present:

```razor
@using System.Net.Http
@using Microsoft.AspNetCore.Components.Forms
@using Microsoft.AspNetCore.Components.Routing
@using Microsoft.AspNetCore.Components.Web
@using static Microsoft.AspNetCore.Components.Web.RenderMode
@using Microsoft.AspNetCore.Components.Web.Virtualization
@using Microsoft.JSInterop
@using Web
@using MediatR
```

### 12b. Shared form component

`Web/Features/<Feature>/Pages/<Feature>Form.razor` — receives a model and exposes callbacks. Used by both Add and Edit pages.

```razor
@* <Feature>Form.razor — reusable form for Add and Edit *@

<div class="space-y-5">
    @* Render one labeled input per domain property. Example: *@

    <div>
        <label class="block text-sm font-medium text-[--color-primary] dark:text-[--color-primary-light] mb-1">Title</label>
        <input @bind="Model.Title"
               class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600
                      bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                      focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
               placeholder="Enter title" />
    </div>

    @* Add an input/textarea/checkbox for each property *@

    @if (!string.IsNullOrEmpty(ErrorMessage))
    {
        <p class="text-sm text-red-500 dark:text-red-400">@ErrorMessage</p>
    }
</div>

@code {
    [Parameter, EditorRequired] public <Feature>FormModel Model { get; set; } = new();
    [Parameter] public string? ErrorMessage { get; set; }
}

@* Place this class in the same file or a sibling .cs file *@
@code {
    public sealed class <Feature>FormModel
    {
        // Mirror the editable properties of the domain model, e.g.:
        // public string Title { get; set; } = string.Empty;
        // public string Description { get; set; } = string.Empty;
        // public bool IsActive { get; set; }
    }
}
```

### 12c. List page with table and delete confirmation

`Web/Features/<Feature>/Pages/<Feature>ListPage.razor`

```razor
@page "/url-prefix"
@rendermode InteractiveServer
@inject IMediator Mediator
@inject NavigationManager Nav

<PageTitle><Feature>s</PageTitle>

<div class="max-w-6xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
        <h1 class="text-3xl font-bold text-gray-900 dark:text-white"><Feature>s</h1>
        <a href="/url-prefix/add"
           class="px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg
                  hover:bg-[var(--color-primary-light)] transition-colors font-medium">
            + Add New
        </a>
    </div>

    @if (_loading)
    {
        <div class="space-y-3">
            @for (var i = 0; i < 5; i++)
            {
                <div class="h-12 rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse"></div>
            }
        </div>
    }
    else if (_items is { Count: 0 })
    {
        <div class="text-center py-20 text-gray-400 dark:text-gray-500">
            <p class="text-5xl mb-4">📭</p>
            <p class="text-lg">No items yet. <a href="/url-prefix/add" class="underline text-[var(--color-primary)]">Add the first one</a>.</p>
        </div>
    }
    else
    {
        <div class="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
            <table class="w-full text-sm text-left">
                <thead class="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 uppercase text-xs tracking-wider">
                    <tr>
                        @* Add a <th> per visible column *@
                        <th class="px-4 py-3">Title</th>
                        <th class="px-4 py-3">Created</th>
                        <th class="px-4 py-3 text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-700">
                    @foreach (var item in _items!)
                    {
                        <tr class="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors">
                            @* Add a <td> per visible column *@
                            <td class="px-4 py-3 font-medium text-gray-900 dark:text-white">@item.Title</td>
                            <td class="px-4 py-3 text-gray-500 dark:text-gray-400">@item.CreatedAt.ToString("MMM d, yyyy")</td>
                            <td class="px-4 py-3">
                                <div class="flex items-center justify-end gap-2">
                                    <a href="/url-prefix/@item.Id"
                                       class="px-2 py-1 text-xs rounded-md bg-gray-100 dark:bg-gray-700 text-[--color-primary] dark:text-[--color-primary-light] hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                                        Details
                                    </a>
                                    <a href="/url-prefix/@item.Id/edit"
                                       class="px-2 py-1 text-xs rounded-md bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors">
                                        Edit
                                    </a>
                                    <button @onclick="() => PromptDelete(item)"
                                            class="px-2 py-1 text-xs rounded-md bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900 transition-colors">
                                        Delete
                                    </button>
                                </div>
                            </td>
                        </tr>
                    }
                </tbody>
            </table>
        </div>
    }

    @if (!string.IsNullOrEmpty(_error))
    {
        <div class="mt-4 p-4 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-xl text-red-700 dark:text-red-300">
            @_error
        </div>
    }
</div>

@* Delete confirmation modal *@
@if (_deleteTarget is not null)
{
    <div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md">
            <div class="p-6">
                <h2 class="text-xl font-semibold text-gray-900 dark:text-white mb-2">Confirm Delete</h2>
                <p class="text-gray-600 dark:text-gray-300">
                    Are you sure you want to delete <strong>@_deleteTarget.Title</strong>?
                    This action cannot be undone.
                </p>
            </div>
            <div class="flex gap-3 justify-end px-6 pb-6">
                <button @onclick="CancelDelete"
                        class="px-4 py-2 rounded-lg text-[--color-primary] dark:text-[--color-primary-light] hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                    Cancel
                </button>
                <button @onclick="ConfirmDelete" disabled="@_deleting"
                        class="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors font-medium disabled:opacity-50">
                    @(_deleting ? "Deleting…" : "Yes, Delete")
                </button>
            </div>
        </div>
    </div>
}

@code {
    private List<<Feature>>? _items;
    private bool _loading = true;
    private string? _error;
    private <Feature>? _deleteTarget;
    private bool _deleting;

    protected override async Task OnInitializedAsync() => await LoadAsync();

    private async Task LoadAsync()
    {
        _loading = true;
        _error = null;
        var result = await Mediator.Send(new Get<Feature>ListQuery());
        if (result.IsSuccess) _items = result.Value;
        else _error = result.Error;
        _loading = false;
    }

    private void PromptDelete(<Feature> item)
    {
        _deleteTarget = item;
        _error = null;
    }

    private void CancelDelete() => _deleteTarget = null;

    private async Task ConfirmDelete()
    {
        if (_deleteTarget is null) return;
        _deleting = true;
        var result = await Mediator.Send(new Delete<Feature>Command(_deleteTarget.Id));
        _deleting = false;
        _deleteTarget = null;
        if (result.IsSuccess) await LoadAsync();
        else _error = result.Error;
    }
}
```

### 12d. Add page

`Web/Features/<Feature>/Pages/<Feature>AddPage.razor`

```razor
@page "/url-prefix/add"
@rendermode InteractiveServer
@inject IMediator Mediator
@inject NavigationManager Nav

<PageTitle>Add <Feature></PageTitle>

<div class="max-w-2xl mx-auto px-4 py-8">
    <div class="flex items-center gap-3 mb-6">
        <a href="/url-prefix" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">← Back</a>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Add <Feature></h1>
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <<Feature>Form Model="_model" ErrorMessage="@_error" />

        <div class="mt-6 flex gap-3 justify-end">
            <a href="/url-prefix"
               class="px-4 py-2 rounded-lg text-[--color-primary] dark:text-[--color-primary-light] hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                Cancel
            </a>
            <button @onclick="Submit" disabled="@_saving"
                    class="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-light)] transition-colors font-medium disabled:opacity-50">
                @(_saving ? "Saving…" : "Create")
            </button>
        </div>
    </div>
</div>

@code {
    private <Feature>Form.<Feature>FormModel _model = new();
    private bool _saving;
    private string? _error;

    private async Task Submit()
    {
        _saving = true;
        _error = null;
        try
        {
            var cmd = new Create<Feature>Command(/* map _model properties */);
            var result = await Mediator.Send(cmd);
            if (result.IsSuccess)
                Nav.NavigateTo("/url-prefix");
            else
                _error = result.Error;
        }
        catch (FluentValidation.ValidationException ex)
        {
            _error = string.Join(" ", ex.Errors.Select(e => e.ErrorMessage));
        }
        finally
        {
            _saving = false;
        }
    }
}
```

### 12e. Edit page

`Web/Features/<Feature>/Pages/<Feature>EditPage.razor`

```razor
@page "/url-prefix/{id}/edit"
@rendermode InteractiveServer
@inject IMediator Mediator
@inject NavigationManager Nav

<PageTitle>Edit <Feature></PageTitle>

<div class="max-w-2xl mx-auto px-4 py-8">
    <div class="flex items-center gap-3 mb-6">
        <a href="/url-prefix/@Id" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">← Back</a>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Edit <Feature></h1>
    </div>

    @if (_loading)
    {
        <div class="h-48 rounded-2xl bg-gray-200 dark:bg-gray-700 animate-pulse"></div>
    }
    else if (_notFound)
    {
        <div class="p-6 bg-red-50 dark:bg-red-950 rounded-2xl text-red-700 dark:text-red-300">
            Item not found.
        </div>
    }
    else
    {
        <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <<Feature>Form Model="_model" ErrorMessage="@_error" />

            <div class="mt-6 flex gap-3 justify-end">
                <a href="/url-prefix/@Id"
                   class="px-4 py-2 rounded-lg text-[--color-primary] dark:text-[--color-primary-light] hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                    Cancel
                </a>
                <button @onclick="Submit" disabled="@_saving"
                        class="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-light)] transition-colors font-medium disabled:opacity-50">
                    @(_saving ? "Saving…" : "Save Changes")
                </button>
            </div>
        </div>
    }
</div>

@code {
    [Parameter] public string Id { get; set; } = string.Empty;

    private <Feature>Form.<Feature>FormModel _model = new();
    private bool _loading = true;
    private bool _notFound;
    private bool _saving;
    private string? _error;

    protected override async Task OnInitializedAsync()
    {
        var result = await Mediator.Send(new Get<Feature>ByIdQuery(Id));
        if (!result.IsSuccess || result.Value is null)
        {
            _notFound = true;
        }
        else
        {
            var item = result.Value;
            // Map domain model → form model, e.g.:
            // _model.Title = item.Title;
            // _model.Description = item.Description;
        }
        _loading = false;
    }

    private async Task Submit()
    {
        _saving = true;
        _error = null;
        try
        {
            var cmd = new Update<Feature>Command(Id /*, map _model properties */);
            var result = await Mediator.Send(cmd);
            if (result.IsSuccess)
                Nav.NavigateTo($"/url-prefix/{Id}");
            else
                _error = result.Error;
        }
        catch (FluentValidation.ValidationException ex)
        {
            _error = string.Join(" ", ex.Errors.Select(e => e.ErrorMessage));
        }
        finally
        {
            _saving = false;
        }
    }
}
```

### 12f. Details page

`Web/Features/<Feature>/Pages/<Feature>DetailsPage.razor`

```razor
@page "/url-prefix/{id}"
@rendermode InteractiveServer
@inject IMediator Mediator
@inject NavigationManager Nav

<PageTitle><Feature> Details</PageTitle>

<div class="max-w-2xl mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
            <a href="/url-prefix" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">← Back</a>
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white"><Feature> Details</h1>
        </div>
        @if (_item is not null)
        {
            <a href="/url-prefix/@Id/edit"
               class="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-light)] transition-colors font-medium text-sm">
                Edit
            </a>
        }
    </div>

    @if (_loading)
    {
        <div class="h-48 rounded-2xl bg-gray-200 dark:bg-gray-700 animate-pulse"></div>
    }
    else if (_item is null)
    {
        <div class="p-6 bg-red-50 dark:bg-red-950 rounded-2xl text-red-700 dark:text-red-300">
            Item not found.
        </div>
    }
    else
    {
        <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
            @* Add a detail row per property. Template: *@
            <div class="px-6 py-4 flex gap-4">
                <span class="w-32 shrink-0 text-sm font-medium text-gray-500 dark:text-gray-400">Title</span>
                <span class="text-gray-900 dark:text-white">@_item.Title</span>
            </div>
            <div class="px-6 py-4 flex gap-4">
                <span class="w-32 shrink-0 text-sm font-medium text-gray-500 dark:text-gray-400">Created</span>
                <span class="text-gray-900 dark:text-white">@_item.CreatedAt.ToString("MMM d, yyyy HH:mm")</span>
            </div>
            @if (_item.UpdatedAt.HasValue)
            {
                <div class="px-6 py-4 flex gap-4">
                    <span class="w-32 shrink-0 text-sm font-medium text-gray-500 dark:text-gray-400">Updated</span>
                    <span class="text-gray-900 dark:text-white">@_item.UpdatedAt.Value.ToString("MMM d, yyyy HH:mm")</span>
                </div>
            }
        </div>
    }
</div>

@code {
    [Parameter] public string Id { get; set; } = string.Empty;

    private <Feature>? _item;
    private bool _loading = true;

    protected override async Task OnInitializedAsync()
    {
        var result = await Mediator.Send(new Get<Feature>ByIdQuery(Id));
        _item = result.IsSuccess ? result.Value : null;
        _loading = false;
    }
}
```

---

## Step 13 — Add navigation links

In `NavMenu.razor`, add a NavLink for the new feature to both desktop links and the mobile menu:

```razor
<NavLink href="url-prefix"
         class="text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-[--color-primary] dark:hover:text-[--color-primary-light] transition-colors duration-200"
         ActiveClass="font-semibold border-b-2 pb-0.5" style="border-color: var(--color-primary); color: var(--color-primary)">
    <Feature>s
</NavLink>
```

---

## Step 14 — Rebuild and verify

```bash
dotnet build <WebProject>.csproj
```

Resolve any errors. Common issues:

- `static types cannot be used as type arguments` → use a non-static concrete type (e.g. `<Feature>Repository`) with `RegisterServicesFromAssembly` and `AddValidatorsFromAssemblyContaining`
- `InteractiveServer does not exist` → ensure `@using static Microsoft.AspNetCore.Components.Web.RenderMode` is in `_Imports.razor`
- `PageTitle not found` → same `_Imports.razor` fix
- Nullability mismatch on `Result<T?>` → use explicit type argument: `Result.Success<T?>(value)`

---

## Checklist

- [ ] Packages installed (MediatR, MongoDB.Driver, FluentValidation)
- [ ] `Result.cs` and `ValidationBehavior.cs` exist in `Web/Shared/`
- [ ] Domain model with `[BsonId]` created
- [ ] Repository interface + implementation created
- [ ] Create/Update/Delete commands + handlers + validators created
- [ ] GetById + GetList queries + handlers created
- [ ] DI extension `Add<Feature>Feature()` created
- [ ] `appsettings.json` has MongoDB connection string
- [ ] `Program.cs` registers MongoDB + calls `Add<Feature>Feature()`
- [ ] `_Imports.razor` exists for `Features/` folder
- [ ] `<Feature>Form.razor` shared form component created
- [ ] List page with table, Details/Edit/Delete action buttons, and delete confirmation modal created
- [ ] Add page with form and Create command wired up
- [ ] Edit page with pre-filled form and Update command wired up
- [ ] Details page with read-only field layout
- [ ] NavMenu links added (desktop + mobile)
- [ ] `dotnet build` passes with 0 errors
