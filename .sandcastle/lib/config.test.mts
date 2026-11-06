import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUILD_ROLES,
  BUILDING_LABEL_MAX_AGE_MS,
  ROLE_RUN_GRACE_MINUTES,
  BudgetError,
  DEFAULT_BUDGET_MINUTES,
  FIXED_ROLE_AGENTS,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_LABEL_DEFINITION,
  GATE_FIXER_ATTEMPTS,
  HOST_LABELS,
  LOCAL_QUEUE_LABEL,
  LOCAL_QUEUE_LABEL_DEFINITION,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_GATE_RUNS,
  MAX_REVIEWERS_PER_ROUND,
  OPTIONAL_ROLES,
  QUEUE_LABEL,
  QUEUE_SCOPE_USAGE,
  QueueScopeError,
  REVIEW_FIX_ROUNDS,
  REVIEW_WALL_CLOCK_MINUTES,
  REVIEWER_ATTEMPTS,
  ROLES,
  RunModeError,
  ReviewerModeError,
  SANDBOX_CPUS,
  SANDCASTLE_LABELS,
  SESSION_REPLY_MARKER,
  budgetMinutesFrom,
  isDefaultQueueScope,
  reviewerMode,
  queueScopeFrom,
  runModeFrom,
  sandboxCpus,
} from "./config.mts";
import { GATE_LIMIT_MINUTES } from "./repo-config.mts";
import { COMMAND_LIMIT_MINUTES } from "./step-limit.mts";
import * as config from "./config.mts";
import { roleAgent, uiEnabled } from "./agents.mts";
import { ROLE_AGENTS } from "./repo-config.mts";

