# Squad-Team Removal Runbook

A repo-agnostic checklist for stripping the squad-team framework out of a
repository that has moved on from it (e.g. switched to Claude Code, which
doesn't interface with squad). Derived from the actual removal performed
against IssueManager (tracked under its `wayfinder:map` issue "Remove
squad-team footprint from IssueManager"); IssueManager specifics below are
examples, not requirements — substitute your repo's own paths and names.

Work through the steps in order: decisions (1–2) before deletion (3–9),
because deletion is much harder to reverse once the source material is gone.
Validate (10) only after everything else lands.

## 0. Scope the footprint first

Don't assume the footprint is only `.squad/` and files that obviously read
it. In IssueManager, an initial pass that only touched the 5 workflows
reading `.squad/` content missed a coordinator agent file, ~80 skill
directories split across two skill catalogs, and 9 more squad-prefixed
workflows — all invisible to a `.squad/`-content grep. Before starting,
search broadly for the term itself, not just for files under the framework's
own directory:

```bash
grep -ril squad --include='*.md' --include='*.yml' --include='*.yaml' --include='*.json' .
```

Treat every hit as a candidate; triage each into "delete", "rewrite", or
"keep, it's generic" (step 4) before touching anything.

## 1. Migrate durable decisions out of the framework's decision log

If the framework's own decision log (e.g. `.squad/decisions.md`,
`.squad/decisions-archive.md`) holds real, repo-specific architectural
decisions — not template boilerplate or ceremony trail — migrate the durable
ones into a repo-native doc (e.g. `docs/decisions.md`) before deleting the
source:

- Keep: decisions about the actual system design (data model choices,
  auth patterns, API conventions, branch-protection rules, architectural
  trade-offs) — rewritten in plain repo voice, framework jargon stripped.
- Drop: framework-ceremony entries (agent casting, session-log ceremony,
  ephemeral status reports, PR-merge changelog entries that duplicate
  `CHANGELOG.md`/git history, and one-off engineering trail like dependency
  bump notes or test-migration mechanics).
- Add one new entry documenting the removal decision itself — it's usually
  ADR-worthy (hard to reverse, non-obvious to a future reader, a real
  trade-off was weighed) even though the rest of the migrated entries
  predate it.
- Don't delete the framework's source files in this same step; land the new
  doc first, delete the source in step 3 once it's no longer needed as a
  reference.

## 2. Update the branch-naming convention

If a pre-push hook or CI check enforces branch-name patterns tied to the
framework (e.g. `squad/{issue}-{slug}`, `sprint/{n}-{slug}`), update the
pattern before deleting anything else so in-flight branches aren't left in
limbo:

- Drop the framework-specific patterns.
- Add (or confirm) generic patterns for ongoing work: typically
  `feature/{slug}`, `fix/{slug}`, `chore/{slug}`, `hotfix/{slug}`.
- Verify the new regex against sample branch names for both the accepted
  and rejected cases before relying on it.

## 3. Delete the framework's own directory and the workflows that read it

Delete the framework's root directory (e.g. `.squad/`) and every workflow
whose entire job is reading or writing its content (heartbeat, triage,
promote, issue-assign, label-sync, etc. — names vary by framework).

Two things worth checking before you delete wholesale:

- **Template copies.** If the framework ships template files that duplicate
  a workflow already in `.github/workflows/` (e.g. a template copy of the
  heartbeat workflow inside the framework's own `templates/` subtree), you
  only need to delete the canonical one explicitly — the template copy
  disappears with the rest of the directory.
- **Operational trail vs. decisions.** Log files and per-agent history files
  under the framework's directory are operational trail, not decisions —
  delete them outright, no preservation needed (that's what step 1 was for).

## 4. Keep genuinely generic workflows, drop their framework coupling

Some workflows that live under the framework's naming prefix are actually
repo-wide and not squad-specific (e.g. lint gates that already scope
themselves away from the framework's directory). Keep those, but strip:

- Now-vestigial ignore/exclude lines referencing the framework's directory
  in the workflow itself, and in `.gitignore`, `.gitattributes`, and lint
  configs (e.g. `.yamllint.yml`).
- Any MCP server / tool wiring dedicated to the framework (e.g. an
  `.mcp.json` entry for a framework-specific state server) — remove the
  entry, and clean up any leftover untracked runtime state it wrote to disk
  before its wiring is gone (it won't get cleaned up automatically once the
  server can no longer run).

## 5. Delete or rewrite the remaining framework-prefixed workflows

For every other workflow carrying the framework's naming prefix, decide per
workflow:

- **Delete** if its entire function is framework-specific and dead once the
  framework is gone (e.g. gated on a label the framework owned, calls a
  script that was never actually committed to the repo, targets a branch
  type the new naming convention no longer creates).
- **Rename** if its function is actually generic (CI, release, label
  enforcement, README sync, dependency auto-merge) — strip the framework
  prefix from the filename, display name, concurrency-group name, and any
  placeholder text, but keep the logic.

Before renaming anything wired into branch protection, confirm how required
status checks are keyed. If they key on job name rather than workflow
filename (check the repo's ruleset/branch-protection settings), renaming
carries no merge-gating risk. If they key on filename, plan a coordinated
update to the ruleset alongside the rename.

## 6. Delete the framework's coordinator agent and skill catalogs

If the framework shipped an agent definition (a "coordinator" or similar)
and/or skill directories describing its internals, CLI, or conventions,
delete:

- The coordinator agent file.
- Every skill directory that documents framework internals, its CLI
  tooling, cross-instance communication, or framework-specific workflow
  conventions.

Keep skills that are genuinely generic or specific to the repo's own stack
(build/test loops, database query patterns, framework-agnostic conventions)
even if they happen to live in the same catalog. If a kept skill has a
leftover reference to the framework in passing (e.g. a "see also" link into
the deleted decision log), strip just that reference rather than deleting
the whole skill.

## 7. Delete the framework's issue-tracker labels

If the framework registered its own label set on the issue tracker (e.g. a
`squad:*` prefix), confirm zero open issues currently carry any of those
labels, then delete the full label roster. Do this after the workflow
deletions in steps 3 and 5 so nothing can silently re-apply a label you're
about to remove out from under a still-running workflow.

## 8. Sweep for stale references in docs and prose

Search again (same grep as step 0) for anything still pointing at the
framework:

- README badges/links pointing at renamed or deleted workflow files.
- Prose describing "the squad-based development model" or similar —
  rewrite or delete.
- Dead links to framework-specific directories that no longer exist.
- Any agent-definition frontmatter (e.g. Copilot prompt files with an
  `agent: <FrameworkAgentName>` field) still pointing at the coordinator
  agent you deleted in step 6.
- Stale header comments in hooks or scripts naming the framework or its
  conventions, even after the functional code they sit above has already
  been updated.

## 9. Consolidate duplicate hook/script copies uncovered along the way

Removal work has a way of surfacing pre-existing duplication that predates
the framework but was masked by it — e.g. two divergent copies of the same
git hook (one canonical, pointed to by `core.hooksPath`, one dead weight
under `scripts/` still enforcing the framework's retired branch convention).
When you find one, delete the dead copy and its installer, and repoint any
remaining reference (comments, docs) at the canonical location. This isn't
strictly framework removal, but it's exactly the kind of thing a careful
pass turns up — don't skip it just because it's not on the original list.

## 10. Validate

Once every step above is done:

- Run a full clean build and test pass. A pre-existing environmental gap
  (e.g. an E2E suite that reports zero tests run for unrelated reasons) is
  not a regression — confirm it predates this work rather than treating it
  as a blocker.
- Re-verify the hook and CI workflow set: confirm the branch-naming pattern
  from step 2 is what's actually enforced, and that the workflow set
  matches what steps 3–5 intended.
- Re-run the grep from step 0. Anything still matching should be
  consciously justified (a lint-gate filename that's intentionally generic,
  the word "squad" used in an unrelated generic sense, the ADR entry from
  step 1 itself, dated historical docs) — not silently ignored. Anything
  that isn't justified is a dangling reference: fix it before calling the
  removal done.
- While sweeping, watch for unrelated contamination that removal work incidentally
  surfaces (e.g. content that bled in from a sibling repo via a shared
  template or copy-paste). It's not framework removal, but it's cheap to
  clean up once you're already looking, and expensive to leave for someone
  else to trip over later.

## Explicitly out of scope for this runbook

- Reconsidering the framework as a tool in general, across every repo that
  uses it — this runbook only removes it from one repo at a time.
- This runbook does not execute itself against a second repo. Run it fresh,
  by hand, against each target repo; don't assume file paths, workflow
  names, or label prefixes transfer exactly — verify them against that
  repo's own layout at step 0.
