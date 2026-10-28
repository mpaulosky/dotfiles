# `state.md`

Rewritten, not appended, whenever a step changes it. After a compaction this file, with `decisions.md`, is the run.

```markdown
# Hardening review state: <branch>

- Step: <the step to do next, e.g. "5 Triage, batch 2 of 3">
- Pass: <N> of at most <5, or the raised limit>
- Next finding id: R<n>      (from `scripts/review.sh next`, then counted on)
- Key: <the key prepare printed this pass>
- HEAD: <the HEAD prepare printed this pass>
- Worktree: <absolute path>
- Run folder: <absolute path>

## Reviewers (this pass)

| Lens | Agent id | Answered |
| --- | --- | --- |
| Bar | <id> | yes |
| Edge cases (Shell) | <id> | no |

## Batch in progress

<The finding ids, the commit, the mutation spec, and whether mutate and the gate have passed.>

## Open items

<Ids that wait for the person, each as id, lens, path. Their reasons are in known-open.json and decisions.md.>
```
