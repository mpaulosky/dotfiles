# Review before the push

Every branch is reviewed on the developer's machine before it is pushed, and the gate refuses a push without that review. GitHub's
reviewers (Copilot, Claude Review) are then a backstop that finds little.
Why: [ADR 0008](../docs/adr/0008-review-before-the-push.md). The process a developer follows is in `docs/PROCESS.md`; the skill that does it is
`.claude/skills/pre-push-review/SKILL.md`.

## What it is

| Piece | Where | Owned or Seed |
| --- | --- | --- |
| The skill: severities, steps, the ledger commands | `.claude/skills/pre-push-review/SKILL.md` | Owned |
| The reviewers' bar (Claude Review's own prompt, adapted and widened) and the generic lenses | `.claude/skills/pre-push-review/review-bar.md`, `lenses.md` | Owned |
| The repeat-until-quiet loop for a large or risky branch, with its mutation runner and known-open list | `.claude/skills/hardening-review/` (`SKILL.md`, `references/`, `scripts/mutate.py`, `scripts/known_open.py`) | Owned |
| The read-only reviewer agent (Read, Grep and Glob only) | `.claude/agents/pre-push-reviewer.md` | Owned |
| The ledger: what the review found and what became of it, keyed by the branch's own hunks | `.sandcastle/lib/review-ledger.mts` (run as `scripts/review.sh`) | Owned |
| The security record: a local, git-ignored file per security finding, written by `record` and read by both reviews | `.security/` in the main checkout (`.sandcastle/lib/security-record.mts`) | Owned code; Owned `.security/README.md`; Owned `.gitignore` lines |
| The gate's check | `scripts/gate.sh`, step "Local review" | Owned |
| The repo's name for `GH_REPO` (`scripts/review.sh repo`) and its own non-Template files under Owned patterns | `REPO_SLUG`, `NOT_OWNED_BASELINE_PATHS` in `.sandcastle/lib/repo-config.mts` | Seed |
| The repo's own lenses, and the guidance reviewers read | `.claude/skills/code-review/SKILL.md`, `CLAUDE.md`, `docs/CODING_STANDARDS.md`, `.claude/rules/` | the repo's |

The ledger lives in the Sandcastle folder because it is TypeScript run with the repo's `tsx`, type-checked and tested with Sandcastle's code.
Apply adds the review to a repo only when it adds Sandcastle (`.sandcastle/` or no commits yet); `scripts/gate.sh` skips the check, with a warning,
where `.sandcastle/lib/review-ledger.mts` is missing.

## How it works

- `/pre-push-review` reviews the branch's whole diff against `origin/main` with parallel reviewers (the bar, plus one per matching lens),
  grades each finding **Critical** (a bug in code that runs, or behaviour with no test), **Warning** (a security weakness, whatever the file) or
  **Advisory** (docs, comments, conventions), fixes all three kinds in the review (Critical and Warning ones behind a regression test, Advisory ones with a gate check when one can pin it),
  reviews the fixes again until a round fixes nothing, and records the result.
- Critical and Warning findings left open (because they need a person, or the last, review-only round raised them) block the push until the person fixes them or accepts
  them with `scripts/review.sh accept` (never on their behalf).
  Advisory findings never block: one that needs a person goes to one follow-up issue per branch.
