import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allowlistedView,
  copyReviewerLogs,
  REPORT_ERROR_LINES,
  REPORT_LINE_LIMIT,
  REPORT_LOG_LIMIT,
  REPORT_TOKEN_RUN,
  type RoleLogFs,
} from "./role-logs.mts";

function fakeFs(files: Record<string, string>, failOn?: string) {
  const written: Record<string, string> = {};
  const made: string[] = [];
  const fs: RoleLogFs = {
    list: () => Object.keys(files),
    read: (path) => {
      if (failOn !== undefined && path.endsWith(failOn)) throw new Error("EACCES");
      return files[path.split(/[\\/]/).at(-1)!]!;
    },
    mkdir: (path) => void made.push(path),
    write: (path, text) => void (written[path] = text),
  };
  return { fs, written, made };
}

const none = () => undefined;
const copy = (text: string, secrets: readonly string[] = []) => {
  const { fs, written } = fakeFs({ "a-reviewer.log": text });
  copyReviewerLogs("logs", fs, none, secrets);
  return written["logs/report/a-reviewer.log"]!;
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

describe("allowlistedView", () => {
  it("keeps every host status line as written", () => {
    assert.equal(allowlistedView(hostLines.join("\n")), `${hostLines.join("\n")}\n`);
  });

  it("keeps a known tool's name and drops its arguments, also over several lines", () => {
    const view = allowlistedView('Bash(cat > f <<\'EOF\'\nthe hidden body\nEOF\n)\nRead(/etc/passwd)\nmcp__x__y(a=1)');
    assert.match(view, /^Bash\(\.\.\.\)\n/);
    assert.ok(view.includes("Read(...)"));
    assert.ok(view.includes("mcp__x__y(...)"));
    assert.ok(!/hidden|passwd|cat > f|a=1/.test(view));
  });

  it("drops a line that only looks like a tool call: another name, a code line, an encoded chunk", () => {
    const lookalikes = ["open(p).read()", "aGVsbG8gd29ybGQ=(", "9Bash(x)", "Not a tool (x)", "bash(x)", "Bashful(x)", "mcp__a(x)", `Read${"x".repeat(60)}(x)`];
    for (const line of lookalikes) assert.equal(allowlistedView(line), "[... 1 line left out]\n", line);
  });

  it("drops model prose and says how many lines it left out, once per run of them, not counting blank ones", () => {
    const view = allowlistedView("Agent started\nsome prose\nmore prose\n\nAgent stopped\nlast words");
    assert.equal(view, "Agent started\n[... 2 lines left out]\nAgent stopped\n[... 1 line left out]\n");
  });

  it("matches a host line whole: a prefix, a suffix, a malformed number or timestamp doesn't pass", () => {
    const near = [
      "I wrote: Agent started", "xAgent stopped", "Agent started and then I printed my secret", "Iteration 1/3x", "Iteration 1/3 plus words",
      "Context window: 42kb", "Syncing 2 commits to host done (3.0s) extra", "Run complete: whatever", "Iteration 1234567/3",
      "--- Run started: 2026-11-03 10:00 ---", "Setting up sandbox done (x.5s)", "Reached max iterations (3)",
    ];
    for (const line of near) assert.equal(allowlistedView(line), "[... 1 line left out]\n", line);
  });

  it("keeps the singular sync line, whole-second durations and every other host form", () => {
    const forms = ["Syncing 1 commit to host", "Setting up sandbox done (3s)", "Reached max iterations (10).", "Capturing session", "Expanding shell expressions", "Iteration 123456/123456"];
    for (const line of forms) assert.equal(allowlistedView(line), `${line}\n`, line);
  });

  it("keeps a line for each word that names an error, and only as a word", () => {
    const words = [
      "abort", "aborted", "error", "errors", "fail", "failed", "failure", "failures", "exception", "fatal", "panic", "timed out", "timeout",
      "killed", "terminated", "exit code 1", "exited with 2", "signal", "crash", "crashed", "unauthorized", "unauthorised", "rate limit", "overloaded",
    ];
    for (const word of words) assert.equal(allowlistedView(`it ${word} now`), `it ${word} now\n`, word);
    for (const near of ["panicky", "fatally", "terrorism", "errorless", "exit codes", "unauthorizeds"]) {
      assert.equal(allowlistedView(`it ${near} now`), "[... 1 line left out]\n", near);
    }
    assert.equal(allowlistedView("An ERROR happened"), "An ERROR happened\n");
  });

  it("keeps an error line, not the prose around it, and the host lines and tool names near it", () => {
    const view = allowlistedView("prose a\nBash(secret)\nthe claude-code process aborted\nAgent stopped\nprose b\n");
    assert.equal(view, "[... 1 line left out]\nBash(...)\nthe claude-code process aborted\nAgent stopped\n[... 1 line left out]\n");
  });

  it("cuts an error line at the line limit exactly, and never in the middle of a surrogate pair", () => {
    assert.equal(REPORT_LINE_LIMIT, 200);
    const line = (length: number) => `error ${" x".repeat(length)}`.slice(0, length);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT - 1)), `${line(REPORT_LINE_LIMIT - 1)}\n`);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT)), `${line(REPORT_LINE_LIMIT)}\n`);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT + 1)), `${line(REPORT_LINE_LIMIT)}\n`);
    const emoji = `error${"a ".repeat(96)}${String.fromCodePoint(0x1f600)} tail`;
    assert.equal(emoji.indexOf(String.fromCodePoint(0x1f600)), 197);
    const cutAtPair = allowlistedView(`error ${"a ".repeat(96)}x${String.fromCodePoint(0x1f600)} tail`).trimEnd();
    assert.ok(!/[\uD800-\uDBFF]$/.test(cutAtPair));
    assert.ok(!/[\uD800-\uDBFF]$/.test(allowlistedView(`${"error ".repeat(32)}${String.fromCodePoint(0x1f600)}${"x".repeat(5)}`).trimEnd()));
  });

  it("leaves out an error line with a run of token characters, at n-1, n and n+1", () => {
    assert.equal(REPORT_TOKEN_RUN, 24);
    const withRun = (length: number) => `error ${"A".repeat(length)}`;
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN - 1)), `${withRun(REPORT_TOKEN_RUN - 1)}\n`);
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN)), "[... 1 line left out]\n");
    assert.equal(allowlistedView(withRun(REPORT_TOKEN_RUN + 1)), "[... 1 line left out]\n");
    for (const ch of ["+", "/", "_", "=", "-", "9", "z"]) assert.equal(allowlistedView(`error ${ch.repeat(REPORT_TOKEN_RUN)}`), "[... 1 line left out]\n", ch);
  });

  it("leaves out an error line the caller's check holds, before the line is cut", () => {
    const secret = `error ${"x ".repeat(98)}hunter2`;
    assert.ok(secret.length > REPORT_LINE_LIMIT);
    assert.equal(allowlistedView(secret, (line) => line.includes("hunter2")), "[... 1 line left out]\n");
    assert.notEqual(allowlistedView(secret), "[... 1 line left out]\n");
  });

  it("keeps only the last REPORT_ERROR_LINES error lines", () => {
    assert.equal(REPORT_ERROR_LINES, 20);
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `error number ${i}`);
    assert.equal(allowlistedView(lines(REPORT_ERROR_LINES).join("\n")), `${lines(REPORT_ERROR_LINES).join("\n")}\n`);
    const over = allowlistedView(lines(REPORT_ERROR_LINES + 1).join("\n"));
    assert.ok(!over.includes("error number 0\n"));
    assert.ok(over.startsWith("[... 1 line left out]\nerror number 1\n"));
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
    assert.deepEqual(copyReviewerLogs("logs", fs, none, []), ["a-reviewer.log"]);
    assert.deepEqual(written, { "logs/report/a-reviewer.log": "aborted\n" });
  });

  it("never copies the pre-push review's log", () => {
    const { fs, written } = fakeFs({ "a-pre-push-reviewer.log": "aborted", "b-reviewer.log": "aborted" });
    assert.deepEqual(copyReviewerLogs("logs", fs, none, []), ["b-reviewer.log"]);
    assert.deepEqual(Object.keys(written), ["logs/report/b-reviewer.log"]);
  });

  it("makes no folder when there is no reviewer log", () => {
    const { fs, made } = fakeFs({ "a-backend.log": "other", "empty.txt": "" });
    assert.deepEqual(copyReviewerLogs("logs", fs, none, []), []);
    assert.deepEqual(made, []);
  });

  it("copies an empty log as an empty view", () => {
    assert.equal(copy(""), "\n");
  });

  // A log whose view is `length` characters: one error line starting with `prefix`, then host lines of 14 characters each.
  const logWithView = (length: number, prefix = "error") => {
    for (let hosts = 0; ; hosts++) {
      const errorLength = length - hosts * 14 - 1;
      if (errorLength > 200) continue;
      assert.ok(errorLength >= prefix.length, "no error line fits");
      const errorLine = (prefix + " x".repeat(errorLength)).slice(0, errorLength);
      const log = [errorLine, ...Array.from({ length: hosts }, () => "Agent started")].join("\n");
      assert.equal(allowlistedView(log).length, length);
      return log;
    }
  };

  it("keeps a view of n-1 and n characters whole and drops only the first character of n+1", () => {
    assert.equal(REPORT_LOG_LIMIT, 100_000);
    for (const length of [REPORT_LOG_LIMIT - 1, REPORT_LOG_LIMIT]) {
      const log = logWithView(length);
      assert.equal(copy(log), allowlistedView(log));
    }
    const log = logWithView(REPORT_LOG_LIMIT + 1);
    assert.equal(copy(log), allowlistedView(log).slice(1));
  });

  it("doesn't start the kept part on half of a surrogate pair, and drops that half", () => {
    const log = logWithView(REPORT_LOG_LIMIT + 6, `error${String.fromCodePoint(0x1f600)}`);
    const view = allowlistedView(log);
    assert.match(view[6]!, /[\uDC00-\uDFFF]/, "the cut does not land inside the pair");
    assert.equal(copy(log), view.slice(7));
    const whole = logWithView(REPORT_LOG_LIMIT + 5, `error${String.fromCodePoint(0x1f600)}`);
    assert.equal(copy(whole), allowlistedView(whole).slice(5));
  });

  it("leaves out an error line that holds a secret value or a token shape", () => {
    for (const leak of [
      "the run failed with hunter2hunter2",
      `error ${"sk-ant-"}oat01-${"A".repeat(30)}`,
      `error ghp_${"B".repeat(25)}`,
      `error github_pat_${"C".repeat(25)}`,
    ]) {
      assert.equal(copy(leak, ["hunter2hunter2"]), "[... 1 line left out]\n", leak);
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
      assert.equal(copy(leak), "[... 1 line left out]\n", JSON.stringify(leak));
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
    assert.deepEqual(copyReviewerLogs("logs", fs, (line) => warnings.push(line), []), ["b-reviewer.log"]);
    copyReviewerLogs("logs", { ...fs, list: () => { throw new Error("ENOENT"); } }, (line) => warnings.push(line), []);
    assert.equal(warnings.length, 2);
  });

  it("ignores a directory named like a log, which it can't read", () => {
    const warnings: string[] = [];
    const { fs, written } = fakeFs({ "dir-reviewer.log": "x" });
    copyReviewerLogs("logs", { ...fs, read: () => { throw new Error("EISDIR"); } }, (line) => warnings.push(line), []);
    assert.equal(warnings.length, 1);
    assert.deepEqual(written, {});
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
      assert.deepEqual(copyReviewerLogs("logs", undefined, () => undefined).sort(), ["a-reviewer.log", "b-reviewer.log"]);
      assert.equal(readFileSync(join(dir, "logs", "report", "a-reviewer.log"), "utf8"), "[... 1 line left out]\n");
      assert.equal(readFileSync(join(dir, "logs", "report", "b-reviewer.log"), "utf8"), "error plain\n");
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
      assert.deepEqual(copyReviewerLogs(dir, undefined, () => undefined, []), ["ok-reviewer.log"]);
      assert.ok(!existsSync(join(dir, "report", "link-reviewer.log")), "a symlinked log was copied");
      assert.equal(readFileSync(join(dir, "report", "ok-reviewer.log"), "utf8"), "the reviewer aborted\n");
      assert.ok(!existsSync(join(dir, "report", "ok-backend.log")));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
