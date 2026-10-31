# Repo CI baseline

The shared CI, release and git-hook standard for mpaulosky's .NET repos, and the process that brings a repo up to it.

## Language

**Baseline**:
The standard set of files and settings every repo is expected to carry.
_Avoid_: Standard files, starter kit

**Template**:
The skill's copy of the Baseline's files, made up of Owned and Seed files.
The single source of truth for the Baseline.
_Avoid_: Copy set, scaffold, reference implementation

**Owned file**:
A Template file the Baseline controls outright; applying the Template always overwrites the repo's copy.
_Avoid_: Managed file, core file

**Seed file**:
A Template file the repo controls after it first exists; applying the Template writes it only when the repo has none.
_Avoid_: Default file, starter file

**Apply**:
Copy the Template into a repo, the first step of Standardizing.
_Avoid_: Port, install, sync

**Adapt**:
The work after Apply that brings a repo's own code and Seed files into line with the Baseline.
_Avoid_: Port, fix-up

**Standardize**:
Bring a repo onto the Baseline: Apply, then Adapt.
_Avoid_: Port, migrate, onboard

**Drift**:
A difference between a repo's copy of an Owned file and the Template's, found when Applying.
_Avoid_: Divergence, local changes

**Leftover**:
A file in a directory the Template owns (workflows, hooks, CI scripts) that the Template doesn't carry.
_Avoid_: Orphan, stale file

**Security record**:
The review's local, git-ignored `.security/` folder in the main checkout: one file per security finding, written by `scripts/review.sh record`
and read by both reviews by id, lens and path only. Its README is an Owned file; its entries are never published.
_Avoid_: Security log, findings database

**Sandcastle section**:
The Template's files for a repo that runs Sandcastle: `.sandcastle/`, its workflow and Seed skills list, the session guidance
`.claude/rules/sandcastle-hand-off.md`, and the local review's skills, agent and `scripts/review.sh`.
Apply adds them only to a repo that has a `.sandcastle/` folder or no commits yet.
The files, and the model for handing a PR off, are in [references/sandcastle.md](references/sandcastle.md#hand-off-prs).
_Avoid_: Sandcastle template, agent kit

**Review round**:
A review of a non-merge commit on a PR, by Copilot or by Claude Review where Copilot can't review. It is dirty when it raised an inline thread or an off-diff finding, and clean otherwise.
A merge of `main` into the PR is never a round.
_Avoid_: Review pass, review cycle

**Exhausted loop**:
A PR's review loop after `MAX_CLAUDE_ROUNDS` (3) dirty rounds in a row. PR Auto-Merge takes `review:claude` off, posts one comment listing the threads still open
(and whether the head was reviewed), and lets the PR merge once its required checks pass, unless a thread a person opened is still open.
A login with write access re-adding `review:claude` starts a new loop; the label is ignored while Copilot can review.
The rule is in [references/automerge.md](references/automerge.md).
_Avoid_: Review cap, round limit
