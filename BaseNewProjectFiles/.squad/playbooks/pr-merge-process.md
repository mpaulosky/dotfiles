# PR Review & Merge Process Playbook

**Owner:** Aragorn (Lead) + Ralph (Work Monitor)
**Ref:** `.squad/ceremonies.md` (PR Review Gate, Standard Task Workflow)
**Last Updated:** 2026-04-13

---

## Overview

This playbook covers the end-to-end PR lifecycle: from opening a PR to squash-merging into `dev` (or `main`). Ralph monitors gates; Aragorn facilitates review; domain specialists provide parallel reviews.

## Step 1 — Open the PR

After pushing your branch (all pre-push gates passed):

```bash
gh pr create \
  --base dev \
  --title "feat(scope): description (#issue)" \
  --body "Closes #<issue-number>

## Changes
- ...

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing done

## Checklist
- [ ] Code follows conventions
- [ ] Tests added/updated
- [ ] Documentation updated (if needed)" \
  --assignee @me
```

**Branch naming:** `squad/{issue-number}-{slug}` (enforced by routing.md)

## Step 2 — Wait for CI

Do NOT request review until CI is green:

```bash
# Poll CI status
gh pr checks <PR-number>
# All checks must show ✅ before proceeding
```

**If CI fails:** Fix on the same branch, push again (pre-push hook re-runs), wait for green.

## Step 3 — Ralph's Pre-Review Gate

Ralph MUST verify ALL of the following before spawning reviewers. Any failing gate blocks review:

| Gate                | Command                                             | Expected                   |
| ------------------- | --------------------------------------------------- | -------------------------- |
| CI green            | `gh pr checks <N>`                                  | All passing                |
| No conflicts        | `gh pr view <N> --json mergeable -q .mergeable`     | `MERGEABLE`                |
| PR template filled  | `gh pr view <N> --json body`                        | Contains filled checkboxes |
| Branch is `squad/*` | `gh pr view <N> --json headRefName -q .headRefName` | Starts with `squad/`       |

## Step 4 — Spawn Reviewers

Aragorn is ALWAYS required. Additional reviewers depend on files changed:

| Files Changed                                                                             | Required Reviewer                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------ |
| Any file                                                                                  | **Aragorn** (lead — always required) |
| `.github/workflows/`, `*AppHost.csproj`, `Directory.Packages.props`                        | **Boromir**                          |
| `Auth/`, `appsettings*.json` auth sections, `Program.cs` auth, `*Service.cs` (auth)       | **Gandalf**                          |
| `tests/{TestType}.Tests/`, `tests/*.Tests.Bunit/`                                          | **Gimli**                            |
| `tests/AppHost.Tests/` (Playwright / Aspire E2E)                                           | **Pippin**                           |
| `src/Domain/`, `src/Persistence.*/`, `src/Web/Endpoints/`, `src/Web/Features/`             | **Sam**                              |
| `src/Web/Components/`, `*.razor`, `*.razor.cs`, `*.razor.css`, `wwwroot/`                  | **Legolas**                          |
| `docs/`, `README.md`, XML doc changes                                                     | **Frodo**                            |

### Read Copilot Review First

Before any reviewer posts their verdict, read GitHub Copilot's automated review:

```bash
gh pr view <N> --json reviews -q '.reviews[] | select(.author.login == "copilot-pull-request-reviewer") | .body'
```

Address any Copilot-flagged bugs, security issues, or logic errors. Style suggestions are discretionary.

## Step 5 — Collect Verdicts

- Spawn Aragorn + all required domain reviewers **in parallel**
- Each reviewer posts a GitHub PR review:

```bash
# Approve
gh pr review <N> --approve --body "LGTM — [summary]"
# Request changes
gh pr review <N> --request-changes --body "[specific issues]"
```

- **Unanimous approval required** — ALL spawned reviewers must approve

## Step 6 — Handle CHANGES_REQUESTED

If ANY reviewer requests changes:

1. **Lockout rule:** The PR author is locked out of fixing in the same revision cycle
2. Aragorn routes fixes to a DIFFERENT agent based on domain:
   - Backend/logic → Sam
   - Frontend/UI → Legolas
   - Tests → Gimli / Pippin
   - Security → Gandalf
   - CI/infra → Boromir
3. Fix agent pushes corrections to the **same branch** (no new PR)
4. Wait for CI to re-pass
5. Original reviewers re-review
6. If approved → resume Step 7. If rejected again → repeat from Step 6

### Comment Template (Aragorn posts on PR)

```md
🔄 **CHANGES_REQUESTED — Routing fix cycle**

Reviewer: @{reviewer} requested changes.
PR author (@{author}) is locked out of this revision cycle per rejection protocol.

**Issues to fix:**
{list from reviewer}

**Routed to:** @{fix-agent} ({role})
Fix agent: push corrections to `{branch}` and comment when ready for re-review.
```

## Step 7 — Squash Merge

Once all reviewers approve and CI is green:

```bash
gh pr merge <N> --squash --delete-branch
```

**Commit message format** (conventional commits):

```md
feat(scope): description (#PR-number)

- Bullet point changes
- ...

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Step 8 — Post-Merge Cleanup

Ralph triggers the Post-Merge Orphan Branch Cleanup ceremony:

```bash
# Sync local
git checkout dev && git pull origin dev && git fetch --prune

# Remove merged remote squad/ branches
git branch -r --merged origin/dev \
  | grep 'origin/squad/' \
  | sed 's|origin/||' \
  | xargs -r -I{} git push origin --delete {}

# Remove merged local squad/ branches
git branch --merged dev \
  | grep -E '^\s+squad/' \
  | xargs -r git branch -d

# Remove local branches with deleted remotes
git branch -vv \
  | grep ': gone]' \
  | grep 'squad/' \
  | awk '{print $1}' \
  | xargs -r git branch -D

echo "✅ Orphan branch cleanup complete."
```

## Anti-Patterns

- ❌ **Requesting review while CI is failing** — Wait for green first
- ❌ **PR author fixing their own rejected code** — Lockout enforced per rejection protocol
- ❌ **Merge commit instead of squash** — Use `--squash` for clean history
- ❌ **Skipping Copilot review read** — Always check automated feedback first
- ❌ **Leaving orphan branches** — Run cleanup after every merge
- ❌ **Opening PR from `main` or `feature/`** — Must be from `squad/*` branch

## Related Documents

- **Full ceremonies:** `.squad/ceremonies.md` (PR Review Gate, CHANGES_REQUESTED, Post-Merge Orphan Branch Cleanup)
- **Reviewer protocol skill:** `.copilot/skills/reviewer-protocol/SKILL.md`
- **Merged PR guard skill:** `.copilot/skills/merged-pr-guard/SKILL.md`
- **Routing:** `.squad/routing.md` (reviewer mapping)
- **Pre-push playbook:** `.squad/playbooks/pre-push-process.md`

---

**Use this playbook for every PR.** Ralph enforces the gates automatically, but following this checklist ensures no steps are missed.
