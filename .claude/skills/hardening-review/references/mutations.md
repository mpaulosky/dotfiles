# Mutation specs

`<private>/mutations/<batch>.json` (the private folder of [SKILL.md](../SKILL.md)), run with `scripts/mutate.py`. The file is data, and the tests run as an argv list with no
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
  `AMBIGUOUS` or `INVALID`. Exit 2: refused (a bad spec, an untracked, dirty or outside target, tests that fail before
  any mutation or do not finish within `timeout`). Exit 130: interrupted by SIGINT, SIGTERM or SIGHUP; the files are
  restored.
- The tests run in their own process group, which is killed when they end, time out or are interrupted, so a
  `pnpm run test` leaves no `node` behind. `git` and the tests get no `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`, and
  Python tests get `PYTHONDONTWRITEBYTECODE` and `PYTHONPYCACHEPREFIX` (one new folder per run, shared by the baseline and every mutation), so a same-size mutation can't load a
  stale `.pyc`. A Python test command must not run with `-I`, which ignores those variables.
- A runner killed with SIGKILL can't restore its file. It claims a journal under `review/` in the common git directory
  (`mutate-journal-<hash>.txt`, a folder Sandcastle hides from its sandboxes) before the baseline run and writes the
  originals into it before the first mutation, named relative to the worktree's top level. There is one journal per
  worktree, shared by every `--root` in it. Until the journal is deleted, the next run (or a second one started
  meanwhile) refuses to start. After a kill, check `git diff`, run `git checkout -- <file>` from the top level the
  message names and delete the journal it names. The journal is never written in place: the claim is staged in a file of its own and
  put into position with a hard link (which fails if the journal exists), and the originals replace it with `os.replace`. It is
  never empty, so any journal blocks the run and nothing is deleted to take over. When the tests fail before any mutation, the last lines of their output are printed.
- POSIX only: the tests run in a process group, so on Windows outside WSL the runner refuses with exit 2.
- **CAUGHT only means the tests failed.** A mutation that leaves the file unparsable or uncompilable fails every test, so
  write mutations that keep the file valid, and run the first one by hand to see that the test failing is one that
  covers the fix.
- Write about one mutation per branch and guard in the fix. Don't pad the list to a number: a mutation that no test
  could distinguish from the original is `equivalent`, with the reason.
