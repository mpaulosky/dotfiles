import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allowlistedView,
  BuildLogs,
  buildLogs,
  copyReviewerLogs,
  REVIEWER_LOG_INDEX,
  reviewerLogFileName,
  reviewerLogsDir,
  REVIEWER_LOGS_NAME,
  REPORT_LOG_LIMIT,
  REPORT_INPUT_LIMIT,
  REPORT_TOKEN_RUN,
  liveRoleLogFs,
  readLogTail,
  type RoleLogFs,
} from "./role-logs.mts";

function fakeFs(files: Record<string, string>, failOn?: string) {
  const written: Record<string, string> = {};
  const made: string[] = [];
  const cleared: string[] = [];
  const fs: RoleLogFs = {
    clear: (path) => void cleared.push(path),
    list: () => Object.keys(files),
    read: (path) => {
      if (failOn !== undefined && path.endsWith(failOn)) throw new Error("EACCES");
      return files[path.split(/[\\/]/).at(-1)!]!;
    },
    mkdir: (path) => void made.push(path),
    write: (path, text) => void (written[path] = text),
  };
  return { fs, written, made, cleared };
}

const none = () => undefined;
const copy = (text: string, secrets: readonly string[] = []) => {
  const { fs, written } = fakeFs({ "a-reviewer.log": text });
  copyTo("logs", fs, none, secrets);
  return written["logs/report/reviewer-1.log"]!;
};

const hostLines = [
  "--- Run started: 2026-11-03T10:00:00.123Z ---",
  "Iteration 1/3",
  "Setting up sandbox",
  "Setting up sandbox done (1.5s)",
  "Agent started",
  "Context window: 42k",
  "Agent stopped",
  "Collecting commits",
  "Collecting commits done (0.2s)",
  "Capturing session",
  "Expanding shell expressions done (0.1s)",
  "No commits to sync out",
  "Syncing 2 commits to host done (3.0s)",
  "Agent signaled completion after 2 iteration(s).",
  "Reached max iterations (3).",
  "Run complete: agent finished after 2 iteration(s).",
  "Run complete: reached 3 iteration(s) without completion signal.",
];

// A record of builds that wrote every `*-reviewer.log` in `names`, issue numbers in sorted order from 1: only a log of a build the run started is copied.
const knowing = (names: readonly string[]) => {
  const builds = new BuildLogs();
  names.filter((name) => name.endsWith("-reviewer.log")).sort().forEach((name, i) => builds.add(i + 1, name.replace(/-reviewer\.log$/, "")));
  return builds;
};

// The files a folder lists, or none when it can't be listed (copyReviewerLogs says that itself).
const listed = (logsDir: string, fs?: RoleLogFs) => {
  try {
    return (fs ?? liveRoleLogFs).list(logsDir);
  } catch {
    return [];
  }
};

// copyReviewerLogs with the views going to <logsDir>/report, as most tests below read them from there. Every log the folder lists is a build's.
const copyTo = (logsDir: string, fs?: RoleLogFs, warn?: (line: string) => void, secrets?: readonly string[], builds?: BuildLogs) =>
  copyReviewerLogs(logsDir, join(logsDir, "report"), fs, warn, secrets, builds ?? knowing(listed(logsDir, fs)));

