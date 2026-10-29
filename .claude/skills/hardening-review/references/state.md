# `state.md`

Rewritten, not appended, whenever a step changes it. After a compaction this file, with `decisions.md`, is the run.

```markdown
# Hardening review state: <branch>

- Step: <the step to do next, e.g. "5 Triage, batch 2 of 3", or `recorded` once step 8's record has been made>
- Pass: <N> of at most <5, or the raised limit>
- Next finding id: R<n>      (from `scripts/review.sh next`, then counted on)
- Key: <the key prepare printed this pass>
- HEAD: <the HEAD prepare printed this pass>
- Worktree: <absolute path>
- Run folder: <absolute path>
- Private folder: <absolute path>
- Verify checkout: <absolute path of the throwaway checkout, or none>

## Reviewers (this pass)

| Lens | Agent id | Answered |
| --- | --- | --- |
| Bar | <id> | yes |
| Edge cases (Shell) | <id> | no |

## Batch in progress

<The finding ids, the commit, the mutation spec, and whether mutate and the gate have passed.>

## Open items

<Ids that wait for the person, each as id, lens, path. Their reasons are in the private folder's known-open.json. When a fix moves an
accepted item's lines, its entry is `changed`: a re-accepted finding is removed and added again (`known_open.py remove`, then `add`), so
the line numbers here and in known-open.json agree.>
```
