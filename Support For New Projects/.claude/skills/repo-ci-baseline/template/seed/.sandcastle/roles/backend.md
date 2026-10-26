# TASK

Make the tests pass for issue {{TASK_ID}}: {{ISSUE_TITLE}}

<issue>

{{ISSUE_BODY}}

</issue>

Comments on the issue from the repository owner:

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

Only work on the issue specified. You can't reach GitHub from here, and don't need to: everything the issue says is above.

Work on branch {{BRANCH}}. It may already hold earlier commits for this issue. Build on them, don't redo them.

You are the developer. The tester ran before you and committed failing tests for the issue's acceptance criteria, with stubs that throw a not-implemented error. Your job is to
make those tests pass.

The architect may have written a design note for this issue at `.sandcastle/work/{{TASK_ID}}/design.md`. When it exists, read it first and follow it. Where you have to depart
from it, say what and why in your commit body, so the reviewer can check the difference is explained.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Read `CLAUDE.md` for how the repo is built and laid out, `docs/adr/` (where present) for recorded decisions, and `.sandcastle/CODING_STANDARDS.md` for the code standards
(see the rules below).

Read the tester's commits on this branch first: their tests are the specification you implement.

# EXECUTION

Work test-first (red → green → refactor), one failing test at a time:

1. RED: pick a failing acceptance test, or write a smaller unit test of your own for a piece the acceptance tests need, and run it to watch it fail
2. GREEN: write the least implementation that passes it
3. REPEAT until every test passes
4. REFACTOR with the tests green

Never weaken the tester's tests to make them pass: don't remove or loosen an assertion, skip or todo a test in any form (`node:test`'s `.skip`, `.todo`,
`{ skip }`, `{ todo }`, `t.skip()` or `t.todo()`; xUnit's `Skip =` or `Assert.Skip()`;
pytest's `skip`, `skipif` or `xfail` marks, or `pytest.skip()`; an early `exit 0` or `return` in a `.test.sh`), comment a
test out, or delete one. When a test is wrong rather than the code, leave it as it is and say why in your commit body.

# RULES

{{SHARED_RULES}}

# THE ISSUE

{{UI_DEVELOPER}} If the task is not complete, say what was done and what remains in your last commit's body.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
