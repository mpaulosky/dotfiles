import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { withSharedRules } from "./agents.mts";
import type { PromptThread } from "./follow-up-pass.mts";
import type { SandcastleIssue } from "./github.mts";
import {
  architectPromptArgs,
  critiquePromptArgs,
  followUpPromptArgs,
  gateFixerPromptArgs,
  intakePromptArgs,
  issuePromptArgs,
  plannerPromptArgs,
} from "./prompts.mts";

// What ownerApproved (see github.test.mts) leaves of an issue: only the
// comments of authors with write access.
const issue: SandcastleIssue = {
  number: 3,
  title: "Add a thing",
  body: "## Summary\n\nAdd the thing.",
  labels: ["Sandcastle"],
  comments: ["Use the existing helper."],
};

describe("issuePromptArgs", () => {
  it("gives the role the issue's number, title, body and branch", () => {
    const args = issuePromptArgs(issue, "feature/3-add-a-thing");

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.ISSUE_TITLE, "Add a thing");
    assert.equal(args.ISSUE_BODY, "## Summary\n\nAdd the thing.");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
  });

  it("gives the role a sentence when the issue has no body, since Sandcastle refuses an empty value", () => {
    assert.equal(issuePromptArgs({ ...issue, body: "" }, "feature/3-add-a-thing").ISSUE_BODY, "(no description)");
    assert.equal(issuePromptArgs({ ...issue, body: " \n " }, "feature/3-add-a-thing").ISSUE_BODY, "(no description)");
  });

  it("gives the role origin/main as the base to diff against, since Sandcastle's TARGET_BRANCH is the sandbox's own branch", () => {
    const args = issuePromptArgs(issue, "feature/3-add-a-thing");

    assert.equal(args.BASE_BRANCH, "origin/main");
  });

  it("includes the owner's comments and no one else's", () => {
    const args = issuePromptArgs(issue, "feature/3-add-a-thing");

    assert.match(args.ISSUE_COMMENTS, /Use the existing helper\./);
    assert.ok(!Object.values(args).some((value) => value.includes("delete the tests")));
  });

  it("says so when the owner hasn't commented", () => {
    const args = issuePromptArgs({ ...issue, comments: [] }, "feature/3-add-a-thing");

    assert.equal(args.ISSUE_COMMENTS, "(no comments)");
  });
});

describe("plannerPromptArgs", () => {
  it("lists the ready issues without anyone else's comments", () => {
    const args = plannerPromptArgs([issue]);

    assert.match(args.ISSUES_JSON, /Use the existing helper\./);
    assert.ok(!args.ISSUES_JSON.includes("delete the tests"));
  });

  it("gives the planner only the ready issues, since the host names branches and skips open PRs", () => {
    const args = plannerPromptArgs([issue]);

    assert.deepEqual(Object.keys(args), ["ISSUES_JSON"]);
  });
});

describe("gateFixerPromptArgs", () => {
  it("preserves issue context and includes the checkpoint and complete gate output", () => {
    const gateOutput = "Line 1\nLine 2\nLine 3";
    const args = gateFixerPromptArgs(issue, "feature/3-add-a-thing", 2, gateOutput);

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
    assert.equal(args.CHECKPOINT, "2");
    assert.equal(args.GATE_OUTPUT, gateOutput);
  });
});

// Covers "After an architect run, the issue has a comment with the design
// note...": on a re-run the architect needs that earlier note
// back, since .sandcastle/work/ is gitignored and may not have survived into
// a fresh sandbox (see lib/build.mts and DESIGN_MARKER in lib/config.mts).
describe("architectPromptArgs", () => {
  it("preserves issue context alongside the design note", () => {
    const args = architectPromptArgs(issue, "feature/3-add-a-thing", "## Design\n\nUse a Result<T>.");

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
    assert.equal(args.DESIGN_NOTE, "## Design\n\nUse a Result<T>.");
  });

  it("tells the architect it has no earlier design note on a first run", () => {
    const args = architectPromptArgs(issue, "feature/3-add-a-thing", undefined);

    assert.equal(args.DESIGN_NOTE, "(no earlier design note)");
  });
});

