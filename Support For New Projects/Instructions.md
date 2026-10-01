# Instructions For Setting Up a New Project

## 1. Create the Repository

```bash
mkdir [ProjectName]
cd [ProjectName]
mkdir -p docs/blogs docs/plans src tests
git init -b main
git remote add origin https://github.com/mpaulosky/[ProjectName].git
```

Add the solution file (`[ProjectName].slnx`) at the root before the next step, so `{{SOLUTION}}` gets filled in.

## 2. Apply the Baseline

The CI, release, hook and lint files come from the `repo-ci-baseline` skill's Template. On a repo with no commits,
`apply.sh` runs on `main`, and its output is the first commit:

```bash
"$HOME/github/dotfiles/Support For New Projects/.claude/skills/repo-ci-baseline/apply.sh" .
git add -A
git commit -m "chore: apply repo-ci-baseline Template"
```

It also runs `git config core.hooksPath .github/hooks`. Fill any placeholders the report lists, then work through the
skill's `references/adapt.md` for the GitHub settings: required checks, the `semver:minor` and `semver:major` labels,
and the `RELEASE_PR_PAT` secret.

## 3. Optional: App-Stack Starting Points

These aren't part of the Baseline. Copy the ones that fit, and rewrite them for the new project; they were written for
IssueTracker.

- [ ] `.aspire/` for an Aspire app
- [ ] `.github/instructions/blazor.instructions.md` for a Blazor UI
- [ ] `.github/instructions/dotnet-project.instructions.md`
- [ ] `.github/instructions/mongo-dba.instructions.md` for MongoDB
- [ ] `.github/skills/code-review/` (a repo skill; see `.claude/skills/README.md` in the new repo)
- [ ] `.github/agents/beast.agent.md`

## 4. Configure Auth0 for Web Projects

In the Web project's `Web.csproj` file, replace the `UserSecretsId` value with:

```xml
<UserSecretsId>94491f6e-auth0-values-3ff40da38702</UserSecretsId>
```
