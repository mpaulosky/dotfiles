# CONTEXT

A planner has picked the issues below to build in parallel this round, each on its own branch from `main`.

The picked issues. Each one's `files` lists the paths the planner expects it to change. The host has already held back every pick whose `files` share a path with another pick's
or with any open pull request's, so no two picks below name the same file:

<picked-json>

{{PICKED_JSON}}

</picked-json>

The in-flight issues. Each one already has an open pull request waiting for review; `files` lists the paths that PR changes:

<in-flight-json>

{{IN_FLIGHT_JSON}}

</in-flight-json>

The ready issues the planner didn't pick this round. One with a `heldNote` was held back by the host, for a reason the note doesn't give.
It won't be built this round, but it's still an open issue, so count it in the dependency check below like any other unpicked ready issue:

<unpicked-json>

{{UNPICKED_JSON}}

</unpicked-json>

The repository is checked out in your working directory at `main`. Read it to see which files and modules each issue would change.

# TASK

Check whether the picked issues are safe to build in parallel. Check only these two things:

1. **Overlap.** A pick would change the same files or modules as another pick, or as an in-flight issue's pull request, so the branches would likely conflict. The shared file
   paths in `files` were already held back, so look for what that check can't see: the same module or code reached through different files, or a file the planner likely
   missed.
2. **Dependency.** A pick needs an API, a type, a file or a decision that another open issue (a pick, an in-flight issue or an unpicked ready issue) will establish, so building it now
   would mean guessing at that work.

Don't judge anything else: not whether an issue is well written, too big, worth doing, or ordered well. Those aren't your concern.

Your only power is to **defer** a pick. A deferred pick waits until the issue it's deferred behind lands. You can't add, reorder, merge or rewrite issues.

When two picks overlap, keep one and defer the other behind it. Prefer to keep the pick the other depends on, and otherwise the smaller one. Never defer both picks of a pair behind each
other. When a pick overlaps an in-flight issue, defer it behind that in-flight issue. When in doubt, keep the pick: a needless deferral costs a round, and the pre-push gate still
catches a real conflict.

# OUTPUT

Give one verdict per picked issue, as a JSON object wrapped in `<critique>` tags:

<critique>
{"verdicts": [{"id": "42", "verdict": "keep", "reason": "Only it touches claude-review.yml."}, {"id": "43", "verdict": "defer", "blockedBy": "42", "reason": "Both change pr-automerge.yml."}]}
</critique>

- `id` is the picked issue's number, as a string.
- `verdict` is `keep` or `defer`.
- `blockedBy` is required for `defer` and left out for `keep`. It is the number, as a string, of the open issue the pick must wait for. Name an issue, never a pull request: for an in-flight
  issue, use its `number`, not its `pr`.
- `reason` is one or two sentences naming the overlapping files or modules, or the API or decision the pick depends on. The host posts it on the deferred issue, so write it for the
  person who reads it there.

Always emit the `<critique>` tags.
