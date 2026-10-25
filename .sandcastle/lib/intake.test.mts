import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { BUILDING_LABEL, INTAKE_BATCH_SIZE, INTAKE_FAILED_RUNS_LIMIT, INTAKE_REFUSED_BATCHES_LIMIT, SANDCASTLE_LABELS, UMBRELLA_MARKER } from "./config.mts";
import type { OpenPullRequest, SandcastleIssue } from "./github.mts";
import { UncountedStopError } from "./errors.mts";
import {
  applyVerdicts,
  intakePhase,
  intakeRound,
  intakeRunner,
  needsInfoComment,
  needsIntake,
  readyComment,
  umbrellaComment,
  type IntakeVerdict,
  type SplitGitHub,
} from "./intake.mts";
import { bodyBlockers } from "./gate.mts";
import { HandBackReport, IntakeStopReport } from "./report.mts";

const issue = (number: number, labels: string[] = ["Sandcastle"]): SandcastleIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  labels,
  comments: [],
});

// A gh stub recording every call's args and stdin input, as handback.test.mts
// uses. It answers `issue view` (the labels applyVerdicts reads again before a
// verdict) with `labels`, and throws `fail`'s error for a call it matches.
function recordingGh(labels: string[] = ["Sandcastle"], fail?: (args: readonly string[]) => Error | undefined) {
  const calls: { args: readonly string[]; input: unknown }[] = [];
  const run = ((_cmd: string, args: readonly string[], options: { input?: unknown } = {}) => {
    calls.push({ args, input: options.input });
    const error = fail?.(args);
    if (error) throw error;
    return args[1] === "view" ? JSON.stringify(labels) : "";
  }) as unknown as typeof execFileSync;
  return { calls, run };
}

const verdict = (id: number, overrides: Partial<IntakeVerdict> = {}): IntakeVerdict => ({
  id: String(id),
  verdict: "ready",
  bug: false,
  reason: "has a Summary, a checkable acceptance criterion and no open question",
  ...overrides,
});

// A drafted child that carries a Summary and one acceptance criterion, as a
// well-formed split's children must.
const child = (title: string, acceptanceCriterion: string) => ({
  title,
  body: `## Summary\n\n${title}.\n\n## Acceptance criteria\n\n- [ ] ${acceptanceCriterion}`,
});

const wellFormedChildren = [
  child("Create the child issues", "Each child is created with Sandcastle."),
  child("Link the child issues in build order", "Child 2 is blocked by child 1, and child 3 by child 2."),
  child("Close the umbrella once its children finish", "The umbrella closes as completed once every child does."),
];

const splitVerdict = (id: number, children: { title: string; body: string }[] = wellFormedChildren, overrides: Partial<IntakeVerdict> = {}): IntakeVerdict => ({
  id: String(id),
  verdict: "split",
  bug: false,
  reason: "meets the Definition of Ready but needs three PRs",
  children,
  ...overrides,
});

// A SplitGitHub stub recording every call, and handing out sequential
// numbers (starting at 101) for each child it creates. `queueLabel` is
// "Sandcastle" by default, as it is in GitHub Actions and in issue scope.
function recordingSplitGithub(firstChildNumber: number = 101, queueLabel: string = "Sandcastle") {
  const calls: { fn: string; args: unknown[] }[] = [];
  let next = firstChildNumber;
  const github: SplitGitHub = {
    createChild: (title, body, labels) => {
      const number = next++;
      calls.push({ fn: "createChild", args: [title, body, labels] });
      return number;
    },
    addSubIssue: (parent, childNumber) => {
      calls.push({ fn: "addSubIssue", args: [parent, childNumber] });
    },
    addBlockedBy: (childNumber, blocker) => {
      calls.push({ fn: "addBlockedBy", args: [childNumber, blocker] });
    },
    removeSandcastle: (issueNumber) => {
      calls.push({ fn: "removeSandcastle", args: [issueNumber] });
    },
    comment: (issueNumber, body) => {
      calls.push({ fn: "comment", args: [issueNumber, body] });
    },
    markSplitting: (issueNumber) => {
      calls.push({ fn: "markSplitting", args: [issueNumber] });
    },
    unmarkSplitting: (issueNumber) => {
      calls.push({ fn: "unmarkSplitting", args: [issueNumber] });
    },
    blockersOf: () => [],
    queueLabel: () => queueLabel,
  };
  return { calls, github };
}

describe("needsIntake", () => {
  it("sends an issue without sandcastle:ready to intake", () => {
    const sent = needsIntake([issue(1, ["Sandcastle"])]);

    assert.deepEqual(sent.map((i) => i.number), [1]);
  });

  it("doesn't send an issue that already has sandcastle:ready", () => {
    const sent = needsIntake([issue(1, ["Sandcastle", "sandcastle:ready"])]);

    assert.deepEqual(sent, []);
  });

  it("doesn't send an issue labelled sandcastle:needs-info", () => {
    const sent = needsIntake([issue(1, ["Sandcastle", "sandcastle:needs-info"])]);

    assert.deepEqual(sent, []);
  });

  it("doesn't send an issue labelled sandcastle:needs-human", () => {
    const sent = needsIntake([issue(1, ["Sandcastle", "sandcastle:needs-human"])]);

    assert.deepEqual(sent, []);
  });

  // Already built or being built: questions on it now would be noise for
  // whoever reviews the work.
  it("doesn't send an issue another run is building", () => {
    const sent = needsIntake([issue(1, ["Sandcastle", BUILDING_LABEL])]);

    assert.deepEqual(sent, []);
  });

  it("doesn't send an issue whose PR is open, and still sends the others", () => {
    const openPrs: OpenPullRequest[] = [{ number: 50, headRefName: "feature/1-add-a-thing" }];

    const sent = needsIntake([issue(1), issue(2)], openPrs);

    assert.deepEqual(sent.map((i) => i.number), [2]);
  });

  it("sends a blocked issue too, so questions reach the human while a blocker is still in flight", () => {
    const sent = needsIntake([{ ...issue(1, ["Sandcastle"]), body: "Blocked by #2" }]);

    assert.deepEqual(sent.map((i) => i.number), [1]);
  });
});

describe("applyVerdicts", () => {
  it("adds sandcastle:ready and comments why, for a ready verdict", () => {
    const gh = recordingGh();
    const report = new HandBackReport();

    applyVerdicts(
      [issue(1)],
      [verdict(1, { reason: "has a Summary, a checkable acceptance criterion and no open question" })],
      gh.run,
      "o/r",
      report,
    );

    const edits = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "edit");
    const comments = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "comment");
    assert.deepEqual(edits.map((call) => call.args), [["issue", "edit", "1", "--repo", "o/r", "--add-label", "sandcastle:ready"]]);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.input as string, /has a Summary, a checkable acceptance criterion and no open question/);
    assert.deepEqual(report.items(), []);
  });

  it("leaves a needs-info verdict with Sandcastle and sandcastle:needs-info, a comment of numbered questions, and a hand-back entry", () => {
    const gh = recordingGh();
    const report = new HandBackReport();

    applyVerdicts(
      [issue(7)],
      [
        verdict(7, {
          verdict: "needs-info",
          questions: ["What should happen when the input is empty?", "Which page shows this?"],
          reason: "no acceptance criterion is objectively checkable",
        }),
      ],
      gh.run,
      "o/r",
      report,
    );

    const edits = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "edit");
    const comments = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "comment");
    assert.deepEqual(edits.map((call) => call.args), [["issue", "edit", "7", "--repo", "o/r", "--add-label", "sandcastle:needs-info"]]);
    assert.ok(!edits[0]!.args.includes("--remove-label"), "a needs-info verdict must leave Sandcastle on the issue");
    assert.equal(comments.length, 1);
    const body = comments[0]!.input as string;
    assert.match(body, /1\.\s*What should happen when the input is empty\?/);
    assert.match(body, /2\.\s*Which page shows this\?/);
    assert.equal(report.items().length, 1);
    assert.equal(report.items()[0]!.kind, "issue");
    assert.equal(report.items()[0]!.number, 7);
    assert.equal(report.items()[0]!.label, "sandcastle:needs-info");
  });

  it("adds the bug label when a ready verdict carries bug: true", () => {
    const gh = recordingGh();
    const report = new HandBackReport();

    applyVerdicts([issue(3)], [verdict(3, { bug: true })], gh.run, "o/r", report);

    const edits = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "edit");
    assert.ok(edits.some((call) => call.args.includes("bug")), JSON.stringify(edits));
  });

  it("adds the bug label when a needs-info verdict carries bug: true", () => {
    const gh = recordingGh();
    const report = new HandBackReport();

    applyVerdicts(
      [issue(4)],
      [verdict(4, { verdict: "needs-info", questions: ["Which page?"], bug: true, reason: "unclear" })],
      gh.run,
      "o/r",
      report,
    );

    const edits = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "edit");
    assert.ok(edits.some((call) => call.args.includes("bug")), JSON.stringify(edits));
  });

  it("ignores and logs a verdict for an id that wasn't sent to intake", () => {
    const gh = recordingGh();
    const report = new HandBackReport();
    const lines: string[] = [];

    applyVerdicts([issue(1)], [verdict(9)], gh.run, "o/r", report, (line) => lines.push(line));

    assert.equal(gh.calls.length, 0);
    assert.deepEqual(report.items(), []);
    assert.ok(lines.some((line) => line.includes("#9") && line.includes("wasn't sent")));
  });
});

