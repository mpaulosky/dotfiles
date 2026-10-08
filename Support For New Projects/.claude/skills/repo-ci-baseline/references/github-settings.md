# GitHub settings

Skill files (not copied into repos): `github-settings.sh`, which runs `github/settings.py`, and the standard beside it in `github/`:
`settings.json`, `main-rules.json`, `labels.json`, `legacy.json`, `repos.txt` and `repos/<repo>.json`.
Tests: `github/tests/test_settings.py`, run by `test.sh`. Decisions: [ADR 0003](../docs/adr/0003-github-settings-as-code.md).

`apply.sh` copies the Baseline's files. Everything a file can't carry lives on GitHub: merge settings, the ruleset and its required checks,
labels, Actions permissions and security features. Before this script, each repo's were set by hand, and the survey found every repo different.

```bash
github-settings.sh mpaulosky/<repo>          # report; exit 1 on any DRIFT, MANUAL or LEGACY
github-settings.sh --fix mpaulosky/<repo>    # report, apply, report again
github-settings.sh --all                     # every repo in github/repos.txt
github-settings.sh --fix --remove-legacy …   # also delete the legacy rulesets and protection
github-settings.sh --suspend mpaulosky/<repo> # emergency: main-rules disabled until the next --fix
github-settings.sh --json …                  # the same report, machine-readable
```

It runs as you, through `gh api`, and needs admin rights on the repo. It's never run from a workflow: an admin token stored in every repo
would let a repo's own PRs change the rules that gate them.

## The standard

| Area | Standard |
| --- | --- |
| Merging | Squash only (`allow_merge_commit` and `allow_rebase_merge` off); the squash commit is the **PR title and body**, so `main`'s history reads like the PRs and Releases. Delete the branch on merge; update-branch on; auto-merge allowed, since `release.yml` and `dependabot-auto-merge.yml` arm it on their PRs. Forking stays allowed (CONTRIBUTING starts with a fork). |
| Security | Secret scanning, push protection, Dependabot alerts and Dependabot security updates on. CodeQL **default setup off** wherever `codeql-analysis.yml` runs CodeQL: GitHub rejects the workflow's results while default setup is on. |
| Actions | Workflows get a **read** token by default (every Template workflow declares its own `permissions:`), and may create PRs, which `release.yml` and `backfill-blog-posts.yml` need when they fall back to `GITHUB_TOKEN` without `RELEASE_PR_PAT`. Pinned actions are required once every workflow is pinned. |
| Ruleset `main-rules` | On `~DEFAULT_BRANCH`: no deletion or force-push, linear history, squash only, 0 approvals, review threads **not** required, Copilot reviews every push (drafts too), strict required checks, **no bypass actors**. No `code_quality` rule. |
| Required checks | `Build Solution`, `Test Suite`, `Branch name`, `PR title`, `actionlint`, `zizmor`, `shellcheck`, `markdownlint`, `yamllint`. CodeQL isn't one: it skips docs-only PRs, so requiring it would block them. |
| Labels | `semver:minor`, `semver:major`, `docs-only`, `review:claude`, `sandcastle:needs-human`, `dependencies`, `github-actions`, with the colors and descriptions in `labels.json`. Dependabot drops a label that doesn't exist, `release.yml` releases a PR without its semver label as a patch, and `gh pr edit --add-label review:claude` fails without the label. |
| Secrets | `RELEASE_PR_PAT` and `CLAUDE_CODE_OAUTH_TOKEN` (Claude Review's, from `claude setup-token`) must exist; the script reads secret names, never values, so a missing one is MANUAL. |

**Review threads hold the merge for at most three review rounds** (Copilot's and Claude's together), in every repo. A ruleset can only require *every* thread resolved,
with no cap, which blocks ADR 0002's cap (IssueTracker's did); so `main-rules` leaves it off and `pr-automerge.yml` enforces the cap.
The script checks each repo's `pr-automerge.yml` sets `COPILOT_REVIEW_CAP` to `review_cap` (3); without it, the finding is MANUAL until the re-Apply.
Repo features unrelated to PRs (wiki, projects, discussions) aren't managed.

## What `--fix` may change

