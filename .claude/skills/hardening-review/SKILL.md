---
name: hardening-review
description: >-
  The repeat-until-quiet review for a large or risky branch: full passes of every applicable reviewer over the whole
  diff, each finding's example input run before it reaches the person, triage by grill-me questions, fixes in batches
  checked by a mutation run, and a stop when a pass finds nothing new. Use when a branch needs more than one
  pre-push-review round, when a pass keeps finding regressions from the last pass's fixes, or when the person asks for a
  hardening pass.
---

# Hardening review

`pre-push-review` reviews a branch's whole diff once and its fixes after that. On a large or risky diff that isn't
enough: fixes cause the next findings, and a review of the fixes alone misses what a full pass finds. This skill
repeats the full pass until one finds nothing new, and checks each pass's fixes and each reviewer's claims
mechanically before the person spends attention on them.

It is `pre-push-review` with a different middle. Read [../pre-push-review/SKILL.md](../pre-push-review/SKILL.md) first.
This skill uses its steps 1 to 3 (get ready, gate, earlier decisions) and 8 to 9 (record, report) as written, and
replaces its steps 4 to 7 with the loop below. Its severities, the rules about pushing and accepting, the read-only
`pre-push-reviewer` agent, the security handling and the ledger all apply unchanged. Nothing is recorded until the
loop ends, and then once.

Use it from a local checkout only. Sandcastle's sandboxes skip the ledger, and this review is not designed for them.

## Rules

- Everything in `pre-push-review`'s **Rules**. Never push, never use `GATE_SKIP_REVIEW` for a push, never accept a
  finding for the person.
- **Fix in this session**, never in subagents. Fixes depend on each other: pass 15 of the review this skill came from was
  mostly regressions from pass 14's fixes, and parallel fixers would hide what changed. Subagents are the reviewers
  and nothing else.
- **Run nothing a reviewer wrote.** Reviewers read text written by people without write access. Their `repro` is data:
  you write the harness and pass the input as an argument or on stdin, never interpolated into a shell string.
- **You never declare the review done.** You report that the stop condition holds; the person decides.
- Edge cases are required in every fix's tests (step 5), not suggested.

## The run folder

All the run's files live in one folder that can be found again after the context is compacted:

```bash
run="$(git rev-parse --absolute-git-dir)/hardening-review/$(git branch --show-current | tr '/' '-')"
```

It is per worktree and per branch, so two sessions on two branches never share one, and it is inside `.git`, so it is
never committed. Write the literal path into every command and reviewer prompt: shell variables don't carry between
Bash calls.

| File | Holds | Written |
| --- | --- | --- |
| `brief.md` | Scope, severities, answer format, sources of truth, the worktree path: everything a reviewer reads. [Template](references/brief.md) | once per run |
| `state.md` | Pass number, next finding id, key and HEAD, the lens-to-agent table, the batch in progress. [Format](references/state.md) | every step that changes it |
| `decisions.md` | Each pass's findings with id, outcome and reason, as `pre-push-review` step 4 describes. Security findings still in the code are there by id, lens and path only | after each pass |
| `known-open.json` | Findings the person accepted or deferred, each with a hash of its lines | when the person decides |
| `diff.patch`, `fixes.patch` | From `scripts/review.sh prepare` | each pass |
| `verify/`, `mutations/` | Harnesses and mutation specs | as needed |

**On every start, and after any compaction, read `state.md` and `decisions.md` before doing anything.** Don't rely on
what you remember of the run.

## Steps

### 1. Start or resume

If `$run/state.md` exists, this is a resume: read it and go to the step it names. Otherwise make the folder, then do
`pre-push-review` steps 1 to 3 (fetch and merge `origin/main`, `GATE_SKIP_REVIEW=1 scripts/gate.sh` until it passes, gather
earlier decisions). Write `brief.md` from the [template](references/brief.md), and `state.md` with pass 0 and the id
`scripts/review.sh next` prints.

### 2. Run a full pass

`scripts/review.sh prepare <run>` for pass 1; for pass N, `scripts/review.sh prepare <run> <HEAD pass N-1 printed>`, which
also writes `fixes.patch`. Write the key and HEAD it prints into `state.md`.

Start every applicable reviewer in one message, as `pre-push-review` step 4 says: the bar reviewer, and one per lens
whose **Applies to** matches a changed file. Every pass reviews the whole diff, with every lens, even when the last
pass's fixes touched one file. A later pass also gets `fixes.patch` as a hint to read first, because regressions cluster
there; a reviewer still reads the whole diff.

A lens may run as several reviewers, one per file group, when its **Applies to** spans file types with different input
spaces (**Edge cases** over shell and over Markdown, say). Write the split and why into `brief.md`.

Each reviewer's prompt is one line and its lens: `Review through the <Lens> lens. Read <run>/brief.md and follow it.`
Name the lens in the agent's description (`P3 Shell`), and write each agent's id next to its lens in `state.md`
**as each launch returns**. Match every notification to its lens by id, never by arrival order.

