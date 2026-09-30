---
name: repo-ci-baseline
description: The standard CI, release and git-hook baseline for mpaulosky's .NET repos (branch-name standard, pre-commit and pre-push hooks, serialized releases with one blog PR per run, docs-only CI skip, per-project test matrix) and the process for porting it. Use when setting up or changing a repo's hooks, branch names, CI, release or blog-post workflows, porting the baseline to another repo, or when a hook, release, blog PR or docs-only PR misbehaves.
---

# Repo CI baseline

Every repo shares one CI and release baseline. It came from atelier-store and IssueTracker, and IssueTracker holds the
**reference implementation** of each part. A repo adopts the baseline by porting each part's *change* into its own
versions of the files, never by copying files over: repos drift (test runner, package manager, extra projects), and a
copied file silently undoes their local fixes.

## The parts

| Part | What it guarantees | Reference |
| --- | --- | --- |
| Git hooks and branch names | One branch-name standard; pushes are gated on the pushed commit; commits are linted as they'll be committed | [git-hooks.md](references/git-hooks.md), [pre-commit.md](references/pre-commit.md) |
| Serialized releases | Versions follow merge order, a missed or failed release is retried, and there's one blog PR per run | [release-pipeline.md](references/release-pipeline.md) |
| Docs-only CI skip | Blog and docs PRs skip the build and tests and merge in about a minute, while required checks still pass | [docs-only-ci.md](references/docs-only-ci.md) |
| Per-project test matrix | Each test project runs in its own job, with no build-output cache | [test-matrix.md](references/test-matrix.md) |
| Release labels | `semver:minor` and `semver:major` exist, because `release.yml` reads them | [release-pipeline.md](references/release-pipeline.md) |

Read a part's reference before touching it. Each one holds the design, the review findings that shaped it, and how to
verify it live.

## Porting the baseline to a repo

1. **Survey.** For each part, diff the repo's files against the reference implementation's version *before* that part's
   change, to see how the repo has drifted. Also record the pre-push hook's branch-name pattern, the ruleset's required
   checks, which Releases have no blog post, and which release labels are missing. Done when every drift and every one
   of those facts is listed, with how the port will handle it.
2. **Track.** Open one issue in the repo listing every part to port, in the order below. Done when the issue exists and
   names the reference PRs.
3. **Port one part per PR**, in this order: git hooks (the pre-commit lint, then the branch standard), the release
   pipeline, the docs-only skip, the test matrix, then labels. Each PR follows the repo's own branch, worktree and
   commit rules, and is validated locally (tests, `yamllint`, `actionlint`, `zizmor`, `shellcheck`) before its single
   push. Done when each PR has merged *and* its release-blog PR has merged.
4. **Verify live**, as each part's reference describes. A part counts as ported only once its live check has passed on
   the real repo, not when CI goes green on the PR.
5. **Record.** Add anything the port taught you to the relevant reference here, as a gotcha or a verification step. Done
   when the next port wouldn't hit the same surprise.

Merge the release-pipeline PR while nothing else is in flight: its own merge is the new workflow's first live run.

Each PR is reviewed by Copilot, and every thread gets fixed or answered, then resolved; expect several rounds on
workflow logic. The cross-cutting lessons, review handling included, are in [gotchas.md](references/gotchas.md).
