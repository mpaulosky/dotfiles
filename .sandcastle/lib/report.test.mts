import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handBacksJson,
  intakeStopExitCode,
  IntakeStopReport,
  OutcomeReport,
  REPORT_DIR,
  renderSummary,
  targetUrl,
  UsageReport,
  WaitingPrReport,
  writeRunReport,
  type HandBackEntry,
  type HumanThreadEntry,
  type IntakeStopEntry,
  type OutcomeEntry,
  type ReportFs,
  type SummaryInput,
  type WaitingPrEntry,
} from "./report.mts";

const usage = (inputTokens: number, cacheCreationInputTokens: number, cacheReadInputTokens: number, outputTokens: number) =>
  ({ inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens });

describe("UsageReport", () => {
  it("sums every iteration's usage per role", () => {
    const report = new UsageReport();

    report.record("planner", [{ usage: usage(1, 2, 3, 4) }]);
    report.record("backend", [{ usage: usage(10, 20, 30, 40) }, { usage: usage(1, 1, 1, 1) }]);
    report.record("backend", [{ usage: usage(100, 0, 0, 0) }]);

    assert.deepEqual(report.totals(), new Map([
      ["planner", usage(1, 2, 3, 4)],
      ["backend", usage(111, 21, 31, 41)],
    ]));
  });

  it("counts a run with no captured usage as zero", () => {
    const report = new UsageReport();

    report.record("reviewer", [{}]);

    assert.deepEqual(report.totals().get("reviewer"), usage(0, 0, 0, 0));
  });

  it("lists each role's input, cache-creation, cache-read and output tokens", () => {
    const report = new UsageReport();
    report.record("planner", [{ usage: usage(1, 2, 3, 4) }]);

    const lines = report.lines();

    assert.deepEqual(lines, ["  planner: input 1, cache creation 2, cache read 3, output 4"]);
  });
});

describe("targetUrl", () => {
  it("links an issue to /issues/<n>", () => {
    assert.equal(targetUrl("o/r", { kind: "issue", number: 81 }), "https://github.com/o/r/issues/81");
  });

  it("links a pull request to /pull/<n>", () => {
    assert.equal(targetUrl("o/r", { kind: "pr", number: 17 }), "https://github.com/o/r/pull/17");
  });
});

describe("OutcomeReport", () => {
  it("returns every outcome recorded, in order", () => {
    const report = new OutcomeReport();

    report.record({ kind: "issue", number: 81, outcome: "published", detail: "https://github.com/o/r/pull/300" });
    report.record({ kind: "pr", number: 17, outcome: "updated", detail: "was only behind main" });

    assert.deepEqual(report.items(), [
      { kind: "issue", number: 81, outcome: "published", detail: "https://github.com/o/r/pull/300" },
      { kind: "pr", number: 17, outcome: "updated", detail: "was only behind main" },
    ]);
  });
});

describe("WaitingPrReport", () => {
  it("replaces its list each sweep, rather than accumulating across sweeps", () => {
    const report = new WaitingPrReport();

    report.replace([{ pr: 17, threads: 2 }]);
    report.replace([{ pr: 20, threads: 1 }]);

    assert.deepEqual(report.items(), [{ pr: 20, threads: 1 }]);
  });

  it("starts empty", () => {
    assert.deepEqual(new WaitingPrReport().items(), []);
  });
});

// AC: "When intake stops ... the stop is recorded with its reason, the
// unjudged issue numbers and the first error's message (tested)," for both
// of intakeRound's two limits.
describe("IntakeStopReport", () => {
  it("returns every stop recorded, in order", () => {
    const report = new IntakeStopReport();

    report.record({ reason: "8 intake runs in a row failed", unjudged: [1, 2], firstError: "the sandbox didn't start" });
    report.record({ reason: "GitHub refused every verdict in 2 batches in a row", unjudged: [3], firstError: "gh: HTTP 401" });

    assert.deepEqual(report.items(), [
      { reason: "8 intake runs in a row failed", unjudged: [1, 2], firstError: "the sandbox didn't start" },
      { reason: "GitHub refused every verdict in 2 batches in a row", unjudged: [3], firstError: "gh: HTTP 401" },
    ]);
  });

  it("starts empty", () => {
    assert.deepEqual(new IntakeStopReport().items(), []);
  });
});