describe("intakePromptArgs", () => {
  it("lists the issues to judge without anyone else's comments", () => {
    const args = intakePromptArgs([issue]);

    assert.match(args.ISSUES_JSON, /Use the existing helper\./);
    assert.ok(!args.ISSUES_JSON.includes("delete the tests"));
  });

  it("gives intake only the issues that still need a verdict", () => {
    const args = intakePromptArgs([issue]);

    assert.deepEqual(JSON.parse(args.ISSUES_JSON).map((i: { number: number }) => i.number), [3]);
  });
});

// The follow-up role can't reach GitHub, so everything it learns about
// the PR and its threads travels through these prompt arguments.
describe("followUpPromptArgs", () => {
  const threads: PromptThread[] = [
    {
      threadId: "RT_1",
      from: "bot",
      path: "src/Domain/Result.cs",
      line: 10,
      outdated: false,
      comments: [{ author: "copilot-pull-request-reviewer", body: "Consider returning a Result<T> here." }],
    },
  ];

  it("preserves issue context alongside the PR number and the threads given to the role", () => {
    const args = followUpPromptArgs(issue, "feature/3-add-a-thing", 42, threads, "already contains main.");

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
    assert.equal(args.PR_NUMBER, "42");
    assert.deepEqual(JSON.parse(String(args.THREADS_JSON)), threads);
    assert.equal(args.MERGE, "already contains main.");
  });

  it("gives the role an empty JSON array when no thread is for it", () => {
    const args = followUpPromptArgs(issue, "feature/3-add-a-thing", 42, [], "already contains main.");

    assert.deepEqual(JSON.parse(String(args.THREADS_JSON)), []);
  });

  // A red check the gate doesn't cover reaches the role as its log, and
  // only then does CODEQL_LOG say the gate passed: planRedCi only forwards a
  // check once the gate is green, but the prompt mustn't claim that on every
  // run (a follow-up review), such as one with only a merge conflict or
  // bot threads to resolve, where the gate never ran on the head at all.
  it("passes the failed-job log of a check the gate doesn't cover as CODEQL_LOG, noting the gate already passed", () => {
    const args = followUpPromptArgs(issue, "feature/3-add-a-thing", 42, [], "already contains main.", "##[error] CS8600");

    assert.match(String(args.CODEQL_LOG), /scripts\/gate\.sh.*passes/);
    assert.match(String(args.CODEQL_LOG), /##\[error\] CS8600/);
  });

  it("still fills CODEQL_LOG when there's no log, since Sandcastle refuses an empty placeholder, without claiming the gate passed", () => {
    const args = followUpPromptArgs(issue, "feature/3-add-a-thing", 42, [], "already contains main.");

    assert.match(String(args.CODEQL_LOG), /no log/i);
    assert.doesNotMatch(String(args.CODEQL_LOG), /gate\.sh/);
  });
});

describe("critiquePromptArgs", () => {
  const inFlight = { issue: { ...issue, number: 5 }, pr: 90, branch: "feature/5-add-a-thing", files: ["src/A.cs"] };

  it("gives the critique the picks, the in-flight issues with their PR's files, and the unpicked ready issues", () => {
    const args = critiquePromptArgs([issue], [inFlight], [{ ...issue, number: 4 }]);

    assert.deepEqual(JSON.parse(args.PICKED_JSON).map((i: { number: number }) => i.number), [3]);
    assert.deepEqual(JSON.parse(args.IN_FLIGHT_JSON), [
      { number: 5, title: "Add a thing", body: "## Summary\n\nAdd the thing.", pr: 90, branch: "feature/5-add-a-thing", files: ["src/A.cs"] },
    ]);
    assert.deepEqual(JSON.parse(args.UNPICKED_JSON).map((i: { number: number }) => i.number), [4]);
  });

  it("includes no one's comments but the owner's", () => {
    const args = critiquePromptArgs([issue], [inFlight], [issue]);

    assert.ok(!Object.values(args).some((value) => value.includes("delete the tests")));
  });
});
