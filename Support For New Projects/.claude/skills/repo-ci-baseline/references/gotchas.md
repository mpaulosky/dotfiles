# Gotchas

Lessons that apply to every part of the Baseline, learned bringing repos onto it.

## Repo drift

- **Branch names differ until a repo is Standardized.** Until then its pre-push hook enforces its old pattern:
  atelier-store refused `squad/86-...` because it allowed only `feature/`, `hotfix/` and `chore/`.
  `chore/standardize-baseline` passes every pattern seen so far ([git-hooks.md](git-hooks.md) has the standard).
- **Labels.** `release.yml` reads `semver:minor` and `semver:major` (and `release:*`). A repo without them silently
  releases every PR as a patch. Create them:

  ```bash
  gh label create "semver:minor" -R <repo> --color 1D76DB --description "Release a minor version when this PR merges"
  gh label create "semver:major" -R <repo> --color B60205 --description "Release a major version when this PR merges"
  ```

## Reviews and descriptions

- **Refresh the PR description after every follow-up commit.** The release workflow copies the merged PR's description
  into its blog post word for word. A stale claim (a test count, a feature since removed) turns into a stale post, and
  Copilot then holds the blog PR on it.
- **Answer every Copilot thread**, fix or reply, then resolve it, and only after the push has landed, so the reply names
  a commit that exists. Auto-merge waits for every thread (Copilot's only until its review cap). Workflow and release logic draws real findings:
  IssueTracker's release pipeline took five rounds and ten fixes, and porting it to atelier-store found three more (a
  manual run naming a PR merged elsewhere, a published draft missing its `Source PR` line, and a draft naming another
  PR, even inside a list item). A fix found late can land after the PR has already auto-merged; it then needs its own
  follow-up PR, Template first.
- **Decision logic goes in a tested script from the start.** Any workflow shell that decides whether something is
  released, published or skipped (a draft Release's body, whether required checks run) draws a Copilot request for
  automated tests. Write it as a standard-library script under `.github/scripts/` with pytest tests, and keep the
  workflow step to the call. Manual simulations in the PR description don't count.
- **A PR left `BEHIND` never auto-merges.** When the ruleset requires branches to be up to date, a PR that went green
  while another PR merged sits at `mergeStateStatus: BEHIND`: every check passes and nothing happens. Run `gh pr
  update-branch <n>`, then `gh pr edit <n> --add-reviewer @copilot`: the auto-merge workflow wants Copilot's review on
  the exact head, and the merge commit `update-branch` makes doesn't get one by itself. The workflow's 15-minute sweep
  merges it once the review lands. Watch for this whenever two PRs are in flight.
- **Count claims before writing them.** Recount tests from the test run, not from memory.
- **A fix found in a repo goes into the Template first.** When a review finds a flaw in an Owned file, fix it in
  `template/` (a dotfiles PR with `test.sh` green), then Apply it to the repo. Fixed only in the repo, it is reverted by
  the next Apply.

## Local tooling

- **Stale build servers break the pre-push gate.** With several IDEs running their own .NET builds, the gate can fail
  with bogus Razor errors (pages parsed as C#) on files the branch never touched. Run `dotnet build-server shutdown` and
  delete the UI project's `obj/` and `bin/`, then push again.
- **Run one pre-push gate at a time** when the gate starts containers (Aspire, Testcontainers): parallel gates in two
  worktrees collide on fixed container names.
- **A global `init.templateDir` reaches throwaway repos.** Hooks under `~/.git-templates/hooks` are installed into every
  `git init`, so a test that builds repos runs this machine's hooks on its commits and checkouts. `test.sh` points
  `GIT_TEMPLATE_DIR` at an empty directory; do the same in any new test.
- **Interactive aliases:** `rm` may be aliased (for example to a `trash` command that isn't installed), and `cp` to `cp
  -i`, which waits silently on an overwrite prompt. Use `command rm` and `command cp -f` in scripts.

## Shell in workflows and scripts

- **`--no-renames`, `--diff-filter=...R`:** any path classification must account for renames, which git otherwise
  reports under the new path only.
- **File names are untrusted log input.** Git allows `\r` and `\n` in a path, so printing one raw to the Actions log
  lets the rest of the name start a workflow command (`::error::`, `::add-mask::`). Escape line breaks before logging a
  PR-controlled path, and test it with such a name. Read git's output as bytes: `subprocess.run(text=True)` uses
  universal newlines and silently turns a `\r` in a name into `\n`.
- **Reply text with backticks** breaks inside a double-quoted shell string. Write reply bodies to a file and pass them
  with `gh api -F body=@file`.
- **Check a push succeeded before acting on it.** Chain the reply, resolve and description steps after the push, and
  stop if it fails. A pipe hides the failure: `git push | tail` exits with `tail`'s status, so redirect the push's
  output to a file and test `$?` instead.
- **`node --test` takes files or globs, not a directory,** on Node 24: quote a glob so node expands it,
  `node --test '.github/scripts/tests/*.test.mjs'`.
- **Script tests need pytest,** which the system Python may lack. `uvx pytest -q .github/scripts/tests` runs them
  without installing anything.
