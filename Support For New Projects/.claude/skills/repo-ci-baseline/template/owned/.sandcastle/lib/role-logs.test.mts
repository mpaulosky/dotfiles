import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allowlistedView,
  BuildLogs,
  copyReviewerLogs,
  REVIEWER_LOG_INDEX,
  reviewerLogFileName,
  reviewerLogsDir,
  REVIEWER_LOGS_NAME,
  REPORT_ERROR_LINES,
  REPORT_HOST_LINES,
  REPORT_TOOL_LINES,
  REPORT_LINE_LIMIT,
  REPORT_TOKEN_RUN,
  liveRoleLogFs,
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

// copyReviewerLogs with the views going to <logsDir>/report, as most tests below read them from there.
const copyTo = (logsDir: string, fs?: RoleLogFs, warn?: (line: string) => void, secrets?: readonly string[]) =>
  copyReviewerLogs(logsDir, join(logsDir, "report"), fs, warn, secrets);

describe("allowlistedView", () => {
  it("keeps every host status line as written, but for the start line's timestamp", () => {
    const kept = hostLines.map((line) => (line.startsWith("--- Run started") ? "--- Run started ---" : line));
    assert.equal(allowlistedView(hostLines.join("\n")), `${kept.join("\n")}\n`);
  });

  it("keeps only the last REPORT_HOST_LINES host lines", () => {
    assert.equal(REPORT_HOST_LINES, 30);
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `Iteration ${i}/99`);
    assert.equal(allowlistedView(lines(REPORT_HOST_LINES).join("\n")), `${lines(REPORT_HOST_LINES).join("\n")}\n`);
    const over = allowlistedView(lines(REPORT_HOST_LINES + 1).join("\n"));
    assert.ok(over.startsWith("[... lines left out]\nIteration 1/99\n"));
    assert.ok(over.endsWith(`Iteration ${REPORT_HOST_LINES}/99\n`));
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
      assert.equal(view(line(limit)), `${line(limit)}\n`, line(limit));
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
    assert.match(view, /^Bash\(\.\.\.\)\n/);
    assert.ok(view.includes("Read(...)"));
    assert.ok(!/hidden|passwd|cat > f/.test(view));
  });

  it("keeps only the last REPORT_TOOL_LINES tool lines", () => {
    assert.equal(REPORT_TOOL_LINES, 30);
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `${i % 2 === 0 ? "Bash" : "Read"}(${i})`);
    const kept = (count: number) => lines(count).map((line) => `${line.split("(")[0]}(...)`);
    assert.equal(allowlistedView(lines(REPORT_TOOL_LINES).join("\n")), `${kept(REPORT_TOOL_LINES).join("\n")}\n`);
    const over = allowlistedView(lines(REPORT_TOOL_LINES + 1).join("\n"));
    assert.equal(over, `[... lines left out]\n${kept(REPORT_TOOL_LINES + 1).slice(1).join("\n")}\n`);
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

  it("drops model prose and marks where lines were left out, once per run of them and without a count, blank lines being no run", () => {
    const view = allowlistedView("Agent started\nsome prose\nmore prose\n\nAgent stopped\nlast words");
    assert.equal(view, "Agent started\n[... lines left out]\nAgent stopped\n[... lines left out]\n");
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
    for (const line of forms) assert.equal(allowlistedView(line), `${line}\n`, line);
  });

  it("keeps a line for each word that names an error, and only as a word", () => {
    const words = [
      "abort", "aborted", "error", "errors", "fail", "failed", "failure", "failures", "exception", "fatal", "panic", "timed out", "timeout",
      "killed", "terminated", "exit code 1", "exited with 2", "signal", "crash", "crashed", "unauthorized", "unauthorised", "rate limit", "overloaded",
    ];
    for (const word of words) assert.equal(allowlistedView(`it ${word} now`), `it ${word} now\n`, word);
    for (const near of ["panicky", "fatally", "terrorism", "errorless", "exit codes", "unauthorizeds"]) {
      assert.equal(allowlistedView(`it ${near} now`), "[... lines left out]\n", near);
    }
    assert.equal(allowlistedView("An ERROR happened"), "An ERROR happened\n");
  });

  it("keeps an error line, not the prose around it, and the host lines and tool names near it", () => {
    const view = allowlistedView("prose a\nBash(secret)\nthe claude-code process aborted\nAgent stopped\nprose b\n");
    assert.equal(view, "[... lines left out]\nBash(...)\nthe claude-code process aborted\nAgent stopped\n[... lines left out]\n");
  });

  it("cuts an error line at the line limit exactly, and never in the middle of a surrogate pair", () => {
    assert.equal(REPORT_LINE_LIMIT, 200);
    const line = (length: number) => `error ${" x".repeat(length)}`.slice(0, length);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT - 1)), `${line(REPORT_LINE_LIMIT - 1)}\n`);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT)), `${line(REPORT_LINE_LIMIT)}\n`);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT + 1)), `${line(REPORT_LINE_LIMIT)}\n`);
  });

  it("drops a surrogate pair the cut would split, and keeps one that ends at the limit", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const withPairAt = (index: number, tail: string) => `${`error${" x".repeat(100)}`.slice(0, index)}${emoji}${tail}`;
    const split = withPairAt(REPORT_LINE_LIMIT - 1, "yyyy");
    assert.equal(split.indexOf(emoji), REPORT_LINE_LIMIT - 1);
    assert.equal(allowlistedView(split), `${split.slice(0, REPORT_LINE_LIMIT - 1)}\n`);
    const whole = withPairAt(REPORT_LINE_LIMIT - 2, "yyyy");
    assert.equal(whole.indexOf(emoji), REPORT_LINE_LIMIT - 2);
    assert.equal(allowlistedView(whole), `${whole.slice(0, REPORT_LINE_LIMIT)}\n`);
    const loneHigh = `${`error${" x".repeat(100)}`.slice(0, REPORT_LINE_LIMIT - 1)}\uD83D`;
    assert.equal(allowlistedView(loneHigh), `${loneHigh}\n`);
    const exact = withPairAt(REPORT_LINE_LIMIT - 2, "");
    assert.equal(exact.length, REPORT_LINE_LIMIT);
    assert.equal(allowlistedView(exact), `${exact}\n`);
  });

  it("leaves out an error line with a run of token characters, at n-1, n and n+1", () => {
    assert.equal(REPORT_TOKEN_RUN, 24);
    const withRun = (length: number) => `error ${"A".repeat(length)}`;
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN - 1)), `${withRun(REPORT_TOKEN_RUN - 1)}\n`);
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN)), "[... lines left out]\n");
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN + 1)), "[... lines left out]\n");
    for (const ch of ["+", "/", "_", "=", "-", "9", "z"]) assert.equal(allowlistedView(`error ${ch.repeat(REPORT_TOKEN_RUN)}`), "[... lines left out]\n", ch);
  });

  it("leaves out an error line the caller's check holds, before the line is cut", () => {
    const secret = `error ${"x ".repeat(98)}hunter2`;
    assert.ok(secret.length > REPORT_LINE_LIMIT);
    assert.equal(allowlistedView(secret, (line) => line.includes("hunter2")), "[... lines left out]\n");
    assert.notEqual(allowlistedView(secret), "[... lines left out]\n");
  });

  it("keeps only the last REPORT_ERROR_LINES error lines", () => {
    assert.equal(REPORT_ERROR_LINES, 20);
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `error number ${i}`);
    assert.equal(allowlistedView(lines(REPORT_ERROR_LINES).join("\n")), `${lines(REPORT_ERROR_LINES).join("\n")}\n`);
    const over = allowlistedView(lines(REPORT_ERROR_LINES + 1).join("\n"));
    assert.ok(!over.includes("error number 0\n"));
    assert.ok(over.startsWith("[... lines left out]\nerror number 1\n"));
    assert.ok(over.endsWith(`error number ${REPORT_ERROR_LINES}\n`));
  });

  it("keeps a first-line-only error log, and reads CRLF lines", () => {
    assert.equal(allowlistedView("aborted"), "aborted\n");
    assert.equal(allowlistedView("Agent started\r\nAgent stopped\r\n"), "Agent started\nAgent stopped\n");
  });
});

