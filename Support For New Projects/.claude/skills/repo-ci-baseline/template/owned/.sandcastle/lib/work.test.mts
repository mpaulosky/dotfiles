import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findWork, type WorkSources } from "./work.mts";
import type { OpenPullRequest, SandcastleIssue } from "./github.mts";

const issue = (number: number, labels: string[] = []): SandcastleIssue => ({
  number,
  title: `Issue ${number}`,
  body: "",
  labels,
  comments: [],
});

// A WorkSources stub recording which sources findWork actually reads, so a
// test can check the gate's blocker lookups are skipped once earlier work is
// found.
function stubSources({
  queue = [],
  openPrs = [],
  gateReady = [],
}: {
  queue?: SandcastleIssue[];
  openPrs?: OpenPullRequest[];
  gateReady?: SandcastleIssue[];
} = {}): { sources: WorkSources; calls: string[] } {
  const calls: string[] = [];
  const sources: WorkSources = {
    queue: () => {
      calls.push("queue");
      return queue;
    },
    openPullRequests: () => {
      calls.push("openPullRequests");
      return openPrs;
    },
    gate: () => {
      calls.push("gate");
      return { ready: gateReady };
    },
  };
  return { sources, calls };
}

describe("findWork", () => {
  it("is undefined with an empty queue, no PRs needing a pass and an empty gate", () => {
    const { sources } = stubSources();

    assert.equal(findWork([], sources), undefined);
  });

  it("is undefined when every queued issue is handed back with sandcastle:needs-info", () => {
    const { sources } = stubSources({ queue: [issue(1, ["sandcastle:needs-info"])] });

    assert.equal(findWork([], sources), undefined);
  });

  it("is undefined when every queued issue is handed back with sandcastle:needs-human", () => {
    const { sources } = stubSources({ queue: [issue(1, ["sandcastle:needs-human"])] });

    assert.equal(findWork([], sources), undefined);
  });

  it("is undefined when every queued issue is being built", () => {
    const { sources } = stubSources({ queue: [issue(1, ["sandcastle:ready", "sandcastle:building"])] });

    assert.equal(findWork([], sources), undefined);
  });

  it("is undefined when every queued issue already has an open PR", () => {
    const { sources } = stubSources({
      queue: [issue(1)],
      openPrs: [{ number: 10, headRefName: "feature/1-add-search" }],
    });

    assert.equal(findWork([], sources), undefined);
  });

  it("is undefined when a sandcastle:ready issue is held back by the gate", () => {
    const { sources } = stubSources({ queue: [issue(1, ["sandcastle:ready"])], gateReady: [] });

    assert.equal(findWork([], sources), undefined);
  });

  it("finds work for an issue with no judged label, without calling the gate", () => {
    const { sources, calls } = stubSources({ queue: [issue(1)] });

    const work = findWork([], sources);

    assert.match(work ?? "", /issue\(s\) for intake/);
    assert.ok(!calls.includes("gate"), calls.join(", "));
  });

  it("finds work for a PR that needs a follow-up pass", () => {
    const { sources } = stubSources();

    const work = findWork([101], sources);

    assert.match(work ?? "", /1 open PR\(s\) need a follow-up pass/);
  });

  it("finds work for a ready, unblocked issue from the gate", () => {
    const { sources } = stubSources({ gateReady: [issue(1, ["sandcastle:ready"])] });

    const work = findWork([], sources);

    assert.match(work ?? "", /1 ready, unblocked issue\(s\)/);
  });
});
