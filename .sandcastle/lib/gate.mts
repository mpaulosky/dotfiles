// ---------------------------------------------------------------------------
// Blocker gate
//
// An issue is blocked while any issue it depends on is unfinished. Blockers
// come from two places: GitHub's native "blocked by" relationships and lines
// in the issue body that start with "Blocked by #N" or "Depends on #N". A
// blocker is finished only when it closed as completed (for an issue) or was
// merged (for a PR). An open blocker, one closed as not planned or duplicate,
// or a PR closed without merging keeps the dependent issue blocked, since the
// code it needs never reached main. The gate also holds back an issue intake
// hasn't cleared (no sandcastle:ready) or that's handed back to a human
// (sandcastle:needs-info or sandcastle:needs-human), so the planner never
// sees one (#74). The gate reads the queue through lib/queue.mts#loadQueue,
// so an issue outside the run's queue scope, or one the repository owner
// didn't approve, never reaches it (#146).
// ---------------------------------------------------------------------------

import { isIssueBranch } from "./branches.mts";
import { BUILDING_LABEL } from "./config.mts";
import { hasLabel, openPullRequests, repoName, type OpenPullRequest, type SandcastleIssue } from "./github.mts";
import { loadQueue } from "./queue.mts";
import { sh } from "./shell.mts";

export type Blocker = {
  number: number;
  state: string;
  state_reason: string | null;
  merged_at: string | null;
  is_pr: boolean;
};

const blockerFields =
  "{number, state, state_reason, merged_at: (.pull_request.merged_at // null), is_pr: (.pull_request != null)}";

// The GitHub reads the gate needs; tests pass a stub. The lookups throw when
// GitHub can't answer.
export type GateGitHub = {
  sandcastleIssues(): SandcastleIssue[];
  openPullRequests(): OpenPullRequest[];
  // The issue's native "blocked by" links.
  nativeBlockers(issueNumber: number): Blocker[];
  blocker(number: number): Blocker;
};

export const liveGitHub: GateGitHub = {
  sandcastleIssues: () => loadQueue(),
  openPullRequests,
  nativeBlockers: (issueNumber) =>
    sh(
      process.cwd(), "gh", "api", "--paginate", `repos/${repoName()}/issues/${issueNumber}/dependencies/blocked_by`,
      "--jq", `.[] | ${blockerFields}`,
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Blocker),
  blocker: (number) =>
    JSON.parse(sh(process.cwd(), "gh", "api", `repos/${repoName()}/issues/${number}`, "--jq", blockerFields)) as Blocker,
};

// Undefined when the lookup fails (a mistyped number 404s, the network drops).
// Callers treat that as still blocking, so one bad reference holds back only
// its own issue instead of aborting the whole run.
function fetchBlocker(number: number, cache: Map<number, Blocker>, github: GateGitHub): Blocker | undefined {
  let blocker = cache.get(number);
  if (!blocker) {
    try {
      blocker = github.blocker(number);
    } catch {
      return undefined;
    }
    cache.set(number, blocker);
  }
  return blocker;
}

