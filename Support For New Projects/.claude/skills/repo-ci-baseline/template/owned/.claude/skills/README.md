# Repo skills

Claude Code loads each folder here as a skill for this repo: `<name>/SKILL.md`, with `name` and `description` front
matter.

Put a skill here only when it's about this repo: its architecture, its review standards, its release quirks. Skills that
apply to every repo, such as `repo-ci-baseline`, live in the personal `~/.claude/skills/` instead, so there's one copy
to keep current.

`pre-push-review` and `hardening-review` are the exception: the Baseline's Owned review skills, which Apply keeps current in a repo with Sandcastle.
Don't edit them here (the next Apply reverts them); the repo's own skills, such as `code-review`, go beside them.

A `gh` command in a skill must be told its repository on its own line, and the gate's `check_gh_repo.py` checks it. The
line must be copy-pasteable, so a placeholder such as `--repo <owner>/<repo>` is refused: write the real `owner/repo`.
