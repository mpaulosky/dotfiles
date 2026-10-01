# Docs-only CI skip

Template files (Owned): `ci.yml`, `codeql-analysis.yml`, `.github/scripts/detect_changes.py` and its tests. History:
IssueTracker #175; atelier-store #95's review moved the classifier into a tested script, and IssueTracker #188 took it
back.

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
  (`test_detect_changes.py`, built on real git repos), not inline shell: Copilot asks for this every time.
- `build` gets `needs: changes` and `if: needs.changes.outputs.code == 'true'`. Test discovery, the matrix and coverage
  then skip through their `needs` chains.
- **`Test Suite`** (the `report` job, `if: always()`) needs `changes` too, and fails when `changes` didn't succeed.
  Otherwise a failed detection would skip the build *and* pass the suite. It keeps failing on any failed or cancelled
  job, and its summary notes a docs-only skip.
- **CodeQL:** add `paths-ignore: ["docs/**", "**/*.md"]` to its `pull_request` trigger. It isn't a required check, and
  its push and scheduled runs still cover `main`. Where a ruleset *does* require it (IssueManager required `Analyze
  (csharp)`), `paths-ignore` leaves the check unreported and blocks every docs PR: drop it from the required checks, or
  move the Template's CodeQL to the `needs: changes` gate first.
- Lint, Python and hook tests keep running on every PR; they take seconds.

## Adapting

Every required check (`gh api repos/<r>/rulesets` → `required_status_checks`) must be a gated job or a job that
tolerates the skip. A repo may already skip docs PRs its own way (IssueManager used `dorny/paths-filter` with an
allowlist of code paths, which also skipped the build for `.github/` changes); Apply replaces it with
`detect_changes.py`, which treats everything outside `docs/` and `*.md` as code.

## Verify live

1. **Before merging,** open a throwaway **draft** PR that changes one doc and targets the Standardize branch (not `main`).
   Its CI runs the new `ci.yml` against a docs-only diff: `Detect Changes` passes, the build, tests and coverage are
   skipped, and the report job (`Test Suite`) passes. Close it without
   merging. Keep the Standardize PR a draft until then, or it can auto-merge first. Lint workflows that only trigger
   for PRs into `main` don't run on the probe; that's expected.
2. **After merging,** the Standardize PR's release-blog PR is docs-only. It must merge under `main`'s ruleset with `Build
   Solution` skipped. This is the only proof the ruleset accepts the skip.
