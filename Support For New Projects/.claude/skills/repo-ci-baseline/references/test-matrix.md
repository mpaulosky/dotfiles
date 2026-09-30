# Per-project test matrix

Reference: IssueTracker PR #178 (`ci.yml`).

## The rule

Each test project runs in its own matrix job and restores and builds its own project. The build job caches no `bin/` or
`obj/`: nothing restored that cache, so the step only cost time.

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

## Porting

Remove any "Cache build artifacts" step whose cache no job restores. Keep the NuGet package cache. Add a comment on the
test job that states the measured reason, so a build cache isn't added back without new numbers.

Confirm the cache is dead before removing it: `grep -n "build-" .github/workflows/*.yml` should find only the step
that saves it. Measure what it costs, for the PR description: the step's time in recent `main` runs
(`gh api repos/<r>/actions/runs/<id>/jobs`), and its storage (`gh api "repos/<r>/actions/caches?key=Linux-build-"`
against `actions/cache/usage`). In atelier-store (#99) it restored *after* the build, cost 5 to 8 seconds per run, and
held 1.1 GB of the repo's 7.9 GB of cache, crowding the NuGet caches under GitHub's 10 GB limit.

## Measuring a repo

To re-measure: push each variant to its own branch and dispatch `ci.yml` on each (`gh workflow run ci.yml --ref
<branch>`), one run at a time, over several rounds that include `main` as the baseline. Record the conclusion,
wall-clock time (`run_started_at` to `updated_at`) and summed job durations. Treat a failure as a finding to explain,
not noise.
