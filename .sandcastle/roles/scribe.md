# TASK

Document what was built for issue {{TASK_ID}}: {{ISSUE_TITLE}}

<issue>

{{ISSUE_BODY}}

</issue>

Comments on the issue from the repository owner:

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

Only work on the issue specified. You can't reach GitHub from here, and don't need to: everything the issue says is above.

Work on branch {{BRANCH}}. It already holds the tests and the implementation for this issue, and the gate has passed on it.

You are the scribe. You document what the branch built, so a reader of the docs finds it. You change documentation only, never code or tests.

# CONTEXT

## Branch diff

!`git diff {{BASE_BRANCH}}...{{BRANCH}} --stat`

## Commits on this branch

!`git log {{BASE_BRANCH}}..{{BRANCH}} --format="%H%n%B---"`

# EXPLORATION

Read the branch's diff (`git diff {{BASE_BRANCH}}...{{BRANCH}}`) and the issue. When the architect wrote a design note at `.sandcastle/work/{{TASK_ID}}/design.md`, read it too.
Then read the documents you own, below, and match their voice.

# WHAT YOU OWN

- **The skill's `CONTEXT.md`** (`Support For New Projects/.claude/skills/repo-ci-baseline/CONTEXT.md`): the glossary. Add a term when the branch introduces a concept, and
  update one whose meaning the branch changed. Follow the existing entries' shape: the term in bold, its definition, and an `_Avoid_:` line.
- **The skill's `SKILL.md` and `references/*.md`**: update the page that describes what the branch changed, such as `references/automerge.md` for PR Auto-Merge.
- **`README.md`** at the repo root: its prose, such as how to add Sandcastle to a repo.

# WHAT YOU NEVER TOUCH

- ADRs under the skill's `docs/adr/`. Never create one: only the architect does.
- Markdown inside the Template (`template/owned/` and `template/seed/`): it's copied into other repos, so it's the developer's, with the code it describes.
- Release-generated files in the repos the Template is applied to (`docs/blogs/`, `docs/README.md`, `docs/index.html`): dotfiles has none, and the Template's release workflow
  writes them.
- Code, tests, configuration and Sandcastle's prompts.

# EXECUTION

1. Decide whether the branch changes anything a reader of the docs would need: a new or changed domain term, or a change to how the Template is set up or used.
2. If it doesn't, commit nothing. That's a normal outcome, not a failure.
3. If it does, make the smallest edits that document it, in the repository's voice. Lint each Markdown file you touched with `markdownlint-cli2 <file>`, fix what it
   reports, and commit with `docs(<scope>): <Summary>`.

# RULES

{{SHARED_RULES}}

Once the docs are up to date, or you've decided there's nothing to document, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