describe("ROLE_AGENTS", () => {
  // lib/repo-config.mts gives each role its agent. The Owned modules index it by Role, so a role it lacks fails a run, and one
  // it adds that ROLES lacks fails the type-check, except the opt-in `ui`, which is not in ROLES so that a
  // repo-config.mts written before it existed still type-checks.
  it("gives every role in ROLES an agent, and no other but the opt-in ui", () => {
    assert.deepEqual(Object.keys(ROLE_AGENTS).filter((role) => role !== "ui").sort(), [...ROLES].sort());
  });

  it("names every role the build and the optional-role list use", () => {
    for (const role of [...BUILD_ROLES, ...OPTIONAL_ROLES]) {
      assert.ok(role === "ui" || ROLES.includes(role), `${role} is missing from ROLES`);
    }
  });

  // A repo that adds a ui entry also needs the prompts the role and its planner pick read, or its first ui build fails.
  it("has the prompts the ui role needs when the repo opted into it", { skip: !uiEnabled() && "the repo hasn't opted into the ui role" }, () => {
    const file = (path: string) => new URL(`../${path}`, import.meta.url);

    assert.ok(existsSync(file("roles/ui.md")), "roles/ui.md is missing");
    assert.match(readFileSync(file("roles/backend.md"), "utf8"), /\{\{UI_DEVELOPER\}\}/);
    assert.match(readFileSync(file("plan-prompt.md"), "utf8"), /\{\{UI_ROLE\}\}/, "plan-prompt.md is missing {{UI_ROLE}}, where the host puts the planner's ui bullet");
    // The planner's bullet, backend.md and roles/ui.md all send the reader to the shared rules for which files are the UI developer's. The file is
    // the repo's own Seed, so only that the section exists and has text of its own is checked, not its wording: the Seed ships the heading with
    // only a comment under it, which a repo that opted in and edited nothing must not pass.
    // The section ends at the next heading of its own level or a higher one, so sub-headings under it are part of it.
    const rules = visibleMarkdown(readFileSync(file("roles/shared-rules.md"), "utf8"));
    const heading = /^ {0,3}(#{1,6})\s+UI developer\s*$/m.exec(rules);

    assert.ok(heading, 'roles/shared-rules.md has no "## UI developer" section outside a comment or an unclosed code fence (either hides everything after it): add one that names the UI files, or the developer and the ui role each leave them to the other');

    const afterHeading = rules.slice(heading.index + heading[0].length);
    const body = (afterHeading.split(new RegExp(`^ {0,3}#{1,${heading[1]!.length}}\\s`, "m"))[0] ?? "").trim();

    assert.notEqual(body, "", 'roles/shared-rules.md\'s "## UI developer" section has only a comment: replace it with the UI files the ui role builds');
  });
});

// A review-prompt.md without the placeholder never tells its reviewer what the host refuses in a PR description.
describe("review-prompt.md", () => {
  it("has {{PR_BODY_RULES}} where the PR description's rules go", () => {
    const prompt = readFileSync(new URL("../review-prompt.md", import.meta.url), "utf8");

    assert.match(
      prompt,
      /\{\{PR_BODY_RULES\}\}/,
      "add `{{PR_BODY_RULES}}` where the PR description's rules go; the Template's Owned review-prompt.md shows where",
    );
  });
});

describe("the host-side review's fixed role", () => {
  it("is the pre-push-review skill's reviewer: sonnet at high effort, once per run, and in no repo's ROLES", () => {
    const agent = FIXED_ROLE_AGENTS["pre-push-reviewer"];

    assert.equal(agent.model, "sonnet");
    assert.equal(agent.effort, "high");
    assert.equal(agent.maxIterations, 1);
    assert.ok(agent.timeoutMinutes > 0);
    assert.ok(!(ROLES as readonly string[]).includes("pre-push-reviewer"), "a repo's ROLE_AGENTS would have to name it");
  });

  it("stops fixing after 3 rounds and asks each reviewer for a valid answer twice", () => {
    assert.equal(REVIEW_FIX_ROUNDS, 3);
    assert.equal(REVIEWER_ATTEMPTS, 2);
  });
});

// Issue 399: the lead of a round's parallel subagents is a fixed role of its own, so one timeout covers the whole wave.
describe("the review lead's fixed role", () => {
  it("is sonnet at the reviewer's effort, once per run, for 30 minutes: the reviewer's 20 with all lenses in one wave, plus relay time", () => {
    const lead = FIXED_ROLE_AGENTS["pre-push-review-lead"];

    assert.equal(lead.model, "sonnet");
    assert.equal(lead.effort, FIXED_ROLE_AGENTS["pre-push-reviewer"].effort);
    assert.equal(lead.maxIterations, 1);
    assert.equal(lead.timeoutMinutes, 30);
  });

  it("is in no repo's ROLES, so a repo's ROLE_AGENTS names none", () => {
    assert.ok(!(ROLES as readonly string[]).includes("pre-push-review-lead"));
    assert.deepEqual(roleAgent("pre-push-review-lead"), FIXED_ROLE_AGENTS["pre-push-review-lead"]);
  });

  it("starts every reviewer of a round in one wave: MAX_REVIEWERS_PER_ROUND is within Claude Code's 20 concurrent subagents", () => {
    assert.equal(MAX_CONCURRENT_SUBAGENTS, 20);
    assert.ok(MAX_REVIEWERS_PER_ROUND <= MAX_CONCURRENT_SUBAGENTS, `${MAX_REVIEWERS_PER_ROUND} reviewers > ${MAX_CONCURRENT_SUBAGENTS} subagents`);
  });
});

// The switch stays on "sequential" until the items references/pre-push-review.md lists as open are settled and a person accepts the relay risk, and a typo must not silently pick a path.
describe("reviewerMode", () => {
  it("is sequential when SANDCASTLE_REVIEWERS is unset or empty", () => {
    assert.equal(reviewerMode({}), "sequential");
    assert.equal(reviewerMode({ SANDCASTLE_REVIEWERS: "" }), "sequential");
    assert.equal(reviewerMode({ SANDCASTLE_REVIEWERS: undefined }), "sequential");
  });

  it("reads sequential and subagents as they are", () => {
    assert.equal(reviewerMode({ SANDCASTLE_REVIEWERS: "sequential" }), "sequential");
    assert.equal(reviewerMode({ SANDCASTLE_REVIEWERS: "subagents" }), "subagents");
  });

  it("throws for anything else, rather than pick a path for a typo", () => {
    for (const value of ["subagent", "Subagents", "parallel", "1", "true"]) {
      assert.throws(() => reviewerMode({ SANDCASTLE_REVIEWERS: value }), /SANDCASTLE_REVIEWERS/, JSON.stringify(value));
    }
  });

  // main.mts catches this class to exit 2 at start-up; a plain Error would read as a crash.
  it("throws a ReviewerModeError, so main.mts can refuse the value at start-up", () => {
    for (const value of ["subagent", "subagents ", " subagents", "SEQUENTIAL"]) {
      assert.throws(() => reviewerMode({ SANDCASTLE_REVIEWERS: value }), ReviewerModeError, JSON.stringify(value));
    }
  });
});

describe("sandboxCpus", () => {
  it("gives a sandbox 4 CPUs at most (mpaulosky/dotfiles#423)", () => {
    assert.equal(SANDBOX_CPUS, 4);
  });

  it("gives a daemon with fewer CPUs all of them, since docker refuses --cpus above its count", () => {
    assert.equal(sandboxCpus(1), 1);
    assert.equal(sandboxCpus(2), 2);
    assert.equal(sandboxCpus(3), 3);
    assert.equal(sandboxCpus(4), 4);
    assert.equal(sandboxCpus(5), 4);
    assert.equal(sandboxCpus(64), 4);
  });

  it("rounds a fractional count down", () => {
    assert.equal(sandboxCpus(2.9), 2);
    assert.equal(sandboxCpus(1.5), 1);
  });

  it("gives no limit (undefined) for a count that is not a count of CPUs", () => {
    assert.equal(sandboxCpus(undefined), undefined);
    assert.equal(sandboxCpus(0.5), undefined);
    assert.equal(sandboxCpus(0), undefined);
    assert.equal(sandboxCpus(-3), undefined);
    assert.equal(sandboxCpus(Number.NaN), undefined);
    assert.equal(sandboxCpus(Number.POSITIVE_INFINITY), undefined);
  });
});

describe("BUILDING_LABEL_MAX_AGE_MS", () => {
  // A startup clears a sandcastle:building label older than this as a crashed
  // run's, so it must outlast the longest build a live run can make, or a
  // second run would clear a live build's label and build the issue too.
  // BUILD_ROLES, each once, plus the gate-fixer's attempts at both
  // checkpoints, plus the host-side review (lib/host-review.mts), which is capped at REVIEW_WALL_CLOCK_MINUTES and may overrun it by one step.
  // build.test.mts checks buildIssue runs no other role.
  it("outlasts the longest build the role timeouts allow, with twenty minutes for sandboxes and publishing", () => {
    const checkpoints = 2;
    // The UI developer counts even in a repo that hasn't opted in, at the backend developer's budget (the Seed's example
    // entry), so a repo that opts in with a larger one gets the sum checked again by this test in its own config.
    const timeout = (role: (typeof BUILD_ROLES)[number]) => (role === "ui" && !uiEnabled() ? ROLE_AGENTS.backend : roleAgent(role)).timeoutMinutes;
    // Checkpoint 1 runs the gate, then once more after each gate-fixer attempt. Checkpoint 2 runs it on the merged tree first,
    // and when that is red goes through the same loop as checkpoint 1: MAX_GATE_RUNS runs in all, each up to its step limit.
    const gateRuns = MAX_GATE_RUNS;
    const gateFixing = ROLE_AGENTS["gate-fixer"].timeoutMinutes * GATE_FIXER_ATTEMPTS;
    // The review stops starting steps after REVIEW_WALL_CLOCK_MINUTES (lib/host-review.mts), so it takes that plus the step it was in:
    // a reviewer's attempts, or a fixer run with its gate-fixer attempts and gate runs after it.
    const review =
      REVIEW_WALL_CLOCK_MINUTES +
      Math.max(
        REVIEWER_ATTEMPTS * Math.max(FIXED_ROLE_AGENTS["pre-push-reviewer"].timeoutMinutes, FIXED_ROLE_AGENTS["pre-push-review-lead"].timeoutMinutes) + ROLE_RUN_GRACE_MINUTES,
        ROLE_AGENTS.backend.timeoutMinutes + ROLE_RUN_GRACE_MINUTES + gateFixing + MAX_GATE_RUNS * GATE_LIMIT_MINUTES,
      );
    const minutes =
      BUILD_ROLES.reduce((sum, role) => sum + timeout(role), 0) +
      checkpoints * gateFixing +
      gateRuns * GATE_LIMIT_MINUTES +
      // A command other than the gate that runs over its limit stalls the sandbox: it throws, as does every later exec and
      // every role start (lib/step-limit.mts, lib/agents.mts), so one more limit is the most any build adds from them.
      // The probe before each gate-fixer attempt (lib/checkpoint.mts#sandboxDown) is such a command.
      COMMAND_LIMIT_MINUTES +
      // A role run the host gave up on stalls its sandbox the same way, so a build adds this grace once.
      ROLE_RUN_GRACE_MINUTES +
      review;
    const spare = 20;

    assert.ok(
      (minutes + spare) * 60_000 <= BUILDING_LABEL_MAX_AGE_MS,
      `the longest build takes ${minutes} minutes plus twenty minutes, past BUILDING_LABEL_MAX_AGE_MS`,
    );
  });
});

// A local run must never silently build the whole queue nor silently build
// nothing: an environment that names no valid scope is a usage error, not a
// default ("A local run without SANDCASTLE_ISSUE or SANDCASTLE_LABEL
// exits non-zero with a usage message and touches nothing").
describe("queueScopeFrom", () => {
  it("throws QueueScopeError with both usage forms when neither variable is set", () => {
    try {
      queueScopeFrom({});
      assert.fail("expected queueScopeFrom to throw");
    } catch (error) {
      assert.ok(error instanceof QueueScopeError);
      assert.match((error as Error).message, /SANDCASTLE_ISSUE/);
      assert.match((error as Error).message, /SANDCASTLE_LABEL/);
    }
  });

  it("throws when both SANDCASTLE_ISSUE and SANDCASTLE_LABEL are set", () => {
    assert.throws(() => queueScopeFrom({ SANDCASTLE_ISSUE: "146", SANDCASTLE_LABEL: "Sandcastle:dev" }), QueueScopeError);
  });

  for (const bad of ["0", "abc", "12a", "-1", " "]) {
    it(`throws when SANDCASTLE_ISSUE is "${bad}"`, () => {
      assert.throws(() => queueScopeFrom({ SANDCASTLE_ISSUE: bad }), QueueScopeError);
    });
  }

  it("throws when SANDCASTLE_ISSUE is blank", () => {
    assert.throws(() => queueScopeFrom({ SANDCASTLE_ISSUE: "" }), QueueScopeError);
  });

  it("throws when SANDCASTLE_LABEL is blank", () => {
    assert.throws(() => queueScopeFrom({ SANDCASTLE_LABEL: "" }), QueueScopeError);
  });

  // gh's --label is a CSV list: a comma splits the label in two, and a stray
  // quote fails gh's parse.
  for (const label of ["Sandcastle,dev", 'Sandcastle"dev']) {
    it(`throws when SANDCASTLE_LABEL is ${JSON.stringify(label)}, which gh's --label would split or fail to parse`, () => {
      assert.throws(() => queueScopeFrom({ SANDCASTLE_LABEL: label }), /SANDCASTLE_LABEL can't contain/);
    });
  }

  for (const managed of ["sandcastle:ready", "Sandcastle:Ready", "bug", "BUG", "sandcastle:building", "sandcastle:needs-info", "sandcastle:needs-human"]) {
    it(`throws when SANDCASTLE_LABEL names the host-managed label "${managed}"`, () => {
      assert.throws(() => queueScopeFrom({ SANDCASTLE_LABEL: managed }), QueueScopeError);
    });
  }

  // The hand-off label is the owner's to add, and a run follows hand-off pull requests only on the default queue: a
  // SANDCASTLE_LABEL naming it would queue the issues that carry it and run the local scope's follow-ups on them.
  for (const handOff of ["sandcastle:follow-up", "Sandcastle:Follow-Up"]) {
    it(`throws when SANDCASTLE_LABEL names the hand-off label "${handOff}", saying it is the owner's, not a queue`, () => {
      assert.throws(() => queueScopeFrom({ SANDCASTLE_LABEL: handOff }), (error: unknown) => {
        assert.ok(error instanceof QueueScopeError);
        assert.match(error.message, /the owner's hand-off label for a pull request, not a queue/);
        return true;
      });
    });
  }

  it("resolves SANDCASTLE_ISSUE to an issue scope", () => {
    assert.deepEqual(queueScopeFrom({ SANDCASTLE_ISSUE: "146" }), { kind: "issue", number: 146 });
  });

  it("resolves SANDCASTLE_LABEL to a label scope, Sandcastle included: it's an explicit opt-in locally", () => {
    assert.deepEqual(queueScopeFrom({ SANDCASTLE_LABEL: "Sandcastle:dev" }), { kind: "label", label: "Sandcastle:dev" });
    assert.deepEqual(queueScopeFrom({ SANDCASTLE_LABEL: "Sandcastle" }), { kind: "label", label: "Sandcastle" });
  });

  it("resolves to the Sandcastle label in GitHub Actions", () => {
    assert.deepEqual(queueScopeFrom({ GITHUB_ACTIONS: "true" }), { kind: "label", label: "Sandcastle" });
  });

  for (const key of ["SANDCASTLE_ISSUE", "SANDCASTLE_LABEL"]) {
    it(`throws in GitHub Actions when ${key} is also set, rather than silently ignoring it`, () => {
      assert.throws(() => queueScopeFrom({ GITHUB_ACTIONS: "true", [key]: "146" }), QueueScopeError);
    });
  }

  it("QUEUE_SCOPE_USAGE shows both local forms", () => {
    assert.match(QUEUE_SCOPE_USAGE, /SANDCASTLE_ISSUE=<n>/);
    assert.match(QUEUE_SCOPE_USAGE, /SANDCASTLE_LABEL=<label>/);
  });
});

// No new round, and no role run, starts once this many minutes have
// passed since the run started.
describe("budgetMinutesFrom", () => {
  it("defaults to DEFAULT_BUDGET_MINUTES when unset", () => {
    assert.equal(budgetMinutesFrom({}), DEFAULT_BUDGET_MINUTES);
  });

  it("defaults to DEFAULT_BUDGET_MINUTES when blank", () => {
    assert.equal(budgetMinutesFrom({ SANDCASTLE_BUDGET_MINUTES: "" }), DEFAULT_BUDGET_MINUTES);
  });

  it("parses a positive whole number of minutes", () => {
    assert.equal(budgetMinutesFrom({ SANDCASTLE_BUDGET_MINUTES: "90" }), 90);
  });

  for (const bad of ["0", "-5", "1.5", "abc", "4h"]) {
    it(`throws BudgetError for "${bad}"`, () => {
      assert.throws(() => budgetMinutesFrom({ SANDCASTLE_BUDGET_MINUTES: bad }), BudgetError);
    });
  }

  // Unlike SANDCASTLE_ISSUE and SANDCASTLE_LABEL, the budget is allowed in
  // GitHub Actions too.
  it("accepts the variable when GITHUB_ACTIONS is set", () => {
    assert.equal(budgetMinutesFrom({ GITHUB_ACTIONS: "true", SANDCASTLE_BUDGET_MINUTES: "90" }), 90);
  });
});

// A run that only answers its PRs' reviews and red checks (follow-up) runs beside a full run, which is
// busy building an issue and would answer them only after the build.
describe("runModeFrom", () => {
  it("is a full run when SANDCASTLE_MODE is unset", () => {
    assert.equal(runModeFrom({}), "full");
  });

  it("is a full run when SANDCASTLE_MODE is blank", () => {
    assert.equal(runModeFrom({ SANDCASTLE_MODE: "" }), "full");
    assert.equal(runModeFrom({ SANDCASTLE_MODE: "  " }), "full");
  });

  it("reads full", () => {
    assert.equal(runModeFrom({ SANDCASTLE_MODE: "full" }), "full");
  });

  it("reads follow-up", () => {
    assert.equal(runModeFrom({ SANDCASTLE_MODE: "follow-up" }), "follow-up");
  });

  it("ignores whitespace around the value", () => {
    assert.equal(runModeFrom({ SANDCASTLE_MODE: " follow-up\n" }), "follow-up");
  });

  // A typo must not silently start a full run, which builds issues, when the workflow asked for a follow-up-only one.
  for (const bad of ["followup", "follow_up", "follow-up-only", "builds", "0"]) {
    it(`throws RunModeError for "${bad}", naming the variable and the value`, () => {
      assert.throws(
        () => runModeFrom({ SANDCASTLE_MODE: bad }),
        (error: unknown) => error instanceof RunModeError && /SANDCASTLE_MODE/.test(error.message) && error.message.includes(`"${bad}"`),
      );
    });
  }

  // Unlike SANDCASTLE_ISSUE and SANDCASTLE_LABEL, the mode is how the workflow asks for a follow-up-only run in GitHub Actions.
  it("accepts the variable when GITHUB_ACTIONS is set", () => {
    assert.equal(runModeFrom({ GITHUB_ACTIONS: "true", SANDCASTLE_MODE: "follow-up" }), "follow-up");
  });
});

// The hand-off label (lib/follow-up.mts#sweepSubject): created at startup, never a queue or a managed label.
describe("FOLLOW_UP_LABEL", () => {
  it("is sandcastle:follow-up", () => {
    assert.equal(FOLLOW_UP_LABEL, "sandcastle:follow-up");
  });

  it("is kept out of SANDCASTLE_LABELS, which the host adds and removes itself", () => {
    assert.ok(!SANDCASTLE_LABELS.some((label) => label.name.toLowerCase() === FOLLOW_UP_LABEL));
  });

  it("is created at startup: HOST_LABELS holds it exactly once", () => {
    assert.equal(HOST_LABELS.filter((label) => label.name === FOLLOW_UP_LABEL).length, 1);
  });

  it("is created beside the managed labels and the local queue's label, which HOST_LABELS still holds", () => {
    const names = HOST_LABELS.map((label) => label.name);

    for (const label of [...SANDCASTLE_LABELS, LOCAL_QUEUE_LABEL_DEFINITION]) assert.ok(names.includes(label.name), label.name);
    assert.ok(names.includes(LOCAL_QUEUE_LABEL));
  });

  it("is defined with a description GitHub accepts (at most 100 characters) and a six-digit colour", () => {
    assert.equal(FOLLOW_UP_LABEL_DEFINITION.name, FOLLOW_UP_LABEL);
    assert.ok(FOLLOW_UP_LABEL_DEFINITION.description.length > 0);
    assert.ok(FOLLOW_UP_LABEL_DEFINITION.description.length <= 100);
    assert.match(FOLLOW_UP_LABEL_DEFINITION.color, /^[0-9A-Fa-f]{6}$/);
  });
});

// Only the run GitHub Actions starts follows hand-off pull requests.
describe("isDefaultQueueScope", () => {
  for (const label of [QUEUE_LABEL, "sandcastle", "SANDCASTLE"]) {
    it(`is true for the label scope "${label}", compared as GitHub compares labels`, () => {
      assert.equal(isDefaultQueueScope({ kind: "label", label }), true);
    });
  }

  for (const label of [LOCAL_QUEUE_LABEL, "Sandcastle:dev", "Sandcastle "]) {
    it(`is false for the label scope "${label}"`, () => {
      assert.equal(isDefaultQueueScope({ kind: "label", label }), false);
    });
  }

  it("is false for an issue scope", () => {
    assert.equal(isDefaultQueueScope({ kind: "issue", number: 146 }), false);
  });

  it("is true for the scope queueScopeFrom gives in GitHub Actions, and false for a local one", () => {
    assert.equal(isDefaultQueueScope(queueScopeFrom({ GITHUB_ACTIONS: "true" })), true);
    assert.equal(isDefaultQueueScope(queueScopeFrom({ SANDCASTLE_ISSUE: "5" })), false);
    assert.equal(isDefaultQueueScope(queueScopeFrom({ SANDCASTLE_LABEL: "Sandcastle:dev" })), false);
  });
});

// A Claude Code session posts under the owner's token, so this is how its replies are told from the owner's.
describe("SESSION_REPLY_MARKER", () => {
  it("is the marker docs/PROCESS.md tells a Claude Code session to end every reply with", () => {
    assert.equal(SESSION_REPLY_MARKER, "<!-- claude-session -->");
  });
});

describe("the PR watcher", () => {
  // scripts/watch-pr.sh skips a PR comment that starts with a Sandcastle marker, because Sandcastle posts under the owner's token.
  // Every marker config.mts exports must be one it skips, so a new marker is covered with no edit here.
  const watcher = fileURLToPath(new URL("../../scripts/watch-pr.sh", import.meta.url));
  const hasJq = spawnSync("jq", ["--version"]).status === 0;
  const skip = hasJq ? false : "jq is not installed";

  // Whether the watcher skips a comment with this body: exit 0 when it does, 1 when it wouldn't.
  const wouldSkip = (body: string): number | null =>
    spawnSync("bash", [watcher, "--would-skip"], { input: body, encoding: "utf8" }).status;

  const sandcastleMarkers = Object.entries(config as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].startsWith("<!-- sandcastle:"),
  );

  // A comment as Sandcastle posts it: the marker whole when it closes itself, else (the prefix markers) with the data it carries.
  const samples = (marker: string): string[] =>
    marker.endsWith("-->")
      ? [marker, `${marker}\nThe rest of the comment.`]
      : [`${marker} ${"a".repeat(40)} -->`, `${marker} issue#12 -->`, `${marker} ${"a".repeat(40)} -->\nThe rest of the comment.`];

  it("finds the markers it is meant to check, so an emptied scan can't pass", () => {
    const names = sandcastleMarkers.map(([name]) => name);

    for (const name of [
      "PR_MARKER",
      "DESIGN_MARKER",
      "FOLLOW_UP_MARKER",
      "FOLLOW_UP_REPLY_MARKER",
      "APPROVED_HEAD_MARKER",
      "OVERLAP_MARKER",
      "BUILD_FAILED_MARKER",
      "UMBRELLA_MARKER",
      "GIVE_UP_MARKER",
      "WORKTREE_TAMPERED_MARKER",
    ]) {
      assert.ok(names.includes(name), `${name} is exported by config.mts and starts <!-- sandcastle:`);
    }
  });

  it("defines the give-up and worktree-tampered markers in the form the watcher matches", () => {
    assert.equal(config.GIVE_UP_MARKER, "<!-- sandcastle:give-up -->");
    assert.equal(config.WORKTREE_TAMPERED_MARKER, "<!-- sandcastle:worktree-tampered -->");
  });

  for (const [name, marker] of sandcastleMarkers) {
    it(`skips a comment that starts with ${name}`, { skip }, () => {
      for (const body of samples(marker)) {
        assert.equal(wouldSkip(body), 0, `a comment starting ${JSON.stringify(body.slice(0, 80))} is skipped`);
      }
    });
  }

  it("skips a comment with the session's marker in the middle of its body", { skip }, () => {
    assert.equal(wouldSkip(`Fixed in abc123.\n\n${SESSION_REPLY_MARKER}`), 0);
  });

  it("doesn't skip a person's comment", { skip }, () => {
    assert.equal(wouldSkip("Please fix this"), 1);
  });

  it("doesn't skip a comment that quotes a Sandcastle marker without starting with it", { skip }, () => {
    assert.equal(wouldSkip("> <!-- sandcastle:pr -->\n\nWhy is this here?"), 1);
    assert.equal(wouldSkip("Look at <!-- sandcastle:give-up --> in the log."), 1);
  });
});

// The text of a Markdown file as a reader sees it, for the one check above: a comment that opens a line (as the Seed's does) is dropped up to the
// line holding its "-->", an unclosed one running to the end of the file; a fenced block that holds text is replaced by "X", an unclosed one too,
// since it runs to the end, and an empty one by nothing; and every other complete comment on a line is dropped, wherever it sits, a code span's
// included. What is left, an unclosed "<!--" after other text or inside a code span among it, is text as written, so it never hides the heading
// after it. Read line by line, so a "#" line inside a comment or a fence is never taken for a heading.
function visibleMarkdown(markdown: string): string {
  const out: string[] = [];
  let fence: RegExp | undefined;
  let fenceHasText = false;
  let inComment = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      if (fence.test(line)) {
        // An empty fence shows nothing, so only one with text counts as text.
        if (fenceHasText) out.push("X");
        fence = undefined;
      } else if (line.trim() !== "") {
        fenceHasText = true;
      }
      continue;
    }

    let rest = line;
    if (inComment) {
      const end = rest.indexOf("-->");
      if (end === -1) continue;
      inComment = false;
      // The block ends on the line that holds "-->", so a "<!--" after it on that line opens nothing.
      rest = rest.slice(end + 3);
    } else {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      // A backtick fence's info string holds no backtick, or the line is a code span.
      if (opener && !(opener[1]!.startsWith("`") && opener[2]!.includes("`"))) {
        const marker = opener[1]![0]!;
        fence = new RegExp(`^ {0,3}\\${marker}{${opener[1]!.length},}\\s*$`);
        fenceHasText = false;
        continue;
      }

      const comment = /^ {0,3}<!--/.exec(line);
      if (comment) {
        // The close may overlap the opener, as in "<!-->", a complete comment of its own.
        const end = line.indexOf("-->", comment[0].length - 2);
        if (end === -1) {
          inComment = true;
          rest = "";
        } else {
          rest = line.slice(end + 3);
        }
      }
    }

    // A line that shows only comments shows nothing.
    out.push(rest.replace(/<!--.*?-->/g, ""));
  }

  // A fence still open at the end runs to the end of the file, and what it held is shown.
  if (fence && fenceHasText) out.push("X");

  return out.join("\n");
}