// AC: "The host exits with code 1 after writing the run report when a stop
// was recorded, and with code 0 when there were none, whatever the
// hand-backs (tested)." intakeStopExitCode is the pure decision main.mts's
// finally applies after writeRunReport; it never sees the hand-backs report
// at all, so what main.mts hands back can't flip it.
describe("intakeStopExitCode", () => {
  it("is 0 when intake recorded no stop this run", () => {
    assert.equal(intakeStopExitCode([]), 0);
  });

  it("is 1 when intake recorded any stop this run, whatever else happened", () => {
    assert.equal(intakeStopExitCode([{ reason: "8 intake runs in a row failed", unjudged: [1], firstError: "boom" }]), 1);
  });
});

// AC: "After a run, .sandcastle/logs/summary.md lists every touched issue and
// PR with its outcome, the hand-backs with links, PRs waiting on human
// threads, and a token-usage table by role."
describe("renderSummary", () => {
  const outcomes: OutcomeEntry[] = [
    { kind: "issue", number: 81, outcome: "published", detail: "https://github.com/o/r/pull/300" },
    { kind: "issue", number: 70, outcome: "deferred", detail: "behind #65" },
    { kind: "issue", number: 55, outcome: "gate failed", detail: "checkpoint 2" },
  ];
  const handBacks: HandBackEntry[] = [
    {
      kind: "pr",
      number: 17,
      label: "sandcastle:needs-human",
      reason: "it has had 2 follow-up passes already",
      url: targetUrl("o/r", { kind: "pr", number: 17 }),
    },
  ];
  const waitingPrs: WaitingPrEntry[] = [{ pr: 17, threads: 2 }];
  const humanThreads: HumanThreadEntry[] = [
    { pr: 17, author: "alice", url: "https://github.com/o/r/pull/17#discussion_r1" },
    { pr: 17, author: null, url: "https://github.com/o/r/pull/17#discussion_r2" },
  ];
  const fullInput: SummaryInput = {
    queue: "issue #81",
    repo: "o/r",
    ending: { kind: "finished" },
    outcomes,
    handBacks,
    waitingPrs,
    humanThreads,
    usage: new Map([
      ["planner", usage(1, 2, 3, 4)],
      ["backend", usage(5, 6, 7, 8)],
    ]),
    stops: [],
  };

  it("names the queue and says the run finished", () => {
    const summary = renderSummary(fullInput);

    assert.match(summary, /Queue: issue #81\./);
    assert.match(summary, /The run finished\./);
  });

  it("says a clean stop and why, when the run stopped on the time budget or usage limit", () => {
    const summary = renderSummary({ ...fullInput, ending: { kind: "stopped", reason: "the time budget passed" } });

    assert.match(summary, /The run stopped cleanly: the time budget passed\./);
  });

  it("says the run ended on an error, when it crashed", () => {
    const summary = renderSummary({ ...fullInput, ending: { kind: "crashed" } });

    assert.match(summary, /ended on an error/);
    assert.match(summary, /run log/);
  });

  it("lists every touched issue and PR, linked, with its outcome and detail", () => {
    const summary = renderSummary(fullInput);

    assert.ok(summary.includes(`[issue #81](${targetUrl("o/r", { kind: "issue", number: 81 })})`));
    assert.ok(summary.includes("published"));
    assert.ok(summary.includes("https://github.com/o/r/pull/300"));
    assert.ok(summary.includes(`[issue #70](${targetUrl("o/r", { kind: "issue", number: 70 })})`));
    assert.ok(summary.includes("deferred"));
    assert.ok(summary.includes("behind #65"));
    assert.ok(summary.includes(`[issue #55](${targetUrl("o/r", { kind: "issue", number: 55 })})`));
    assert.ok(summary.includes("gate failed"));
    assert.ok(summary.includes("checkpoint 2"));
  });

  it("adds a handed-back row for each hand-back, naming its label and reason", () => {
    const summary = renderSummary(fullInput);

    assert.ok(summary.includes(`[PR #17](${targetUrl("o/r", { kind: "pr", number: 17 })})`));
    assert.ok(summary.includes("handed back"));
    assert.ok(summary.includes("sandcastle:needs-human"));
    assert.ok(summary.includes("it has had 2 follow-up passes already"));
  });

  it("lists the run's hand-backs with links", () => {
    const summary = renderSummary(fullInput);

    assert.match(summary, /### Hand-backs/);
    const section = summary.slice(summary.indexOf("### Hand-backs"));
    assert.ok(section.includes(`[PR #17](${targetUrl("o/r", { kind: "pr", number: 17 })})`));
    assert.ok(section.includes("sandcastle:needs-human"));
    assert.ok(section.includes("it has had 2 follow-up passes already"));
  });

  it("lists PRs waiting on a person with their thread links, naming a deleted account's author", () => {
    const summary = renderSummary(fullInput);

    assert.match(summary, /### Pull requests waiting on a person/);
    const section = summary.slice(summary.indexOf("### Pull requests waiting on a person"));
    assert.ok(section.includes(`[PR #17](${targetUrl("o/r", { kind: "pr", number: 17 })})`));
    assert.match(section, /2 unresolved/);
    assert.ok(section.includes("https://github.com/o/r/pull/17#discussion_r1"));
    assert.ok(section.includes("alice"));
    assert.ok(section.includes("https://github.com/o/r/pull/17#discussion_r2"));
    assert.ok(section.includes("a deleted account"));
  });

  it("lists a PR waiting only on the owner's reply to answered threads, without a count of people's threads", () => {
    const summary = renderSummary({ ...fullInput, waitingPrs: [{ pr: 18, threads: 0, answered: 2 }], humanThreads: [] });

    const section = summary.slice(summary.indexOf("### Pull requests waiting on a person"));
    assert.ok(section.includes(`[PR #18](${targetUrl("o/r", { kind: "pr", number: 18 })})`));
    assert.match(section, /2 answered threads left open for the owner/);
    assert.ok(!section.includes("opened by people"));
  });

  it("lists each role's token usage with a total row", () => {
    const summary = renderSummary(fullInput);

    assert.match(summary, /### Token usage by role/);
    const section = summary.slice(summary.indexOf("### Token usage by role"));
    assert.match(section, /planner[^\n]*1[^\n]*2[^\n]*3[^\n]*4/);
    assert.match(section, /backend[^\n]*5[^\n]*6[^\n]*7[^\n]*8/);
    // 1+5, 2+6, 3+7, 4+8.
    assert.match(section, /\*\*Total\*\*[^\n]*6[^\n]*8[^\n]*10[^\n]*12/);
  });

  // AC: "renderSummary lists each recorded stop under its own heading, and
  // omits the heading when there are none (tested)."
  it("lists each recorded intake stop under its own heading, with its reason, unjudged issues and first error, and omits the heading when there are none", () => {
    const stops: IntakeStopEntry[] = [
      { reason: "8 intake runs in a row failed", unjudged: [81, 82, 83], firstError: "the sandbox didn't start" },
    ];

    const withStops = renderSummary({ ...fullInput, stops });

    assert.match(withStops, /### Intake stops/);
    const section = withStops.slice(withStops.indexOf("### Intake stops"));
    assert.match(section, /8 intake runs in a row failed/);
    assert.match(section, /#81/);
    assert.match(section, /#82/);
    assert.match(section, /#83/);
    assert.match(section, /the sandbox didn't start/);

    const withoutStops = renderSummary({ ...fullInput, stops: [] });
    assert.ok(!withoutStops.includes("### Intake stops"));
  });

  it("says nothing was touched, there were no hand-backs or waiting PRs, and no role ran, when every list is empty", () => {
    const summary = renderSummary({
      queue: "issue #1",
      repo: "o/r",
      ending: { kind: "finished" },
      outcomes: [],
      handBacks: [],
      waitingPrs: [],
      humanThreads: [],
      usage: new Map(),
      stops: [],
    });

    assert.match(summary, /Nothing was touched\./);
    assert.match(summary, /No role ran\./);
    assert.equal((summary.match(/None\./g) ?? []).length, 2);
    assert.ok(!summary.includes("### Intake stops"));
  });

  it("leaves a target unlinked when the repository isn't known", () => {
    const summary = renderSummary({ ...fullInput, repo: undefined, handBacks: [], waitingPrs: [], humanThreads: [] });

    assert.ok(summary.includes("issue #81"));
    assert.ok(!summary.includes("[issue #81]("));
  });

  it("escapes a pipe, a newline and an angle bracket in a cell, and cuts a long one short", () => {
    const longDetail = `pipe|here\nnewline<tag>${"x".repeat(310)}`;
    const summary = renderSummary({
      ...fullInput,
      outcomes: [{ kind: "issue", number: 1, outcome: "published", detail: longDetail }],
      handBacks: [],
      waitingPrs: [],
      humanThreads: [],
    });

    assert.ok(summary.includes("pipe\\|here"));
    assert.ok(summary.includes("&lt;tag"));
    assert.ok(summary.includes("…"));
    assert.ok(!summary.includes("x".repeat(310)));
  });

  it("doubles a backslash before escaping a pipe, so the backslash can't turn the escape into a real delimiter", () => {
    const detail = `a${"\\"}${"|"}b`; // one backslash, then a pipe: a\|b
    const summary = renderSummary({
      ...fullInput,
      outcomes: [{ kind: "issue", number: 1, outcome: "published", detail }],
      handBacks: [],
      waitingPrs: [],
      humanThreads: [],
    });

    // The backslash doubled, then the pipe escaped: three backslashes, then the pipe.
    assert.ok(summary.includes(`a${"\\".repeat(3)}|b`));
  });

  it("flattens a lone carriage return, not only a CRLF or LF pair", () => {
    const summary = renderSummary({
      ...fullInput,
      outcomes: [{ kind: "issue", number: 1, outcome: "published", detail: "before\rafter" }],
      handBacks: [],
      waitingPrs: [],
      humanThreads: [],
    });

    assert.ok(summary.includes("before after"));
    assert.ok(!summary.includes("before\rafter"));
  });
});

// AC: "handbacks.json: an array of { kind, number, label, reason, url },
// empty when there were none."
describe("handBacksJson", () => {
  it("is an empty JSON array followed by a newline when there were no hand-backs", () => {
    assert.equal(handBacksJson([]), "[]\n");
  });

  it("is the hand-backs as a JSON array of their five fields", () => {
    const entries: HandBackEntry[] = [
      {
        kind: "issue",
        number: 69,
        label: "sandcastle:needs-human",
        reason: "two failed build attempts",
        url: targetUrl("o/r", { kind: "issue", number: 69 }),
      },
    ];

    assert.equal(handBacksJson(entries), `${JSON.stringify(entries, null, 2)}\n`);
  });
});

function recordingFs(): { calls: { op: string; path: string; text?: string }[]; fs: ReportFs } {
  const calls: { op: string; path: string; text?: string }[] = [];
  const fs: ReportFs = {
    mkdir: (path) => calls.push({ op: "mkdir", path }),
    writeFile: (path, text) => calls.push({ op: "writeFile", path, text }),
    appendFile: (path, text) => calls.push({ op: "appendFile", path, text }),
  };
  return { calls, fs };
}

const handBackEntries: HandBackEntry[] = [
  {
    kind: "issue",
    number: 69,
    label: "sandcastle:needs-human",
    reason: "two failed build attempts",
    url: targetUrl("o/r", { kind: "issue", number: 69 }),
  },
];

// AC: "After a run, .sandcastle/logs/summary.md lists..." and
// ".sandcastle/logs/handbacks.json always exists after a run."
describe("writeRunReport", () => {
  it("creates the report directory, then writes handbacks.json before summary.md", () => {
    const { calls, fs } = recordingFs();

    writeRunReport("## Sandcastle run\n", handBackEntries, {}, fs);

    assert.deepEqual(calls[0], { op: "mkdir", path: REPORT_DIR });
    assert.deepEqual(calls[1], {
      op: "writeFile",
      path: `${REPORT_DIR}/handbacks.json`,
      text: `${JSON.stringify(handBackEntries, null, 2)}\n`,
    });
    assert.deepEqual(calls[2], { op: "writeFile", path: `${REPORT_DIR}/summary.md`, text: "## Sandcastle run\n" });
  });

  it("writes an empty array to handbacks.json when there were no hand-backs", () => {
    const { calls, fs } = recordingFs();

    writeRunReport("## Sandcastle run\n", [], {}, fs);

    const written = calls.find((call) => call.path === `${REPORT_DIR}/handbacks.json`);
    assert.equal(written?.text, "[]\n");
  });

  // AC: "When GITHUB_STEP_SUMMARY is set, the same Markdown is appended to it."
  it("appends the exact summary to GITHUB_STEP_SUMMARY when it's set and non-empty", () => {
    const { calls, fs } = recordingFs();

    writeRunReport("## Sandcastle run\n", [], { GITHUB_STEP_SUMMARY: "/tmp/step-summary" }, fs);

    assert.deepEqual(
      calls.find((call) => call.op === "appendFile"),
      { op: "appendFile", path: "/tmp/step-summary", text: "## Sandcastle run\n" },
    );
  });

  it("doesn't append anything when GITHUB_STEP_SUMMARY isn't set", () => {
    const { calls, fs } = recordingFs();

    writeRunReport("## Sandcastle run\n", [], {}, fs);

    assert.equal(calls.some((call) => call.op === "appendFile"), false);
  });

  it("doesn't append anything when GITHUB_STEP_SUMMARY is set but empty", () => {
    const { calls, fs } = recordingFs();

    writeRunReport("## Sandcastle run\n", [], { GITHUB_STEP_SUMMARY: "" }, fs);

    assert.equal(calls.some((call) => call.op === "appendFile"), false);
  });

  it("still writes handbacks.json, and warns instead of throwing, when writing summary.md fails", () => {
    const calls: { op: string; path: string }[] = [];
    const warnings: string[] = [];
    const fs: ReportFs = {
      mkdir: (path) => calls.push({ op: "mkdir", path }),
      writeFile: (path, text) => {
        calls.push({ op: "writeFile", path });
        if (path.endsWith("summary.md")) throw new Error("disk full");
        void text;
      },
      appendFile: (path) => calls.push({ op: "appendFile", path }),
    };

    assert.doesNotThrow(() => writeRunReport("## Sandcastle run\n", handBackEntries, {}, fs, (line) => warnings.push(line)));

    assert.ok(calls.some((call) => call.path === `${REPORT_DIR}/handbacks.json`));
    assert.ok(warnings.length > 0);
  });

  it("warns instead of throwing when every write fails, so it never masks the run's own error from main.mts's finally", () => {
    const fs: ReportFs = {
      mkdir: () => {
        throw new Error("no such directory");
      },
      writeFile: () => {
        throw new Error("disk full");
      },
      appendFile: () => {
        throw new Error("disk full");
      },
    };
    const warnings: string[] = [];

    assert.doesNotThrow(() =>
      writeRunReport("## Sandcastle run\n", handBackEntries, { GITHUB_STEP_SUMMARY: "/tmp/x" }, fs, (line) => warnings.push(line)),
    );

    assert.ok(warnings.length > 0);
  });
});
