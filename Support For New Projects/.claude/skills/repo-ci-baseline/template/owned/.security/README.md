# The security record

This folder is the review's local record of security findings, shaped like `docs/adr/`. `scripts/review.sh record` writes one
file here for every security finding it records (every Warning, and any finding marked `security: true`), so a later branch
doesn't raise the same weakness again and settle it differently in another worktree.

## What an entry holds

One file per weakness, numbered like the ADRs: `0001-<slug>.md`, the next number after the highest entry, in four digits.

- The weakness, and the lens and path it was found under.
- The policy that resolves it: the rule that now holds.
- The test or gate check that pins the policy.
- Its status: `fixed`, `accepted` or `open`.
- The branch and the pull request it came from (or "none when recorded").

A finding that repeats a weakness an entry already holds writes no second file. An `open` entry the weakness is later
recorded `fixed` for is updated in place.

## What the status means

- `fixed`: the weakness is resolved and a test or gate check pins the policy. A review does not raise a finding that repeats it
  as new. It reads the entry first, and raises the finding again only when the code no longer holds the policy or the pinning
  test or check is gone.
- `accepted`: a person accepted the weakness (`scripts/review.sh accept`). The entry is read like any other and changes no
  behaviour yet.
- `open`: the weakness is waiting for a person. The entry is read like any other and changes no behaviour yet.

## Where it lives, and who reads it

- The entries live in the main checkout's `.security/`, shared by all its worktrees, so a review on any branch reads what another
  decided. `scripts/review.sh security` lists them: id, status, lens, path and file.
- The two reviews (`pre-push-review` and `hardening-review`) read the list by id, lens and path only, never an entry's words.
  The session reads an entry's file itself when a finding looks like a repeat.
- The entries are git-ignored (`.gitignore` has `.security/*` and `!.security/README.md`) and never published: the follow-up
  issue, the pull request's Review notes and the report never quote them. Sandcastle's sandboxes see an empty folder here.
- The review writes the entries. A person may edit them: a hand edit is read back as it stands, and an entry whose
  `- Status:` line can't be read never suppresses anything.
- This README comes from the Baseline's Seed once. A re-Apply leaves it, and every entry, as they are.

## Relation to ADRs

An entry records a decision about one weakness, locally. A policy that deserves a decision for the whole repository is promoted to
an ADR in `docs/adr/` by a person; nothing promotes an entry automatically.
