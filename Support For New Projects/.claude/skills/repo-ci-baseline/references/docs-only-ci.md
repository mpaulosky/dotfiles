# Docs-only CI skip

Reference: IssueTracker PR #175 (`ci.yml`, `codeql-analysis.yml`). Ported to atelier-store in #95, whose review moved
the classifier into `.github/scripts/detect_changes.py` with tests; IssueTracker took it back in #188.

## Why jobs skip themselves

`paths-ignore` can't be used on `pull_request` in `ci.yml`, because `Build Solution` and `Test Suite` are required
checks, and a required check that never reports blocks the merge. A job skipped by its own `if:` *does* report, and
GitHub counts it as passing, and so does auto-merge, which relies on GitHub's `CLEAN` merge state. The result: a blog
PR that took about 4 minutes and 17 runner-minutes merges in about 1 minute.

## Design

- **`Detect Changes` job:** on `pull_request`, check out with `fetch-depth: 0` and run
  `.github/scripts/detect_changes.py --base "$BASE_SHA" --output "$GITHUB_OUTPUT"`, which lists `git diff --name-only
  --no-renames -z` and appends `code=true|false`. The PR is docs-only when every path is under `docs/` or ends in `.md`.
  Everything else counts as code: workflows, scripts, project files, and an empty diff. Pushes and manual runs always
  output `code=true`. `--no-renames` lists a rename under both its paths, so moving code into `docs/` still runs the
  suite. The rule decides whether required checks run, so it lives in a script with tests
  (`test_detect_changes.py`, built on real git repos), not inline shell: Copilot asks for this on every port.
- `build` gets `needs: changes` and `if: needs.changes.outputs.code == 'true'`. Test discovery, the matrix and coverage
  then skip through their `needs` chains.
- **`Test Suite`** (the `report` job, `if: always()`) needs `changes` too, and fails when `changes` didn't succeed.
  Otherwise a failed detection would skip the build *and* pass the suite. It keeps failing on any failed or cancelled
  job, and its summary notes a docs-only skip.
- **CodeQL:** add `paths-ignore: ["docs/**", "**/*.md"]` to its `pull_request` trigger. It isn't a required check, and
  its push and scheduled runs still cover `main`.
- Lint, Python and hook tests keep running on every PR; they take seconds.

## Porting

Find the repo's required checks (`gh api repos/<r>/rulesets` → `required_status_checks`), and make sure each one is
either the gated job or a job that tolerates the skip.

## Verify live

1. **Before merging,** open a throwaway **draft** PR that changes one doc and targets the port's branch (not `main`).
   Its CI runs the new `ci.yml` against a docs-only diff: `Detect Changes` passes, the build, tests and coverage are
   skipped, and the report job (`Test Suite`, or `Test Report Summary` in atelier-store) passes. Close it without
   merging. Mark the port's own PR as a draft until then, or it can auto-merge first. Lint workflows that only trigger
   for PRs into `main` don't run on the probe; that's expected.
2. **After merging,** the port's own release-blog PR is docs-only. It must merge under `main`'s ruleset with `Build
   Solution` skipped. This is the only proof the ruleset accepts the skip.
