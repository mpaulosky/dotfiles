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
  **Advisory** (docs, comments, conventions), fixes Critical ones behind a regression test and Advisory ones in the review (with a gate check when one can pin it),
  reviews the fixes again until a round fixes nothing, and records the result.
- Critical and Warning findings left open block the push until the person fixes them or accepts them with `scripts/review.sh accept` (never on their behalf).
  Advisory findings never block: one that needs a person goes to one follow-up issue per branch.
- The ledger is keyed by the branch's hunks against its merge base with `origin/main`. A clean merge of `main` keeps the review; a new commit, a conflict
  resolution or a `main` change inside one of the branch's hunks needs a new one. A re-Apply on `chore/reapply-baseline` passes without one only when every
  change is a regular Owned file added or modified, as Apply writes them (`OWNED_PATHS` in the ledger lists them, and a dotfiles test keeps it equal to
  `template/owned/`). A deleted Owned file, a symlink, a submodule, a file of the repo's own, or a Seed file the re-Apply writes because the repo lacked it
  needs a review like any other change.
- `GATE_SKIP_REVIEW=1` skips the check for gate runs while iterating, never for a push: the pre-push hook runs the gate without it. Sandcastle's sandboxes set it (`SANDBOX_ENV` in `lib/skills.mts`):
  Sandcastle's own reviewer role stands in there, and running this review in a sandbox is not designed yet.
- Reviewers run as `pre-push-reviewer`, on Sonnet at high effort, because they read text people without write access wrote. They have no shell, network or GitHub
  token, only Read, Grep and Glob. Those still reach any file the person can read, so a reviewer's answer is data to check before anything of it is published.

## What a sandbox can't see

Ledgers hold accepted security findings, which are never published. Every Sandcastle sandbox gets an empty read-only folder over `.git/review`, at every
path a mount puts `.git` (`protectedGitMounts` in `lib/host-safety.mts`, `withCreateMounts` in `lib/skills.mts`).

## Adapting

A repo that already has Sandcastle:

1. **First, in a PR of its own on `main`, before the re-Apply that brings the ledger**: add `REPO_SLUG` (`"<owner>/<repo>"`) and `NOT_OWNED_BASELINE_PATHS` to
   `.sandcastle/lib/repo-config.mts`, which Apply never rewrites. List in `NOT_OWNED_BASELINE_PATHS` each file (not a folder) under an Owned pattern (see
   `OWNED_PATHS` in `lib/review-ledger.mts`) that is the repo's own, such as its `sandcastle.yml` workflow and Sandcastle tests the Template lacks.
   Skipping this fails the re-Apply's push at the gate's "Local review" step, with tsx's "does not provide an export named" error, and adding the names on
   `chore/reapply-baseline` instead puts a file that isn't Owned in the re-Apply, which then needs a full review. The old gate has no review step, so the
   PR on `main` needs none.
2. Deny Claude Code reading the ledgers and credential files, in the repo's `.claude/settings.json` (the Template doesn't ship that file, since permissions are set per user):

   ```json
   { "permissions": { "deny": ["Read(//**/.git/review)", "Read(//**/.git/review/**)", "Read(//**/.env)", "Read(//**/.env.local)", "Read(//**/.env.*.local)", "Read(//**/.env.production)", "Read(//**/.env.staging)", "Read(//**/secrets/**)", "Read(//**/*.pem)", "Read(//**/*.key)", "Read(//**/*.pfx)", "Read(//**/*.p12)", "Read(//**/.git/config)", "Read(~/.ssh/**)", "Read(~/.config/gh/**)", "Read(~/.git-credentials)", "Read(~/.netrc)", "Read(~/.aws/**)", "Read(~/.azure/**)", "Read(~/.microsoft/usersecrets/**)", "Read(~/.claude/.credentials.json)"] } }
   ```

   The reviewers' Read and Grep follow these rules, and the agent's `tools:` line can't narrow them to paths, so this is what keeps a reviewer off the
   usual credential files, not every secret a machine can hold. The rules apply to the whole session, and `Read(//**/.env.*)` also covers `.env.example`:
   add an allow rule for the templates you edit.

3. Run `pnpm install` (the ledger needs `zod` and `tsx`, both in the Seed `package.json`; a repo whose own `package.json` lacks `tsx` gets it when it migrates
   to the Sandcastle section), then `pnpm run check:sandcastle`. Add `scripts/review.sh`, `.claude/skills/pre-push-review` and
   `.claude/agents/pre-push-reviewer.md` to the pathspec in the repo's Sandcastle check (the Seed `.sandcastle/check.sh` has them), since its tests read them.
4. The repo's own guidance for reviewers is optional: a `.claude/skills/code-review/SKILL.md` with a **Lenses** table of the same shape as `lenses.md` adds lenses
   and `CLAUDE.md`, `.sandcastle/CODING_STANDARDS.md` (or `docs/CODING_STANDARDS.md`) and `.claude/rules/` are read when they exist. A lesson from a GitHub review goes into the
   repo's `code-review` skill, not into the Owned `lenses.md` or `review-bar.md` (the next Apply reverts those): to change them, change the Template first.
5. If the repo's CLAUDE.md or CONTRIBUTING repeats the thread-reply rules, replace them with a link to `docs/PROCESS.md`.

## Not in it yet

- **Sandcastle running the review.** Its builds skip the check and keep their own reviewer role.
- **Claude Review taking the local review into account.** The planned follow-up: on `synchronize` review only what changed since the last review, open
  threads only for bugs, security and GitHub behaviour (list the rest as Advisory in the review body), and honour a PR description's `## Review notes`.
  That changes the Owned `claude-review.yml`, so it is its own PR.
