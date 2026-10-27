# Copilot review instructions

GitHub's Copilot code review reads `.github/copilot-instructions.md`. A repo that has a code-review skill
(`.claude/skills/code-review/SKILL.md`) generates that file from it, so Copilot and Claude's reviewers (and the local
`/pre-push-review`, which reads the skill) review against the same rules. The skill is the source; the file is generated.

## What the Template carries (Owned)

| File | What it does |
| --- | --- |
| `scripts/sync-copilot-review.sh` | Writes `.github/copilot-instructions.md` from the skill (front matter dropped, under a generated-file header); `--check` fails when the file has drifted |
| `.github/workflows/copilot-review-sync.yml` | Runs `--check` on every PR to `main` and every push to it; the job is "Copilot review instructions in sync" |
| `scripts/gate.sh` | Runs `bash scripts/sync-copilot-review.sh --check` before the build, so the push is refused rather than the PR; a repo that hasn't received the script yet skips it |
| `scripts/tests/sync-copilot-review.test.sh` | The script's tests, run by `test.sh` and by CI's hook-tests job in every repo |

Line endings: the script drops the skill's carriage returns and `--check` ignores a trailing one in the committed file, so a Windows checkout with
`core.autocrlf` agrees with CI. A skill whose front matter opens with `---` and never closes is refused, and the instructions file is left as it was.

## Opting in

A repo without the skill has nothing to sync: the script says so and succeeds in both modes, so the job and the gate pass, and a
hand-written `copilot-instructions.md` is left as it is. A repo opts in by adding `.claude/skills/code-review/SKILL.md` and running
`scripts/sync-copilot-review.sh`, which replaces the hand-written file with the generated one: move what that file said into the skill first.

The skill is also optional guidance for the local review ([pre-push-review.md](pre-push-review.md)), so a repo that already has one is opted in by its
next Apply, intended or not. Only Blazor-Server and auth0-management-app have it today, and both already generate the file.

The Template doesn't Seed a code-review skill. The hand-written files in TicketManager, Articles and IssueManager are specific to those repos,
and a generic skill would fail their check the moment it replaced them.

## Migrating

Blazor-Server and auth0-management-app have both files, byte-identical, and a "Copilot review instructions sync" step in their own
`.github/ci/gate-checks.sh`. Their re-Apply replaces the workflow and script with the Template's, which differ in the workflow's header
comment and its `bash` prefix, and in the script's skip for a missing skill, its argument check, its line-ending and front-matter handling. Apply never edits a Seed, so their Adapt deletes the
step from `gate-checks.sh` by hand, since `scripts/gate.sh` runs the check now; until then it runs a second time whenever the skill, the instructions file or the script changed.

The check isn't a required status check: a repo that hasn't re-Applied yet has no such job, and requiring it would block that repo's PRs.
