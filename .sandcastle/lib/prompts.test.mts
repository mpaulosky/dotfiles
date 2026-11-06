import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { withSharedRules } from "./agents.mts";
import type { PromptThread } from "./follow-up-pass.mts";
import type { SandcastleIssue } from "./github.mts";
import {
  architectPromptArgs,
  backendPromptArgs,
  critiquePromptArgs,
  followUpPromptArgs,
  gateFixerPromptArgs,
  intakePromptArgs,
  issuePromptArgs,
  plannerPromptArgs,
  PR_BODY_RULES,
  reviewerPromptArgs,
  UI_ROLE_BULLET,
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

  it("gives the role a sentence when the issue has no body, rather than leave a blank", () => {
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
    const args = plannerPromptArgs([issue], false);

    assert.match(args.ISSUES_JSON, /Use the existing helper\./);
    assert.ok(!args.ISSUES_JSON.includes("delete the tests"));
  });

  it("gives the planner only the ready issues and the ui role's bullet, since the host names branches and skips open PRs", () => {
    const args = plannerPromptArgs([issue], false);

    assert.deepEqual(Object.keys(args), ["ISSUES_JSON", "UI_ROLE"]);
  });

  // mpaulosky/dotfiles#392: the Owned plan-prompt.md carries {{UI_ROLE}}; a repo without a UI role leaves the planner's ui bullet out.
  it("fills UI_ROLE with the ui bullet when the repo opted into the ui role", () => {
    const args = plannerPromptArgs([issue], true);

    assert.equal(args.UI_ROLE, UI_ROLE_BULLET);
    assert.match(args.UI_ROLE, /^- `ui`:/);
  });

  it("fills UI_ROLE with nothing when the repo didn't opt into the ui role", () => {
    assert.equal(plannerPromptArgs([issue], false).UI_ROLE, "");
  });

  // UI_ROLE and REPO_SKILLS (lib/agents.mts#withSharedRules) are passed empty when the repo has no UI role or no skills block. That is only safe
  // while Sandcastle refuses a prompt argument holding null or undefined and nothing else, which this reads from the pinned package.
  it("passes UI_ROLE empty safely, since the pinned Sandcastle refuses only a null or undefined prompt argument", () => {
    const source = readFileSync(new URL(import.meta.resolve("@ai-hero/sandcastle")), "utf8");
    const check = /const value = sanitizedArgs\[key\];\s*if \(value == null\) \{/.exec(source);

    assert.ok(check, "Sandcastle's promptArgs check changed: confirm it still accepts an empty string, then update this test");
    assert.equal(plannerPromptArgs([issue], false).UI_ROLE, "");
    assert.equal(typeof plannerPromptArgs([issue], false).UI_ROLE, "string");
  });

  it("words the ui bullet for any repo: no Blazor, and it points at the shared rules for which files are the UI developer's", () => {
    assert.doesNotMatch(UI_ROLE_BULLET, /Blazor|\.razor/);
    assert.match(UI_ROLE_BULLET, /shared rules/);
    assert.match(UI_ROLE_BULLET, /UI developer/);
    assert.ok(!UI_ROLE_BULLET.includes("\n"), "the bullet is one line");
  });
});

describe("backendPromptArgs", () => {
  // mpaulosky/dotfiles#392: the Owned backend prompt reads the same in every repo, so the text the host fills in names no stack.
  it("words the UI developer text for any repo: no Blazor, and it sends the reader to the shared rules for the UI files", () => {
    const text = String(backendPromptArgs(issue, "feature/3-add-a-thing", true).UI_DEVELOPER);

    assert.match(text, /UI developer runs after you/);
    assert.doesNotMatch(text, /Blazor|\.razor|bUnit/);
    assert.match(text, /shared rules/);
    assert.match(text, /say so in your last commit's body/);
  });

  it("keeps the no-UI-developer text: this run is the last developer run and every test must pass", () => {
    const text = String(backendPromptArgs(issue, "feature/3-add-a-thing", false).UI_DEVELOPER);

    assert.match(text, /No UI developer runs for this issue/);
    assert.match(text, /your run is the last developer run: every test must pass by its end\./);
    assert.doesNotMatch(text, /Blazor/);
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

  // The gate-fixer prompt knows two checkpoints; the gate after the host-side review's fixes (checkpoint 3) is a repair-only one
  // like the second, so the fixer is told it is at the second.
  it("tells the gate-fixer a gate after the review's fixes is at checkpoint 2, the repair-only one it knows", () => {
    const args = gateFixerPromptArgs(issue, "feature/3-add-a-thing", 3, "red");

    assert.equal(args.CHECKPOINT, "2");
    assert.equal(args.GATE_OUTPUT, "red");
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

  it("still fills CODEQL_LOG when there's no log, rather than leave a blank, without claiming the gate passed", () => {
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

// The rules for the reviewer's PR description travel as a prompt argument the
// host fills in, so they match what the host refuses (lib/build.mts#reviewerPrBody).
describe("reviewerPromptArgs", () => {
  it("gives the reviewer PR_BODY_RULES, the Template's fragment, and not an empty one", () => {
    const args = reviewerPromptArgs(issue, "feature/3-add-a-thing");

    assert.equal(args.PR_BODY_RULES, PR_BODY_RULES);
    assert.notEqual(PR_BODY_RULES.trim(), "");
  });

  it("is the issue's prompt arguments plus PR_BODY_RULES, and no other role's", () => {
    const args = reviewerPromptArgs(issue, "feature/3-add-a-thing");

    assert.deepEqual(args, { ...issuePromptArgs(issue, "feature/3-add-a-thing"), PR_BODY_RULES });
    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
  });
});
