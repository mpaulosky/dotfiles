---
name: "release-process-base"
description: "Generic, framework-agnostic release workflow patterns: version bumping, branch merging, tagging, and CI/CD architecture. Parameterized for .NET, Node.js, Python, Java, and other ecosystems. Use this as a template; bind to your project via .release-config.json or project playbook."
domain: "release-workflow"
confidence: "high"
source: "abstracted from BlazorWebFormsComponents"
tools:
  - name: "gh"
    description: "GitHub CLI for detecting repo state, workflows, and secrets (read-only)"
    when: "Inferring project-specific parameters instead of hardcoding"
---

## Context

Release workflows vary by ecosystem, branching model, and deployment targets. This skill abstracts the **universal patterns** (versioning, merge strategies, CI/CD triggers) and separates them from **project-specific bindings** (branch names, package IDs, registries).

**When to use:**
- Preparing a release in any Git + CI/CD environment
- Designing a release process for a new project
- Troubleshooting version, merge, or CI/CD issues during release
- Migrating a release workflow between projects

**When NOT to use:**
- Deploying code between environments (use DevOps/deployment skills)
- Managing secrets or authentication (use security skills)
- Troubleshooting CI/CD platform issues (use CI/CD skills)

## Generic Release Workflow

### Prerequisites (Project-Agnostic)

Before any release, verify:
- ✅ All feature PRs for this release are merged into the **development branch**
- ✅ CI pipeline passes on **development branch** (unit tests, integration tests, linting)
- ✅ No unmerged feature branches lingering in the development branch
- ✅ Changelog or release notes are prepared

### Phase 1 — Version Bumping

**Decision Tree:**

- **Q: How is your version stored?**
  - **A: In a version file (version.json, VERSION, package.json)** → Static file update
    - Edit `{VERSION_FILE}` to the next semantic version
    - Commit to `{DEV_BRANCH}` with message: `Bump version to {VERSION}`
  - **A: Computed by a tool (NBGV, Maven, Cargo.toml)** → Tool-based update
    - Run the version tool's bump command
    - Verify the new version in the tool's config file
    - Commit to `{DEV_BRANCH}`
  - **A: Only via Git tags** → Skip this phase; version is inferred at tag time

- **Q: Do you release from a dedicated release branch?**
  - **A: Yes (e.g., 1.x, 2.x)** → Create/update branch; merge to it, bump there
  - **A: No** → Bump on `{DEV_BRANCH}` before merge to `{RELEASE_BRANCH}`

**Best Practice:** Version bumps should be separate, reviewable commits. Always push the bump to `{DEV_BRANCH}` before creating the release PR.

### Phase 2 — Release PR (Dev → Release Branch)

Create a PR from `{DEV_BRANCH}` to `{RELEASE_BRANCH}`:

```bash
gh pr create \
  --repo {OWNER}/{REPO} \
  --base {RELEASE_BRANCH} \
  --head {DEV_BRANCH} \
  --title "Release v{VERSION}" \
  --body "## Release v{VERSION}

### What's Included
- {Feature A}
- {Feature B}
...

### Validation Checklist
- [ ] All CI checks passing
- [ ] All integration tests passing
- [ ] Version bumped correctly in {VERSION_FILE}
- [ ] Changelog updated
- [ ] Release notes prepared"
```

**Decision Tree: Merge Strategy**

- **Option A: Merge Commit** (`--merge`)
  - **Pros:** Preserves full commit history, clean chronological sequence, keeps `{RELEASE_BRANCH}` and `{DEV_BRANCH}` in sync
  - **Cons:** More commits on release branch
  - **When to use:** When release branch exists long-term and history matters (e.g., `main`, `1.x`, `2.x`)
  - **Command:** `gh pr merge {PR_NUM} --merge --subject "Release v{VERSION}"`

- **Option B: Squash Merge** (`--squash`)
  - **Pros:** Single clean commit per release, minimal history on release branch
  - **Cons:** Loses feature-level commit history on release branch
  - **When to use:** When release branch is short-lived or history exists on dev
  - **Command:** `gh pr merge {PR_NUM} --squash --subject "Release v{VERSION}"`

- **Option C: Rebase** (`--rebase`)
  - **Pros:** Linear history, no merge commits
  - **Cons:** Rewrites history; incompatible with collaboration
  - **When to use:** Single-developer projects; rarely recommended for team projects
  - **Command:** `gh pr merge {PR_NUM} --rebase`

**Recommendation:** Use merge commits on `{RELEASE_BRANCH}`. Squash merges work for ephemeral dev branches but undermine release branch history.

### Phase 3 — Tagging and Release

After merge to `{RELEASE_BRANCH}`:

