import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UncountedStopError } from "./errors.mts";
import { FINDINGS_LOST_STOP_REASON, findingsLostStops, publishedIssues, roundOutcomes, roundSummary } from "./round.mts";

const work = [
  { issue: { number: 71 }, branch: "feature/71-a" },
  { issue: { number: 72 }, branch: "feature/72-b" },
];

const built = (prUrl: string | undefined, publishFailed = false): PromiseSettledResult<{ prUrl: string | undefined; publishFailed: boolean }> => ({
  status: "fulfilled",
  value: { prUrl, publishFailed },
});

describe("roundSummary", () => {
  it("names a publish failure, not a round that opened nothing, when every gated branch failed to publish", () => {
    const summary = roundSummary(work, [built(undefined, true), { status: "rejected", reason: new Error("sandbox crashed") }]);

    assert.equal(summary.stop, "Publishing failed for every gated branch this round. Stopping.");
    assert.ok(summary.lines.includes("  #71 (feature/71-a): see the comment on the issue"));
  });

  it("stops on no pull requests opened when nothing was gated and published", () => {
    const summary = roundSummary(work, [built(undefined), { status: "rejected", reason: new Error("sandbox crashed") }]);

    assert.equal(summary.stop, "No pull requests opened this round. Stopping.");
    assert.ok(!summary.lines.some((line) => line.includes("stranded")));
  });

  it("lists the opened pull requests and the stranded branches, and doesn't stop, when a pull request opened", () => {
    const summary = roundSummary(work, [built("https://github.com/o/r/pull/1"), built(undefined, true)]);

    assert.equal(summary.stop, undefined);
    assert.deepEqual(summary.lines, [
      "\nExecution complete. 1 pull request(s):",
      "  #71 (feature/71-a) → https://github.com/o/r/pull/1",
      "\n1 gated branch(es) couldn't be published, so their work is stranded:",
      "  #72 (feature/72-b): see the comment on the issue",
    ]);
  });

  // A round that stopped cleanly on the time budget or Claude's usage
  // limit must say so and stop the run, even when another build in the same
  // round opened a pull request.
  it("stops on an UncountedStopError even when another build opened a pull request", () => {
    const stop = new UncountedStopError("Claude's usage limit was hit during the backend run");
    const summary = roundSummary(work, [built("https://github.com/o/r/pull/1"), { status: "rejected", reason: stop }]);

    assert.equal(summary.stop, `Stopping the run: ${stop.message}.`);
  });

  // The stop comes before publish, so this attempt's commits were never
  // pushed: an ephemeral Actions runner drops them with its checkout.
  it("adds a line naming the stopped build, saying its unpushed commits are dropped and the next run rebuilds it", () => {
    const stop = new UncountedStopError("Claude's usage limit was hit during the backend run");
    const summary = roundSummary(work, [built(undefined), { status: "rejected", reason: stop }]);

    const line = summary.lines.find((candidate) => candidate.includes("⏹"));
    assert.ok(line !== undefined && line.includes("#72") && line.includes(stop.message), summary.lines.join("\n"));
    assert.match(line, /weren't pushed/);
    assert.match(line, /next run rebuilds/);
    assert.doesNotMatch(line, /keeps its commits/);
  });

  it("keeps today's behaviour for a plain Error rejection, not treating it as a clean stop", () => {
    const summary = roundSummary(work, [built(undefined), { status: "rejected", reason: new Error("sandbox crashed") }]);

    assert.equal(summary.stop, "No pull requests opened this round. Stopping.");
    assert.ok(!summary.lines.some((line) => line.includes("⏹")));
  });
});

// AC: "every touched issue and PR" reaches the run report with its outcome.
describe("roundOutcomes", () => {
  it("takes a fulfilled build's own outcome and detail", () => {
    const outcomes = roundOutcomes(work, [
      { status: "fulfilled", value: { prUrl: "https://github.com/o/r/pull/1", publishFailed: false, outcome: "published", detail: "https://github.com/o/r/pull/1" } },
      { status: "fulfilled", value: { prUrl: undefined, publishFailed: false, outcome: "deferred", detail: "behind #65" } },
    ]);

    assert.deepEqual(outcomes, [
      { kind: "issue", number: 71, outcome: "published", detail: "https://github.com/o/r/pull/1" },
      { kind: "issue", number: 72, outcome: "deferred", detail: "behind #65" },
    ]);
  });

  it("marks a build that rejected with UncountedStopError as stopped, with its message", () => {
    const stop = new UncountedStopError("Claude's usage limit was hit during the backend run");

    const outcomes = roundOutcomes(work, [
      { status: "fulfilled", value: { prUrl: "https://github.com/o/r/pull/1", publishFailed: false, outcome: "published", detail: "https://github.com/o/r/pull/1" } },
      { status: "rejected", reason: stop },
    ]);

    assert.deepEqual(outcomes[1], { kind: "issue", number: 72, outcome: "stopped", detail: stop.message });
  });

  it("marks any other rejection as not published, since the build threw rather than return a result", () => {
    const outcomes = roundOutcomes(work, [
      { status: "rejected", reason: new Error("sandbox crashed") },
      { status: "fulfilled", value: { prUrl: undefined, publishFailed: false, outcome: "role failed", detail: "the tester failed" } },
    ]);

    assert.deepEqual(outcomes[0], { kind: "issue", number: 71, outcome: "not published", detail: "the build stopped on an error; see the run log" });
  });
});

// A hold behind a pick lasts the run only when that pick's build opened a PR.
describe("publishedIssues", () => {
  it("names the issues whose build opened a PR", () => {
    assert.deepEqual([...publishedIssues(work, [built("https://github.com/o/r/pull/1"), built("https://github.com/o/r/pull/2")])], [71, 72]);
  });

  it("leaves out a build that opened no PR, even one whose branch was gated and stranded", () => {
    assert.deepEqual([...publishedIssues(work, [built(undefined), built(undefined, true)])], []);
  });

  it("leaves out a build that threw", () => {
    const settled = [{ status: "rejected", reason: new Error("sandbox crashed") } as const, built("https://github.com/o/r/pull/2")];

    assert.deepEqual([...publishedIssues(work, settled)], [72]);
  });

  it("leaves out a build that stopped on the time budget", () => {
    const settled = [{ status: "rejected", reason: new UncountedStopError("budget") } as const, built(undefined)];

    assert.deepEqual([...publishedIssues(work, settled)], []);
  });
});

describe("findingsLostStops", () => {
  it("records one stop, naming the issue and no error text, for each build that lost its findings, and none for the others", () => {
    const value = (findingsLost?: boolean) => ({ status: "fulfilled", value: { findingsLost } }) as const;
    const stops = findingsLostStops(work, [value(true), value(false)]);

    assert.deepEqual(stops, [
      { reason: FINDINGS_LOST_STOP_REASON, unjudged: [], firstError: "filing the follow-up issue and commenting on #71 both failed; the findings are in the run log only" },
    ]);
    assert.deepEqual(findingsLostStops(work, [value(undefined), { status: "rejected", reason: new Error("boom") }]), []);
  });

  it("records a stop, with its own text, for a build whose Advisory findings none could be listed publicly", () => {
    const value = (findingsUnlisted?: boolean) => ({ status: "fulfilled", value: { findingsUnlisted } }) as const;

    assert.deepEqual(findingsLostStops(work, [value(false), value(true)]), [
      { reason: FINDINGS_LOST_STOP_REASON, unjudged: [], firstError: "no Advisory finding on #72 could be put in a public issue, so none was filed" },
    ]);
    assert.deepEqual(findingsLostStops(work, [value(undefined), value(false)]), []);
  });

  it("gives a build that lost its findings and one whose findings could not be listed each its own text, in work order", () => {
    const value = (flags: { findingsLost?: boolean; findingsUnlisted?: boolean }) => ({ status: "fulfilled", value: flags }) as const;
    const stops = findingsLostStops(work, [value({ findingsLost: true }), value({ findingsUnlisted: true })]);

    assert.deepEqual(stops.map((stop) => stop.firstError), [
      "filing the follow-up issue and commenting on #71 both failed; the findings are in the run log only",
      "no Advisory finding on #72 could be put in a public issue, so none was filed",
    ]);
  });

  it("names each lost build by its own issue, whichever position it is in, even beside a rejected build", () => {
    const value = (findingsLost?: boolean) => ({ status: "fulfilled", value: { findingsLost } }) as const;
    const named = (stops: { firstError: string }[]) => stops.map((stop) => /#(\d+)/.exec(stop.firstError)?.[1]);

    assert.deepEqual(named(findingsLostStops(work, [value(false), value(true)])), ["72"]);
    assert.deepEqual(named(findingsLostStops(work, [value(true), value(true)])), ["71", "72"]);
    assert.deepEqual(named(findingsLostStops(work, [{ status: "rejected", reason: new Error("boom") }, value(true)])), ["72"]);
  });
});
