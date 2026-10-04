# Instructions For Setting Up or Standardizing a Repo

Every repo carries the same CI, release, hook and lint Baseline, copied from the `repo-ci-baseline` skill's Template by
`apply.sh`. A new repo gets it as its first commit (Part A); an existing repo gets it through one Standardize PR
(Part B). Parts C and D apply to either.

The skill lives at `Support For New Projects/.claude/skills/repo-ci-baseline/`. Its `SKILL.md` is the source of truth;
these steps are the short path through it.

```bash
BASELINE="$HOME/github/dotfiles/Support For New Projects/.claude/skills/repo-ci-baseline"
```

## Part A: Set Up a New Repo

### A1. Create the Repository

```bash
mkdir [ProjectName]
cd [ProjectName]
mkdir -p docs/blogs docs/plans src tests
git init -b main
git remote add origin https://github.com/mpaulosky/[ProjectName].git
```

Add the solution file (`[ProjectName].slnx`) at the root before the next step, so `{{SOLUTION}}` gets filled in.

### A2. Apply the Baseline

On a repo with no commits, `apply.sh` runs on `main`, and its output is the first commit:

```bash
"$BASELINE/apply.sh" .
git add -A
git commit -m "chore: apply repo-ci-baseline Template"
```

It also runs `git config core.hooksPath .github/hooks`. From here on, `pre-commit` refuses commits in this primary
checkout: every later change, including filling the placeholders, is made in a worktree under
`../[ProjectName]-worktrees/` (see the skill's `references/git-hooks.md`). Fill any placeholders the report lists.

Push `main`, add the `RELEASE_PR_PAT` secret, then apply the GitHub settings (merge settings, ruleset, required checks,
labels, Actions and security):

```bash
"$BASELINE/github-settings.sh" --fix mpaulosky/[ProjectName]
```

Run it again after the first PR merges: required checks are added only once `main` reports them.

## Part B: Standardize an Existing Repo

One repo, one PR. If the repo still has squad installed (`.squad/` or `squad-*` workflows), run the `remove-squad`
skill first and land that on its own.

### B1. Survey

From the repo's primary checkout, on any branch:

```bash
"$BASELINE/apply.sh" --dry-run .
```

The dry run writes nothing. Read the report with the skill's `references/apply.md`, and plan an action for every line:
drift in overwritten Owned files, skipped Seed files, unfilled placeholders, Leftovers and Conflicts.

### B2. Apply

Sync `main`, then Apply in a fresh worktree. The script refuses `main`, `preview`, `dev`, a detached `HEAD` and a dirty
worktree, so the Apply commit is exactly its output:

```bash
git fetch origin
git worktree add -b chore/standardize-baseline ../[Repo]-worktrees/chore-standardize-baseline origin/main
cd ../[Repo]-worktrees/chore-standardize-baseline
"$BASELINE/apply.sh" .
git add -A
git commit -m "chore: apply repo-ci-baseline Template"
```

### B3. Adapt

In further commits on the same branch, work through the skill's `references/adapt.md`: drop drift (or move a real local
fix into the Template first), merge skipped Seed files, fill placeholders, decide each Leftover, fix Conflicts, and move
repo-only CI setup into `.github/ci/prepare.sh`. Done when `scripts/gate.sh` passes locally.

### B4. Land

Push once and open the PR **as a draft**, because the repo's old auto-merge workflow would otherwise merge it as soon as
its checks pass. While it's a draft:

- run the docs-only probe from `references/docs-only-ci.md`,
- run `"$BASELINE/github-settings.sh" --fix mpaulosky/[Repo]` (it also checks the `RELEASE_PR_PAT` secret exists).

Then land it by hand as `references/automerge.md` describes, while nothing else is in flight: the merge is the new
`release.yml`'s first live run. Run `github-settings.sh --fix` again right after the merge, so the new required checks
are added. Done when the PR **and** its release-blog PR have merged, and `github-settings.sh` reports the repo clean.

### B5. Verify and Record

Run each part's live check from its reference; a part counts only once that passes on the repo. Put any lesson into the
matching reference, and any fix to an Owned file into the Template (a dotfiles PR with `test.sh` green), so the next
Standardize doesn't hit the same surprise.

Order across repos: TicketManager first, then IssueTracker, atelier-store, Blazor-Server, IssueManager and Articles.
TinyTicket is retired and not Standardized.

## Part C: Optional App-Stack Starting Points

These aren't part of the Baseline. Copy the ones that fit, and rewrite them for the project; they were written for
IssueTracker.

- [ ] `.aspire/` for an Aspire app
- [ ] `.github/instructions/blazor.instructions.md` for a Blazor UI
- [ ] `.github/instructions/dotnet-project.instructions.md`
- [ ] `.github/instructions/mongo-dba.instructions.md` for MongoDB
- [ ] `.github/skills/code-review/` (a repo skill; see `.claude/skills/README.md` in the repo)
- [ ] `.github/agents/beast.agent.md`

## Part D: Configure Auth0 for Web Projects

In the Web project's `Web.csproj` file, replace the `UserSecretsId` value with:

```xml
<UserSecretsId>94491f6e-auth0-values-3ff40da38702</UserSecretsId>
```
