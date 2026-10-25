# TASK

Write the failing tests for issue {{TASK_ID}}: {{ISSUE_TITLE}}

<issue>

{{ISSUE_BODY}}

</issue>

Comments on the issue from the repository owner:

<issue-comments>

{{ISSUE_COMMENTS}}

</issue-comments>

Only work on the issue specified. You can't reach GitHub from here, and don't need to: everything the issue says is above.

Work on branch {{BRANCH}}. It may already hold earlier commits for this issue. Build on them, don't redo them.

You are the tester. The developer runs after you and makes your tests pass, so you write tests, not the implementation.

The architect may have written a design note for this issue at `.sandcastle/work/{{TASK_ID}}/design.md`. When it exists, read it first: write the tests against the types and
signatures it names, and put them where it says.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Read `CLAUDE.md` for how the repo is built and laid out, `docs/adr/` (where present) for recorded decisions, and `.sandcastle/CODING_STANDARDS.md` for the code standards
(see the rules below).

Pay extra attention to existing test files near the code the issue touches, and follow their layout and naming.

# EXECUTION

1. List the issue's acceptance criteria. Each one needs at least one test, and the name of each test should make it clear which criterion it checks.
2. Write the tests through the behaviour the issue describes, in the test project or file that already covers the code it touches (see the rules below): the project
   under `tests/` for the project under `src/`, and `<module>.test.mts` beside a Sandcastle module.
3. When a test calls something that doesn't exist yet, add the smallest stub that lets it load: for C#, `throw new NotImplementedException();`; for TypeScript,
   `throw new Error("Not implemented")`. Write no real behaviour. When the change is to existing behaviour, the test needs no stub: it fails against the
   current code.
4. Build what you changed and fix every error: `dotnet build` for C#, and `pnpm exec tsc --noEmit -p .sandcastle` for Sandcastle's TypeScript.
5. Run the tests you wrote with the stack's test command, and confirm each one fails for the reason you expect: an assertion failing or the stub throwing, not a syntax error, a
   missing fixture or a broken setup.
6. Lint the files you changed: `markdownlint-cli2 <file>` for Markdown, `shellcheck <file>` for shell, and `yamllint -c .yamllint.yml <file>` for YAML.
7. Commit the tests and stubs red, with `test(<scope>): <Summary>`. Say in the body which test covers which criterion.

When a criterion can't be tested automatically (for example, it's about docs or a manual step), don't write a test that doesn't check it. Name the criterion and why it can't be
tested in the commit body, or in your final message when you have nothing to commit.

On a re-run, the branch may already hold tests for some criteria. Keep them, and write tests only for the criteria nothing covers yet.

Don't run `scripts/gate.sh`: your tests are red on purpose, so it would fail.

# RULES

{{SHARED_RULES}}

Once every criterion that can be tested automatically has a committed test, output <promise>COMPLETE</promise>. That includes the case where you commit nothing, because earlier
commits already cover every criterion or none can be tested automatically.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
