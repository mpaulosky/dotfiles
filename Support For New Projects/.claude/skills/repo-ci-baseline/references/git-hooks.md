# Git hooks and branch names

Template files (Owned): `.github/hooks/` (`pre-commit`, `pre-push`, `post-checkout`), `.github/hooks/tests/` and
`scripts/gate.sh`. History: IssueTracker #182 (the branch standard).

## Branch-name standard

Every repo's pre-push hook enforces the same rule:

| Branch | Use |
| --- | --- |
| `feature/{issue}-{slug}` | New behaviour |
| `fix/{issue}-{slug}` | A bug fix |
| `hotfix/{issue}-{slug}` | An urgent fix |
| `chore/{slug}` | Work without an issue |

`{slug}` is lowercase letters and digits in words joined by `-` (`upgrade-net10`, `oauth2-login`). A `chore/` slug
starts with a letter, so it can't pass for an issue-linked name (`chore/7-cleanup` is refused). The check:

```bash
[[ "$branch" =~ ^(feature|fix|hotfix)/[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$ ]] || [[ "$branch" =~ ^chore/[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]]
```

`squad/` and `sprint/` are retired. Branches the release workflow pushes (`docs/release-notes`) come from Actions, not a
local push, so the hook never sees them.

## The hooks

Hooks live in `.github/hooks/` and are switched on once per clone with `git config core.hooksPath .github/hooks`.
`apply.sh` sets it in the clone it Applies to; the repo's README or CONTRIBUTING tells everyone else.

- **`post-checkout`** repairs `core.hooksPath` and the hooks' execute bits after checkouts. Git only runs it once
  `core.hooksPath` already points at `.github/hooks`, so it can't bootstrap a fresh clone: its header comment says this,
  and names the one-time command.
- **`pre-commit`** lints the staged content of Markdown files; see [pre-commit.md](pre-commit.md).
- **`pre-push`**, in order:
  1. Read the refs from stdin, and gate the refs being pushed, not the checked-out branch. Classify by the *remote* ref,
     so a tag pushed onto a branch still counts as a branch push.
  2. Refuse pushes to, and deletions of, the protected branches (`main`, `preview`, `dev`).
  3. Refuse a branch name outside the standard.
  4. Refuse a pushed commit that isn't the checked-out `HEAD`, because the gate only tests the working tree.
  5. Refuse a working tree with uncommitted or untracked changes, for the same reason. Ignored files don't count.
  6. A push with no branch updates (tags only, or deletions only) skips the gate.
  7. Skip the gate when `HEAD` is the commit recorded in `git config sandcastle.gatedHead`: Sandcastle runs the gate in
     its sandbox, records the commit it passed, then pushes it, so a second run on the host only repeats it. Steps 4
     and 5 still apply first. Unset outside a Sandcastle repo (Blazor-Server #93).
  8. Run `scripts/gate.sh`.
- **`scripts/gate.sh`**, also safe to run by hand: lint the Markdown, YAML, workflow and shell files changed since
  `origin/main`, using CI's configs, and prefer installed tools with pinned fallbacks. Then build and run each test
  project, where the stack allows it locally. Which steps it runs depends on the repo; what's standard is that
  everything it checks, CI checks too.
  Between the lints and the build it runs the Seed `.github/ci/gate-checks.sh <merge-base>` when the repo has one:
  checks only that repo needs, such as Blazor-Server's Sandcastle TypeScript check and Copilot review sync. The merge
  base is empty without an `origin/main`.

## Tests

`.github/hooks/tests/pre-push.test.sh` runs the hook in a throwaway repo with stub tools that log each call, so no real
build runs. It needs cases for:

- each protected-branch rule and deletion
- the tag and mixed pushes
- a push that isn't the checked-out commit
- an untracked or unstaged file
- `.github/ci/gate-checks.sh` running with the merge base, and failing the push before the build
- a Sandcastle-gated `HEAD` skipping the gate (pushed and by hand), an ungated `HEAD` running it, and a gated `HEAD`
  with a dirty tree still refused
- **each accepted branch prefix** (including slugs with digits), and each retired or malformed name (`squad/`,
  `sprint/`, a prefix missing its issue number, a `chore/` slug starting with a digit, and an uppercase letter in an
  otherwise valid name such as `chore/tidy-Up`). Each bad name must break exactly one rule, or it can't catch a
  regression in that rule.

CI's hook-tests job runs this suite and `pre-commit.test.sh`.

## Adapting

- A repo's own gate steps go in the Seed `.github/ci/gate-checks.sh`, each guarded by the paths it covers. A step
  added to `gate.sh` itself is drift, reverted by the next Apply.
- Update every doc that lists branch names (`CLAUDE.md`, `CONTRIBUTING.md`, the README).
- The Standardize branch is pushed through the *new* hook, because `core.hooksPath` is relative to the worktree. Its
  name, `chore/standardize-baseline`, passes both the old rules and the new one.
- **Run one pre-push gate at a time.** A gate that runs Aspire or Testcontainers tests starts fixed-name containers, so
  two pushes gated in parallel (one per worktree) collide and fail each other.

## Verify live

Push a branch named under a retired prefix (`git push --dry-run` still runs the hook): it's refused with the standard's
message. Push a `fix/{issue}-{slug}` branch: the gate runs.
