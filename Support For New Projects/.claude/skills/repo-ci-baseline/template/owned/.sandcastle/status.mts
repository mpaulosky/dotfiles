// Sandcastle status — why is each open Sandcastle pull request held?
//
// Usage:
//   pnpm run sandcastle:status                      (the default queue: issues labelled Sandcastle, and hand-off PRs)
//   SANDCASTLE_ISSUE=<n> pnpm run sandcastle:status (only issue #n and its PR)
//   SANDCASTLE_LABEL=<label> pnpm run sandcastle:status
//
// Read-only: no comment, label or push, no sandbox, no model call. The report is lib/status.mts's.
//
// Exit codes: 0 once the report is printed, whatever is held; 1 when it can't be read (the host's login, the in-scope issues, the
// open PRs or the repository name, or host git is unsafe), with the cause on stderr; 2 for a bad scope variable, before git or gh is
// touched.

import { QueueScopeError, describeQueueScope, type QueueScope } from "./lib/config.mts";
import { protectHostGit } from "./lib/host-safety.mts";
import { useQueueScope } from "./lib/queue.mts";
import { plainStderr, statusCommand, statusScopeFrom, terminalText } from "./lib/status.mts";

// The queue scope comes first, so a bad variable exits with the usage message before git or gh is touched.
let scope: QueueScope;
try {
  scope = statusScopeFrom(process.env);
} catch (error) {
  if (!(error instanceof QueueScopeError)) throw error;
  console.error(error.message);
  process.exit(2);
}
useQueueScope(scope);
// What a read warns on stderr is plain text too.
plainStderr();
console.error(`Queue: ${describeQueueScope(scope)}`);

try {
  // gh reads git's config, and an agent may have written one: pin every git command to this repository's own, as the run
  // does, before the first gh call. This is the only startup step the status takes; the others write to GitHub.
  protectHostGit();
  statusCommand();
} catch (error) {
  // gh's own text (its stderr is in the message) goes to the terminal as plain text, as the report's does.
  console.error(terminalText(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
