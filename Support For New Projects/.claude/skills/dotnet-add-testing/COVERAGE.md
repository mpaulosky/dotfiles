# Coverage thresholds and reports

Beyond the basic `coverlet.collector` run in [SKILL.md](SKILL.md).

## Enforce a threshold in CI

Thresholds need `coverlet.msbuild` (add it to the test `.csproj` or `tests/Directory.Build.props`, version in CPM):

```xml
<PackageReference Include="coverlet.msbuild" />
```

```bash
dotnet test /p:CollectCoverage=true \
  /p:CoverageOutputFormat=cobertura \
  /p:Threshold=80 \
  /p:ThresholdType=line
```

## HTML report

```bash
dotnet tool install -g dotnet-reportgenerator-globaltool
reportgenerator \
  -reports:"tests/**/coverage.cobertura.xml" \
  -targetdir:coverage-report \
  -reporttypes:Html
```