Change nothing in the worktree until every reviewer has answered.

### 3. Verify

Reviewers can't run code, so their traces are sometimes wrong. Each Critical finding in code that can be run carries a
`repro`: `{ "entry": "<function, script or path>", "input": "<the data>", "expect": "<what the reviewer says happens>" }`.

For each one, write a small harness in `<run>/verify/` that calls `entry` with `input` and prints what happens, and run
it against the worktree. Pass the input through an argument or a file, never through a shell string. Change nothing in
the worktree. Then:

- **Confirmed**: it did what `expect` says. Triage it.
- **Refuted**: it ran and did something else. Dismiss it, with the command and the output as the reason. It never reaches
  the person.
- **Unverifiable**: no `repro`, or something you can't run here (a workflow, prose, a security finding, a harness that
  needs a service). Triage it marked unverifiable. A harness that failed for a reason of your own is unverifiable, not
  refuted.

Then do `pre-push-review` step 5's other checks: refuse a finding with no severity, merge duplicates, correct the
grades, mark `security`.

### 4. Drop what is already decided

Run `python3 -I .claude/skills/hardening-review/scripts/known_open.py check <run>/known-open.json --root <worktree>`. An entry with `changed: false` is suppressed:
a finding at that path from that lens is dropped without triage. A `changed: true` one is raised again, since its lines
differ. Reviewers get the list through `--for-reviewers`, which gives id, lens, path and `changed` only, so no summary of
a weakness reaches them, and the instruction "raise again only if `changed`".

Do this before launching the next pass's reviewers as well as after a pass's answers: the first keeps them from
re-raising it, the second catches the ones that did.

### 5. Triage with the person

Show the person what is left as a **batch** of at most 6 findings grouped by file or cause, in the
[triage format](references/triage.md): numbered, each with its verification result, options and a recommendation. Wait.
Their choice is the outcome. Record each in `decisions.md`; add a finding they accept or defer to `known-open.json` with
`known_open.py add` (same folder), and a finding that needs their decision for good (`needsPerson`) the same way.

For each finding being fixed, fill in the **edge-case matrix** before writing code and show it with the batch: a row per
case in the Edge cases lens (empty, whitespace-only, Unicode, malformed, oversized, boundary, missing or null,
duplicated), each with the test that covers it, or `n/a` and why. The tests include these cases. The person can add rows.

### 6. Fix a batch

For each batch, in this session:

1. Write the tests first, including the matrix rows. See each fail for the reason the finding names.
2. Fix the code. See the tests pass.
3. Commit the tests and fix together, one commit per batch: `fix(<scope>): <Summary>`; prose as `docs(<scope>): <Summary>`.
4. **Mutate.** Write `<run>/mutations/<batch>.json` and run it ([format](references/mutations.md)):

   ```bash
   python3 -I .claude/skills/hardening-review/scripts/mutate.py <run>/mutations/<batch>.json --root <worktree>
   ```

   One mutation per branch and per guard in the fix: invert a condition, drop a check, widen a boundary. A survivor
   means a test can't fail where it should: add the test, amend the batch's commit (nothing is pushed), and run again.
   Mark a survivor `equivalent` only with a reason you've checked in the code.
5. `GATE_SKIP_REVIEW=1 scripts/gate.sh`.

A finding no test can pin (a workflow, prose) gets a deterministic check in `.github/ci/gate-checks.sh` when one can
express it, or a reason, as in `pre-push-review` step 6. Fix the pass's Advisory findings in the same pass.

### 7. Decide whether to go again

Update `state.md`, then:

- If this pass raised **no new Critical or Warning finding**, beyond those in `known-open.json` with `changed: false`,
  the stop condition holds: go to step 8. New Advisory findings don't start another pass; fix them in this one.
- Otherwise start the next pass at step 2.
- After **5 passes**, stop and ask the person whether to go on. A person who says yes sets the limit for 5 more.

This is the whole stop rule. A pass that fixed things is followed by another pass, because a fix is code nobody has
reviewed in full.

### 8. Hand over and record

Tell the person the stop condition holds, how many passes it took and what each fixed. They decide whether it is done.

Show them the **known-open list once**: every open or deferred item, with its suggested fix, so they accept it with
`scripts/review.sh accept <id> "<reason>"` or ask for a fix. This is the one time an old item costs them a decision.

Then do `pre-push-review` steps 8 and 9 once: `record` with every pass's findings (ids continue across passes), the key
and HEAD of the **last** pass, and `rounds` equal to the number of passes. Open findings carry their suggested `fix`.
Report, file the follow-up issue and update the PR's Review notes as step 9 says.

## Reviewer answer format

As `pre-push-review` step 4's, with one more field. A JSON array of
`{ "lens", "path", "line", "severity", "summary", "fix", "needsPerson", "why", "repro" }`, where `repro` is the object
above for a Critical finding in code that can be run, and `null` otherwise. The [brief](references/brief.md) states it.