// Issue numbers named on "Blocked by #N" / "Depends on #N" lines in the body.
// Only line starts count, so prose such as "reuses the generator from #22"
// doesn't create a dependency.
export function bodyBlockers(body: string): number[] {
  const numbers: number[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*(?:[-*]\s+)?\**(?:blocked by|depends on)\**:?\s*(.*)$/i.exec(line);
    if (!match) continue;
    for (const ref of match[1]!.matchAll(/(?<![\w/])#(\d+)\b/g)) numbers.push(Number(ref[1]));
  }
  return numbers;
}

// Why a blocker still blocks, or undefined when it has landed.
export function unfinishedReason(blocker: Blocker): string | undefined {
  const ref = `#${blocker.number}`;
  if (blocker.state === "open") return `${ref} is still open`;
  if (blocker.is_pr) return blocker.merged_at ? undefined : `${ref} was closed without merging`;
  if (blocker.state_reason === "completed") return undefined;
  return `${ref} was closed as ${blocker.state_reason ?? "unknown"}, so its work never landed`;
}

// Why intake hasn't cleared the issue to build yet, or undefined once it has
// (see docs/plans/sandcastle-workflow.md, "Phase 3: Blocker gate"): it isn't
// marked sandcastle:ready, or it's labelled sandcastle:needs-info or
// sandcastle:needs-human (#74).
export function readinessReason(issue: SandcastleIssue): string | undefined {
  // The hand-back labels come first: an issue can carry sandcastle:ready and
  // still be handed back, and the reason should name what a human must do.
  if (hasLabel(issue, "sandcastle:needs-human")) return "it's handed back with sandcastle:needs-human";
  if (hasLabel(issue, "sandcastle:needs-info")) return "it's waiting for answers to intake's questions (sandcastle:needs-info)";
  if (!hasLabel(issue, "sandcastle:ready")) return "intake hasn't marked it sandcastle:ready yet";
  return undefined;
}

// Why an issue waits for review rather than an agent, or undefined when no open
// PR's head is its feature/{n}-*, fix/{n}-* or hotfix/{n}-* branch.
export function openPrReason(issueNumber: number, openPrs: OpenPullRequest[]): string | undefined {
  const pr = openPrFor(issueNumber, openPrs);
  return pr ? prReason(pr) : undefined;
}

function openPrFor(issueNumber: number, openPrs: OpenPullRequest[]): OpenPullRequest | undefined {
  return openPrs.find((candidate) => isIssueBranch(candidate.headRefName, issueNumber));
}

function prReason(pr: OpenPullRequest): string {
  return `PR #${pr.number} (${pr.headRefName}) is already open for it`;
}

// A held-back issue, why it waits, and the open PR holding it back, if any.
export type HeldBackIssue = { issue: SandcastleIssue; reasons: string[]; pr?: OpenPullRequest };

// Split the open Sandcastle issues into those ready to plan and those waiting
// on intake or a human (see readinessReason), an unfinished blocker, an open
// PR or another run building them (sandcastle:building), with the reasons for
// each held-back issue and its open PR, which the critique compares the
// round's picks with.
// Blockers are resolved afresh on every call: an issue whose blocker's PR
// merged during the previous round becomes ready now.
export function gateIssues(
  github: GateGitHub = liveGitHub,
): { ready: SandcastleIssue[]; blocked: HeldBackIssue[] } {
  const issues = github.sandcastleIssues();
  const openPrs = github.openPullRequests();
  const cache = new Map<number, Blocker>();

  const ready: SandcastleIssue[] = [];
  const blocked: HeldBackIssue[] = [];

  for (const issue of issues) {
    // Its work is waiting for review, not for an agent. Checked first, so its
    // blockers aren't looked up for nothing.
    const pr = openPrFor(issue.number, openPrs);
    if (pr) {
      blocked.push({ issue, reasons: [prReason(pr)], pr });
      continue;
    }

    // Another Sandcastle run is building it right now (#150).
    if (hasLabel(issue, BUILDING_LABEL)) {
      blocked.push({ issue, reasons: ["it's already being built"] });
      continue;
    }

    // Intake hasn't cleared it yet (#74). Checked before the native blockers
    // are read, so an issue without sandcastle:ready isn't looked up for
    // nothing.
    const readiness = readinessReason(issue);
    if (readiness) {
      blocked.push({ issue, reasons: [readiness] });
      continue;
    }

    let native: Blocker[];
    try {
      native = github.nativeBlockers(issue.number);
    } catch {
      // Without its native links the issue's blockers are unknown, so hold it back.
      blocked.push({ issue, reasons: ["its GitHub \"blocked by\" links couldn't be read"] });
      continue;
    }
    for (const blocker of native) cache.set(blocker.number, blocker);

    const numbers = new Set([...native.map((b) => b.number), ...bodyBlockers(issue.body)]);
    numbers.delete(issue.number);

    const reasons = [...numbers]
      .map((number) => {
        const blocker = fetchBlocker(number, cache, github);
        return blocker ? unfinishedReason(blocker) : `#${number} couldn't be fetched`;
      })
      .filter((reason): reason is string => reason !== undefined);

    if (reasons.length > 0) blocked.push({ issue, reasons });
    else ready.push(issue);
  }

  return { ready, blocked };
}