```bash
# Sync local release branch
git fetch origin
git checkout {RELEASE_BRANCH}
git reset --hard origin/{RELEASE_BRANCH}

# Tag the release
git tag -a {TAG_PREFIX}{VERSION} -m "Release {TAG_PREFIX}{VERSION}"
git push origin {TAG_PREFIX}{VERSION}

# Create GitHub Release (optional but recommended)
gh release create {TAG_PREFIX}{VERSION} \
  --repo {OWNER}/{REPO} \
  --title "v{VERSION}" \
  --notes "{Release notes}" \
  --target {RELEASE_BRANCH}
```

**Tag Format:**
- Use semantic versioning: `v1.2.3`, `v0.19.0-beta.1`
- Prefix with `{TAG_PREFIX}` (usually `v`)
- Annotated tags preserve tagger info; lightweight tags are faster but less informative

**GitHub Release:**
- Triggered by `gh release create` or the GitHub UI
- Publishing a release typically **triggers CI/CD workflows** (via `published` event)
- Release notes are searchable and visible to end users

### Phase 4 — CI/CD Pipeline Verification

**What Happens After Release Tag:**

Depending on your `.github/workflows/` configuration, the `published` release event may trigger:

| Capability | Typical Workflow | Role |
|------------|------------------|------|
| Build Verification | `release.yml` or `build.yml` | Verify build succeeds on release tag |
| Package Publishing | `publish-nuget.yml`, `publish-npm.yml` | Publish to NuGet, npm, PyPI, etc. |
| Container Publishing | `publish-container.yml` | Build and push Docker/OCI image to registry |
| Documentation Deploy | `docs.yml` | Build docs and deploy to GitHub Pages or docs site |
| Artifact Archiving | `archive-release.yml` | Attach binaries, source archives to release |
| Notification | (webhook or action) | Slack, email, Discord notification |
| Deployment | `deploy-prod.yml` | Auto-deploy to production (if desired) |

**Your playbook must specify:** Which workflows are configured for your project.

**Verification:** Visit your release on GitHub and confirm:
- ✅ Build job passed
- ✅ All artifacts (packages, Docker images, docs) attached or deployed
- ✅ No workflow failures in Actions tab

### Phase 5 — Post-Release Tasks

After release is confirmed successful:

```bash
# Sync both branches locally
git fetch origin
git checkout {DEV_BRANCH}
git reset --hard origin/{DEV_BRANCH}

git checkout {RELEASE_BRANCH}
git reset --hard origin/{RELEASE_BRANCH}
```

**Optional (depending on project):**
- Merge release branch back into dev (if using long-lived release branches)
- Create a follow-up issue for the next release
- Notify stakeholders (Slack, email, GitHub Discussions)
- Archive release notes in documentation

## Architecture Patterns

### Two-Branch Model (Recommended)

```
{DEV_BRANCH} (active development)
    │
    ├─ Feature PR 1 ──squash──> dev
    ├─ Feature PR 2 ──squash──> dev
    └─ Feature PR 3 ──squash──> dev
    │
    └─ Release PR ──merge──> {RELEASE_BRANCH}
                                    │
                                    └─ Tag v1.2.3
                                    └─ GitHub Release
                                    └─ CI/CD pipelines
```

**Why:**
- Dev branch accumulates feature branches; keeps history rich
- Release branch is pristine: only merge commits and tags
- Tags always point to release commits, making history auditable
- Allows parallel release prep while dev continues

### Single-Branch Model (Simpler)

```
main (all history)
    │
    ├─ Feature PR 1 ──merge──> main
    ├─ Feature PR 2 ──merge──> main
    ├─ Feature PR 3 ──merge──> main
    │
    └─ Tag v1.2.3
    └─ GitHub Release
    └─ CI/CD pipelines
```

**When to use:**
- Small projects with infrequent releases
- Teams that prefer minimal branching
- Continuous delivery models (releases every PR)

**Trade-off:** All history on main; no separation of concerns.

## Version System Abstractions

### Pattern: Static File Versioning

**Example: version.json**
```json
{
  "version": "1.2.3"
}
```
- ✅ Simple, language-agnostic
- ✅ Easy to bump via CI scripts
- ❌ Must remember to commit before release
- **When to use:** Node.js (package.json), Python (pyproject.toml), custom projects

### Pattern: Tool-Computed Versioning (NBGV)

