# Serialized releases

Template files (Owned): `.github/workflows/release.yml`, `backfill-blog-posts.yml`, and `.github/scripts/`
(`release_queue.py`, `draft_release.py`, `release_post.py`, `backfill_blog_posts.py`) with their tests under
`.github/scripts/tests/`. History: IssueTracker #172, with the fixes from atelier-store #90's review (IssueTracker #184).

## What it guarantees

- Versions follow merge order, even when PRs merge seconds apart.
- A release that was cancelled, or failed before its GitHub Release was published, is retried by the next run.
- One blog PR per run, never one per released PR, so blog PRs can't conflict with each other.
- A merged blog PR (`[skip-release]`) releases nothing and opens nothing, so there's no loop.
- A Dependabot PR gets no Release of its own: it's folded into the next one. A dependency bump isn't worth a Release
  and blog post, so the queue never counts a PR Dependabot opened as owed. The next Release's tag sits on a later
  commit, so it contains the bump, and `--generate-notes` lists the bump's PR among the changes since the previous
  Release. Before this rule, the next run released each bump first with a Release and post of its own (IssueTracker
  #198 became v0.0.24 when #197 merged); Dependabot's merges start no workflow, so it was never released on time.

## Design

**Concurrency.** Every run that can release shares the group `release-main` (`cancel-in-progress: false`). GitHub keeps
only the newest *pending* run in a group and cancels the one it replaces, so a shared group alone would silently drop
releases. That's why each run releases everything owed, not just its own PR. A run that can't release (an unmerged PR
closing, a dispatch from a branch) gets `release-ignored-<run id>`, so it can't replace a pending release run and then
do nothing. The group expression repeats the `plan` job's `if`; keep the two in step.

**`plan` job** (read-only) runs `release_queue.py --repo <repo> --pr <trigger>` and outputs a JSON list:

- **Cutoff:** the newest *published* GitHub Release, meaning a `vX.Y.Z` tag with a `Source PR: #n` line, highest by
  version. Never the newest git tag: a run that pushed its tag and then failed before creating the Release would
  otherwise hide its PR for good. Drafts don't count.
- **Listing:** closed PRs into `main`, sorted by update time, newest first. Page back until a PR's update time is before
  the cutoff PR's merge time. A PR merged after the cutoff can't have been updated before it, so no fixed page size can
  miss one.
- **Owed:** merged after the cutoff, no `[skip-release]` in the title, not opened by Dependabot, no Release naming it, and merge commit not inside
  the cutoff Release's tag. The last rule keeps history from before release automation out. With no Release at all, only
  the triggering PR is queued.
- **Order:** by each merge commit's position on `main`'s first-parent history (`git rev-list --first-parent --reverse`),
  never by `merged_at`, which has one-second resolution and ties. Fetch `main` *after* listing, so every listed merge is
  on it. If one isn't, fail the run instead of guessing; the next run retries.
- **Manual runs** (`workflow_dispatch` with `pr_number`) go through the same planner, so a newer PR can't be released
  ahead of an older owed one. A named PR joins the list only if its base branch is `main`; one merged elsewhere is left
  out rather than failing the run on a merge commit `main` doesn't have.

**`release` job:** a matrix over the list with `max-parallel: 1` and `fail-fast: false`, using `contents: write` and
`pull-requests: read`. Per PR it resolves the PR, skips `[skip-release]`, checks for an existing non-draft Release (the
idempotency check), reserves a tag by pushing it (the push is the lock), and creates the Release. If it finds a draft
Release for its tag, it publishes it with the body `draft_release.py` returns: the draft's own text, plus the release
notes unless the draft already has this PR's `Source PR: #n` on a line of its own. The planner and the ordering guard
recognise a Release only by that marker, so a draft published without it would stay "owed" forever and block every later
PR. A draft that names a *different* PR fails the job instead, because publishing it would give one Release two sources.
The helper matches markers anywhere in a line, as `source_pr_of()` does, so a list item like `- Source PR: #5` is
caught; every parser must agree on which markers count.

- **Ordering guard:** before reserving a tag, every PR ahead of this one in the list must already have a *published
  Release*. A tag alone isn't enough. If one is missing, fail, and the next run releases both in order.

**`docs` job** (`needs: [plan, release]`, `if: always() && needs.plan.result == 'success'`) runs
`backfill_blog_posts.py`, which writes a post for every Release that `main` has no post for, then rebuilds the README
and blog tables once. It then force-pushes the result to a single branch, `docs/release-notes`, and creates or updates
one PR titled `docs: Add release blog for PR #N [skip-release]` (`release blogs for PR #A, #B` when a run covers
several), with auto-merge enabled. A still-open blog PR gets folded into the next run's PR instead of conflicting with
it. The PRs covered come from the new file names (`docs/blogs/<date>-pr-<n>-<slug>.md`).

GitHub's release *list* can lag a just-published Release by several seconds. The docs job starts about four seconds
after the last release, so it passes the plan's queue as `--wait-for-prs`, and the backfill lists again every 2
seconds, for up to about 30 seconds, until each queued PR has a Release. The posts and the tables then use that one
listing. Without this, IssueTracker's v0.0.20 (PR #188) got no blog PR: the run logged "Every Release already has its
post" and succeeded. Recovery was `gh run rerun <run id> --job <docs job id>`. Reference: IssueTracker #190 and #192.

**`docs/README.md`.** A repo that keeps a `docs/README.md` (its README as the Pages landing page) gets the README's text
there too, with relative links rebased for `docs/` by `rebase_readme_links`: `docs/x` becomes `x`, `docs` becomes `./`,
any other path (`../up.md` too) gets `../`. URLs, `#anchors`, `?query` references, root-relative paths and code
(fenced or indented blocks, at any depth, and code spans) are left alone. Origin: TicketManager #104; code from #52,
which Copilot raised on the re-Apply PRs. The backfill rebuilds the tables (and so this
copy) even when it writes no post, because a README-only PR merged with `[skip-release]` releases nothing and nothing
else syncs it. The docs job then opens `docs: Refresh release tables and docs/README.md [skip-release]`. A run with
nothing to change leaves the tree clean, so no PR.

**Untrusted text.** A post is built from the PR title, description and commit subjects, the AI summary and file names,
and GitHub Pages publishes it through Jekyll and kramdown, so `release_post.py` makes each one safe first
(mpaulosky/dotfiles#48, from Copilot's review of Articles#280):

- **HTML:** every `<` outside code becomes `&lt;`, except `<https://…>`, `<http://…>` and `<mailto:…>` autolinks. HTML
  comments are dropped. A description's `<details>` therefore shows as text.
- **Links:** a destination after `](` or `]:` whose scheme isn't `http`, `https` or `mailto` gets a `#` in front, so it
  becomes a fragment link. Entities and control characters are read the way browsers read them, so `java&#9;script:` counts,
  however much padding pushes the scheme along. An entity's leading zeros are dropped before decoding: Python refuses
  numbers over 4300 digits, so `&#000…9;` would otherwise stop the release before its post was written.
  Only a footnote definition alone at the start of its line (`[^1]: …`) is exempt; a label holding an escaped `\[^` isn't one.
- **kramdown:** `{:` (attribute lists, `{::extensions}`) becomes `&#123;:`.
- **Code keeps its text.** kramdown and CommonMark disagree about some fences (unclosed, a two-word info string, nested
  in a list), and escaping an HTML block can bring a fence line inside it to life. So every code block is re-emitted as a
  top-level fence, longer than any backtick run inside it and always with an info string, with blank lines around it.
  A block in a list or quote moves out of it. Any other line that looks like a fence gets its first fence marker escaped.
  A code span holding `<`, `{` or `]` becomes `<code>` with its symbols as entities. It looks the same, and it stays
  safe however a parser pairs the backticks. A span may cross a line break, but not a blank line, as in CommonMark;
  the README's `docs/` copy pairs spans the same way when it rebases links. File names with risky characters are written the same way.
- **Liquid:** Jekyll runs Liquid before Markdown, even inside code, so `{{` or `{%` in a PR body could break the Pages
  build. The post body sits between `<!-- {% raw %} -->` and `<!-- {% endraw %} -->` (comments, so neither GitHub nor
  Pages shows them), and a `{%` that would read as `endraw` is printed by Liquid instead. The README and blog index
  tables aren't in a raw block, so their titles have every `{` as `&#123;`.
  In the blog index a title is a link label, so its `[` and `]` outside code become entities: `fix: ](https://…)` can't
  close the label and link the row elsewhere.
- **The front matter's `post_title`** stays as written: it's a YAML string, never rendered as Markdown.
- **Excerpts** read the escaped text back as plain text.

**Permissions:** workflow-level `permissions: {}`, with each job granting only what it needs. The docs and release
checkouts use `RELEASE_PR_PAT`, falling back to `GITHUB_TOKEN`, so the blog PR's own checks start without a manual
approval.

## Adapting

- Check which Releases lack a post *before* the Standardize PR merges (`backfill_blog_posts.select_releases` with the
  repo's releases and `docs/blogs`). The docs job writes every missing one on its first run. If there are old ones, run
  the repo's "Backfill blog posts" workflow first (`gh workflow run backfill-blog-posts.yml --ref main`), so they
  arrive in a deliberate PR. atelier-store had 8 from before its blog automation.
- A post counts only when its file name has `-pr-<n>-` (`posts_for_pr`). Posts named another way (IssueManager's `<date>-release-vX.md`)
  look missing, and the first run writes a second post for each. Rename them to `<date>-pr-<n>-release-vX.md`, taking `<n>` from each
  Release's `Source PR` line, and update the links to them.
- A `docs/index.html` Pages site needs the `RELEASES_HTML_START`/`END` and `BLOGS_HTML_START`/`END` markers that `update_tables` fills;
  without them `test_release_post.py` fails on the repo's own page. `update_index_html` only replaces what's between existing markers, so
  add both pairs by hand (empty), with styles for the generated post cards (`post-grid`, `post-card`, …), then fill them once with
  `update_index_html`. Drop any script that rebuilt the tables in the browser.
- A repo's `release_post.py` is Owned now. A fix it carries that the Template lacks shows up as drift: move it into
  the Template first.
- Dry-run the planner against the real repo before pushing: `python3 .github/scripts/release_queue.py --repo
  <owner/name> --pr <last merged PR>`. It must print `[]` and name the newest Release as the cutoff. Any other result
  means the switch would release something unexpected.
- Create the `semver:minor` and `semver:major` labels if they're missing ([gotchas.md](gotchas.md#repo-drift)).
- Check that `RELEASE_PR_PAT` has **Workflows: Read and write** (fine-grained) or the `workflow` scope (classic).
  The release job pushes its tag with `git push`, and GitHub refuses a new tag on a commit whose workflow files differ
  from `main`'s unless the token may change workflows. The Standardize changes every workflow, so the first release that
  tags an older commit hits this. Blazor-Server's first run after #127 queued #126, merged just before it, and was
  refused five times. The tag step now stops at a rejection like that with GitHub's message; it retries only when
  another release took the tag.

## Verify live

The Standardize PR's own merge is the first live run. Check it:

1. `plan` logs `Newest published Release: vX (PR #prev). Queue: [<this PR>]`.
2. `release (<this PR>)` publishes the next version.
3. `docs` opens `docs: Add release blog for PR #<this PR> [skip-release]` from `docs/release-notes`, and it merges.
4. The blog PR's own run shows `Queue: empty`, `release` skipped, and `docs` reporting that every Release already has
   its post.

The `docs` job is idempotent (it rebuilds from `main`, force-pushes, then creates or updates the PR), so a failure on a
transient API error is fixed with `gh run rerun <run id> --failed`. atelier-store's first live run hit a GitHub 502 on
`gh pr create`; the rerun opened its blog PR.