- The ledger is keyed by the branch's hunks against its merge base with `origin/main`. A clean merge of `main` keeps the review; a new commit, a conflict
  resolution or a `main` change inside one of the branch's hunks needs a new one. A re-Apply on `chore/reapply-baseline` passes without one only when every
  change is a regular Owned file added or modified, as Apply writes them (`OWNED_PATHS` in the ledger lists them, and a dotfiles test keeps it equal to
  `template/owned/`). A deleted Owned file, a symlink, a submodule, a file of the repo's own, a Seed file the re-Apply writes because the repo lacked it, or one of
  the Owned files that carry behaviour (`REVIEWED_ON_REAPPLY`: `.github/ci/coverage-threshold`, which ci.yml enforces at any value,
  `.claude/rules/sandcastle-hand-off.md`, which loads into every session, the three `.github/ISSUE_TEMPLATE/` files, whose front matter sets labels and assignees,
  `.claude/agents/pre-push-reviewer.md`, whose `tools:` front matter keeps reviewers read-only, `.sandcastle/critique-prompt.md` and `intake-prompt.md`, which instruct the
  pipeline's judging roles, and `global.json`, which sets the SDK and msbuild-sdks a build runs)
  needs a review like any other change: the exemption judges a path, and a repo has no Template copy to compare. The gate's message names those files. A re-Apply
  that writes one (a repo whose `coverage-threshold` isn't already `80`, or that lacks the file, gets it from its first one) is refused at `reapply.sh`'s first
  push, which leaves the Apply commit on `chore/reapply-baseline` unpushed. Review it in that worktree with `/pre-push-review`, then run `reapply.sh` again: step 1
  carries the never-pushed branch on. A finding in a Template file goes to the Template in a dotfiles PR, not to an edit in the repo.
- `GATE_SKIP_REVIEW=1` skips the check for gate runs while iterating, never for a push: the pre-push hook runs the gate without it. Sandcastle's sandboxes set it (`SANDBOX_ENV` in `lib/skills.mts`):
  the host runs the review's rounds on a built branch itself, after checkpoint 2 ([below](#sandcastle-runs-the-review-on-the-host)), so the sandbox's gate need not.
- Reviewers run as `pre-push-reviewer`, on Sonnet at high effort, because they read text people without write access wrote. They have no shell, network or GitHub
  token, only Read, Grep and Glob. Those still reach any file the person can read, so a reviewer's answer is data to check before anything of it is published.

## Hardening review

`/hardening-review` is `pre-push-review` with a different middle, for a branch that one review and a round of fixes won't settle. It keeps
the first three steps (get ready, gate, earlier decisions; its run folder replaces the `mktemp -d` one) and the last two (record, report), the severities, the read-only reviewer
and the rules, and replaces the rounds with full passes: every applicable lens over the whole diff each time, `fixes.patch` as a hint to read first. Between a
pass and the person it grades the findings, runs each runnable Critical finding's example input (reviewers send data, never a command, and the harness runs in a
throwaway checkout with a scrubbed environment), holds back findings the known-open list settles (only inside an unchanged range, and listed to the person, never silently),
and puts the rest to the person in numbered batches with a recommendation and an edge-case matrix. Each batch of fixes is committed, then
`.claude/skills/hardening-review/scripts/mutate.py` applies hand-written mutations to it and the tests must catch each. It stops when a pass commits no fix
(after five that did, one more pass only reviews), and records once, at the end. Fixes are made in the session, never by subagents.

Its files live in two folders found again from the branch name after a compaction: `.git/hardening-review/<branch, / as ~>/` for what reviewers read
(`brief.md`, `state.md`, `decisions.md`, the patches) and `.git/review/hardening/<branch, / as ~>/` for what can describe a weakness (the known-open list
with its reasons, harness output, mutation specs). The second is under `.git/review/`, so the sandbox mount below covers it, and so does the deny rule
`Read(//**/.git/review/**)` in a repo that has added it (Adapting, step 2).
The tests of the two scripts are in repo-ci-baseline's own `tests/hardening/` (not shipped to other repos), and `test.sh` runs them.

## The security record

`.git/review/*.json` holds findings per diff, and `latest` looks only at the same branch's commits, so a weakness one branch settled was raised
again, and settled differently, on the next (one weakness took six rounds). The security record keeps those decisions across branches and worktrees.

- **What it is.** `.security/` in the main checkout, shaped like `docs/adr/`: one file per weakness, `0001-<slug>.md`, numbered after the highest entry in four digits.
  An entry states the weakness, the policy that resolves it, the test or gate check that pins it, its status (`fixed`, `accepted` or `open`), the lens and
  path, and the branch and PR it came from.
- **Who writes it.** `scripts/review.sh record` writes an entry for every security finding it records `fixed` or `open` (every Warning, and any finding marked
  `security: true`; see `isSecurity`), under the ledger's lock, after the ledger is written. A problem writing entries is a warning on stderr (`.security: ...`),
  never a failed record. The finding may carry a `policy` (one sentence, the rule that now holds) and `repeats` (the number of the entry it repeats), and the review a `pr`;
  none is stored in the ledger. `scripts/review.sh accept` turns the matching entry `accepted`. A person may edit an entry; an entry whose status can't be
  read counts as `unknown` and suppresses nothing.
- **No second file.** A finding for a weakness an entry holds writes none: the entry it names in `repeats`, else the one with the same fingerprint (a hash of the
  path and the summary, case and spacing set aside). An `open` entry recorded `fixed` later is updated in place. The match is exact on purpose: a wrongly merged
  entry would hide a real weakness, while a reworded repeat only gets a second file.
- **Where.** The main worktree's `.security/`, found with `git worktree list`, so a review in any worktree or branch reads and writes the same entries. A bare clone has none:
  nothing is written, with a warning. The directory is mode 0700, entries 0600, written with `wx`; a symlink there is refused.
- **Git-ignored, never published.** The Owned `.gitignore` carries `.security/*` and `!.security/README.md`, and `record` writes nothing, with a warning to
  re-Apply, where `git check-ignore` says the directory isn't ignored. The README is Owned, so a re-Apply restores it, and it leaves every entry alone. (The
  ignore lines are in the Owned `.gitignore` too, so they reach every repo.) The follow-up issue, the PR's Review notes and the
  report never include an entry's text. The worktree check of `record` does not count an untracked `.security/` file as a change.
