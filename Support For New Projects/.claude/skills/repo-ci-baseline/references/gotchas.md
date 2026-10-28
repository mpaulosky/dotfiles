# Gotchas

Lessons that apply to every part of the Baseline, learned bringing repos onto it.

## Repo drift

- **Branch names differ until a repo is Standardized.** Until then its pre-push hook enforces its old pattern:
  atelier-store refused `squad/86-...` because it allowed only `feature/`, `hotfix/` and `chore/`.
  `chore/standardize-baseline` passes every pattern seen so far ([git-hooks.md](git-hooks.md) has the standard).
- **README links inside `docs/`.** A README copied into `docs/README.md` verbatim has every relative link one directory
  too deep. `release_post.py` now rebases them ([release-pipeline.md](release-pipeline.md)); TicketManager #104 fixed it
  first with its own `.github/scripts/docs_readme.py`, a Leftover after Apply: delete it, its test and
  `docs-readme-tests.yml`.
- **Labels.** `release.yml` reads `semver:minor` and `semver:major` (and `release:*`). A repo without them silently
  releases every PR as a patch, and Dependabot silently drops a label that doesn't exist. `github-settings.sh --fix`
  creates or corrects all the standard labels ([github-settings.md](github-settings.md)); `docs-only` may already exist with
  the default color, since CI creates it on first use.

## Reviews and descriptions

- **Refresh the PR description after every follow-up commit.** The release workflow copies the merged PR's description
  into its blog post word for word. A stale claim (a test count, a feature since removed) turns into a stale post, and
  Copilot then holds the blog PR on it.
- **Answer every Copilot thread**, fix or reply, then resolve it, and only after the push has landed, so the reply names
  a commit that exists. Auto-merge waits for every thread, past the review cap too (#146). Workflow and release logic draws real findings:
  IssueTracker's release pipeline took five rounds and ten fixes, and porting it to atelier-store found three more (a
  manual run naming a PR merged elsewhere, a published draft missing its `Source PR` line, and a draft naming another
  PR, even inside a list item). A fix found late can land after the PR has already auto-merged; it then needs its own
  follow-up PR, Template first.