// A split verdict is well-formed once it has at least one drafted child and
// every child carries acceptance criteria (see "a malformed split verdict"
// below for what happens otherwise).
describe("applyVerdicts for a well-formed split verdict", () => {
  it("creates a Sandcastle sub-issue for each child, in build order, each blocked by the one before it", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.equal(created.length, 3, JSON.stringify(split.calls));
    const held = ["Sandcastle", "sandcastle:needs-human"];
    assert.deepEqual(created.map((call) => call.args[2]), [held, held, held]);
    assert.deepEqual(created.map((call) => call.args[0]), wellFormedChildren.map((c) => c.title));

    const [child1, child2, child3] = [101, 102, 103];
    const subIssues = split.calls.filter((call) => call.fn === "addSubIssue");
    assert.deepEqual(subIssues.map((call) => call.args), [[10, child1], [10, child2], [10, child3]]);

    const blockedBy = split.calls.filter((call) => call.fn === "addBlockedBy");
    assert.deepEqual(blockedBy.map((call) => call.args), [[child2, child1], [child3, child2]]);
  });

  it("adds bug to each child when the original verdict carries bug: true", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();

    applyVerdicts([issue(10)], [splitVerdict(10, wellFormedChildren, { bug: true })], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.equal(created.length, 3);
    for (const call of created) {
      assert.deepEqual(call.args[2], ["Sandcastle", "bug", "sandcastle:needs-human"]);
    }
  });

  it("removes Sandcastle from the original and comments with the umbrella marker listing the children", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    assert.deepEqual(split.calls.filter((call) => call.fn === "removeSandcastle").map((call) => call.args), [[10]]);

    const comment = split.calls.find((call) => call.fn === "comment");
    assert.ok(comment, `no umbrella comment was posted: ${JSON.stringify(split.calls)}`);
    assert.equal(comment!.args[0], 10);
    const body = comment!.args[1] as string;
    assert.match(body, /<!-- sandcastle:umbrella -->/);
    assert.match(body, /#101/);
    assert.match(body, /#102/);
    assert.match(body, /#103/);
  });

  // A local run with SANDCASTLE_LABEL=Sandcastle:dev mustn't put its split
  // children in GitHub Actions' queue.
  it("creates each child with the split github's queue label, not the literal Sandcastle, in a non-default queue scope", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub(101, "Sandcastle:dev");

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.equal(created.length, 3, JSON.stringify(split.calls));
    for (const call of created) {
      assert.deepEqual(call.args[2], ["Sandcastle:dev", "sandcastle:needs-human"]);
    }
  });
});

