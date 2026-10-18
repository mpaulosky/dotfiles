// ---------------------------------------------------------------------------
// Umbrellas
//
// Intake splits an oversized issue into child issues and turns the original
// into an umbrella (see lib/intake.mts#applyVerdicts): it loses Sandcastle
// and carries one comment with UMBRELLA_MARKER listing its children, so
// listSandcastleIssues can no longer see it. Each round the host looks for
// open umbrellas and closes as completed any whose children have all closed
// as completed. One still open, or closed as not planned, keeps the umbrella
// open too: its own work isn't finished either way.
// ---------------------------------------------------------------------------

import { QUEUE_LABEL, queueLabelOf, UMBRELLA_MARKER, type QueueScope } from "./config.mts";
import { closeIssueAsCompleted, issueLabels, openIssuesWithComment, subIssuesOf, type SubIssue } from "./github.mts";
import { activeQueueScope } from "./queue.mts";

// The GitHub reads and writes closing an umbrella needs; tests pass a stub.
export type UmbrellaGitHub = {
  // The open issues carrying UMBRELLA_MARKER.
  openUmbrellas(): number[];
  // The umbrella's children, with enough state to tell whether each closed
  // as completed.
  subIssues(parent: number): SubIssue[];
  // The umbrella's labels (see closeFinishedUmbrellas).
  labels(number: number): string[];
  closeCompleted(number: number): void;
};

export const liveUmbrellaGitHub: UmbrellaGitHub = {
  openUmbrellas: () => openIssuesWithComment(UMBRELLA_MARKER),
  subIssues: subIssuesOf,
  labels: (number) => issueLabels(number),
  closeCompleted: closeIssueAsCompleted,
};

// Closes as completed any open umbrella whose children have all closed as
// completed. Leaves one open while it has no children yet, any child is
// still open, or a child closed as not planned: that child's work never
// landed, so the umbrella's own job isn't done either. `scope` is this run's
// queue scope (#146): in issue scope, only its one issue is considered among
// openUmbrellas(), and the "held" check also matches the scope's own queue
// label, case-insensitively, not just the literal "Sandcastle". Returns the
// numbers of the umbrellas this round closed.
export function closeFinishedUmbrellas(
  github: UmbrellaGitHub = liveUmbrellaGitHub,
  log: (line: string) => void = console.log,
  scope: QueueScope = activeQueueScope(),
): number[] {
  const closed: number[] = [];
  // A split that failed after its umbrella comment landed is handed back
  // with sandcastle:needs-human, and a person may re-queue it with
  // Sandcastle or the scope's own queue label: either way it isn't an
  // umbrella to close (#234).
  const holding = [QUEUE_LABEL, queueLabelOf(scope), "sandcastle:needs-human"].map((label) => label.toLowerCase());
  const umbrellas = github.openUmbrellas().filter((umbrella) => scope.kind === "label" || umbrella === scope.number);
  for (const umbrella of umbrellas) {
    // One umbrella whose children can't be read, or that won't close, waits
    // for the next round without holding up the others.
    try {
      const held = github.labels(umbrella).find((label) => holding.includes(label.toLowerCase()));
      if (held) {
        log(`  ☂ #${umbrella} stays open: it carries ${held}.`);
        continue;
      }
      const children = github.subIssues(umbrella);
      if (children.length === 0) {
        log(`  ☂ #${umbrella} stays open: it has no sub-issues yet.`);
        continue;
      }
      const unfinished = children.filter((child) => !closedAsCompleted(child));
      if (unfinished.length > 0) {
        log(`  ☂ #${umbrella} stays open: ${unfinished.map(describeUnfinished).join(", ")}.`);
        continue;
      }
      github.closeCompleted(umbrella);
      log(`  ☂ Closed #${umbrella} as completed: every child (${children.map((child) => `#${child.number}`).join(", ")}) has.`);
      closed.push(umbrella);
    } catch (error) {
      log(`  ⚠ Couldn't check whether umbrella #${umbrella} is finished, so it's checked again next round: ${error}`);
    }
  }
  return closed;
}

// GitHub reports state and state_reason in lower case over REST, but upper
// case over GraphQL, so neither is assumed.
function closedAsCompleted(child: SubIssue): boolean {
  return child.state.toLowerCase() === "closed" && child.state_reason?.toLowerCase() === "completed";
}

function describeUnfinished(child: SubIssue): string {
  return child.state.toLowerCase() === "closed"
    ? `#${child.number} closed as ${child.state_reason ?? "an unknown reason"}`
    : `#${child.number} is still open`;
}

// The umbrella check as main.mts runs it at the start of each round. A
// failure, such as GitHub's search being unavailable, is logged and the
// umbrellas are checked again next round: closing one is housekeeping, never
// a reason to stop building.
export function umbrellaPhase(
  close: () => number[] = closeFinishedUmbrellas,
  warn: (message: string) => void = console.error,
): void {
  try {
    close();
  } catch (error) {
    warn(`  ✗ Couldn't look for finished umbrellas, so they're checked again next round: ${error}`);
  }
}
