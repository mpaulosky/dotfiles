// ---------------------------------------------------------------------------
// Sandcastle status
//
// The read-only status of the follow-up sweep: for each open Sandcastle pull
// request into main, how many follow-up passes it has used, why Sandcastle is
// holding it (the sweep's own answer), its unresolved threads split into bot,
// owner and other, and the Sandcastle workflow's recent runs. It owns the
// report's data and rendering, and writes nothing to GitHub or git.
// ---------------------------------------------------------------------------

import type { QueueScope } from "./config.mts";
import type { WorkflowRun } from "./github.mts";
import type {
  FollowUpGitHub,
  SweepContext,
  SweepDecision,
  SweepPullRequest,
  SweepSubject,
  LabelOriginHold,
} from "./follow-up.mts";
import type { QueueGitHub } from "./queue.mts";

// The reads status needs. Only reads, so the type itself keeps the command read-only. `repo` and `queueScope` name what the
// report is about.
export type StatusGitHub = Pick<
  FollowUpGitHub,
  | "hostLogin"
  | "openPullRequests"
  | "inScopeIssues"
  | "followsHandOffs"
  | "pullRequestEvents"
  | "pullRequestBodyEdits"
  | "pullRequestComments"
  | "mergeOfMain"
  | "isOwner"
  | "repositoryOwner"
  | "reviewThreads"
> & {
  passesUsed(pr: number): number;
  workflowRuns(limit: number): WorkflowRun[];
  repo(): string;
  queueScope(): QueueScope;
};

// Where a PR stands with the sweep.
export type Held = {
  state: "skipped" | "waiting" | "pass due" | "hand-back due" | "act next sweep" | "settled";
  reason: string;
};

// A PR's unresolved threads by who opened them; `answered` are the ones the host replied to, which wait on the owner.
export type ThreadSplit = { bot: number; owner: number; other: number; answered: number };

// One PR's line in the report. A field that couldn't be read is `{ unreadable }` with the reason.
export type PrStatus = {
  number: number;
  title: string;
  headRefName: string;
  subject: "issue" | "hand-off" | "not swept";
  issueNumber?: number;
  passes: { used: number; cap: number } | { unreadable: string };
  held: Held;
  threads: ThreadSplit | { unreadable: string };
  mergeState: string;
  draft: boolean;
  labels: string[];
};

export type StatusReport = {
  repo: string;
  scope: string;
  prs: PrStatus[];
  unlisted: number;
  runs: WorkflowRun[] | { unreadable: string };
};

// Which open PRs are listed: Sandcastle's own, and any same-repo PR into main carrying the owner's hand-off label.
export function isListed(_pr: SweepPullRequest, _host: string): boolean {
  throw new Error("Not implemented");
}

// The sweep's own answer for one PR, in the sweep's order. No writes.
export function heldReason(_args: {
  pr: SweepPullRequest;
  admitted: { subject: SweepSubject } | { skip: string };
  origin: LabelOriginHold | undefined;
  decision?: SweepDecision;
  passesUsed?: number;
  answered: number;
  human: number;
}): Held {
  throw new Error("Not implemented");
}

// One PR's status.
export function statusOf(
  _pr: SweepPullRequest,
  _ctx: { context: SweepContext; now: number },
  _github: StatusGitHub,
  _log: (line: string) => void,
): PrStatus {
  throw new Error("Not implemented");
}

// Reads everything the report shows.
export function collectStatus(_github: StatusGitHub, _now: number = Date.now(), _log: (line: string) => void = console.error): StatusReport {
  throw new Error("Not implemented");
}

// The report as plain text lines.
export function renderStatus(_report: StatusReport): string[] {
  throw new Error("Not implemented");
}

// The queue scope status reports on: the default scope when the environment names none.
export function statusScopeFrom(_env: Record<string, string | undefined>): QueueScope {
  throw new Error("Not implemented");
}

// The in-scope issues, read through loadQueue with its label fixes switched off, so reading the queue changes nothing.
export function statusQueue(
  _scope: QueueScope,
  _queue: QueueGitHub,
  _log: (line: string) => void,
): { number: number; labels: string[] }[] {
  throw new Error("Not implemented");
}

// Collects and prints the report; returns it.
export function statusCommand(
  _github: StatusGitHub = liveStatusGitHub,
  _print: (line: string) => void = console.log,
  _now: number = Date.now(),
): StatusReport {
  throw new Error("Not implemented");
}

export const liveStatusGitHub: StatusGitHub = {
  hostLogin: () => {
    throw new Error("Not implemented");
  },
  openPullRequests: () => {
    throw new Error("Not implemented");
  },
  inScopeIssues: () => {
    throw new Error("Not implemented");
  },
  followsHandOffs: () => {
    throw new Error("Not implemented");
  },
  pullRequestEvents: () => {
    throw new Error("Not implemented");
  },
  pullRequestBodyEdits: () => {
    throw new Error("Not implemented");
  },
  pullRequestComments: () => {
    throw new Error("Not implemented");
  },
  mergeOfMain: () => {
    throw new Error("Not implemented");
  },
  isOwner: () => {
    throw new Error("Not implemented");
  },
  repositoryOwner: () => {
    throw new Error("Not implemented");
  },
  reviewThreads: () => {
    throw new Error("Not implemented");
  },
  passesUsed: () => {
    throw new Error("Not implemented");
  },
  workflowRuns: () => {
    throw new Error("Not implemented");
  },
  repo: () => {
    throw new Error("Not implemented");
  },
  queueScope: () => {
    throw new Error("Not implemented");
  },
};
