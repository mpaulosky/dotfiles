# Standardize by copying an Owned/Seed Template instead of porting changes

**Status:** accepted and implemented: `template/`, `apply.sh` and `test.sh`, with `SKILL.md` describing Standardize.

Repos used to adopt the Baseline by porting each part's *change* from IssueTracker (the reference implementation), one part per PR, because a copied file silently undoes a repo's local fixes.
That kept every repo slightly different and made each port a survey-and-diff project.
We now copy a Template instead: Owned files are always overwritten, Seed files are written only when missing, and the repo's own work happens afterwards in Adapt.

## Consequences

- The Template is the single source of truth, so the "copy undoes local fixes" risk is handled by rule instead of by avoiding copies.
  A fix found in a repo goes into the Template first, and `apply.sh` reports every Owned file it overwrites, so no fix is lost unseen.
- Owned files must stay free of per-repo values.
  Per-repo behavior goes through Seed extension points (for example `.github/ci/prepare.sh`), and `test.sh` fails on any `{{` placeholder under `owned/`.
- `global.json` is Owned, so SDK bumps land in the Template first; a Dependabot bump in one repo is reverted by the next Apply.
- One Standardize is one PR per repo (an Apply commit, then Adapt commits), not one PR per part.
