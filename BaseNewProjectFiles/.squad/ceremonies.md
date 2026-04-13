# Squad Ceremonies

## Defined Ceremonies

> **Plan Mode Standard Process:** Every `/plan` session MUST produce a milestone + sprint structure before work begins. No issue should be worked without being assigned to a sprint. This is the team's planning contract.

### Plan Ceremony

- **Trigger:** manual — when the user enters plan mode (`/plan` command or [[PLAN]] prefix)
- **When:** after plan.md is finalized and user approves the plan
- **Facilitator:** Aragorn
- **Participants:** Aragorn (lead), Ralph (work monitor)
- **Purpose:** Convert the approved plan.md into trackable GitHub milestones and sprint structure

#### Phase 1: Milestone Creation

1. Derive the milestone name from the plan title or epic (e.g., "Sprint 1 — {feature/epic name}")
2. Set a due date if the user specified one; otherwise leave blank
3. Create via GitHub API (note: `gh` does not have a `milestone create` subcommand natively):

   ```bash
   gh api repos/{owner}/{repo}/milestones --method POST \
     --field title="{milestone-name}" \
     --field description="{plan summary}" \
     [--field due_on="{ISO8601}"]
   ```

4. Confirm creation and record the milestone number

#### Phase 2: Sprint Definition

1. Review the todos from plan.md (or the SQL todos table)
2. Group todos into sprints — default sprint size: **5–8 issues** per sprint, or by logical dependency grouping
3. Name sprints: `Sprint {N} — {theme}` (e.g., "Sprint 1 — Foundation", "Sprint 2 — Core Features")
4. Each sprint should represent a shippable increment

#### Phase 3: Issue Creation + Sprint Assignment

1. For each todo in the plan, create a GitHub issue:

   ```bash
   gh issue create --title "{todo title}" \
     --body "{todo description}" \
     --label "squad" \
     --milestone "{milestone-name}"
   ```

