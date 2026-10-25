# Every branch is reviewed on the developer's machine before it is pushed

**Status:** accepted. Implemented in `template/owned/.claude/`, `template/owned/.sandcastle/lib/review-ledger.mts`, `template/owned/scripts/gate.sh`
and `template/owned/docs/PROCESS.md` ([pre-push-review.md](../../references/pre-push-review.md)). The design and its first run are
mpaulosky/auth0-management-app#82, #89 and #94.

## Context

Most of the review threads GitHub's reviewers opened on the Baseline repos' PRs were about behaviour a review before the push could have caught:
auth0-management-app had 166 threads in three days, 160 of them from Claude Review. Each thread costs a push, a re-review and a hold on PR Auto-Merge.
That repo moved the heavy review onto the developer's machine, before the push, and its GitHub reviews found far less.

## Decisions

- **The review runs before the push, and the gate enforces it.** `/pre-push-review` reviews the whole diff against `origin/main`; `scripts/gate.sh` refuses a
  diff without a clean record. The record (a ledger under `.git/review/`, keyed by the branch's hunks) is a process aid, not a security boundary against the person.
- **Findings are graded Critical, Warning or Advisory.** Only bugs in code that runs, behaviour with no test, and security weaknesses block. Docs, comments and
  conventions are fixed in the review or go to one follow-up issue, so a stale comment never blocks a push as hard as a bug.
- **Only the person accepts a finding**, with `scripts/review.sh accept`. An acceptance never carries to a later review of different code.
- **Reviewers are read-only and run at high effort.** The `pre-push-reviewer` agent has Read, Grep and Glob only, because the diff, issue and threads it reads
  were written by people who may not have write access.
- **It is Owned.** The skill, agent, ledger and gate step carry no per-repo values; the repo's name (`REPO_SLUG`) and its own files under Owned patterns
  (`NOT_OWNED_BASELINE_PATHS`) are Seed values in `lib/repo-config.mts`. The ledger lives in `.sandcastle/lib/`, so Apply adds the review where it adds Sandcastle.
- **Sandcastle's builds skip the check for now** (`GATE_SKIP_REVIEW=1` in every sandbox) and keep their own reviewer role. Its sandboxes see an empty folder over
  `.git/review`, since ledgers hold accepted security findings that are never published.
- **`.claude/settings.json` stays out of the Template.** The deny rule for `.git/review` is an adapting step instead.
- **Claude Review still reviews every push, unchanged**, until its own change lands (it reviews only what the push changed, and opens threads only for what
  a local review can't check). That is a separate PR because it changes `claude-review.yml`.
