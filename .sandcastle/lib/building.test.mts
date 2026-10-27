import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS } from "./config.mts";
import type { TimelineLabelEvent } from "./github.mts";
import {
  claimBuildingLabel,
  clearStaleBuildingLabels,
  installBuildingLabelRelease,
  labelIsStale,
  releaseAllBuildingLabels,
  releaseBuildingLabel,
  claimPullRequestBuildingLabel,
  releasePullRequestBuildingLabel,
  type BuildingGitHub,
  type BuildingLabels,
  type PullRequestBuildingLabels,
} from "./building.mts";

const labeled = (createdAt: string): TimelineLabelEvent => ({ event: "labeled", label: BUILDING_LABEL, createdAt });
const unlabeled = (createdAt: string): TimelineLabelEvent => ({ event: "unlabeled", label: BUILDING_LABEL, createdAt });

describe("labelIsStale", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");

  it("is stale once the label's most recent labeled event is more than the max age old", () => {
    const timeline = [labeled("2026-10-10T05:00:00Z")]; // 7h before `now`

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), true);
  });

  it("isn't stale while the label's most recent labeled event is within the max age", () => {
    const timeline = [labeled("2026-10-10T09:00:00Z")]; // 3h before `now`

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), false);
  });

  it("uses the label's most recent labeled event, not an earlier one", () => {
    // Labelled a day ago, then again 2h ago: a second run picked the issue up
    // after the first one cleared it.
    const timeline = [labeled("2026-10-09T00:00:00Z"), unlabeled("2026-10-09T01:00:00Z"), labeled("2026-10-10T10:00:00Z")];

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), false);
  });

  it("isn't stale when the timeline has no labeled event for this label", () => {
    const timeline: TimelineLabelEvent[] = [{ event: "labeled", label: "sandcastle:ready", createdAt: "2026-01-01T00:00:00Z" }];

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), false);
  });
});

describe("clearStaleBuildingLabels", () => {
  function github(timelines: Record<number, TimelineLabelEvent[]>): BuildingGitHub & { removed: number[] } {
    const removed: number[] = [];
    return {
      removed,
      issuesWithLabel: () => Object.keys(timelines).map(Number),
      labelTimeline: (issueNumber) => timelines[issueNumber] ?? [],
      removeLabel: (issueNumber) => void removed.push(issueNumber),
      pullRequestsWithLabel: () => [],
      removePullRequestLabel: () => {},
    };
  }

  const now = Date.parse("2026-10-10T12:00:00Z");

  it("removes the label from an issue whose most recent labeling is older than the max age", () => {
    const gh = github({ 42: [labeled("2026-10-10T05:00:00Z")] });

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(gh.removed, [42]);
  });

  // Clearing a label without knowing its age could free an issue a live run
  // is building, so an unreadable timeline stops the run at startup instead.
  it("lets a timeline that can't be read throw, removing nothing", () => {
    const gh = github({ 42: [] });
    gh.labelTimeline = () => {
      throw new Error("gh api repos/o/r/issues/42/timeline failed:\nHTTP 502: Bad Gateway");
    };

    assert.throws(() => clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), /502/);

    assert.deepEqual(gh.removed, []);
  });

  it("keeps the label on an issue a live run labelled recently", () => {
    const gh = github({ 42: [labeled("2026-10-10T11:00:00Z")] });

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(gh.removed, []);
  });

  it("checks every issue carrying the label and clears only the stale ones", () => {
    const gh = github({
      42: [labeled("2026-10-10T05:00:00Z")], // stale
      43: [labeled("2026-10-10T11:30:00Z")], // fresh
    });

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(gh.removed, [42]);
  });

  it("only reads the timeline of issues carrying the label", () => {
    const read: number[] = [];
    const gh: BuildingGitHub = {
      issuesWithLabel: () => [42],
      labelTimeline: (issueNumber) => {
        read.push(issueNumber);
        return [labeled("2026-10-10T00:00:00Z")];
      },
      removeLabel: () => {},
      pullRequestsWithLabel: () => [],
      removePullRequestLabel: () => {},
    };

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(read, [42]);
  });
});

