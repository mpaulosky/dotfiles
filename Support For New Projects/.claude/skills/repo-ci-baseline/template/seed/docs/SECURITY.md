# Security Policy

## Supported Versions

{{REPO}} releases from `main`, and only the latest release receives security fixes.
A fix ships as a new release; earlier releases are not patched.

## Reporting a Vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/{{OWNER}}/{{REPO}}/security/advisories/new).
If that isn't available, email <matthew.paulosky@outlook.com> with the subject `[SECURITY] {{REPO}}`.

Please include:

1. A description of the vulnerability and its impact
2. Steps to reproduce it
3. The affected release or commit
4. A suggested fix, if you have one

## What to Expect

- An acknowledgement within 7 days.
- An assessment, and a plan for a fix if one is needed, once the report is confirmed.
- Credit in the published advisory, unless you prefer to stay anonymous.

Please keep the details private until a fix has been released.
Fixed vulnerabilities are published in the repository's
[security advisories](https://github.com/{{OWNER}}/{{REPO}}/security/advisories) and in the release notes.

## Contributors

- Never commit secrets, API keys or passwords; use user secrets locally and repository or environment secrets in CI.
- Dependabot keeps dependencies current; `dotnet list package --vulnerable` checks for known vulnerabilities locally.
