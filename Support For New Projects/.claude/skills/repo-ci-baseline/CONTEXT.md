# Repo CI baseline

The shared CI, release and git-hook standard for mpaulosky's .NET repos, and the process that brings a repo up to it.

## Language

**Baseline**:
The standard set of files and settings every repo is expected to carry.
_Avoid_: Standard files, starter kit

**Template**:
The skill's copy of the Baseline's files, laid out as a target repo's root and split into Owned and Seed files. The
single source of truth for the Baseline.
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