- **Who reads it.** `scripts/review.sh security` lists the entries (id, status, lens, finding path, file), never their text. Step 3 of `pre-push-review` and of
  `hardening-review` read that list, and it reaches reviewers by id, lens and path only. A finding that repeats a weakness a `fixed` entry holds isn't raised again as new:
  step 5 dismisses it after the session reads the entry itself and finds the policy still in the code and the pinning test still there. `accepted` and `open` entries are read
  like any other and change no behaviour yet; what each tells a reviewer is for a later change.
- **ADRs.** An entry is a local decision about one weakness. A policy that deserves a decision for the repository is promoted to `docs/adr/` by a person.

## What a sandbox can't see

Ledgers hold accepted security findings, which are never published, and so does the hardening review's `.git/review/hardening/`.
Every Sandcastle sandbox gets an empty read-only folder over `.git/review`, at every
path a mount puts `.git` (`protectedGitMounts` in `lib/host-safety.mts`, `withCreateMounts` in `lib/skills.mts`).
The security record is hidden the same way: head-mode sandboxes (planner, critique, intake) mount the main checkout itself, so
`protectedRecordMounts` puts an empty read-only folder over `<checkout>/.security`. Like the other mounts, it needs a run against a real sandbox before merging.

## Adapting

A repo that already has Sandcastle:

1. **First, in a PR of its own on `main`, before the re-Apply that brings the ledger**: add `REPO_SLUG` (`"<owner>/<repo>"`) and `NOT_OWNED_BASELINE_PATHS` to
   `.sandcastle/lib/repo-config.mts`, which Apply never rewrites, each as a one-line `export const NAME` (or `export let`) at the start of a line. List
   in `NOT_OWNED_BASELINE_PATHS` each file (not a folder) under an Owned pattern (see
   `OWNED_PATHS` in `lib/review-ledger.mts`) that is the repo's own, such as a workflow of its own and Sandcastle tests the Template lacks.
   Until this is on `main`, Apply holds back the four files that import it (`scripts/review.sh`, `lib/review-ledger.mts`, and the tests
   `review-ledger.test.mts` and `pre-push-review-skill.test.mts`) and lists them in
   its report, so the re-Apply passes the gate without a review step; Apply again after this PR merges to bring them. `scripts/review.sh` also stops with a
   message naming the missing export. Adding the names on `chore/reapply-baseline` instead puts a file that isn't Owned in the re-Apply, which then needs
   a full review. The old gate has no review step, so the PR on `main` needs none.
2. Deny Claude Code reading the ledgers and credential files, in the repo's `.claude/settings.json` (the Template doesn't ship that file, since permissions are set per user):

   ```json
   { "permissions": { "deny": ["Read(//**/.git/review)", "Read(//**/.git/review/**)", "Read(//**/.env)", "Read(//**/.env.local)", "Read(//**/.env.*.local)", "Read(//**/.env.production)", "Read(//**/.env.prod)", "Read(//**/.env.staging)", "Read(//**/.env.development)", "Read(//**/.env.dev)", "Read(//**/.env.test)", "Read(//**/.env.docker)", "Read(//**/secrets/**)", "Read(//**/*.pem)", "Read(//**/*.key)", "Read(//**/*.pfx)", "Read(//**/*.p12)", "Read(//**/.git/config)", "Read(~/.ssh/**)", "Read(~/.config/gh/**)", "Read(~/.git-credentials)", "Read(~/.netrc)", "Read(~/.aws/**)", "Read(~/.azure/**)", "Read(~/.microsoft/usersecrets/**)", "Read(~/.claude/.credentials.json)"] } }
   ```

   The reviewers' Read and Grep follow these rules, and the agent's `tools:` line can't narrow them to paths, so this is what keeps a reviewer off the
   usual credential files, not every secret a machine can hold. The rules apply to the whole session. The `.env` rules name the files that hold secrets, so `.env.example` stays readable
   (a deny rule beats any allow rule, so a `.env.*` rule would lock the templates too). The list is a floor: add a rule for each other `.env.<name>` file your repo keeps secrets in.

