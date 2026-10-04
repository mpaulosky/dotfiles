# GitHub settings are kept as data in the skill and applied by a script run by hand

**Status:** accepted and implemented in `github-settings.sh` and `github/` ([github-settings.md](../../references/github-settings.md)).

A survey of the seven Baseline repos (2026-10-04) found the files close to the Template but the GitHub settings different in every repo:
merge methods, squash commit text, required checks, bypass actors, thread resolution, Copilot's draft reviews, labels, Actions permissions
and security features. Nothing set or checked them: `apply.sh` copies files, and `adapt.md` listed a few settings to change by hand.
Two of the differences broke Baseline behaviour silently: IssueTracker's required thread resolution blocks ADR 0002's review cap,
and IssueManager's Dependabot `always` bypass let Dependabot skip every rule.

So the settings are a standard kept as JSON in the skill, and `github-settings.sh` checks a repo against it and, with `--fix`, applies it.

## Decisions

- **Run by hand, from the skill.** Changing rulesets needs admin rights; they stay with the owner rather than in a token every repo's workflows can reach.
- **Python standard library behind a bash wrapper**, tested with pytest against an in-memory GitHub: the work is JSON diffs and reports.
- **One standard; per-repo files may only add** required checks or labels. A repo can't quietly loosen it, and every exception is written down in dotfiles.
- **Squash only, with the PR title and body as the commit.** Every merge was already a squash; the title is also the Release name.
- **No bypass actors.** An emergency is `--suspend`, which every check then reports until `--fix` restores the ruleset.
- **Review threads hold the merge for at most three Copilot rounds, in every repo.** A ruleset can only require every thread resolved, with no cap,
  so `main-rules` leaves it off, `pr-automerge.yml` enforces the cap (ADR 0002), and the script checks each repo runs that cap.
  Copilot reviews drafts too: Standardize PRs are drafts.
- **Nine required checks**, adding `markdownlint` and `yamllint` (both run on every PR) so release-blog and Dependabot PRs, which merge on required checks alone, can't merge broken Markdown or YAML.
  CodeQL stays optional because it skips docs-only PRs.
- **No `code_quality` rule.** GitHub's Code Quality isn't available on these repos, so the rule checked nothing; re-add it when Code Quality is enabled.
- **`--fix` changes only what it manages**; legacy items go only with `--remove-legacy`, and classic protection only once `main-rules` is active.
- **A check is required only once a workflow reports it, and an old one stays while it's still reported**,
  so `--fix` can run at any point of a Standardize without blocking every PR or dropping the repo's only test gate.
- **Actions get a read token by default and may create PRs** (the `GITHUB_TOKEN` fallback for release-notes and backfill PRs). Pinned actions are required once all workflows are pinned.
- **Security:** secret scanning, push protection, Dependabot alerts and security updates on; CodeQL default setup off where the workflow runs CodeQL.
- **dotfiles gets the merge settings only:** it isn't a Baseline repo, and rulesets need GitHub Pro there.
- **TinyTicket is retired**: it isn't in `repos.txt` and isn't Standardized.
- **Squad is retired**, so `--fix` deletes `squad*` labels with no flag; the squad-era rulesets still need `--remove-legacy`.
- **Dependabot bumps are folded into the next Release.** The release queue never counts a Dependabot PR as owed, so a bump gets no Release
  or blog post of its own; the next Release's tag contains it and its generated notes list it. (Without the rule, each bump got its own Release,
  made late by the next merged PR's run.)

## Considered Options

- **An Owned workflow that applies each repo's settings**: rejected; it needs an admin token in every repo, and a repo's PR could change the rules gating it.
- **A scheduled dotfiles workflow that applies settings**: rejected for applying; a read-only drift check is planned as its own change.
- **bash and jq**: rejected; the nested ruleset diff and the reports are much clearer in Python.
- **Full per-repo overrides**: rejected; the drift this replaces came from per-repo choices.
- **A repository-admin bypass**: rejected; it lets a merge skip the rules by accident, where `--suspend` is deliberate and visible.
- **Deleting everything outside the standard on `--fix`**: rejected; deletion stays an explicit `--remove-legacy`.
- **A release for every Dependabot merge**, late (the queue's behaviour before) or at once (auto-merge armed with the PAT,
  copied into each repo's Dependabot secrets): rejected as noise.

## Consequences

- Standardize runs `--fix` twice, before and right after the merge; a new repo after its first push and after its first PR.
- A Template change that adds a required check or label is followed by re-Apply, then `--fix`.
- `~/github/RuleSet Templates/` (outside dotfiles), which this superseded, was deleted on 2026-10-04.
- A read-only drift check across all repos (settings and files) remains to be built.