// A hand-off pull request (lib/follow-up.mts#sweepSubject) carries the claim itself, so a crashed run can leave
// sandcastle:building on a PR as well as on an issue.
describe("clearStaleBuildingLabels and pull requests", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");

  function github(issues: Record<number, TimelineLabelEvent[]>, pullRequests: Record<number, TimelineLabelEvent[]>) {
    const removedIssues: number[] = [];
    const removedPullRequests: number[] = [];
    const listed: string[] = [];
    const gh: BuildingGitHub = {
      issuesWithLabel: () => Object.keys(issues).map(Number),
      labelTimeline: (number) => issues[number] ?? pullRequests[number] ?? [],
      removeLabel: (number) => void removedIssues.push(number),
      pullRequestsWithLabel: (label) => {
        listed.push(label);
        return Object.keys(pullRequests).map(Number);
      },
      removePullRequestLabel: (number) => void removedPullRequests.push(number),
    };
    return { gh, removedIssues, removedPullRequests, listed };
  }

  it("removes the label from an open pull request whose most recent labeling is older than the max age", () => {
    const { gh, removedIssues, removedPullRequests, listed } = github({}, { 70: [labeled("2026-10-10T05:00:00Z")] });

    const cleared = clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(removedPullRequests, [70]);
    assert.deepEqual(removedIssues, []);
    assert.deepEqual(listed, [BUILDING_LABEL]);
    assert.deepEqual(cleared, [70]);
  });

  it("removes a stale label from a pull request with the pull request's call, never the issue's", () => {
    const { gh, removedIssues } = github({}, { 70: [labeled("2026-10-10T05:00:00Z")] });

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(removedIssues, []);
  });

  it("keeps the label on a pull request a live run labelled recently", () => {
    const { gh, removedPullRequests } = github({}, { 70: [labeled("2026-10-10T11:00:00Z")] });

    const cleared = clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(removedPullRequests, []);
    assert.deepEqual(cleared, []);
  });

  it("clears the stale ones among issues and pull requests together, and only those", () => {
    const { gh, removedIssues, removedPullRequests } = github(
      { 42: [labeled("2026-10-10T05:00:00Z")], 43: [labeled("2026-10-10T11:30:00Z")] },
      { 70: [labeled("2026-10-10T04:00:00Z")], 71: [labeled("2026-10-10T11:45:00Z")] },
    );

    const cleared = clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(removedIssues, [42]);
    assert.deepEqual(removedPullRequests, [70]);
    assert.deepEqual(cleared.toSorted((a, b) => a - b), [42, 70]);
  });

  it("lets a pull request's timeline that can't be read throw, removing nothing from it", () => {
    const { gh, removedPullRequests } = github({}, { 70: [] });
    gh.labelTimeline = () => {
      throw new Error("gh api failed:\nHTTP 502: Bad Gateway");
    };

    assert.throws(() => clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), /502/);

    assert.deepEqual(removedPullRequests, []);
  });
});

// A BuildingLabels stub over an in-memory label list per issue, recording
// every call. `failRemove` makes removing the label from those issues throw;
// `failAdd` makes adding it throw after GitHub has applied it, as a timeout or
// a proxy's 502 can.
function labelStub(labels: Record<number, string[]> = {}, failRemove: number[] = [], failAdd: number[] = []) {
  const calls: string[] = [];
  const github: BuildingLabels = {
    issueLabels: (issueNumber) => {
      calls.push(`labels #${issueNumber}`);
      return [...(labels[issueNumber] ?? [])];
    },
    addLabel: (issueNumber, label) => {
      calls.push(`add #${issueNumber}`);
      (labels[issueNumber] ??= []).push(label);
      if (failAdd.includes(issueNumber)) throw new Error("gh issue edit failed:\nHTTP 502: Bad Gateway");
    },
    removeLabel: (issueNumber, label) => {
      calls.push(`remove #${issueNumber}`);
      if (failRemove.includes(issueNumber)) throw new Error("gh issue edit failed:\nHTTP 502: Bad Gateway");
      labels[issueNumber] = (labels[issueNumber] ?? []).filter((name) => name !== label);
    },
  };
  return { calls, github, labels };
}

