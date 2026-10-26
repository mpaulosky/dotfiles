# Reading the Apply report

`apply.sh [--dry-run] <repo>` prints one report, the same shape for a dry run and a real run.
Each section maps to an action in Adapt ([adapt.md](adapt.md)).

| Section | Meaning | Action |
| --- | --- | --- |
| Placeholders | The `OWNER`, `REPO` and `SOLUTION` values, from `origin` and the single root `*.slnx`; `?` when not found | A `?` leaves those placeholders unfilled |
| Owned files added | The repo lacked them | None; review them in the Apply commit |
| Owned files overwritten | **Drift**: the repo's copy differed in content or execute bit | Each one is drift to drop, or a local fix to move into the Template first |
| Owned files already identical | Count only | None |
| Sandcastle files left out | Count of the [Sandcastle section](sandcastle.md)'s files skipped because the repo has no `.sandcastle/` folder | None; to add them, create `.sandcastle/` and Apply again |
| Seed files written | New, placeholders filled | Fill any left in "unfilled placeholders", which counts only `{{OWNER}}`, `{{REPO}}` and `{{SOLUTION}}` |
| Seed files skipped | The repo has its own copy, kept as is | Compare with the Template's and merge what the repo lacks |
| Leftovers | Files under `.github/workflows`, `.github/hooks` or `.github/scripts` the Template doesn't carry | Delete, keep as repo-specific, or move into the Template |
| Conflicts | Known clashes: a `.markdownlint.*` file that overrides the Template's rules, squad still installed | Fix before landing |

## Guards

A real run refuses a dirty worktree (untracked files count), a detached `HEAD`, and `main`, `preview` or `dev`, so the Apply commit is exactly the script's output on a work branch.
A repo with no commits yet is allowed on any branch.
A dry run has no guards and writes nothing, not even `core.hooksPath`.

The Sandcastle section (`.sandcastle/`, `package.json`, `pnpm-workspace.yaml`, and the local review's skill, agent
and `scripts/review.sh`) is written only into a repo with a `.sandcastle/` folder or no commits yet
([sandcastle.md](sandcastle.md#when-apply-adds-it)).

## What it never does

Delete.
Leftovers and conflicts are reported for a person to decide, because a workflow the Template doesn't know may be a real feature (TicketManager's `generate-blog-posts-json.yml`).
