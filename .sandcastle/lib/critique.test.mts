import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Blocker } from "./gate.mts";
import type { SandcastleIssue } from "./github.mts";
import { critiqueUnpicked } from "./overlap.mts";
import { applyVerdicts, critiqueRound, deferralComment, type CritiqueGitHub, type CritiqueVerdict } from "./critique.mts";
import { UncountedStopError } from "./errors.mts";
import type { CritiquePromptArgs } from "./prompts.mts";
import { OutcomeReport } from "./report.mts";

const issue = (number: number): SandcastleIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  labels: ["Sandcastle"],
  comments: [],
});

const openIssue = (number: number): Blocker => ({ number, state: "open", state_reason: null, merged_at: null, is_pr: false });

// A GitHub stub: every issue is open, `chains` holds each issue's existing
// blockers, and writes are recorded instead of sent.
const github = (overrides: Partial<CritiqueGitHub> & { chains?: Record<number, number[]> } = {}) => {
  const links: [number, number][] = [];
  const comments: [number, string][] = [];
  const stub: CritiqueGitHub = {
    pullRequestFiles: () => [],
    issue: openIssue,
    blockersOf: (number) => overrides.chains?.[number] ?? [],
    addBlockedBy: (id, blocker) => {
      links.push([id, blocker]);
    },
    comment: (id, body) => {
      comments.push([id, body]);
    },
    ...overrides,
  };
  return { stub, links, comments };
};

const capture = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
};

const defer = (id: number, blockedBy: number | undefined, reason = "both edit lib/plan.mts"): CritiqueVerdict =>
  ({ id: String(id), verdict: "defer", ...(blockedBy === undefined ? {} : { blockedBy: String(blockedBy) }), reason });

