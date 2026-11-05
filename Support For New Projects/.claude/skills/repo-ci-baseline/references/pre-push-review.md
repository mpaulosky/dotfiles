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
  reviews the fixes again until a round fixes nothing, and records the result. The fixer checks its own fix before it commits (boundary tests, a mutation check, the edge-case
  checklist), and replaces a function that two rounds in a row fixed instead of patching it again. A branch past 30 files or 3,000 lines (a file and its Template mirror
  counting once) gets a warning in round 1 to consider splitting it; the review goes on.
- The reviewers read less than the key covers. `prepare` leaves out of `diff.patch` and `fixes.patch` a Template mirror that is a verbatim copy of a root file in the same
  patch (the same after-blob and mode, or both deleted; a path git writes two sections for, such as a symlink that
  becomes a file, must match section for section); a mirror that differs from its root copy, has no root section, or has a quoted or unreadable header stays. The key
  printed is that of the whole diff, so a change in a mirror alone still needs a new review. One agent per lens is already how the round starts; splitting round 1 by file group is not done.
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
  pipeline's judging roles, `.sandcastle/check.sh`, whose watched paths decide whether the Sandcastle check runs,
  and `global.json`, which sets the SDK and msbuild-sdks a build runs)
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
   This is a hard prerequisite: a repo with a `.sandcastle/lib/repo-config.mts` that lacks either name makes Apply stop before it writes anything, since Sandcastle's
   `build.mts` and `host-review.mts` import the ledger and would not load. Merge this PR, then Apply. `scripts/review.sh` also stops with a
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
   to the Sandcastle section), then `pnpm run check:sandcastle`. The Owned `.sandcastle/check.sh` already watches `scripts/review.sh`, `.claude/skills/pre-push-review`,
   `.claude/agents/pre-push-reviewer.md` and `.github/workflows/claude-review.yml`, since its tests read them. A repo with a sandbox gate script of its own adds them to that script's
   pathspec, and any other file its tests read goes in the Seed `.sandcastle/check-paths.txt`.
4. The repo's own guidance for reviewers is optional: a `.claude/skills/code-review/SKILL.md` with a **Lenses** table of the same shape as `lenses.md` adds lenses
   and `CLAUDE.md`, `.sandcastle/CODING_STANDARDS.md` (or `docs/CODING_STANDARDS.md`) and `.claude/rules/` are read when they exist. A lesson from a GitHub review goes into the
   repo's `code-review` skill, not into the Owned `lenses.md` or `review-bar.md` (the next Apply reverts those): to change them, change the Template first.
5. If the repo's CLAUDE.md or CONTRIBUTING repeats the thread-reply rules, replace them with a link to `docs/PROCESS.md`.

## Sandcastle runs the review on the host

A branch Sandcastle builds gets this review's rounds after the reviewer role and a passing checkpoint 2 (`lib/host-review.mts`, `lib/host-review-prompts.mts`):

