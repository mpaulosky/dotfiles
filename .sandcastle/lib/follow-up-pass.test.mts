import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sandbox, SandboxRunOptions } from "@ai-hero/sandcastle";
import { FOLLOW_UP_MARKER, FOLLOW_UP_PASS_CAP, FOLLOW_UP_REPLY_MARKER } from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import type { CheckState, PassTarget } from "./follow-up.mts";
import {
  followUpPassPhase,
  giveUpComment,
  isGateCovered,
  parseVerdicts,
  passOutcomeEntry,
  passSummaryComment,
  planRedCi,
  type PassHost,
  type PassOutcome,
  type PassReport,
  replyBody,
  runPass,
  threadActions,
  threadsForRole,
  type PromptThread,
  type RedCiPlan,
  type ThreadAction,
  type ThreadVerdict,
} from "./follow-up-pass.mts";
import type { HeadCheck, ReviewThread, SandcastleIssue } from "./github.mts";
import type { IsOwner } from "./queue.mts";
import { OutcomeReport, type HumanThreadEntry } from "./report.mts";
import { RunLimits } from "./limits.mts";
import type { SecretMatch } from "./scan.mts";

const ISSUE_NUMBER = 50;
const PR_NUMBER = 7;
const BRANCH = "feature/50-fix-widget";
const BASE = "d".repeat(40);
const HEAD = "c".repeat(40);
// The commit the follow-up role makes in sandboxFake, unless a test says otherwise.
const ROLE_COMMIT = "a".repeat(40);
const HOST_LOGIN = "sandcastle-bot";

// A match host.leaksSecret can return: a line, so a test can check the log
// and the hand-back name its path and line number without naming the secret.
const sampleSecretMatch: SecretMatch = {
  location: { commit: "e".repeat(40), field: "line", path: "src/example.ts", line: 3 },
  kind: { type: "pattern", shape: "sk-ant-" },
};

const issue: SandcastleIssue = { number: ISSUE_NUMBER, title: "Fix the widget", body: "", labels: ["Sandcastle"], comments: [] };

function passTarget(overrides: Partial<PassTarget> = {}): PassTarget {
  return {
    number: PR_NUMBER,
    id: "PR_7",
    headRefName: BRANCH,
    headRefOid: HEAD,
    issueNumber: ISSUE_NUMBER,
    reasons: ["1 unresolved bot thread(s)"],
    conflicted: false,
    ...overrides,
  };
}

// A red check (completed, not green) with an Actions run behind it; tests
// override just the fields their scenario needs. A check's runId is what a
// pass can re-run or forward (see runlessCheck for one with none, #79).
function redCheck(overrides: Partial<HeadCheck> = {}): HeadCheck {
  return { name: "Build Solution", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z", runId: 1001, ...overrides };
}

// A red check with no Actions run behind it, such as code scanning's own
// "CodeQL" result (lib/github.mts's HeadCheck): nothing a pass can re-run or
// read a failed-job log from (#79).
function runlessCheck(overrides: Partial<HeadCheck> = {}): HeadCheck {
  return redCheck({ name: "CodeQL", runId: undefined, ...overrides });
}

function botThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "RT_bot",
    resolved: false,
    outdated: false,
    path: "src/Domain/Result.cs",
    line: 10,
    comments: [
      {
        author: "copilot-pull-request-reviewer",
        byBot: true,
        body: "Consider returning a Result<T> here.",
        url: "https://github.com/o/r/pull/7#discussion_r1",
      },
    ],
    ...overrides,
  };
}

function ownerThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "RT_owner",
    resolved: false,
    outdated: false,
    path: "src/Domain/Result.cs",
    line: 20,
    comments: [{ author: "owner", byBot: false, body: "Why not use pattern matching here?", url: "https://github.com/o/r/pull/7#discussion_r2" }],
    ...overrides,
  };
}

function strangerThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "RT_stranger",
    resolved: false,
    outdated: false,
    path: "src/Domain/Result.cs",
    line: 30,
    comments: [{ author: "stranger", byBot: false, body: "I think this is wrong.", url: "https://github.com/o/r/pull/7#discussion_r3" }],
    ...overrides,
  };
}

const isOwner: IsOwner = (login) => (login === null ? false : login === "owner");

// ---------------------------------------------------------------------------
// threadsForRole
// ---------------------------------------------------------------------------

