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
  suite. A **Dependabot GitHub Actions bump** also outputs `code=false`, so its build and tests are skipped while every
  other check runs: it only moves pinned action SHAs. All three must hold (`--author dependabot[bot]`, a
  `dependabot/github_actions/` branch, and only `.github/workflows/` or `.github/actions/` paths), so neither a person
  nor a mixed change can skip the build that way. NuGet and SDK bumps change what's built, so they always build.
  The script also writes `skip_reason` (`docs-only`, `actions-bump`, or empty), so the Test Suite summary names which
  skip it was rather than calling an Actions bump docs-only (Copilot on TicketManager #113). The rule decides whether required checks run, so it lives in a script with tests
  (`test_detect_changes.py`, built on real git repos), not inline shell: Copilot asks for this every time.
- **`docs-only` label:** the `docs-label` job (`Docs-only label`) mirrors `code` as the `docs-only` label on every
  same-repo PR, adding it for docs-only and removing it otherwise. Nothing reads it: the diff decides what runs, and the
  label is only for filtering PRs. A label would be the wrong input, because anyone with triage access can set one, and
  a label change doesn't re-run CI. The job is skipped for Dependabot and fork PRs, whose token is read-only.
  `release.yml` and `backfill-blog-posts.yml` also label the blog PRs they open, best-effort, so it shows before CI
  runs. Adding a label the repo lacks creates it in a default color; create it once for a color and description
  ([gotchas.md](gotchas.md#repo-drift)).
- `build` gets `needs: changes` and `if: needs.changes.outputs.code == 'true'`. Test discovery, the matrix and coverage
  then skip through their `needs` chains.
- **`Test Suite`** (the `report` job, `if: always()`) needs `changes` too, and fails when `changes` didn't succeed.
  Otherwise a failed detection would skip the build *and* pass the suite. It keeps failing on any failed or cancelled
  job, and its summary notes a docs-only skip.
- **CodeQL:** add `paths-ignore: ["docs/**", "**/*.md"]` to its `pull_request` trigger. It isn't a required check, and
  its push and scheduled runs still cover `main`. Where a ruleset *does* require it (IssueManager required `Analyze
  (csharp)`), `paths-ignore` leaves the check unreported and blocks every docs PR. The standard never requires CodeQL,
  so `github-settings.sh --fix` drops it from the required checks ([github-settings.md](github-settings.md)).
- Lint, Python and hook tests keep running on every PR; they take seconds.

## Adapting

Every required check (`gh api repos/<r>/rulesets` → `required_status_checks`) must be a gated job or a job that
tolerates the skip. A repo may already skip docs PRs its own way (IssueManager used `dorny/paths-filter` with an
allowlist of code paths, which also skipped the build for `.github/` changes); Apply replaces it with
`detect_changes.py`, which treats everything outside `docs/` and `*.md` as code.

## Verify live

1. **Before merging,** open a throwaway **draft** PR that changes one doc and targets the Standardize branch (not `main`).
   Its CI runs the new `ci.yml` against a docs-only diff: `Detect Changes` passes, the build, tests and coverage are
   skipped, the report job (`Test Suite`) passes, and `Docs-only label` adds `docs-only`. Close it without
   merging. Keep the Standardize PR a draft until then, or it can auto-merge first. Lint workflows that only trigger
   for PRs into `main` don't run on the probe; that's expected.
2. **After merging,** the Standardize PR's release-blog PR is docs-only. It must merge under `main`'s ruleset with `Build
   Solution` skipped. This is the only proof the ruleset accepts the skip.
