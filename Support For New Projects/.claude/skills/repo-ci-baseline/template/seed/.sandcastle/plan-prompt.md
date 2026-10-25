# ISSUES

Here are the open issues in the repo:

<issues-json>

{{ISSUES_JSON}}

</issues-json>

The list above has already been filtered to issues ready for work.
Issues with an explicit blocker (a GitHub "blocked by" link, or a "Blocked by #N" or "Depends on #N" line) whose work hasn't landed on main were removed before you saw the list.
So don't hold an issue back only because its body mentions an issue that isn't in the list: that issue is either finished or outside this backlog.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

# ROLES

The tester, the developer and the reviewer build every issue. For each issue you pick, also choose which optional roles it needs, in a `roles` list. Pick a role only
when the issue needs it: each one costs a run.

- `architect`: the issue needs a design before the tests are written. Pick it when the issue adds a new type, module or public API whose shape the issue leaves open, touches
  several scripts or workflows that must agree, or makes a decision that would be hard to reverse. Leave it out for a fix or a change whose shape the issue already spells out.
- `scribe`: the issue adds or changes a domain term in `CONTEXT.md`, or changes what `README.md`, `CLAUDE.md` or a page under `docs/` describes. Leave it out when the
  issue only changes code and its tests.

An empty list, `[]`, means the issue needs none of them. If you leave `roles` out, every optional role runs.

# FILES

For each issue you pick, also list in `files` the repo-relative path of every file the issue will add, change, delete or rename (both names for a rename). Find them by reading
the repo, not by guessing from the title. Give paths only: no globs and no directories, unless the issue adds files under a new directory, in which case name the directory, which
covers every path under it.

This list matters. Sandcastle won't build two picks that name the same file in one round, or a pick that names a file an open pull request changes, and it builds a pick with no
`files` only when no pull request is open and it's the only pick it builds that round. A file you leave out risks a merge conflict; a file you list needlessly holds the
pick back a round.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [
  {"id": "42", "title": "Refuse an order with no lines", "roles": [], "files": ["src/Api/Orders/OrderValidator.cs", "tests/Api.Tests/Orders/OrderValidatorTests.cs"]},
  {"id": "43", "title": "Add an order history page", "roles": ["architect", "scribe"], "files": ["src/Web/Pages/OrderHistory.razor", "README.md"]}
]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.

# RULES

You only read and plan: you commit nothing. These rules apply to every role:

{{SHARED_RULES}}