// The critique's reason is model text posted on a public issue by the host's
// login, so it's made safe as intake's reasons are.
describe("deferralComment", () => {
  it("breaks mentions and cross-references in the reason", () => {
    const body = deferralComment(4, "cc @someone: both change #12's files");

    assert.doesNotMatch(body, /(^|[^\w])@someone\b/);
    assert.doesNotMatch(body, /(^|[^\w&])#12\b/);
  });

  it("breaks a host marker the reason quotes, so markerComments can't count the comment as that marker's", () => {
    assert.ok(!deferralComment(4, "Both touch <!-- sandcastle:build-failed --> handling.").includes("<!--"));
  });

  it("withholds a reason that looks like it holds a secret", () => {
    const body = deferralComment(4, `Both read ghp_${"a".repeat(36)}.`);

    assert.doesNotMatch(body, /ghp_/);
    assert.match(body, /looked like it held a secret/);
  });
});

describe("applyVerdicts", () => {
  it("links a deferred issue to its blocker, comments once, and leaves it out of the round", () => {
    const gh = github();
    const { log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 2)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [2]);
    assert.deepEqual(gh.links, [[1, 2]]);
    assert.equal(gh.comments.length, 1);
    const [id, body] = gh.comments[0]!;
    assert.equal(id, 1);
    assert.match(body, /#2/);
    assert.match(body, /both edit lib\/plan\.mts/);
    assert.match(body, /delete/i);
  });

  it("logs a keep verdict and writes nothing to GitHub", () => {
    const gh = github();
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [{ id: "1", verdict: "keep", reason: "touches only docs" }], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.deepEqual(gh.comments, []);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("touches only docs")));
  });

  // AC: a deferred issue reaches the run report (lib/report.mts), so the
  // summary lists it as "deferred" rather than silently dropping it.
  it("records a linked defer as deferred, naming its blocker", () => {
    const gh = github();
    const { log } = capture();
    const report = new OutcomeReport();

    applyVerdicts([issue(1), issue(2)], [defer(1, 2, "both edit lib/plan.mts")], gh.stub, log, report);

    assert.deepEqual(report.items(), [{ kind: "issue", number: 1, outcome: "deferred", detail: "behind #2" }]);
  });

  it("records nothing for a keep verdict", () => {
    const gh = github();
    const { log } = capture();
    const report = new OutcomeReport();

    applyVerdicts([issue(1), issue(2)], [{ id: "1", verdict: "keep", reason: "touches only docs" }], gh.stub, log, report);

    assert.deepEqual(report.items(), []);
  });

  it("records nothing for an ignored defer, since it wasn't applied", () => {
    const gh = github();
    const { log } = capture();
    const report = new OutcomeReport();

    applyVerdicts([issue(1), issue(2)], [defer(1, undefined)], gh.stub, log, report);

    assert.deepEqual(report.items(), []);
  });

  it("ignores and logs a verdict for an issue that wasn't picked", () => {
    const gh = github();
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(9, 2)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.deepEqual(gh.comments, []);
    assert.ok(lines.some((line) => line.includes("#9") && line.includes("wasn't picked")));
  });

  it("ignores a defer without a blocker", () => {
    const gh = github();
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, undefined)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("names no blocker")));
  });

  it("ignores a defer whose blocker is closed", () => {
    const gh = github({ issue: (number) => ({ ...openIssue(number), state: "closed", state_reason: "completed" }) });
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 5)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.deepEqual(gh.comments, []);
    assert.ok(lines.some((line) => line.includes("#5") && line.includes("closed")));
  });

  it("ignores a defer whose blocker doesn't exist", () => {
    const gh = github({
      issue: () => {
        throw new Error("HTTP 404");
      },
    });
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 404)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.ok(lines.some((line) => line.includes("#404") && line.includes("couldn't be found")));
  });

  it("ignores a defer whose blocker is a pull request", () => {
    const gh = github({ issue: (number) => ({ ...openIssue(number), is_pr: true }) });
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 90)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.ok(lines.some((line) => line.includes("#90") && line.includes("pull request")));
  });

  it("ignores a defer that would close an existing chain into a cycle", () => {
    // Issue 3 is blocked by 4, which is blocked by 1, so 1 blocked by 3 would loop.
    const gh = github({ chains: { 3: [4], 4: [1] } });
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 3)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.deepEqual(gh.comments, []);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("cycle")));
  });

  it("counts links added earlier in the same round when looking for a cycle", () => {
    const gh = github();
    const { log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 2), defer(2, 1)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [2]);
    assert.deepEqual(gh.links, [[1, 2]]);
  });

  it("ignores a defer behind the issue itself", () => {
    const gh = github();
    const { log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 1)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
  });

  it("ignores a defer when the blocker chain can't be read, since a cycle can't be ruled out", () => {
    const gh = github({
      blockersOf: () => {
        throw new Error("network");
      },
    });
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 3)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.links, []);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("couldn't be read")));
  });

  it("keeps the issue and posts no comment when GitHub refuses the link", () => {
    const gh = github({
      addBlockedBy: () => {
        throw new Error("HTTP 422");
      },
    });
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 2)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [1, 2]);
    assert.deepEqual(gh.comments, []);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("couldn't be linked")));
  });

  it("still defers the issue when only the comment fails", () => {
    const gh = github({
      comment: () => {
        throw new Error("network");
      },
    });
    const { log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 2)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [2]);
  });

  it("applies only the first verdict for an issue", () => {
    const gh = github();
    const { lines, log } = capture();

    const kept = applyVerdicts([issue(1), issue(2), issue(3)], [defer(1, 2), defer(1, 3)], gh.stub, log);

    assert.deepEqual(kept.map((i) => i.number), [2, 3]);
    assert.deepEqual(gh.links, [[1, 2]]);
    assert.equal(gh.comments.length, 1);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("already has a verdict")));
  });

  it("can defer every pick, leaving nothing to build", () => {
    const gh = github();
    const { log } = capture();

    const kept = applyVerdicts([issue(1), issue(2)], [defer(1, 7), defer(2, 7)], gh.stub, log);

    assert.deepEqual(kept, []);
    assert.deepEqual(gh.links, [[1, 7], [2, 7]]);
  });
});

