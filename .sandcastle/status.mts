// Sandcastle status — why is each open Sandcastle pull request held?
//
// Usage:
//   pnpm run sandcastle:status                      (the default queue: issues labelled Sandcastle, and hand-off PRs)
//   SANDCASTLE_ISSUE=<n> pnpm run sandcastle:status (only issue #n and its PR)
//   SANDCASTLE_LABEL=<label> pnpm run sandcastle:status
//
// Read-only: no comment, label or push, no sandbox, no model call. The report is lib/status.mts's.

throw new Error("Not implemented");
