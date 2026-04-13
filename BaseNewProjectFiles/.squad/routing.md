# Squad Routing

## Signal → Agent

| Signal                                                                                                                                                          | Agent                      | Notes                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------- |
| /plan, plan mode, [[PLAN]]                                                                                                                                      | Aragorn                    | Lead runs Plan Ceremony after plan.md is approved |
| Architecture, scope, decisions, code review, PR review                                                                                                          | Aragorn                    | Lead                                              |
| Blazor, Razor, UI, frontend, components, CSS                                                                                                                    | Legolas                    | Frontend                                          |
| {ComponentName}, {FeatureName}Modal, {Feature}Panel, {Feature}Table components                                                                               | Legolas                    | Frontend — admin UI components                    |
| {Feature}Input component, filter chips, autocomplete, multi-value input                                                                                        | Legolas                    | Frontend — input components                       |
| MongoDB, repositories, API endpoints, backend services, MediatR handlers                                                                                        | Sam                        | Backend                                           |
| Admin management, {Feature}Service, external API integration, admin roles, /admin/*                                                                             | Sam                        | Backend — admin CQRS handlers                     |
| {Feature} filtering, Add{Feature}Command, Remove{Feature}Command, I{Feature}Service                                                                            | Sam                        | Backend — CQRS + service                          |
| Unit tests, bUnit, MongoDB integration tests, test quality review                                                                                               | Gimli                      | Tester                                            |
| Playwright E2E tests, Aspire integration tests, test infrastructure                                                                                             | Pippin                     | Tester (E2E)                                      |
| CI/CD, GitHub Actions, NuGet, deployment, Aspire infra, protected branch                                                                                        | Boromir                    | DevOps                                            |
| Docs, README, XML docs, comments, CONTRIBUTING                                                                                                                  | Frodo                      | Docs                                              |
| Blog posts, GitHub Pages, project announcements, changelog posts, feature write-ups                                                                             | Bilbo                      | Tech Blogger                                      |
| Auth0, authentication, authorization, JWT, RBAC, security audit, vulnerabilities, injection, XSS, CSRF, secrets, HTTPS, CORS, security headers, security review | Gandalf                    | Security                                          |
| Auth0 Management API, management client, ManagementApiClient                                                                                                    | Gandalf                    | Security review of management API usage           |
| admin role assignment, role revocation, user role management                                                                                                    | Gandalf                    | Auth security — admin operations                  |
| ResultErrorCode.ExternalService, external API failures                                                                                                          | Gandalf + Sam              | Auth error wrapping patterns                      |
| GitHub board, issues, PRs, backlog, work queue                                                                                                                  | Ralph                      | Work Monitor                                      |
| Session log, orchestration log, history summarization, decisions archival, memory sweep                                                                         | Scribe                     | Memory management                                 |
| PR with reviewDecision: CHANGES_REQUESTED                                                                                                                       | Aragorn                    | Lead routes fix to non-author agent               |
| PR with mergeable: CONFLICTED                                                                                                                                   | Aragorn                    | Lead determines resolver by file domain           |
| PR with statusCheckRollup: FAILURE                                                                                                                              | Boromir + author agent     | CI failure: Boromir diagnoses, author fixes       |
| PR ready for review (CI green, no conflicts)                                                                                                                    | Aragorn + domain reviewers | Spawn per files-changed table in ceremonies.md    |
| Untriaged issues (squad label, no squad:* sub-label)                                                                                                            | Aragorn                    | Lead triages                                      |
| squad:aragorn                                                                                                                                                   | Aragorn                    | —                                                 |
| squad:legolas                                                                                                                                                   | Legolas                    | —                                                 |
| squad:sam                                                                                                                                                       | Sam                        | —                                                 |
| squad:gimli                                                                                                                                                     | Gimli                      | —                                                 |
| squad:pippin                                                                                                                                                    | Pippin                     | —                                                 |
| squad:boromir                                                                                                                                                   | Boromir                    | —                                                 |
| squad:frodo                                                                                                                                                     | Frodo                      | —                                                 |
| squad:bilbo                                                                                                                                                     | Bilbo                      | —                                                 |
| squad:gandalf                                                                                                                                                   | Gandalf                    | —                                                 |
| squad:copilot                                                                                                                                                   | @copilot                   | Auto-assign: false                                |

## Branching Policy

- Squad work branches: `squad/{issue-number}-{slug}` — exempt from Protected Branch Guard
- NEVER commit `.squad/` files on `feature/*` branches — guard will block the PR
- Scribe commits `.squad/` changes on `squad/*` branches only

## Playbook-Aware Routing

Before spawning any agent, check playbooks and skills for relevant procedures:

### Playbooks (step-by-step execution)

- Any push/commit work → `.squad/playbooks/pre-push-process.md`
- PR ready for merge → `.squad/playbooks/pr-merge-process.md`
- Release preparation → `.squad/playbooks/release-process.md`

### Skills (knowledge / troubleshooting)

- Pre-push gate details → `.copilot/skills/pre-push-test-gate/SKILL.md`
- Build/test failure → `.github/prompts/build-repair.prompt.md`
- PR review protocol → `.copilot/skills/reviewer-protocol/SKILL.md`
- Merged PR guard → `.copilot/skills/merged-pr-guard/SKILL.md`
- Git workflow/branching → `.copilot/skills/git-workflow/SKILL.md`

> ⚠️ Skills prefixed with "Squad CLI Only" (`squad-conventions`, `ci-validation-gates`, `release-process`) are for the Squad npm package, NOT {ProjectName}.