- The host starts the same reviewers `/pre-push-review` does: the Bar and one per lens whose "Applies to" matches a changed file, read from the main checkout's
  `lenses.md`, `review-bar.md`, `SKILL.md` and `pre-push-reviewer.md` (never the worktree's, which the branch controls), plus a repo's own lenses. One difference from the local
  review: the host gives the Security lens to Markdown under `.claude/` and `.sandcastle/` too, which steers agents that hold a shell and a token, where the skill gives a Markdown-only
  diff just the Docs and Repo conventions lenses. `LENS_APPLIES` holds a path rule per
  lens, and `host-review.test.mts` fails when `lenses.md` gains, loses or rewords a lens, or the model, effort, tools or round limit differ.
- The host does the same as `prepare`: it writes `readPatch` and `readFixes` (the patches without verbatim mirrors), applies the size limit, the lens choice and the PR note's
  read paths to them, and tells every reviewer the mirrors are left out when a read patch is shorter than its whole patch; the key it records is that of the whole diff.
- Round 1 logs the branch-size warning once (`sizeWarning`, the text `prepare` writes to stderr): past 30 files or 3,000 lines, a file and its
  Template mirror counting once. It advises and never stops the review.
- A repo's own `code-review` skill reaches the host reviewers only as lens rows, read from the main checkout. They read `CLAUDE.md`, `CONTEXT.md`,
  `CODING_STANDARDS`, the ADRs and `.claude/rules/` from the worktree, and the prompt says that is the branch's own text, applied as conventions but
  never overriding the bar, a lens's row or the severities.
- Reviewers run in the build's sandbox as `claude --print --tools Read,Grep,Glob`,
  with `--strict-mcp-config`, `--setting-sources user` (the branch's `.claude/settings.json` hooks never run) and
  deny rules for `.git/review`. Their prompts name no shell, token or `scripts/review.sh`.
- The host triages the findings in code (merging duplicates, grading security:
  a finding counts as non-security only when its reviewer set `security: false`) and has the backend role
  fix each fixable one behind a failing test. It records a finding `fixed`
  only with a test whose file the round changed and that is a test file (a code file in a test folder or named like a test; never a docs or data file)
  (a reason alone is enough only for a non-security finding) and,
  for a Warning or a security finding, only when the file at its `path` changed too (the next round reads only the fixes, so the reviewers
  are also told to read the code at each `fixed` item's `path:line` and raise it again if the problem is still there), `dismissed` only with a `file:line` reason
  (never for a Warning or a security finding, which stays open), and everything else `open`.
- Round 1 removes any stale `fixes.patch` from the run folder. The PR body keeps the marker, `Closes #n` and the notes whole, lists at most 100 check files
  ("and M more" after that), and cuts the description to fit.
- A round that fixed something is followed by checkpoint 3 (the gate) and a round reviewing `fixes.patch`. After 3 such rounds one more round only reviews.
- Only the host records, in the main checkout, with `prepareRound` and `recordReview` called in-process: it never runs the worktree's `scripts/review.sh`.
- A usage-limit stop, or a stalled sandbox (a reviewer or fixer run the host gave up on `ROLE_RUN_GRACE_MINUTES` after its `timeoutMinutes`), leaves the branch for a later round: nothing is
  published and no failed attempt is spent; a usage-limit stop ends the run cleanly,
  and a stalled sandbox ends it red. The run's time budget passing (`TimeBudgetStopError`), or the review's own cap of `REVIEW_WALL_CLOCK_MINUTES` (checked before each
  round, reviewer and fixer run), ends the review as failed at the last commit the gate passed on, so work already gated is published, as a draft, with a note.
  The first reviewer that fails ends the round (no later reviewer of it runs). That, a record that can't be made, a round's diff past `MAX_REVIEW_PATCH_BYTES`,
  or a checkpoint 3 that stays red after a round's fixes
  publishes the branch, at the last commit the gate passed on, as a draft with a PR note and no record (see the draft bullet below). A fixer that moves HEAD without
  changing a file ends the review at the round as it was read. A finding's lens is the reviewer's the host ran, never the one its answer names.
  Open non-security findings go in the PR as a note of at most 20 findings, each by id, severity and place only: a reviewer's own summary and fix stay in the local record.
  A finding is listed only when its path is a file the review's diffs touched and is made of plain file-name characters (never a link, an image or a `www.` address), and a line the host's
  public-text check would change, or that reads like a `## Review notes` section, is left out on its own. The rest, and any security finding, are only counted.
- Open Critical or Warning findings (and any open security finding, whatever its grade) hold the PR as a draft, and so does a review that didn't finish, since it hasn't cleared the code (its
  note says so): the host opens it with `gh pr create --draft`, and its body says why and what a person does: the ledger stays on the runner (it can hold security details), so a person
  first runs `/pre-push-review` on the checked-out branch to record one. Only a person accepts a finding, with `scripts/review.sh accept`, and marks the
  PR ready with `gh pr ready`; the host never does either. A PR with none open is opened ready. A PR that already exists for the branch (a rerun) is turned into a draft with `gh pr ready
  --undo` before the new commits are pushed (retried after a GitHub server error; if it still fails nothing is pushed and the issue gets a comment saying so) and then given the new body, but
  only while its body still carries the host's `sandcastle:pr` marker and reads no `## Review notes`; otherwise the body (a person's acceptances, or text written by hand) is kept and the
  draft note added to it, unless that would pass GitHub's 65,536-character limit: then the body is left as it is and the PR is a draft with no note. A body edited by hand with the marker
  left in is rewritten. A rerun that no longer holds a PR that is a draft leaves it a draft, as marking it ready is a person's, but takes the draft note out of its body (the host's own body
  is replaced; a person's body loses only the note). That edit is best effort: if reading or editing the body fails the host logs the reason and still publishes, and the note stays until a
  person removes it. A held PR is a draft, so Sandcastle's follow-up sweep and `sandcastle:status` skip it until a person marks it ready: a failing check or
  review feedback on it needs a person.
- The PR's `## Review notes` hold only a person's acceptances, as in a local review: the host writes no such section, and an agent-written PR body that carries the words is replaced by the
  generic one.
- The review's open Advisory findings go in one follow-up issue titled `chore(review): Advisory review findings: <branch>`, whose body is `renderAdvisories`' list (a security finding is left out,
  the issue being public). The host differs from the skill's step 9: it files the issue only after the secret scan passes and the branch is published, shows no person the text first, and doesn't
  leave out a re-raised finding. It lists a finding only when its path is a file the review read and is plain file-name characters, and its line (summary and fix too) holds nothing GitHub renders
  as a link or an image (a scheme, `www.`, `mailto:`, `](`, `![`) and reads like neither a secret under the host's public-text check nor a `## Review notes` section (at most 20 findings, 2000
  characters a line; the rest are counted). That check sees each finding's own line, so a branch named for review notes loses none; the whole body is checked once for the branch, and a refusal is
  logged. It reuses only an open issue of its own (`--author` with the host's login) with that exact title. It does not match finding by finding as step 9 does: it comments the whole current list
  unless the body or one of the host's own comments already holds exactly that text (anyone can comment on a public issue, so another author's comment never counts), so findings the issue already
  lists can appear again beside a new one; a body a person edited is never replaced. A later review with no Advisory findings files nothing, so the earlier issue keeps findings that may be fixed
  by now: a person closes it. It files none for a review that didn't finish. A failed filing is retried after a GitHub server error; if it still fails, the failure is logged and the same
  checked list is posted as a comment on the Sandcastle issue, so it isn't lost with the runner, and the PR still publishes. A push or PR create that fails after the PR was held as a draft
  hands back with a comment saying the PR may already be a draft: find it with `gh pr list --head <branch>` rather than open a second one. A finding is also left out when its id, path,
  summary or fix, or the branch, holds text a reader can't see (`hasHiddenText` in `status.mts`, the rule of ADR 0010: `terminalText` would drop or cap something other than whitespace). That
  covers a control, format or default-ignorable character such as a bidirectional mark, a zero-width space, a soft hyphen, a variation selector or a tag character, a blank filler (U+2800,
  Hangul), a next-line character (U+0085, which the issue's own text folding would publish raw), a joiner that does no work (outside emoji or the joining scripts), more than eight joiners or more than
  eight private-use or unassigned characters across the issue's text, and a run of more than eight combining marks. Each field is also checked for secrets as the reviewer wrote it, not only in the
  escaped line the issue shows. When open Advisory findings exist and none can be listed, the build logs that no follow-up issue is filed. The issue lists reviewer prose (summary and fix) on
  purpose: on Actions the local record is discarded with the runner, so the issue is the only copy that survives.
- Not in v1: the branch's earlier recorded review, the `.security/` entries and PR threads aren't given to the reviewers.
- A round's reviewers start one of two ways, chosen by `SANDCASTLE_REVIEWERS` (`lib/config.mts#reviewerMode`): `sequential` or `subagents`. Unset or empty means `sequential`, any other
  value is refused at start-up (exit 2, before any sandbox starts), and the default stays `sequential` until a run in a real sandbox settles the questions below.
  - `sequential`: the reviewers run one after another on one sandbox, at most `MAX_REVIEWERS_PER_ROUND`, since role runs started together race for the sandbox's global git config lock
    (a real run lost four of ten). A round can take hours against the run's 240-minute budget. `BUILDING_LABEL_MAX_AGE_MS` is sized for that and for the cap (12 hours, so a crashed run, an
    Actions run included, holds its issue that long).
  - `subagents`: one role run, `pre-push-review-lead`, starts all the round's reviewers as parallel subagents (one wave: `MAX_REVIEWERS_PER_ROUND` is within Claude Code's 20 concurrent subagents),
    so there is one role start and no lock race. Each lens's full prompt is a file under the run's folder (`lens-<id>.md`), and its subagent, `lens-<id>`, is defined on the lead's command line with
    `--agents` (`tools` Read, Grep and Glob; the quoted word is capped at `MAX_AGENTS_WORD_BYTES`) and told to read that file. The lead holds `Agent`, Read, Grep and Glob: no shell, no network,
    no write tool. Its `Agent` tool is an allowlist of the round's `lens-<id>` agents (`Agent(lens-1,lens-2,…)`, `leadTools`), which `restrictedClaudeCode` refuses to run without,
    and it is also denied every known built-in subagent type (`LEAD_DENIED_TOOLS`) as a second layer, since a deny list alone can't name a type a later release adds or one from the sandbox user's `~/.claude/agents`.
  - The lead returns each subagent's `<findings>` block verbatim (the subagent is told to answer with that block only, so up to 14 relayed answers stay within the lead's output limit)
    between `<review-{nonce}-{id}>` and `</review-{nonce}-{id}>`, with a nonce the host makes fresh for each lead run. The host parses each
    lens's block itself, with the parser the sequential mode uses. A lens with a missing wrapper, an empty one or an invalid block fails, and is asked for again alone (up to `REVIEWER_ATTEMPTS`
    asks per lens, keeping the other lenses' findings; a retry after a cut-off relay is two lead runs,
    so a round uses at most `REVIEWER_ATTEMPTS` + 1 lead runs, and the time cap is checked before each); a lens still failing ends the review as failed, with a host-written reason.
    When the lead's reply was cut off (its last wrapper has no closing tag), the retry asks for the lenses in two halves,
    each in a lead run of its own with its own nonce, since asking for all of them again would be cut off at the same place. Any anomaly in the nonce's tags (a lens nobody asked for, a tag twice, a
    closing tag before its opening tag, nested or overlapping wrappers, an unclosed wrapper) fails every lens of that run, so a subagent steered by a planted file can't write a tag that clears
    another lens. A lead that shortens a block, or empties one, can't be told from the subagent's own answer, because the host sees only the lead's output: that is accepted, and bounded by the lead
    having no write tool and a prompt that forbids adding, shortening or merging.
  - The role's one timeout (`FIXED_ROLE_AGENTS`, 30 minutes: the reviewer's 20 with every lens in one wave, plus relay time) covers all the subagents, and the run's idle timeout is set to it, since a
    lead waiting on its subagents may print nothing for longer than Sandcastle's default 10 minutes.
    Each lead run has this timeout, so a round that is cut off and retried in halves may spend up to three of them. A lead that times out or fails ends the round at once with no retry
    (every lens not yet answered in it is reported as failed or timed out, not as a malformed answer); a usage-limit stop or a
    stalled sandbox is rethrown as for a reviewer. The lead's log is never copied to the public report.
  - What the tests can't settle, and the answer the design takes so that a wrong guess fails loudly instead of recording a clean review: whether the lead's `--tools` narrows its subagents and honours
    `Agent(name,…)` (the lead holds Read, Grep and Glob itself, each subagent's own `tools` list is its ceiling, and the deny list stays beside the allowlist);
    whether `--setting-sources user` blocks the branch's `.claude/agents` (the subagents are named by the host and
    defined on the command line, so they don't depend on it); how one role timeout covers all the subagents (above); and keeping the lead from dropping findings (the wrapper protocol above).
    A CLI that can't start subagents leaves every lens missing, and the review fails.
- A change to how the host runs the reviewers needs a run against a real sandbox before merging, since the tests stub Docker and see `--tools`, `--agents`, `--strict-mcp-config`,
  `--setting-sources` and `--disallowedTools` only as text. For the `subagents` mode that run is `SANDCASTLE_REVIEWERS=subagents SANDCASTLE_ISSUE=<n> pnpm run sandcastle`, before the default flips.

## Not in it yet

- **Claude Review reviewing only what a push changed.** Claude Review now opens findings only for what a local review can't check and reads the PR's
  `## Review notes` as accepted findings ([ADR 0004](../docs/adr/0004-claude-review-as-copilots-backup.md#claude-review-after-the-local-review)),
  but it still reads the PR's whole diff on every push. A delta needs the diff step's exclusion and holding rules applied to a second diff.
