# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

# CONTEXT

## The issue

Issue #{{TASK_ID}}: {{ISSUE_TITLE}}

<issue>

{{ISSUE_BODY}}

</issue>

Comments on the issue from the repository owner:

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

## Branch diff

!`git diff {{BASE_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{BASE_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, null-forgiving operators, or unchecked assumptions?
   - Does it follow the red → green history the issue asks for, with tests covering every new or changed behaviour?
   - Do the acceptance tests cover every acceptance criterion in the issue that can be tested automatically? The tester committed them red first. Name any criterion no test
     checks. A criterion that can't be tested automatically, such as one about docs or a manual step, needs no test: check it against the change directly.
   - Did the developers weaken the tester's tests to make them pass? Compare each acceptance test with the tester's commit: look for removed or loosened assertions, tests that
     were skipped, commented out or deleted, and expected values changed to match the code.
   - When `.sandcastle/work/{{TASK_ID}}/design.md` exists, was the architect's design note followed? Where the code departs from it, is the difference explained in a commit
     body? Name any unexplained difference in your final message rather than change the code to match the note.
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the rules below and `.sandcastle/CODING_STANDARDS.md`

6. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# EXECUTION

A missing acceptance test, or one that was weakened, is the one exception to preserving functionality: add the missing test for a criterion that can be tested automatically, or
restore what the tester's test checked, and commit it with `test(<scope>): <Summary>`. If the code then fails the test, don't change the test to match it. Say in the commit body what fails.

If you find improvements to make:

1. Make the changes directly on this branch
2. Commit using `refactor(<scope>): <Summary>`
3. Run `scripts/gate.sh` as your last step and confirm it passes

If the code is already clean and well-structured, change nothing.

Either way, write the PR description last, once the branch is final, to `.sandcastle/work/{{TASK_ID}}/pr-body.md`, creating the folder. It's gitignored, so don't commit it:
the host reads it after your run and publishes it as the PR's body, under its own marker and `Closes #{{TASK_ID}}`. The description is published word for word as the squash
commit's message, the Release's notes and the release blog post, so follow `docs/PROCESS.md` and write it for a reader who wasn't there, in plain
sentences. Use exactly these three headings, in this order, and no others at that level:

```markdown
## Why

## What changed

## Verification
```

- **Why**: the problem the issue describes and who it affects, in a few sentences.
- **What changed**: what the branch does, as a short list a reader can check against the diff. Name any departure from the design note.
- **Verification**: the tests added or changed, by file and what they pin, and the gate checkpoints the branch passed. Claim only checks this run made or the commits record:
  never a manual test, a real-sandbox run or a CI result nobody ran.

Don't name another issue with a closing keyword (`Fixes #12`), @mention anyone, or write `<!--`: GitHub would close the issue or notify the person when the PR merges, and
the host would read a marker. A body with any of them isn't published, and the PR gets a generic one instead. Refer to another issue without a keyword ("see #12").

Don't add `Closes`, `Fixes`, a marker or a sign-off line: the host adds what it needs. Never put a secret, a token or a credential in it. When the file is missing, lacks a heading
or looks like it holds a secret, the host publishes a generic body instead.

Once the description is written, output <promise>COMPLETE</promise>.

# RULES

{{SHARED_RULES}}
