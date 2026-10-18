import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { execFileSync } from "node:child_process";
import { BUILD_FAILED_MARKER, BUILD_FAILURE_CAP } from "./config.mts";
import { buildFailedComment, handBackWorkflowChange, needsHumanComment, recordFailedAttempt, workflowHandBackComment } from "./handback.mts";
import { HandBackReport, targetUrl } from "./report.mts";

// A gh stub recording every call's args and stdin input.
function recordingGh() {
  const calls: { args: readonly string[]; input: unknown }[] = [];
  const run = ((_cmd: string, args: readonly string[], options: { input?: unknown }) => {
    calls.push({ args, input: options.input });
    return "";
  }) as unknown as typeof execFileSync;
  return { calls, run };
}

describe("buildFailedComment", () => {
  it("carries the marker, the attempt number and the detail", () => {
    const comment = buildFailedComment(1, "feature/69-run-the-gate", "the tester failed: Error: timed out");

    assert.ok(comment.includes(BUILD_FAILED_MARKER));
    assert.match(comment, /attempt 1/);
    assert.match(comment, /the tester failed: Error: timed out/);
    assert.match(comment, /`feature\/69-run-the-gate`/);
  });
});

describe("buildFailedComment within GitHub's comment limit", () => {
  // A rejected comment saves no marker, so the attempt is never counted and
  // the issue never reaches the cap.
  it("trims a detail longer than GitHub's limit, keeping the marker and the end of the output", () => {
    const detail = "```text\n" + Array.from({ length: 3000 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n") + "\nerror: the real failure\n```";

    const comment = buildFailedComment(1, "feature/69-run-the-gate", detail);

    assert.ok(comment.length <= 65_536, `${comment.length} characters`);
    assert.ok(comment.startsWith(BUILD_FAILED_MARKER));
    assert.match(comment, /error: the real failure/);
    assert.match(comment, /trimmed/);
    assert.equal((comment.match(/^```/gm) ?? []).length % 2, 0, "unbalanced fences");
  });
});

describe("needsHumanComment", () => {
  it("quotes every failure, oldest first", () => {
    const comment = needsHumanComment("feature/69-run-the-gate", ["first failure detail", "second failure detail"]);

    const firstIndex = comment.indexOf("first failure detail");
    const secondIndex = comment.indexOf("second failure detail");
    assert.ok(firstIndex >= 0 && secondIndex >= 0);
    assert.ok(firstIndex < secondIndex);
  });
});

