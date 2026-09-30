---
name: remove-squad
description: Strip the squad-team framework out of one repo cleanly — its .squad/ directory, squad-prefixed workflows, coordinator agent, skill catalogs, MCP wiring, labels, branch patterns and stale references — while migrating its durable decisions into repo-native docs. Use when the user wants to remove, uninstall or migrate a repo off squad.
---

# Remove squad from a repo

Removes the squad-team framework from **one** repo per run. Derived from the IssueManager removal; every path, workflow
name and label prefix below is an example. The repo's own layout, as the scan shows it, is the truth.

The order matters: decisions (steps 1–2) come before deletion (3–9), because deletion is hard to reverse once the source
material is gone. Validation (10) comes last.

Do the work under the global change-management rules: a synced `main`, one worktree on a `chore/remove-squad` branch
(or whatever name the repo's pre-push hook accepts *today*, before step 2 changes it), local validation, a single push.
The removal is one PR unless the scan turns up enough to justify splitting it; if it does, step 2 goes in the first PR.

## Steps

### 0. Scope the footprint

Run [`scripts/scan-footprint.sh`](scripts/scan-footprint.sh) from the repo root. It is read-only and lists framework
directories, workflows, agents, skill directories, MCP, lint and ignore configs, hooks, other tracked files, untracked
runtime state, prefixed branches and labels (with their open-issue counts).

The footprint is always wider than `.squad/` and the files that read it. In IssueManager a first pass that only chased
`.squad/` readers missed a coordinator agent, ~80 skill directories across two catalogs and 9 more squad-prefixed
workflows.

Triage every hit into **delete**, **rewrite** or **keep (generic)**. Done when every line of the scan output has a
verdict, and the list is shown to the user before anything is deleted.

### 1. Migrate durable decisions

If `.squad/decisions.md` (or an archive of it) holds real, repo-specific decisions, move the durable ones into a
repo-native doc such as `docs/decisions.md`, in plain repo voice with the framework jargon stripped.

- **Keep** decisions about the system itself: data model, auth patterns, API conventions, branch protection,
  architectural trade-offs.
- **Drop** ceremony: agent casting, session logs, status reports, merge notes that duplicate `CHANGELOG.md` or git
  history, and one-off trail like dependency bumps or test-migration mechanics.
- **Add** one entry recording the removal itself; it is ADR-worthy (hard to reverse, a real trade-off).

Done when the new doc exists and every source entry is either migrated or consciously dropped. Leave the source in place
until step 3.

### 2. Update the branch-name convention

If the pre-push hook or a CI check enforces framework patterns (`squad/{issue}-{slug}`, `sprint/{n}-{slug}`), replace
them with the standard from the `repo-ci-baseline` skill (`feature/`, `fix/`, `hotfix/`, `chore/`). List in-flight
branches that carry the old prefixes (the scan shows them) and tell the user which ones need renaming or merging first.
Done when the new regex has been run against sample names that must pass *and* names that must fail.

### 3. Delete the framework directory and the workflows that read it

Delete `.squad/` and every workflow whose whole job is reading or writing it (heartbeat, triage, promote, issue-assign,
label-sync; names vary). Template copies of workflows under `.squad/templates/` go with the directory. Logs and
per-agent history files are operational trail: delete them outright, step 1 already saved what mattered.

### 4. Keep generic workflows, cut their coupling

Some squad-named workflows are repo-wide (a lint gate that already excludes `.squad/`). Keep them, and remove the
now-vestigial `.squad/` excludes from them and from `.gitignore`, `.gitattributes` and lint configs (`.yamllint.yml`,
`.markdownlint*`). Remove any MCP server entry dedicated to squad (e.g. in `.mcp.json`), and delete the untracked runtime
state it wrote to disk while its wiring still tells you where that is.

### 5. Delete or rename the remaining squad-prefixed workflows

Per workflow:

- **Delete** it when it is dead without the framework: gated on a squad label, calling a script that was never
  committed, or targeting a branch type the new convention no longer creates.
- **Rename** it when its job is generic (CI, release, label enforcement, README sync, dependency auto-merge): strip the
  prefix from the filename, display name, concurrency group and placeholder text; keep the logic.

Before renaming anything, check how the ruleset keys required checks (`gh api repos/{owner}/{repo}/rulesets` and branch
protection). Keyed on job name, a rename is safe. Keyed on workflow name, update the ruleset in step with the rename and
tell the user, since that is an outward-facing change.

### 6. Delete the coordinator agent and squad skill catalogs

Delete the coordinator agent file and every skill directory about squad internals, its CLI, cross-instance
communication or squad-specific workflow conventions. Keep skills that are generic or about the repo's own stack
(build/test loops, query patterns), and strip just the passing squad reference from them (a "see also" into the deleted
decision log).

### 7. Delete the squad labels

After steps 3 and 5 (so no running workflow re-applies them), confirm the scan shows zero open issues on every
`squad:*` label, then confirm with the user and delete the roster with `gh label delete <name> --yes`. Done when
`gh label list` shows none.

### 8. Sweep stale references

Re-run the scan and fix what it still finds in prose and config:

- README badges and links to renamed or deleted workflows.
- Prose about "the squad-based development model".
- Links into directories that no longer exist.
- Agent or prompt frontmatter (`agent: <Coordinator>`) pointing at the deleted agent.
- Header comments in hooks and scripts still naming squad conventions above already-updated code.

### 9. Consolidate duplicate hooks and scripts

Removal tends to expose duplication squad masked, e.g. a dead second copy of the pre-push hook under `scripts/` still
enforcing `squad/` names while `core.hooksPath` points at the real one. Delete the dead copy and its installer, and
repoint remaining references at the canonical location.

### 10. Validate

- A clean build and full test pass. A gap that predates this work (an E2E suite reporting zero tests) is not a
  regression; prove it predates the branch rather than blocking on it.
- The pre-push hook enforces exactly the step-2 pattern, and the workflow set matches the step 3–5 verdicts.
- A final scan where every remaining hit is **justified** in the PR description: a deliberately generic filename, an
  unrelated use of the word, the step-1 removal entry, dated historical docs. An unjustified hit is a dangling
  reference; fix it.
- Note any unrelated contamination the sweep surfaced (content bled in from a sibling repo) and clean it if it is cheap.

Done when all four hold, then push once and hand off to the `pr-watch-cleanup` skill. Once the PR has merged, offer the
`squad-branch-cleanup` skill for the leftover `squad/` and `sprint/` branches.
