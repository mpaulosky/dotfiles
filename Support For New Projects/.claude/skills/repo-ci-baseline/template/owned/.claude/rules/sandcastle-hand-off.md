# Handing a pull request off to Sandcastle

Sandcastle follows up the pull requests it opens: review threads, red checks and falling behind `main`. The `sandcastle:follow-up`
label gives it a pull request you or a session opened, so one you finished can be left to it for the review follow-up.

## What the label does

Sandcastle then follows the pull request up as it does its own: it asks Copilot to review again, updates the branch when it is only
behind `main`, and runs a follow-up pass for a merge conflict, a red check or an unresolved bot or owner review thread. After three passes
it gives up and labels the pull request `sandcastle:needs-human`.

The label counts when the repository's owner adds it, or a session adds it under the owner's token. A label from anyone else does not count,
and neither does one followed by someone else editing the pull request's title or description (remove the label and add it again to approve it).
It covers the commits the pull request had when you added it, and up to five merges of `main` made as the account of `SANDCASTLE_GH_TOKEN` on top
of them. A commit pushed by anyone else afterwards, a force-push, or a merge of `main` made under another account stops the follow-up
until you remove the label and add it again. The pull request must have been opened by the repository's owner or by a session (the owner's token),
so a collaborator can't hand off their own. A repository an organisation owns has no owner login to match, so nothing can be handed off there.

A pull request labelled before the repository began recording heads is not followed up: remove the label and add it again.

## Which pull requests

- Opened by the repository's owner (a session's counts), in the same repository (not a fork), into `main`, not a draft.
- A branch name `scripts/check-branch-name.sh` accepts.
- Only a run on the default `Sandcastle` queue follows hand-offs: GitHub Actions always, a local run only with `SANDCASTLE_LABEL=Sandcastle`.
- The repository runs Sandcastle in GitHub Actions with its `SANDCASTLE_GH_TOKEN` secret set to the account the runs use, since a workflow there
  records the head you label. Without that, nothing can be handed off.

## How to hand one off

- Add the label when your own work on the pull request is finished and it only needs review follow-up. Stop pushing to it after that:
  a push of yours stops the follow-up until you remove the label and add it again.
- Remove the label to take the pull request back. `sandcastle:needs-human` means Sandcastle gave up; address the threads or checks
  yourself, then remove that label to requeue it.
- A session that replied to a review thread before handing off ends the reply with `<!-- claude-session -->`, so Sandcastle sees the
  thread as answered and doesn't answer it a second time.
- Don't add the label to a pull request carrying an accepted security finding: Sandcastle's follow-up can't see the acceptance.
