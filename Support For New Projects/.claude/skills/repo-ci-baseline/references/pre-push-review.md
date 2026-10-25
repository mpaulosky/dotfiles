# Review before the push

Every branch is reviewed on the developer's machine before it is pushed, and the gate refuses a push without that review. GitHub's
reviewers (Copilot, Claude Review) are then a backstop that finds little.
Why: [ADR 0008](../docs/adr/0008-review-before-the-push.md). The process a developer follows is in `docs/PROCESS.md`; the skill that does it is
`.claude/skills/pre-push-review/SKILL.md`.

## What it is

| Piece | Where | Owned or Seed |
| --- | --- | --- |
| The skill: severities, steps, the ledger commands | `.claude/skills/pre-push-review/SKILL.md` | Owned |
| The reviewers' bar (Claude Review's own prompt, adapted) and the generic lenses | `.claude/skills/pre-push-review/review-bar.md`, `lenses.md` | Owned |
| The read-only reviewer agent (Read, Grep and Glob only) | `.claude/agents/pre-push-reviewer.md` | Owned |
| The ledger: what the review found and what became of it, keyed by the branch's own hunks | `.sandcastle/lib/review-ledger.mts` (run as `scripts/review.sh`) | Owned |
| The gate's check | `scripts/gate.sh`, step "Local review" | Owned |
| The repo's name for `GH_REPO` (`scripts/review.sh repo`) and its own non-Template files under Owned patterns | `REPO_SLUG`, `NOT_OWNED_BASELINE_PATHS` in `.sandcastle/lib/repo-config.mts` | Seed |
| The repo's own lenses, and the guidance reviewers read | `.claude/skills/code-review/SKILL.md`, `CLAUDE.md`, `docs/CODING_STANDARDS.md`, `.claude/rules/` | the repo's |

The ledger lives in the Sandcastle folder because it is TypeScript run with the repo's `tsx`, type-checked and tested with Sandcastle's code.
Apply adds the review to a repo only when it adds Sandcastle (`.sandcastle/` or no commits yet); `scripts/gate.sh` skips the check, with a warning,
where `.sandcastle/lib/review-ledger.mts` is missing.

## How it works

- `/pre-push-review` reviews the branch's whole diff against `origin/main` with parallel reviewers (the bar, plus one per matching lens),
  grades each finding **Critical** (a bug in code that runs, or behaviour with no test), **Warning** (a security weakness, whatever the file) or
  **Advisory** (docs, comments, conventions), fixes Critical and Advisory ones behind a regression test, reviews the fixes again until a round fixes nothing,
  and records the result.
- Critical and Warning findings left open block the push until the person fixes them or accepts them with `scripts/review.sh accept` (never on their behalf).
  Advisory findings never block: one that needs a person goes to one follow-up issue per branch.
- The ledger is keyed by the branch's hunks against its merge base with `origin/main`. A clean merge of `main` keeps the review; a new commit, a conflict
  resolution or a `main` change inside one of the branch's hunks needs a new one. A re-Apply on `chore/reapply-baseline` that changes only Owned files
  passes without one (`OWNED_PATHS` in the ledger lists them, and a dotfiles test keeps it equal to `template/owned/`).
- `GATE_SKIP_REVIEW=1` skips the check for gate runs while iterating, never for a push. Sandcastle's sandboxes set it (`SANDBOX_ENV` in `lib/skills.mts`):
  Sandcastle's own reviewer role stands in there, and running this review in a sandbox is not designed yet.
- Reviewers run as `pre-push-reviewer`, on Opus at high effort, because they read text people without write access wrote. They get no shell, network or token.

## What a sandbox can't see

Ledgers hold accepted security findings, which are never published. Every Sandcastle sandbox gets an empty read-only folder over `.git/review`, at every
path a mount puts `.git` (`protectedGitMounts` in `lib/host-safety.mts`, `withCreateMounts` in `lib/skills.mts`).

## Adapting

A repo that already has Sandcastle:

1. Add `REPO_SLUG` (`"<owner>/<repo>"`) and `NOT_OWNED_BASELINE_PATHS` to `.sandcastle/lib/repo-config.mts`, which Apply never rewrites. List in
   `NOT_OWNED_BASELINE_PATHS` the files under an Owned pattern (see `OWNED_PATHS` in `lib/review-ledger.mts`) that are the repo's own, such as its
   `sandcastle.yml` workflow and Sandcastle tests the Template lacks. `tsc --noEmit` fails until both exist.
2. Deny Claude Code reading the ledgers, in the repo's `.claude/settings.json` (the Template doesn't ship that file, since permissions are set per user):

   ```json
   { "permissions": { "deny": ["Read(//**/.git/review)", "Read(//**/.git/review/**)"] } }
   ```

3. Run `pnpm install` (the ledger needs `zod` and `tsx`, which Sandcastle's `package.json` already has), then `pnpm run check:sandcastle`.
4. The repo's own guidance for reviewers is optional: a `.claude/skills/code-review/SKILL.md` with a **Lenses** table of the same shape as `lenses.md` adds lenses
   (auth0-management-app's is the example), and `CLAUDE.md`, `docs/CODING_STANDARDS.md` and `.claude/rules/` are read when they exist.
5. If the repo's CLAUDE.md or CONTRIBUTING repeats the thread-reply rules, replace them with a link to `docs/PROCESS.md`.

## Not in it yet

- **Sandcastle running the review.** Its builds skip the check and keep their own reviewer role.
- **Claude Review taking the local review into account.** The planned follow-up: on `synchronize` review only what changed since the last review, open
  threads only for bugs, security and GitHub behaviour (list the rest as Advisory in the review body), and honour a PR description's `## Review notes`.
  That changes the Owned `claude-review.yml`, so it is its own PR.
