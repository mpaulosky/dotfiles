# The Sandcastle workflow is Owned, and a repo opts in with a secret

**Status:** accepted (mpaulosky/dotfiles#312); supersedes ADR 0006's decision to keep `sandcastle.yml` out of the Template.
Implemented in `template/owned/.github/workflows/sandcastle.yml`, `template/seed/.github/ci/sandcastle-skills.txt`, `apply.sh` and `test.sh`
([sandcastle.md](../../references/sandcastle.md#the-workflow)).

ADR 0006 left the Sandcastle workflow to each repo because Sandcastle's Actions token has no Workflows permission and can't push a change to it.
Three copies then drifted (dotfiles, Blazor-Server and auth0-management-app: 185, 207 and 280 lines), and the workflow half of every Sandcastle
feature had to be landed by hand in each. A Template file reaches every repo by one re-Apply, from a PR a person opens.

## Considered options

- **Keep the workflow each repo's own** (ADR 0006): rejected. Three copies drifted, and a Sandcastle feature's workflow half could not come from Sandcastle's own PR.
- **Owned, switched on by a repository variable:** rejected. It is explicit, but the three repos that run Sandcastle today would stop, silently, at the re-Apply until
  someone set it.
- **A Seed script the Owned workflow runs (rejected):** it runs outside the sandbox with whatever the repo's `main` holds, and the steps after it, which hold the PAT and
  the Claude credential, trust everything it leaves behind (the workspace and `.git/config`, the home directory, `PATH`, `GITHUB_ENV`, `GITHUB_PATH`, the global git config).
  Comments can describe that risk, not remove it. A Seed data file the Owned workflow validates covers the one need (the skills) without it.
- **Owned, skipping without the token (chosen):** the repos that run it today need no change, and a local-only repo gets a green run.

## Decisions

- **The workflow is Owned**, and Apply writes it only into a repo that runs Sandcastle (a `.sandcastle/` folder, or a new repo), as for the rest of
  the Sandcastle section.
- **A repo opts in with `SANDCASTLE_GH_TOKEN`.** Four repos have a `.sandcastle/` folder and run Sandcastle only locally, with no token: an Owned workflow
  there would fail on every two-hourly run. The first step reports whether the secret is set, and every later step waits for it, so the run ends green with a
  notice. A variable would be an explicit switch, but it would stop the three repos that run Sandcastle today silently at the re-Apply if it were not set first.
- **The repo's own setup is data, not a script.** The one thing a repo needs on the runner is the skills `lib/skills.mts` mounts, so the Seed
  `.github/ci/sandcastle-skills.txt` lists them (a pinned dotfiles commit and skill names). An Owned step validates it strictly, fetches the commit before git holds the PAT,
  refuses a commit that isn't in dotfiles' `main` and a symlink in a listed skill or above it, and links only the listed skills. A setup the list can't express needs a Template change.
- **`workflow_run` lists the CI workflows by name** (it can't read a variable): the Template's `ci.yml`, the workflow that tests the Template in dotfiles, and Claude Review.
  The follow-up-run and hand-opened-PR triggers of auth0-management-app are not included: they land with the host code that uses them
  (mpaulosky/dotfiles#313 and mpaulosky/dotfiles#314), now that a Template PR can change the workflow and `lib/` together.
  The `pull_request_target` `labeled` trigger and its `record-head` job landed with mpaulosky/dotfiles#334: it records the head a hand-off label approves.

## Consequences

- A re-Apply brings the file to the repos that run Sandcastle, and overwrites a repo's own copy: `apply.sh` has no way to skip an Owned file for a repo, and
  `NOT_OWNED_BASELINE_PATHS` only tells the local review which files are the repo's own. A repo with its own copy drops it from that list in its re-Apply, and
  Blazor-Server moves its skills step into `sandcastle-skills.txt` in the same PR. auth0-management-app must not be re-Applied until the follow-up-only and
  hand-off triggers land in the Template (mpaulosky/dotfiles#313 and #314), or its re-Apply drops them; `rollout.sh` has no way to leave a repo out of a round,
  so until then each repo except auth0-management-app is re-Applied one at a time with `reapply.sh`, TicketManager first, and `rollout.sh` is not run
  ([sandcastle.md](../../references/sandcastle.md#the-workflow) has the reason).
- A repo that later adds the token starts running Sandcastle in Actions with no further workflow change.
- A mistyped secret name no longer fails the run loudly: the run is green with a notice. The notice names the secret.
