# Per-project test matrix

Template files (Owned): `ci.yml` (the `discover-tests`, `test` and `coverage` jobs), `.github/scripts/discover_tests.py`, `global.json`, and the Seeds
`.github/ci/prepare.sh` and `.github/ci/coverage-threshold`. History: IssueTracker #178.

## The rule

Each test project runs in its own matrix job and restores and builds its own project.
A test project is one whose `IsTestProject` resolves to true, from its `.csproj` or the nearest `Directory.Build.props`
that sets it (atelier-store and Blazor-Server set it once in `tests/Directory.Build.props`). `discover_tests.py` fails
the job when `tests/` has projects but none of them is a test project: `Test Suite` passes a skipped matrix, so a
discovery miss would otherwise pass every PR with no tests run (atelier-store's first Standardize run did). The build job caches no `bin/` or
`obj/`: nothing restored that cache, so the step only cost time.

Tests run on **Microsoft Testing Platform** (`global.json` → `"test": {"runner": "Microsoft.Testing.Platform"}`), so
`ci.yml` passes MTP's options: `--report-xunit-trx` for the TRX report and `--coverage --coverage-output-format
cobertura` for coverage, not VSTest's `--logger` and `--collect`. A test project on VSTest fails under it; moving it is
an Adapt step ([adapt.md](adapt.md#test-runner)). The coverage job gates on line coverage at the percentage in the Seed
`.github/ci/coverage-threshold` (80 when the file is missing).

Per-repo setup (publishing a project, pulling images, a build tool) goes in the Seed `.github/ci/prepare.sh`, which
`ci.yml` calls as `prepare.sh build` and `prepare.sh test <test-name>` after the restore.

## Why (measured on IssueTracker, 8 test projects, 3 runs each)

| Option | Wall clock | Runner-minutes |
| --- | --- | --- |
| **Per-project matrix, no build cache** | **2.9 min** | 10.2 |
| Share the build output, tests run `--no-build` | 3.8 min | 10.3 |
| One job running every project in turn | 4.4 min | 4.2 |

- Most of each matrix job's cost is setup (checkout, .NET, the NuGet cache, restore), not the build (~15s).
- **Sharing the build saves nothing.** Packing the ~164 MB of output costs ~20s, and downloading and unpacking it ~9s
  per job. The jobs still need the NuGet cache and a restore, because `--no-build` skips compiling but the test host and
  Blazor static web assets load files from `.nuget/packages`. Without the restore, integration tests and `dotnet publish
  --no-build` fail.
- **One job** uses 60% fewer runner-minutes but is the slowest. Minutes are free for public repositories, so wall-clock
  time wins. For a private repository on paid minutes, or when concurrent PRs queue for runners, revisit this.

## Adapting

A repo's old "Cache build artifacts" step disappears with Apply. To report what it cost, for the PR description: its
time in recent `main` runs (`gh api repos/<r>/actions/runs/<id>/jobs`) and its storage (`gh api
"repos/<r>/actions/caches?key=Linux-build-"` against `actions/cache/usage`). In atelier-store (#99) it restored *after*
the build, cost 5 to 8 seconds per run, and held 1.1 GB of the repo's 7.9 GB of cache.

## Measuring a repo

To re-measure: push each variant to its own branch and dispatch `ci.yml` on each (`gh workflow run ci.yml --ref
<branch>`), one run at a time, over several rounds that include `main` as the baseline. Record the conclusion,
wall-clock time (`run_started_at` to `updated_at`) and summed job durations. Treat a failure as a finding to explain,
not noise.