describe("threadsForRole", () => {
  it("sorts a bot thread's first comment into forRole, tagged \"bot\"", () => {
    const { forRole, leftForHuman, unknown } = threadsForRole([botThread()], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, [
      {
        threadId: "RT_bot",
        from: "bot",
        path: "src/Domain/Result.cs",
        line: 10,
        outdated: false,
        comments: [{ author: "copilot-pull-request-reviewer", body: "Consider returning a Result<T> here." }],
      },
    ]);
    assert.deepEqual(leftForHuman, []);
    assert.deepEqual(unknown, []);
  });

  it("sorts a thread the repository owner opened into forRole, tagged \"owner\"", () => {
    const { forRole } = threadsForRole([ownerThread()], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, [
      {
        threadId: "RT_owner",
        from: "owner",
        path: "src/Domain/Result.cs",
        line: 20,
        outdated: false,
        comments: [{ author: "owner", body: "Why not use pattern matching here?" }],
      },
    ]);
  });

  it("drops an owner thread whose last comment already carries the host's reply marker", () => {
    const answered = ownerThread({
      comments: [
        ...ownerThread().comments,
        { author: "sandcastle-bot", byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nFixed in abc1234.`, url: "https://github.com/o/r/pull/7#discussion_r4" },
      ],
    });

    const { forRole, leftForHuman, unknown } = threadsForRole([answered], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, []);
    assert.deepEqual(leftForHuman, []);
    assert.deepEqual(unknown, []);
  });

  it("drops an owner thread the host answered, when the host is signed in as the owner", () => {
    const answered = ownerThread({
      comments: [...ownerThread().comments, { author: "owner", byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nNoted.`, url: "https://github.com/o/r/pull/7#discussion_r4" }],
    });

    const { forRole } = threadsForRole([answered], isOwner, "owner");

    assert.deepEqual(forRole, []);
  });

  it("keeps an owner thread for the role when a stranger quotes the host's reply marker in it", () => {
    const spoofed = ownerThread({
      comments: [...ownerThread().comments, { author: "stranger", byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nNoted.`, url: "https://github.com/o/r/pull/7#discussion_r4" }],
    });

    const { forRole } = threadsForRole([spoofed], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole.map((thread) => thread.threadId), ["RT_owner"]);
  });

  it("still drops an owner thread the host answered when a stranger or a bot replies after the host", () => {
    const answered = ownerThread({
      comments: [
        ...ownerThread().comments,
        { author: HOST_LOGIN, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nNoted.`, url: "https://github.com/o/r/pull/7#discussion_r4" },
        { author: "stranger", byBot: false, body: "+1", url: "https://github.com/o/r/pull/7#discussion_r5" },
        { author: "some-bot", byBot: true, body: "Beep.", url: "https://github.com/o/r/pull/7#discussion_r6" },
      ],
    });

    const { forRole } = threadsForRole([answered], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, []);
  });

  it("gives an owner thread back to the role once the owner replies to the host", () => {
    const repliedTo = ownerThread({
      comments: [
        ...ownerThread().comments,
        { author: HOST_LOGIN, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nNoted.`, url: "https://github.com/o/r/pull/7#discussion_r4" },
        { author: "owner", byBot: false, body: "Please do it anyway.", url: "https://github.com/o/r/pull/7#discussion_r5" },
      ],
    });

    const { forRole } = threadsForRole([repliedTo], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole.map((thread) => thread.threadId), ["RT_owner"]);
  });

  it("drops a bot thread the host already answered, leaving it to a person rather than answering or resolving it again", () => {
    const answered = botThread({
      comments: [...botThread().comments, { author: HOST_LOGIN, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nFixed.`, url: "https://github.com/o/r/pull/7#discussion_r4" }],
    });

    const { forRole, leftForHuman, unknown } = threadsForRole([answered], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, []);
    assert.deepEqual(leftForHuman, []);
    assert.deepEqual(unknown, []);
  });

  it("gives a bot thread back to the role when the bot comments again after the host's reply", () => {
    const followedUp = botThread({
      comments: [
        ...botThread().comments,
        { author: HOST_LOGIN, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nFixed.`, url: "https://github.com/o/r/pull/7#discussion_r4" },
        { author: "copilot-pull-request-reviewer", byBot: true, body: "Still not fixed.", url: "https://github.com/o/r/pull/7#discussion_r5" },
      ],
    });

    const { forRole } = threadsForRole([followedUp], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole.map((thread) => thread.threadId), ["RT_bot"]);
  });

  it("drops a resolved thread outright, whoever opened it", () => {
    const { forRole, leftForHuman, unknown } = threadsForRole([botThread({ resolved: true })], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, []);
    assert.deepEqual(leftForHuman, []);
    assert.deepEqual(unknown, []);
  });

  it("sends a stranger's thread to leftForHuman and never to the role", () => {
    const { forRole, leftForHuman } = threadsForRole([strangerThread()], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, []);
    assert.deepEqual(leftForHuman, [strangerThread()]);
  });

  it("treats a thread with no author as left for a person too", () => {
    const noAuthor = strangerThread({ comments: [{ author: null, byBot: false, body: "???", url: "https://github.com/o/r/pull/7#discussion_r5" }] });

    const { forRole, leftForHuman } = threadsForRole([noAuthor], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole, []);
    assert.deepEqual(leftForHuman, [noAuthor]);
  });

  it("sends a thread to unknown, not leftForHuman, when it can't tell whether the author is the owner", () => {
    const uncertain = ownerThread({ comments: [{ author: "maybe-owner", byBot: false, body: "Hmm.", url: "https://github.com/o/r/pull/7#discussion_r6" }] });
    const unsure: IsOwner = () => undefined;

    const { forRole, leftForHuman, unknown } = threadsForRole([uncertain], unsure, HOST_LOGIN);

    assert.deepEqual(forRole, []);
    assert.deepEqual(leftForHuman, []);
    assert.deepEqual(unknown, [uncertain]);
  });

  it("drops a stranger's reply inside a kept bot thread, keeping only the bot's and the owner's comments", () => {
    const mixed = botThread({
      comments: [...botThread().comments, { author: "stranger", byBot: false, body: "I disagree.", url: "https://github.com/o/r/pull/7#discussion_r7" }],
    });

    const { forRole } = threadsForRole([mixed], isOwner, HOST_LOGIN);

    assert.deepEqual(forRole[0]!.comments, [{ author: "copilot-pull-request-reviewer", body: "Consider returning a Result<T> here." }]);
  });
});

// ---------------------------------------------------------------------------
// parseVerdicts
// ---------------------------------------------------------------------------

describe("parseVerdicts", () => {
  it("parses a well-formed array of verdicts", () => {
    const text = JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Returned a Result<T>.", commit: "a".repeat(7) }]);

    const { verdicts, rejected } = parseVerdicts(text);

    assert.deepEqual(verdicts, [{ threadId: "RT_bot", verdict: "fixed", reason: "Returned a Result<T>.", commit: "a".repeat(7) }]);
    assert.deepEqual(rejected, []);
  });

  it("throws when the file isn't a JSON array at all", () => {
    assert.throws(() => parseVerdicts(JSON.stringify({ threadId: "RT_bot" })), /array/i);
  });

  it("throws on text that isn't JSON", () => {
    assert.throws(() => parseVerdicts("not json"), /JSON|token|array/i);
  });

  it("rejects one malformed entry without losing the rest", () => {
    const good = { threadId: "RT_bot", verdict: "fixed", reason: "Returned a Result<T>." };
    const bad = { threadId: "RT_owner", verdict: "not-a-real-verdict", reason: "???" };
    const text = JSON.stringify([good, bad]);

    const { verdicts, rejected } = parseVerdicts(text);

    assert.deepEqual(verdicts, [good]);
    assert.deepEqual(rejected, [bad]);
  });

  it("gives an empty array when the role found nothing to say", () => {
    const { verdicts, rejected } = parseVerdicts("[]");

    assert.deepEqual(verdicts, []);
    assert.deepEqual(rejected, []);
  });
});

// ---------------------------------------------------------------------------
// threadActions
// ---------------------------------------------------------------------------

const forRoleBot: PromptThread = {
  threadId: "RT_bot",
  from: "bot",
  path: "src/Domain/Result.cs",
  line: 10,
  outdated: false,
  comments: [{ author: "copilot-pull-request-reviewer", body: "Consider returning a Result<T> here." }],
};

const forRoleOwner: PromptThread = {
  threadId: "RT_owner",
  from: "owner",
  path: "src/Domain/Result.cs",
  line: 20,
  outdated: false,
  comments: [{ author: "owner", body: "Why not use pattern matching here?" }],
};

describe("threadActions", () => {
  it("resolves a fixed bot thread ADDRESSED", () => {
    const verdict: ThreadVerdict = { threadId: "RT_bot", verdict: "fixed", reason: "Returned a Result<T>.", commit: "a".repeat(7) };

    const { actions, ignored } = threadActions([verdict], [forRoleBot]);

    assert.deepEqual(actions, [{ thread: forRoleBot, verdict, resolve: "ADDRESSED" }]);
    assert.deepEqual(ignored, []);
  });

  it("resolves an outdated bot thread ADDRESSED too", () => {
    const verdict: ThreadVerdict = { threadId: "RT_bot", verdict: "outdated", reason: "Already handled elsewhere." };

    const { actions } = threadActions([verdict], [forRoleBot]);

    assert.equal(actions[0]!.resolve, "ADDRESSED");
  });

  it("resolves a declined bot thread WONT_FIX by default", () => {
    const verdict: ThreadVerdict = { threadId: "RT_bot", verdict: "declined", reason: "Out of scope for this issue." };

    const { actions } = threadActions([verdict], [forRoleBot]);

    assert.equal(actions[0]!.resolve, "WONT_FIX");
  });

  it("resolves a declined bot thread INVALID when the verdict says the suggestion is factually wrong", () => {
    const verdict: ThreadVerdict = { threadId: "RT_bot", verdict: "declined", reason: "The code already does this.", invalid: true };

    const { actions } = threadActions([verdict], [forRoleBot]);

    assert.equal(actions[0]!.resolve, "INVALID");
  });

  it("never resolves an owner thread, whatever the verdict", () => {
    const verdict: ThreadVerdict = { threadId: "RT_owner", verdict: "fixed", reason: "Done." };

    const { actions } = threadActions([verdict], [forRoleOwner]);

    assert.equal(actions[0]!.resolve, undefined);
  });

  it("ignores a verdict for a thread id the role was never given", () => {
    const verdict: ThreadVerdict = { threadId: "RT_made_up", verdict: "fixed", reason: "Done." };

    const { actions, ignored } = threadActions([verdict], [forRoleBot]);

    assert.deepEqual(actions, []);
    assert.deepEqual(ignored, ["RT_made_up"]);
  });

  it("ignores a second verdict for a thread that already has one", () => {
    const first: ThreadVerdict = { threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) };
    const second: ThreadVerdict = { threadId: "RT_bot", verdict: "declined", reason: "Changed my mind." };

    const { actions, ignored } = threadActions([first, second], [forRoleBot]);

    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.verdict, first);
    assert.deepEqual(ignored, ["RT_bot"]);
  });
});

// ---------------------------------------------------------------------------
// replyBody, passSummaryComment, giveUpComment
// ---------------------------------------------------------------------------

const publicError = (text: string) => text.replaceAll("@", "@​").replaceAll(/#(\d+)/g, "#​$1");

describe("replyBody", () => {
  it("carries the host's reply marker and the reason through publicError", () => {
    const action: ThreadAction = {
      thread: forRoleBot,
      verdict: { threadId: "RT_bot", verdict: "fixed", reason: "Fixes @everyone's #123 concern.", commit: "a".repeat(7) },
      resolve: "ADDRESSED",
    };

    const body = replyBody(action, publicError);

    assert.match(body, new RegExp(FOLLOW_UP_REPLY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(!body.includes("@everyone"), "expected the mention to be broken by publicError");
    assert.ok(!body.includes("#123"), "expected the cross-reference to be broken by publicError");
  });

  it("names the commit when the verdict gives one", () => {
    const action: ThreadAction = {
      thread: forRoleBot,
      verdict: { threadId: "RT_bot", verdict: "fixed", reason: "Returned a Result<T>.", commit: "abc1234" },
      resolve: "ADDRESSED",
    };

    assert.match(replyBody(action, publicError), /abc1234/);
  });

  it("never resolves, and says so, for an owner thread", () => {
    const action: ThreadAction = { thread: forRoleOwner, verdict: { threadId: "RT_owner", verdict: "declined", reason: "Disagree." }, resolve: undefined };

    const body = replyBody(action, publicError);

    assert.match(body, /Left open for the repository owner/);
    assert.doesNotMatch(body, /Resolved as/);
  });
});

describe("passSummaryComment", () => {
  const report: PassReport = {
    pass: 1,
    pushed: "a".repeat(40),
    merged: "clean",
    actions: [{ thread: forRoleBot, verdict: { threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }, resolve: "ADDRESSED" }],
    ignored: ["RT_made_up"],
    unverified: [],
    failedWrites: [],
    leftForHuman: 1,
  };

  it("carries the follow-up marker and names the pass number against the cap", () => {
    const comment = passSummaryComment(report, publicError);

    assert.match(comment, new RegExp(FOLLOW_UP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(comment, new RegExp(`pass 1 of ${FOLLOW_UP_PASS_CAP}`, "i"));
  });

  it("names each thread action's resolution", () => {
    const comment = passSummaryComment(report, publicError);

    assert.match(comment, /ADDRESSED/);
  });

  it("says a thread was left open for the owner when it was only replied to", () => {
    const ownerReport: PassReport = { ...report, actions: [{ thread: forRoleOwner, verdict: { threadId: "RT_owner", verdict: "fixed", reason: "Done." }, resolve: undefined }] };

    assert.match(passSummaryComment(ownerReport, publicError), /left open for the owner/i);
  });

  it("sends each reason and ignored id through publicError, as a reply's reason is", () => {
    const hideSecret = (text: string) => text.replaceAll("sk-ant-secret", "[redacted]");
    const leaky: PassReport = {
      ...report,
      actions: [{ thread: forRoleBot, verdict: { threadId: "RT_bot", verdict: "declined", reason: "Echoed sk-ant-secret." }, resolve: "WONT_FIX" }],
      ignored: ["RT_sk-ant-secret"],
    };

    const comment = passSummaryComment(leaky, hideSecret);

    assert.doesNotMatch(comment, /sk-ant-secret/);
    assert.match(comment, /Echoed \[redacted\]/);
  });

  it("leaves no live comment opener, mention or reference from the role's text, through plainText", () => {
    const hostile: PassReport = {
      ...report,
      actions: [{ thread: forRoleBot, verdict: { threadId: "RT_bot", verdict: "declined", reason: "<!-- sandcastle:follow-up --> @everyone see #123" }, resolve: "WONT_FIX" }],
      ignored: ["<!-- sandcastle:follow-up -->@everyone"],
    };

    const comment = passSummaryComment(hostile, (text) => text);

    assert.equal(comment.split("<!--").length - 1, 1, "only the host's own marker opens a comment");
    assert.doesNotMatch(comment, /(^|[^\w`])@everyone\b/);
    assert.doesNotMatch(comment, /(^|\s)#123\b/);
  });

  it("cuts a long reason without splitting a character in two", () => {
    const long: PassReport = {
      ...report,
      actions: [{ thread: forRoleBot, verdict: { threadId: "RT_bot", verdict: "declined", reason: `${"x".repeat(299)}😀 and more` }, resolve: "WONT_FIX" }],
    };

    const comment = passSummaryComment(long, publicError);

    assert.doesNotMatch(comment, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("lists the threads whose \"fixed\" verdict named no commit the pass added", () => {
    assert.match(passSummaryComment({ ...report, unverified: ["RT_bot"] }, publicError), /no commit this pass added[^\n]*RT_bot/);
  });

  it("says the gate was red on the PR's head when the pass fixed it", () => {
    const comment = passSummaryComment({ ...report, redCi: { fix: true, rerun: [], forward: [] } }, publicError);

    assert.match(comment, /`scripts\/gate\.sh` was red on the PR's head/);
  });

  it("names the checks whose failed-job logs went to the follow-up role", () => {
    const comment = passSummaryComment({ ...report, redCi: { fix: false, rerun: [], forward: ["Analyze (csharp)"] } }, publicError);

    assert.match(comment, /failed-job logs[^\n]*Analyze \(csharp\)/);
  });

  it("says nothing about red CI when no check was red", () => {
    const comment = passSummaryComment({ ...report, redCi: { fix: false, rerun: [], forward: [] } }, publicError);

    assert.equal(comment, passSummaryComment(report, publicError));
  });
});

describe("giveUpComment", () => {
  it("quotes the gate's tail in a fence", () => {
    const comment = giveUpComment("the gate is still red after 2 gate-fixer attempts", "Line 1\nLine 2\nFAIL");

    assert.match(comment, /the gate is still red/);
    assert.match(comment, /FAIL/);
    assert.match(comment, /```/);
  });

  it("names how to re-queue the PR", () => {
    assert.match(giveUpComment("a conflict couldn't be resolved", undefined), /sandcastle:needs-human/);
  });
});

// ---------------------------------------------------------------------------
// isGateCovered / planRedCi
// ---------------------------------------------------------------------------

// Acceptance criterion: "The decision between fix, re-run and CodeQL is unit
// tested with stubbed check data."
describe("isGateCovered", () => {
  for (const name of ["Build Solution", "Tests: Domain.Tests.Unit", "Tests: Architecture.Tests", "markdownlint", "yamllint"]) {
    it(`treats "${name}" as a job scripts/gate.sh reproduces`, () => {
      assert.equal(isGateCovered(name), true);
    });
  }

  for (const name of ["Analyze (csharp)", "Analyze (actions)", "Analyze", "Python tests", "Hook tests", "Docs-only label"]) {
    it(`treats "${name}" as a check scripts/gate.sh doesn't reproduce`, () => {
      assert.equal(isGateCovered(name), false);
    });
  }
});

describe("planRedCi", () => {
  it("fixes a build the gate reproduces, regardless of which checks are red", () => {
    const plan: RedCiPlan = planRedCi(false, [redCheck({ name: "Build Solution" })]);

    assert.deepEqual(plan, { fix: true, rerun: [], forward: [] });
  });

  it("fixes even when the only red check is one the gate doesn't cover, since the gate itself is red", () => {
    const plan: RedCiPlan = planRedCi(false, [redCheck({ name: "Analyze (csharp)" })]);

    assert.deepEqual(plan, { fix: true, rerun: [], forward: [] });
  });

  it("re-runs a gate-covered check once the gate is green", () => {
    const plan: RedCiPlan = planRedCi(true, [redCheck({ name: "Tests: Domain.Tests.Unit" })]);

    assert.deepEqual(plan, { fix: false, rerun: ["Tests: Domain.Tests.Unit"], forward: [] });
  });

  it("forwards a check the gate doesn't cover once the gate is green", () => {
    const plan: RedCiPlan = planRedCi(true, [redCheck({ name: "Analyze (csharp)" })]);

    assert.deepEqual(plan, { fix: false, rerun: [], forward: ["Analyze (csharp)"] });
  });

  it("sorts red checks of both kinds into rerun and forward once the gate is green", () => {
    const plan: RedCiPlan = planRedCi(true, [redCheck({ name: "Build Solution" }), redCheck({ name: "Analyze (csharp)" })]);

    assert.deepEqual(plan, { fix: false, rerun: ["Build Solution"], forward: ["Analyze (csharp)"] });
  });

  it("does nothing when the gate is green and no check is red", () => {
    const plan: RedCiPlan = planRedCi(true, []);

    assert.deepEqual(plan, { fix: false, rerun: [], forward: [] });
  });
});

// ---------------------------------------------------------------------------
// runPass
// ---------------------------------------------------------------------------

function sandboxFake(
  options: {
    gateExitCodes?: number[];
    followUpJson?: string;
    mergeConflictFiles?: string[];
    roleFailing?: string[];
    roleFailWith?: Record<string, Error>;
    roleUnfinished?: string[];
    // The role finishes a conflicted merge with `git merge --abort` rather
    // than a merge commit, so its commit doesn't contain main.
    abandonsMerge?: boolean;
    // The role's commit shares no history with the PR's head.
    rewritesHistory?: boolean;
    // Something commits while scripts/gate.sh runs.
    gateCommits?: boolean;
    // These roles leave the worktree's head exactly as they found it: a
    // follow-up run that declines every thread and fixes nothing from a
    // forwarded log commits nothing (#79), unlike every other test's role,
    // which always commits to simulate a change.
    roleNoCommit?: string[];
  } = {},
) {
  const execCalls: string[] = [];
  const runs: SandboxRunOptions[] = [];
  const steps: string[] = [];
  let headNumber = 0;
  const nextHead = () => (++headNumber).toString(16).padStart(40, "0");
  // Each commit's history, itself included, so `git merge-base --is-ancestor`
  // and `git rev-parse --verify` answer as they would in a real repository.
  const history = new Map<string, Set<string>>([
    [HEAD, new Set([HEAD])],
    [BASE, new Set([BASE])],
  ]);
  let head = HEAD;
  let mergeConflicted = false;
  const commit = (sha: string, options: { from?: Set<string>; withMain?: boolean } = {}) => {
    history.set(sha, new Set([...(options.from ?? history.get(head)!), ...(options.withMain ? history.get(BASE)! : []), sha]));
    head = sha;
  };
  const gateExitCodes = [...(options.gateExitCodes ?? [0])];

  const sandbox = {
    worktreePath: "/worktree",
    exec: async (command: string) => {
      execCalls.push(command);
      // Every exec call lands here too, alongside role runs, so a test can
      // compare an exec's position against a role's in one timeline instead
      // of mixing this array with execCalls, which only ever grows.
      steps.push(command);
      if (command.startsWith("rm -f")) return { stdout: "", stderr: "", exitCode: 0 };
      if (command.startsWith("git reset --hard")) return { stdout: "", stderr: "", exitCode: 0 };
      if (command === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "", exitCode: 0 };
      const verify = /^git rev-parse --verify --quiet '([0-9a-f]+)\^\{commit\}'$/.exec(command);
      if (verify !== null) {
        const found = [...history.keys()].find((sha) => sha.startsWith(verify[1]!));
        return found === undefined ? { stdout: "", stderr: "", exitCode: 1 } : { stdout: `${found}\n`, stderr: "", exitCode: 0 };
      }
      const ancestry = /^git merge-base --is-ancestor '([^']+)' '([^']+)'$/.exec(command);
      if (ancestry !== null) {
        return { stdout: "", stderr: "", exitCode: history.get(ancestry[2]!)?.has(ancestry[1]!) === true ? 0 : 1 };
      }
      if (command === "git merge --abort") {
        mergeConflicted = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.startsWith("git merge ")) {
        if ((options.mergeConflictFiles?.length ?? 0) > 0) {
          mergeConflicted = true;
          return { stdout: "CONFLICT", stderr: "", exitCode: 1 };
        }
        commit(nextHead(), { withMain: true });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("diff --name-only --diff-filter=U")) {
        return { stdout: (options.mergeConflictFiles ?? []).join("\n"), stderr: "", exitCode: 0 };
      }
      if (command.startsWith("cat") && command.includes("follow-up.json")) {
        return options.followUpJson === undefined ? { stdout: "", stderr: "", exitCode: 1 } : { stdout: options.followUpJson, stderr: "", exitCode: 0 };
      }
      if (command.startsWith("git status")) return { stdout: "", stderr: "", exitCode: 0 };
      const exitCode = gateExitCodes.shift();
      if (exitCode === undefined) throw new Error("the gate ran more often than the test expected");
      if (options.gateCommits) commit(nextHead());
      return { stdout: `gate output, exit ${exitCode}\n`, stderr: "", exitCode };
    },
    run: async (opts: SandboxRunOptions) => {
      const role = opts.name!;
      runs.push(opts);
      steps.push(role);
      if (options.roleFailing?.includes(role)) throw options.roleFailWith?.[role] ?? new Error(`${role} failed`);
      if (!options.roleNoCommit?.includes(role)) {
        commit(role === "follow-up" ? ROLE_COMMIT : nextHead(), {
          from: options.rewritesHistory ? new Set() : undefined,
          withMain: mergeConflicted && !options.abandonsMerge,
        });
      }
      mergeConflicted = false;
      return {
        iterations: [],
        commits: [{ sha: head }],
        completionSignal: options.roleUnfinished?.includes(role) ? undefined : "<promise>COMPLETE</promise>",
      };
    },
    close: async () => ({}),
  } as unknown as Sandbox;

  return { sandbox, execCalls, runs, steps, headOf: () => head };
}

function passHostFake(
  options: {
    threads?: ReviewThread[];
    headRefOid?: string;
    containsBase?: boolean;
    passCount?: number;
    markBuildingResult?: boolean;
    sandbox?: ReturnType<typeof sandboxFake>;
    pushError?: Error;
    leaksSecret?: SecretMatch;
    worktreeProblems?: string[];
    isOwnerFn?: IsOwner;
    hostLogin?: string;
    // What GitHub says once the issue is claimed, when it changed meanwhile.
    threadsAfterClaim?: ReviewThread[];
    passCountAfterClaim?: number;
    // The branch's head on GitHub after a failed push; by default someone
    // else pushed meanwhile.
    remoteHead?: string;
    // A fresh read of the PR's current checks (host.checks); defaults to no
    // red checks.
    checks?: HeadCheck[];
    // The head host.checks says its checks were read from; defaults to the
    // PR's head, so a test must say when it's read a race (#79).
    checksHeadRefOid?: string;
    // The state of the re-run checks host.rerunFailedChecks reports once it
    // settles; defaults to still red, so a test must say when the re-run
    // fixed it.
    rerunResult?: CheckState[];
    // host.failedCheckLog's answer.
    failedCheckLog?: string;
  } = {},
) {
  const calls = {
    fetchBranch: [] as string[],
    markBuilding: [] as number[],
    unmarkBuilding: [] as number[],
    createSandbox: [] as string[],
    push: [] as { branch: string; commit: string }[],
    replyToThread: [] as { threadId: string; body: string }[],
    resolveThread: [] as string[],
    commentOnPullRequest: [] as { pr: number; body: string }[],
    handBack: [] as { pr: number; reason: string; body: string }[],
    recordHumanThread: [] as HumanThreadEntry[],
    checks: [] as number[],
    rerunFailedChecks: [] as { pr: number; checkNames: string[]; expectedHead: string }[],
    failedCheckLog: [] as { pr: number; checkNames: string[]; expectedHead: string }[],
    log: [] as string[],
  };
  const sandbox = options.sandbox ?? sandboxFake();
  const passHost: PassHost = {
    fetchBranch: (branch) => void calls.fetchBranch.push(branch),
    reviewThreads: () => ({
      headRefOid: options.headRefOid ?? HEAD,
      threads: (calls.markBuilding.length > 0 ? options.threadsAfterClaim : undefined) ?? options.threads ?? [],
    }),
    isOwner: options.isOwnerFn ?? isOwner,
    hostLogin: () => options.hostLogin ?? HOST_LOGIN,
    passCount: () => (calls.markBuilding.length > 0 ? options.passCountAfterClaim : undefined) ?? options.passCount ?? 0,
    contains: () => options.containsBase ?? true,
    markBuilding: (issueNumber) => {
      calls.markBuilding.push(issueNumber);
      return options.markBuildingResult ?? true;
    },
    unmarkBuilding: (issueNumber) => void calls.unmarkBuilding.push(issueNumber),
    createSandbox: async (branch) => {
      calls.createSandbox.push(branch);
      return sandbox.sandbox;
    },
    worktreeProblems: () => options.worktreeProblems ?? [],
    leaksSecret: () => options.leaksSecret,
    push: async (branch, commit) => {
      calls.push.push({ branch, commit });
      if (options.pushError) throw options.pushError;
    },
    remoteHead: () => options.remoteHead ?? "f".repeat(40),
    checks: (pr) => {
      calls.checks.push(pr);
      return { headRefOid: options.checksHeadRefOid ?? options.headRefOid ?? HEAD, checks: options.checks ?? [] };
    },
    rerunFailedChecks: (pr, checkNames, expectedHead) => {
      calls.rerunFailedChecks.push({ pr, checkNames: [...checkNames], expectedHead });
      return options.rerunResult ?? [...checkNames].map((name) => redCheck({ name }));
    },
    failedCheckLog: (pr, checkNames, expectedHead, limit) => {
      calls.failedCheckLog.push({ pr, checkNames: [...checkNames], expectedHead });
      const text = options.failedCheckLog ?? "";
      // Mirrors the live host's per-run truncation (lib/github.mts#failedCheckLogs)
      // for this stub's single simulated run, keeping the end, where the
      // error is.
      if (limit === undefined || text.length <= limit) return text;
      return text.slice(-limit);
    },
    replyToThread: (threadId, body) => void calls.replyToThread.push({ threadId, body }),
    resolveThread: (threadId) => void calls.resolveThread.push(threadId),
    commentOnPullRequest: (pr, body) => void calls.commentOnPullRequest.push({ pr, body }),
    handBack: (pr, reason, body) => void calls.handBack.push({ pr, reason, body }),
    recordHumanThread: (entry) => void calls.recordHumanThread.push(entry),
    publicError: (text) => String(text),
    limits: new RunLimits(),
    log: (line) => void calls.log.push(line),
  };
  return { passHost, calls, sandbox };
}

describe("runPass", () => {
  // Acceptance criterion: "A settled PR with an open Copilot thread gets one
  // pass: a fix commit, a reply on the thread, the thread resolved, and a
  // pass-summary comment."
  it("fixes a bot thread, pushes the gated commit, replies, resolves the thread and posts the pass summary, in that order", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Returned a Result<T>.", commit: "a".repeat(7) }]) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "passed");
    assert.deepEqual(sandbox.steps.filter((step) => step === "follow-up"), ["follow-up"]);
    assert.equal(calls.push.length, 1);
    assert.equal(calls.replyToThread.length, 1);
    assert.equal(calls.replyToThread[0]!.threadId, "RT_bot");
    assert.deepEqual(calls.resolveThread, ["RT_bot"]);
    assert.equal(calls.commentOnPullRequest.length, 1);
    assert.match(calls.commentOnPullRequest[0]!.body, new RegExp(FOLLOW_UP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  // Acceptance criterion: "An owner thread is replied to but never resolved
  // (tested with stubbed verdicts)."
  for (const verdict of ["fixed", "declined", "outdated"] as const) {
    it(`replies to an owner thread given a "${verdict}" verdict, but never resolves it`, async () => {
      const commit = verdict === "fixed" ? { commit: ROLE_COMMIT.slice(0, 7) } : {};
      const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_owner", verdict, reason: "Noted.", ...commit }]) });
      const { passHost, calls } = passHostFake({ threads: [ownerThread(), botThread()], containsBase: true, sandbox });

      await runPass(passTarget(), issue, BASE, passHost);

      assert.equal(calls.replyToThread.length, 1);
      assert.equal(calls.replyToThread[0]!.threadId, "RT_owner");
      assert.deepEqual(calls.resolveThread, []);
    });
  }

  it("excludes an owner thread from the role once the host has already replied and is waiting on the owner", async () => {
    const answered = ownerThread({
      comments: [...ownerThread().comments, { author: "sandcastle-bot", byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nNoted.`, url: "https://github.com/o/r/pull/7#discussion_r4" }],
    });
    const sandbox = sandboxFake({ followUpJson: "[]" });
    const { passHost } = passHostFake({ threads: [answered, botThread()], containsBase: true, sandbox });

    await runPass(passTarget(), issue, BASE, passHost);

    const roleRun = sandbox.runs.find((run) => run.name === "follow-up");
    assert.ok(roleRun !== undefined, "the bot thread starts a pass");
    assert.ok(!String(roleRun?.promptArgs?.THREADS_JSON ?? "").includes("RT_owner"));
  });

  // Acceptance criterion: "A thread opened by someone other than the owner
  // or a bot never reaches the follow-up role (tested)."
  it("never gives a stranger's thread to the follow-up role, and records it for a person instead", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]" });
    const { passHost, calls } = passHostFake({ threads: [strangerThread(), botThread()], containsBase: true, sandbox });

    await runPass(passTarget(), issue, BASE, passHost);

    const roleRun = sandbox.runs.find((run) => run.name === "follow-up");
    assert.ok(roleRun !== undefined, "the bot thread starts a pass");
    assert.ok(!String(roleRun?.promptArgs?.THREADS_JSON ?? "").includes("RT_stranger"));
    // Recorded on each read of the PR, before and after the claim; the live
    // host lists each thread once (livePassHost.recordHumanThread).
    assert.deepEqual(new Set(calls.recordHumanThread.map((entry) => JSON.stringify(entry))), new Set([JSON.stringify({ pr: PR_NUMBER, author: "stranger", url: strangerThread().comments[0]!.url })]));
  });

  it("creates no sandbox when a thread's author can't be confirmed as the repository owner", async () => {
    const uncertain = ownerThread({ comments: [{ author: "maybe-owner", byBot: false, body: "Hmm.", url: "https://github.com/o/r/pull/7#discussion_r6" }] });
    const { passHost, calls } = passHostFake({ threads: [uncertain], containsBase: true, isOwnerFn: () => undefined });

    await runPass(passTarget(), issue, BASE, passHost);

    assert.deepEqual(calls.createSandbox, []);
  });

  // Acceptance criterion: "Verdicts for unknown thread ids are ignored
  // (tested)."
  for (const verdict of [
    { threadId: "RT_made_up", verdict: "fixed", reason: "Done." },
    { threadId: "RT_made_up", verdict: "declined", reason: "Out of scope." },
  ]) {
    it(`ignores a "${verdict.verdict}" verdict for an unknown thread id: no reply, no resolve, and it's listed as ignored in the summary`, async () => {
      const sandbox = sandboxFake({ followUpJson: JSON.stringify([verdict]) });
      const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

      await runPass(passTarget(), issue, BASE, passHost);

      assert.deepEqual(calls.replyToThread, []);
      assert.deepEqual(calls.resolveThread, []);
      assert.match(calls.commentOnPullRequest[0]!.body, /Ignored verdicts[^\n]*RT_made_up/);
      assert.doesNotMatch(calls.commentOnPullRequest[0]!.body, /no commit this pass added/);
    });
  }

  it("doesn't let a thread's second verdict win when its first, a \"fixed\" one, names no commit the pass added", async () => {
    const verdicts = [
      { threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "b".repeat(7) },
      { threadId: "RT_bot", verdict: "declined", reason: "Out of scope." },
    ];
    const sandbox = sandboxFake({ followUpJson: JSON.stringify(verdicts) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

    await runPass(passTarget(), issue, BASE, passHost);

    assert.deepEqual(calls.replyToThread, []);
    assert.deepEqual(calls.resolveThread, []);
  });

  it("tells the role no merge is needed, without claiming the branch contains main, when the PR is only behind", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]" });
    const { passHost } = passHostFake({ threads: [botThread()], containsBase: false, sandbox });

    await runPass(passTarget(), issue, BASE, passHost);

    const merge = String(sandbox.runs[0]?.promptArgs?.MERGE ?? "");
    assert.match(merge, /No merge with main is needed/);
    assert.doesNotMatch(merge, /contains main/);
  });

  // Acceptance criterion: "A `DIRTY` PR gets `main` merged in (no rebase or
  // force-push) and is pushed once the gate is green."
  it("merges main before running the role when the PR needs it, never rebasing or force-pushing", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]" });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: false, sandbox });

    await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    const resetIndex = sandbox.steps.findIndex((step) => step.startsWith("git reset --hard"));
    const mergeIndex = sandbox.steps.findIndex((step) => step.startsWith("git merge"));
    const roleIndex = sandbox.steps.indexOf("follow-up");
    assert.ok(resetIndex !== -1 && mergeIndex !== -1 && resetIndex < mergeIndex, "expected the merge to come after the reset");
    assert.ok(mergeIndex < roleIndex, "expected the merge to come before the follow-up role");
    assert.ok(!sandbox.execCalls.some((call) => call.includes("rebase")), "runPass must never rebase");
    assert.ok(!sandbox.execCalls.some((call) => /--force/.test(call)), "runPass must never force anything");
    assert.equal(calls.push.length, 1);
  });

  it("gives up and quotes the gate's tail when the gate stays red after the gate-fixer's attempts", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]", gateExitCodes: [1, 1, 1] });
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false, sandbox });

    const outcome = await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    assert.deepEqual(calls.push, []);
    assert.equal(outcome.kind, "gave-up");
    assert.equal(calls.handBack.length, 1);
    assert.match(calls.handBack[0]!.body, /gate output, exit 1/);
  });

  // Acceptance criterion: "A fourth pass isn't started. The PR gets
  // `sandcastle:needs-human` instead."
  it("hands the PR back instead of starting a fourth pass", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()], passCount: FOLLOW_UP_PASS_CAP });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.deepEqual(calls.createSandbox, []);
    assert.equal(calls.handBack.length, 1);
    assert.match(calls.handBack[0]!.reason, new RegExp(String(FOLLOW_UP_PASS_CAP)));
  });

  it("runs a third pass and says so in its summary, one under the cap", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }]) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox, passCount: FOLLOW_UP_PASS_CAP - 1 });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "passed");
    assert.match(calls.commentOnPullRequest[0]!.body, new RegExp(`pass ${FOLLOW_UP_PASS_CAP} of ${FOLLOW_UP_PASS_CAP}`, "i"));
  });

  it("skips a PR whose head moved since the sweep read it, without creating a sandbox", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()], headRefOid: "f".repeat(40) });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("skips a PR whose only threads for the role are owner threads and that needs no merge, without creating a sandbox", async () => {
    const { passHost, calls } = passHostFake({ threads: [ownerThread()], containsBase: true });

    const outcome = await runPass(passTarget({ reasons: ["CI is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("doesn't run the follow-up role when GitHub's conflict merges in cleanly here and no thread is left for it, but still gates and pushes the merge", async () => {
    const sandbox = sandboxFake();
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false, sandbox });

    const outcome = await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    assert.deepEqual(sandbox.runs, []);
    assert.deepEqual(outcome, { kind: "passed", pushed: sandbox.headOf() });
    assert.deepEqual(calls.push, [{ branch: BRANCH, commit: sandbox.headOf() }]);
    assert.match(calls.commentOnPullRequest[0]!.body, /Merged `main` into the branch\./);
  });

  it("doesn't merge main into a PR that's only behind it, and so skips one that's otherwise only red on CI", async () => {
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false });

    const outcome = await runPass(passTarget({ reasons: ["check build is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("answers a bot thread on a PR that's only behind main without merging main in", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]" });
    const { passHost } = passHostFake({ threads: [botThread()], containsBase: false, sandbox });

    await runPass(passTarget(), issue, BASE, passHost);

    assert.ok(!sandbox.execCalls.some((call) => call.startsWith("git merge ")), sandbox.execCalls.join("\n"));
  });

  it("leaves a bot thread the host answered alone on the next pass, whether its resolve failed or the owner unresolved it", async () => {
    const answered = botThread({
      comments: [...botThread().comments, { author: HOST_LOGIN, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\n**Declined.** Resolved as won't fix.`, url: "https://github.com/o/r/pull/7#discussion_r4" }],
    });
    const { passHost, calls } = passHostFake({ threads: [answered], containsBase: true });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.resolveThread, []);
    assert.deepEqual(calls.replyToThread, []);
    assert.deepEqual(calls.createSandbox, []);
  });

  it("doesn't hand the PR back from the read before the claim, even at the cap", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()], passCount: FOLLOW_UP_PASS_CAP, markBuildingResult: false });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.handBack, []);
  });

  it("hands the PR back when its sandbox can't be created, rather than failing the same way every round", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true });
    passHost.createSandbox = async () => {
      throw new Error("the worktree no longer points at this repository");
    };

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /creating the sandbox failed/);
    assert.match(calls.handBack[0]!.body, /no longer points at this repository/);
    assert.deepEqual(calls.unmarkBuilding, [ISSUE_NUMBER]);
  });

  it("skips a PR that needs no merge and has no thread for the role, without creating a sandbox", async () => {
    const { passHost, calls } = passHostFake({ threads: [], containsBase: true });

    const outcome = await runPass(passTarget({ reasons: [] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("claims the building label before creating a sandbox, and releases it even when the pass throws", async () => {
    const sandbox = sandboxFake({ roleFailing: ["follow-up"] });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

    await runPass(passTarget(), issue, BASE, passHost).catch(() => undefined);

    assert.deepEqual(calls.markBuilding, [ISSUE_NUMBER]);
    assert.deepEqual(calls.unmarkBuilding, [ISSUE_NUMBER]);
  });

  it("creates no sandbox when another run already claimed the issue's building label", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, markBuildingResult: false });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("rethrows an UncountedStopError from the follow-up role instead of giving up", async () => {
    const stop = new UncountedStopError("usage limit reached");
    const sandbox = sandboxFake({ roleFailing: ["follow-up"], roleFailWith: { "follow-up": stop } });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

    await assert.rejects(() => runPass(passTarget(), issue, BASE, passHost), (error: unknown) => error instanceof UncountedStopError);

    assert.deepEqual(calls.handBack, []);
    assert.deepEqual(calls.commentOnPullRequest, []);
  });

  it("still posts replies and the pass summary when nothing needed pushing", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "declined", reason: "Out of scope." }]) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "passed");
    assert.equal(calls.replyToThread.length, 1);
    assert.equal(calls.commentOnPullRequest.length, 1);
  });

  it("neither replies nor comments when the push fails because someone else pushed meanwhile", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }]) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox, pushError: new Error("! [rejected] (non-fast-forward)") });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "push-failed");
    assert.deepEqual(calls.replyToThread, []);
    assert.deepEqual(calls.commentOnPullRequest, []);
    assert.deepEqual(calls.handBack, []);
  });

  it("hands the PR back when the push fails and the PR's head hasn't moved, so another round would fail the same way", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }]) });
    const { passHost, calls } = passHostFake({
      threads: [botThread()],
      containsBase: true,
      sandbox,
      pushError: new Error("! [remote rejected] (protected branch hook declined)"),
      remoteHead: HEAD,
    });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.equal(calls.handBack.length, 1);
    assert.match(calls.handBack[0]!.body, /protected branch hook declined/);
    assert.deepEqual(calls.replyToThread, []);
  });

  it("answers the threads and posts the summary when a push that reported an error landed anyway", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }]) });
    const { passHost, calls } = passHostFake({
      threads: [botThread()],
      containsBase: true,
      sandbox,
      pushError: new Error("HTTP 502"),
      remoteHead: ROLE_COMMIT,
    });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.deepEqual(outcome, { kind: "passed", pushed: ROLE_COMMIT });
    assert.deepEqual(calls.resolveThread, ["RT_bot"]);
    assert.equal(calls.commentOnPullRequest.length, 1);
  });

  it("decides from what GitHub says once the issue is claimed: a thread another run answered meanwhile isn't passed on", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()], threadsAfterClaim: [botThread({ resolved: true })], containsBase: true });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
    assert.deepEqual(calls.unmarkBuilding, [ISSUE_NUMBER]);
  });

  it("hands the PR back, with no sandbox, when another run took it to the cap before this one claimed it", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()], passCount: FOLLOW_UP_PASS_CAP - 1, passCountAfterClaim: FOLLOW_UP_PASS_CAP });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("pushes nothing when HEAD moved while the gate ran", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]", gateExitCodes: [0, 0, 0], gateCommits: true });
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false, sandbox });

    const outcome = await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.deepEqual(calls.push, []);
    assert.match(calls.handBack[0]!.reason, /HEAD moved while it ran/);
    assert.match(calls.handBack[0]!.body, /moved while it ran/);
  });

  // A "fixed" verdict is only believed for a commit the pass added.
  for (const [scenario, commit] of [
    ["names a commit the branch doesn't hold", "b".repeat(7)],
    ["names a commit already on the PR before the pass", HEAD.slice(0, 7)],
    ["names no commit at all", undefined],
  ] as const) {
    it(`neither replies to nor resolves a thread whose "fixed" verdict ${scenario}, and says so in the summary`, async () => {
      const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit }]) });
      const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

      const outcome = await runPass(passTarget(), issue, BASE, passHost);

      assert.equal(outcome.kind, "passed");
      assert.deepEqual(calls.replyToThread, []);
      assert.deepEqual(calls.resolveThread, []);
      assert.match(calls.commentOnPullRequest[0]!.body, /no commit this pass added[^\n]*RT_bot/);
    });
  }

  for (const [scenario, commit] of [
    ["one of main's commits the merge brought in", BASE],
    ["the merge commit the host made itself", "1".padStart(40, "0")],
  ] as const) {
    it(`leaves a bot thread open when its "fixed" verdict names ${scenario}`, async () => {
      const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit }]) });
      const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: false, sandbox });

      const outcome = await runPass(passTarget({ conflicted: true }), issue, BASE, passHost);

      assert.equal(outcome.kind, "passed");
      assert.deepEqual(calls.resolveThread, []);
      assert.match(calls.commentOnPullRequest[0]!.body, /no commit this pass added[^\n]*RT_bot/);
    });
  }

  it("gives up without pushing when a commit holds a secret", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }]) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox, leaksSecret: sampleSecretMatch });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.deepEqual(calls.push, []);
    assert.equal(calls.handBack.length, 1);
  });

  it("logs the match's location, and adds it to the hand-back's entry in the run report, without naming the secret itself or changing the PR comment", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }]) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox, leaksSecret: sampleSecretMatch });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    const logged = calls.log.join("\n");
    assert.match(logged, /src\/example\.ts/);
    assert.match(logged, /\b3\b/);
    assert.equal(calls.handBack.length, 1);
    // The run report shows the hand-back's reason (lib/report.mts#handBackLines); the PR comment never does (#324).
    assert.match(calls.handBack[0]!.reason, /src\/example\.ts/);
    assert.doesNotMatch(calls.handBack[0]!.body, /src\/example\.ts/);
  });
});

