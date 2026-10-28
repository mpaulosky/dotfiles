# CLAUDE.md

dotfiles holds the owner's machine configuration (`Bashrc/`, `PowerShell 7/`, `systemd/` and the rest) and the skills under
`Support For New Projects/.claude/skills/`. The main one is `repo-ci-baseline`: its Template is the CI, release and git-hook Baseline every
other repo copies (see its `SKILL.md` and `CONTEXT.md`).

## Layout

- `Support For New Projects/.claude/skills/repo-ci-baseline/`: the skill. `template/owned/` and `template/seed/` hold the Template's files,
  `references/` and `docs/adr/` describe them, and `test.sh` tests all of it.
- `.github/workflows/claude-review.yml`, `pr-automerge.yml`, `pr-review-submitted.yml`, `sandcastle.yml`, `.github/scripts/post_claude_review.py`, `.github/hooks/*`,
  `scripts/check-branch-name.sh`, `scripts/review.sh`, the pre-push review's skills and agent (`.claude/skills/pre-push-review/`, `.claude/skills/hardening-review/`,
  `.claude/agents/pre-push-reviewer.md`) and the Owned files under `.sandcastle/` (`main.mts`, every `lib/` module but `repo-config.mts`, and their tests):
  copies of the Template's Owned files. Edit the Template's file and copy it over; `test.sh` fails when a copy drifts.
- `scripts/gate.sh` and `.github/workflows/repo-ci-baseline.yml` are dotfiles' own, and so is `.github/ci/sandcastle-skills.txt`, the Seed list of skills `sandcastle.yml` installs (empty here).
- `.sandcastle/`: the unattended agent pipeline (TypeScript, run with Claude Code), ported from Blazor-Server's. Its rules are in
  `.claude/rules/sandcastle.md`.

## Commands

The repo uses pnpm (pinned by `packageManager` in `package.json`); npm is refused. Run `pnpm install` after changing `package.json`, and
commit `pnpm-lock.yaml` with the change.

```bash
pnpm install                                   # Sandcastle's packages
scripts/gate.sh                                # the full check: the local review's record, test.sh, then the Sandcastle check when its files changed
GATE_SKIP_REVIEW=1 scripts/gate.sh              # the same without the review check, while iterating; never for a push
scripts/review.sh report                        # the local review (/pre-push-review) of this branch's diff
pnpm run check:sandcastle                      # type-check and test .sandcastle/
SANDCASTLE_ISSUE=<n> pnpm run sandcastle       # build one issue (and its PR) locally
SANDCASTLE_LABEL=<label> pnpm run sandcastle   # work the issues labelled <label>
```

## Which Sandcastle label

The Sandcastle workflow in GitHub Actions works the issues labelled `Sandcastle`. Its token has no Workflows permission, so GitHub
refuses its push of any change under `.github/workflows/`. Here that's most changes to Claude Review, PR Auto-Merge or the Sandcastle
workflow itself, since dotfiles' copies of those Template files must match. Label such an issue `Sandcastle:local` instead: Actions never builds it, and
`SANDCASTLE_LABEL=Sandcastle:local pnpm run sandcastle` builds it from the main checkout, pushing with your own `gh` login. Its PR's
follow-up passes then run locally too. When GitHub refuses Actions' push of a new branch for a workflow change main made after the
build started, Sandcastle moves the issue to `Sandcastle:local` itself, with a comment saying why.

## Git workflow

Branches are `feature/{issue}-{slug}`, `fix/{issue}-{slug}`, `hotfix/{issue}-{slug}` or `chore/{slug}` (`scripts/check-branch-name.sh`).
Commit subjects are `<type>(<scope>): <Summary>`, with the scope `baseline` for the Template.

Don't start work on an issue labelled `sandcastle:building`: a Sandcastle run is building it. Claude reviews a PR only when it has the
`review:claude` label, and its review counts only where Copilot can't review the head: it posted its quota note, or its request was dropped
and no review or request is pending. PR Auto-Merge and `land.sh` add the label then, so don't add it yourself, except where the Template's
[`PROCESS.md`](<Support For New Projects/.claude/skills/repo-ci-baseline/template/owned/docs/PROCESS.md>) says to (its "A ready PR is kept up to date" bullet,
for a merge of `main` that waits for a new review).
