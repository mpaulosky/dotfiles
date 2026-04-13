# dotfiles

Configuration and support files for quickly bootstrapping .NET projects and developer environments.

> **Purpose:** This repository is a **template and support-file library** — it holds
> reusable configurations, starter projects, shell profiles, CI workflows, and
> documentation templates that can be quickly copied into new repositories.

---

## Repository Structure

```text
BaseNewProject/          Starter template for new .NET Blazor projects
  docs/                  Project-specific docs (PRDs, specs)
Bashrc/                  Linux shell profile templates (.bashrc, .profile)
PowerShell 7/            PowerShell profile template
Posh-Git Themes/         Posh-Git theme files for PowerShell prompt
docs/                    Documentation templates (CONTRIBUTING, SECURITY, etc.)
.devcontainer/           Dev Container definition (.NET 10)
.github/
  instructions/          Copilot instruction files (Blazor, MongoDB DBA)
  workflows/             CI workflows (Squad automation, linting)
  agents/                GitHub Copilot agent definitions
.copilot/                Copilot CLI configuration and skills
.squad/                  Squad AI team orchestration
```

## Quick Start

### Using a Starter Template

1. Copy the `BaseNewProject/` folder into your new repository
2. Copy relevant files from `docs/` for project documentation
3. Copy `.github/instructions/copilot-instructions.md` for Copilot guidance
4. Adjust to your project's specifics

### Shell Profiles

- **Bash:** Copy files from `Bashrc/` to your home directory
- **PowerShell:** Copy the profile from `PowerShell 7/` to your PowerShell profile path
- **Posh-Git:** Copy theme files from `Posh-Git Themes/`

### Dev Container

The `.devcontainer/` folder provides a ready-to-use development container targeting
**.NET 10** with Aspire support. Copy it to your project for consistent dev environments.

### Copilot Instructions

Files in `.github/instructions/` are reusable Copilot instruction templates:

| File | Purpose |
|------|---------|
| `copilot-instructions.md` | .NET project coding standards (C# 14, Blazor, MongoDB, testing) |
| `blazor-web-app.instructions.md` | Blazor component and application patterns |
| `mongodb-dba.agent.md` | MongoDB DBA chat mode instructions |

## Documentation Templates

The `docs/` folder contains **template documentation** meant to be copied into other projects:

- `CONTRIBUTING.md` — contribution guidelines template
- `SECURITY.md` — security policy template
- `REFERENCES.md` — project references template
- `CODE_OF_CONDUCT.md` — code of conduct template

> **Note:** These are templates — do not modify them for this repository specifically.

## Squad AI Team

This repository uses [Squad](https://github.com/bradygaster/squad-cli) for AI-assisted
development orchestration. See `.squad/team.md` for the current team roster.

## License

See [LICENSE](LICENSE) for details.
