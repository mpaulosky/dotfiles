# xUnit analyzers

`xunit.analyzers` (included with xUnit v3) flags test-authoring mistakes at compile time. Rules most often hit:

| Rule | Description | Severity |
| --- | --- | --- |
| `xUnit1004` | Test methods should not be skipped | Info |
| `xUnit1012` | Null should not be used for value type parameters | Warning |
| `xUnit1025` | `InlineData` should be unique within a `Theory` | Warning |
| `xUnit2000` | Constants and literals should be the expected argument | Warning |
| `xUnit2002` | Do not use null check on value type | Warning |
| `xUnit2007` | Do not use `typeof` expression to check type | Warning |
| `xUnit2013` | Do not use equality check to check collection size | Warning |
| `xUnit2017` | Do not use `Contains()` to check if value exists in a set | Warning |

To relax a rule for test projects, set its severity in `.editorconfig`:

```ini
[tests/**.cs]
# Allow skipped tests during development
dotnet_diagnostic.xUnit1004.severity = suggestion
```

[Full rule list](https://xunit.net/xunit.analyzers/rules/)