describe("needsHumanComment within GitHub's comment limit", () => {
  it("stays under 65,536 characters, keeping each failure's heading and the end of its output", () => {
    const failure = (n: number) => `**Failed build attempt ${n}**\n\n${"x".repeat(60_000)}\nlast line of attempt ${n}`;

    const comment = needsHumanComment("feature/69-run-the-gate", [failure(1), failure(2)]);

    assert.ok(comment.length <= 65_536, `${comment.length} characters`);
    for (const n of [1, 2]) {
      assert.ok(comment.includes(`### Attempt ${n}`));
      assert.ok(comment.includes(`last line of attempt ${n}`));
    }
    assert.match(comment, /trimmed/);
  });

  it("reopens a code fence whose opening line was trimmed away", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `gate output line ${i} ${"y".repeat(20)}`).join("\n");
    const failure = `**Failed build attempt 1**\n\n\`\`\`text\n${lines}\n\`\`\``;

    const comment = needsHumanComment("feature/69-run-the-gate", [failure, failure]);

    for (const section of comment.split("### Attempt ").slice(1)) {
      assert.equal((section.match(/^> \`\`\`/gm) ?? []).length % 2, 0, "unbalanced fences");
    }
  });

  // The summary goes on before the label edit. If that edit fails, the issue
  // stays in the queue, and its next failure must count the earlier attempts,
  // not the summary, so it hands the issue back again rather than at attempt 3.
  it("carries no failed-attempt marker, so a summary is never counted as an attempt", () => {
    const comment = needsHumanComment("feature/69-run-the-gate", [buildFailedComment(1, "feature/69-run-the-gate", "detail")]);

    assert.equal(comment.includes(BUILD_FAILED_MARKER), false);
  });

  it("quotes short failures in full", () => {
    const comment = needsHumanComment("feature/69-run-the-gate", ["first failure detail", "second failure detail"]);

    assert.doesNotMatch(comment, /trimmed/);
  });
});

describe("recordFailedAttempt", () => {
  it("posts the marker comment for the first failed attempt and leaves the issue in the queue", () => {
    const { calls, run } = recordingGh();
    const report = new HandBackReport();

    recordFailedAttempt(69, "feature/69-run-the-gate", "the tester failed: Error: timed out", [], run, "o/r", report);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ["issue", "comment", "69", "--repo", "o/r", "--body-file", "-"]);
    const body = calls[0]!.input as string;
    assert.ok(body.includes(BUILD_FAILED_MARKER));
    assert.match(body, /attempt 1/);
    assert.match(body, /the tester failed: Error: timed out/);
    assert.deepEqual(report.items(), []);
  });

  it(`hands the issue back on the ${BUILD_FAILURE_CAP}nd failed attempt since sandcastle:needs-human was last removed`, () => {
    const { calls, run } = recordingGh();
    const report = new HandBackReport();
    const firstFailure = buildFailedComment(1, "feature/69-run-the-gate", "the tester failed: Error: timed out");

    recordFailedAttempt(69, "feature/69-run-the-gate", "the gate is still red at checkpoint 1", [firstFailure], run, "o/r", report);

    const edits = calls.filter((call) => call.args[1] === "edit");
    const comments = calls.filter((call) => call.args[1] === "comment");
    assert.deepEqual(edits[0]!.args, [
      "issue", "edit", "69", "--repo", "o/r", "--add-label", "sandcastle:needs-human", "--remove-label", "sandcastle:ready",
    ]);
    assert.equal(comments.length, 1);
    const summary = comments[0]!.input as string;
    assert.match(summary, /the tester failed: Error: timed out/);
    assert.match(summary, /the gate is still red at checkpoint 1/);
    // The attempt that hands the issue back isn't "still in the queue".
    const lastAttempt = summary.slice(summary.indexOf(`### Attempt ${BUILD_FAILURE_CAP}`));
    assert.match(lastAttempt, /Failed build attempt 2 of 2/);
    assert.doesNotMatch(lastAttempt, /stays in the queue/);
    assert.equal(report.items().length, 1);
    assert.equal(report.items()[0]!.kind, "issue");
    assert.equal(report.items()[0]!.number, 69);
    assert.equal(report.items()[0]!.label, "sandcastle:needs-human");
    assert.match(report.items()[0]!.reason, /feature\/69-run-the-gate/);
    assert.equal(report.items()[0]!.url, targetUrl("o/r", { kind: "issue", number: 69 }));
  });
});

// #147: a push GitHub rejected because it touches .github/workflows/**
// without Workflows permission must hand the issue back, not be treated as a
// failed build attempt.
describe("workflowHandBackComment", () => {
  const change = { head: "abc1234def5678abc1234def5678abc1234def56", files: [".github/workflows/ci.yml", ".github/workflows/release.yml"] };
  const detail =
    "! [remote rejected] abc -> feature/69-run-the-gate (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)";

  it("names the branch, each workflow file and the head commit, says a person must make the change, and fences the detail", () => {
    const comment = workflowHandBackComment("feature/69-run-the-gate", detail, change);

    assert.match(comment, /`feature\/69-run-the-gate`/);
    assert.match(comment, /`\.github\/workflows\/ci\.yml`/);
    assert.match(comment, /`\.github\/workflows\/release\.yml`/);
    assert.match(comment, /abc1234def5678abc1234def5678abc1234def56/);
    assert.match(comment, /a person/i);
    assert.match(comment, /```\n[\s\S]*refusing to allow[\s\S]*\n```/);
  });

  // GitHub refused the push, so origin's branch doesn't hold the commits: the
  // comment mustn't send a person to edit a branch that lacks them.
  it("says GitHub doesn't have the commits, rather than that the branch keeps them or asking to edit it", () => {
    const comment = workflowHandBackComment("feature/69-run-the-gate", detail, change);

    assert.match(comment, /GitHub doesn't have/);
    assert.doesNotMatch(comment, /keeps its commits/);
    assert.doesNotMatch(comment, /drop it from/);
    assert.match(comment, /once it has merged, remove `sandcastle:needs-human`/);
  });

  // The names come from the sandboxed agent's commits, and the comment is
  // public: a backtick in a name mustn't end its code span and let the rest
  // render as Markdown, a link or an @mention.
  it("keeps a file name with backticks inside its code span", () => {
    const hostile = ".github/workflows/x` @org/team [link](https://example.com) `.yml";
    const comment = workflowHandBackComment("feature/69-run-the-gate", detail, { head: change.head, files: [hostile] });

    assert.ok(comment.includes(`\`\` ${hostile} \`\``), comment);
  });

  it("puts a file name with a newline on one line", () => {
    const comment = workflowHandBackComment("feature/69-run-the-gate", detail, {
      head: change.head,
      files: [".github/workflows/a\n@org/team.yml"],
    });

    assert.ok(comment.includes("`.github/workflows/a @org/team.yml`"), comment);
  });

  it("still reads when the workflow files couldn't be listed", () => {
    const comment = workflowHandBackComment("feature/69-run-the-gate", detail, { head: change.head, files: [] });

    assert.match(comment, /a file under `\.github\/workflows\/`/);
  });

  it("carries no BUILD_FAILED_MARKER, since this isn't a failed attempt", () => {
    const comment = workflowHandBackComment("feature/69-run-the-gate", "refusing to allow", change);

    assert.equal(comment.includes(BUILD_FAILED_MARKER), false);
  });
});

describe("handBackWorkflowChange", () => {
  it("comments on the issue, hands it back with sandcastle:needs-human, and records the hand-back", () => {
    const { calls, run } = recordingGh();
    const report = new HandBackReport();

    handBackWorkflowChange(
      69,
      "feature/69-run-the-gate",
      "refusing to allow a GitHub App to create or update workflow without `workflows` permission",
      { head: "a".repeat(40), files: [".github/workflows/ci.yml"] },
      run,
      "o/r",
      report,
    );

    const comments = calls.filter((call) => call.args[1] === "comment");
    const edits = calls.filter((call) => call.args[1] === "edit");
    assert.equal(comments.length, 1);
    assert.deepEqual(edits[0]!.args, [
      "issue", "edit", "69", "--repo", "o/r", "--add-label", "sandcastle:needs-human", "--remove-label", "sandcastle:ready",
    ]);
    assert.equal(report.items().length, 1);
    assert.equal(report.items()[0]!.kind, "issue");
    assert.equal(report.items()[0]!.number, 69);
    assert.equal(report.items()[0]!.label, "sandcastle:needs-human");
    assert.match(report.items()[0]!.reason, /\.github\/workflows/);
    assert.equal(report.items()[0]!.url, targetUrl("o/r", { kind: "issue", number: 69 }));
  });
});