describe("allowlistedView", () => {
  it("keeps every host status line with its numbers masked, and the start line without its timestamp", () => {
    const kept = hostLines.map((line) => (line.startsWith("--- Run started") ? "--- Run started ---" : line.replace(/\d+/g, "#")));
    assert.ok(kept.some((line) => line.includes("#")) && kept.every((line) => !/\d/.test(line)));
    assert.equal(allowlistedView(hostLines.join("\n")), `${[...new Set(kept)].sort().join("\n")}\n`);
  });

  it("is a set, not a sequence: order, count and gaps change nothing, so they carry nothing", () => {
    const a = allowlistedView("Agent started\nBash(1)\nfatal x\nAgent stopped\nRead(2)\npanic y");
    assert.equal(a, "Agent started\nAgent stopped\nBash(...)\nRead(...)\n[error line: fatal]\n[error line: panic]\n");
    // Reordered, repeated, interleaved with blank lines, with CRLF: the same view.
    assert.equal(allowlistedView("panic y\r\nRead(2)\r\n\r\nAgent stopped\nfatal x\nBash(9)\nAgent started\nAgent started\nBash(1)\nBash(1)\npanic y"), a);
    // A thousand lines of each kind are still one line of each.
    const many = Array.from({ length: 1000 }, (_, i) => ["Agent started", `Bash(${i})`, `fatal ${i}`, "Agent stopped"][i % 4]!).join("\n");
    assert.equal(allowlistedView(many), "Agent started\nAgent stopped\nBash(...)\n[error line: fatal]\n");
    // A line of prose between two host lines does not show where it sat: only that something was left out.
    assert.equal(allowlistedView("Agent started\nprose\nAgent stopped"), "[... lines left out]\nAgent started\nAgent stopped\n");
    assert.equal(allowlistedView("Agent started\n\n\nAgent stopped\n"), "Agent started\nAgent stopped\n");
  });

  it("shows one line for each fixed host line, tool and error word, however often each appears: 30 host kinds, 15 tools, 26 error words", () => {
    const masked = [...new Set(hostLines.map((line) => (line.startsWith("--- Run started") ? "--- Run started ---" : line.replace(/\d+/g, "#"))))].sort();
    assert.equal(allowlistedView(hostLines.concat(hostLines).join("\n")), `${masked.join("\n")}\n`);
    const tools = ["Bash", "Read", "Grep", "Glob", "Edit", "MultiEdit", "Write", "NotebookEdit", "Task", "Agent", "TodoWrite", "WebFetch", "WebSearch", "Skill"];
    const toolLines = [...tools.map((name) => `${name}(x)`), "mcp__a__b(x)", "mcp__c__d(y)"];
    const toolView = allowlistedView(toolLines.concat(toolLines).join("\n"));
    assert.equal(toolView, `${[...tools.map((name) => `${name}(...)`), "mcp__(...)"].sort().join("\n")}\n`);
    assert.equal(toolView.split("\n").filter(Boolean).length, 15);
    const words = ["abort", "aborted", "error", "errors", "fail", "failed", "failure", "failures", "exception", "fatal", "panic", "timed out", "timeout", "killed",
      "terminated", "exit code", "exited code", "exit with", "exited with", "signal", "crash", "crashed", "unauthorized", "unauthorised", "rate limit", "overloaded"];
    const errorView = allowlistedView(words.concat(words).map((word) => `x ${word} y`).join("\n"));
    assert.equal(errorView, `${words.map((word) => `[error line: ${word}]`).sort().join("\n")}\n`);
  });

  it("has 30 host kinds once numbers are masked, and shows each once", () => {
    const phrases = ["Setting up sandbox", "Collecting commits", "Capturing session", "Expanding shell expressions", "No commits to sync out", "Syncing 2 commits to host", "Syncing 1 commit to host"];
    const forms = phrases.flatMap((phrase) => [phrase, `${phrase} done (1s)`, `${phrase} done (1.5s)`]);
    const others = [
      "--- Run started: 2026-11-03T10:00:00.123Z ---", "Iteration 1/3", "Agent started", "Agent stopped", "Agent signaled completion after 2 iteration(s).",
      "Context window: 42k", "Reached max iterations (3).", "Run complete: agent finished after 2 iteration(s).", "Run complete: reached 3 iteration(s) without completion signal.",
    ];
    const lines = [...forms, ...others];
    const masked = [...new Set(lines.map((line) => (line.startsWith("--- Run started") ? "--- Run started ---" : line.replace(/\d+/g, "#"))))];
    assert.equal(masked.length, 30);
    const view = allowlistedView(lines.join("\n"));
    assert.equal(view, `${[...masked].sort().join("\n")}\n`);
  });

  it("asks the caller's check only about an error line that holds no run of token characters, once for each", () => {
    const asked: string[] = [];
    const held = (line: string) => (asked.push(line), false);
    allowlistedView(["prose", "Agent started", "Bash(x)", "fatal one", `fatal ${"A".repeat(REPORT_TOKEN_RUN)}`, "panic two", ""].join("\n"), held);
    assert.deepEqual(asked, ["fatal one", "panic two"]);
  });

  it("limits every number in a host line to three digits (two after a decimal point), and needs one", () => {
    const templates = [
      "Iteration {n}/1", "Iteration 1/{n}", "Syncing {n} commits to host", "Syncing {n} commit to host done (1s)", "Setting up sandbox done ({n}s)",
      "Setting up sandbox done (1.{n}s)", "Agent signaled completion after {n} iteration(s).", "Context window: {n}k", "Reached max iterations ({n}).",
      "Run complete: agent finished after {n} iteration(s).", "Run complete: reached {n} iteration(s) without completion signal.",
    ];
    for (const template of templates) {
      const limit = template.includes("1.{n}") ? 2 : 3;
      const line = (digits: number) => template.replace("{n}", "7".repeat(digits));
      // `held` rejects every error line, so only a host line can be kept (one worded with an error word, as one is, would be kept as an error otherwise).
      const view = (text: string) => allowlistedView(text, () => true);
      assert.equal(view(line(limit)), `${line(limit).replace(/\d+/g, "#")}\n`, line(limit));
      assert.equal(view(line(limit + 1)), "[... lines left out]\n", line(limit + 1));
      assert.equal(view(line(0)), "[... lines left out]\n", line(0));
    }
  });

  it("keeps a run-start line without its timestamp, and only a timestamp of the exact shape", () => {
    assert.equal(allowlistedView("--- Run started: 2026-10-19T01:38:45.498Z ---"), "--- Run started ---\n");
    const shape = ["2026", "10", "19", "01", "38", "45", "498"];
    const bads = shape.flatMap((part, i) => [part.slice(1), `${part}0`].map((changed) => shape.map((p, j) => (j === i ? changed : p))));
    const stamp = ([y, mo, d, h, mi, sec, ms]: string[]) => `--- Run started: ${y}-${mo}-${d}T${h}:${mi}:${sec}.${ms}Z ---`;
    for (const bad of [
      ...bads.map(stamp),
      stamp(shape).replace("T", " "), stamp(shape).replace("Z", ""), "--- Run started: 104117110116 ---", "--- Run started:  ---",
    ]) {
      assert.equal(allowlistedView(bad), "[... lines left out]\n", bad);
    }
  });

  it("keeps a known tool's name and drops its arguments, also over several lines", () => {
    const view = allowlistedView('Bash(cat > f <<\'EOF\'\nthe hidden body\nEOF\n)\nRead(/etc/passwd)');
    assert.equal(view, "[... lines left out]\nBash(...)\nRead(...)\n");
    assert.ok(!/hidden|passwd|cat > f/.test(view));
  });

  it("keeps each tool a role is given by name", () => {
    for (const name of ["Bash", "Read", "Grep", "Glob", "Edit", "MultiEdit", "Write", "NotebookEdit", "Task", "Agent", "TodoWrite", "WebFetch", "WebSearch", "Skill"]) {
      assert.equal(allowlistedView(`${name}(x)`), `${name}(...)\n`, name);
    }
  });

  it("keeps an MCP tool only as mcp__(...), with no part of its name, within the name bounds", () => {
    const mcp = (server: string, tool: string) => allowlistedView(`mcp__${server}__${tool}(a=1)`);
    assert.equal(mcp("x", "y"), "mcp__(...)\n");
    assert.equal(mcp("a".repeat(30), "b"), "mcp__(...)\n");
    assert.equal(mcp("a".repeat(31), "b"), "[... lines left out]\n");
    assert.equal(mcp("a", "b".repeat(40)), "mcp__(...)\n");
    assert.equal(mcp("a".repeat(30), "b".repeat(40)), "mcp__(...)\n");
    assert.equal(mcp("a", "b".repeat(41)), "[... lines left out]\n");
    assert.equal(mcp("", "b"), "[... lines left out]\n");
    assert.equal(mcp("a", ""), "[... lines left out]\n");
    assert.equal(mcp("a_b", "c"), "[... lines left out]\n");
    assert.equal(mcp("a-b", "create_issue"), "mcp__(...)\n");
    assert.equal(mcp("a", "c-d"), "mcp__(...)\n");
    assert.equal(mcp("a.b", "c"), "[... lines left out]\n");
    assert.equal(mcp("a", "c.d"), "[... lines left out]\n");
    assert.ok(!mcp("aHVudGVy", "bnRlcjI").includes("aHVudGVy"));
  });

  it("drops a line that only looks like a tool call: another name, a code line, an encoded chunk", () => {
    const lookalikes = [
      "open(p).read()", "aHVudGVyMmh1bnRlcjI(", "Bash2(x)", "Bash.x(x)", "Read:x(x)", "bash(x)", "Bashful(x)", "mcp__a(x)",
      "aGVsbG8gd29ybGQ=(", "9Bash(x)", "Not a tool (x)", `Read${"x".repeat(56)}(x)`, "x".repeat(61) + "(x)", "x".repeat(62) + "(x)",
    ];
    for (const line of lookalikes) assert.equal(allowlistedView(line), "[... lines left out]\n", line);
  });

  it("drops model prose and marks that lines were left out, once, first and without a count, blank lines being none", () => {
    const view = allowlistedView("Agent started\nsome prose\nmore prose\n\nAgent stopped\nlast words");
    assert.equal(view, "[... lines left out]\nAgent started\nAgent stopped\n");
  });

  it("matches a host line whole: a prefix, a suffix, a malformed number or timestamp doesn't pass", () => {
    const near = [
      "I wrote: Agent started", "xAgent stopped", "Agent started and then I printed my secret", "Iteration 1/3x", "Iteration 1/3 plus words",
      "Context window: 42kb", "Syncing 2 commits to host done (3.0s) extra", "Run complete: whatever", "Iteration 1234567/3",
      "--- Run started: 2026-11-03 10:00 ---", "Setting up sandbox done (x.5s)", "Reached max iterations (3)",
    ];
    for (const line of near) assert.equal(allowlistedView(line), "[... lines left out]\n", line);
  });

  it("keeps the singular sync line, whole-second durations and every other host form", () => {
    const forms = ["Syncing 1 commit to host", "Setting up sandbox done (3s)", "Reached max iterations (10).", "Capturing session", "Expanding shell expressions", "Iteration 123/123"];
    for (const line of forms) assert.equal(allowlistedView(line), `${line.replace(/\d+/g, "#")}\n`, line);
  });

  it("masks the numbers of a host line, so a forged line carries no digits out", () => {
    // 40 forged lines whose digits spell a token would, unmasked, carry it out; masked they are the same line.
    const forged = Array.from({ length: 40 }, (_, i) => `Iteration ${100 + i}/${200 + i}`);
    assert.equal(allowlistedView(forged.join("\n")), "Iteration #/#\n");
    assert.equal(allowlistedView("Iteration 1/3\nIteration 2/3"), allowlistedView("Iteration 9/9\nIteration 8/8"));
    assert.equal(allowlistedView("Context window: 42k"), "Context window: #k\n");
    assert.equal(allowlistedView("Setting up sandbox done (1.5s)"), "Setting up sandbox done (#.#s)\n");
  });

  it("keeps a fixed message for each word that names an error, and only as a word", () => {
    const words = [
      "abort", "aborted", "error", "errors", "fail", "failed", "failure", "failures", "exception", "fatal", "panic", "timed out", "timeout",
      "killed", "terminated", "exit code", "exited code", "exit with", "exited with", "signal", "crash", "crashed", "unauthorized", "unauthorised", "rate limit", "overloaded",
    ];
    assert.equal(words.length, 26);
    for (const word of words) assert.equal(allowlistedView(`it ${word} 1 now`), `[error line: ${word}]\n`, word);
    for (const near of ["panicky", "fatally", "terrorism", "errorless", "exit codes", "unauthorizeds"]) {
      assert.equal(allowlistedView(`it ${near} now`), "[... lines left out]\n", near);
    }
    assert.equal(allowlistedView("An ERROR happened"), "[error line: error]\n");
  });

  it("keeps an error line as a message, not the prose around it, and the host lines and tool names near it", () => {
    const view = allowlistedView("prose a\nBash(secret)\nthe claude-code process aborted\nAgent stopped\nprose b\n");
    assert.equal(view, "[... lines left out]\nAgent stopped\nBash(...)\n[error line: aborted]\n");
  });

  it("publishes no text of an error line, however long, with any characters", () => {
    const emoji = String.fromCodePoint(0x1f600);
    for (const line of [`error ${" x".repeat(500)}`, `error ${emoji}${emoji} tail`, "error \uD83D lone", "fatal: the key is hunter2 ok"]) {
      assert.match(allowlistedView(line), /^\[error line: [a-z ]+\]\n$/, line);
    }
  });

  it("does not publish a secret an error line spaced out with invisible fillers or as hex chunks", () => {
    const secret = "s3cr3tValueForTesting12345678";
    const fillers = ["\u3164", "\u2800", "\u115F", "\u200B"];
    const hex = Buffer.from(secret).toString("hex").match(/.{1,4}/g)!.join(" ");
    const spaced = [...fillers.map((filler) => `error ${secret.split("").join(filler)}`), `error ${hex}`];
    for (const line of spaced) {
      assert.equal(allowlistedView(line, (candidate) => candidate.includes(secret)), "[error line: error]\n", line);
      // copy() also holds a line whose characters, once format characters are taken out, spell the secret: only U+200B (a format character) is.
      assert.equal(copy(line, [secret]), line.includes("\u200B") ? "[... lines left out]\n" : "[error line: error]\n", line);
    }
    // Plain, the secret is held; its run of token characters would leave the line out anyway.
    assert.equal(allowlistedView(`error ${secret}`, (candidate) => candidate.includes(secret)), "[... lines left out]\n");
  });

  it("keeps a message only for an ASCII error word: a look-alike character never spells one", () => {
    // U+017F (long s) and U+212A (Kelvin sign) fold to s and k under a Unicode case-insensitive match, which errorLine must never use.
    for (const line of ["\u017Fignal lost", "\u212Ailled", "err\u200Bor", "exit\u00A0code 1", "exit  code 1"]) {
      assert.equal(allowlistedView(line), "[... lines left out]\n", line);
    }
    assert.equal(allowlistedView("\u017Fignal \u212Ailled and a real ERROR"), "[error line: error]\n");
    assert.equal(allowlistedView("exit code 1"), "[error line: exit code]\n");
    assert.equal(allowlistedView("fatal\u0131"), "[error line: fatal]\n");
    assert.doesNotMatch(allowlistedView("\u017Fignal \u212Ailled and a real ERROR"), /[^\x00-\x7f]/);
  });

  it("replaces a view that holds a secret value with a note, even a value that is only a fixed message or host line", () => {
    const note = "Left out: the view held something shaped like a secret.\n";
    assert.equal(copy("Agent stopped", ["Agent stopped"]), note);
    assert.equal(copy("Bash(x)", ["Bash(...)"]), note);
    assert.equal(copy("fatal", ["error line: fatal"]), note);
    assert.equal(copy("Agent stopped", ["Agent stopped!"]), "Agent stopped\n");
  });

  it("leaves out an error line with a run of token characters, at n-1, n and n+1", () => {
    assert.equal(REPORT_TOKEN_RUN, 24);
    const withRun = (length: number) => `error ${"A".repeat(length)}`;
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN - 1)), "[error line: error]\n");
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN)), "[... lines left out]\n");
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN + 1)), "[... lines left out]\n");
    for (const ch of ["+", "/", "_", "=", "-", "9", "z"]) assert.equal(allowlistedView(`error ${ch.repeat(REPORT_TOKEN_RUN)}`), "[... lines left out]\n", ch);
  });

  it("leaves out an error line the caller's check holds", () => {
    const secret = `error ${"x ".repeat(98)}hunter2`;
    assert.equal(allowlistedView(secret, (line) => line.includes("hunter2")), "[... lines left out]\n");
    assert.equal(allowlistedView(secret), "[error line: error]\n");
  });

  it("keeps a first-line-only error log, and reads CRLF lines", () => {
    assert.equal(allowlistedView("aborted"), "[error line: aborted]\n");
    assert.equal(allowlistedView("Agent started\r\nAgent stopped\r\n"), "Agent started\nAgent stopped\n");
  });
});

