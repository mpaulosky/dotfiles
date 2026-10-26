# Repo skills

Claude Code loads each folder here as a skill for this repo: `<name>/SKILL.md`, with `name` and `description` front
matter.

Put a skill here only when it's about this repo: its architecture, its review standards, its release quirks. Skills that
apply to every repo, such as `repo-ci-baseline`, live in the personal `~/.claude/skills/` instead, so there's one copy
to keep current.

`pre-push-review` is the exception: the Baseline's Owned review skill, which Apply keeps current in a repo with Sandcastle.
Don't edit it here (the next Apply reverts it); the repo's own skills, such as `code-review`, go beside it.