// A split's children are model text, so the host gives each one the
// parent's conventional-commit prefix itself, deterministically, rather than
// relying on the model to copy it from the parent.
describe("applyVerdicts for a split verdict's child titles", () => {
  const withTitle = (number: number, title: string): SandcastleIssue => ({ ...issue(number), title });

  it("gives each child the parent title's conventional prefix when its drafted title has none", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const parent = withTitle(20, "feat(ui): Show the running Release and commit in the footer");
    const children = [
      child("Generate build-time BuildInfo and the Release label function", "BuildInfo carries the commit SHA."),
      child("Show the Release and commit in the footer", "The footer shows the Release label."),
    ];

    applyVerdicts([parent], [splitVerdict(20, children)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.deepEqual(created.map((call) => call.args[0]), [
      "feat(ui): Generate build-time BuildInfo and the Release label function",
      "feat(ui): Show the Release and commit in the footer",
    ]);
  });

  it("posts a drafted child title unchanged when it already starts with a conventional prefix", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const parent = withTitle(21, "feat(ui): Show the running Release and commit in the footer");
    const children = [child("fix(ui): Correct the footer's commit link", "The footer links to the right commit.")];

    applyVerdicts([parent], [splitVerdict(21, children)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.deepEqual(created.map((call) => call.args[0]), ["fix(ui): Correct the footer's commit link"]);
  });

  it("passes on the parent prefix's breaking-change marker as written", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const parent = withTitle(22, "feat(ui)!: Replace the footer layout");
    const children = [child("Remove the old footer component", "The old component no longer renders.")];

    applyVerdicts([parent], [splitVerdict(22, children)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.deepEqual(created.map((call) => call.args[0]), ["feat(ui)!: Remove the old footer component"]);
  });

  it("passes on a scopeless parent prefix as written", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const parent = withTitle(23, "chore: Tidy up the release tooling");
    const children = [child("Remove the unused release script", "The old script is deleted.")];

    applyVerdicts([parent], [splitVerdict(23, children)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.deepEqual(created.map((call) => call.args[0]), ["chore: Remove the unused release script"]);
  });

  it("leaves the drafted child titles unchanged when the parent title has no conventional prefix", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const parent = withTitle(24, "Show the running Release and commit in the footer");
    const children = [child("Generate build-time BuildInfo", "BuildInfo carries the commit SHA.")];

    applyVerdicts([parent], [splitVerdict(24, children)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const created = split.calls.filter((call) => call.fn === "createChild");
    assert.deepEqual(created.map((call) => call.args[0]), ["Generate build-time BuildInfo"]);
  });

  it("lists the children in the umbrella comment by the titles actually posted", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const parent = withTitle(25, "feat(ui): Show the running Release and commit in the footer");
    const children = [child("Generate build-time BuildInfo", "BuildInfo carries the commit SHA.")];

    applyVerdicts([parent], [splitVerdict(25, children)], gh.run, "o/r", new HandBackReport(), undefined, split.github);

    const comment = split.calls.find((call) => call.fn === "comment");
    assert.ok(comment, `no umbrella comment was posted: ${JSON.stringify(split.calls)}`);
    const body = comment!.args[1] as string;
    assert.match(body, /#101 feat\(ui\): Generate build-time BuildInfo\b/);
  });
});

// A split verdict with no children, or whose drafted children include one
// with no acceptance criteria, can't be applied: the host asks a human to
// split the issue instead, rather than create an umbrella with missing or
// empty children.
describe("applyVerdicts for a malformed split verdict", () => {
  it("hands the issue back with sandcastle:needs-info and a question asking a human to split it, when the split has no children", () => {
    const gh = recordingGh();
    const report = new HandBackReport();
    const split = recordingSplitGithub();

    applyVerdicts([issue(11)], [splitVerdict(11, [])], gh.run, "o/r", report, undefined, split.github);

    assert.equal(split.calls.length, 0, "no child issue should be created for a malformed split");
    const edits = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "edit");
    assert.deepEqual(edits.map((call) => call.args), [["issue", "edit", "11", "--repo", "o/r", "--add-label", "sandcastle:needs-info"]]);
    const comments = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "comment");
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.input as string, /split/i);
    assert.equal(report.items().length, 1);
    assert.equal(report.items()[0]!.kind, "issue");
    assert.equal(report.items()[0]!.number, 11);
  });

  it("hands the issue back with sandcastle:needs-info, when a drafted child has no acceptance criteria", () => {
    const gh = recordingGh();
    const report = new HandBackReport();
    const split = recordingSplitGithub();
    const children = [{ title: "Create the child issues", body: "## Summary\n\nCreates each child." }, ...wellFormedChildren.slice(1)];

    applyVerdicts([issue(12)], [splitVerdict(12, children)], gh.run, "o/r", report, undefined, split.github);

    assert.equal(split.calls.length, 0, "no child issue should be created for a malformed split");
    const edits = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "edit");
    assert.deepEqual(edits.map((call) => call.args), [["issue", "edit", "12", "--repo", "o/r", "--add-label", "sandcastle:needs-info"]]);
    assert.equal(report.items().length, 1);
  });
});

describe("applyVerdicts for a split verdict beyond the acceptance criteria", () => {
  // The umbrella comment is how lib/umbrella.mts finds the issue again, so it
  // must never go on an issue whose children aren't all linked yet.
  it("creates and links every child before the original loses Sandcastle and gets the umbrella comment", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    const lastLink = split.calls.findLastIndex((call) => call.fn === "addSubIssue" || call.fn === "addBlockedBy");
    const firstUmbrella = split.calls.findIndex((call) => call.fn === "removeSandcastle" || call.fn === "comment");
    assert.ok(lastLink < firstUmbrella, JSON.stringify(split.calls));
  });

  it("lists the children in build order in the umbrella comment", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    const body = split.calls.find((call) => call.fn === "comment")!.args[1] as string;
    assert.ok(body.indexOf("#101") < body.indexOf("#102") && body.indexOf("#102") < body.indexOf("#103"), body);
  });

  // Marked before the first child is created, so neither a concurrent run
  // nor a later round splits it again.
  it("marks the issue with sandcastle:needs-human before creating any child, and removes the mark once it's an umbrella", () => {
    const split = recordingSplitGithub();

    applyVerdicts([issue(10)], [splitVerdict(10)], recordingGh().run, "o/r", new HandBackReport(), () => {}, split.github);

    const fns = split.calls.map((call) => call.fn);
    assert.equal(fns[0], "markSplitting", fns.join(", "));
    assert.equal(fns.at(-1), "unmarkSplitting", fns.join(", "));
    assert.ok(fns.indexOf("comment") < fns.indexOf("unmarkSplitting"), fns.join(", "));
  });

  // A label edit GitHub answered with an error may still have landed, and
  // would then hold the issue back with nothing saying why.
  it("leaves the issue unjudged, with nothing created, and takes the mark back off, when marking it fails", () => {
    const gh = recordingGh();
    const report = new HandBackReport();
    const split = recordingSplitGithub();
    split.github.markSplitting = () => {
      throw new Error("HTTP 502");
    };
    const lines: string[] = [];

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", report, (line) => lines.push(line), split.github);

    assert.deepEqual(split.calls, [{ fn: "unmarkSplitting", args: [10] }]);
    assert.deepEqual(gh.calls.filter((call) => call.args[1] !== "view"), []);
    assert.equal(report.items().length, 0);
    assert.ok(lines.some((line) => line.includes("judged again")), lines.join("\n"));
  });

  it("logs that a person has to remove the mark when marking fails and taking it off fails too", () => {
    const split = recordingSplitGithub();
    split.github.markSplitting = () => {
      throw new Error("HTTP 502");
    };
    split.github.unmarkSplitting = () => {
      throw new Error("HTTP 502");
    };
    const lines: string[] = [];

    applyVerdicts([issue(10)], [splitVerdict(10)], recordingGh().run, "o/r", new HandBackReport(), (line) => lines.push(line), split.github);

    assert.ok(lines.some((line) => /sandcastle:needs-human/.test(line) && /remove it by hand/.test(line)), lines.join("\n"));
  });

  // A create that fails may still have created the issue on GitHub (a 502
  // after the write), so the split can't safely be tried again.
  it("hands the issue back with sandcastle:needs-human when creating the first child fails, naming the child it may have created", () => {
    const gh = recordingGh();
    const report = new HandBackReport();
    const split = recordingSplitGithub();
    split.github.createChild = () => {
      throw new Error("HTTP 502");
    };

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", report, () => {}, split.github);

    assert.deepEqual(report.items().map((item) => item.label), ["sandcastle:needs-human"]);
    const comment = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.match(comment, new RegExp(wellFormedChildren[0]!.title));
    assert.ok(!split.calls.some((call) => call.fn === "unmarkSplitting"), "the mark stays, keeping the issue out of intake");
  });

  // The issue is already marked, so a hand-back that fails too still keeps
  // it out of intake.
  it("logs a hand-back that fails after a partial split, and keeps the mark", () => {
    const split = recordingSplitGithub();
    const createChild = split.github.createChild;
    let created = 0;
    split.github.createChild = (title, body, labels) => {
      if (++created === 2) throw new Error("HTTP 502");
      return createChild(title, body, labels);
    };
    const failingGh = recordingGh(["Sandcastle"], (args) => (args[1] === "comment" || args[1] === "edit" ? new Error("HTTP 503") : undefined));
    const lines: string[] = [];

    assert.doesNotThrow(() =>
      applyVerdicts([issue(10)], [splitVerdict(10)], failingGh.run, "o/r", new HandBackReport(), (line) => lines.push(line), split.github),
    );

    assert.ok(!split.calls.some((call) => call.fn === "unmarkSplitting"));
    assert.ok(lines.some((line) => /handing it back failed/.test(line) && /sandcastle:needs-human/.test(line)), lines.join("\n"));
    assert.ok(!lines.some((line) => /judged again/.test(line)), lines.join("\n"));
  });

  // Recovery depends on how far the split got.
  it("tells a person to add Sandcastle back when the split had already removed it", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    split.github.comment = () => {
      throw new Error("HTTP 502");
    };

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    const comment = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.match(comment, /add `Sandcastle` back/);
    assert.match(comment, /close this issue yourself/);
    assert.doesNotMatch(comment, /may still have created/, "every child's create call succeeded");
  });

  it("doesn't tell a person to add Sandcastle back when the split never removed it", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    split.github.addBlockedBy = () => {
      throw new Error("HTTP 502");
    };

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    const comment = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.doesNotMatch(comment, /add `Sandcastle` back/);
    assert.match(comment, /close this issue yourself/);
  });

  // The original is about to lose Sandcastle, so its own blockers stop
  // holding anything back: the first child takes them over, as a "Blocked
  // by" line the gate reads, so a blocker GitHub won't link (a typo, a PR)
  // can't fail the split partway.
  it("puts the original's blockers, native and in its body, in the first child's body", () => {
    const split = recordingSplitGithub();
    split.github.blockersOf = (number) => (number === 10 ? [50] : []);
    const original = { ...issue(10), body: "## Summary\n\nA thing.\n\nBlocked by #60" };

    applyVerdicts([original], [splitVerdict(10)], recordingGh().run, "o/r", new HandBackReport(), () => {}, split.github);

    const bodies = split.calls.filter((call) => call.fn === "createChild").map((call) => call.args[1] as string);
    assert.deepEqual(bodyBlockers(bodies[0]!), [50, 60]);
    assert.deepEqual(bodyBlockers(bodies[1]!), []);
    const blockedBy = split.calls.filter((call) => call.fn === "addBlockedBy").map((call) => call.args);
    assert.deepEqual(blockedBy, [[102, 101], [103, 102]]);
  });

  it("leaves the issue unjudged, with nothing marked or created, when reading its blockers fails", () => {
    const split = recordingSplitGithub();
    split.github.blockersOf = () => {
      throw new Error("HTTP 502");
    };
    const lines: string[] = [];

    applyVerdicts([issue(10)], [splitVerdict(10)], recordingGh().run, "o/r", new HandBackReport(), (line) => lines.push(line), split.github);

    assert.deepEqual(split.calls, []);
    assert.ok(lines.some((line) => line.includes("judged again")), lines.join("\n"));
  });

  // Each child is held until the split finishes, so a partial split's
  // children aren't built before a person has read the hand-back.
  it("takes the hold off every child and the original once the umbrella comment is posted", () => {
    const split = recordingSplitGithub();

    applyVerdicts([issue(10)], [splitVerdict(10)], recordingGh().run, "o/r", new HandBackReport(), () => {}, split.github);

    const unmarked = split.calls.filter((call) => call.fn === "unmarkSplitting").map((call) => call.args[0]);
    assert.deepEqual(unmarked, [101, 102, 103, 10]);
    const fns = split.calls.map((call) => call.fn);
    assert.ok(fns.indexOf("comment") < fns.indexOf("unmarkSplitting"), fns.join(", "));
  });

  it("keeps every child it created held when the split fails partway, and says so", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const createChild = split.github.createChild;
    let created = 0;
    split.github.createChild = (title, body, labels) => {
      if (++created === 3) throw new Error("HTTP 502");
      return createChild(title, body, labels);
    };

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    assert.ok(!split.calls.some((call) => call.fn === "unmarkSplitting"));
    const comment = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.match(comment, /carry `sandcastle:needs-human`/);
    // Closing a sub-issue as completed would let the umbrella check close
    // this issue as completed too.
    assert.match(comment, /as not planned/);
  });

  // Mentions and references don't fire inside code, and a child's body is a
  // build spec: a Razor directive there must reach the agent as written.
  it("leaves code spans and fenced blocks in a child as written", () => {
    const split = recordingSplitGithub();
    const coded = {
      title: "Add `@page \"/x\"` for @someone",
      body: "## Summary\n\ncc @someone.\n\n```razor\n@inject IFoo Foo\n@code { }\n```\n\n## Acceptance criteria\n\n- [ ] The page has `@page \"/x\"` and `@media` rules.",
    };

    applyVerdicts([issue(10)], [splitVerdict(10, [coded])], recordingGh().run, "o/r", new HandBackReport(), () => {}, split.github);

    const [title, body] = split.calls.find((call) => call.fn === "createChild")!.args as [string, string];
    assert.ok(title.includes("`@page \"/x\"`"), title);
    assert.doesNotMatch(title, /@someone/);
    assert.ok(body.includes("```razor\n@inject IFoo Foo\n@code { }\n```"), body);
    assert.ok(body.includes("`@page \"/x\"` and `@media`"), body);
    assert.doesNotMatch(body, /cc @someone/);
  });

  // GitHub renders these as prose, so a mention or reference in them would
  // fire.
  for (const [what, body] of [
    ["after an escaped backtick", "## Summary\n\nPress \\`@someone\\` to see #123.\n\n## Acceptance criteria\n\n- [ ] One."],
    ["between a stray backtick and a later code span", "## Summary\n\nThe ` key toggles.\n\ncc @someone, see #123\n\n## Acceptance criteria\n\n- [ ] `foo` works."],
    ["after a backtick fence whose info string holds a backtick", "## Summary\n\n``` foo ` bar\n\ncc @someone, see #123\n\n## Acceptance criteria\n\n- [ ] One."],
  ] as const) {
    it(`breaks a mention and a reference ${what}`, () => {
      const split = recordingSplitGithub();

      applyVerdicts([issue(10)], [splitVerdict(10, [{ title: "Part 1", body }])], recordingGh().run, "o/r", new HandBackReport(), () => {}, split.github);

      const created = split.calls.find((call) => call.fn === "createChild")!.args[1] as string;
      assert.doesNotMatch(created, /@someone|#123/);
    });
  }

  // The children's bodies are model text posted from the host's account, so
  // a mention or cross-reference copied from the original would fire again.
  // They keep their Markdown, which the build needs.
  it("posts each child without a working mention or cross-reference, keeping its Markdown", () => {
    const split = recordingSplitGithub();
    const hostileChild = {
      title: "Fix #12 for @someone",
      body: "## Summary\n\ncc @someone, see #123, GH-4, https://github.com/o/r/issues/5, &#64;other and &commat;another.\n\n## Acceptance criteria\n\n- [ ] One.",
    };

    applyVerdicts([issue(10)], [splitVerdict(10, [hostileChild])], recordingGh().run, "o/r", new HandBackReport(), () => {}, split.github);

    const [title, body] = split.calls.find((call) => call.fn === "createChild")!.args as [string, string];
    for (const text of [title, body]) {
      assert.doesNotMatch(text, /@someone|#12\b|#123|GH-4|github\.com|&#64;|(?<!&amp;)&commat;/);
    }
    assert.match(body, /^## Acceptance criteria$/m);
    assert.match(body, /^- \[ \] One\.$/m);
  });

  // The malformed-split comment names the child at fault.
  it("posts a malformed split's child title as plain text", () => {
    const gh = recordingGh();
    const hostile = { title: "Use ``` here, cc @someone, see #123", body: "## Summary\n\nNo criteria." };

    applyVerdicts([issue(12)], [splitVerdict(12, [hostile])], gh.run, "o/r", new HandBackReport(), () => {}, recordingSplitGithub().github);

    const comment = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.doesNotMatch(comment, /@someone|#123|(^|[^\\])```/m);
  });

  // Judging it again would split it again, creating a second set of children.
  it("hands the issue back with sandcastle:needs-human, listing the children created, when the split fails partway", () => {
    const gh = recordingGh();
    const report = new HandBackReport();
    const split = recordingSplitGithub();
    const createChild = split.github.createChild;
    let created = 0;
    split.github.createChild = (title, body, labels) => {
      if (++created === 3) throw new Error("HTTP 502");
      return createChild(title, body, labels);
    };

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", report, () => {}, split.github);

    assert.equal(split.calls.filter((call) => call.fn === "removeSandcastle" || call.fn === "comment").length, 0);
    assert.ok(!split.calls.some((call) => call.fn === "unmarkSplitting"));
    const edits = gh.calls.filter((call) => call.args[1] === "edit");
    assert.deepEqual(edits.map((call) => call.args.slice(0, 7)), [["issue", "edit", "10", "--repo", "o/r", "--add-label", "sandcastle:needs-human"]]);
    const comment = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.match(comment, /#101/);
    assert.match(comment, /#102/);
    assert.doesNotMatch(comment, /HTTP 502/, "the error belongs in the run log, not on the public issue");
    assert.deepEqual(report.items().map((item) => item.label), ["sandcastle:needs-human"]);
  });

  it("adds bug before handing a malformed split back, when it carries bug: true", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();

    applyVerdicts([issue(11)], [splitVerdict(11, [], { bug: true })], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    const edits = gh.calls.filter((call) => call.args[1] === "edit");
    assert.deepEqual(edits.map((call) => call.args.slice(-1)), [["bug"], ["sandcastle:needs-info"]]);
  });

  it("treats a split whose child has an empty Acceptance criteria section as malformed", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const children = [{ title: "Part 1", body: "## Summary\n\nOne.\n\n## Acceptance criteria\n\n## Notes\n\nNone." }];

    applyVerdicts([issue(12)], [splitVerdict(12, children)], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    assert.equal(split.calls.length, 0);
    assert.ok(gh.calls.some((call) => call.args.includes("sandcastle:needs-info")));
  });

  it("treats a split whose child has a blank title as malformed", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();

    applyVerdicts([issue(12)], [splitVerdict(12, [{ ...wellFormedChildren[0]!, title: " " }])], gh.run, "o/r", new HandBackReport(), () => {}, split.github);

    assert.equal(split.calls.length, 0);
    assert.ok(gh.calls.some((call) => call.args.includes("sandcastle:needs-info")));
  });

  it("logs which children a split created", () => {
    const gh = recordingGh();
    const split = recordingSplitGithub();
    const lines: string[] = [];

    applyVerdicts([issue(10)], [splitVerdict(10)], gh.run, "o/r", new HandBackReport(), (line) => lines.push(line), split.github);

    assert.ok(lines.some((line) => /#10\b/.test(line) && line.includes("#101, #102, #103")), lines.join("\n"));
  });
});

describe("applyVerdicts beyond the acceptance criteria", () => {
  // One edit, so the issue never carries sandcastle:ready without bug, and
  // never ends up on a feature/ branch.
  it("adds bug and sandcastle:ready in one edit", () => {
    const gh = recordingGh();

    applyVerdicts([issue(3)], [verdict(3, { bug: true })], gh.run, "o/r", new HandBackReport());

    const edits = gh.calls.filter((call) => call.args[1] === "edit").map((call) => call.args);
    assert.deepEqual(edits, [["issue", "edit", "3", "--repo", "o/r", "--add-label", "bug", "--add-label", "sandcastle:ready"]]);
  });

  // Labels before the comment: a failed edit posts nothing, so judging the
  // issue again next round can't leave a second "ready" comment on it.
  it("posts nothing when a ready verdict's label edit fails, and judges the issue again next round", () => {
    const gh = recordingGh(["Sandcastle"], (args) => (args[1] === "edit" ? new Error("HTTP 502") : undefined));
    const lines: string[] = [];

    applyVerdicts([issue(1)], [verdict(1)], gh.run, "o/r", new HandBackReport(), (line) => lines.push(line));

    assert.ok(!gh.calls.some((call) => call.args[1] === "comment"));
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("judged again in a later round or run")), lines.join("\n"));
  });

  // Added before the hand-back, so a failed bug edit leaves the issue
  // unjudged, as the log says, rather than handed back without bug.
  it("adds bug before handing a needs-info verdict back, so a failed bug edit leaves the issue unjudged", () => {
    const gh = recordingGh(["Sandcastle"], (args) => (args[1] === "edit" && args.includes("bug") ? new Error("HTTP 502") : undefined));
    const report = new HandBackReport();
    const lines: string[] = [];

    applyVerdicts(
      [issue(4)],
      [verdict(4, { verdict: "needs-info", questions: ["Which page?"], bug: true })],
      gh.run,
      "o/r",
      report,
      (line) => lines.push(line),
    );

    assert.ok(!gh.calls.some((call) => call.args[1] === "comment"));
    assert.ok(!gh.calls.some((call) => call.args.includes("sandcastle:needs-info")));
    assert.deepEqual(report.items(), []);
    assert.ok(lines.some((line) => line.includes("#4") && line.includes("judged again in a later round or run")), lines.join("\n"));
  });

  // Handing an issue back without questions would leave its author nothing to
  // answer, so the verdict is treated as missing.
  for (const questions of [undefined, [], ["  "]]) {
    it(`leaves a needs-info verdict with questions ${JSON.stringify(questions)} unjudged, and logs it`, () => {
      const gh = recordingGh();
      const report = new HandBackReport();
      const lines: string[] = [];

      applyVerdicts(
        [issue(5)],
        [verdict(5, { verdict: "needs-info", ...(questions === undefined ? {} : { questions }) })],
        gh.run,
        "o/r",
        report,
        (line) => lines.push(line),
      );

      assert.ok(!gh.calls.some((call) => call.args[1] === "comment" || call.args[1] === "edit"));
      assert.deepEqual(report.items(), []);
      assert.ok(lines.some((line) => line.includes("#5") && line.includes("no questions")), lines.join("\n"));
    });
  }

  // An ignored verdict isn't the issue's verdict, so a valid one after it
  // still applies.
  it("applies a valid verdict that follows an ignored needs-info verdict with no questions", () => {
    const gh = recordingGh();
    const lines: string[] = [];

    applyVerdicts(
      [issue(5)],
      [verdict(5, { verdict: "needs-info", questions: [] }), verdict(5)],
      gh.run,
      "o/r",
      new HandBackReport(),
      (line) => lines.push(line),
    );

    assert.ok(gh.calls.some((call) => call.args[1] === "edit" && call.args.includes("sandcastle:ready")));
    assert.ok(!lines.some((line) => line.includes("already has a verdict")), lines.join("\n"));
  });

  // Another Sandcastle run judged the issue after this round read the queue;
  // applying this verdict too would leave two comments, possibly conflicting.
  it("skips a verdict on an issue another run has judged since this round read it", () => {
    const gh = recordingGh(["Sandcastle", "Sandcastle:Ready"]);
    const lines: string[] = [];

    applyVerdicts([issue(6)], [verdict(6)], gh.run, "o/r", new HandBackReport(), (line) => lines.push(line));

    assert.deepEqual(gh.calls.map((call) => call.args[1]), ["view"]);
    assert.ok(lines.some((line) => line.includes("#6") && line.includes("another run")), lines.join("\n"));
  });

  it("applies only the first verdict on an issue and logs the rest", () => {
    const gh = recordingGh();
    const lines: string[] = [];

    applyVerdicts(
      [issue(1)],
      [verdict(1), verdict(1, { verdict: "needs-info", questions: ["Why?"] })],
      gh.run,
      "o/r",
      new HandBackReport(),
      (line) => lines.push(line),
    );

    const edits = gh.calls.filter((call) => call.args[1] === "edit");
    assert.deepEqual(edits.map((call) => call.args.at(-1)), ["sandcastle:ready"]);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("already has a verdict")), lines.join("\n"));
  });

  it("logs an issue intake gave no verdict on, and labels nothing", () => {
    const gh = recordingGh();
    const lines: string[] = [];

    applyVerdicts([issue(1), issue(2)], [verdict(1)], gh.run, "o/r", new HandBackReport(), (line) => lines.push(line));

    assert.ok(!gh.calls.some((call) => call.args[2] === "2"));
    assert.ok(lines.some((line) => line.includes("#2") && line.includes("no verdict")), lines.join("\n"));
  });

  // The ready comment only explains labels already applied, so a rejected one
  // costs the explanation, not the verdict.
  it("keeps a ready issue's labels and logs it when its comment is rejected, and still applies the next verdict", () => {
    const gh = recordingGh(["Sandcastle"], (args) => (args[1] === "comment" && args[2] === "1" ? new Error("HTTP 422") : undefined));
    const lines: string[] = [];

    applyVerdicts([issue(1), issue(2)], [verdict(1), verdict(2)], gh.run, "o/r", new HandBackReport(), (line) => lines.push(line));

    const edits = gh.calls.filter((call) => call.args[1] === "edit");
    assert.deepEqual(edits.map((call) => call.args[2]), ["1", "2"]);
    assert.ok(lines.some((line) => line.includes("#1") && line.includes("HTTP 422")), lines.join("\n"));
  });

  // Removing a label takes triage access, which an issue's author may not
  // have, and their replies don't reach intake.
  it("tells an author without triage access to ask a maintainer to re-queue the issue", () => {
    const gh = recordingGh();

    applyVerdicts(
      [issue(7)],
      [verdict(7, { verdict: "needs-info", questions: ["Which page?"], reason: "the page isn't named" })],
      gh.run,
      "o/r",
      new HandBackReport(),
    );

    const body = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.match(body, /ask a maintainer/);
  });

  // The comment is the only guidance the author gets, so the questions are
  // cleaned up before they're numbered.
  describe("the needs-info comment's questions", () => {
    const posted = (questions: string[]) => {
      const gh = recordingGh();
      applyVerdicts(
        [issue(8)],
        [verdict(8, { verdict: "needs-info", questions, reason: "unclear" })],
        gh.run,
        "o/r",
        new HandBackReport(),
      );
      const body = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
      return body.split("\n").filter((line) => /^\d+\. /.test(line));
    };

    it("drops a blank question", () => {
      assert.deepEqual(posted(["Which page?", "  "]), ["1. Which page?"]);
    });

    it("keeps a question with a blank line in it to one numbered line", () => {
      assert.deepEqual(posted(["Which page?\n\nThe menu or the footer?", "Which Theme?"]), [
        "1. Which page? The menu or the footer?",
        "2. Which Theme?",
      ]);
    });

    it("leaves a question that starts with a number alone", () => {
      assert.deepEqual(posted(["2.0 or 3.0: which API version?", "3.5 seconds or 5?"]), [
        "1. 2.0 or 3.0: which API version?",
        "2. 3.5 seconds or 5?",
      ]);
    });

    it("doesn't number a question twice when intake numbered it", () => {
      assert.deepEqual(posted(["1. Which page?", "2) Which Theme?"]), ["1. Which page?", "2. Which Theme?"]);
    });
  });

  it("explains in the needs-info comment why, and how to re-queue the issue", () => {
    const gh = recordingGh();

    applyVerdicts(
      [issue(7)],
      [verdict(7, { verdict: "needs-info", questions: ["Which page?"], reason: "the page isn't named" })],
      gh.run,
      "o/r",
      new HandBackReport(),
    );

    const body = gh.calls.find((call) => call.args[1] === "comment")!.input as string;
    assert.match(body, /the page isn't named/);
    assert.match(body, /remove `sandcastle:needs-info`/);
  });
});

// gh issue edit --add-label fails for a label the repository doesn't have,
// which would leave every verdict unapplied and Sandcastle building nothing.
describe("the labels intake adds", () => {
  it("are all created at startup by ensureLabels", () => {
    const ensured = SANDCASTLE_LABELS.map((label) => label.name);

    for (const label of ["sandcastle:ready", "sandcastle:needs-info", "bug"]) {
      assert.ok(ensured.includes(label), `${label} isn't in SANDCASTLE_LABELS`);
    }
  });
});

describe("intakeRound", () => {
  // One bad or truncated answer then costs at most its batch, while the rest
  // of the backlog is still judged.
  it("judges every batch in the same round, INTAKE_BATCH_SIZE issues at a time", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE + 2 }, (_, i) => issue(i + 1));
    const sent: number[][] = [];

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        sent.push(JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number));
        return [];
      },
      recordingGh().run,
      "o/r",
      new HandBackReport(),
      () => {},
      () => {},
    );

    assert.deepEqual(sent, [issues.slice(0, INTAKE_BATCH_SIZE).map((i) => i.number), [INTAKE_BATCH_SIZE + 1, INTAKE_BATCH_SIZE + 2]]);
  });

  // Otherwise a batch that fails every time would starve the issues behind
  // it.
  it("logs the issue that breaks its batch, and still judges the next batch", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE + 1 }, (_, i) => issue(i + 1));
    const last = INTAKE_BATCH_SIZE + 1;
    const gh = recordingGh();
    const warnings: string[] = [];

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        if (sent.includes(1)) throw new Error("no <intake> block");
        return sent.map((number) => verdict(number, { reason: "clear and checkable" }));
      },
      gh.run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0]!, /Intake failed on #1,/);
    assert.match(warnings[0]!, /no <intake> block/);
    assert.match(warnings[0]!, /a later round or run/);
    assert.ok(gh.calls.some((call) => call.args.includes("edit") && call.args.includes(String(last))), JSON.stringify(gh.calls));
  });

  // Two bad issues in different halves make both halves fail; that's not a
  // failure every run would hit, so each half is narrowed down in turn.
  it("narrows down two issues that break their batch from different halves, and judges the rest", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE }, (_, i) => issue(i + 1));
    const bad = [3, 7];
    const gh = recordingGh();
    const warnings: string[] = [];

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        if (sent.some((number) => bad.includes(number))) throw new Error("truncated <intake> block");
        return sent.map((number) => verdict(number, { reason: "clear and checkable" }));
      },
      gh.run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    const edited = issues
      .map((i) => i.number)
      .filter((number) => gh.calls.some((call) => call.args.includes("edit") && call.args.includes(String(number))));
    assert.deepEqual(edited, issues.map((i) => i.number).filter((number) => !bad.includes(number)));
    assert.equal(warnings.filter((warning) => /Intake failed on #3,|Intake failed on #7,/.test(warning)).length, 2, warnings.join("\n"));
  });

  // A failure every run hits would otherwise spend a run on every split of
  // every batch.
  it("stops for the round after INTAKE_FAILED_RUNS_LIMIT failed runs in a row, and logs it", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE * 3 }, (_, i) => issue(i + 1));
    const warnings: string[] = [];
    let runs = 0;

    await intakeRound(
      issues,
      [],
      async () => {
        runs += 1;
        throw new Error("the sandbox didn't start");
      },
      recordingGh().run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    assert.equal(runs, INTAKE_FAILED_RUNS_LIMIT);
    assert.ok(
      warnings.some((warning) => warning.includes(`${INTAKE_FAILED_RUNS_LIMIT} intake runs in a row failed`) && /later round or run/.test(warning)),
      warnings.join("\n"),
    );
  });

  // AC: "When intake stops after INTAKE_FAILED_RUNS_LIMIT failed runs in a
  // row, the stop is recorded with its reason, the unjudged issue numbers
  // and the first error's message (tested)." (a repeated failure, such
  // as the missing Docker image in the first automatic runs, must no longer
  // end the job green.)
  it("records a stop with its reason, the unjudged issues and the first error's message after INTAKE_FAILED_RUNS_LIMIT failed runs in a row", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE * 3 }, (_, i) => issue(i + 1));
    const stops = new IntakeStopReport();

    await intakeRound(
      issues,
      [],
      async () => {
        throw new Error("the sandbox didn't start");
      },
      recordingGh().run,
      "o/r",
      new HandBackReport(),
      () => {},
      () => {},
      stops,
    );

    assert.equal(stops.items().length, 1, JSON.stringify(stops.items()));
    const [stop] = stops.items();
    assert.equal(stop!.reason, `${INTAKE_FAILED_RUNS_LIMIT} intake runs in a row failed`);
    assert.equal(stop!.firstError, "the sandbox didn't start");
    assert.deepEqual([...stop!.unjudged].sort((a, b) => a - b), issues.map((i) => i.number));
  });

  // applyVerdicts handles a failure on one issue itself; when it fails on
  // every verdict in two batches in a row, GitHub is refusing the host, so
  // each later batch would cost a run for nothing.
  it("stops for the round when GitHub refuses every verdict in two batches in a row, and logs it", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE * 3 }, (_, i) => issue(i + 1));
    const warnings: string[] = [];
    let runs = 0;

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        runs += 1;
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        return sent.map((number) => verdict(number, { reason: "clear and checkable" }));
      },
      recordingGh(["Sandcastle"], () => new Error("gh: HTTP 401")).run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    assert.equal(runs, 2);
    assert.ok(warnings.some((warning) => /GitHub refused every verdict/.test(warning) && /later round or run/.test(warning)), warnings.join("\n"));
  });

  // AC: "When intake stops after INTAKE_REFUSED_BATCHES_LIMIT refused
  // batches in a row, the stop is recorded the same way (tested)."
  it("records a stop with its reason, the unjudged issues and the first error's message after GitHub refuses every verdict in INTAKE_REFUSED_BATCHES_LIMIT batches in a row", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE * 3 }, (_, i) => issue(i + 1));
    const stops = new IntakeStopReport();

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        return sent.map((number) => verdict(number, { reason: "clear and checkable" }));
      },
      recordingGh(["Sandcastle"], () => new Error("gh: HTTP 401")).run,
      "o/r",
      new HandBackReport(),
      () => {},
      () => {},
      stops,
    );

    assert.equal(stops.items().length, 1, JSON.stringify(stops.items()));
    const [stop] = stops.items();
    assert.equal(stop!.reason, `GitHub refused every verdict in ${INTAKE_REFUSED_BATCHES_LIMIT} batches in a row`);
    assert.equal(stop!.firstError, "gh: HTTP 401");
    assert.deepEqual([...stop!.unjudged].sort((a, b) => a - b), issues.map((i) => i.number));
  });

  // One refused edit can be the issue's own (closed or transferred since the
  // queue was read), so a batch of one whose verdict GitHub refuses isn't
  // reason enough to stop.
  it("still judges the next batch when GitHub refuses the only verdict in one batch", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE + 1 }, (_, i) => issue(i + 1));
    const last = INTAKE_BATCH_SIZE + 1;
    const gh = recordingGh(["Sandcastle"], (args) => (args.includes("1") ? new Error("gh: issue #1 was transferred") : undefined));
    const warnings: string[] = [];

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        return [verdict(sent[0]!, { reason: "clear and checkable" })];
      },
      gh.run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    assert.ok(gh.calls.some((call) => call.args.includes("edit") && call.args.includes(String(last))), JSON.stringify(gh.calls));
    assert.deepEqual(warnings, []);
  });

  // Narrowing a failed batch makes single-issue batches back to back, each of
  // whose edits can fail for that issue's own reasons, so they don't count
  // toward the refused-batches limit.
  it("still judges the rest when single-issue batches from narrowing are refused in a row", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE + 1 }, (_, i) => issue(i + 1));
    const closed = ["2", "3"];
    const gh = recordingGh(["Sandcastle"], (args) => (args[1] === "edit" && closed.includes(String(args[2])) ? new Error("gh: issue closed") : undefined));
    const warnings: string[] = [];

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        if (sent.includes(1)) throw new Error("truncated <intake> block");
        return sent.map((number) => verdict(number, { reason: "clear and checkable" }));
      },
      gh.run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    const edited = issues
      .map((i) => i.number)
      .filter((number) => gh.calls.some((call) => call.args[1] === "edit" && call.args[2] === String(number)));
    assert.deepEqual(edited, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.ok(!warnings.some((warning) => /GitHub refused/.test(warning)), warnings.join("\n"));
  });

  // Refused batches with a good one between them aren't "in a row".
  it("still judges the next batch when a batch GitHub accepted sits between two refused ones", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE * 4 }, (_, i) => issue(i + 1));
    const refused = (number: number) => number <= INTAKE_BATCH_SIZE || (number > INTAKE_BATCH_SIZE * 2 && number <= INTAKE_BATCH_SIZE * 3);
    const gh = recordingGh(["Sandcastle"], (args) => (args[1] === "edit" && refused(Number(args[2])) ? new Error("gh: HTTP 502") : undefined));
    const warnings: string[] = [];

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        return sent.map((number) => verdict(number, { reason: "clear and checkable" }));
      },
      gh.run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    const last = INTAKE_BATCH_SIZE * 4;
    assert.ok(gh.calls.some((call) => call.args[1] === "edit" && call.args[2] === String(last)), JSON.stringify(gh.calls.length));
    assert.ok(!warnings.some((warning) => /GitHub refused/.test(warning)), warnings.join("\n"));
  });

  // The run that reaches the limit may be a batch's own: intake mustn't then
  // log that it's splitting a batch it never tries.
  it("doesn't log a split it won't try once intake has stopped for the round", async () => {
    const lines: string[] = [];

    await intakeRound(
      Array.from({ length: INTAKE_BATCH_SIZE * 3 }, (_, i) => issue(i + 1)),
      [],
      async () => {
        throw new Error("the sandbox didn't start");
      },
      recordingGh().run,
      "o/r",
      new HandBackReport(),
      (line) => lines.push(line),
      () => {},
    );

    const splits = lines.filter((line) => /trying them in halves/.test(line)).length;
    const runs = lines.filter((line) => /^Intake is judging/.test(line)).length;
    assert.equal(runs, INTAKE_FAILED_RUNS_LIMIT);
    // Every split logged is followed by at least one run of its halves.
    assert.ok(splits < runs, lines.join("\n"));
    const last = lines.at(-1)!;
    assert.match(last, /^Intake is judging/, lines.join("\n"));
  });

  // Batches are slices of the unjudged issues, so a failed batch re-forms
  // with the same issues every round: without splitting, one bad issue would
  // keep its batch-mates unjudged for good.
  it("splits a batch whose intake run fails until only the issue that breaks it is left unjudged", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE }, (_, i) => issue(i + 1));
    const bad = 3;
    const gh = recordingGh();
    const warnings: string[] = [];

    await intakeRound(
      issues,
      [],
      async (promptArgs) => {
        const sent: number[] = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => i.number);
        if (sent.includes(bad)) throw new Error("truncated <intake> block");
        return sent.map((number) => verdict(number, { reason: "clear and checkable" }));
      },
      gh.run,
      "o/r",
      new HandBackReport(),
      () => {},
      (message) => warnings.push(message),
    );

    const edited = issues
      .map((i) => i.number)
      .filter((number) => gh.calls.some((call) => call.args.includes("edit") && call.args.includes(String(number))));
    assert.deepEqual(edited, issues.map((i) => i.number).filter((number) => number !== bad));
    assert.ok(warnings.some((warning) => /Intake failed on #3,/.test(warning) && /a later round or run/.test(warning)), warnings.join("\n"));
  });

  // A usage limit or time budget ends the whole run, not just one batch.
  it("rethrows an UncountedStopError from a batch without judging the next", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE + 1 }, (_, i) => issue(i + 1));
    const stop = new UncountedStopError("usage limit");
    let runs = 0;

    await assert.rejects(
      intakeRound(
        issues,
        [],
        async () => {
          runs += 1;
          throw stop;
        },
        recordingGh().run,
        "o/r",
        new HandBackReport(),
        () => {},
        () => {},
      ),
      (error) => error === stop,
    );
    assert.equal(runs, 1);
  });

  // AC: "An UncountedStopError (usage limit or time budget) still ends the
  // run as stopped with exit code 0, as today (tested)." It isn't a stop
  // intake records, even mid-streak, so intakeStopExitCode stays 0.
  it("records no stop when an UncountedStopError ends the round after some failed runs", async () => {
    const issues = Array.from({ length: INTAKE_BATCH_SIZE * 3 }, (_, i) => issue(i + 1));
    const stops = new IntakeStopReport();
    const stop = new UncountedStopError("usage limit");
    let runs = 0;

    await assert.rejects(
      intakeRound(
        issues,
        [],
        async () => {
          runs += 1;
          throw runs < INTAKE_FAILED_RUNS_LIMIT ? new Error("the sandbox didn't start") : stop;
        },
        recordingGh().run,
        "o/r",
        new HandBackReport(),
        () => {},
        () => {},
        stops,
      ),
      (error) => error === stop,
    );
    assert.equal(runs, INTAKE_FAILED_RUNS_LIMIT);
    assert.deepEqual(stops.items(), []);
  });

  it("doesn't judge an issue whose PR is open", async () => {
    let ran = false;

    await intakeRound(
      [issue(1)],
      [{ number: 50, headRefName: "fix/1-a-thing" }],
      async () => {
        ran = true;
        return [];
      },
      recordingGh().run,
      "o/r",
      new HandBackReport(),
    );

    assert.equal(ran, false);
  });

  it("skips the intake run when every issue already has a verdict label", async () => {
    let ran = false;
    const report = new HandBackReport();
    const noGh = (() => "") as unknown as typeof execFileSync;

    await intakeRound(
      [issue(1, ["Sandcastle", "sandcastle:ready"])],
      [],
      async () => {
        ran = true;
        return [];
      },
      noGh,
      "o/r",
      report,
    );

    assert.equal(ran, false);
  });

  it("runs intake and applies its verdicts for an issue that still needs one", async () => {
    const gh = recordingGh();
    const report = new HandBackReport();
    let sentIds: string[] | undefined;

    await intakeRound(
      [issue(2, ["Sandcastle"])],
      [],
      async (promptArgs) => {
        sentIds = JSON.parse(promptArgs.ISSUES_JSON).map((i: { number: number }) => String(i.number));
        return [verdict(2, { reason: "clear and checkable" })];
      },
      gh.run,
      "o/r",
      report,
    );

    assert.deepEqual(sentIds, ["2"]);
    const edits = gh.calls.filter((call) => call.args[0] === "issue" && call.args[1] === "edit");
    assert.deepEqual(edits.map((call) => call.args), [["issue", "edit", "2", "--repo", "o/r", "--add-label", "sandcastle:ready"]]);
  });
});

