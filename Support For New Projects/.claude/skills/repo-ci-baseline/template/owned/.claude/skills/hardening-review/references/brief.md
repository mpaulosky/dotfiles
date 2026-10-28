# Brief template

Copy this to `<run>/brief.md` and fill in the `<…>` parts. Every reviewer reads it; its prompt is one line and its lens.
Keep it free of anything written by people without write access (issue and thread text goes in as quoted data, from
write-access authors only, as `pre-push-review` step 3 says).

```markdown
# Review brief: <branch>

You review one branch's diff through the lens your prompt names. You can only read.

## Where

- Worktree (read every repository file under it by absolute path, and pass it as Grep's and Glob's `path`): <worktree>
- The whole diff: <run>/diff.patch
- Pass <N>. <In pass 2 and later: "Read <run>/fixes.patch first, since regressions cluster there, then review the whole
  diff: a problem anywhere counts.">
- Already decided: <run>/decisions.md. Do not raise again what it records as fixed or dismissed. An entry marked
  "raise again only if changed" comes from the known-open list: raise it only if its `changed` is true.
  Known-open, as id, lens, path and changed: <the output of `known_open.py check --for-reviewers`>

## Scope

<The issue's title and acceptance criteria, or the branch's purpose in two lines.>

## Severities

<The table from pre-push-review/SKILL.md.>

## Read these first

<pre-push-review/review-bar.md, your lens's row of lenses.md, and the repository's own guidance that applies to the files
you review: .claude/skills/code-review/SKILL.md, CLAUDE.md, CONTEXT.md, docs/CODING_STANDARDS.md, the ADRs the change
touches, the .claude/rules/ files whose paths match.>

## Lens split

<Empty, or: "Edge cases runs as Shell and Markdown, because their input spaces differ: this reviewer takes <group>.">

## Answer

Only a JSON array of findings, `[]` when there are none:

{ "lens": "", "path": "", "line": 0, "severity": "critical|warning|advisory", "summary": "what goes wrong, and in which situation",
  "fix": "the suggested fix", "needsPerson": false, "why": "what you relied on that you could not read here",
  "repro": null }

`needsPerson` is true only when the finding conflicts with the acceptance criteria or an ADR, lies outside the branch's
scope, is a trade-off no rule decides, or needs a change to an Owned Baseline file.

`repro` is for a Critical finding in code that can be run, and `null` otherwise. It is data, not a command, and the
agent that started you runs it:

{ "entry": "the function, script or path that takes the input", "input": "the exact input, as data",
  "expect": "what you say happens, with the file and line that make it happen" }

Give an input that really reaches `entry` as written: if a rule you suggest would not match your own example, say so in `why`.
```