// ---------------------------------------------------------------------------
// followUpPassPhase
// ---------------------------------------------------------------------------

// AC: every PR a follow-up pass touched reaches the run report with its outcome.
describe("passOutcomeEntry", () => {
  it("names a passed pass's pushed commit, abbreviated", () => {
    const outcome: PassOutcome = { kind: "passed", pushed: "a".repeat(40) };

    assert.deepEqual(passOutcomeEntry(passTarget(), outcome), {
      kind: "pr",
      number: PR_NUMBER,
      outcome: "follow-up pass",
      detail: `pushed ${"a".repeat(7)}`,
    });
  });

  it("says nothing needed pushing when a passed pass pushed nothing", () => {
    const outcome: PassOutcome = { kind: "passed", pushed: undefined };

    assert.deepEqual(passOutcomeEntry(passTarget(), outcome), {
      kind: "pr",
      number: PR_NUMBER,
      outcome: "follow-up pass",
      detail: "nothing needed pushing",
    });
  });

  it("gives a neutral detail for a push-failed outcome, since the error isn't always a moved head", () => {
    const outcome: PassOutcome = { kind: "push-failed", error: "non-fast-forward" };

    assert.deepEqual(passOutcomeEntry(passTarget(), outcome), {
      kind: "pr",
      number: PR_NUMBER,
      outcome: "follow-up pass",
      detail: "its push failed; see the run log; swept again next round",
    });
  });

  it("is undefined for a pass that gave up, since the hand-back already makes a row", () => {
    const outcome: PassOutcome = { kind: "gave-up", reason: "it has had 2 follow-up passes already" };

    assert.equal(passOutcomeEntry(passTarget(), outcome), undefined);
  });

  it("is undefined for a skipped pass, since nothing was touched", () => {
    const outcome: PassOutcome = { kind: "skipped", reason: "its head moved since the sweep read it" };

    assert.equal(passOutcomeEntry(passTarget(), outcome), undefined);
  });
});

