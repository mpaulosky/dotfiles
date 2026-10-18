// ---------------------------------------------------------------------------
// Queue scope
//
// Only work the repository owner queued and approved reaches an agent (see
// docs/plans/sandcastle-workflow.md, "Labels" and "The round"). Every phase
// reads the open Sandcastle issues through loadQueue, not through
// listSandcastleIssues directly: loadQueue keeps only the issues in this
// run's queue scope (lib/config.mts#QueueScope) whose most recent queueing
// was the repository owner's, with no untrusted edit since, and fixes any
// trust-sensitive label whose most recent add or removal wasn't the
// owner's (#146).
// ---------------------------------------------------------------------------

import { queueLabelOf, type QueueScope } from "./config.mts";
import {
  addIssueLabel,
  bodyEdits,
  hasLabel,
  issueEvents,
  listSandcastleIssues,
  pushAccess,
  removeIssueLabel,
  signedInHostLogin,
  type ContentEdit,
  type IssueEvent,
  type SandcastleIssue,
} from "./github.mts";

let activeScope: QueueScope | undefined;

// Sets the scope every phase reads the queue through for the rest of the
// run. Called once, by main.mts, right after it resolves a scope from the
// environment (lib/config.mts#queueScopeFrom).
export function useQueueScope(scope: QueueScope): void {
  activeScope = scope;
}

// The scope useQueueScope set. Throws when nothing has set one yet, so a
// caller that forgets fails closed instead of silently reading every issue.
export function activeQueueScope(): QueueScope {
  if (activeScope === undefined) {
    throw new Error("No queue scope is active: call useQueueScope before loading the queue.");
  }
  return activeScope;
}

// Tri-state owner check (see lib/github.mts#pushAccess): true when the login
// can push to the repository, false when it definitely can't (including a
// null, deleted actor), undefined when the lookup failed. undefined never
// drives a write: the caller holds the issue back and checks again next
// round.
export type IsOwner = (login: string | null) => boolean | undefined;

// An IsOwner that counts the host's own login as the owner before asking
// `access`. GitHub Actions' host can act as a GitHub App, whose "<app>[bot]"
// login has no collaborator permission, so the lookup would call every label
// the host itself adds or removes (intake's sandcastle:ready, a split's
// children, loadQueue's own restores) a stranger's. `hostLogin` is read only
// when a login needs checking.
export function ownerCheck(hostLogin: () => string, access: IsOwner): IsOwner {
  return (login) => (login !== null && login === hostLogin() ? true : access(login));
}

export type Approval = { approved: true } | { approved: false; reason: string };

// Whether the issue's most recent `labeled` event adding `queueLabel` was
// the repository owner's, and nobody but the owner has renamed the issue or
// edited its body since (see docs/plans/sandcastle-workflow.md, "Labels"):
// only the owner's own queueing, undisturbed by anyone else, reaches an
// agent. Not approved when there's no such event, when its actor isn't
// (definitely) the owner, or when any renamed event or ContentEdit at or
// after that time has a definite non-owner editor. An unknown actor
// anywhere is also not approved, so the issue is held back rather than let
// through on a failed lookup.
export function approval(
  queueLabel: string,
  events: readonly IssueEvent[],
  edits: readonly ContentEdit[],
  isOwner: IsOwner,
): Approval {
  const queued = latest(events, (event) => event.event === "labeled" && sameLabel(event.label, queueLabel));
  if (queued === undefined) return { approved: false, reason: `nothing shows who added ${queueLabel}` };
  const queuer = isOwner(queued.actor);
  if (queuer === undefined) {
    return { approved: false, reason: `couldn't check whether ${who(queued.actor)}, who added ${queueLabel}, is the repository owner` };
  }
  if (!queuer) return { approved: false, reason: `${who(queued.actor)} added ${queueLabel}, not the repository owner` };

  const since = Date.parse(queued.createdAt);
  // Only a change provably before the add is ignored. The same second counts
  // as after, since GitHub's times are to the second, and so does a time that
  // won't parse (fail closed).
  const after = (time: string) => !(Date.parse(time) < since);
  const changes = [
    ...events
      .filter((event) => event.event === "renamed" && after(event.createdAt))
      .map((event) => ({ editor: event.actor, what: "the title" })),
    ...edits.filter((edit) => after(edit.editedAt)).map((edit) => ({ editor: edit.editor, what: "the body" })),
  ];
  const checked = changes.map((change) => ({ ...change, owner: isOwner(change.editor) }));
  const stranger = checked.find((change) => change.owner === false);
  if (stranger !== undefined) {
    return {
      approved: false,
      reason: `${who(stranger.editor)} edited ${stranger.what} after the owner added ${queueLabel}; remove and re-add ${queueLabel} to approve it`,
    };
  }
  const unknown = checked.find((change) => change.owner === undefined);
  if (unknown !== undefined) {
    return {
      approved: false,
      reason: `couldn't check whether ${who(unknown.editor)}, who edited ${unknown.what} after ${queueLabel} was added, is the repository owner`,
    };
  }
  return { approved: true };
}

