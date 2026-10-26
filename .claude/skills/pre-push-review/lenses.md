# Review lenses

The `pre-push-review` skill gives each lens below to its own reviewer, for the changed files its **Applies to** column
matches. They are the kinds of finding that keep recurring on GitHub's reviews of the Baseline repos' PRs: behaviour on a
path the author didn't test, far more often than style. A repository adds its own lenses, and the sources of truth they
rest on, in `.claude/skills/code-review/SKILL.md` (a **Lenses** table of the same shape): the skill reads both.

Every finding is graded: Critical for a bug in code that runs (application code, tests, tooling and build and dependency
configuration) or new or changed behaviour with no test, Warning for a security weakness in any file, and Advisory for
docs, comments, prompts and conventions. Every finding has a suggested fix.

| Lens | Applies to | Ask |
| --- | --- | --- |
| Edge cases | Any code | What do empty, whitespace-only, Unicode, malformed, oversized and boundary inputs do? What if a value is missing, null or duplicated? |
| Races and caches | Shared state, caches, async code, Sandcastle runs | What if two requests, circuits or runs interleave? Can a read already in flight put a stale entry back after a write evicts it? Does every write evict what it makes stale? |
| Error contract | Handlers, services, components showing errors | Does each expected failure come back as the failure the caller is told to expect, with the right stable code? Is anything caught too broadly, swallowed, or logged with a token or secret? |
| Blazor lifecycle | `.razor`, `.razor.cs` | Does it work prerendered and then interactive? Is UI changed from a timer, callback or background task wrapped in `InvokeAsync(StateHasChanged)`? Is everything it subscribes to disposed? Does every link and navigation reach a page? |
| Security | Pages, endpoints, auth, workflows, scripts | Does every page and endpoint that reads or changes protected data require authorization (`[Authorize]`, not `<AuthorizeView>` alone)? Can input reach output, a redirect, a query or a shell unchecked? Can a fork, a bot or a person without write access reach a secret or a write token? |
| Tests | Any behaviour change | Does every new or changed behaviour have a test that fails without the change? Can each assertion actually fail? Are both the success and every error path covered, and every testable acceptance criterion? |
| Docs match the code | Comments, `README.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/`, prompts | Does every comment and doc the change touches, or that describes what it changed, still say what the code does? Is a list (slices, labels, scopes) still complete? Does an edit leave a doc contradicting itself? |
| Sandcastle host | `.sandcastle/` | Does it fail closed? Does a failure end the run red rather than green or crashing? Is every label it claims released on every path? Does no agent gain a way to reach GitHub? |
| Shell | `*.sh`, hooks | Does it hold under `set -euo pipefail`, an empty variable, a path with spaces, GNU and BSD tools, a missing tool, and the `GIT_*` variables a hook sets? Does every failure exit non-zero? |
| GitHub Actions | `.github/workflows/`, `.github/scripts/` | Which events start it, from which actor, with which token and permissions? What does a skipped, cancelled or failed run do to the PR's merge state? Can a fork's PR reach the secrets? Is every action pinned to a commit no older than `main`'s? |
| Repo conventions | Any file | Does it keep the repository's own boundaries and conventions (`CLAUDE.md`, `.sandcastle/CODING_STANDARDS.md`, its ADRs and `.claude/rules/`), and leave the Owned Baseline files as the Template has them? |

A diff that changes only Markdown gets the **Docs match the code** and **Repo conventions** lenses.

## Out of scope

Leave compiler and analyzer findings to the build, which fails CI on them. Spend comments on behaviour, boundaries, tests
and intent.