describe("followUpPassPhase", () => {
  const otherIssue: SandcastleIssue = { number: 51, title: "Tidy up the widget", body: "", labels: ["Sandcastle"], comments: [] };
  const targets = [passTarget(), passTarget({ number: 8, id: "PR_8", headRefName: "feature/51-tidy-widget", issueNumber: 51 })];

  it("fetches every target's branch before running any pass", async () => {
    const { passHost, calls } = passHostFake({ threads: [] });

    await followUpPassPhase(targets, [issue, otherIssue], BASE, passHost);

    assert.deepEqual(calls.fetchBranch, [BRANCH, "feature/51-tidy-widget"]);
  });

  it("returns one outcome per target", async () => {
    const { passHost } = passHostFake({ threads: [], containsBase: true });

    const outcomes = await followUpPassPhase(targets, [issue, otherIssue], BASE, passHost);

    assert.equal(outcomes.length, targets.length);
  });

  it("rethrows the first UncountedStopError only after every pass has settled", async () => {
    const stop = new UncountedStopError("usage limit reached");
    const stoppingSandbox = sandboxFake({ roleFailing: ["follow-up"], roleFailWith: { "follow-up": stop } });
    const slowSandbox = sandboxFake({ followUpJson: "[]" });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true });
    // The second PR's sandbox comes a few ticks after the first PR's pass has
    // already thrown, so the rethrow has to wait for it.
    passHost.createSandbox = async (branch) => {
      calls.createSandbox.push(branch);
      if (branch === BRANCH) return stoppingSandbox.sandbox;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return slowSandbox.sandbox;
    };

    await assert.rejects(
      () => followUpPassPhase(targets, [issue, otherIssue], BASE, passHost),
      (error: unknown) => error instanceof UncountedStopError,
    );

    assert.deepEqual(calls.unmarkBuilding.toSorted(), [ISSUE_NUMBER, 51]);
    assert.deepEqual(calls.commentOnPullRequest.map((comment) => comment.pr), [8]);
  });

  // Recorded before the rethrow, so a stop mid-round still shows up in the
  // run report rather than being lost with the process exit.
  it("records the stopped PR's outcome before rethrowing the UncountedStopError", async () => {
    const stop = new UncountedStopError("usage limit reached");
    const stoppingSandbox = sandboxFake({ roleFailing: ["follow-up"], roleFailWith: { "follow-up": stop } });
    const { passHost } = passHostFake({ threads: [botThread()], containsBase: true, sandbox: stoppingSandbox });
    const report = new OutcomeReport();

    await assert.rejects(
      () => followUpPassPhase([passTarget()], [issue], BASE, passHost, report),
      (error: unknown) => error instanceof UncountedStopError,
    );

    assert.deepEqual(report.items(), [{ kind: "pr", number: PR_NUMBER, outcome: "stopped", detail: stop.message }]);
  });
});