// main.mts's Phase 0a: a failed intake costs only the issues it was judging
// this round, and the run carries on to the gate.
describe("intakePhase", () => {
  // When nothing else is ready the run ends after the gate, so the retry may
  // only come with the next Sandcastle run, and the log says so.
  it("logs an intake run that throws, and carries on", async () => {
    const warnings: string[] = [];

    await intakePhase(
      () => ({ issues: [issue(1)], openPrs: [] }),
      async () => {
        throw new Error("StructuredOutputError: no <intake> tag");
      },
      (message) => warnings.push(message),
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /no <intake> tag/);
    assert.match(warnings[0]!, /a later round or run/);
  });

  it("logs a queue that can't be read, and carries on without running intake", async () => {
    let ran = false;
    const warnings: string[] = [];

    await intakePhase(
      () => {
        throw new Error("gh issue list failed:\nHTTP 502");
      },
      async () => {
        ran = true;
      },
      (message) => warnings.push(message),
    );

    assert.equal(ran, false);
    assert.match(warnings[0]!, /502/);
  });

  // A usage limit or time budget ends the whole run, not just intake.
  it("rethrows an UncountedStopError", async () => {
    const stop = new UncountedStopError("usage limit reached");

    await assert.rejects(
      intakePhase(
        () => ({ issues: [issue(1)], openPrs: [] }),
        async () => {
          throw stop;
        },
        () => {},
      ),
      (error) => error === stop,
    );
  });

  it("passes intake the issues and open PRs it loaded", async () => {
    const openPrs = [{ number: 50, headRefName: "feature/2-a-thing" }];
    let received: unknown;

    await intakePhase(
      () => ({ issues: [issue(1)], openPrs }),
      async (issues, prs) => {
        received = { issues: issues.map((i) => i.number), prs };
      },
      () => {},
    );

    assert.deepEqual(received, { issues: [1], prs: openPrs });
  });
});

