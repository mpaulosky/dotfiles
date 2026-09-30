# Standardize by copying an Owned/Seed Template instead of porting changes

Repos used to adopt the Baseline by porting each part's *change* from IssueTracker (the reference implementation) into
their own copies of the files, one part per PR, because a copied file silently undoes a repo's local fixes. That kept
every repo slightly different and made each port a survey-and-diff project. We now copy a Template instead: Owned files
are always overwritten, Seed files are written only when missing, and the repo's own work happens afterwards in Adapt.
The Template is the single source of truth, so the "copy undoes local fixes" risk is handled by rule, not by avoiding
copies: a fix found in a repo goes into the Template first, and `apply.sh` reports every Owned file it is about to
overwrite so no fix is lost unseen.

## Consequences

- Owned files must stay free of per-repo values; per-repo behaviour goes through Seed extension points (for example
  `.github/ci/prepare-tests.sh`), and `test.sh` fails on any `{{` placeholder under `owned/`.
- `global.json` is Owned, so SDK bumps land in the Template first; a Dependabot bump in one repo is reverted by the next
  Apply.
- One Standardize is one PR per repo (an Apply commit, then Adapt commits), not one PR per part.
