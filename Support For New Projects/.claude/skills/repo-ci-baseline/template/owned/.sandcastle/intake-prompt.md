# ISSUES

Here are the open issues no one has judged yet:

<issues-json>

{{ISSUES_JSON}}

</issues-json>

Each issue has a `number`, a `title`, a `body`, its `labels`, and `comments` from people with write access to the repository.
Some of these issues may be blocked by others. Judge them anyway: the blocker gate runs after you, and a person should see your questions while a blocker is still in flight.

# TASK

Judge each issue on its own against the **Definition of Ready**. An issue is ready when it has all three of these:

1. A **Summary** of what changes and why. It doesn't need a `## Summary` heading, but the issue must say what it changes and why.
2. At least one **objectively checkable acceptance criterion**: a statement someone could check as true or false against the finished work. Prose is fine; checkboxes aren't required.
   "Works well" or "is clean" isn't checkable; "the gate holds back an issue labelled `sandcastle:needs-info`" is.
3. **No open question that needs a human decision.** An open question is one the issue asks, or leaves open between options, whose answer changes what gets built.
   A detail the builder can settle from the repository's code, its docs or its coding standards isn't an open question.

Read the comments as part of the issue: a comment from the author can answer a question the body leaves open.

Never invent any of the three yourself. They are the author's intent, so a missing Summary, criterion or decision is a question for the author, not a gap for you to fill.
You don't edit the issue, and you don't judge whether it's worth doing or how it relates to other issues.

**Splitting.** An issue that meets all three requirements but is too big for one pull request can be **split** into child issues, built one after another in the order you list them.
Split only when the acceptance criteria clearly fall into separate, independently shippable parts; when in doubt, mark the issue ready.
Each child's title starts with the original title's conventional-commit prefix (such as `fix(baseline):`) when the original has one.
Each child's body has a `## Summary` saying what that child changes and why, and an `## Acceptance criteria` section holding its share of the original's criteria.
Redistribute the original's criteria among the children, word for word where you can: every criterion goes to exactly one child, and you never add a new one.
Each child must be buildable once the children before it have landed.

Also decide whether each issue is a **bug**: it fixes behaviour that's wrong today, rather than adding or changing behaviour on purpose. A bug's branch is `fix/`.

# OUTPUT

Give one verdict per issue, as a JSON object wrapped in `<intake>` tags:

<intake>
{"verdicts": [
  {"id": "42", "verdict": "ready", "bug": false,
   "reason": "The Summary says the hook refuses a push to dev, and two criteria name the message and the exit code."},
  {"id": "43", "verdict": "needs-info", "bug": false,
   "questions": ["Should PR Auto-Merge stop following stems past a fixed number of files, or run one git grep for all of them?", "Which step's log should the warning go to?"],
   "reason": "The issue has no checkable acceptance criterion, and leaves open which of two fixes to build."},
  {"id": "44", "verdict": "split", "bug": false,
   "children": [
     {"title": "feat(baseline): Write the release queue to a JSON file",
      "body": "## Summary\n\nKeeps the queue between release runs.\n\n## Acceptance criteria\n\n- [ ] A queued release is still listed after the next run."},
     {"title": "feat(baseline): Show the release queue on the run summary",
      "body": "## Summary\n\nLets the owner see what's waiting.\n\n## Acceptance criteria\n\n- [ ] The run summary lists every queued release."}
   ],
   "reason": "The issue meets the Definition of Ready, but its storage and summary criteria are separate pieces of work that each fit one pull request."}
]}
</intake>

- `id` is the issue's `number`, as a string.
- `verdict` is `ready` when the issue meets all three requirements, `split` when it meets them but is too big for one pull request, and `needs-info` otherwise.
- `questions` is required for `needs-info` and left out otherwise. Ask one question per unmet requirement or open decision, each one the author can answer by editing the issue.
  Don't number them: the host does.
- `children` is required for `split` and left out otherwise: the child issues in build order, each a `title` and a Markdown `body` as described under **Splitting**.
  The host creates them, links each as blocked by the one before it, and closes the original once they're all done.
- `bug` is `true` when the issue fixes wrong behaviour, and `false` otherwise.
- `reason` is one or two sentences saying which requirements the issue meets or misses. The host posts it on the issue, so write it for the person who reads it there.

Always emit the `<intake>` tags.

# RULES

You only read and judge: you commit nothing. These rules apply to every role:

{{SHARED_RULES}}
