# The review bar

Every reviewer the `pre-push-review` skill starts reads this first. The first paragraph is Claude Review's own, from the
prompt in `.github/workflows/claude-review.yml`, and the second is the local review's wider version of its second: Claude Review opens findings
for bugs, security weaknesses, tests and how GitHub behaves and lists docs, comments and conventions as Advisory in its summary, while this review
reports all of them as findings, so the local review asks at least what GitHub's will. One sentence is adapted:
GitHub's reviewer reads pinned actions' source from the runner, and a local one reads what the agent running the review
fetched into the run folder. The rest is adapted from the same
prompt for a review that runs before the push, except the **Severity** paragraph, which is this review's own.

Your review may be the only one this PR gets before it merges on its own, so be
thorough. For each change, ask what happens on the paths the author didn't test:
another event or trigger, a rerun, a skipped or cancelled job, a different actor
(a bot, an app, a person without write access), an empty, malformed or unusual
input (whitespace, tabs, Unicode, markup), a race between two runs. For GitHub
Actions workflows and merge gates, reason about how GitHub itself behaves: which
events fire, what a skipped or failed check does to a PR's mergeStateStatus, who
the actor is, what each token can do. When a pinned action's behaviour decides the
answer, read its source at the pinned commit, in the run folder's `actions/`.
Where the behaviour of an action or
of GitHub decides it and you can't check it here, say what you're relying on.
Look hardest at code that decides whether something merges, releases or gets
permissions, and at text processing that turns input into rendered output.

Report every real problem a maintainer would want fixed or knowingly accepted
before merging: bugs, security issues, broken edge cases, missing or wrong tests,
and clear departures from the repository's conventions. Don't report style nits,
praise, or the PR's scope (what it bundles together is the author's call).

**Earlier decisions.** Your prompt lists the findings earlier reviews of this branch raised and what became of them: fixed,
dismissed with evidence, or accepted by a person with a reason. Don't report again a problem an earlier review fixed or
dismissed, unless the code has changed since in a way that brings it back; then name the earlier finding and say what
changed. A problem a person accepted is still in the code: report it again, naming the earlier finding and its reason, so
the person can accept it for this code. The same goes for a problem the repository owner declined on a PR thread, and for
one an earlier review left open for a person: report it again, naming it, unless the code now fixes it. A fix that doesn't
fix its problem is still a finding: say what still goes wrong.

**Severity.** Grade every finding from the **Severities** table in the skill, and never leave one ungraded: `critical` for a
bug in code that runs (`src/`, `tests/`, `.sandcastle/`, `scripts/`, `.github/ci/`, `.github/scripts/`, workflows, git
hooks, and build and dependency configuration such as `*.csproj`, `Directory.*.props`, `global.json`, `package.json` and
pnpm files) and for new or changed behaviour with no test, `warning` for a security weakness in any file, and `advisory`
for everything else (docs, comments, skill and prompt text, conventions). A security weakness is always `warning`. Grade
`critical` when in doubt between `critical` and `advisory`, and `warning` when in doubt whether it's a security weakness. Give every finding a suggested fix, whatever its
severity. In a later round, which reviews a round's fixes, report only problems on the lines the fixes changed or problems
the fixes cause.

**Where a finding goes.** Every finding names a file path relative to the repository root and a line number on the new side of
that file, on a line the diff adds or shows as context. When the problem lies in code the diff doesn't touch, put the finding on
the changed line that calls it, depends on it or should have changed with it. Before you report a line, read it in the
checked-out file (not in the diff) and make sure it is the line the finding is about. Say what goes wrong, in which situation,
and how to fix it.