describe("copyReviewerLogs", () => {
  it("copies only the reviewer logs, as their view, into the report folder", () => {
    const { fs, written } = fakeFs({ "a-reviewer.log": "aborted", "a-backend.log": "other" });
    assert.deepEqual(copyTo("logs", fs, none, []), ["reviewer-1.log"]);
    assert.deepEqual(written, { "logs/report/reviewer-1.log": "[error line: aborted]\n", "logs/report/index.txt": "reviewer-1.log: issue #1\n" });
  });

  it("never copies the review lead's log (issue 399), which lists the subagents' answers", () => {
    const { fs, written } = fakeFs({ "a-pre-push-review-lead.log": "aborted", "b-reviewer.log": "aborted" });
    assert.deepEqual(copyTo("logs", fs, none, []), ["reviewer-1.log"]);
    assert.deepEqual(Object.keys(written), ["logs/report/reviewer-1.log", "logs/report/index.txt"]);
  });

  it("never copies the pre-push review's log", () => {
    const { fs, written } = fakeFs({ "a-pre-push-reviewer.log": "aborted", "b-reviewer.log": "aborted" });
    assert.deepEqual(copyTo("logs", fs, none, []), ["reviewer-1.log"]);
    assert.deepEqual(Object.keys(written), ["logs/report/reviewer-1.log", "logs/report/index.txt"]);
  });

  it("puts the views in a subfolder of the report folder, so emptying it leaves the report alone", () => {
    assert.equal(REVIEWER_LOGS_NAME, "reviewer-logs");
    assert.equal(reviewerLogsDir(join("runner", "sandcastle-report")), join("runner", "sandcastle-report", "reviewer-logs"));
  });

  it("writes the views to the folder it is given and nothing under the logs folder, which sandboxes mount", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-logs-default-"));
    const out = mkdtempSync(join(tmpdir(), "role-logs-out-"));
    try {
      writeFileSync(join(dir, "ok-reviewer.log"), "the reviewer aborted\n");
      // A file left in the output folder is removed, and a file in the checkout's own report folder stays where it is, untouched.
      writeFileSync(join(out, "old-reviewer.log"), "left over\n");
      mkdirSync(join(dir, "report"));
      writeFileSync(join(dir, "report", "planted-reviewer.log"), "planted\n");
      assert.deepEqual(copyReviewerLogs(dir, out, undefined, () => undefined, [], knowing(["ok-reviewer.log"])), ["reviewer-1.log"]);
      assert.deepEqual(readdirSync(out).sort(), ["index.txt", "reviewer-1.log"]);
      assert.deepEqual(readdirSync(join(dir, "report")), ["planted-reviewer.log"], "the checkout's report folder was touched");
      assert.deepEqual(readdirSync(dir).sort(), ["ok-reviewer.log", "report"], "something was written under the logs folder");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("empties the output folder first, also when there is no reviewer log, so nothing an earlier run left is uploaded", () => {
    const { fs, cleared } = fakeFs({ "a-reviewer.log": "aborted" });
    copyTo("logs", fs, none, []);
    assert.deepEqual(cleared, ["logs/report"]);
    const none2 = fakeFs({ "a-backend.log": "other" });
    copyTo("logs", none2.fs, none, []);
    assert.deepEqual(none2.cleared, ["logs/report"]);
  });

  it("writes nothing and warns when the output folder can't be emptied", () => {
    const warnings: string[] = [];
    const { fs, written } = fakeFs({ "a-reviewer.log": "aborted" });
    const stuck: RoleLogFs = { ...fs, clear: () => { throw new Error("EBUSY"); } };
    assert.deepEqual(copyTo("logs", stuck, (line) => warnings.push(line), []), []);
    assert.deepEqual(written, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not be emptied/);
  });

  it("removes a file left in the output folder, and an output folder that is a symlink, keeping only the fresh views", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-logs-planted-"));
    try {
      mkdirSync(join(dir, "report"));
      writeFileSync(join(dir, "report", "planted-reviewer.log"), "sk-ant-planted\n");
      writeFileSync(join(dir, "ok-reviewer.log"), "the reviewer aborted\n");
      assert.deepEqual(copyTo(dir, undefined, () => undefined, []), ["reviewer-1.log"]);
      assert.ok(!existsSync(join(dir, "report", "planted-reviewer.log")), "a planted log survived");
      assert.equal(readFileSync(join(dir, "report", "reviewer-1.log"), "utf8"), "[error line: aborted]\n");
      // With no reviewer log at all, a planted file is still removed.
      rmSync(join(dir, "ok-reviewer.log"));
      writeFileSync(join(dir, "report", "planted-reviewer.log"), "planted\n");
      assert.deepEqual(copyTo(dir, undefined, () => undefined, []), []);
      assert.ok(!existsSync(join(dir, "report", "planted-reviewer.log")));
      // A report folder that is a link to somewhere else is unlinked, not followed.
      const elsewhere = mkdtempSync(join(tmpdir(), "role-logs-elsewhere-"));
      try {
        writeFileSync(join(elsewhere, "keep-reviewer.log"), "outside\n");
        rmSync(join(dir, "report"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        symlinkSync(elsewhere, join(dir, "report"));
        writeFileSync(join(dir, "ok-reviewer.log"), "aborted again\n");
        copyTo(dir, undefined, () => undefined, []);
        assert.ok(existsSync(join(elsewhere, "keep-reviewer.log")), "the link's target was emptied");
        assert.ok(!existsSync(join(elsewhere, "reviewer-1.log")), "a view was written through the link");
        assert.equal(readFileSync(join(dir, "report", "reviewer-1.log"), "utf8"), "[error line: aborted]\n");
      } finally {
        rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("makes no folder when there is no reviewer log", () => {
    const { fs, made } = fakeFs({ "a-backend.log": "other", "empty.txt": "" });
    assert.deepEqual(copyTo("logs", fs, none, []), []);
    assert.deepEqual(made, []);
  });

  it("copies an empty log as an empty view", () => {
    assert.equal(copy(""), "\n");
  });

  it("keeps a view small by construction, whatever the log holds", () => {
    const junk = Array.from({ length: 2000 }, (_, i) => [`Iteration ${i % 999}/999`, `Bash(${i})`, `error ${i} ${"x ".repeat(150)}`, `prose ${i}`]).flat();
    const view = allowlistedView(junk.join("\n"));
    assert.ok(view.length < 10_000, `${view.length} characters`);
    assert.equal(copy(junk.join("\n")), view);
  });

  it("leaves out an error line that holds a secret value or a token shape", () => {
    for (const leak of [
      "the run failed with hunter2hunter2",
      `error ${"sk-ant-"}oat01-${"A".repeat(30)}`,
      `error ghp_${"B".repeat(25)}`,
      `error github_pat_${"C".repeat(25)}`,
    ]) {
      assert.equal(copy(leak, ["hunter2hunter2"]), "[... lines left out]\n", leak);
    }
  });

  it("leaves out an error line whose token was printed spaced out or between control characters", () => {
    const token = `ghp_${"D".repeat(25)}`;
    for (const leak of [
      `error ${token.split("").join(" ")}`,
      `error ${token.slice(0, 8)}\u200b${token.slice(8)}`,
      `error ${token.slice(0, 8)}\u001b[0m${token.slice(8)}`,
      `error ${token.slice(0, 8)}\u0301${token.slice(8)}`,
    ]) {
      assert.equal(copy(leak), "[... lines left out]\n", JSON.stringify(leak));
    }
  });

  it("publishes no text of a token wrapped across error lines, each short enough to pass alone", () => {
    // Each line is short enough to pass the token-run check alone; both come out as fixed messages, so no part of the token reaches the view.
    const wrapped = (head: string, filler: string, count: number) => copy(`error ${head}${filler.repeat(10)}\n${filler.repeat(count)}! failed`);
    for (const [head, filler] of [["ghp_", "D"], ["sk-ant-", "E"], ["gho_", "F"], ["ghu_", "F"], ["ghs_", "F"], ["ghr_", "F"], ["github_pat_", "G"]] as const) {
      const out = wrapped(head, filler, 10);
      assert.equal(out, "[error line: error]\n[error line: failed]\n", head);
      assert.ok(!out.includes(filler) && !out.includes(head), head);
    }
    assert.equal(copy("error hunter2\nhunter2 failed", ["hunter2hunter2"]), "[error line: error]\n[error line: failed]\n");
  });

  it("publishes no secret that sits in prose, a tool's arguments or a tool-call lookalike, in any form, and none plain on an error line", () => {
    const secret = "hunter2hunter2";
    const base64 = Buffer.from(secret).toString("base64");
    const text = [
      "Agent started",
      `I will now print ${secret} and ${base64} and ${[...secret].reverse().join("")}`,
      `${base64}(`,
      `error: ${secret}`,
      `Bash(echo ${secret} | base64)`,
      "Agent stopped",
    ].join("\n");
    const out = copy(text, [secret]);
    assert.ok(!out.includes(secret) && !out.includes(base64) && !out.startsWith("Left out"));
    assert.ok(out.includes("Bash(...)"));
  });

  it("still copies an ordinary log whose words are spaced and coloured", () => {
    const out = copy("Agent started\n\u001b[32mgreen\u001b[0m prose about ghp and sk-ant\nthe run failed: exit code 1\n");
    assert.ok(out.includes("[error line: failed]") && !out.includes("exit code 1"));
    assert.ok(!out.startsWith("Left out"));
  });

  it("warns and carries on when a log can't be read or the folder can't be listed", () => {
    const warnings: string[] = [];
    const { fs } = fakeFs({ "a-reviewer.log": "x", "b-reviewer.log": "y" }, "a-reviewer.log");
    assert.deepEqual(copyTo("logs", fs, (line) => warnings.push(line), []), ["reviewer-2.log"]);
    copyTo("logs", { ...fs, list: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } }, (line) => warnings.push(line), []);
    assert.equal(warnings.length, 2);
  });

  it("says nothing when the logs folder doesn't exist, as in a run that started no role, but still warns when it can't be listed", () => {
    const root = mkdtempSync(join(tmpdir(), "role-logs-missing-"));
    try {
      const warnings: string[] = [];
      assert.deepEqual(copyReviewerLogs(join(root, "no-such-logs"), join(root, "out"), liveRoleLogFs, (line) => warnings.push(line), []), []);
      assert.equal(warnings.length, 0);
      // No logs means nothing is written, the index included.
      assert.equal(existsSync(join(root, "out")), false);
      // A path that is a file, not a folder, is a real fault (ENOTDIR), not an empty run.
      writeFileSync(join(root, "file"), "x");
      copyReviewerLogs(join(root, "file"), join(root, "out"), liveRoleLogFs, (line) => warnings.push(line), []);
      assert.equal(warnings.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("names the views itself and keeps a source name and fs error paths out of the output and the warnings", () => {
    const token = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUv";
    const warnings: string[] = [];
    const { fs, written } = fakeFs({ [`${token}-reviewer.log`]: "Agent stopped", "z-reviewer.log": "x" });
    const broken: RoleLogFs = {
      ...fs,
      read: (path) => {
        if (path.includes(token)) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
        return fs.read(path);
      },
    };
    assert.deepEqual(copyTo("logs", broken, (line) => warnings.push(line), []), ["reviewer-2.log"]);
    assert.deepEqual(Object.keys(written), ["logs/report/reviewer-2.log", "logs/report/index.txt"]);
    assert.deepEqual(warnings, ["Couldn't copy reviewer log 1 to the report (EACCES)"]);
    // A readable one is written under a number as well.
    const ok = fakeFs({ [`${token}-reviewer.log`]: "Agent stopped" });
    copyTo("logs", ok.fs, none, []);
    assert.deepEqual(Object.keys(ok.written), ["logs/report/reviewer-1.log", "logs/report/index.txt"]);
    assert.ok(!JSON.stringify([ok.written, written, warnings]).includes(token));
  });

  it("ignores a directory named like a log, which it can't read", () => {
    const warnings: string[] = [];
    const { fs, written } = fakeFs({ "dir-reviewer.log": "x" });
    copyTo("logs", { ...fs, read: () => { throw new Error("EISDIR"); } }, (line) => warnings.push(line), []);
    assert.equal(warnings.length, 1);
    assert.deepEqual(written, { "logs/report/index.txt": "reviewer-1.log: issue #1 (not copied)\n" });
  });

  it("reads the sandbox's secrets from .sandcastle/.env by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-logs-env-"));
    const before = process.cwd();
    try {
      mkdirSync(join(dir, ".sandcastle"));
      writeFileSync(join(dir, ".sandcastle", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=swordfish-in-the-env\n");
      mkdirSync(join(dir, "logs"));
      writeFileSync(join(dir, "logs", "a-reviewer.log"), "error swordfish-in-the-env\n");
      writeFileSync(join(dir, "logs", "b-reviewer.log"), "error plain\n");
      process.chdir(dir);
      assert.deepEqual(copyTo("logs", undefined, () => undefined).sort(), ["reviewer-1.log", "reviewer-2.log"]);
      assert.equal(readFileSync(join(dir, "logs", "report", "reviewer-1.log"), "utf8"), "[... lines left out]\n");
      assert.equal(readFileSync(join(dir, "logs", "report", "reviewer-2.log"), "utf8"), "[error line: error]\n");
    } finally {
      process.chdir(before);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("uses the real filesystem by default and refuses a symlinked log", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-logs-"));
    try {
      writeFileSync(join(dir, "ok-reviewer.log"), "the reviewer aborted\n");
      writeFileSync(join(dir, "ok-backend.log"), "not copied\n");
      writeFileSync(join(dir, "target.txt"), "a host file\n");
      symlinkSync(join(dir, "target.txt"), join(dir, "link-reviewer.log"));
      mkdirSync(join(dir, "report"), { recursive: true });
      assert.deepEqual(copyTo(dir, undefined, () => undefined, []), ["reviewer-2.log"]);
      assert.deepEqual(readdirSync(join(dir, "report")).sort(), ["index.txt", "reviewer-2.log"], "a symlinked log was copied");
      assert.equal(readFileSync(join(dir, "report", "reviewer-2.log"), "utf8"), "[error line: aborted]\n");
      assert.ok(!existsSync(join(dir, "report", "ok-backend.log")));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

// Only the logs of builds this run started are copied, and at most REPORT_LOG_LIMIT of them: a sandbox that can write the logs folder
// could add files of its own, and each view is a few dozen bits it would choose.
describe("the log limit", () => {
  const name = (i: number) => `log-${String(i).padStart(3, "0")}-reviewer.log`;
  // Listed in reverse, each with a view of its own (a tool name that depends on its position), so which logs were copied and in what order shows.
  const filesOf = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => count - 1 - i).map((i) => [name(i), `${["Bash", "Read", "Grep"][i % 3]}(${i})`]));
  const more = `more than ${REPORT_LOG_LIMIT} reviewer logs: the rest were not copied`;
  const others = "other reviewer logs in the folder were not copied: no build of this run wrote them";
  const buildsFor = (count: number) => {
    const builds = new BuildLogs();
    for (let i = 0; i < count; i++) builds.add(100 + i, name(i).replace(/-reviewer\.log$/, ""));
    return builds;
  };

  it("copies the first REPORT_LOG_LIMIT build logs by sorted name, whatever order they are listed in, and says in the index that the rest were not copied (n-1, n, n+1)", () => {
    assert.equal(REPORT_LOG_LIMIT, 20);
    for (const count of [REPORT_LOG_LIMIT - 1, REPORT_LOG_LIMIT, REPORT_LOG_LIMIT + 1, REPORT_LOG_LIMIT + 30]) {
      const { fs, written } = fakeFs(filesOf(count));
      const copied = copyReviewerLogs("logs", "logs/report", fs, none, [], buildsFor(count));
      const limit = Math.min(count, REPORT_LOG_LIMIT);
      assert.deepEqual(copied, Array.from({ length: limit }, (_, i) => `reviewer-${i + 1}.log`), `${count} logs`);
      for (let i = 0; i < limit; i++) assert.equal(written[`logs/report/reviewer-${i + 1}.log`], `${["Bash", "Read", "Grep"][i % 3]}(...)\n`, `${count} logs, log ${i}`);
      assert.ok(!(`logs/report/reviewer-${limit + 1}.log` in written), `${count} logs`);
      const lines = Array.from({ length: limit }, (_, i) => `reviewer-${i + 1}.log: issue #${100 + i}`);
      assert.equal(written["logs/report/index.txt"], `${[...lines, ...(count > REPORT_LOG_LIMIT ? [more] : [])].join("\n")}\n`, `${count} logs`);
    }
  });

  it("copies by default only the logs of builds the global record knows, the record every build adds itself to", () => {
    buildLogs.add(4242, "zz/default-record-test");
    const { fs, written } = fakeFs({ [reviewerLogFileName("zz/default-record-test")]: "Bash(1)", "x-reviewer.log": "Read(2)" });
    assert.deepEqual(copyReviewerLogs("logs", "logs/report", fs, none, []), ["reviewer-1.log"]);
    assert.equal(written["logs/report/reviewer-1.log"], "Bash(...)\n");
    assert.equal(written["logs/report/index.txt"], `reviewer-1.log: issue #4242\n${others}\n`);
  });

  it("copies no log that no build of this run wrote, however many a sandbox adds, and says so once in the index", () => {
    const builds = new BuildLogs();
    builds.add(9, "zzz/9-late");
    const files = { ...filesOf(REPORT_LOG_LIMIT + 5), "zzz-9-late-reviewer.log": "Write(x)" };
    const { fs, written } = fakeFs(files);
    const copied = copyReviewerLogs("logs", "logs/report", fs, none, [], builds);
    assert.deepEqual(copied, ["reviewer-1.log"]);
    assert.equal(written["logs/report/reviewer-1.log"], "Write(...)\n");
    assert.equal(written["logs/report/index.txt"], `reviewer-1.log: issue #9\n${others}\n`);
    assert.deepEqual(Object.keys(written).sort(), ["logs/report/index.txt", "logs/report/reviewer-1.log"]);
    // With none known, nothing is copied and the index only says so.
    const none3 = fakeFs(filesOf(3));
    assert.deepEqual(copyReviewerLogs("logs", "logs/report", none3.fs, none, [], new BuildLogs()), []);
    assert.deepEqual(none3.written, { "logs/report/index.txt": `${others}\n` });
  });

  it("says both fixed lines, the limit first, when there are more than the limit and files no build wrote", () => {
    const { fs, written } = fakeFs({ ...filesOf(REPORT_LOG_LIMIT + 1), "extra-reviewer.log": "Bash(1)" });
    copyReviewerLogs("logs", "logs/report", fs, none, [], buildsFor(REPORT_LOG_LIMIT + 1));
    assert.ok(written["logs/report/index.txt"]!.endsWith(`${more}\n${others}\n`));
  });

  it("gives a log that can't be read its number and its index line, and still omits the one after the limit", () => {
    const { fs, written } = fakeFs(filesOf(REPORT_LOG_LIMIT + 1), name(REPORT_LOG_LIMIT - 1));
    const warnings: string[] = [];
    const copied = copyReviewerLogs("logs", "logs/report", fs, (line) => warnings.push(line), [], buildsFor(REPORT_LOG_LIMIT + 1));
    assert.equal(copied.length, REPORT_LOG_LIMIT - 1);
    assert.ok(!copied.includes(`reviewer-${REPORT_LOG_LIMIT}.log`));
    const index = written["logs/report/index.txt"]!.split("\n");
    assert.equal(index[REPORT_LOG_LIMIT - 1], `reviewer-${REPORT_LOG_LIMIT}.log: issue #${100 + REPORT_LOG_LIMIT - 1} (not copied)`);
    assert.equal(index[REPORT_LOG_LIMIT], more);
    assert.equal(warnings.length, 1);
  });
});

// The numbered views carry no name, so the host says which build each one is (mpaulosky/dotfiles#428).
describe("reviewer log index", () => {
  it("names a log the way Sandcastle does: the branch with the characters a file name can't hold as hyphens", () => {
    assert.equal(reviewerLogFileName("feature/214-say-in-pr-auto-merges"), "feature-214-say-in-pr-auto-merges-reviewer.log");
    assert.equal(reviewerLogFileName('a\\b:c*d?e"f<g>h|i/j'), "a-b-c-d-e-f-g-h-i-j-reviewer.log");
    assert.equal(reviewerLogFileName("fix/421-x"), "fix-421-x-reviewer.log");
  });

  it("looks a log up by the name its build's branch gives it", () => {
    const builds = new BuildLogs();
    builds.add(421, "fix/421-gate");
    builds.add(7, "feature/7-seven");
    assert.equal(builds.issueOf("fix-421-gate-reviewer.log"), 421);
    assert.equal(builds.issueOf("feature-7-seven-reviewer.log"), 7);
    assert.equal(builds.issueOf("fix-421-gate-tester.log"), undefined);
    assert.equal(builds.issueOf("other-reviewer.log"), undefined);
  });

  it("says in the index which issue each numbered view is, in the order of the numbers", () => {
    const builds = new BuildLogs();
    builds.add(421, "fix/421-gate");
    builds.add(7, "feature/7-seven");
    const { fs, written } = fakeFs({ "fix-421-gate-reviewer.log": "x", "feature-7-seven-reviewer.log": "y", "unknown-reviewer.log": "z" });

    assert.equal(REVIEWER_LOG_INDEX, "index.txt");
    copyReviewerLogs("logs", "logs/report", fs, none, [], builds);

    // Sorted names: feature-7..., fix-421...; unknown-reviewer.log is no build's and is not copied.
    assert.equal(
      written["logs/report/index.txt"],
      "reviewer-1.log: issue #7\nreviewer-2.log: issue #421\nother reviewer logs in the folder were not copied: no build of this run wrote them\n",
    );
  });

  it("marks a view that couldn't be copied, and never prints a source name", () => {
    const token = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUv";
    const builds = new BuildLogs();
    builds.add(5, "fix/5-five");
    const { fs, written } = fakeFs({ "fix-5-five-reviewer.log": "x", [`${token}-reviewer.log`]: "y" }, "fix-5-five-reviewer.log");

    copyReviewerLogs("logs", "logs/report", fs, none, [], builds);

    assert.equal(written["logs/report/index.txt"], `reviewer-1.log: issue #5 (not copied)\nother reviewer logs in the folder were not copied: no build of this run wrote them\n`);
    assert.ok(!JSON.stringify(written).includes(token));
  });

  it("writes no index when there is no reviewer log, and warns when the index can't be written", () => {
    const none2 = fakeFs({ "a-backend.log": "other" });
    copyReviewerLogs("logs", "logs/report", none2.fs, none, [], knowing(["a-reviewer.log"]));
    assert.deepEqual(none2.written, {});

    const warnings: string[] = [];
    const { fs, written } = fakeFs({ "a-reviewer.log": "x" });
    const noIndex: RoleLogFs = {
      ...fs,
      write: (path, text) => {
        if (path.endsWith(REVIEWER_LOG_INDEX)) throw Object.assign(new Error(`EACCES: open '${path}'`), { code: "EACCES" });
        fs.write(path, text);
      },
    };
    assert.deepEqual(copyReviewerLogs("logs", "logs/report", noIndex, (line) => warnings.push(line), [], knowing(["a-reviewer.log"])), ["reviewer-1.log"]);
    assert.deepEqual(warnings, ["Couldn't write the index of the reviewer logs: EACCES"]);
    assert.deepEqual(Object.keys(written), ["logs/report/reviewer-1.log"]);
  });

  it("warns without the error's message, which names the path, when the index write throws something with no code", () => {
    for (const thrown of [new Error("open '/secret/path/index.txt'"), "a string", null]) {
      const warnings: string[] = [];
      const { fs } = fakeFs({ "a-reviewer.log": "x" });
      const noIndex: RoleLogFs = {
        ...fs,
        write: (path, text) => {
          if (path.endsWith(REVIEWER_LOG_INDEX)) throw thrown;
          fs.write(path, text);
        },
      };
      copyReviewerLogs("logs", "logs/report", noIndex, (line) => warnings.push(line), [], knowing(["a-reviewer.log"]));
      assert.deepEqual(warnings, ["Couldn't write the index of the reviewer logs: an error"]);
    }
  });

  it("indexes the real files of a real folder too", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-logs-index-"));
    try {
      const builds = new BuildLogs();
      builds.add(9, "fix/9-nine");
      writeFileSync(join(dir, "fix-9-nine-reviewer.log"), "the reviewer aborted\n");
      copyReviewerLogs(dir, join(dir, "report"), undefined, () => undefined, [], builds);
      assert.equal(readFileSync(join(dir, "report", "index.txt"), "utf8"), "reviewer-1.log: issue #9\n");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

// A reviewer log is written by the sandbox, so its size is the sandbox's choice: the host reads at most the end of it, which is all the view keeps.
describe("the input limit", () => {
  const early = "Fatal: early failure\n";
  const late = "Panic: late failure\n";
  const LEFT_OUT = "[... lines left out]";
  // A log of exactly `length` characters: the early error line, one long line of blanks (which is no line left out), the late error line.
  const logOf = (length: number) => `${early}${" ".repeat(length - early.length - late.length - 1)}\n${late}`;
  const inTemp = (body: (dir: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "role-logs-limit-"));
    try {
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };

  it("keeps the whole log up to REPORT_INPUT_LIMIT characters and only its end beyond it, and says so (n-1, n, n+1)", () => {
    assert.equal(REPORT_INPUT_LIMIT, 4 * 1024 * 1024);
    for (const [length, cut] of [[REPORT_INPUT_LIMIT - 1, false], [REPORT_INPUT_LIMIT, false], [REPORT_INPUT_LIMIT + 1, true]] as const) {
      const view = allowlistedView(logOf(length));
      assert.equal(view.includes("[error line: fatal]"), !cut, `length ${length}`);
      assert.ok(view.includes("[error line: panic]"), `length ${length}`);
      assert.equal(view.startsWith(`${LEFT_OUT}\n`), cut, `length ${length}`);
    }
  });

  it("reads at most the last REPORT_INPUT_LIMIT bytes of a real log, from a whole line, marks the cut, and reads all of a log that fits (n-1, n, n+1)", () => {
    inTemp((root) => {
      const file = join(root, "a-reviewer.log");
      for (const [bytes, cut] of [[REPORT_INPUT_LIMIT - 1, false], [REPORT_INPUT_LIMIT, false], [REPORT_INPUT_LIMIT + 1, true]] as const) {
        writeFileSync(file, logOf(bytes));
        const text = liveRoleLogFs.read(file);
        assert.equal(text.includes("Fatal: early failure"), !cut, `${bytes} bytes`);
        assert.ok(text.includes("Panic: late failure"), `${bytes} bytes`);
        assert.equal(text.startsWith(`${LEFT_OUT}\n`), cut, `${bytes} bytes`);
        assert.ok(Buffer.byteLength(text) <= REPORT_INPUT_LIMIT + LEFT_OUT.length + 1, `${bytes} bytes`);
      }
      // A log of exactly the limit with no final line break comes back as written; an empty one comes back empty.
      const noFinalBreak = `${early}${"a".repeat(REPORT_INPUT_LIMIT - early.length)}`;
      writeFileSync(file, noFinalBreak);
      assert.equal(liveRoleLogFs.read(file), noFinalBreak);
      writeFileSync(file, "");
      assert.equal(liveRoleLogFs.read(file), "");
    });
  });

  it("shows a log it read cut as the marker and the whole of its kept tail, not cut a second time", () => {
    inTemp((root) => {
      const file = join(root, "a-reviewer.log");
      writeFileSync(file, logOf(REPORT_INPUT_LIMIT + 1));
      assert.equal(allowlistedView(liveRoleLogFs.read(file)), `${LEFT_OUT}\n[error line: panic]\n`);
    });
  });

  it("keeps a first line that the cut leaves whole, and drops one that begins where the window does", () => {
    // The window (the last REPORT_INPUT_LIMIT + 1 characters) starts on a line break: the early line after it is whole, so it stays.
    const aligned = `x\n${early}${"a".repeat(REPORT_INPUT_LIMIT - early.length - late.length - 1)}\n${late}`;
    assert.equal(aligned.length, REPORT_INPUT_LIMIT + 2);
    assert.ok(allowlistedView(aligned).includes("[error line: fatal]"));
    // One character further in, the early line starts exactly where the window begins: nothing shows it began a line, so it goes,
    // which keeps the result within the limit.
    const exact = `x\n${early}${"a".repeat(REPORT_INPUT_LIMIT - early.length - late.length)}\n${late}`;
    assert.equal(exact.length, REPORT_INPUT_LIMIT + 3);
    assert.ok(!allowlistedView(exact).includes("[error line: fatal]"));
    inTemp((root) => {
      const file = join(root, "a-reviewer.log");
      writeFileSync(file, aligned);
      assert.ok(liveRoleLogFs.read(file).includes("Fatal: early failure"));
      // The marker read adds in front makes the text a little longer than the limit; the view's own cut still keeps the whole tail.
      assert.ok(allowlistedView(liveRoleLogFs.read(file)).includes("[error line: fatal]"));
      writeFileSync(file, exact);
      assert.ok(!liveRoleLogFs.read(file).includes("Fatal: early failure"));
    });
  });

  it("leaves only the marker for a tail with no line break, so a reader can tell a cut log from a quiet one", () => {
    const oneLine = `${early}${"a".repeat(REPORT_INPUT_LIMIT + 5)}`;
    assert.equal(allowlistedView(oneLine), `${LEFT_OUT}\n`);
    inTemp((root) => {
      const file = join(root, "a-reviewer.log");
      writeFileSync(file, oneLine);
      assert.equal(liveRoleLogFs.read(file), `${LEFT_OUT}\n`);
      assert.equal(allowlistedView(liveRoleLogFs.read(file)), `${LEFT_OUT}\n`);
    });
  });

  it("cuts a log with CRLF line endings at a whole line", () => {
    const crlf = `${early.replace("\n", "\r\n")}${"a".repeat(REPORT_INPUT_LIMIT)}\r\n${late.replace("\n", "\r\n")}`;
    assert.ok(crlf.length > REPORT_INPUT_LIMIT);
    const view = allowlistedView(crlf);
    assert.ok(view.includes("[error line: panic]\n"));
    assert.ok(!view.includes("[error line: fatal]"));
    inTemp((root) => {
      const file = join(root, "a-reviewer.log");
      writeFileSync(file, crlf);
      assert.ok(allowlistedView(liveRoleLogFs.read(file)).includes("[error line: panic]\n"));
    });
  });

  it("never starts the tail in the middle of a multi-byte character, whichever byte of it the cut lands on", () => {
    inTemp((root) => {
      const file = join(root, "a-reviewer.log");
      const head = `${"é".repeat(5)}\n`;
      // The window starts `offset` bytes into the file: 1 is the second byte of the first é (a half character), 2 the first byte of the second (the boundary).
      for (const offset of [1, 2]) {
        const filler = "a".repeat(REPORT_INPUT_LIMIT + 1 + offset - Buffer.byteLength(head) - Buffer.byteLength(late) - 1);
        writeFileSync(file, `${head}${filler}\n${late}`);
        assert.equal(statSync(file).size, REPORT_INPUT_LIMIT + 1 + offset);
        const text = liveRoleLogFs.read(file);
        assert.ok(!text.includes("\uFFFD"), `offset ${offset}: a half character became U+FFFD`);
        assert.ok(!text.includes("é"), `offset ${offset}: the cut line was kept`);
        assert.ok(text.includes("Panic: late failure"));
      }
    });
  });

  it("refuses a log that is not a regular file before opening it: a symlink, a directory and a FIFO", () => {
    inTemp((root) => {
      writeFileSync(join(root, "target"), "x");
      symlinkSync(join(root, "target"), join(root, "link-reviewer.log"));
      assert.throws(() => liveRoleLogFs.read(join(root, "link-reviewer.log")), /not a regular file/);
      mkdirSync(join(root, "dir-reviewer.log"));
      assert.throws(() => liveRoleLogFs.read(join(root, "dir-reviewer.log")), /not a regular file/);
      // The check comes first, so a FIFO is refused without an open (an open without O_NONBLOCK would wait here).
      if (spawnSync("mkfifo", [join(root, "fifo-reviewer.log")]).status === 0) assert.throws(() => liveRoleLogFs.read(join(root, "fifo-reviewer.log")), /not a regular file/);
      assert.deepEqual(readLogTail(join(root, "target")), "x");
    });
  });

  it("still refuses what the open finds when the entry was swapped after the check (the check stood in by one that passes): a symlink, a directory", () => {
    inTemp((root) => {
      writeFileSync(join(root, "target"), "x");
      symlinkSync(join(root, "target"), join(root, "link-reviewer.log"));
      assert.throws(() => readLogTail(join(root, "link-reviewer.log"), () => true), { code: "ELOOP" });
      mkdirSync(join(root, "dir-reviewer.log"));
      assert.throws(() => readLogTail(join(root, "dir-reviewer.log"), () => true), /not a regular file/);
    });
  });

  it("does not wait for a writer on a FIFO swapped in after the check (run in a child process, since a wait would block this one)", (t) => {
    // The child imports a .mts file, which only Node's own type stripping (unflagged from 22.18 and 23.6) lets a bare `node -e` do.
    if (!process.features.typescript) return t.skip("needs Node's type stripping");
    inTemp((root) => {
      const fifo = join(root, "fifo-reviewer.log");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return t.skip("mkfifo is not available");
      const module = new URL("./role-logs.mts", import.meta.url).href;
      const script = `import(${JSON.stringify(module)}).then((m) => { try { m.readLogTail(${JSON.stringify(fifo)}, () => true); process.exit(4); } catch (e) { process.exit(e.message === "not a regular file" ? 0 : 3); } });`;
      const run = spawnSync(process.execPath, ["-e", script], { timeout: 15_000, encoding: "utf8" });
      assert.equal(run.status, 0, `exit ${run.status}, signal ${run.signal}: ${run.stderr}`);
    });
  });
});
