# Security Policy

## Supported Versions

dotfiles has no releases. Only `main` is maintained, and a fix lands there as a normal change.
The Template under `Support For New Projects/.claude/skills/repo-ci-baseline/` is copied into other repositories, so a fix to it reaches them when they Apply it again.

## Reporting a Vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/mpaulosky/dotfiles/security/advisories/new).
If that isn't available, email <matthew.paulosky@outlook.com> with the subject `[SECURITY] dotfiles`.

Please include:

1. A description of the vulnerability and its impact
2. Steps to reproduce it
3. The affected commit
4. A suggested fix, if you have one

## What to Expect

- An acknowledgement within 7 days.
- An assessment, and a plan for a fix if one is needed, once the report is confirmed.
- Credit in the published advisory, unless you prefer to stay anonymous.

Please keep the details private until a fix has been merged.
Fixed vulnerabilities are published in the repository's
[security advisories](https://github.com/mpaulosky/dotfiles/security/advisories).

## Accepted security findings from the local review

The pre-push review ([ADR 0008](<../Support For New Projects/.claude/skills/repo-ci-baseline/docs/adr/0008-review-before-the-push.md>))
never lists an accepted security finding in a public PR description: the notes only count them.
The person who accepted one keeps its reason in the review's ledger under `.git/review` on their own machine, which is not shared,
so they put the reason into a private report, as above, before pushing the branch.

## Contributors

- Never commit secrets, API keys or passwords; keep them in untracked local configuration and in repository or environment secrets for CI.
- Keep dependencies current, act on Dependabot security alerts, and check for known vulnerabilities with the ecosystem's audit tool before merging a dependency change.