- **Only what it manages.** Other rulesets and labels are reported as INFO and left alone.
- **Squad labels** (`removed_label_prefixes`: `squad`, `squad:*`) are deleted on every `--fix`: squad is retired everywhere.
- **Legacy items** (`legacy.json`: the squad-era `dev-rules` and `protect-preview` rulesets, and classic branch protection)
  are reported as LEGACY and deleted only with `--remove-legacy`. Classic protection goes only once `main-rules` is active,
  so the branch is never left unprotected: where `main-rules` is created in the same run, run `--fix --remove-legacy` twice.
  `release:minor` and `release:major` aren't legacy: `release.yml` still reads them.
- **A required check only once the repo reports it on every PR.** The script reads the job names (or job ids) of the workflows on the
  default branch that run on every pull request: a `pull_request` trigger with no `paths` filter (a scheduled workflow's, or CodeQL's, wouldn't report on every PR).
  A standard check none reports is MANUAL and left out of the ruleset; requiring it would block every PR, since a check that never runs never passes.
  A templated name (a matrix job's) can't be read, so such a check can't be required.
- **An old required check stays while the repo still reports it.** Before a Standardize, a repo's own test gate (IssueManager's `All Tests Passed`)
  is its only one; dropping it before `Test Suite` exists would leave no required test. It's reported as INFO and dropped by the first `--fix` after it stops being reported.
  That is after the Standardize merges, but the Standardize PR itself never reports the old check, so it can't merge while the check is required.
  `--admin` doesn't get past a ruleset, and the first `--fix` empties `bypass_actors`. Remove the old check from `main-rules` by hand just
  before merging, once `Test Suite` has passed on the PR's head, then run the second `--fix` straight after the merge (IssueManager #241).
- **Pinned actions only once every workflow is pinned.** Until then the unpinned `uses:` are listed as MANUAL, and so they are
  if pinning is already required, since GitHub then refuses to run them.

## Exceptions

- **`github/repos/<repo>.json`** may add `required_checks` or `labels` for one repo, never remove or loosen anything; any other key is an error.
  A repo's own required check (a Sandcastle check, say) goes there, and in its workflow.
- **`repos.txt` scope.** `repo-settings-only` manages just the merge settings, and deletes the retired squad labels. dotfiles carries it: it isn't a Baseline repo,
  and rulesets need GitHub Pro on a private repo, where the API answers 403 (reported as UNAVAILABLE, which doesn't fail the run).

## When to run it

- **Standardize**, twice in the same sitting ([SKILL.md](../SKILL.md#standardize-a-repo)): `--fix` while the PR is a draft, then again right after it merges.
  The first can't require `Branch name`, `PR title` or `Test Suite` yet, because `main` doesn't report them; the second does.
- **New repo**: after the first push of `main` (Instructions Part A), then again after the first PR merges.
- **After a Template change** that adds a required check or label: re-Apply, then `--fix`.
- **Emergency**: CI broken on `main` blocks the PR that fixes it. `--suspend` disables `main-rules`; merge the fix, then `--fix` restores it.
  While it's suspended, every check reports it as DRIFT, so it isn't forgotten.

## Tests

`github/tests/test_settings.py` runs the script against an in-memory GitHub that keeps state, so a case can run `--fix` and then show that a
second run writes nothing. Cases cover each area's drift and fix, a check-only run writing nothing, required checks limited to what workflows report,
an old check kept while reported, a required check from another app, the suspend/restore cycle (keeping every rule), 403s,
squad labels deleted, legacy rulesets deleted only on request (and classic protection only with `main-rules` active), the review cap,
pinning only when all workflows are pinned, scope and per-repo additions, a per-repo file that tries to loosen the standard, and `--json`.
The fake rejects a partial ruleset update, as GitHub may. Mutation-check the safety rules: breaking each one (kept checks, unreported checks,
the app comparison, the active guard, the pinning guard, the legacy flag, the suspended check, the additive-only rule) must fail a test.

## Verify live

`github-settings.sh --all` before and after a rollout step. A repo counts once its report has no DRIFT, MANUAL or LEGACY.
The first read-only run, before any `--fix` (2026-10-04), found drift in every repo; each repo's report is the start of its rollout PR.
