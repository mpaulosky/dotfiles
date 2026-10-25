import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILDING_LABEL } from "./config.mts";
import { bodyBlockers, gateIssues, openPrReason, readinessReason, unfinishedReason, type Blocker, type GateGitHub } from "./gate.mts";

// An issue already judged ready by intake, since that's the common case the
// other gate checks (blockers, open PRs, sandcastle:building) are about.
const sandcastleIssue = (number: number, body = "", labels: string[] = ["Sandcastle", "sandcastle:ready"]) => ({
  number,
  title: `Issue ${number}`,
  body,
  labels,
  comments: [],
});

describe("bodyBlockers", () => {
  it("reads issue numbers from lines that start with Blocked by or Depends on", () => {
    const body = "## Summary\n\nBlocked by #65\nDepends on #12, #13\n";

    assert.deepEqual(bodyBlockers(body), [65, 12, 13]);
  });

  it("accepts list markers, bold and a colon before the numbers", () => {
    const body = "- **Blocked by:** #7\n  * depends on #8";

    assert.deepEqual(bodyBlockers(body), [7, 8]);
  });

  it("ignores issue numbers mentioned in prose", () => {
    const body = "This reuses the generator from #22, which is blocked by #30 upstream.";

    assert.deepEqual(bodyBlockers(body), []);
  });

  it("ignores references to other repositories", () => {
    const body = "Blocked by other/repo#4";

    assert.deepEqual(bodyBlockers(body), []);
  });
});

describe("unfinishedReason", () => {
  const blocker = (fields: Partial<Blocker>): Blocker => ({
    number: 5,
    state: "closed",
    state_reason: null,
    merged_at: null,
    is_pr: false,
    ...fields,
  });

  it("blocks while the blocker is open", () => {
    assert.equal(unfinishedReason(blocker({ state: "open" })), "#5 is still open");
  });

  it("clears a merged pull request", () => {
    assert.equal(unfinishedReason(blocker({ is_pr: true, merged_at: "2026-09-25T00:00:00Z" })), undefined);
  });

  it("blocks on a pull request closed without merging", () => {
    assert.equal(unfinishedReason(blocker({ is_pr: true })), "#5 was closed without merging");
  });

  it("clears an issue closed as completed", () => {
    assert.equal(unfinishedReason(blocker({ state_reason: "completed" })), undefined);
  });

  it("blocks on an issue closed as not planned", () => {
    assert.equal(
      unfinishedReason(blocker({ state_reason: "not_planned" })),
      "#5 was closed as not_planned, so its work never landed",
    );
  });
});

describe("openPrReason", () => {
  const prs = [
    { number: 90, headRefName: "feature/28-other-slug" },
    { number: 91, headRefName: "hotfix/7-fix-it" },
    { number: 92, headRefName: "chore/28-tidy" },
    { number: 93, headRefName: "feature/280-bigger" },
  ];

  it("names the open PR whose head is the issue's feature branch", () => {
    assert.equal(openPrReason(28, prs), "PR #90 (feature/28-other-slug) is already open for it");
  });

  it("names the open PR whose head is the issue's hotfix branch", () => {
    assert.equal(openPrReason(7, prs), "PR #91 (hotfix/7-fix-it) is already open for it");
  });

  it("ignores PRs from other branch kinds and issues whose numbers share a prefix", () => {
    assert.equal(openPrReason(2, prs), undefined);
    assert.equal(openPrReason(8, [{ number: 92, headRefName: "chore/8-tidy" }]), undefined);
  });
});

describe("readinessReason", () => {
  it("blocks an issue without sandcastle:ready", () => {
    assert.match(readinessReason(sandcastleIssue(1, "", ["Sandcastle"])) ?? "", /sandcastle:ready/);
  });

  it("blocks an issue labelled sandcastle:needs-info", () => {
    assert.match(
      readinessReason(sandcastleIssue(1, "", ["Sandcastle", "sandcastle:ready", "sandcastle:needs-info"])) ?? "",
      /sandcastle:needs-info/,
    );
  });

  it("blocks an issue labelled sandcastle:needs-human", () => {
    assert.match(
      readinessReason(sandcastleIssue(1, "", ["Sandcastle", "sandcastle:ready", "sandcastle:needs-human"])) ?? "",
      /sandcastle:needs-human/,
    );
  });

  it("doesn't block an issue labelled sandcastle:ready and nothing else needing a human", () => {
    assert.equal(readinessReason(sandcastleIssue(1)), undefined);
  });
});

