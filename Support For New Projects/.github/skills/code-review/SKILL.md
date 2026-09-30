---
name: code-review
description: >-
  Code review for pull requests in IssueTracker, a Blazor Server issue tracker on MongoDB and .NET Aspire. Use when
  reviewing a pull request or diff for correctness, repository standards, data access, security, tests, docs, and workflows.
---

# Code review

Review the pull request against this repository's own sources of truth. The rules below point at them and add what
they don't say. Every finding cites the file and rule it rests on.

## Sources of truth

Read the sections that govern the changed code before commenting on it:

- `CLAUDE.md`: architecture, configuration, build and test commands, and workflow. It wins when another instruction
  file disagrees.
- `.editorconfig`: tabs, file-scoped namespaces, explicit types over `var`, and `System` usings first.
- `.github/instructions/*.instructions.md`: Blazor, .NET, Markdown, MongoDB and blog post rules.
- `.github/instructions/git-commit-instructions.md`: commit message format.

## What to check

**Layering.** Pages and components call services only. Flag a component that injects a repository, `IMongoDbContextFactory`
or a MongoDB type, and a service that depends on a concrete repository instead of an interface from
`PlugInRepositoryInterfaces/`. `Architecture.Tests` only covers part of this, so the review is the check.

**Data access and caching.** Repositories in `IssueTracker.PlugIns/DataAccess` own every application-data query; the
one other MongoDB call is the ping in `Helpers/MongoHealthCheck.cs`. A write path added or changed in a service must
remove every `IMemoryCache` entry it affects, including per-user keys such as `GetIssuesByUser`'s; several existing
write paths don't yet (#149). Flag a new query that loads a whole collection where a filter would do.

**Models.** A change to a CoreBusiness model (`IssueModel`, `CommentModel`, ...) changes stored documents. Check that the
matching `Basic*Model`, the Bogus fakes in `BogusFakes/`, and the repositories that project it still agree.

**Security.** Protected pages need `@attribute [Authorize]`, with `Policy = "Admin"` for admin pages.
`<AuthorizeView>` isn't a security boundary. Redirect targets must be root-relative paths, never scheme-relative
(`//host`) or absolute URLs. Flag secrets in code or `appsettings*.json`; configuration comes from user secrets and
environment variables.

**Tests.** Every new or changed behaviour has a test in the matching project, with `// Arrange`, `// Act` and
`// Assert` markers. Component tests derive from bUnit's `BunitContext`, not the obsolete `TestContext`. Repository changes
need an integration test in `IssueTracker.PlugIns.Tests.Integration`.

**Build.** Builds run with `-warnaserror`. Flag a new `NoWarn` or `#pragma warning disable` without a comment saying why
and when it goes away, and a `Version` on a `PackageReference` (Central Package Management owns versions).

**Markdown.** Lines outside tables stay within 200 characters, and each file starts with one H1. CI's markdownlint
enforces this and the other rules in `.markdownlint-cli2.jsonc`, except in the paths it ignores, such as the generated
posts in `docs/blogs/`.

**Workflows and hooks.** Actions are pinned immutably: a commit SHA with the version in a comment, a Docker image
digest, or, for an action with no releases, a commit SHA with its source ref and date. Steps that publish anything
(open a PR, push, tag, release) run only for `main`: a `github.ref == 'refs/heads/main'` check, or a merged-into-`main`
condition as in `release.yml`. Pull request runs check out a detached merge commit, and fork PRs get a read-only token.
`Build Solution` and `Test Suite` in `ci.yml` are required status checks on `main`, so they must run on every pull request.

## Out of scope

Leave compiler errors to the build. Spend comments on behaviour, boundaries, tests and intent.