// The design note's other give-ups and guards (.sandcastle/work/78/design.md,
// "Also pin"), each a hand-back with no push unless it says otherwise.
describe("runPass's other give-ups", () => {
  const fixedVerdict = JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: "a".repeat(7) }]);

  it("gives up when the follow-up role finishes without signalling completion", async () => {
    const sandbox = sandboxFake({ followUpJson: fixedVerdict, roleUnfinished: ["follow-up"] });
    const { passHost, calls } = passHostFake({ threads: [botThread()], sandbox });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.deepEqual(calls.push, []);
    assert.equal(calls.handBack.length, 1);
  });

  it("gives up when the follow-up role was given threads but wrote no follow-up.json", async () => {
    const sandbox = sandboxFake();
    const { passHost, calls } = passHostFake({ threads: [botThread()], sandbox });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /follow-up\.json/);
    assert.deepEqual(calls.replyToThread, []);
  });

  it("treats a missing follow-up.json as no verdicts when the role was given no threads", async () => {
    const sandbox = sandboxFake({ mergeConflictFiles: ["src/A.cs"] });
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false, sandbox });

    const outcome = await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "passed");
    assert.equal(calls.commentOnPullRequest.length, 1);
  });

  it("gives up when follow-up.json isn't a JSON array", async () => {
    const sandbox = sandboxFake({ followUpJson: JSON.stringify({ threadId: "RT_bot" }) });
    const { passHost, calls } = passHostFake({ threads: [botThread()], sandbox });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.deepEqual(calls.push, []);
  });

  it("removes an earlier follow-up.json before the role runs", async () => {
    const sandbox = sandboxFake({ followUpJson: fixedVerdict });
    const { passHost } = passHostFake({ threads: [botThread()], sandbox });

    await runPass(passTarget(), issue, BASE, passHost);

    const removeIndex = sandbox.execCalls.findIndex((call) => call === "rm -f .sandcastle/follow-up.json");
    const readIndex = sandbox.execCalls.findIndex((call) => call.startsWith("cat") && call.includes("follow-up.json"));
    assert.ok(removeIndex !== -1 && removeIndex < readIndex, sandbox.execCalls.join("\n"));
    assert.equal(sandbox.runs.length, 1, "the role runs once, between the removal and the read");
  });

  it("gives up without pushing when the gated commit doesn't contain the PR's head", async () => {
    const sandbox = sandboxFake({ followUpJson: fixedVerdict, rewritesHistory: true });
    const { passHost, calls } = passHostFake({ threads: [botThread()], containsBase: true, sandbox });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /rewritten/);
    assert.deepEqual(calls.push, []);
  });

  it("tells the role which files conflicted when merging main conflicts", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]", mergeConflictFiles: ["src/A.cs", "src/B.cs"] });
    const { passHost } = passHostFake({ threads: [], containsBase: false, sandbox });

    await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    const merge = String(sandbox.runs[0]?.promptArgs?.MERGE ?? "");
    assert.match(merge, /src\/A\.cs, src\/B\.cs/);
    assert.match(merge, /git commit --no-edit/);
  });

  it("pushes a conflicted merge once the role has resolved it and the gate passes", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]", mergeConflictFiles: ["src/A.cs"] });
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false, sandbox });

    const outcome = await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    assert.deepEqual(outcome, { kind: "passed", pushed: ROLE_COMMIT });
    assert.deepEqual(calls.push, [{ branch: BRANCH, commit: ROLE_COMMIT }]);
    assert.match(calls.commentOnPullRequest[0]!.body, /resolved its conflicts/);
  });

  it("gives up without pushing when the role abandoned the merge with main", async () => {
    const sandbox = sandboxFake({ followUpJson: "[]", mergeConflictFiles: ["src/A.cs"], abandonsMerge: true });
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false, sandbox });

    const outcome = await runPass(passTarget({ conflicted: true, reasons: ["it has merge conflicts"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /abandoned/);
    assert.deepEqual(calls.push, []);
  });

  it("gives up when GitHub refuses the push for a workflow file", async () => {
    const rejection = new Error(
      "git push failed:\n! [remote rejected] (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
    );
    const sandbox = sandboxFake({ followUpJson: fixedVerdict });
    const { passHost, calls } = passHostFake({ threads: [botThread()], sandbox, pushError: rejection });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /workflow/);
    assert.deepEqual(calls.replyToThread, []);
  });

  it("doesn't resolve a bot thread whose reply failed to post", async () => {
    const sandbox = sandboxFake({ followUpJson: fixedVerdict });
    const { passHost, calls } = passHostFake({ threads: [botThread()], sandbox });
    passHost.replyToThread = () => {
      throw new Error("gh api graphql failed");
    };

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "passed");
    assert.deepEqual(calls.resolveThread, []);
    assert.match(calls.commentOnPullRequest[0]!.body, /reply on thread RT_bot/);
  });

  it("skips the pass, with no sandbox, when the role's only threads are owner threads already answered and nothing needs merging", async () => {
    const answered = ownerThread({
      comments: [...ownerThread().comments, { author: "owner", byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nNoted.`, url: "https://github.com/o/r/pull/7#discussion_r8" }],
    });
    const { passHost, calls } = passHostFake({ threads: [answered], containsBase: true, hostLogin: "owner" });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });
});

describe("runPass's red CI handling", () => {
  // Acceptance criterion: "A failed build that the gate reproduces is fixed
  // by the gate-fixer and pushed."
  it("fixes a build the gate reproduces, via the gate-fixer, and pushes the result", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [1, 0] });
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: true,
      sandbox,
      checks: [redCheck({ name: "Build Solution" })],
    });

    const outcome = await runPass(passTarget({ reasons: ["check Build Solution is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "passed");
    assert.ok(sandbox.runs.some((run) => run.name === "gate-fixer"), "the gate-fixer ran");
    assert.equal(calls.push.length, 1);
  });

  // Acceptance criterion: "A failed test job that the gate doesn't
  // reproduce is re-run once, not changed."
  it("re-runs a gate-covered check once when the gate is green, without changing anything", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0] });
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: true,
      sandbox,
      checks: [redCheck({ name: "Tests: Domain.Tests.Unit" })],
      rerunResult: [redCheck({ name: "Tests: Domain.Tests.Unit", green: true })],
    });

    const outcome = await runPass(passTarget({ reasons: ["check Tests: Domain.Tests.Unit is red"] }), issue, BASE, passHost);

    assert.deepEqual(outcome, { kind: "passed", pushed: undefined });
    assert.deepEqual(calls.rerunFailedChecks, [{ pr: PR_NUMBER, checkNames: ["Tests: Domain.Tests.Unit"], expectedHead: HEAD }]);
    assert.equal(sandbox.runs.length, 0, "no role ran: nothing in the branch needed changing");
    assert.deepEqual(calls.push, []);
  });

  // Acceptance criterion: "A second failure hands the PR back with
  // `sandcastle:needs-human`."
  it("gives up with sandcastle:needs-human when the re-run check fails again", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0] });
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: true,
      sandbox,
      checks: [redCheck({ name: "Tests: Domain.Tests.Unit" })],
      rerunResult: [redCheck({ name: "Tests: Domain.Tests.Unit" })],
    });

    const outcome = await runPass(passTarget({ reasons: ["check Tests: Domain.Tests.Unit is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.equal(calls.handBack.length, 1);
    const handBack = calls.handBack[0]!;
    assert.match(`${handBack.reason}\n${handBack.body}`, /Tests: Domain\.Tests\.Unit/);
    assert.deepEqual(calls.push, []);
  });

  // Acceptance criterion: "A failed CodeQL check passes its failed-job log
  // to the follow-up role."
  it("forwards a CodeQL check's failed-job log to the follow-up role", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0, 0, 0], followUpJson: "[]" });
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: true,
      sandbox,
      checks: [redCheck({ name: "Analyze (csharp)" })],
      failedCheckLog: "##[error] CS8600: converting null literal...",
    });

    const outcome = await runPass(passTarget({ reasons: ["check Analyze (csharp) is red"] }), issue, BASE, passHost);

    assert.deepEqual(calls.failedCheckLog, [{ pr: PR_NUMBER, checkNames: ["Analyze (csharp)"], expectedHead: HEAD }]);
    const roleRun = sandbox.runs.find((run) => run.name === "follow-up");
    assert.ok(roleRun !== undefined, "the follow-up role ran to fix the CodeQL failure");
    assert.match(String(roleRun?.promptArgs?.CODEQL_LOG ?? ""), /CS8600/);
    assert.equal(outcome.kind, "passed");
    assert.equal(calls.push.length, 1);
  });

  // #79's follow-up review: a CodeQL failure the role can't act on (an
  // autobuild or infrastructure error, say) leaves the role committing
  // nothing. Reporting "passed" there would only let the next sweep find the
  // same red check and run the role the same way again, every sweep until
  // FOLLOW_UP_PASS_CAP. Giving up at once instead stops that repeat as soon
  // as it's seen, rather than after two more of the same costly pass.
  it("gives up at once when the role commits nothing for a forwarded log, instead of reporting passed", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0, 0], followUpJson: "[]", roleNoCommit: ["follow-up"] });
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: true,
      sandbox,
      checks: [redCheck({ name: "Analyze (csharp)" })],
      failedCheckLog: "##[error] CS8600: converting null literal...",
    });

    const outcome = await runPass(passTarget({ reasons: ["check Analyze (csharp) is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /Analyze \(csharp\)/);
    assert.deepEqual(calls.push, []);
    const roleRun = sandbox.runs.find((run) => run.name === "follow-up");
    assert.ok(roleRun !== undefined, "the role still ran, and was given the log");
  });

  // #79's follow-up review: a red check with no Actions run behind it (code
  // scanning's own "CodeQL" result, not the "Analyze" job) has no log a pass
  // could forward and nothing a pass could re-run, so sending it to the
  // follow-up role would only start a run with nothing to fix from, every
  // sweep, until a new commit. It's left out of redChecks entirely instead.
  it("doesn't start a pass for a red check with no Actions run behind it", async () => {
    const { passHost, calls } = passHostFake({ threads: [], containsBase: true, checks: [runlessCheck()] });

    const outcome = await runPass(passTarget({ reasons: ["check CodeQL is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
    assert.deepEqual(calls.failedCheckLog, []);
  });
});

describe("runPass's red CI decisions", () => {
  // #79's follow-up review: host.checks's own read can race a push that
  // lands between the sweep and this pass, which would otherwise decide
  // redChecks from a commit other than the one it's about to gate and push.
  it("skips the pass when its checks were read from a commit other than its head", async () => {
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: true,
      checks: [redCheck({ name: "Build Solution" })],
      checksHeadRefOid: "f".repeat(40),
    });

    const outcome = await runPass(passTarget({ reasons: ["check Build Solution is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("leaves a PR alone while any of its checks is still running, red ones included", async () => {
    const { passHost, calls } = passHostFake({
      threads: [],
      checks: [redCheck({ name: "Tests: Domain.Tests.Unit" }), redCheck({ name: "Analyze (csharp)", completed: false, completedAt: null })],
    });

    const outcome = await runPass(passTarget({ reasons: ["check Tests: Domain.Tests.Unit is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.markBuilding, []);
    assert.deepEqual(calls.rerunFailedChecks, []);
  });

  // #79's follow-up review: `pull_request` CI checks out the head merged
  // with main, so a PR that's merely behind main (not conflicted) has its
  // checks run against a commit the bare head's gate never sees. Merging
  // main in first, before the gate decides, makes the gate judge the same
  // commit CI did.
  it("merges main into the branch before gating red CI, when the PR is behind main but not conflicted", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0] });
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: false,
      sandbox,
      checks: [redCheck({ name: "Build Solution" })],
    });

    const outcome = await runPass(passTarget({ conflicted: false, reasons: ["check Build Solution is red"] }), issue, BASE, passHost);

    const mergeIndex = sandbox.steps.findIndex((step) => step.startsWith("git merge "));
    const gateIndex = sandbox.steps.findIndex((step) => step === "scripts/gate.sh 2>&1");
    assert.ok(mergeIndex !== -1, "the branch was merged with main");
    assert.ok(gateIndex !== -1, "the gate ran");
    assert.ok(mergeIndex < gateIndex, "the merge happened before the gate decided red CI");
    assert.equal(outcome.kind, "passed");
    assert.equal(calls.push.length, 1);
  });

  // #259's follow-up review: GitHub's conflicted flag can be stale by the
  // time this pass fetches main, so `mergeFirst`'s merge can conflict even
  // though the PR isn't flagged as conflicted. Gating the half-merged tree
  // that leaves behind would judge conflict markers, not the branch, so the
  // pass must abort back to the bare head and gate that instead.
  it("aborts a merge that conflicts despite GitHub's conflicted flag, and gates the bare head instead", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0, 0], followUpJson: "[]", mergeConflictFiles: ["src/A.cs"] });
    const { passHost, calls } = passHostFake({
      threads: [],
      containsBase: false,
      sandbox,
      checks: [redCheck({ name: "Build Solution" })],
    });

    const outcome = await runPass(passTarget({ conflicted: false, reasons: ["check Build Solution is red"] }), issue, BASE, passHost);

    const firstMergeIndex = sandbox.steps.findIndex((step) => step.startsWith("git merge "));
    const abortIndex = sandbox.steps.findIndex((step) => step === "git merge --abort");
    const gateIndex = sandbox.steps.findIndex((step) => step === "scripts/gate.sh 2>&1");
    assert.ok(firstMergeIndex !== -1 && abortIndex !== -1 && gateIndex !== -1, sandbox.steps.join("\n"));
    assert.ok(firstMergeIndex < abortIndex, "the conflicted merge was aborted");
    assert.ok(abortIndex < gateIndex, "the gate ran on the bare head, after the abort, not on the half-merged tree");
    assert.equal(outcome.kind, "passed");
    assert.equal(calls.push.length, 1);
  });

  // The counterpart to the above: being behind main, on its own, still
  // isn't a reason to spend a counted pass. The sweep's update-branch
  // handles that once the PR is settled (lib/follow-up.mts#decide); only a
  // red check (or a bot thread) makes the merge worth doing here.
  it("doesn't start a pass merely because the PR is behind main, with no red check or bot thread", async () => {
    const { passHost, calls } = passHostFake({ threads: [], containsBase: false, checks: [] });

    const outcome = await runPass(passTarget({ conflicted: false }), issue, BASE, passHost);

    assert.equal(outcome.kind, "skipped");
    assert.deepEqual(calls.createSandbox, []);
  });

  it("doesn't re-run a flaky check when the pass pushes, since the push starts CI again", async () => {
    const sandbox = sandboxFake({
      gateExitCodes: [0, 0],
      followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "fixed", reason: "Done.", commit: ROLE_COMMIT }]),
    });
    const { passHost, calls } = passHostFake({ threads: [botThread()], sandbox, checks: [redCheck({ name: "Tests: Domain.Tests.Unit" })] });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.deepEqual(outcome, { kind: "passed", pushed: ROLE_COMMIT });
    assert.deepEqual(calls.rerunFailedChecks, []);
  });

  it("says in the pass summary which checks it re-ran", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0] });
    const { passHost, calls } = passHostFake({
      threads: [],
      sandbox,
      checks: [redCheck({ name: "Tests: Domain.Tests.Unit" })],
      rerunResult: [redCheck({ name: "Tests: Domain.Tests.Unit", completed: false, completedAt: null })],
    });

    await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(calls.commentOnPullRequest.length, 1);
    assert.match(calls.commentOnPullRequest[0]!.body, /Re-ran the failed jobs of Tests: Domain\.Tests\.Unit once/);
  });

  it("gives up on a re-run check the answer leaves out, rather than taking it as green", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0] });
    const { passHost, calls } = passHostFake({ threads: [], sandbox, checks: [redCheck({ name: "Build Solution" })], rerunResult: [] });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /Build Solution/);
  });

  it("gives the follow-up role only the end of a failed-job log too long for a prompt", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0, 0] });
    const { passHost } = passHostFake({
      threads: [],
      sandbox,
      checks: [redCheck({ name: "Analyze (csharp)" })],
      failedCheckLog: `${"x".repeat(200_000)}\n##[error] the real failure`,
    });

    await runPass(passTarget(), issue, BASE, passHost);

    const log = String(sandbox.runs.find((run) => run.name === "follow-up")?.promptArgs?.CODEQL_LOG ?? "");
    assert.ok(log.length < 100_000, `the log reached the role at ${log.length} characters`);
    assert.match(log, /the real failure$/);
  });

  // #79's follow-up review: reading the CodeQL log happens before the role
  // or anything else runs, so a stop here loses nothing of this pass's own —
  // but an uncaught throw would otherwise crash the pass instead of handing
  // the PR back with a reason.
  it("gives up when reading a forwarded check's failed-job log fails, rather than crashing", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0] });
    const { passHost, calls } = passHostFake({ threads: [], sandbox, checks: [redCheck({ name: "Analyze (csharp)" })] });
    passHost.failedCheckLog = () => {
      throw new Error("gh api rate limited");
    };

    const outcome = await runPass(passTarget({ reasons: ["check Analyze (csharp) is red"] }), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /Analyze \(csharp\)/);
    assert.equal(sandbox.runs.length, 0, "the role never ran: there was no log to give it");
  });

  // #79's follow-up review: a give-up for a re-run check still red used to
  // leave before the role's thread verdicts were replied to and resolved,
  // throwing away work the role already did. The reply and resolution must
  // land even though the pass ends in a hand-back.
  it("answers the role's bot thread before giving up when a re-run check stays red", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0, 0], followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "declined", reason: "Out of scope." }]), roleNoCommit: ["follow-up"] });
    const { passHost, calls } = passHostFake({
      threads: [botThread()],
      sandbox,
      checks: [redCheck({ name: "Tests: Domain.Tests.Unit" })],
      rerunResult: [redCheck({ name: "Tests: Domain.Tests.Unit" })],
    });

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.deepEqual(calls.push, []);
    assert.equal(calls.replyToThread.length, 1);
    assert.equal(calls.replyToThread[0]!.threadId, "RT_bot");
    assert.deepEqual(calls.resolveThread, ["RT_bot"]);
  });

  // #79's follow-up review: an error re-running the checks (the head moved,
  // or a `gh` failure) must give up with a reason rather than crash the pass
  // outright, and must still answer the role's threads first.
  it("gives up, after answering threads, when re-running a still-red check fails", async () => {
    const sandbox = sandboxFake({ gateExitCodes: [0, 0], followUpJson: JSON.stringify([{ threadId: "RT_bot", verdict: "declined", reason: "Out of scope." }]), roleNoCommit: ["follow-up"] });
    const { passHost, calls } = passHostFake({
      threads: [botThread()],
      sandbox,
      checks: [redCheck({ name: "Tests: Domain.Tests.Unit" })],
    });
    passHost.rerunFailedChecks = () => {
      throw new Error("gh run rerun failed");
    };

    const outcome = await runPass(passTarget(), issue, BASE, passHost);

    assert.equal(outcome.kind, "gave-up");
    assert.match(calls.handBack[0]!.reason, /Tests: Domain\.Tests\.Unit/);
    assert.equal(calls.replyToThread.length, 1);
    assert.deepEqual(calls.resolveThread, ["RT_bot"]);
  });
});

