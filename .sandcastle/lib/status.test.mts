import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  COPILOT_REVIEWER,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_PASS_CAP,
  FOLLOW_UP_REPLY_MARKER,
  PR_MARKER,
  QUEUE_LABEL,
  QueueScopeError,
  describeQueueScope,
  type QueueScope,
} from "./config.mts";
import type { ContentEdit, IssueEvent, ReviewThread, SandcastleIssue, TimestampedComment, WorkflowRun, MainMerge } from "./github.mts";
import { approvedHeadComment, decide, type SweepContext, type SweepPullRequest } from "./follow-up.mts";
import type { QueueGitHub } from "./queue.mts";
import {
  collectStatus,
  heldReason,
  PASS_MAY_SKIP,
  isListed,
  plainStderr,
  liveStatusGitHub,
  renderStatus,
  terminalLine,
  terminalText,
  statusCommand,
  statusOf,
  statusQueue,
  statusScopeFrom,
  type PrStatus,
  type StatusGitHub,
  type StatusReport,
} from "./status.mts";

// `pnpm run sandcastle:status`: why is each open Sandcastle pull request held? The status gives the sweep's own answer
// (lib/follow-up.mts), and is read-only.

const HOST = "sandcastle-bot";
const OWNER = "owner";
const BRANCH = "feature/42-add-search";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const HEAD = "a".repeat(40);
const LABELLED_AT = "2026-10-09T10:00:00Z";
const RECORDED_AT = "2026-10-09T10:05:00Z";

// A settled, CLEAN Sandcastle PR on issue 42's branch, reviewed by Copilot with every check green.
function pr(overrides: Partial<SweepPullRequest> = {}): SweepPullRequest {
  return {
    number: 101,
    title: "feat: Add search",
    author: HOST,
    body: `${PR_MARKER}\nCloses #42`,
    baseRefName: "main",
    headRefName: BRANCH,
    isCrossRepository: false,
    id: "PR_101",
    headRefOid: HEAD,
    isDraft: false,
    labels: [],
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    reviews: [{ author: COPILOT_REVIEWER, commitOid: HEAD }],
    threads: [],
    checks: [{ name: "build", completed: true, green: true, completedAt: "2026-10-10T09:00:00Z" }],
    copilotRequestedAt: [],
    truncated: false,
    ...overrides,
  };
}

// A Sandcastle PR for issue `issue`.
const issuePr = (issue: number, overrides: Partial<SweepPullRequest> = {}) =>
  pr({
    number: 100 + issue,
    id: `PR_${100 + issue}`,
    title: `feat: Issue ${issue}`,
    body: `${PR_MARKER}\nCloses #${issue}`,
    headRefName: `feature/${issue}-thing`,
    ...overrides,
  });

// A PR the owner opened on a chore/ branch with no Sandcastle marker, labelled sandcastle:follow-up.
const handOffPr = (overrides: Partial<SweepPullRequest> = {}) =>
  pr({
    number: 201,
    id: "PR_201",
    title: "chore: Tidy the build",
    author: OWNER,
    body: "Tidies the build scripts.",
    headRefName: "chore/tidy-the-build",
    labels: [FOLLOW_UP_LABEL],
    ...overrides,
  });

