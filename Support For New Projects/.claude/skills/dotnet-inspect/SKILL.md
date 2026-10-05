---
name: dotnet-inspect
description: "Inspect .NET APIs (types, members, signatures, version diffs, extension methods, implementors) in NuGet packages, platform libraries, and local .dll/.nupkg files. Use when answering what a .NET library contains, or when code broke after a package upgrade."
---

# dotnet-inspect

The same commands work across NuGet packages, platform libraries (System.*, Microsoft.AspNetCore.*), and local .dll/.nupkg files.

## Running it

Run through `dnx` (like `npx`), always with `-y` and `--` so it never prompts:

```bash
dnx dotnet-inspect -y -- <command>
```

## Pick a command

| Question | Command |
| -------- | ------- |
| Code broke after an upgrade | `diff --package Foo@old..new --oneline` to triage, then `diff -t Type ...` for detail, then `member Type --oneline` on the new version |
| What types are in this package? | `type` (terse, no docs; `--shape` for hierarchy) or `find` (glob search across any scope) |
| What's this type's API surface? | `member Type --package Foo --oneline` |
| Full signatures + docs | `member Type --package Foo -m Method` (docs on by default) |
| Source, lowered C#, IL | `member Type --package Foo -m Method -v:d` |
| Constructors | `member 'Type<T>' --package Foo -m .ctor` |
| All overloads | `member Type --package Foo --select` (shows `Name:N` indices) |
| What changed between versions? | `diff` (classifies breaking/additive) |
| What extends this type? | `extensions` (extension methods/properties) |
| What implements this interface / extends this base? | `implements` |
| What does this type depend on? | `depends` (walks interfaces and base classes upward) |
| Version, files, dependencies, NuGet search | `package` (`package search` for discovery) |
| Library metadata, symbols, references | `library` |
| Showcase | `demo` (list, invoke, or feeling-lucky) |

## Key patterns

Scan with `--oneline` by default; it works on `type`, `member`, `find`, `diff`, and `implements`:

```bash
dnx dotnet-inspect -y -- member JsonSerializer --package System.Text.Json --oneline
dnx dotnet-inspect -y -- type --package System.Text.Json --oneline
```

`--shape` shows a type's hierarchy and surface at a glance:

```bash
dnx dotnet-inspect -y -- type 'HashSet<T>' --platform System.Collections --shape
```

Fixing broken code after an upgrade runs `diff` first:

```bash
dnx dotnet-inspect -y -- diff --package System.CommandLine@2.0.0-beta4.22272.1..2.0.3 --oneline  # what changed?
dnx dotnet-inspect -y -- diff -t Command --package System.CommandLine@2.0.0-beta4.22272.1..2.0.3  # detail on Command
dnx dotnet-inspect -y -- member Command --package System.CommandLine@2.0.3 --oneline              # new API surface
```

## Search scope

`find`, `extensions`, `implements`, and `depends` take scope flags:

- **(no flags)**: platform frameworks + Microsoft.Extensions.AI
- **`--platform`**: all platform frameworks
- **`--extensions`**: curated Microsoft.Extensions.* packages
- **`--aspnetcore`**: curated Microsoft.AspNetCore.* packages
- **`--package Foo`**: a specific NuGet package (combinable with the scope flags)

`type`, `member`, `library`, and `diff` take `--platform <name>` as a string naming one platform library.

## Limiting output

Limit output with the tool's own flags, which keep headers and formatting intact (piping through `head`, `tail`, or `Select-Object` breaks them):

- **`-n N` or `-N`**: line limit, like `head`
- **`-s Section`**: show one section (glob-capable); `-s` alone lists the sections
- **`-v:q`**: quiet, compact summary

```bash
dnx dotnet-inspect -y -- member JsonSerializer --package System.Text.Json --oneline -10
dnx dotnet-inspect -y -- find "*Logger*" -n 5
dnx dotnet-inspect -y -- member JsonSerializer --package System.Text.Json -v:q -s Methods
```

## Syntax gotchas

- **Generic types** take quotes and `<T>`: `'Option<T>'` resolves to the concrete generic with constructors; `"Option<>"` resolves to the abstract base.
- **Filters**: `type` filters with `-t`, `member` with `-m` (dotted form works: `-m JsonSerializer.Deserialize`).
- **Diff ranges** use `..`: `--package System.Text.Json@9.0.0..10.0.0`.
- **Signatures** include `params` and default values from metadata.
- **Derived types** show only their own members, so query the base type too (`RootCommand` inherits `Add()` and `SetAction()` from `Command`).

## Full documentation

For full syntax, edge cases, and the flag compatibility matrix, run `dnx dotnet-inspect -y -- llmstxt`.
