# Triage format

One batch is at most 6 findings, grouped by file or cause. Each is a question to the person, who answers them all in one
reply. Recommend an outcome for each; the person's answer is the outcome.

```text
❓ **F1** - **R17 Critical · Shell · scripts/review.sh:88 - <short title>**
<What goes wrong and in which situation, in two or three lines.>
Verified: confirmed (ran `<entry>` with `<input>`: <what it printed>) | unverifiable (<why>)
Options: (a) fix as suggested: <fix>   (b) fix another way: <how>   (c) accept   (d) defer   (e) dismiss, because <why>

➡️ <your recommended option and why>

Edge cases:
| Case | Test, or n/a and why |
| --- | --- |
| empty | `Review_EmptyNote_ReturnsError` |
| whitespace-only | … |
| Unicode / malformed / oversized / boundary / missing / duplicated | … |
```

- Refuted findings are not asked: they are dismissed with their evidence and listed in one line after the batch.
- A finding suppressed by the known-open list is not asked as a question, but is listed in one line (`R3 again: unchanged,
  settled`); a matching Warning is confirmed there by the person, not decided for them.
- A Warning (security) is never accepted for the person and is never quoted in a public place. Ask by id, path and a
  neutral description, and say the details are in the private report. A `Verified:` line, its input and its output, is
  never quoted outside the session.
- The standing rule: every fix's tests include edge cases. A row marked `n/a` needs a reason the person can check.