describe("critiqueRound", () => {
  const pr = (number: number, headRefName: string) => ({ number, headRefName });

  it("skips the critique when there's one pick, no in-flight PR and no unpicked ready issue", async () => {
    const gh = github();
    const { log } = capture();
    let runs = 0;

    const kept = await critiqueRound(
      { picks: [issue(1)], inFlight: [], unpicked: [] },
      async () => {
        runs++;
        return [];
      },
      gh.stub,
      log,
    );

    assert.equal(runs, 0);
    assert.deepEqual(kept.map((i) => i.number), [1]);
  });

  it("passes the picks, the in-flight issues with their PRs' changed files, and the unpicked ready issues", async () => {
    const gh = github({ pullRequestFiles: (number) => (number === 90 ? ["src/A.cs", "src/B.cs"] : []) });
    const { log } = capture();
    let args: CritiquePromptArgs | undefined;

    await critiqueRound(
      { picks: [issue(1)], inFlight: [{ issue: issue(5), pr: pr(90, "feature/5-thing") }], unpicked: [issue(3)] },
      async (promptArgs) => {
        args = promptArgs;
        return [];
      },
      gh.stub,
      log,
    );

    assert.deepEqual(JSON.parse(args!.PICKED_JSON).map((i: SandcastleIssue) => i.number), [1]);
    assert.deepEqual(JSON.parse(args!.IN_FLIGHT_JSON), [
      { number: 5, title: "Issue 5", body: "Body of 5", pr: 90, branch: "feature/5-thing", files: ["src/A.cs", "src/B.cs"] },
    ]);
    assert.deepEqual(JSON.parse(args!.UNPICKED_JSON).map((i: SandcastleIssue) => i.number), [3]);
  });

  // Issues 1 and 2 name the same file and 2 is held behind 1; 3 depends on 2. The critique has to see 2 to
  // defer 3 behind it, or 3 is built before the issue it depends on.
  it("shows the critique an overlap-held issue as unpicked, with a note that it is held", async () => {
    const gh = github();
    const { log } = capture();
    let args: CritiquePromptArgs | undefined;
    const ready = [1, 2, 3].map(issue);
    const unpicked = critiqueUnpicked(ready, [{ number: 1 }, { number: 3 }], new Set([2]));

    await critiqueRound(
      { picks: [issue(1), issue(3)], inFlight: [], unpicked },
      async (promptArgs) => {
        args = promptArgs;
        return [{ id: "1", verdict: "keep", reason: "ok" }, { id: "3", verdict: "keep", reason: "ok" }];
      },
      gh.stub,
      log,
    );

    const sent = JSON.parse(args!.UNPICKED_JSON) as { number: number; heldNote?: string }[];
    assert.deepEqual(sent.map((i) => i.number), [2]);
    assert.match(sent[0]!.heldNote ?? "", /held/i);
  });

  it("defers a pick that depends on an overlap-held issue behind it", async () => {
    const gh = github();
    const { log } = capture();
    const unpicked = critiqueUnpicked([1, 2, 3].map(issue), [{ number: 1 }, { number: 3 }], new Set([2]));

    const kept = await critiqueRound(
      { picks: [issue(1), issue(3)], inFlight: [], unpicked },
      // Defers issue 3 only when the prompt shows 2 as held, as a critique has to see it to do so.
      async (promptArgs) => {
        const sent = JSON.parse(promptArgs.UNPICKED_JSON) as { number: number; heldNote?: string }[];
        const sawHeld = sent.some((i) => i.number === 2 && typeof i.heldNote === "string");
        return [
          { id: "1", verdict: "keep", reason: "independent" },
          sawHeld ? defer(3, 2, "needs the API #2 adds") : { id: "3", verdict: "keep", reason: "independent" },
        ];
      },
      gh.stub,
      log,
      new OutcomeReport(),
    );

    assert.deepEqual(kept.map((i) => i.number), [1]);
    assert.deepEqual(gh.links, [[3, 2]]);
  });

  // critique-prompt.md says each pick carries `files`; they must reach the prompt.
  it("passes each pick's files to the critique", async () => {
    const picks: (SandcastleIssue & { files: string[] })[] = [
      { ...issue(1), files: ["lib/a.mts"] },
      { ...issue(2), files: [] },
    ];
    const { log } = capture();
    let args: CritiquePromptArgs | undefined;

    await critiqueRound(
      { picks, inFlight: [], unpicked: [] },
      async (promptArgs) => {
        args = promptArgs;
        return [
          { id: "1", verdict: "keep", reason: "fine" },
          { id: "2", verdict: "keep", reason: "fine" },
        ];
      },
      github().stub,
      log,
    );

    const passed = JSON.parse(args!.PICKED_JSON) as { number: number; files: string[] }[];
    assert.deepEqual(passed.map(({ number, files }) => [number, files]), [[1, ["lib/a.mts"]], [2, []]]);
  });

  it("applies the critique's verdicts to the picks", async () => {
    const gh = github();
    const { log } = capture();

    const kept = await critiqueRound(
      { picks: [issue(1), issue(2)], inFlight: [], unpicked: [] },
      async () => [defer(2, 1), { id: "1", verdict: "keep", reason: "no overlap" }],
      gh.stub,
      log,
    );

    assert.deepEqual(kept.map((i) => i.number), [1]);
    assert.deepEqual(gh.links, [[2, 1]]);
  });

  it("builds only the planner's first pick, with a warning, when the critique run fails", async () => {
    const gh = github();
    const { lines, log } = capture();

    const kept = await critiqueRound(
      { picks: [issue(4), issue(2), issue(3)], inFlight: [], unpicked: [] },
      async () => {
        throw new Error("StructuredOutputError: no <critique> tag");
      },
      gh.stub,
      log,
    );

    assert.deepEqual(kept.map((i) => i.number), [4]);
    assert.deepEqual(gh.links, []);
    assert.ok(lines.some((line) => line.includes("⚠") && line.includes("#4")));
  });

  it("builds only the planner's first pick when the critique leaves a pick without a verdict", async () => {
    const gh = github();
    const { lines, log } = capture();

    const kept = await critiqueRound(
      { picks: [issue(4), issue(2), issue(3)], inFlight: [], unpicked: [] },
      async () => [{ id: "4", verdict: "keep", reason: "no overlap" }],
      gh.stub,
      log,
    );

    assert.deepEqual(kept.map((i) => i.number), [4]);
    assert.deepEqual(gh.links, []);
    assert.ok(lines.some((line) => line.includes("⚠") && line.includes("#2, #3")));
  });

  it("builds only the planner's first pick when the critique returns no verdicts", async () => {
    const gh = github();
    const { log } = capture();

    const kept = await critiqueRound(
      { picks: [issue(4), issue(2)], inFlight: [], unpicked: [] },
      async () => [],
      gh.stub,
      log,
    );

    assert.deepEqual(kept.map((i) => i.number), [4]);
  });

  // A critique run stopped by the time budget or Claude's usage limit
  // must end the round uncounted, rather than falling back to the first pick
  // as a failed critique does.
  it("rethrows an UncountedStopError from the run instead of returning the first pick", async () => {
    const gh = github();
    const { log } = capture();
    const stop = new UncountedStopError("the run's 240-minute time budget has passed");

    await assert.rejects(
      () =>
        critiqueRound(
          { picks: [issue(4), issue(2), issue(3)], inFlight: [], unpicked: [] },
          () => Promise.reject(stop),
          gh.stub,
          log,
        ),
      (error: unknown) => error === stop,
    );
  });

  it("treats a failure to read an in-flight PR's files as a failed critique", async () => {
    const gh = github({
      pullRequestFiles: () => {
        throw new Error("network");
      },
    });
    const { log } = capture();
    let runs = 0;

    const kept = await critiqueRound(
      { picks: [issue(1), issue(2)], inFlight: [{ issue: issue(5), pr: pr(90, "feature/5-thing") }], unpicked: [] },
      async () => {
        runs++;
        return [];
      },
      gh.stub,
      log,
    );

    assert.equal(runs, 0);
    assert.deepEqual(kept.map((i) => i.number), [1]);
  });
});