**Example: Nerdbank.GitVersioning (NBGV, .NET)**
```json
{
  "version": "1.2.0",
  "publicReleaseRefSpec": ["^refs/heads/main$", "^refs/tags/v.*"]
}
```
- ✅ Auto-increments on git height
- ✅ Prevents manual version bumps
- ✅ Integrates with build system
- ❌ Requires tool dependency
- **When to use:** .NET (C#), Maven (Java), Cargo (Rust)

### Pattern: Tag-Only Versioning

**Example: Inferred from git tag**
```bash
# Version is v1.2.3 if tag is v1.2.3
# Prevents double-versioning (no version.json, no tool)
```
- ✅ Minimal dependencies
- ✅ Single source of truth (the tag)
- ❌ CI must parse tag to extract version
- **When to use:** Simple projects, microservices, Docker-first workflows

**Recommendation:** Choose one; mixing versioning systems causes conflicts.

## Common Issues and Diagnostics

### Issue: Version Mismatch (tag vs. file)

**Symptom:** Release CI/CD reports version 1.2.2 but tag is v1.2.3

**Root Cause:** Version file bumped after tag, or tag created before version bump

**Fix:**
```bash
# Audit: Check tag vs. version file
git show v1.2.3:version.json | grep '"version"'
git show v1.2.3:package.json | jq '.version'

# If mismatch: Delete tag, re-bump, re-tag
git tag -d v1.2.3
git push origin :v1.2.3  # Delete remote tag
# Now: fix version file, commit, tag again
```

### Issue: Merge Conflicts During Release PR

**Symptom:** Cannot merge `{DEV_BRANCH}` → `{RELEASE_BRANCH}` due to conflicts

**Root Cause:** Release branch has diverged (e.g., hot-fix commits) or version file conflicts

**Fix:**
```bash
# Option A: Sync release branch from dev (if safe)
git checkout {RELEASE_BRANCH}
git merge {DEV_BRANCH} --allow-unrelated-histories --ours  # Prefer dev version

# Option B: Resolve conflicts manually
git merge {DEV_BRANCH}  # Lists conflicts
# Edit conflicted files, choose strategy
git add .
git commit -m "Resolve release merge conflicts"
```

### Issue: CI/CD Pipeline Doesn't Trigger After Release

**Symptom:** Tag created, release published, but no workflows ran

**Root Causes:**
1. Workflows not configured to trigger on `published` event
2. Tag does not match `on.push.tags` filter in workflow
3. Branch protection blocks tag-based workflows

**Fix:**
```bash
# Check workflow configuration
grep -A5 "on:" .github/workflows/release.yml | grep -A2 "release"

# Verify tag matches pattern
# If workflow expects tags like "release-1.2.3", tag accordingly

# Check if tag push was blocked
git push origin --tags  # Explicitly push all tags
```

### Issue: NuGet / npm / PyPI Publishing Fails

**Symptom:** Build succeeds but publish job fails with "Invalid credentials"

**Root Cause:** API key expired, secret misconfigured, or package name mismatch

**Fix:**
```bash
# List available secrets (names only; never values)
gh secret list --json name

# Rotate API key (contact your package registry)
gh secret set {SECRET_NAME}  # Prompts for value

# Verify package ID/name matches registry
# For NuGet: PackageId in .csproj
# For npm: "name" in package.json
# For PyPI: [project] name in pyproject.toml
```

## Anti-Patterns (What NOT to Do)

❌ **Bump version on release branch**
- Version changes should be on dev; release branch is immutable
- Forces cherry-picks and merge conflicts

❌ **Manual package publishing after release**
- Rely on CI/CD; manual steps introduce inconsistency
- Document in workflows instead

❌ **Tag-and-release without CI verification**
- Always wait for CI to pass before releasing to users
- If CI fails, delete tag and fix

❌ **Squash merge on long-lived release branches**
- Loses historical context; makes debugging harder
- Use merge commits for release history

❌ **Mixing version systems (version.json + NBGV + tags)**
- Pick one; multiple sources cause conflicts
- Document choice in playbook

## Glossary

- **{DEV_BRANCH}:** Active development branch (e.g., `dev`, `develop`, `main` for single-branch)
- **{RELEASE_BRANCH}:** Branch where releases are tagged (e.g., `main`, `release`)
- **{TAG_PREFIX}:** Prefix for release tags (e.g., `v`, `release-`)
- **{VERSION}:** Semantic version (e.g., `1.2.3`, `0.19.0-beta.1`)
- **{VERSION_FILE}:** File storing version (e.g., `version.json`, `package.json`)
- **{OWNER}/{REPO}:** GitHub repo identifier

## Next Steps: Binding to Your Project

1. **Create `.release-config.json` at repo root** (or document in playbook):
   ```json
   {
     "devBranch": "dev",
     "releaseBranch": "main",
     "versionSystem": "nbgv|semver-file|tag-only",
     "versionFile": "version.json",
     "tagPrefix": "v",
     "mergeStrategy": "merge|squash",
     "workflows": ["build", "publish-nuget", "deploy-docs"],
     "packageName": "MyPackage",
     "artifacts": ["nuget", "docker", "docs"]
   }
   ```

2. **Create a project-specific playbook** (e.g., `.squad/playbooks/release-myproject.md`):
   - Bind parameters from config
   - Document any project-specific steps
   - Link to workflow files

3. **Validate:** Run a mock release on a non-production tag to test the workflow.

---

**See also:** Your project's `.release-config.json` or project playbook for concrete bindings.