describe("followUpPassPhase's skips", () => {
  it("neither fetches nor passes on a PR whose issue isn't in this round's queue", async () => {
    const { passHost, calls } = passHostFake({ threads: [botThread()] });

    const outcomes = await followUpPassPhase([passTarget({ issueNumber: 99, headRefName: "feature/99-gone" })], [issue], BASE, passHost);

    assert.deepEqual(calls.fetchBranch, []);
    assert.deepEqual(calls.createSandbox, []);
    assert.equal(outcomes[0]!.kind, "skipped");
  });

  it("skips a PR whose branch fails to fetch, and still passes on the rest", async () => {
    const { passHost, calls } = passHostFake({ threads: [], containsBase: true });
    passHost.fetchBranch = (branch) => {
      calls.fetchBranch.push(branch);
      if (branch === BRANCH) throw new Error("git fetch failed");
    };
    const other: SandcastleIssue = { number: 51, title: "Tidy up the widget", body: "", labels: ["Sandcastle"], comments: [] };

    const outcomes = await followUpPassPhase(
      [passTarget(), passTarget({ number: 8, id: "PR_8", headRefName: "feature/51-tidy-widget", issueNumber: 51 })],
      [issue, other],
      BASE,
      passHost,
    );

    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["skipped", "skipped"]);
    assert.match((outcomes[0] as { reason: string }).reason, /fetch/);
    assert.match((outcomes[1] as { reason: string }).reason, /nothing a follow-up pass handles/);
  });
});
