# The Sandcastle workflow is Owned, and a repo opts in with a secret

**Status:** accepted (mpaulosky/dotfiles#312); supersedes ADR 0006's decision to keep `sandcastle.yml` out of the Template.
Implemented in `template/owned/.github/workflows/sandcastle.yml`, `template/seed/.github/ci/sandcastle-prepare.sh`, `apply.sh` and `test.sh`
([sandcastle.md](../../references/sandcastle.md#the-workflow)).

ADR 0006 left the Sandcastle workflow to each repo because Sandcastle's Actions token has no Workflows permission and can't push a change to it.
Three copies then drifted (dotfiles, Blazor-Server and auth0-management-app: 185, 207 and 280 lines), and the workflow half of every Sandcastle
feature had to be landed by hand in each. A Template file reaches every repo by one re-Apply, from a PR a person opens.

## Considered options

- **Keep the workflow each repo's own** (ADR 0006): rejected. Three copies drifted, and a Sandcastle feature's workflow half could not come from Sandcastle's own PR.
- **Owned, switched on by a repository variable:** rejected. It is explicit, but the three repos that run Sandcastle today would stop, silently, at the re-Apply until
  someone set it.
- **Owned, skipping without the token (chosen):** the repos that run it today need no change, and a local-only repo gets a green run.

## Decisions

- **The workflow is Owned**, and Apply writes it only into a repo that runs Sandcastle (a `.sandcastle/` folder, or a new repo), as for the rest of
  the Sandcastle section.
- **A repo opts in with `SANDCASTLE_GH_TOKEN`.** Four repos have a `.sandcastle/` folder and run Sandcastle only locally, with no token: an Owned workflow
  there would fail on every two-hourly run. The first step reports whether the secret is set, and every later step waits for it, so the run ends green with a
  notice. A variable would be an explicit switch, but it would stop the three repos that run Sandcastle today silently at the re-Apply if it were not set first.
- **The repo's own setup is a Seed script,** `.github/ci/sandcastle-prepare.sh`, run with `bash` after the checkout and before git holds the PAT, with no secrets
  in its environment. It replaces Blazor-Server's inline step that fetches the `dotnet-*` skills. It is still code on the runner outside the sandbox:
  whatever it leaves on the runner (the workspace and `.git/config`, the home directory, `PATH`, `GITHUB_ENV`, `GITHUB_PATH`, the global git config) is trusted by the steps
  that follow, which hold the PAT and the Claude credential, so a change to it needs a person's review (the script's header and [The workflow](../../references/sandcastle.md#the-workflow) say so).
- **`workflow_run` lists the CI workflows by name** (it can't read a variable): the Template's `ci.yml`, the workflow that tests the Template in dotfiles, and Claude Review.
  The follow-up-run and hand-opened-PR triggers of auth0-management-app are not included: they land with the host code that uses them
  (mpaulosky/dotfiles#313 and mpaulosky/dotfiles#314), now that a Template PR can change the workflow and `lib/` together.

## Consequences

- A re-Apply brings the file to the repos that run Sandcastle. A repo with its own copy drops it from `NOT_OWNED_BASELINE_PATHS`;
  Blazor-Server moves its skills step into `sandcastle-prepare.sh` in the same PR. auth0-management-app keeps its file in that list until
  the follow-up-only and hand-off triggers land in the Template, or its re-Apply would drop them.
- A repo that later adds the token starts running Sandcastle in Actions with no further workflow change.
- A mistyped secret name no longer fails the run loudly: the run is green with a notice. The notice names the secret.
