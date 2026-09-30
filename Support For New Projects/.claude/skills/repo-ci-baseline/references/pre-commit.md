# Staged-content pre-commit

Reference: IssueTracker PR #170 (`.github/hooks/pre-commit`, `.github/hooks/tests/pre-commit.test.sh`, the hook-tests
job in `ci.yml`).

## Design

The hook lints what the commit will contain. It writes each staged Markdown file's **index** content, plus the
**staged** `.markdownlint-cli2.jsonc`, into a temporary tree with the same layout (`git checkout-index
--prefix=<tmp>/`), then runs `markdownlint-cli2` from inside that tree. The config's `ignores` still apply there because
the paths are unchanged.

- Staged paths come from `git diff --cached --name-only -z --diff-filter=ACMR`. `-z` keeps paths with spaces intact. `R`
  is there because a rename is listed under its new path, so dropping it lets a renamed file skip the lint.
- Only a config that is in the index is used. A config that exists only in the working copy won't be in the commit, so
  it must not decide the result.

## Tests

`pre-commit.test.sh` runs the hook in a throwaway repo with a stub `markdownlint-cli2` on `PATH`. The stub must apply
rules read from the config it finds (a forbidden word, an ignored path prefix). A stub that only checks a config exists
can't tell which config the hook used. Cases that must exist:

- a violation staged but fixed only in the working copy → refused
- a violation only in the unstaged working copy → allowed
- a real staged rename carrying a violation → refused. Give the file enough unchanged lines that `git diff --cached
  --name-status` reports `R` (a one-line file shows up as an add), and make the case **fail** when it doesn't, rather
  than print a warning and go on to test the add path.
- a staged config that differs from the working copy's → the staged rules apply
- a config that isn't staged → not used
- a staged file under an ignored path → allowed
- a path with spaces, a deletion (skips the lint), and no staged Markdown (skips the lint)

Commit the test repo's setup with `git -c core.hooksPath=/dev/null`, so a global hooks path on the developer's machine
doesn't run during setup. Mutation-check the suite: swap the hook to copy the working-copy config and confirm the config
cases fail, and overwrite the renamed file so git sees an add and confirm the rename case fails.

## Porting

Keep the repo's own install hint (for example `pnpm add -g` instead of `npm install -g`). Add the suite to CI's
hook-tests job, and name it in that job's comment.

## Verify live

Commit a partly staged Markdown file whose staged version breaks a rule: the commit must be refused even though the
working copy is clean.
