# Git Commit Instructions

This document defines the required conventions and best practices for writing Git commit messages.

## Commit Message Format

All commit messages **must** follow this structure:

```
<type>(<scope>): <short summary>

<body>
```

### Types

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation only changes
- **style**: Changes that do not affect the meaning of the code (white-space, formatting, etc.)
- **refactor**: A code change that neither fixes a bug nor adds a feature
- **perf**: A code change that improves performance
- **test**: Adding or correcting tests
- **build**: Changes that affect the build system or external dependencies
- **ci**: Changes to CI configuration files and scripts
- **chore**: Other changes that don't modify src or test files
- **revert**: Reverts a previous commit

### Scope

The scope should be the name of the affected project, folder, or feature (e.g., `Web`, `Mongo`, `ServiceDefaults`,
`docs`).

### Short Summary

- Use the imperative mood ("Add," "Fix,", "Update," not "Added," "Fixed," "Updated").
- Limit to 72 characters or fewer.
- Capitalize the first letter.
- Do not end with a period.

### Body (optional)

- Use to explain **what** and **why** vs. **how**.
- Wrap lines at 72 characters.
- Reference issues using `Fixes #123` or `Refs #456`.

## Examples

```
feat(Web): add user authentication with Auth0

Implements login and logout functionality using Auth0.
Updates navigation bar to show user info when authenticated.
Fixes #42
```

```
fix(Mongo): handle null reference in BlogRepository

Adds null checks to prevent exceptions when querying missing documents.
```

```
docs(CONTRIBUTING): update testing section for Playwright

Adds Playwright usage instructions and links to documentation.
```

## Additional ObjectIdelines

- Group related changes in a single commit.
- Separate unrelated changes into different commits.
- Use English for all commit messages.
- Reference issues and pull requests when relevant.