export type LabelFix = { action: "remove" | "restore"; label: string; reason: string };

// Which of the issue's trust-sensitive labels need fixing, because their
// most recent add or removal wasn't the repository owner's (see
// docs/plans/sandcastle-workflow.md, "Labels"): a label in `rules.trustAdds`
// the issue carries, added by someone other than the owner, is fixed by
// removing it; a label in `rules.trustRemovals` the issue doesn't carry, most
// recently removed by someone other than the owner, is fixed by restoring
// it. An unknown actor anywhere, or a trusted-add label with no `labeled`
// event at all, leaves that label out of `fixes` and names it in `unknown`
// instead, so the caller holds the issue back rather than fix or trust a
// label on a guess.
export function labelOriginFixes(
  labels: readonly string[],
  events: readonly IssueEvent[],
  isOwner: IsOwner,
  rules: { trustAdds: readonly string[]; trustRemovals: readonly string[] },
): { fixes: LabelFix[]; unknown: string[] } {
  const fixes: LabelFix[] = [];
  const unknown: string[] = [];
  const carries = (label: string) => labels.some((name) => sameLabel(name, label));
  for (const label of rules.trustAdds.filter(carries)) {
    const added = latest(events, (event) => event.event === "labeled" && sameLabel(event.label, label));
    // GitHub's events list may not show an add made a moment ago (intake's
    // own, just before the gate reloads the queue), and an issue's history
    // can lack it: a gap holds the issue for a round rather than drive a
    // write.
    if (added === undefined) {
      unknown.push(label);
      continue;
    }
    const owner = isOwner(added.actor);
    if (owner === undefined) unknown.push(label);
    else if (!owner) fixes.push({ action: "remove", label, reason: `removed ${label}, which ${who(added.actor)} added, not the repository owner` });
  }
  for (const label of rules.trustRemovals.filter((label) => !carries(label))) {
    const last = latest(events, (event) => event.event !== "renamed" && sameLabel(event.label, label));
    if (last?.event !== "unlabeled") continue;
    const owner = isOwner(last.actor);
    if (owner === undefined) unknown.push(label);
    else if (!owner) fixes.push({ action: "restore", label, reason: `put back ${label}, which ${who(last.actor)} removed, not the repository owner` });
  }
  return { fixes, unknown };
}

// The most recent event `matches` picks out, by its time; of two at the same
// time, the later in the API's order, which lists events oldest first.
function latest(events: readonly IssueEvent[], matches: (event: IssueEvent) => boolean): IssueEvent | undefined {
  let found: IssueEvent | undefined;
  for (const event of events) {
    if (matches(event) && (found === undefined || Date.parse(event.createdAt) >= Date.parse(found.createdAt))) found = event;
  }
  return found;
}

// GitHub matches label names case-insensitively.
function sameLabel(name: string | null, label: string): boolean {
  return name !== null && name.toLowerCase() === label.toLowerCase();
}

function who(login: string | null): string {
  return login === null ? "a deleted account" : `@${login}`;
}

// The labels loadQueue trusts only from the repository owner: sandcastle:ready
// is trusted only when the owner's own add is its most recent (otherwise
// removed, so intake judges the issue again); sandcastle:needs-info and
// sandcastle:needs-human's removal is trusted as a re-queue only when the
// owner made it (otherwise restored).
export const ISSUE_LABEL_RULES = {
  trustAdds: ["sandcastle:ready"],
  trustRemovals: ["sandcastle:needs-info", "sandcastle:needs-human"],
} as const;

// The GitHub reads and writes loadQueue needs; tests pass a stub. Each
// lookup throws when GitHub can't answer.
export type QueueGitHub = {
  issuesInScope(scope: QueueScope): SandcastleIssue[];
  events(number: number): IssueEvent[];
  bodyEdits(number: number): ContentEdit[];
  isOwner: IsOwner;
  removeLabel(number: number, label: string): void;
  addLabel(number: number, label: string): void;
};

// Skip reasons already logged this run, shared by every loadQueue call
// (the gate, the follow-up sweep and intake each load the queue every
// round), so one skip prints once, not three times.
const skipsLogged = new Set<string>();