describe("copyReviewerLogs", () => {
  it("copies only the reviewer logs, as their view, into the report folder", () => {
    const { fs, written } = fakeFs({ "a-reviewer.log": "aborted", "a-backend.log": "other" });
    assert.deepEqual(copyTo("logs", fs, none, []), ["reviewer-1.log"]);
    assert.deepEqual(written, { "logs/report/reviewer-1.log": "aborted\n", "logs/report/index.txt": "reviewer-1.log: a build this run did not start\n" });
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
      assert.deepEqual(copyReviewerLogs(dir, out, undefined, () => undefined, []), ["reviewer-1.log"]);
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
      assert.equal(readFileSync(join(dir, "report", "reviewer-1.log"), "utf8"), "the reviewer aborted\n");
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
        assert.equal(readFileSync(join(dir, "report", "reviewer-1.log"), "utf8"), "aborted again\n");
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

  it("replaces a view whose token is wrapped across error lines, each short enough to pass alone, with a note", () => {
    const note = "Left out: the view held something shaped like a secret.\n";
    // The second line ends its run of token characters with `!`, so the word after it can't lengthen the body.
    const wrapped = (head: string, filler: string, count: number) => copy(`error ${head}${filler.repeat(10)}\n${filler.repeat(count)}! failed`);
    assert.equal(wrapped("ghp_", "D", 10), note);
    assert.notEqual(wrapped("ghp_", "D", 9), note);
    assert.equal(wrapped("sk-ant-", "E", 6), note);
    assert.notEqual(wrapped("sk-ant-", "E", 5), note);
    for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_"]) assert.equal(wrapped(prefix, "F", 10), note, prefix);
    assert.equal(wrapped("github_pat_", "G", 10), note);
    assert.notEqual(wrapped("github_pat_", "G", 9), note);
    assert.equal(copy("error hunter2\nhunter2 failed", ["hunter2hunter2"]), note);
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
    assert.ok(out.includes("the run failed: exit code 1"));
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
      rmSync(root, { recursive: true, force: true });
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
    assert.deepEqual(written, { "logs/report/index.txt": "reviewer-1.log: a build this run did not start (not copied)\n" });
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
      assert.equal(readFileSync(join(dir, "logs", "report", "reviewer-2.log"), "utf8"), "error plain\n");
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
      assert.equal(readFileSync(join(dir, "report", "reviewer-2.log"), "utf8"), "the reviewer aborted\n");
      assert.ok(!existsSync(join(dir, "report", "ok-backend.log")));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
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

    // Sorted names: feature-7..., fix-421..., unknown...
    assert.equal(
      written["logs/report/index.txt"],
      "reviewer-1.log: issue #7\nreviewer-2.log: issue #421\nreviewer-3.log: a build this run did not start\n",
    );
  });

  it("marks a view that couldn't be copied, and never prints a source name", () => {
    const token = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUv";
    const builds = new BuildLogs();
    builds.add(5, "fix/5-five");
    const { fs, written } = fakeFs({ "fix-5-five-reviewer.log": "x", [`${token}-reviewer.log`]: "y" }, "fix-5-five-reviewer.log");

    copyReviewerLogs("logs", "logs/report", fs, none, [], builds);

    assert.equal(written["logs/report/index.txt"], `reviewer-1.log: issue #5 (not copied)\nreviewer-2.log: a build this run did not start\n`);
    assert.ok(!JSON.stringify(written).includes(token));
  });

  it("writes no index when there is no reviewer log, and warns when the index can't be written", () => {
    const none2 = fakeFs({ "a-backend.log": "other" });
    copyReviewerLogs("logs", "logs/report", none2.fs, none, []);
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
    assert.deepEqual(copyReviewerLogs("logs", "logs/report", noIndex, (line) => warnings.push(line), []), ["reviewer-1.log"]);
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
      copyReviewerLogs("logs", "logs/report", noIndex, (line) => warnings.push(line), []);
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
