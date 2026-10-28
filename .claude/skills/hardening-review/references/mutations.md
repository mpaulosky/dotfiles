# Mutation specs

`<run>/mutations/<batch>.json`, run with `scripts/mutate.py`. The file is data, and the tests run as an argv list with no
shell.

```json
{
  "test": ["pnpm", "run", "test"],
  "timeout": 600,
  "mutations": [
    { "path": "src/lib/a.mts", "old": "if (note.trim() === \"\")", "new": "if (note === \"\")",
      "why": "R17: whitespace-only notes" },
    { "path": "src/lib/a.mts", "old": "limit - 1", "new": "limit", "why": "R17: the boundary",
      "equivalent": "optional: why a surviving mutation changes no behaviour" }
  ]
}
```

- Targets must be tracked and committed. The runner refuses a dirty file, so a restore can't lose work: commit the
  batch's fix first.
- `old` must occur exactly once in the file: add context until it does (`NOT FOUND` and `AMBIGUOUS` fail the run).
- The tests must pass before any mutation, or the run is refused: otherwise every mutation looks caught.
- A mutation that makes the tests hang counts as caught once `timeout` passes.
- Exit 0: every mutation was `CAUGHT`, or `EQUIVALENT` with your reason. Exit 1: one `SURVIVED`, was `NOT FOUND`,
  `AMBIGUOUS` or `INVALID`. Exit 2: refused.
- Write about one mutation per branch and guard in the fix. Don't pad the list to a number: a mutation that no test
  could distinguish from the original is `equivalent`, with the reason.