// One round's per-issue reads (events and body edits), keyed by what loadQueue
// can see of the issue (see cacheKey).
export type QueueCache = Map<string, { events: IssueEvent[]; edits: ContentEdit[] }>;

let roundCache: QueueCache = new Map();

// Starts a new round's cache. main.mts calls it at the top of every round,
// so the sweep, intake and the gate (each of which loads the queue) share
// one read of each issue's events and body edits: two GitHub requests an
// issue a round, not six, which a full queue over several rounds would
// otherwise spend against the hourly API limit.
export function startQueueRound(): void {
  roundCache = new Map();
}

// An issue's updatedAt, labels, title and body, so a change between phases
// (intake's own label writes, a rename or body edit) reads its events again
// rather than judging it from a stale list. updatedAt catches what the rest
// can't: a label removed and added back by someone else leaves the label set
// as it was, but GitHub moves updatedAt.
function cacheKey(issue: SandcastleIssue): string {
  return JSON.stringify([
    issue.number,
    issue.updatedAt ?? null,
    [...issue.labels].map((label) => label.toLowerCase()).sort(),
    issue.title,
    issue.body,
  ]);
}

// The live QueueGitHub. A factory, so each load gets one fresh set of failed
// permission lookups, shared by the comment filter and isOwner: a login
// whose lookup failed isn't asked about again in the same load, and is
// retried in the next.
export function liveQueueGitHub(): QueueGitHub {
  const failed = new Set<string>();
  return {
    issuesInScope: (scope) => listSandcastleIssues(undefined, undefined, undefined, undefined, scope, failed),
    events: (number) => issueEvents(number),
    bodyEdits: (number) => bodyEdits(number),
    isOwner: ownerCheck(() => signedInHostLogin(), (login) => pushAccess(login, undefined, failed)),
    removeLabel: (number, label) => removeIssueLabel(number, label),
    addLabel: (number, label) => addIssueLabel(number, label),
  };
}

// Lists `scope`, then keeps only the issues the repository owner queued and
// approved (see approval), fixing any untrusted label origin first (see
// labelOriginFixes and ISSUE_LABEL_RULES). An issue outside the scope, not
// approved, or with an unknown label actor is skipped: logged once per run,
// with no comment and no write. Every phase (the gate, the follow-up sweep,
// intake) calls this instead of reading the queue directly, so each one
// filters the same way (#146).
export function loadQueue(
  scope: QueueScope = activeQueueScope(),
  github: QueueGitHub = liveQueueGitHub(),
  log: (line: string) => void = console.log,
  logged: Set<string> = skipsLogged,
  cache: QueueCache = roundCache,
): SandcastleIssue[] {
  const queueLabel = queueLabelOf(scope);
  const skip = (issue: SandcastleIssue, reason: string): void => {
    const line = `  ⊘ #${issue.number} is skipped: ${reason}.`;
    if (logged.has(line)) return;
    logged.add(line);
    log(line);
  };
  const kept: SandcastleIssue[] = [];
  for (const issue of github.issuesInScope(scope)) {
    // Only an issue scope can list an issue without its queue label.
    if (!hasLabel(issue, queueLabel)) {
      skip(issue, `it doesn't carry ${queueLabel}`);
      continue;
    }
    try {
      const key = cacheKey(issue);
      let read = cache.get(key);
      if (read === undefined) {
        read = { events: github.events(issue.number), edits: github.bodyEdits(issue.number) };
        cache.set(key, read);
      }
      const { events } = read;
      const verdict = approval(queueLabel, events, read.edits, github.isOwner);
      if (!verdict.approved) {
        skip(issue, verdict.reason);
        continue;
      }
      const { fixes, unknown } = labelOriginFixes(issue.labels, events, github.isOwner, ISSUE_LABEL_RULES);
      if (unknown.length > 0) {
        skip(issue, `couldn't check whether the repository owner added or removed ${unknown.join(" and ")}, so it's checked again next round`);
        continue;
      }
      let labels = issue.labels;
      for (const fix of fixes) {
        if (fix.action === "remove") {
          github.removeLabel(issue.number, fix.label);
          labels = labels.filter((name) => !sameLabel(name, fix.label));
        } else {
          github.addLabel(issue.number, fix.label);
          labels = [...labels, fix.label];
        }
        log(`  ↺ #${issue.number}: ${fix.reason}.`);
      }
      kept.push({ ...issue, labels });
    } catch (error) {
      skip(issue, `couldn't check who queued it or fix its labels, so it's checked again next round: ${error}`);
    }
  }
  return kept;
}