3. Run `pnpm install` (the ledger needs `zod` and `tsx`, both in the Seed `package.json`; a repo whose own `package.json` lacks `tsx` gets it when it migrates
   to the Sandcastle section), then `pnpm run check:sandcastle`. Add `scripts/review.sh`, `.claude/skills/pre-push-review`,
   `.claude/agents/pre-push-reviewer.md` and `.github/workflows/claude-review.yml` to the pathspec in the repo's Sandcastle check (the Seed `.sandcastle/check.sh` has them), since its tests read them.
4. The repo's own guidance for reviewers is optional: a `.claude/skills/code-review/SKILL.md` with a **Lenses** table of the same shape as `lenses.md` adds lenses
   and `CLAUDE.md`, `.sandcastle/CODING_STANDARDS.md` (or `docs/CODING_STANDARDS.md`) and `.claude/rules/` are read when they exist. A lesson from a GitHub review goes into the
   repo's `code-review` skill, not into the Owned `lenses.md` or `review-bar.md` (the next Apply reverts those): to change them, change the Template first.
5. If the repo's CLAUDE.md or CONTRIBUTING repeats the thread-reply rules, replace them with a link to `docs/PROCESS.md`.

## Sandcastle runs the review on the host

A branch Sandcastle builds gets this review's rounds after the reviewer role and a passing checkpoint 2 (`lib/host-review.mts`, `lib/host-review-prompts.mts`):

- The host starts the same reviewers `/pre-push-review` does: the Bar and one per lens whose "Applies to" matches a changed file, read from the main checkout's
  `lenses.md`, `review-bar.md`, `SKILL.md` and `pre-push-reviewer.md` (never the worktree's, which the branch controls), plus a repo's own lenses. `LENS_APPLIES` holds a path rule per
  lens, and `host-review.test.mts` fails when `lenses.md` gains, loses or rewords a lens, or the model, effort, tools or round limit differ.
- Reviewers run in the build's sandbox as `claude --print --tools Read,Grep,Glob`, with `--strict-mcp-config` and deny rules for `.git/review`. Their prompts name no shell, token or `scripts/review.sh`.
- The host triages the findings in code (merging duplicates, grading security) and has the backend role fix each fixable one behind a failing test. It records a finding `fixed`
  only with a test whose file the round changed (a reason alone is enough only for a non-security finding), `dismissed` only with a `file:line` reason, and everything else `open`.
- A round that fixed something is followed by checkpoint 3 (the gate) and a round reviewing `fixes.patch`. After 3 such rounds one more round only reviews.
- Only the host records, in the main checkout, with `prepareRound` and `recordReview` called in-process: it never runs the worktree's `scripts/review.sh`.
- A usage or time stop leaves the branch for a later round. A reviewer that fails, or a record the ledger refuses, publishes the branch with a PR note and no record.
  Open non-security findings go in the PR as a note; a security finding is only counted.
- Not in v1: the `.security/` entries and PR threads aren't given to the reviewers; the follow-up Advisory issue isn't filed. It needs a run against a real sandbox before merging, since the tests
  stub Docker and see `--tools`, `--strict-mcp-config` and `--disallowedTools` only as text.

## Not in it yet

- **Claude Review reviewing only what a push changed.** Claude Review now opens findings only for what a local review can't check and reads the PR's
  `## Review notes` as accepted findings ([ADR 0004](../docs/adr/0004-claude-review-as-copilots-backup.md#claude-review-after-the-local-review)),
  but it still reads the PR's whole diff on every push. A delta needs the diff step's exclusion and holding rules applied to a second diff.