// When this run claimed a label, and the time a test acts at: an hour later.
const claimedAt = Date.parse("2026-10-10T05:00:00Z");
const now = claimedAt + 60 * 60 * 1000;

describe("claimBuildingLabel", () => {
  it("adds the label to an issue that doesn't carry it and remembers the issue", () => {
    const { calls, github, labels } = labelStub({ 150: ["Sandcastle"] });
    const marked = new Map<number, number>();

    const claimed = claimBuildingLabel(150, github, marked, now);

    assert.equal(claimed, true);
    assert.equal(marked.get(150), now);
    assert.deepEqual(calls, ["labels #150", "add #150"]);
    assert.deepEqual(labels[150], ["Sandcastle", BUILDING_LABEL]);
    assert.deepEqual([...marked.keys()], [150]);
  });

  // Another run's gate read the labels before this one's add, so both picked
  // the issue: the one that marks it second must leave it alone.
  it("leaves an issue another run already marked, without adding the label or remembering the issue", () => {
    const { calls, github } = labelStub({ 150: ["Sandcastle", "Sandcastle:Building"] });
    const marked = new Map<number, number>();

    const claimed = claimBuildingLabel(150, github, marked);

    assert.equal(claimed, false);
    assert.deepEqual(calls, ["labels #150"]);
    assert.deepEqual([...marked.keys()], []);
  });
});

describe("claimBuildingLabel when adding the label fails", () => {
  it("removes a label the failed add may have applied, forgets the issue and rethrows", () => {
    const { calls, github, labels } = labelStub({ 150: [] }, [], [150]);
    const marked = new Map<number, number>();

    assert.throws(() => claimBuildingLabel(150, github, marked), /502/);

    assert.deepEqual(calls, ["labels #150", "add #150", "remove #150"]);
    assert.deepEqual(labels[150], []);
    assert.deepEqual([...marked.keys()], []);
  });

  // Still remembered, so releaseAllBuildingLabels tries again on exit.
  it("keeps remembering the issue when the label can't be removed either", () => {
    const { github } = labelStub({ 150: [] }, [150], [150]);
    const marked = new Map<number, number>();

    assert.throws(() => claimBuildingLabel(150, github, marked), /502/);

    assert.deepEqual([...marked.keys()], [150]);
  });
});

describe("releaseBuildingLabel", () => {
  it("removes the label and forgets the issue", () => {
    const { github, labels } = labelStub({ 150: [BUILDING_LABEL] });
    const marked = new Map([[150, claimedAt]]);

    releaseBuildingLabel(150, github, marked);

    assert.deepEqual(labels[150], []);
    assert.deepEqual([...marked.keys()], []);
  });

  // Still remembered, so releaseAllBuildingLabels tries again on exit.
  it("keeps remembering the issue when the label can't be removed", () => {
    const { github } = labelStub({ 150: [BUILDING_LABEL] }, [150]);
    const marked = new Map([[150, claimedAt]]);

    assert.throws(() => releaseBuildingLabel(150, github, marked), /502/);

    assert.deepEqual([...marked.keys()], [150]);
  });
});