const labelledBy = (actor: string): IssueEvent => ({ event: "labeled", actor, label: FOLLOW_UP_LABEL, createdAt: LABELLED_AT });
const ownerLabelled = [labelledBy(OWNER)];
const unlabelled = (actor: string): IssueEvent => ({ event: "unlabeled", actor, label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" });
const headRecord = (head: string, author = HOST): TimestampedComment => ({ author, createdAt: RECORDED_AT, updatedAt: RECORDED_AT, body: approvedHeadComment(head) });

const ownerIs = (owner: string) => (login: string | null) => (login === null ? false : login === owner);

// A thread of review comments, the first by `author`.
function thread(author: string, byBot: boolean, more: { author: string; body: string }[] = []): ReviewThread {
  return {
    id: "RT_1",
    resolved: false,
    outdated: false,
    path: null,
    line: null,
    comments: [{ author, byBot, body: "Please change this.", url: "" }, ...more.map((comment) => ({ ...comment, byBot: false, url: "" }))],
  };
}
const hostReply = { author: HOST, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined: it reads better as it is.` };
const unresolved = (author: string, byBot = false) => ({ resolved: false, byBot, author });

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 9001,
  status: "completed",
  conclusion: "success",
  event: "schedule",
  branch: "main",
  createdAt: "2026-10-10T08:00:00Z",
  url: "https://github.com/o/r/actions/runs/9001",
  ...overrides,
});

// What terminalText must never leave in the hostile text these tests feed it (none has a joiner between two pictographs or two letters,
// which terminalText keeps): a control, format (bidi, zero-width, tag, soft hyphen) or surrogate character, a variation selector,
// a noncharacter, a default-ignorable code point, a supplementary private-use one and the fillers that draw as blanks.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u034f\u115f\u1160\u2800\u3164\uffa0\u{F0000}-\u{10FFFF}]/u;

const SCOPE: QueueScope = { kind: "label", label: QUEUE_LABEL };

// A StatusGitHub stub serving `prs`, `issues` and the rest, that also carries a spy for every write the sweep makes, which
// the type doesn't have: a status that reached for one would record it in `writes`.
function statusGithub({
  prs = [pr()],
  issues = [{ number: 42, labels: [] }],
  host = HOST,
  isOwner = ownerIs(OWNER),
  events = () => [],
  reviewThreads,
  comments,
  mergeOfMain = () => ({ problem: "not stubbed" }),
  followsHandOffs = true,
  passes = () => 1,
  runs = () => [],
  scope = SCOPE,
}: {
  prs?: SweepPullRequest[];
  issues?: { number: number; labels: string[] }[];
  host?: string;
  isOwner?: (login: string | null) => boolean | undefined;
  events?: (number: number) => IssueEvent[];
  reviewThreads?: (number: number) => ReviewThread[];
  comments?: (number: number) => TimestampedComment[];
  mergeOfMain?: (commit: string) => MainMerge;
  followsHandOffs?: boolean;
  passes?: (number: number) => number;
  runs?: (limit: number) => WorkflowRun[];
  scope?: QueueScope;
} = {}) {
  const writes: string[] = [];
  const reads: { runs: number[] } = { runs: [] };
  const spy = (name: string) => () => void writes.push(name);
  const base: StatusGitHub = {
    hostLogin: () => host,
    openPullRequests: () => prs,
    inScopeIssues: () => issues,
    followsHandOffs: () => followsHandOffs,
    pullRequestEvents: events,
    pullRequestBodyEdits: (): ContentEdit[] => [],
    pullRequestComments: (number) => comments?.(number) ?? prs.filter((candidate) => candidate.number === number).map((candidate) => headRecord(candidate.headRefOid, host)),
    mergeOfMain,
    isOwner,
    repositoryOwner: () => OWNER,
    reviewThreads: (number) =>
      reviewThreads?.(number) ??
      (prs.find((candidate) => candidate.number === number)?.threads ?? []).map((summary, index) => ({
        id: `RT_${number}_${index}`,
        resolved: summary.resolved,
        outdated: false,
        path: null,
        line: null,
        comments: [{ author: summary.author ?? "", byBot: summary.byBot, body: "", url: "" }],
      })),
    passesUsed: passes,
    workflowRuns: (limit) => {
      reads.runs.push(limit);
      return runs(limit);
    },
    repo: () => "o/r",
    queueScope: () => scope,
  };
  const github = Object.assign(base, {
    requestCopilotReview: spy("requestCopilotReview"),
    updateBranch: spy("updateBranch"),
    handBack: spy("handBack"),
    addPullRequestLabel: spy("addPullRequestLabel"),
    recordApprovedHead: spy("recordApprovedHead"),
    commentOnPullRequest: spy("commentOnPullRequest"),
    closedPullRequests: spy("closedPullRequests"),
  });
  return { github: github as StatusGitHub, writes, reads };
}

const context = (overrides: Partial<SweepContext> = {}): { context: SweepContext; now: number } => ({
  context: { inScope: new Set([42]), host: HOST, building: new Set<number>(), followsHandOffs: true, ...overrides },
  now: NOW,
});

const statusFor = (candidate: SweepPullRequest, options: Parameters<typeof statusGithub>[0] = {}, ctx = context()) =>
  statusOf(candidate, ctx, statusGithub({ prs: [candidate], ...options }).github, () => {});

describe("isListed", () => {
  it("lists a Sandcastle PR, drafts included", () => {
    assert.equal(isListed(pr(), HOST), true);
    assert.equal(isListed(pr({ isDraft: true }), HOST), true);
  });

  it("lists a same-repo PR into main carrying the owner's hand-off label, so the owner sees why a label doesn't count", () => {
    assert.equal(isListed(handOffPr(), HOST), true);
  });

  it("doesn't list a PR from a fork, even with the hand-off label", () => {
    assert.equal(isListed(handOffPr({ isCrossRepository: true }), HOST), false);
  });

  it("doesn't list a PR into another branch, even with the hand-off label", () => {
    assert.equal(isListed(handOffPr({ baseRefName: "develop" }), HOST), false);
  });

  it("doesn't list a collaborator's PR with no hand-off label", () => {
    assert.equal(isListed(pr({ author: "a-collaborator", body: "Closes #42" }), HOST), false);
    assert.equal(isListed(handOffPr({ labels: [] }), HOST), false);
  });
});

describe("heldReason", () => {
  const admitted = { subject: { kind: "issue", issueNumber: 42 } } as const;
  const base = { pr: pr(), admitted, origin: undefined, answered: 0, human: 0 };

  it("says a PR the sweep skips isn't swept, with the sweep's own reason", () => {
    assert.deepEqual(heldReason({ ...base, admitted: { skip: "it's a draft" } }), { state: "skipped", reason: "isn't swept: it's a draft" });
  });

  it("puts a skip before everything else", () => {
    const held = heldReason({ ...base, admitted: { skip: "it's a draft" }, origin: { kind: "unknown" }, decision: { action: "leave", reason: "x" } });

    assert.equal(held.reason, "isn't swept: it's a draft");
  });

  it("says when it couldn't check whether the owner removed sandcastle:needs-human", () => {
    assert.deepEqual(heldReason({ ...base, origin: { kind: "unknown" } }), {
      state: "skipped",
      reason: "couldn't check whether the repository owner removed sandcastle:needs-human",
    });
  });

  it("says the sweep puts back a label a stranger removed", () => {
    const origin = { kind: "restore", label: "sandcastle:needs-human", reason: "put back sandcastle:needs-human, which @stranger removed, not the repository owner" } as const;

    assert.deepEqual(heldReason({ ...base, origin, decision: { action: "leave", reason: "x" } }), {
      state: "skipped",
      reason: "put back sandcastle:needs-human, which @stranger removed, not the repository owner; the sweep puts the label back",
    });
  });

  it("is waiting, with the sweep's reason, for a wait", () => {
    assert.deepEqual(heldReason({ ...base, decision: { action: "wait", reason: "checks are still running" } }), { state: "waiting", reason: "checks are still running" });
  });

  it("is flagged for a pass, with the reasons joined and a note that the pass may skip it, for a PR that needs a pass and has passes left", () => {
    const held = heldReason({ ...base, decision: { action: "needs-pass", reasons: ["check build is red", "1 unresolved bot thread(s)"] }, passesUsed: FOLLOW_UP_PASS_CAP - 1 });

    assert.deepEqual(held, { state: "flagged for a pass", reason: `check build is red; 1 unresolved bot thread(s) (${PASS_MAY_SKIP})` });
  });

  it("is flagged for a hand-back, as planPass's cap check, once the passes are used up", () => {
    const held = heldReason({ ...base, decision: { action: "needs-pass", reasons: ["check build is red", "it has merge conflicts"] }, passesUsed: FOLLOW_UP_PASS_CAP });

    assert.deepEqual(held, {
      state: "flagged for a hand-back",
      reason: `has had ${FOLLOW_UP_PASS_CAP} of ${FOLLOW_UP_PASS_CAP} passes and is flagged for another (check build is red; it has merge conflicts); a pass that has something to act on hands it back with sandcastle:needs-human (${PASS_MAY_SKIP})`,
    });
  });

  it("is waiting, with the reason, when the sweep has no decision for an admitted PR yet", () => {
    assert.deepEqual(heldReason({ ...base, decision: undefined }), { state: "waiting", reason: "the sweep has no decision for it yet" });
  });

  it("acts next sweep: Copilot will be asked to review the head", () => {
    assert.deepEqual(heldReason({ ...base, decision: { action: "request-review" } }), { state: "act next sweep", reason: "Copilot will be asked to review the head" });
  });

  it("acts next sweep: the branch will be updated from main", () => {
    assert.deepEqual(heldReason({ ...base, decision: { action: "update-branch" } }), { state: "act next sweep", reason: "it will be updated from main" });
  });

  it("is settled, with the sweep's reason, for a PR it leaves alone", () => {
    assert.deepEqual(heldReason({ ...base, decision: { action: "leave", reason: "it's settled and CLEAN" } }), { state: "settled", reason: "it's settled and CLEAN" });
  });

  it("adds the answered threads that wait on the owner, then the threads from others that wait on a person", () => {
    const decision = { action: "wait", reason: "checks are still running" } as const;

    assert.equal(heldReason({ ...base, decision, answered: 2 }).reason, "checks are still running; 2 answered thread(s) wait on the owner");
    assert.equal(heldReason({ ...base, decision, human: 1 }).reason, "checks are still running; 1 thread(s) from others wait on a person");
    assert.equal(heldReason({ ...base, decision, answered: 2, human: 1 }).reason, "checks are still running; 2 answered thread(s) wait on the owner; 1 thread(s) from others wait on a person");
  });

  it("adds neither note for no such threads", () => {
    assert.equal(heldReason({ ...base, decision: { action: "leave", reason: "settled" } }).reason, "settled");
  });
});

describe("statusOf", () => {
  it("describes a settled Sandcastle issue PR: passes used, held, threads, branch state", () => {
    const status = statusFor(pr({ labels: ["review:claude"] }));

    assert.equal(status.number, 101);
    assert.equal(status.title, "feat: Add search");
    assert.equal(status.headRefName, BRANCH);
    assert.equal(status.subject, "issue");
    assert.equal(status.issueNumber, 42);
    assert.deepEqual(status.passes, { used: 1, cap: FOLLOW_UP_PASS_CAP });
    assert.deepEqual(status.held, { state: "settled", reason: "it's settled and CLEAN" });
    assert.deepEqual(status.threads, { bot: 0, owner: 0, other: 0, answered: 0 });
    assert.equal(status.mergeState, "CLEAN");
    assert.equal(status.draft, false);
    assert.ok(status.labels.includes("review:claude"));
  });

  it("reads the passes used of the PR itself", () => {
    const asked: number[] = [];

    const status = statusFor(pr(), { passes: (number) => (asked.push(number), 2) });

    assert.deepEqual(status.passes, { used: 2, cap: FOLLOW_UP_PASS_CAP });
    assert.deepEqual(asked, [101]);
  });

  it("says a draft PR isn't swept, and why", () => {
    const status = statusFor(pr({ isDraft: true }));

    assert.equal(status.subject, "not swept");
    assert.equal(status.draft, true);
    assert.deepEqual(status.held, { state: "skipped", reason: "isn't swept: it's a draft" });
  });

  it("says a PR labelled sandcastle:needs-human isn't swept", () => {
    const status = statusFor(pr({ labels: ["sandcastle:needs-human"] }));

    assert.equal(status.subject, "not swept");
    assert.equal(status.held.state, "skipped");
    assert.match(status.held.reason, /sandcastle:needs-human/);
  });

  it("says a PR whose issue a run is building isn't swept", () => {
    const status = statusFor(pr(), {}, context({ building: new Set([42]) }));

    assert.equal(status.held.state, "skipped");
    assert.match(status.held.reason, /sandcastle:building/);
  });

  it("describes an owner-labelled hand-off PR as a hand-off, with no issue", () => {
    const status = statusFor(handOffPr(), { events: () => ownerLabelled });

    assert.equal(status.subject, "hand-off");
    assert.equal(status.issueNumber, undefined);
    assert.equal(status.held.state, "settled");
  });

  it("says why a hand-off PR's label doesn't count", () => {
    const status = statusFor(handOffPr(), { events: () => ownerLabelled, comments: () => [headRecord("d".repeat(40))] });

    assert.equal(status.subject, "not swept");
    assert.equal(status.held.state, "skipped");
    assert.match(status.held.reason, new RegExp(`its ${FOLLOW_UP_LABEL} label doesn't count`));
  });

  it("follows a hand-off PR through a merge of main without recording the head", () => {
    const head = "b".repeat(40);
    const { github, writes } = statusGithub({
      prs: [handOffPr({ headRefOid: head, reviews: [{ author: COPILOT_REVIEWER, commitOid: head }] })],
      events: () => ownerLabelled,
      comments: () => [headRecord(HEAD)],
      mergeOfMain: (commit) => (commit === head ? { firstParent: HEAD } : { problem: "not a merge" }),
    });
    const lines: string[] = [];

    const status = statusOf(handOffPr({ headRefOid: head, reviews: [{ author: COPILOT_REVIEWER, commitOid: head }] }), context(), github, (line) => lines.push(line));

    assert.equal(status.subject, "hand-off");
    assert.deepEqual(writes, []);
    assert.deepEqual(lines, []);
  });

  it("splits the unresolved threads into bot, owner and other", () => {
    const status = statusFor(
      pr({ threads: [unresolved("copilot", true), unresolved("copilot", true), unresolved(OWNER), unresolved("someone"), { resolved: true, byBot: true, author: "copilot" }] }),
    );

    assert.deepEqual(status.threads, { bot: 2, owner: 1, other: 1, answered: 0 });
    assert.deepEqual(status.held, {
      state: "flagged for a pass",
      reason: `2 unresolved bot thread(s); 1 unresolved owner thread(s) (${PASS_MAY_SKIP}); 1 thread(s) from others wait on a person`,
    });
  });

  it("counts a thread whose opener can't be checked as other", () => {
    const status = statusFor(pr({ threads: [unresolved("ghost")] }), { isOwner: (login) => (login === "ghost" ? undefined : login === OWNER) });

    assert.deepEqual(status.threads, { bot: 0, owner: 0, other: 1, answered: 0 });
  });

  it("counts a thread the host answered as answered, not as bot, and says it waits on the owner", () => {
    const status = statusFor(pr({ threads: [unresolved("copilot", true)] }), { reviewThreads: () => [thread("copilot", true, [hostReply])] });

    assert.deepEqual(status.threads, { bot: 0, owner: 0, other: 0, answered: 1 });
    assert.deepEqual(status.held, { state: "settled", reason: "it's settled and CLEAN; 1 answered thread(s) wait on the owner" });
  });

  it("decides as the sweep does: its decision for the PR with the answered threads taken out", () => {
    const candidate = pr({ threads: [unresolved("copilot", true)] });
    const answered = [thread("copilot", true, [hostReply])];

    assert.equal(decide(candidate, NOW, ownerIs(OWNER)).action, "needs-pass");
    assert.equal(statusFor(candidate, { reviewThreads: () => answered }).held.state, "settled");
  });

  it("says a PR whose threads can't be read is held, with the cause, as the sweep leaves it alone", () => {
    const status = statusFor(pr({ threads: [unresolved("copilot", true)] }), {
      reviewThreads: () => {
        throw new Error("gh: HTTP 502");
      },
    });

    assert.ok("unreadable" in status.threads && status.threads.unreadable.includes("HTTP 502"));
    assert.deepEqual(status.held, { state: "waiting", reason: "its threads couldn't be read (gh: HTTP 502), so the sweep leaves it alone this round" });
  });

  it("names the cause of a thread step that fails outside the thread read (the owner check throws), never [object Object]", () => {
    const status = statusFor(pr({ threads: [unresolved("alice")] }), {
      isOwner: () => {
        throw new Error("gh: HTTP 401 on the owner check");
      },
    });

    assert.deepEqual(status.threads, { unreadable: "gh: HTTP 401 on the owner check" });
    assert.deepEqual(status.held, {
      state: "waiting",
      reason: "its threads couldn't be read (gh: HTTP 401 on the owner check), so the sweep leaves it alone this round",
    });
  });

  it("shows a conflicting PR's thread read failing as unknown, and still flags it, since decide flags it whatever its threads say", () => {
    const status = statusFor(pr({ mergeStateStatus: "DIRTY", threads: [unresolved("copilot", true)] }), {
      passes: () => 0,
      reviewThreads: () => {
        throw new Error("gh: HTTP 502");
      },
    });

    assert.ok("unreadable" in status.threads && status.threads.unreadable.includes("HTTP 502"), JSON.stringify(status.threads));
    assert.equal(status.held.state, "flagged for a pass");
    assert.match(status.held.reason, /it has merge conflicts/);
  });

  it("keeps the report, with the cause, when decide throws for one PR (a time that doesn't parse), and prints the other PRs", () => {
    const broken = issuePr(42, { checks: [{ name: "build", completed: true, green: true, completedAt: "not a time" }] });
    const { github } = statusGithub({ prs: [broken, issuePr(43)], issues: [{ number: 42, labels: [] }, { number: 43, labels: [] }] });

    const report = collectStatus(github, NOW, () => {});

    assert.deepEqual(report.prs.map((status) => status.number), [142, 143]);
    assert.equal(report.prs[0]!.held.state, "skipped");
    assert.match(report.prs[0]!.held.reason, /^couldn't decide: .*doesn't parse/);
    assert.deepEqual(report.prs[1]!.held, { state: "settled", reason: "it's settled and CLEAN" });
  });

  it("shows the passes as unreadable, and carries on, when they can't be read", () => {
    const status = statusFor(pr(), {
      passes: () => {
        throw new Error("gh: HTTP 500");
      },
    });

    assert.ok("unreadable" in status.passes && status.passes.unreadable.includes("HTTP 500"));
    assert.equal(status.held.state, "settled");
    assert.deepEqual(status.threads, { bot: 0, owner: 0, other: 0, answered: 0 });
  });

  it("is flagged for a pass for a conflicting PR with passes left", () => {
    const status = statusFor(pr({ mergeStateStatus: "DIRTY" }), { passes: () => FOLLOW_UP_PASS_CAP - 1 });

    assert.deepEqual(status.held, { state: "flagged for a pass", reason: `it has merge conflicts (${PASS_MAY_SKIP})` });
  });

  it("is flagged for a hand-back for a conflicting PR that used its passes", () => {
    const status = statusFor(pr({ mergeStateStatus: "DIRTY" }), { passes: () => FOLLOW_UP_PASS_CAP });

    assert.equal(status.held.state, "flagged for a hand-back");
    assert.match(status.held.reason, /a pass that has something to act on hands it back with sandcastle:needs-human/);
  });

  it("is waiting while checks haven't reported", () => {
    assert.deepEqual(statusFor(pr({ checks: [] })).held, { state: "waiting", reason: "no checks have reported" });
  });

  it("says Copilot will be asked to review a head it hasn't reviewed once CI has been done a while", () => {
    assert.deepEqual(statusFor(pr({ reviews: [] })).held, { state: "act next sweep", reason: "Copilot will be asked to review the head" });
  });

  it("says a PR that's only behind main will be updated", () => {
    assert.deepEqual(statusFor(pr({ mergeStateStatus: "BEHIND" })).held, { state: "act next sweep", reason: "it will be updated from main" });
  });

  it("says the sweep puts back a hand-back label a stranger removed", () => {
    const status = statusFor(pr(), { events: () => [unlabelled("stranger")] });

    assert.equal(status.held.state, "skipped");
    assert.equal(status.held.reason, "put back sandcastle:needs-human, which @stranger removed, not the repository owner; the sweep puts the label back");
  });

  it("says it couldn't check who removed the hand-back label", () => {
    const status = statusFor(pr(), { events: () => [unlabelled("ghost")], isOwner: (login) => (login === "ghost" ? undefined : login === OWNER) });

    assert.deepEqual(status.held, { state: "skipped", reason: "couldn't check whether the repository owner removed sandcastle:needs-human" });
  });

  it("makes no write of any kind", () => {
    const candidates = [pr({ reviews: [] }), pr({ mergeStateStatus: "BEHIND" }), pr({ mergeStateStatus: "DIRTY" })];
    for (const candidate of candidates) {
      const { github, writes } = statusGithub({ prs: [candidate], events: () => [unlabelled("stranger")] });

      statusOf(candidate, context(), github, () => {});
      statusOf({ ...candidate, labels: [] }, context(), statusGithub({ prs: [candidate] }).github, () => {});

      assert.deepEqual(writes, []);
    }
  });
});

