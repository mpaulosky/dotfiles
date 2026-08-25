# Instructions For Setting Up a New Project

## 1. Create the Folder Structure

Create and enter the new project folder:

```bash
mkdir [ProjectName]
cd [ProjectName]
```

Create the project subfolders:

```bash
mkdir -p docs/blogs docs/plans src tests
```

Initialize the git repository:

```bash
git init
```

## 2. Copy Local Folders Into the Project

- [ ] `.aspire`
- [ ] `.copilot`
- [ ] `.github`
- [ ] Contents of the `docs` folder into the project's `docs` folder

## 3. Copy Files Into the Project Root

- [ ] `.editorconfig`
- [ ] `.gitignore`
- [ ] `.markdownlint-cli2.jsonc`
- [ ] `.markdownlint.json`
- [ ] `.yamllint.yml`
- [ ] `GitVersion.yml`
- [ ] `.directory`
- [ ] `global.json`
- [ ] `LICENSE`

## 4. Configure Git Hooks

Point git at the shared hooks so pre-commit, pre-push, and post-checkout enforcement works with your workflow:

```bash
git config core.hooksPath .github/hooks
```

## 5. Configure Auth0 for Web Projects

In the Web project's `Web.csproj` file, replace the `UserSecretsId` value with:

```xml
<UserSecretsId>94491f6e-auth0-values-3ff40da38702</UserSecretsId>
```