describe("releaseAllBuildingLabels", () => {
  // Ctrl-C, SIGTERM and a crash skip buildIssue's finally; main.mts calls
  // this from the process's exit listener instead.
  it("removes the label from every issue this run still holds and returns them", () => {
    const { github, labels } = labelStub({ 71: [BUILDING_LABEL], 150: [BUILDING_LABEL] });
    const marked = new Map([[71, claimedAt], [150, claimedAt]]);

    const released = releaseAllBuildingLabels(github, marked, () => {}, now);

    assert.deepEqual(released, [71, 150]);
    assert.deepEqual(labels, { 71: [], 150: [] });
    assert.deepEqual([...marked.keys()], []);
  });

  // Past the max age, another run's startup may have cleared the label as
  // stale and claimed the issue: the label on it now may be that run's.
  it("forgets, without removing, a label this run claimed more than the max age ago, and reports it", () => {
    const { calls, github } = labelStub({ 150: [BUILDING_LABEL] });
    const marked = new Map([[150, now - BUILDING_LABEL_MAX_AGE_MS - 1]]);
    const warnings: string[] = [];

    const released = releaseAllBuildingLabels(github, marked, (message) => warnings.push(message), now);

    assert.deepEqual(released, []);
    assert.deepEqual(calls, []);
    assert.deepEqual([...marked.keys()], []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /#150/);
  });

  // main.mts calls it at the start of every round too, so a removal that
  // failed doesn't hold the issue back for the rest of the run.
  it("removes a label on a later call after a removal that failed", () => {
    const failRemove = [150];
    const { github, labels } = labelStub({ 150: [BUILDING_LABEL] }, failRemove);
    const marked = new Map([[150, claimedAt]]);

    const first = releaseAllBuildingLabels(github, marked, () => {}, now);
    failRemove.length = 0;
    const second = releaseAllBuildingLabels(github, marked, () => {}, now);

    assert.deepEqual(first, []);
    assert.deepEqual(second, [150]);
    assert.deepEqual(labels[150], []);
  });

  it("carries on past an issue whose label can't be removed, and reports it", () => {
    const { github, labels } = labelStub({ 71: [BUILDING_LABEL], 150: [BUILDING_LABEL] }, [71]);
    const warnings: string[] = [];

    const released = releaseAllBuildingLabels(
      github,
      new Map([[71, claimedAt], [150, claimedAt]]),
      (message) => warnings.push(message),
      now,
    );

    assert.deepEqual(released, [150]);
    assert.deepEqual(labels[150], []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /#71/);
  });
});

// A PullRequestBuildingLabels stub over an in-memory label list per pull request, recording every call, as labelStub
// does for issues.
function pullRequestLabelStub(labels: Record<number, string[]> = {}, failRemove: number[] = [], failAdd: number[] = []) {
  const calls: string[] = [];
  const github: PullRequestBuildingLabels = {
    labels: (pr) => {
      calls.push(`labels PR #${pr}`);
      return [...(labels[pr] ?? [])];
    },
    addLabel: (pr, label) => {
      calls.push(`add PR #${pr}`);
      (labels[pr] ??= []).push(label);
      if (failAdd.includes(pr)) throw new Error("gh pr edit failed:\nHTTP 502: Bad Gateway");
    },
    removeLabel: (pr, label) => {
      calls.push(`remove PR #${pr}`);
      if (failRemove.includes(pr)) throw new Error("gh pr edit failed:\nHTTP 502: Bad Gateway");
      labels[pr] = (labels[pr] ?? []).filter((name) => name !== label);
    },
  };
  return { calls, github, labels };
}

describe("claimPullRequestBuildingLabel", () => {
  it("adds the label to a pull request that doesn't carry it and remembers the pull request", () => {
    const { calls, github, labels } = pullRequestLabelStub({ 70: ["sandcastle:follow-up"] });
    const marked = new Map<number, number>();

    const claimed = claimPullRequestBuildingLabel(70, github, marked, now);

    assert.equal(claimed, true);
    assert.equal(marked.get(70), now);
    assert.deepEqual(calls, ["labels PR #70", "add PR #70"]);
    assert.deepEqual(labels[70], ["sandcastle:follow-up", BUILDING_LABEL]);
  });

  it("leaves a pull request another run already marked, in any case, without adding the label or remembering it", () => {
    const { calls, github } = pullRequestLabelStub({ 70: ["Sandcastle:Building"] });
    const marked = new Map<number, number>();

    const claimed = claimPullRequestBuildingLabel(70, github, marked);

    assert.equal(claimed, false);
    assert.deepEqual(calls, ["labels PR #70"]);
    assert.deepEqual([...marked.keys()], []);
  });

  it("removes a label the failed add may have applied, forgets the pull request and rethrows", () => {
    const { calls, github, labels } = pullRequestLabelStub({ 70: [] }, [], [70]);
    const marked = new Map<number, number>();

    assert.throws(() => claimPullRequestBuildingLabel(70, github, marked), /502/);

    assert.deepEqual(calls, ["labels PR #70", "add PR #70", "remove PR #70"]);
    assert.deepEqual(labels[70], []);
    assert.deepEqual([...marked.keys()], []);
  });

  it("keeps remembering the pull request when the failed add's label can't be removed either", () => {
    const { github } = pullRequestLabelStub({ 70: [] }, [70], [70]);
    const marked = new Map<number, number>();

    assert.throws(() => claimPullRequestBuildingLabel(70, github, marked), /502/);

    assert.deepEqual([...marked.keys()], [70]);
  });
});

describe("releasePullRequestBuildingLabel", () => {
  it("removes the label and forgets the pull request", () => {
    const { github, labels } = pullRequestLabelStub({ 70: [BUILDING_LABEL] });
    const marked = new Map([[70, claimedAt]]);

    releasePullRequestBuildingLabel(70, github, marked);

    assert.deepEqual(labels[70], []);
    assert.deepEqual([...marked.keys()], []);
  });

  it("keeps remembering the pull request when the label can't be removed", () => {
    const { github } = pullRequestLabelStub({ 70: [BUILDING_LABEL] }, [70]);
    const marked = new Map([[70, claimedAt]]);

    assert.throws(() => releasePullRequestBuildingLabel(70, github, marked), /502/);

    assert.deepEqual([...marked.keys()], [70]);
  });
});

describe("releaseAllBuildingLabels and pull requests", () => {
  const release = (
    issues: ReturnType<typeof labelStub>,
    markedIssues: Map<number, number>,
    pullRequests: ReturnType<typeof pullRequestLabelStub>,
    markedPullRequests: Map<number, number>,
    warn: (message: string) => void = () => {},
    at: number = now,
  ) => releaseAllBuildingLabels(issues.github, markedIssues, warn, at, BUILDING_LABEL_MAX_AGE_MS, pullRequests.github, markedPullRequests);

  it("removes the label from every pull request this run still holds, with the pull request's call, and returns them", () => {
    const issues = labelStub({ 150: [BUILDING_LABEL] });
    const pullRequests = pullRequestLabelStub({ 70: [BUILDING_LABEL], 71: [BUILDING_LABEL] });
    const markedPullRequests = new Map([[70, claimedAt], [71, claimedAt]]);

    const released = release(issues, new Map([[150, claimedAt]]), pullRequests, markedPullRequests);

    assert.deepEqual(released.toSorted((a, b) => a - b), [70, 71, 150]);
    assert.deepEqual(pullRequests.labels, { 70: [], 71: [] });
    assert.deepEqual(issues.labels, { 150: [] });
    assert.deepEqual([...markedPullRequests.keys()], []);
    assert.ok(!issues.calls.some((call) => call.includes("#70") || call.includes("#71")), issues.calls.join(", "));
  });

  it("forgets, without removing, a pull request's label this run claimed more than the max age ago, and reports it", () => {
    const issues = labelStub();
    const pullRequests = pullRequestLabelStub({ 70: [BUILDING_LABEL] });
    const markedPullRequests = new Map([[70, now - BUILDING_LABEL_MAX_AGE_MS - 1]]);
    const warnings: string[] = [];

    const released = release(issues, new Map(), pullRequests, markedPullRequests, (message) => warnings.push(message));

    assert.deepEqual(released, []);
    assert.deepEqual(pullRequests.calls, []);
    assert.deepEqual([...markedPullRequests.keys()], []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /#70/);
  });

  it("carries on past a pull request whose label can't be removed, reports it, and tries it again on a later call", () => {
    const failRemove = [70];
    const issues = labelStub({ 150: [BUILDING_LABEL] });
    const pullRequests = pullRequestLabelStub({ 70: [BUILDING_LABEL] }, failRemove);
    const markedPullRequests = new Map([[70, claimedAt]]);
    const warnings: string[] = [];

    const first = release(issues, new Map([[150, claimedAt]]), pullRequests, markedPullRequests, (message) => warnings.push(message));
    failRemove.length = 0;
    const second = release(issues, new Map(), pullRequests, markedPullRequests);

    assert.deepEqual(first, [150]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /#70/);
    assert.deepEqual(second, [70]);
    assert.deepEqual(pullRequests.labels[70], []);
  });

  it("still releases only issues when the run holds no pull request, with the pull request arguments left out", () => {
    const issues = labelStub({ 150: [BUILDING_LABEL] });

    const released = releaseAllBuildingLabels(issues.github, new Map([[150, claimedAt]]), () => {}, now);

    assert.deepEqual(released, [150]);
  });
});

describe("installBuildingLabelRelease", () => {
  // A process stub that records the handlers installed and the exit code.
  function processStub() {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const proc = {
      on: (event: string, handler: () => void) => void handlers.set(event, handler),
      exit: (code: number) => void exits.push(code),
    };
    return { handlers, exits, proc };
  }

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    // Node's default would end the process without an exit event, so the
    // labels would never be released.
    it(`exits with ${code} on ${signal}, so the exit listener runs`, () => {
      const { handlers, exits, proc } = processStub();

      installBuildingLabelRelease(proc, () => [], () => {});
      handlers.get(signal)!();

      assert.deepEqual(exits, [code]);
    });
  }

  it("releases every label the run holds on exit, logging each", () => {
    const { handlers, proc } = processStub();
    const logs: string[] = [];

    installBuildingLabelRelease(proc, () => [71, 150], (line) => logs.push(line));
    handlers.get("exit")!();

    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /#71/);
    assert.match(logs[1]!, /#150/);
  });
});

// main.mts runs at import, so its wiring is checked in its source: the order
// of these calls is what keeps a label from being cleared or left wrongly.
describe("main.mts's sandcastle:building wiring", () => {
  const main = readFileSync(new URL("../main.mts", import.meta.url), "utf8");
  const at = (call: string) => {
    const index = main.indexOf(call);
    assert.notEqual(index, -1, `main.mts doesn't call ${call}`);
    return index;
  };

  it("installs the release on exit and clears stale labels after ensureLabels, before the first round", () => {
    const loop = at("for (let iteration = 1;");

    assert.ok(at("ensureLabels();") < at("clearStaleBuildingLabels()"));
    assert.ok(at("installBuildingLabelRelease(") < loop);
    assert.ok(at("clearStaleBuildingLabels()") < loop);
  });

  // Between rounds none of the run's builds is going, so a label it still
  // holds is one whose removal failed; releasing it before the gate keeps the
  // issue from being held back for the rest of the run.
  it("releases the labels the run still holds at the start of each round, before the gate", () => {
    const loop = at("for (let iteration = 1;");
    const release = main.indexOf("releaseAllBuildingLabels()", loop);

    assert.ok(release > loop, "main.mts doesn't release labels inside the round loop");
    assert.ok(release < at("gateIssues()"));
  });
});