describe("gateIssues", () => {
  const github = (overrides: Partial<GateGitHub>): GateGitHub & { lookedUp: number[] } => {
    const lookedUp: number[] = [];
    return {
      lookedUp,
      sandcastleIssues: () => [],
      openPullRequests: () => [],
      nativeBlockers: (number) => {
        lookedUp.push(number);
        return [];
      },
      blocker: (number) => ({ number, state: "closed", state_reason: "completed", merged_at: null, is_pr: false }),
      ...overrides,
    };
  };

  it("holds back an issue with an open PR, names the PR, and skips its blocker lookup", () => {
    const gh = github({
      sandcastleIssues: () => [sandcastleIssue(67), sandcastleIssue(68)],
      openPullRequests: () => [{ number: 89, headRefName: "feature/67-one-gate-script" }],
    });

    const { ready, blocked } = gateIssues(gh);

    assert.deepEqual(ready.map((i) => i.number), [68]);
    assert.deepEqual(blocked.map((b) => [b.issue.number, b.reasons]), [
      [67, ["PR #89 (feature/67-one-gate-script) is already open for it"]],
    ]);
    assert.deepEqual(gh.lookedUp, [68]);
  });

  it("returns the open PR that holds an issue back, so the critique can compare against it", () => {
    const gh = github({
      sandcastleIssues: () => [sandcastleIssue(67), sandcastleIssue(70, "Blocked by #69")],
      openPullRequests: () => [{ number: 89, headRefName: "feature/67-one-gate-script" }],
      blocker: (number) => ({ number, state: "open", state_reason: null, merged_at: null, is_pr: false }),
    });

    const { blocked } = gateIssues(gh);

    assert.deepEqual(blocked.map((b) => [b.issue.number, b.pr]), [
      [67, { number: 89, headRefName: "feature/67-one-gate-script" }],
      [70, undefined],
    ]);
  });

  it("holds back an issue carrying sandcastle:building, names it in the reason, and skips its blocker lookup", () => {
    const gh = github({
      sandcastleIssues: () => [sandcastleIssue(67, "", ["Sandcastle", BUILDING_LABEL]), sandcastleIssue(68)],
    });

    const { ready, blocked } = gateIssues(gh);

    assert.deepEqual(ready.map((i) => i.number), [68]);
    assert.deepEqual(blocked.map((b) => [b.issue.number, b.reasons]), [[67, ["it's already being built"]]]);
    assert.deepEqual(gh.lookedUp, [68]);
  });

  for (const [label, labels] of [
    ["sandcastle:ready", ["Sandcastle"]],
    ["sandcastle:needs-info", ["Sandcastle", "sandcastle:ready", "sandcastle:needs-info"]],
    ["sandcastle:needs-human", ["Sandcastle", "sandcastle:ready", "sandcastle:needs-human"]],
  ] as const) {
    const relation = label === "sandcastle:ready" ? "without" : "labelled";
    it(`holds back an issue ${relation} ${label}, names the reason, and skips its blocker lookup`, () => {
      const gh = github({
        sandcastleIssues: () => [sandcastleIssue(67, "", [...labels]), sandcastleIssue(68)],
      });

      const { ready, blocked } = gateIssues(gh);

      assert.deepEqual(ready.map((i) => i.number), [68]);
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]!.issue.number, 67);
      assert.match(blocked[0]!.reasons[0]!, new RegExp(label));
      assert.deepEqual(gh.lookedUp, [68]);
    });
  }

  it("holds back an issue whose body blocker is still open", () => {
    const gh = github({
      sandcastleIssues: () => [sandcastleIssue(70, "Blocked by #69")],
      blocker: (number) => ({ number, state: "open", state_reason: null, merged_at: null, is_pr: false }),
    });

    const { ready, blocked } = gateIssues(gh);

    assert.deepEqual(ready, []);
    assert.deepEqual(blocked[0]!.reasons, ["#69 is still open"]);
  });

  it("holds back an issue whose blocked-by links can't be read", () => {
    const gh = github({
      sandcastleIssues: () => [sandcastleIssue(71)],
      nativeBlockers: () => {
        throw new Error("network");
      },
    });

    assert.deepEqual(gateIssues(gh).blocked[0]!.reasons, ['its GitHub "blocked by" links couldn\'t be read']);
  });
});