describe("collectStatus", () => {
  it("lists the Sandcastle and hand-off PRs by number and counts the others", () => {
    const collaborators = pr({ number: 300, id: "PR_300", author: "a-collaborator", body: "Closes #42", headRefName: "chore/x" });
    const { github } = statusGithub({ prs: [handOffPr(), collaborators, pr()], events: (number) => (number === 201 ? ownerLabelled : []) });

    const report = collectStatus(github, NOW, () => {});

    assert.deepEqual(report.prs.map((status) => status.number), [101, 201]);
    assert.equal(report.unlisted, 1);
  });

  it("names the repository and the queue scope", () => {
    const scope: QueueScope = { kind: "issue", number: 42 };

    const report = collectStatus(statusGithub({ scope }).github, NOW, () => {});

    assert.equal(report.repo, "o/r");
    assert.equal(report.scope, describeQueueScope(scope));
  });

  it("lists a draft Sandcastle PR, as skipped", () => {
    const report = collectStatus(statusGithub({ prs: [pr({ isDraft: true })] }).github, NOW, () => {});

    assert.deepEqual(report.prs.map((status) => status.held.state), ["skipped"]);
  });

  it("reads the Sandcastle workflow's latest ten runs", () => {
    const runs = [run(), run({ id: 9000 })];
    const { github, reads } = statusGithub({ runs: () => runs });

    const report = collectStatus(github, NOW, () => {});

    assert.deepEqual(reads.runs, [10]);
    assert.deepEqual(report.runs, runs);
  });

  it("reports the runs as unreadable, and still lists the PRs, when they can't be read", () => {
    const lines: string[] = [];
    const { github } = statusGithub({
      runs: () => {
        throw new Error("gh: HTTP 404");
      },
    });

    const report = collectStatus(github, NOW, (line) => lines.push(line));

    assert.ok("unreadable" in report.runs && report.runs.unreadable.includes("HTTP 404"));
    assert.equal(report.prs.length, 1);
    assert.ok(lines.some((line) => line.includes("HTTP 404")), lines.join("\n"));
  });

  it("logs a runs read's failure as plain text, with no control or hidden character from gh's message", () => {
    const { github } = statusGithub({
      runs: () => {
        throw new Error("gh: HTTP 500\u001b[2K\u200b\u{E0041}");
      },
    });
    const logged: string[] = [];

    collectStatus(github, NOW, (line) => logged.push(line));

    assert.ok(logged.length > 0 && logged.every((line) => !HIDDEN.test(line)), JSON.stringify(logged));
    assert.ok(logged.some((line) => line.includes("gh: HTTP 500")), JSON.stringify(logged));
  });

  it("throws when the open PRs can't be read: nothing can be said", () => {
    const { github } = statusGithub();
    github.openPullRequests = () => {
      throw new Error("gh: HTTP 401");
    };

    assert.throws(() => collectStatus(github, NOW, () => {}), /HTTP 401/);
  });

  it("lists the other PRs when one PR's read fails, showing the cause for the one that failed", () => {
    const { github } = statusGithub({
      prs: [issuePr(42), issuePr(43)],
      issues: [{ number: 42, labels: [] }, { number: 43, labels: [] }],
      events: (number) => {
        if (number === 142) throw new Error("gh: HTTP 500 on events");
        return [];
      },
    });

    const report = collectStatus(github, NOW, () => {});

    assert.deepEqual(report.prs.map((status) => status.number), [142, 143]);
    assert.equal(report.prs[0]!.subject, "unknown");
    assert.deepEqual(report.prs[0]!.held, { state: "skipped", reason: "couldn't read what decides whether it is swept: gh: HTTP 500 on events" });
    assert.deepEqual(report.prs[1]!.held, { state: "settled", reason: "it's settled and CLEAN" });
  });

  it("makes no write of any kind, whatever the sweep would do with each PR", () => {
    const head = "b".repeat(40);
    const { github, writes } = statusGithub({
      prs: [
        issuePr(42, { reviews: [] }),
        issuePr(43, { mergeStateStatus: "BEHIND" }),
        issuePr(44),
        issuePr(45, { mergeStateStatus: "DIRTY" }),
        handOffPr({ headRefOid: head, reviews: [{ author: COPILOT_REVIEWER, commitOid: head }] }),
      ],
      issues: [42, 43, 44, 45].map((number) => ({ number, labels: [] })),
      events: (number) => (number === 144 ? [unlabelled("stranger")] : number === 201 ? ownerLabelled : []),
      comments: (number) => (number === 201 ? [headRecord(HEAD)] : []),
      mergeOfMain: (commit) => (commit === head ? { firstParent: HEAD } : { problem: "not a merge" }),
      isOwner: (login) => login === OWNER || login === HOST,
    });

    const report = collectStatus(github, NOW, () => {});

    assert.equal(report.prs.length, 5);
    assert.deepEqual(writes, []);
  });
});