// The live intake run, with Sandcastle's runRole stubbed. Sandcastle itself
// turns a missing <intake> tag or invalid JSON into a StructuredOutputError;
// what's ours is the role, prompt, tag and schema it's given.
describe("intakeRunner", () => {
  // A runRole stub that records its call and answers with `verdicts`.
  function stubRunRole(verdicts: IntakeVerdict[] = []) {
    const calls: { role: string; options: { promptFile?: string; promptArgs?: unknown; output: { tag: string; schema: unknown } } }[] = [];
    const runRole = (async (role: string, options: (typeof calls)[number]["options"]) => {
      calls.push({ role, options });
      return { iterations: [], commits: [], output: { verdicts } };
    }) as unknown as Parameters<typeof intakeRunner>[0];
    return { calls, runRole };
  }
  const noSandbox = (() => ({})) as unknown as Parameters<typeof intakeRunner>[1];
  // Validates `value` with the schema runIntake hands Sandcastle, as
  // Sandcastle does with the parsed <intake> JSON.
  async function validate(schema: unknown, value: unknown) {
    type Result = { issues?: unknown[]; value?: { verdicts: IntakeVerdict[] } };
    return (schema as { "~standard": { validate(value: unknown): Promise<Result> | Result } })["~standard"].validate(value);
  }

  it("runs the intake role on intake-prompt.md, asking for an <intake> block, and returns its verdicts", async () => {
    const { calls, runRole } = stubRunRole([verdict(3)]);

    const verdicts = await intakeRunner(runRole, noSandbox)({ ISSUES_JSON: "[]" });

    assert.deepEqual(verdicts, [verdict(3)]);
    assert.equal(calls[0]!.role, "intake");
    assert.equal(calls[0]!.options.promptFile, "./.sandcastle/intake-prompt.md");
    assert.deepEqual(calls[0]!.options.promptArgs, { ISSUES_JSON: "[]" });
    assert.equal(calls[0]!.options.output.tag, "intake");
  });

  it("gives Sandcastle a schema that accepts the prompt's example verdicts", async () => {
    const { calls, runRole } = stubRunRole();
    await intakeRunner(runRole, noSandbox)({ ISSUES_JSON: "[]" });

    const result = await validate(calls[0]!.options.output.schema, {
      verdicts: [
        { id: "42", verdict: "ready", bug: false, reason: "Clear." },
        { id: "43", verdict: "needs-info", bug: false, questions: ["Which scales?"], reason: "Open question." },
      ],
    });

    assert.equal(result.issues, undefined);
  });

  it("gives Sandcastle a schema that accepts a split verdict with drafted children", async () => {
    const { calls, runRole } = stubRunRole();
    await intakeRunner(runRole, noSandbox)({ ISSUES_JSON: "[]" });

    const result = await validate(calls[0]!.options.output.schema, {
      verdicts: [
        {
          id: "44",
          verdict: "split",
          bug: false,
          reason: "Clear, but needs three PRs.",
          children: [
            { title: "Part 1", body: "## Summary\n\n## Acceptance criteria\n\n- [ ] One." },
            { title: "Part 2", body: "## Summary\n\n## Acceptance criteria\n\n- [ ] Two." },
          ],
        },
      ],
    });

    assert.equal(result.issues, undefined);
  });

  // The issue JSON gives `number` as a number, so a model may echo it as one;
  // and one verdict without bug would otherwise cost the whole batch.
  it("gives Sandcastle a schema that takes a numeric id as a string and a missing bug as false", async () => {
    const { calls, runRole } = stubRunRole();
    await intakeRunner(runRole, noSandbox)({ ISSUES_JSON: "[]" });

    const result = await validate(calls[0]!.options.output.schema, { verdicts: [{ id: 42, verdict: "ready", reason: "Clear." }] });

    assert.equal(result.issues, undefined);
    assert.deepEqual(result.value!.verdicts, [{ id: "42", verdict: "ready", bug: false, reason: "Clear." }]);
  });

  for (const [what, value] of [
    ["an unknown verdict", { verdicts: [{ id: "1", verdict: "maybe", bug: false, reason: "?" }] }],
    ["no verdicts list", { verdict: "ready" }],
    ["a split verdict whose child has no body", { verdicts: [{ id: "1", verdict: "split", bug: false, reason: "?", children: [{ title: "Part 1" }] }] }],
  ] as const) {
    it(`gives Sandcastle a schema that rejects ${what}`, async () => {
      const { calls, runRole } = stubRunRole();
      await intakeRunner(runRole, noSandbox)({ ISSUES_JSON: "[]" });

      const result = await validate(calls[0]!.options.output.schema, value);

      assert.ok(result.issues && result.issues.length > 0);
    });
  }
});

