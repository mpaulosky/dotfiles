# CLAUDE.md

dotfiles holds the owner's machine configuration (`Bashrc/`, `PowerShell 7/`, `systemd/` and the rest) and the skills under
`Support For New Projects/.claude/skills/`. The main one is `repo-ci-baseline`: its Template is the CI, release and git-hook Baseline every
other repo copies (see its `SKILL.md` and `CONTEXT.md`).

## Layout

- `Support For New Projects/.claude/skills/repo-ci-baseline/`: the skill. `template/owned/` and `template/seed/` hold the Template's files,
  `references/` and `docs/adr/` describe them, and `test.sh` tests all of it.
- `.github/workflows/claude-review.yml`, `pr-automerge.yml`, `.github/scripts/post_claude_review.py`, `.github/hooks/*` and
  `scripts/check-branch-name.sh`: copies of the Template's Owned files. Edit the Template's file and copy it over; `test.sh` fails when a copy
  drifts.
- `scripts/gate.sh` and `.github/workflows/repo-ci-baseline.yml` are dotfiles' own.
- `.sandcastle/`: the unattended agent pipeline (TypeScript, run with Claude Code), ported from Blazor-Server's. Its rules are in
  `.claude/rules/sandcastle.md`.

## Commands

The repo uses pnpm (pinned by `packageManager` in `package.json`); npm is refused. Run `pnpm install` after changing `package.json`, and
commit `pnpm-lock.yaml` with the change.

```bash
pnpm install                                   # Sandcastle's packages
scripts/gate.sh                                # the full check: test.sh, then the Sandcastle check when its files changed
pnpm run check:sandcastle                      # type-check and test .sandcastle/
SANDCASTLE_ISSUE=<n> pnpm run sandcastle       # build one issue (and its PR) locally
SANDCASTLE_LABEL=<label> pnpm run sandcastle   # work the issues labelled <label>
```

## Git workflow

Branches are `feature/{issue}-{slug}`, `fix/{issue}-{slug}`, `hotfix/{issue}-{slug}` or `chore/{slug}` (`scripts/check-branch-name.sh`).
Commit subjects are `<type>(<scope>): <Summary>`, with the scope `baseline` for the Template.

Don't start work on an issue labelled `sandcastle:building`: a Sandcastle run is building it. Claude reviews a PR only when it has the
`review:claude` label; add it to every PR you open.