- **Decision logic goes in a tested script from the start.** Any workflow shell that decides whether something is
  released, published or skipped (a draft Release's body, whether required checks run) draws a Copilot request for
  automated tests. Write it as a standard-library script under `.github/scripts/` with pytest tests, and keep the
  workflow step to the call. Manual simulations in the PR description don't count.
- **A check stuck at pending holds auto-merge.** On Articles #280 the `Hook tests` job finished every step successfully,
  but GitHub left its check `in_progress` for over 30 minutes, so the PR never auto-merged. Its run already showed
  `completed`, so `gh run cancel` refuses; re-run the one job (`gh run rerun <run> --job <job>`) and the check reports.
- **A PR left `BEHIND` waits for an update.** When the ruleset requires branches to be up to date, a PR that went green
  while another PR merged sits at `mergeStateStatus: BEHIND`. PR Auto-Merge brings it up to date once it is otherwise
  ready (#142, [ADR 0005](../docs/adr/0005-pr-auto-merge-brings-ready-prs-up-to-date.md)), but only with
  `RELEASE_PR_PAT`: without it, run `gh pr update-branch <n>` by hand. A clean merge from main (no file changed on
  both sides) needs no new review; otherwise request one (`gh pr edit <n> --add-reviewer @copilot`, or `review:claude`).
- **A cancelled run's "Test Suite" reads as a failure.** It runs `if: always()`, so a run cancelled by a newer one on
  the same head (`cancel-in-progress`) leaves a failed check beside the newer run's result; the newer one is what
  counts. `ci.yml` doesn't run on `ready_for_review`, since drafts already run CI, so marking a PR ready no longer
  causes one. Keep `always()`: a skipped required check passes, so skipping it on cancel could pass an untested head.
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
- **Interactive aliases:** `rm` may be aliased (for example to a `trash` command that isn't installed), and `cp` and `mv`
  to `cp -i` and `mv -i`, which wait silently on an overwrite prompt. Use `command rm`, `command cp -f` and `command mv -f`
  in scripts. A `mv` over the README hung an Articles Adapt step until the command was killed.

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
- **Tell every `gh` command its repository** in the Owned `scripts/`, and in a repo's own `scripts/`, `.github/ci/` and
  skills. Without it gh uses its default repository, which in a clone whose only remote is a fork is the fork, and a
  Baseline repo's gate refuses such a command in files it can't edit (mpaulosky/dotfiles#267). Every repo's
  `scripts/gate.sh` runs `.github/scripts/check_gh_repo.py --repo` for its own files (mpaulosky/dotfiles#321),
  skipping the Owned Baseline files, which `test.sh` checks in dotfiles. In a script, export `GH_REPO` at the top level, alone on its line, before the script's first `gh`
  command, or write `GH_REPO=<repo> gh ...`. gh ignores an empty `GH_REPO`, so write a variable as `${NAME:?}`, which
  stops the script when it's empty. `GITHUB_REPOSITORY` is set only in Actions, not when the pre-push hook runs
  `gate.sh`, so a script that also runs locally falls back to the `upstream` remote, then `origin` (a fork's clone
  needs its `upstream` remote), and stops when there's neither:

  ```bash
  url="$(git remote get-url upstream 2>/dev/null || git remote get-url origin)"
  url="${url%.git}"
  repo="${GITHUB_REPOSITORY:-${url#*github.com[:/]}}"
  export GH_REPO="${repo:?}"
  ```

  Call `gh` by name with its subcommand on the same line: a `gh` followed by `"$@"`, another expansion or a backslash
  continuation is refused even after the export, since the subcommand it hides could be `gh repo view`. `gh repo
  view`, `edit` and most other `gh repo` subcommands don't read `GH_REPO` and have no `-R`: give them the repository as
  their first argument (`list`, `create`, `clone`, `gitignore` and `license` name their own or need none, while
  `rename`, `deploy-key` and `autolink` read `GH_REPO`). `test.sh` checks the Owned scripts with the same
  `check_gh_repo.py`, whose tests are in `tests/gh_repo/`.

  More rules of a script, which this page holds in full (the checker's docstring only points here):

  - A `NAME=value` word before `gh` is walked back over, and the last `GH_REPO=` among them is judged:
    `GH_REPO=o/r GH_TOKEN=x gh pr view 1` is told. A wrapper (`env gh`, `sudo gh`) between them and `gh` is not walked
    over and is refused. A later `unset GH_REPO`, or an assignment that is no prefix of a `gh` command, ends an export.
  - A bare `gh` that ends its line in `||` or `&&` (`command -v gh >/dev/null 2>&1 ||`) is a lookup that goes on to
    its own next command, and is accepted before the export. A pipe or a backslash continuation after it is refused.
  - `gh.exe` is `gh`: it is judged by the same rules, and a longer word (`gh.executable`, `neigh.exe`) or a folder
    (`~/.config/gh.exe/`) is not.
  - The body of a heredoc is skipped only when every command on its logical line (backslash continuations joined)
    treats its input as data: `cat`, `tee`, `echo`, `printf`, `read`, `mail`, `:` and `true`, with a plain redirect and
    any `NAME=value` words before them, and every file they write is text (`.txt`, `.md`, `.json`, `/dev/stderr`, `>&2`,
    ...). Prose naming `gh` in `cat <<EOF` usage text is then no code, as an `echo` message is not. Any other command
    may run its input, so its body is read as code: a shell (`bash <<EOF`, `cat <<EOF | sh`, `eval`, `source`,
    `GH_TOKEN=x . /dev/stdin <<EOF`), an interpreter (`python3 - <<EOF`, `node - <<EOF`, `ssh host <<EOF`), a script
    written to a file that isn't text (`cat > run.sh <<EOF`, `cat > "$file" <<EOF`), and a line ending in a pipe, whose
    consumer follows the body. A `<<` inside a quote, a comment or `(( ))` is no heredoc. An unquoted delimiter
    (`<<EOF`, not `<<'EOF'`) still lets bash run the `$(...)` and backticks in a data body, so a `gh` inside one is
    judged, on whichever line of a multi-line substitution it is.
  - Lines end only at a newline, as bash's do (an optional `\r` before it is dropped). A binary file (with a NUL byte)
    is skipped; any other file is read whatever bytes it holds.

  A skill's snippets stand alone, so there is no export: in a fenced block or an inline code span, write
  `GH_REPO=owner/repo gh ...` (or `GH_REPO="${repo:?}"`) right before each `gh` command, or give `--repo owner/repo`
  (`--repo=` and `-R` work too) on its line, except for `gh api`, which has no such flag. `gh repo`'s subcommands take
  the repository first in a skill too. Keep a command on one line; a backslash continuation or `"$@"` is refused.
  Prose such as "the gh CLI" and a span that is only `` `gh` `` are not commands.
  A skill's `gh` line must be copy-pasteable, so a placeholder repository after `--repo`, `-R` or `GH_REPO=`
  (`gh pr list --repo <owner>/<repo>`) is refused: write a real `owner/repo` or `"${repo:?}"`.

  A line that names `gh` without running it (`command -v gh >/dev/null`, `echo "needs gh"`) ends in a comment
  `# gh-repo: ok` in a script or a fenced block, or carries `<!-- gh-repo: ok -->` in a skill, and the check skips it.
  A path such as `~/.config/gh/hosts.yml` is not a command. The marker is the way out for a line the rules misread; a
  real `gh` command is told its repository instead.
- **Script tests need pytest,** which the system Python may lack. `uvx pytest -q .github/scripts/tests` runs them
  without installing anything.

## Action pins

- **Comment a hash pin with the exact tag, never the major.** zizmor's `ref-version-mismatch` checks that the tag in
  the comment still points at the pinned commit. A floating major tag (`# v7`) moves with each release upstream, so a
  pin that passed yesterday fails every PR in every repo the day `v7` moves, with no change on our side. Find the exact
  tag with `git ls-remote --tags https://github.com/<owner>/<action> | grep <sha>`.