2. Assign sprint grouping via a label: `sprint-{N}` (create the label if it doesn't exist):

   ```bash
   gh label create "sprint-{N}" --color "{color}" \
     --description "Sprint {N}" 2>/dev/null || true
   gh issue edit {number} --add-label "sprint-{N}"
   ```

3. Add appropriate `squad:{member}` routing labels based on the todo domain

#### Phase 4: Board Summary

Present a summary table:

```md
📅 Milestone: {name} (#{number})
├── 🏃 Sprint 1 — {theme}: {N} issues
│   ├── #{issue} {title} [squad:sam]
│   └── #{issue} {title} [squad:legolas]
└── 🏃 Sprint 2 — {theme}: {N} issues
    └── ...
```

### Pre-Sprint Planning

- **Trigger:** manual ("run sprint planning", "plan the sprint")
- **When:** before
- **Facilitator:** Aragorn
- **Participants:** Aragorn, Sam, Legolas, Gimli, Boromir
- **Purpose:** Review open issues, prioritize, assign squad labels

### Build Repair Check

- **Trigger:** automatic — enforced by `.git/hooks/pre-push` on every `git push`
- **When:** before push (gate 2) and before PR (gate 3)
- **Facilitator:** Aragorn
- **Participants:** Aragorn (runs build-repair prompt)
- **Purpose:** Ensure zero errors, zero warnings, all tests pass before pushing
- **Playbook:** `.squad/playbooks/pre-push-process.md` (full 5-gate walkthrough)
- **Critical rules (learned from PR #86 incident):**
  1. **Always use `--configuration Release`** — CI uses Release; Debug builds hide missing files. Never accept a Debug-only passing build.
  2. **Stage ALL untracked `.razor`/`.cs` files before committing** — run `git status --short` and treat any `??` source file as a blocker. Files present on disk but untracked are invisible to CI.
  3. **Loop until green** — the pre-push hook retries build+tests up to 3 times. Fix errors between retries. Do not bypass the hook.
  4. **Hook enforcement:** `.git/hooks/pre-push` runs automatically. It checks for untracked source files (Gate 1), runs `dotnet build --configuration Release` (Gate 2), then runs Architecture/Domain/bUnit tests (Gate 3). Push is blocked if any gate fails.

### Retro

- **Trigger:** manual ("run retro", "retrospective")
- **When:** after
- **Facilitator:** Aragorn
- **Participants:** all
- **Purpose:** What went well, what didn't, action items

### PR Review Gate

- **Trigger:** automatic — Ralph detects PR with `reviewDecision: null` and `statusCheckRollup: SUCCESS`
- **When:** after ALL CI checks pass; do NOT trigger while checks are pending or failing
- **Facilitator:** Aragorn
- **Participants:** Aragorn (always) + domain specialists determined by files changed:
- **Playbook:** `.squad/playbooks/pr-merge-process.md` (full merge lifecycle)

| Files changed                                                                                                                      | Required reviewer                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Any file                                                                                                                           | **Aragorn** (lead — always required) |
| `.github/workflows/`, `AppHost.csproj`, `Directory.Packages.props`                                                                 | **Boromir**                          |
| `Auth/`, `appsettings*.json` auth sections, `Program.cs` auth sections, `UserManagementService.cs`, `Auth0ClaimsTransformation.cs` | **Gandalf**                          |
| `tests/Domain.Tests/`, `tests/Web.Tests.Bunit/`, `tests/Persistence.*/`                                                            | **Gimli**                            |
| `tests/AppHost.Tests/` (Playwright / Aspire E2E)                                                                                   | **Pippin**                           |
| `src/Domain/`, `src/Persistence.*/`, `src/Web/Endpoints/`, `src/Web/Features/`                                                     | **Sam**                              |
| `src/Web/Components/`, `*.razor`, `*.razor.cs`, `*.razor.css`, `wwwroot/`                                                          | **Legolas**                          |
| `docs/`, `README.md`, XML doc changes                                                                                              | **Frodo**                            |

- **Purpose:** Quality and security gate before merge

#### Pre-Conditions (Ralph enforces before spawning reviewers)

Ralph MUST verify ALL of the following before the review cycle begins. Any failing gate blocks review:

1. **CI green:** `gh pr checks {N}` — all checks passing (`statusCheckRollup: SUCCESS`)
2. **No merge conflicts:** `gh pr view {N} --json mergeable` → `MERGEABLE` (not `CONFLICTED`)
3. **PR template complete:** PR description contains filled checkboxes (not all empty `[ ]`)
4. **Branch is `squad/*`:** PR is from a `squad/` branch, not `main` or `feature/`

#### Review Protocol

1. Determine required reviewers from the files-changed table above
2. **Read GitHub Copilot's automated review comments first:**

   ```bash
   gh pr view {N} --json reviews -q '.reviews[] | select(.author.login == "copilot-pull-request-reviewer") | .body'
   ```

   Aragorn must address any Copilot-flagged bugs, security issues, or logic errors
   before posting his own verdict. Copilot style suggestions are discretionary.
3. Spawn Aragorn + all required domain reviewers **in parallel**
4. Each reviewer posts their verdict as a GitHub PR review (`gh pr review {N} --approve` or `--request-changes --body "..."`)
5. Collect all verdicts — **unanimous approval required** (all spawned reviewers must approve)
6. If ANY reviewer submits CHANGES_REQUESTED → trigger **CHANGES_REQUESTED Ceremony** (see below)
7. All approved + CI green → squash merge

#### Merge

```bash
gh pr merge {N} --squash --delete-branch
git checkout main && git pull origin main && git fetch --prune
```

Then Ralph triggers **Post-Merge Orphan Branch Cleanup** (see ceremony below) to remove any stale local and remote `squad/*` branches.

#### Lockout Rule

The PR author (original agent who pushed the branch) is **locked out** of fixing their own rejected work within the same revision cycle. All fixes in a CHANGES_REQUESTED cycle must come from a different agent.

---

### CHANGES_REQUESTED Ceremony

- **Trigger:** automatic — Ralph detects PR with `reviewDecision: CHANGES_REQUESTED`
- **When:** immediately after any reviewer posts CHANGES_REQUESTED
- **Facilitator:** Aragorn
- **Purpose:** Route fixes to the correct agent while enforcing the lockout rule

#### Protocol

1. **Aragorn identifies** the reviewer who requested changes and lists the specific issues
2. **Aragorn identifies** the PR author (this agent is now locked out of this revision cycle)
3. **Aragorn routes fixes** to a DIFFERENT agent based on the nature of the changes requested:
   - Architecture / logic issues → Sam (if backend) or Legolas (if frontend)
   - Test coverage gaps → Gimli
   - E2E test gaps → Pippin
   - Security issues → Gandalf applies fixes
   - CI/infra issues → Boromir
   - If Aragorn is the reviewer, fixes go to the domain specialist owning the code
4. **Fix agent** pushes corrections to the **same branch** (do NOT open a new PR)
5. **CI must re-pass** — wait for all checks to turn green
6. **Original reviewers re-review** — the reviewer who requested changes must re-review (they are not locked out from reviewing)
7. If approved: resume normal PR Review Gate (step 6 — unanimous approval → merge)
8. If CHANGES_REQUESTED again: repeat from step 1 (new revision cycle, same lockout applies)

#### Comment template (posted by Aragorn on PR when routing fixes)

```md
🔄 **CHANGES_REQUESTED — Routing fix cycle**

Reviewer: @{reviewer} requested changes.
PR author (@{author}) is locked out of this revision cycle per rejection protocol.

**Issues to fix:**
{list of specific items from reviewer}

**Routed to:** @{fix-agent} ({role})
Fix agent: please push corrections to `{branch}` and comment when ready for re-review.
```

---

### Merge Conflict Resolution Ceremony

- **Trigger:** Ralph detects `mergeable: CONFLICTED` on an open PR
- **When:** as soon as conflict is detected (typically after `dev` advances)
- **Facilitator:** Aragorn (decides resolver and strategy)
- **Purpose:** Unblock PRs with merge conflicts without violating review integrity

#### Protocol 1

1. **Ralph detects** conflict → posts comment on PR:

   ```md
   ⚠️ **Merge conflict detected** on `{branch}`. This PR cannot merge until conflicts are resolved.
   Pinging Aragorn to route resolution.
   ```

2. **Aragorn determines** which files conflict (`gh pr view {N} --json files`) and routes to:
   - Backend files (`src/Domain/`, `src/Persistence.*/`) → **Sam**
   - Frontend files (`src/Web/Components/`, `*.razor`) → **Legolas**
   - CI/config files (`.github/`, `*.csproj`, `*.props`) → **Boromir**
   - Mixed or architectural conflicts → **Aragorn** resolves directly
3. **Resolver** checks out the branch and merges:

   ```bash
   git checkout {branch}
   git fetch origin
   git merge origin/dev
   # resolve conflicts
   git add .
   git commit -m "chore: resolve merge conflicts with dev\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
   git push
   ```

4. **CI must re-pass** after the merge commit
5. **Existing reviews are invalidated** — all reviewers must re-approve after a merge commit
6. Resume PR Review Gate from the beginning

---

### Post-Merge Orphan Branch Cleanup

- **Trigger:** automatic — Ralph triggers after every successful `gh pr merge`; can also be run manually ("clean orphan branches", "prune branches")
- **When:** immediately after merge completes; optionally run periodically (e.g. before each sprint)
- **Facilitator:** Ralph
- **Participants:** Ralph (executes cleanup autonomously)
- **Purpose:** Remove stale `squad/*` branches from both origin and local to keep the branch list tidy and avoid confusion

#### When to Run

| Trigger                                  | Who                                        |
| ---------------------------------------- | ------------------------------------------ |
| After `gh pr merge` succeeds             | Ralph (automatic)                          |
| Manual request ("clean orphan branches") | Ralph (on demand)                          |
| Before sprint planning                   | Aragorn (includes in pre-sprint checklist) |

#### Protocol 2

#### **Step 1 — Sync and prune remote tracking refs**

```bash
git checkout dev
git pull origin dev
git fetch --prune
```

`--prune` removes local tracking refs (`origin/squad/*`) for branches already deleted on origin.

#### **Step 2 — Delete merged remote branches (origin)**

Catches any `squad/*` branches not removed by `--delete-branch` at merge time:

```bash
git branch -r --merged origin/dev \
  | grep 'origin/squad/' \
  | sed 's|origin/||' \
  | xargs -r -I{} git push origin --delete {}
```

#### **Step 3 — Delete merged local branches**

```bash
git branch --merged dev \
  | grep -E '^\s+squad/' \
  | xargs -r git branch -d
```

#### **Step 4 — Delete local branches whose remote is gone**

Handles branches where the remote was already deleted but the local ref was not cleaned up:

```bash
git branch -vv \
  | grep ': gone]' \
  | grep 'squad/' \
  | awk '{print $1}' \
  | xargs -r git branch -D
```

> ⚠️ Step 4 uses `-D` (force delete) because these branches are already gone from origin. Only applies to `squad/` branches to avoid accidentally removing other local work.

#### **Step 5 — Report**

Print surviving branches for visibility:

```bash
echo "--- Remaining local branches ---"
git branch -vv | grep -v "^\* dev"

echo "--- Remaining remote squad/ branches ---"
git branch -r | grep 'origin/squad/' || echo "(none)"
```

#### Full one-liner (for convenience)

```bash
git checkout dev && git pull origin dev && git fetch --prune && \
git branch -r --merged origin/dev | grep 'origin/squad/' | sed 's|origin/||' | xargs -r -I{} git push origin --delete {} && \
git branch --merged dev | grep -E '^\s+squad/' | xargs -r git branch -d && \
git branch -vv | grep ': gone]' | grep 'squad/' | awk '{print $1}' | xargs -r git branch -D && \
echo "✅ Orphan branch cleanup complete."
```

---

### Standard Task Workflow

- **Trigger:** When starting any new task or issue
- **When:** throughout (setup → planning → implementation → review → cleanup)
- **Facilitator:** Agent or human working the task
- **Participants:** Task owner, reviewers (for PR phase)
- **Purpose:** Ensure consistent task execution with proper branch isolation and verification
- **Playbooks:** `.squad/playbooks/pre-push-process.md` (Phase 3: push), `.squad/playbooks/pr-merge-process.md` (Phase 4: review/merge)
- **Enforcement:** The pre-push hook (Gate 0) blocks direct pushes to `main` — you must use a `squad/{issue}-{slug}` feature branch

#### Phases

##### Phase 1: Setup

1. Sync with main:

   ```bash
   git checkout main
   git pull origin main
   ```

2. Create branch:

   ```bash
   git checkout -b squad/{issue-number}-{kebab-slug}
   ```

3. Push branch to GitHub:

   ```bash
   git push -u origin squad/{issue-number}-{kebab-slug}
   ```

4. If branch falls behind main during work:

   ```bash
   git merge origin/main
   ```

##### Phase 2: Planning

1. Analyze the problem
2. Document approach (in session plan, issue, or PR description)
3. Get user/stakeholder approval before implementing

##### Phase 3: Implementation

1. Make changes in the branch
2. Test locally
3. Iterate until complete
4. Commit and push — the pre-push hook (`.git/hooks/pre-push`) enforces all gates automatically:
   - **Gate 0:** Block direct push to `main`
   - **Gate 1:** Warn/block on untracked `.razor`/`.cs` files (invisible to CI)
   - **Gate 2:** `dotnet build {SolutionFile} --configuration Release` (must match CI exactly — **never** Debug-only)
   - **Gate 3:** `Architecture.Tests` + `Domain.Tests` + `Web.Tests.Bunit` (Release, no-build)
   - Hook loops up to 3 attempts with a "fix and retry" prompt between attempts
5. If a gate fails, fix the issue and re-run `git push` — the hook will re-execute all gates from scratch

##### Phase 4: Review & Merge

1. **CI must pass first.** Do not request review while checks are pending or failing.
   - Poll: `gh pr checks {N}` — wait for all green

2. **Spawn reviewers in parallel** (Aragorn always + domain specialists):
   - Aragorn — lead review (scope, architecture, correctness, naming conventions)
   - Boromir — if any `.github/workflows/` or CI config changed
   - Gandalf — if any auth, permissions, secrets, or security-relevant code changed
   - Gimli/Pippin — if test files changed
   - Sam — if backend/domain/persistence code changed
   - Legolas — if Blazor components or frontend changed

3. **Unanimous approval required.** All spawned reviewers must approve.
   - If rejected: identify fixes → route to a DIFFERENT agent (not the PR author, lockout enforced) → push fixes → wait for CI → repeat from step 1

4. **Merge (squash):**

   ```bash
   gh pr merge {N} --squash --delete-branch
   ```

5. **Update local main:**

   ```bash
   git checkout main
   git pull origin main
   git fetch --prune
   ```

6. **Trigger Post-Merge Orphan Branch Cleanup** — Ralph runs the full cleanup ceremony (remote + local merged branches + stale tracking refs). See **Post-Merge Orphan Branch Cleanup** ceremony for the complete protocol.

##### Phase 5: Cleanup

1. Return to main and sync:

   ```bash
   git checkout main
   git pull origin main
   ```

2. Confirm the branch was deleted remotely; if not, the Orphan Branch Cleanup ceremony handles it automatically.

### Sprint Review / Demo

- **Trigger:** manual ("run sprint review", "sprint demo", "demo sprint {N}")
- **When:** after sprint completion
- **Facilitator:** Aragorn
- **Participants:** Aragorn, Legolas, Sam, Gimli, Boromir, Frodo, Bilbo
- **Purpose:** Review shipped deliverables, confirm all sprint issues closed and PRs merged, prepare for release

#### Protocol 3

1. Aragorn confirms all sprint issues are closed: `gh issue list --state open --label "sprint-{N}"`
2. Aragorn summarizes what shipped: features, fixes, test counts added
3. If a new version ships: flag Bilbo to write the release blog post
4. Legolas demos any new UI components or UX changes (describe in summary if async)
5. Record outcomes in `.squad/decisions/inbox/aragorn-sprint-review-{N}.md`

### Issue Grooming

- **Trigger:** manual ("groom issues", "groom backlog", "refine issues")
- **When:** before sprint planning
- **Facilitator:** Aragorn
- **Participants:** Aragorn, Sam, Legolas, Gimli
- **Purpose:** Ensure open issues are properly labeled, scoped, and ready before sprint planning

#### Protocol 4

1. List open issues: `gh issue list --label "squad" --state open --json number,title,labels`
2. For each issue without `squad:{member}` sub-label: triage and assign appropriate sub-label
3. For each issue: verify title and body are clear and actionable; add details if needed
4. Identify issues that are too large and need splitting (create sub-issues)
5. Identify and close duplicate issues with a note explaining the duplicate

### Git Worktree Setup Ceremony

- **Trigger:** any of the following:
  - User says "use worktrees", "use a worktree", "isolate in a worktree", or "set up a sprint worktree"
  - ≥2 squad branches are active simultaneously
  - A new sprint begins with parallel workstreams planned
- **When:** before beginning sprint work, or at plan creation time when isolation is requested
- **Facilitator:** Boromir / Aragorn / Copilot (Coding Agent)
- **Purpose:** Isolate squad branch work, scribe/planning commits, and main branch to prevent `.squad/` files bleeding into feature branches

#### Worktree Layout

```md
~/Repos/
├── {ProjectName}/            ← main worktree  (main branch, read-only reference)
├── {ProjectName}-scribe/     ← scribe/planning worktree  (squad/scribe-* branches)
└── {ProjectName}-sprint/     ← active sprint worktree    (squad/{issue}-{slug})
```

#### Setup Commands

```bash
# Scribe / planning worktree
git worktree add ../{ProjectName}-scribe squad/scribe-log-updates

# New sprint branch worktree
git worktree add ../{ProjectName}-sprint -b squad/{issue-number}-{slug}

# List all active worktrees
git worktree list

# Remove a worktree after the branch is merged
git worktree remove ../{ProjectName}-sprint
git branch -d squad/{issue-number}-{slug}
```

#### Rules

| Rule                       | Detail                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Main worktree**          | Stays on `main`. Never used for active squad branch work.                                                                    |
| **Scribe worktree**        | Only `.squad/` commits live here. No source code changes.                                                                    |
| **Sprint worktrees**       | One per active squad branch.                                                                                                 |
| **No simultaneous builds** | `bin/` and `obj/` are shared; do not run `dotnet build` in two worktrees simultaneously.                                     |
| **Pre-push hook**          | Runs in every worktree — all gates still enforced.                                                                           |
| **Branching guard**        | `.squad/` files must never appear in sprint/feature worktree commits — the scribe worktree makes this physically impossible. |

---

### Integration Points

- **Build Repair Check:** Enforced via pre-push hook (Phase 3, step 4)
- **Code Review:** Triggered when PR is opened (Phase 4, step 2-3)
- **Merged-PR Branch Guard:** Check before committing to avoid stranded commits
- **Git Worktree Setup:** Use worktrees when ≥2 squad branches are active to prevent branch contamination

---

### Milestone Review → Release or Blog Ceremony

- **Trigger:** automatic — `milestone-blog.yml` fires when any milestone is closed
- **Facilitator:** Ralph (Work Monitor)
- **Participants:** Ralph (decision), Bilbo (blog post), Boromir (release tagging via automation)
- **Purpose:** Ensure every completed milestone gets either a full release or a blog post, and that the blog page is always updated.

#### Flow

```md
Milestone closed
      ↓
[milestone-blog.yml] creates Ralph review issue (squad:ralph + pending-review)
      ↓
Ralph reviews closed issues, checks release criteria
      ↓
Ralph labels the issue:
  ├── "release-candidate"  →  [milestone-release-decision.yml]
  │     ├── Dispatches squad-milestone-release.yml (tag + GitHub Release)
  │     └── release-blog.yml fires on publish → creates squad:bilbo brief
  └── "blog-only"          →  [milestone-release-decision.yml]
        └── Creates squad:bilbo blog brief directly
              ↓
        Bilbo writes post + updates docs/blog/index.md
              ↓
        [blog-readme-sync.yml] → README.md updated (the Page)
```

#### Release Criteria (Ralph's checklist)

| Criteria                                                                      | Weight                |
| ----------------------------------------------------------------------------- | --------------------- |
| Contains user-facing features or enhancements?                                | High                  |
| Contains breaking changes or migration steps?                                 | High (forces release) |
| Sufficient scope for a version bump? (≥3 features, or ≥1 significant feature) | Medium                |
| All CI gates green on `main`?                                                 | Gate (must be green)  |
| More than a hotfix / documentation / process change only?                     | Low                   |

**Default rule:** If in doubt, use `blog-only`. Releases should mark meaningful user-facing milestones.

#### Version Bump Convention

| Change type                  | Bump    |
| ---------------------------- | ------- |
| Breaking API/schema change   | `major` |
| New user-facing features     | `minor` |
| Bug fixes, perf, polish only | `patch` |

To override the default `minor` bump, add a line to the review issue body:

```md
bump: patch
```

before applying the `release-candidate` label.

#### Workflows Involved

| Workflow                         | Trigger                                          | Purpose                          |
| -------------------------------- | ------------------------------------------------ | -------------------------------- |
| `milestone-blog.yml`             | `milestone: closed`                              | Creates Ralph review issue       |
| `milestone-release-decision.yml` | Issue labeled `release-candidate` or `blog-only` | Routes to release or blog path   |
| `squad-milestone-release.yml`    | `workflow_dispatch`                              | Creates tag + GitHub Release     |
| `release-blog.yml`               | `release: published`                             | Creates Bilbo release blog brief |
| `blog-readme-sync.yml`           | `docs/blog/index.md` pushed to `main`            | Updates README Dev Blog section  |

#### Rules final

| Rule                                 | Detail                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| **Every milestone gets a blog post** | No exceptions — `blog-only` is the minimum outcome                              |
| **Ralph owns the decision**          | No other agent applies `release-candidate` or `blog-only` labels                |
| **The Page always updates**          | Bilbo must always update `docs/blog/index.md` — the sync workflow does the rest |
| **Release = blog post**              | A GitHub Release always triggers a blog post via `release-blog.yml`             |
| **Ralph closes the review issue**    | The decision workflow closes it automatically after routing                     |
