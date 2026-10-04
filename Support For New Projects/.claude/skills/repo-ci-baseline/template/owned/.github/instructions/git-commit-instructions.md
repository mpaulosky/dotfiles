# Git Commit Instructions

This document defines the required conventions and best practices for writing Git commit messages.

## Commit Message Format

All commit messages **must** follow this structure:

```text
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

The scope should be the name of the affected project, folder, or feature (e.g., `Web`, `Data`, `Tests`, `ci`,
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

```text
feat(Web): Let users sort the list by date

Adds a Sort by date option above the list. The choice is kept in the
query string, so a shared link keeps the order.
Fixes #42
```

```text
fix(Data): Return an empty list when a record has no children

The query returned null for records without children, which the
details page then dereferenced.
```

```text
docs(CONTRIBUTING): Update testing section for Playwright

Adds Playwright usage instructions and links to documentation.
```

## Additional Guidelines

- Group related changes in a single commit.
- Separate unrelated changes into different commits.
- Use English for all commit messages.
- Reference issues and pull requests when relevant.