// The reason and questions come from a model that read untrusted issue text,
// so they're posted as plain text.
describe("intake's comments", () => {
  const hostile =
    "Use ``` here, cc @someone, see #123 and owner/repo#45, GH-67 and https://github.com/owner/repo/issues/89 <details><summary>ok</summary> <!-- hidden, &#64;someone &commat;someone &#35;123 github&#46;com";

  for (const [name, body] of [
    ["the ready comment's reason", () => readyComment(verdict(1, { reason: hostile }))],
    ["the needs-info comment's reason", () => needsInfoComment(verdict(1, { verdict: "needs-info", questions: ["Which?"], reason: hostile }))],
    ["a needs-info question", () => needsInfoComment(verdict(1, { verdict: "needs-info", questions: [hostile], reason: "r" }))],
    ["the umbrella comment's reason", () => umbrellaComment(verdict(1, { verdict: "split", reason: hostile }), [{ number: 5, title: "Part 1" }])],
    ["a child's title in the umbrella comment", () => umbrellaComment(verdict(1, { verdict: "split", reason: "r" }), [{ number: 5, title: hostile }])],
  ] as const) {
    it(`posts ${name} without a code fence, HTML, mention or cross-reference`, () => {
      // The umbrella comment's own marker is the host's, not intake's text.
      const text = body().replace(UMBRELLA_MARKER, "");

      assert.doesNotMatch(text, /(^|[^\\])```/m);
      assert.doesNotMatch(text, /@someone/);
      assert.doesNotMatch(text, /#123/);
      assert.doesNotMatch(text, /#45/);
      assert.doesNotMatch(text, /GH-67/i);
      assert.doesNotMatch(text, /github\.com/i);
      assert.doesNotMatch(text, /<details|<summary|<!--/);
      // A character reference would decode into the @, # or . the rules above
      // break, so every & must be escaped.
      assert.doesNotMatch(text, /&(?!amp;|lt;)/);
      assert.match(text, /Use \\`\\`\\` here/);
    });
  }

  it("keeps a reason with line breaks on its one line", () => {
    const text = readyComment(verdict(1, { reason: "First.\n\n```\nSecond." }));

    assert.match(text, /\*\*Reason:\*\* First\. \\`\\`\\` Second\./);
  });

  for (const [question, posted] of [
    ["- a list item?", "1. \\- a list item?"],
    ["# a heading?", "1. \\# a heading?"],
    ["> a quote?", "1. \\> a quote?"],
  ] as const) {
    it(`escapes a question that starts with ${question.slice(0, 1)}`, () => {
      const text = needsInfoComment(verdict(1, { verdict: "needs-info", questions: [question], reason: "r" }));

      assert.ok(text.split("\n").includes(posted), text);
    });
  }
});