describe("renderStatus", () => {
  const status = (overrides: Partial<PrStatus> = {}): PrStatus => ({
    number: 101,
    title: "feat: Add search",
    headRefName: BRANCH,
    subject: "issue",
    issueNumber: 42,
    passes: { used: 1, cap: 3 },
    held: { state: "flagged for a pass", reason: "check build is red" },
    threads: { bot: 2, owner: 1, other: 3, answered: 0 },
    mergeState: "BLOCKED",
    draft: false,
    labels: [],
    ...overrides,
  });
  const report = (overrides: Partial<StatusReport> = {}): StatusReport => ({
    repo: "o/r",
    scope: "issues labelled Sandcastle",
    prs: [status()],
    unlisted: 0,
    runs: [],
    ...overrides,
  });
  // Whether `block` appears in `lines` as consecutive lines.
  const contains = (lines: string[], block: string[]) => lines.some((_, start) => block.every((line, offset) => lines[start + offset] === line));

  it("heads the report with the repository, the queue and the number of PRs", () => {
    const lines = renderStatus(report());

    assert.equal(lines[0], "Sandcastle status for o/r (queue: issues labelled Sandcastle)");
    assert.equal(lines[1], "1 open Sandcastle pull request(s) into main");
  });

  it("counts the PRs it doesn't list", () => {
    const lines = renderStatus(report({ prs: [status(), status({ number: 102 })], unlisted: 3 }));

    assert.equal(lines[1], "2 open Sandcastle pull request(s) into main, 3 other open PR(s) not listed");
  });

  it("prints a PR's branch, issue, passes, why it's held and its threads", () => {
    assert.ok(
      contains(renderStatus(report()), [
        "#101 feat: Add search",
        "  branch:   feature/42-add-search (BLOCKED)",
        "  for:      issue #42",
        "  passes:   1 of 3",
        "  held:     flagged for a pass: check build is red",
        "  threads:  bot 2, owner 1, other 3",
      ]),
      renderStatus(report()).join("\n"),
    );
  });

  it("prints no hidden or control character from a title, branch, reason, run, repository or scope, so no line can be overwritten, faked or hidden in", () => {
    const hostile = "feat: x\u001b[2K\nheld:     settled: all clear\r\u202e\u2066\u009b\u200b\u{E0041}\u00ad";
    const lines = renderStatus(
      report({
        repo: `o/r${hostile}`,
        scope: `queue${hostile}`,
        prs: [status({ title: hostile, headRefName: `b${hostile}`, mergeState: hostile, held: { state: "settled", reason: hostile }, passes: { unreadable: hostile }, threads: { unreadable: hostile } })],
        runs: [run({ branch: hostile, event: hostile })],
      }),
    );

    for (const line of lines) assert.doesNotMatch(line, HIDDEN, JSON.stringify(line));
    assert.equal(lines.filter((line) => line.startsWith("  held:")).length, 1);
    assert.equal(lines.filter((line) => line.startsWith("#101 ")).length, 1);
    assert.ok(lines.includes("#101 feat: x[2K held: settled: all clear"), lines.join("\n"));
    for (const line of renderStatus(report({ runs: { unreadable: hostile } }))) assert.doesNotMatch(line, HIDDEN, JSON.stringify(line));
  });

  it("shows a PR whose admission couldn't be read as for: unknown, not as not swept", () => {
    assert.ok(renderStatus(report({ prs: [status({ subject: "unknown" })] })).includes("  for:      unknown"));
  });

  it("marks a draft, and shows only the labels that matter", () => {
    const labels = ["dependencies", "review:claude", "sandcastle:building", "sandcastle:needs-human", "sandcastle:follow-up", "Sandcastle", "Sandcastle:local", "bug"];

    const lines = renderStatus(report({ prs: [status({ draft: true, labels })] }));

    assert.ok(
      lines.includes("  branch:   feature/42-add-search (BLOCKED, draft), labels: review:claude, sandcastle:building, sandcastle:needs-human, sandcastle:follow-up, Sandcastle, Sandcastle:local"),
      lines.join("\n"),
    );
  });

  it("prints a label the PR carries in another case as the label's own spelling, never GitHub's string", () => {
    const lines = renderStatus(report({ prs: [status({ labels: ["SANDCASTLE:LOCAL", "Review:Claude"] })] }));

    assert.ok(lines.includes("  branch:   feature/42-add-search (BLOCKED), labels: Sandcastle:local, review:claude"), lines.join("\n"));
  });

  it("shows no labels clause when none of the PR's labels matter", () => {
    assert.ok(renderStatus(report({ prs: [status({ labels: ["dependencies"] })] })).includes("  branch:   feature/42-add-search (BLOCKED)"));
  });

  it("says a hand-off PR is one, and a PR that isn't swept isn't", () => {
    const lines = renderStatus(report({ prs: [status({ subject: "hand-off", issueNumber: undefined }), status({ number: 102, subject: "not swept", issueNumber: undefined })] }));

    assert.ok(lines.includes("  for:      hand-off"));
    assert.ok(lines.includes("  for:      not swept"));
  });

  it("shows the answered threads only when there are some", () => {
    assert.ok(renderStatus(report({ prs: [status({ threads: { bot: 0, owner: 0, other: 0, answered: 2 } })] })).includes("  threads:  bot 0, owner 0, other 0, answered 2"));
    assert.ok(renderStatus(report()).includes("  threads:  bot 2, owner 1, other 3"));
  });

  it("says unknown, with the cause, for passes and threads that couldn't be read", () => {
    const lines = renderStatus(report({ prs: [status({ passes: { unreadable: "HTTP 500" }, threads: { unreadable: "HTTP 502" } })] }));

    assert.ok(lines.includes("  passes:   unknown (HTTP 500)"), lines.join("\n"));
    assert.ok(lines.includes("  threads:  unknown (HTTP 502)"), lines.join("\n"));
  });

  it("says there are no open Sandcastle PRs, still headed and with the runs", () => {
    const lines = renderStatus(report({ prs: [], runs: [run()] }));

    assert.equal(lines[0], "Sandcastle status for o/r (queue: issues labelled Sandcastle)");
    assert.ok(lines.includes("No open Sandcastle pull requests into main."), lines.join("\n"));
    assert.ok(lines.includes("Sandcastle workflow runs (latest 1):"), lines.join("\n"));
  });

  it("lists the workflow's runs: result, event, branch, time and link", () => {
    const lines = renderStatus(report({ runs: [run(), run({ id: 9000, status: "in_progress", conclusion: null, event: "workflow_dispatch", branch: "feature/315-x", createdAt: "2026-10-10T06:00:00Z", url: "https://github.com/o/r/actions/runs/9000" })] }));

    assert.ok(lines.includes("Sandcastle workflow runs (latest 2):"), lines.join("\n"));
    const done = lines.find((line) => line.includes("https://github.com/o/r/actions/runs/9001"));
    assert.ok(done !== undefined && done.startsWith("  "));
    for (const part of ["success", "schedule", "main", "2026-10-10T08:00:00Z"]) assert.ok(done.includes(part), `${part} in ${done}`);
    const running = lines.find((line) => line.includes("https://github.com/o/r/actions/runs/9000"));
    assert.ok(running !== undefined);
    for (const part of ["in_progress", "workflow_dispatch", "feature/315-x", "2026-10-10T06:00:00Z"]) assert.ok(running.includes(part), `${part} in ${running}`);
  });

  it("says unknown, with the cause, for runs that couldn't be read", () => {
    assert.ok(renderStatus(report({ runs: { unreadable: "HTTP 404" } })).includes("  unknown (HTTP 404)"));
  });

  it("is plain text: no markdown and no ANSI", () => {
    const lines = renderStatus(report({ prs: [status({ labels: ["review:claude"], draft: true })], unlisted: 1, runs: [run()] }));

    for (const line of lines) {
      assert.doesNotMatch(line, /\u001b|\*\*|`|^#{2,} |^\|/, line);
    }
  });
});

describe("terminalText", () => {
  const hiding: Record<string, string> = {
    "a tag character": "\u{E0041}",
    "the tag block's cancel": "\u{E007F}",
    "a soft hyphen": "\u00ad",
    "a zero-width space": "\u200b",
    "a zero-width joiner": "\u200d",
    "a left-to-right mark": "\u200e",
    "an Arabic letter mark": "\u061c",
    "a word joiner": "\u2060",
    "a bidi isolate": "\u2067",
    "a bidi override": "\u202e",
    "a deprecated format character": "\u206a",
    "a byte order mark": "\ufeff",
    "an interlinear annotation mark": "\ufff9",
    "a variation selector": "\ufe0f",
    "a variation selector supplement": "\u{E0100}",
    "a combining grapheme joiner": "\u034f",
    "a Hangul Choseong filler": "\u115f",
    "a Hangul Jungseong filler": "\u1160",
    "a Khmer inherent vowel": "\u17b4",
    "a second Khmer inherent vowel": "\u17b5",
    "an unassigned default-ignorable code point": "\u2065",
    "a noncharacter": "\uffff",
    "a supplementary private-use code point": "\u{F0000}",
    "the last private-use code point": "\u{10FFFD}",
    "a Hangul filler": "\u3164",
    "a halfwidth Hangul filler": "\uffa0",
    "a Braille blank": "\u2800",
    "DEL": "\u007f",
    "a C1 control": "\u009b",
    "ESC": "\u001b",
    "NUL": "\u0000",
    "a lone surrogate": "\ud800",
  };

  for (const [name, character] of Object.entries(hiding)) {
    it(`drops ${name}`, () => {
      assert.equal(terminalText(`a${character}b`), "ab");
    });
  }

  it("turns every kind of line break and other whitespace into one space", () => {
    assert.equal(terminalText("a\nb\rc\r\nd\te\u0085f\u2028g\u2029h\u00a0i"), "a b c d e f g h i");
    assert.equal(terminalText("  a \t b\n c  "), "a b c");
  });

  for (const [name, character] of Object.entries({
    "a vertical tab": "\v", "a form feed": "\f", "an Ogham space mark": "\u1680", "an en quad": "\u2000", "a hair space": "\u200a",
    "a narrow no-break space": "\u202f", "a medium mathematical space": "\u205f", "an ideographic space": "\u3000",
  })) {
    it(`turns ${name} into one space`, () => {
      assert.equal(terminalText(`a${character}b`), "a b");
    });
  }

  it("leaves one space where a dropped character sat between two, and gives the same text when applied twice", () => {
    assert.equal(terminalText("a \u200b b"), "a b");
    const once = terminalText("x \u2060\u200b  y\u{E0041} z");
    assert.equal(terminalText(once), once);
  });

  it("keeps the joiners that do their work, and no others", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    const heart = "\u2764\ufe0f\u200d\u{1F525}";
    const persian = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645";
    const technologist = "\u{1F469}\u{1F3FD}\u200d\u{1F4BB}";
    const runner = "\u{1F3C3}\u{1F3FD}\u200d\u2640\ufe0f";
    const sanskrit = "\u0915\u094d\u200c\u0937";
    const marked = "\u0645\u064e\u200c\u0646";

    assert.equal(terminalText(family), family);
    assert.equal(terminalText(heart), heart);
    assert.equal(terminalText("\u26a0\ufe0f Fix"), "\u26a0\ufe0f Fix");
    assert.equal(terminalText(persian), persian);
    for (const text of [technologist, runner, sanskrit, marked]) assert.equal(terminalText(text), text, JSON.stringify(text));
  });

  it("keeps a non-joiner only between two letters of a script that uses one, not between Latin letters", () => {
    assert.equal(terminalText("a\u200cb"), "ab");
    assert.equal(terminalText("\u0645\u200cb"), "\u0645b");
    assert.equal(terminalText("\u0645\u200c\u0646"), "\u0645\u200c\u0646");
  });

  it("reads only the letter and its marks right before a joiner: a longer run of marks drops it", () => {
    const marks = "\u064e".repeat(20);
    assert.equal(terminalText(`\u0645${marks}\u200c\u0646`), `\u0645${"\u064e".repeat(8)}\u0646`);
  });

  it("keeps at most a few joiners in one text, however many there are", () => {
    const text = Array(20).fill("\u{1F600}").join("\u200d");
    const kept = [...terminalText(text)].filter((character) => character === "\u200d").length;

    assert.equal(kept, 8);
  });

  it("doesn't count a filler, which is dropped, as the letter beside a joiner", () => {
    assert.equal(terminalText("\u0645\u200c\u3164\u200c\u0646"), "\u0645\u0646");
    assert.equal(terminalText("\u3164\u200c\u0646"), "\u0646");
    const text = "\u0645\u200c\u3164\u200c\u0646";
    assert.equal(terminalText(terminalText(text)), terminalText(text));
  });

  it("lets a keycap sequence and a flag's tag sequence fall apart, as the comment says", () => {
    assert.equal(terminalText("1\ufe0f\u20e3"), "1\u20e3");
    assert.equal(terminalText("\u{1F3F4}\u{E0067}\u{E007F}"), "\u{1F3F4}");
  });

  it("drops a joiner that has no pictograph or letter on both sides, and every one of a run", () => {
    assert.equal(terminalText("\u{1F468}\u200d\u200d\u{1F469}"), "\u{1F468}\u{1F469}");
    assert.equal(terminalText("\u0645\u200c\u200c\u0646"), "\u0645\u0646");
    assert.equal(terminalText("\u{1F468}\u200dx"), "\u{1F468}x");
    assert.equal(terminalText("x\u200d\u{1F468}"), "x\u{1F468}");
    assert.equal(terminalText("a\u200c 1"), "a 1");
    assert.equal(terminalText("x\ufe0f"), "x");
    assert.equal(terminalText("\u{1F468}\ufe00"), "\u{1F468}");
  });

  it("keeps at most a few private-use or unassigned code points in one text, and a few combining marks in a row", () => {
    const odd = terminalText("\ue000".repeat(20));
    const marks = terminalText(`e${"\u0301".repeat(12)}x`);

    assert.equal(odd, "\ue000".repeat(8));
    assert.equal(marks, `e${"\u0301".repeat(8)}x`);
    assert.equal(terminalText(odd), odd);
    assert.equal(terminalText(marks), marks);
  });

  it("counts private-use and unassigned code points together, at the boundary, wherever they sit", () => {
    assert.equal(terminalText("\u0378".repeat(20)), "\u0378".repeat(8));
    assert.equal(terminalText("\ue000".repeat(5) + "\u0378".repeat(5)), "\ue000".repeat(5) + "\u0378".repeat(3));
    assert.equal(terminalText("\ue000".repeat(8)), "\ue000".repeat(8));
    assert.equal(terminalText("\ue000".repeat(9)), "\ue000".repeat(8));
    assert.equal(terminalText("a\ue000b".repeat(10)), "a\ue000b".repeat(8) + "ab".repeat(2));
  });

  it("keeps eight combining marks in a row, trims a ninth, and counts each run on its own, astral marks too", () => {
    const eight = "\u0301".repeat(8);

    assert.equal(terminalText(`e${eight}`), `e${eight}`);
    assert.equal(terminalText(`e${eight}\u0301`), `e${eight}`);
    assert.equal(terminalText(`e${eight}\u0301\u0301\u0301`), `e${eight}`);
    assert.equal(terminalText(`a${eight}b${eight}c`), `a${eight}b${eight}c`);
    assert.equal(terminalText(`e${"\u{1D165}".repeat(12)}`), `e${"\u{1D165}".repeat(8)}`);
  });

  it("keeps Tibetan and Hebrew text that stacks four or more marks, which a cap of three trimmed", () => {
    const tibetan = "\u0f40\u0f71\u0f72\u0f74\u0f7a\u0f7e";
    const hebrew = "\u05d1\u05b0\u05bc\u05c1\u05ab\u05bd";

    assert.equal(terminalText(tibetan), tibetan);
    assert.equal(terminalText(hebrew), hebrew);
  });

  it("is idempotent when the cap drops what a joiner sat beside: a joiner is kept only between assigned pictographs", () => {
    const text = "\u{1FC00}".repeat(8) + "\u200d\u{1FC01}";
    const once = terminalText(text);

    assert.ok(!once.includes("\u200d"));
    assert.equal(terminalText(once), once);
    assert.equal(terminalText("\u{1F468}\u200d\u{1F469}"), "\u{1F468}\u200d\u{1F469}");
  });

  it("keeps a joiner after an assigned pictograph only before an assigned one, so the cap can't leave it dangling", () => {
    const text = "\u0378".repeat(8) + "\u{1F468}\u200d\u{1FC00}";
    const once = terminalText(text);

    assert.ok(!once.includes("\u200d"));
    assert.equal(terminalText(once), once);
  });

  it("keeps a variation selector only after an assigned pictograph, so the cap can't leave it dangling", () => {
    const text = "\u0378".repeat(8) + "a\u{1FC00}\ufe0f";
    const once = terminalText(text);

    assert.ok(!once.includes("\ufe0f"));
    assert.equal(terminalText(once), once);
    assert.equal(terminalText("\u2764\ufe0f"), "\u2764\ufe0f");
    assert.equal(terminalText("\u{1F600}\ufe0f"), "\u{1F600}\ufe0f");
  });

  it("keeps a non-joiner a run of marks sits beside, and is idempotent beside marks and odd code points", () => {
    const text = `\u0645${"\u064e".repeat(10)}\u200c\u0646\ue000\u0378${"\u0301".repeat(12)}`;
    const once = terminalText(text);

    assert.ok(once.includes("\u200c"));
    assert.ok(once.endsWith(`\ue000\u0378${"\u0301".repeat(8)}`));
    assert.equal(terminalText(once), once);
  });

  it("keeps a private-use or unassigned code point, which draws a glyph or a box, and drops a noncharacter", () => {
    assert.equal(terminalText("a\ue000b\u0378c"), "a\ue000b\u0378c");
    assert.equal(terminalText("a\u{F0000}b\u{10FFFD}c"), "abc");
    assert.equal(terminalText("a\uffffb"), "ab");
  });

  it("gives the same text when a joiner it kept is cleaned again", () => {
    const text = "\u{1F468}\u200d\u{1F469} \u200b \u0645\u06cc\u200c\u062e a\u200cb \u3164\u200c\u0646";
    assert.equal(terminalText(terminalText(text)), terminalText(text));
  });

  it("leaves a title's letters, digits, punctuation, emoji and accents alone", () => {
    assert.equal(terminalText("feat(baseline): Ajoute la recherche (v2) ✓ 日本語 🚀"), "feat(baseline): Ajoute la recherche (v2) ✓ 日本語 🚀");
  });
});

describe("statusScopeFrom", () => {
  it("is the default queue when neither variable is set, so a bare run shows what GitHub Actions' scope would do", () => {
    assert.deepEqual(statusScopeFrom({}), { kind: "label", label: QUEUE_LABEL });
  });

  it("counts a blank variable as unset", () => {
    assert.deepEqual(statusScopeFrom({ SANDCASTLE_ISSUE: "  ", SANDCASTLE_LABEL: "" }), { kind: "label", label: QUEUE_LABEL });
  });

  it("reads SANDCASTLE_ISSUE as queueScopeFrom does", () => {
    assert.deepEqual(statusScopeFrom({ SANDCASTLE_ISSUE: "7" }), { kind: "issue", number: 7 });
  });

  it("reads SANDCASTLE_LABEL as queueScopeFrom does", () => {
    assert.deepEqual(statusScopeFrom({ SANDCASTLE_LABEL: "Sandcastle:local" }), { kind: "label", label: "Sandcastle:local" });
  });

  it("throws queueScopeFrom's QueueScopeError for a bad value or both variables", () => {
    assert.throws(() => statusScopeFrom({ SANDCASTLE_ISSUE: "abc" }), QueueScopeError);
    assert.throws(() => statusScopeFrom({ SANDCASTLE_ISSUE: "7", SANDCASTLE_LABEL: "Sandcastle:local" }), QueueScopeError);
    assert.throws(() => statusScopeFrom({ SANDCASTLE_LABEL: "bug" }), QueueScopeError);
  });
});

// loadQueue fixes the labels of an issue whose label origin was untrusted; reading the queue for the status mustn't.
describe("statusQueue", () => {
  const issue = (number: number, labels: string[]): SandcastleIssue => ({ number, title: `Issue ${number}`, body: `Body of ${number}`, labels, comments: [] });
  const isOwner = (login: string | null) => (login === null ? undefined : login === "owner" || login === "host");
  function queue(issues: SandcastleIssue[], events: Record<number, IssueEvent[]>) {
    const writes: string[] = [];
    const github: QueueGitHub = {
      issuesInScope: () => issues,
      events: (number) => events[number] ?? [],
      bodyEdits: () => [],
      isOwner,
      removeLabel: (number, label) => void writes.push(`remove ${label} from #${number}`),
      addLabel: (number, label) => void writes.push(`add ${label} to #${number}`),
    };
    return { github, writes };
  }
  const labelled = (actor: string, label: string): IssueEvent => ({ event: "labeled", actor, label, createdAt: "2026-10-01T00:00:00Z" });

  it("returns the issues the owner queued", () => {
    const { github } = queue([issue(501, ["Sandcastle"])], { 501: [labelled("owner", "Sandcastle")] });

    assert.deepEqual(statusQueue(SCOPE, github, () => {}).map((found) => found.number), [501]);
  });

  it("leaves a label a stranger added alone, where loadQueue would remove it, and says nothing changed", () => {
    const { github, writes } = queue([issue(502, ["Sandcastle", "sandcastle:ready"])], {
      502: [labelled("owner", "Sandcastle"), labelled("stranger", "sandcastle:ready")],
    });
    const lines: string[] = [];

    const found = statusQueue(SCOPE, github, (line) => lines.push(line));

    assert.deepEqual(found.map((issue) => issue.number), [502]);
    assert.deepEqual(writes, []);
    assert.ok(lines.some((line) => line.includes("#502") && line.endsWith(" (status only: nothing changed)")), lines.join("\n"));
  });

  it("leaves a label a stranger removed alone, too", () => {
    const { github, writes } = queue([issue(503, ["Sandcastle"])], {
      503: [labelled("owner", "Sandcastle"), { event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-02T00:00:00Z" }],
    });

    statusQueue(SCOPE, github, () => {});

    assert.deepEqual(writes, []);
  });

  it("logs a failed read of an issue's events as plain text, with no control or hidden character from gh's message", () => {
    const { github } = queue([issue(505, ["Sandcastle"])], {});
    github.events = () => {
      throw new Error("gh: HTTP 500\u001b[2K\u200b\u{E0041}");
    };
    const lines: string[] = [];

    statusQueue(SCOPE, github, (line) => lines.push(line));

    assert.ok(lines.some((line) => line.includes("gh: HTTP 500") && line.endsWith(" (status only: nothing changed)")), JSON.stringify(lines));
    assert.ok(lines.every((line) => !HIDDEN.test(line)), JSON.stringify(lines));
  });

  it("suffixes the line for an issue it skips, too", () => {
    const { github } = queue([issue(504, ["Sandcastle"])], { 504: [labelled("stranger", "Sandcastle")] });
    const lines: string[] = [];

    const found = statusQueue(SCOPE, github, (line) => lines.push(line));

    assert.deepEqual(found, []);
    assert.ok(lines.length > 0 && lines.every((line) => line.endsWith(" (status only: nothing changed)")), lines.join("\n"));
  });
});

describe("statusCommand", () => {
  it("prints the rendered report, line by line, and returns it", () => {
    const { github } = statusGithub({ runs: () => [run()] });
    const printed: string[] = [];

    const report = statusCommand(github, (line) => printed.push(line), NOW);

    assert.deepEqual(printed, renderStatus(report));
    assert.deepEqual(report.prs.map((status) => status.number), [101]);
    assert.ok(printed.includes("Sandcastle workflow runs (latest 1):"));
  });

  it("returns normally when every PR is held: the command reports, it doesn't judge", () => {
    const { github } = statusGithub({ prs: [pr({ isDraft: true }), issuePr(43, { labels: ["sandcastle:needs-human"] })], issues: [{ number: 43, labels: [] }] });

    const report = statusCommand(github, () => {}, NOW);

    assert.deepEqual(report.prs.map((status) => status.held.state), ["skipped", "skipped"]);
  });

  it("throws when the open PRs can't be read, printing nothing", () => {
    const { github } = statusGithub();
    github.openPullRequests = () => {
      throw new Error("gh: HTTP 401");
    };
    const printed: string[] = [];

    assert.throws(() => statusCommand(github, (line) => printed.push(line), NOW), /HTTP 401/);
    assert.deepEqual(printed, []);
  });
});

// The imports tell what the status can reach: reads only, and nothing that starts a sandbox or a model.
describe("lib/status.mts's imports", () => {
  const source = readFileSync(new URL("./status.mts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((match) => ({ text: match[0], from: match[1] as string }));

  it("imports nothing that starts a sandbox or a model", () => {
    for (const { from } of imports) {
      assert.doesNotMatch(from, /@ai-hero|build|follow-up-pass|skills|agents|round|plan|intake|critique|building|handback/, from);
    }
  });

  it("imports none of the GitHub writes", () => {
    const writes = [
      "addPullRequestLabel", "addIssueLabel", "removeIssueLabel", "replaceIssueLabel", "removePullRequestLabel", "commentOnPullRequest", "commentOnIssue",
      "handBack", "requestCopilotReview", "updatePullRequestBranch", "ensureLabels", "createIssue", "openPullRequest", "closeIssueAsCompleted",
      "replyToReviewThread", "resolveReviewThread", "addSubIssue", "recordApprovedHead",
    ];
    for (const { text } of imports) {
      for (const name of writes) assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`), `${name} in ${text}`);
    }
  });
});

describe("terminalLine", () => {
  it("keeps the indent the line starts with and cleans the rest", () => {
    assert.equal(terminalLine("  \u26a0 x\u001b[2K\u200b"), "  \u26a0 x[2K");
    assert.equal(terminalLine("no indent"), "no indent");
    assert.equal(terminalLine("\u200b  after a hidden one"), "after a hidden one");
  });
});

describe("plainStderr", () => {
  const sinkOf = () => {
    const printed: string[] = [];
    const sink = { error: (...data: unknown[]) => void printed.push(data.join("|")) };
    plainStderr(sink);
    return { printed, sink };
  };

  it("makes what the console prints plain text, an Error's message too", () => {
    const { printed, sink } = sinkOf();

    sink.error("  \u26a0 gh said\u001b[2K\u202e hidden", new Error("boom\u200b\nline two"));

    assert.deepEqual(printed, ["  \u26a0 gh said[2K hidden boom line two"]);
  });

  it("joins the arguments as data, never as a format string, whichever one holds a %", () => {
    const { printed, sink } = sinkOf();

    sink.error(new Error("100%s done"), "x");
    sink.error(new Error("a %% b"), 1);
    sink.error("gh said %s (%d)", "hi\u202e", 3);
    sink.error("gh said %s", new Error("100%s"));
    sink.error("only 100%s");

    assert.deepEqual(printed, ["100%s done x", "a %% b 1", "gh said %s (%d) hi 3", "gh said %s 100%s", "only 100%s"]);
  });

  it("prints an object and a null-prototype object as console would, cleaned", () => {
    const { printed, sink } = sinkOf();

    sink.error({ a: 1 });
    sink.error(Object.create(null));

    assert.deepEqual(printed, ["{ a: 1 }", "[Object: null prototype] {}"]);
  });

  it("keeps at most a short indent, so text from GitHub can't pad a line", () => {
    const { printed, sink } = sinkOf();

    sink.error(`${" ".repeat(200)}x`);

    assert.equal(printed[0], `${" ".repeat(8)}x`);
  });
});

// Read-only is the issue's acceptance criterion. The import tests above only see names; the live object is already imported, so what pins it is the
// members status reads from it.
describe("lib/status.mts's use of the live sweep object", () => {
  const source = readFileSync(new URL("./status.mts", import.meta.url), "utf8");
  const reads = [
    "hostLogin", "openPullRequests", "followsHandOffs", "pullRequestEvents", "pullRequestBodyEdits", "pullRequestComments",
    "mergeOfMain", "isOwner", "repositoryOwner", "reviewThreads",
  ];

  it("reads only the sweep's reads from liveFollowUpGitHub, never a write", () => {
    const used = [...source.matchAll(/\bliveFollowUpGitHub\.(\w+)/g)].map((match) => match[1] as string);

    assert.ok(used.length > 0, "liveStatusGitHub should serve the sweep's reads from liveFollowUpGitHub");
    assert.deepEqual(used.filter((name) => !reads.includes(name)), []);
  });

  it("reaches liveFollowUpGitHub only as liveFollowUpGitHub.<read>: no alias, destructure, spread or index", () => {
    assert.doesNotMatch(source, /liveFollowUpGitHub\s+as\b/, "liveFollowUpGitHub is imported under its own name");
    const code = source
      .replace(/^import\s[^;]*?;/gms, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    const mentions = code.match(/\bliveFollowUpGitHub\b/g) ?? [];
    const dotted = code.match(/\bliveFollowUpGitHub\.\w+/g) ?? [];

    assert.equal(mentions.length, dotted.length, "every use of liveFollowUpGitHub should be a plain member read");
  });

  it("serves every member of StatusGitHub", () => {
    for (const member of [...reads, "inScopeIssues", "passesUsed", "workflowRuns", "repo", "queueScope"]) {
      assert.equal(typeof (liveStatusGitHub as Record<string, unknown>)[member], "function", member);
    }
  });
});

describe("liveStatusGitHub", () => {
  it("serves the passes used and the workflow's runs besides the sweep's reads", () => {
    assert.equal(typeof liveStatusGitHub.passesUsed, "function");
    assert.equal(typeof liveStatusGitHub.workflowRuns, "function");
    assert.equal(typeof liveStatusGitHub.openPullRequests, "function");
  });
});
