# Handing a pull request off to Sandcastle

Sandcastle follows up the pull requests it opens: review threads, red checks and falling behind `main`. The `sandcastle:follow-up`
label gives it a pull request you or a session opened rather than Sandcastle, so a pull request you finished can be left to Sandcastle for the review follow-up.

## What the label does

Sandcastle then follows the pull request up as it does its own: it asks Copilot to review again, updates the branch when it is only
behind `main`, and runs a follow-up pass for a merge conflict, a red check or an unresolved bot or owner review thread. The pass pushes
merge commits and fixes to the branch. After three passes it gives up and labels the pull request `sandcastle:needs-human`.

The label counts when the repository's owner adds it, a session adds it under the owner's token, or another login with push access adds it
(the check is the one `sandcastle:ready` has). A label from anyone else does not count, and neither does one followed by someone else editing
the pull request's title or description (add the label again to approve it). The check reads the pull request's events and edits, not its
commits, so a push to the branch after the label is not checked, whoever pushes: a login with push access can still push to the branch after
you label it. To keep a collaborator from handing off their own pull request, it must have been opened by the repository's owner or by a
session (the owner's token), apart from the organisation case below. In a repository an organisation owns, only a pull request opened under the
Sandcastle token can be handed off.

## Which pull requests

- Opened by the repository's owner (a session's pull request counts; in an organisation's repository, under the Sandcastle token instead), in the same repository (not a fork), into `main`, not a draft.
- A branch name `scripts/check-branch-name.sh` accepts.
- Only a run whose queue is the default `Sandcastle` label follows hand-offs: GitHub Actions always, a local run only with `SANDCASTLE_LABEL=Sandcastle`.
  `SANDCASTLE_ISSUE`, or any other `SANDCASTLE_LABEL`, does not.

## How to hand one off

- Add the label when your own work on the pull request is finished and it only needs review follow-up. Stop pushing to it after that,
  because Sandcastle pushes to the same branch.
- Remove the label to take the pull request back. `sandcastle:needs-human` means Sandcastle gave up; address the threads or checks
  yourself, then remove that label to put it back in the queue.
- A session that replied to a review thread before handing off ends the reply with `<!-- claude-session -->`, so Sandcastle sees the
  thread as answered and doesn't answer it a second time.
- Don't add the label to a pull request carrying an accepted security finding: Sandcastle's follow-up can't see the acceptance.
