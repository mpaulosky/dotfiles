import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allowlistedView,
  copyReviewerLogs,
  REPORT_ERROR_CONTEXT,
  REPORT_LINE_LIMIT,
  REPORT_LOG_LIMIT,
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

  it("keeps a tool call's name and drops its arguments, also over several lines", () => {
    const view = allowlistedView('Bash(cat > f <<\'EOF\'\nthe hidden body\nEOF\n)\nRead(/etc/passwd)\nmcp__x__y(a=1)');
    assert.match(view, /^Bash\(\.\.\.\)\n/);
    assert.ok(view.includes("Read(...)"));
    assert.ok(view.includes("mcp__x__y(...)"));
    assert.ok(!/hidden|passwd|cat > f|a=1/.test(view));
  });

  it("drops model prose and says how many lines it left out, once per run of them", () => {
    const view = allowlistedView("Agent started\nsome prose\nmore prose\n\nAgent stopped\nlast words");
    assert.equal(view, "Agent started\n[... 2 lines left out]\nAgent stopped\n[... 1 line left out]\n");
  });

  it("doesn't keep a line that only starts like a host line", () => {
    const view = allowlistedView("Agent started and then I printed my secret\nIteration 1/3 plus words\nRun complete: whatever");
    assert.ok(!/secret|plus|whatever/.test(view));
  });

  it("keeps the lines around an error line, cut to the line limit, and not the ones further away", () => {
    const lines = ["p1", "p2", "p3", "p4", "the claude-code process aborted", "p5", "p6", "p7", "p8"];
    const view = allowlistedView(lines.join("\n"));
    const kept = lines.filter((line) => view.split("\n").includes(line));
    assert.deepEqual(kept, ["p3", "p4", "the claude-code process aborted", "p5", "p6"]);
    assert.equal(REPORT_ERROR_CONTEXT, 2);
    assert.ok(allowlistedView(`${"e".repeat(REPORT_LINE_LIMIT + 50)} error`).split("\n")[0]!.length <= REPORT_LINE_LIMIT);
  });

  it("cuts a kept line at the line limit exactly", () => {
    const line = (length: number) => `error ${"x".repeat(length - 6)}`;
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT - 1)), `${line(REPORT_LINE_LIMIT - 1)}\n`);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT)), `${line(REPORT_LINE_LIMIT)}\n`);
    assert.equal(allowlistedView(line(REPORT_LINE_LIMIT + 1)), `${line(REPORT_LINE_LIMIT)}\n`);
  });

  it("keeps only the name of a tool call that sits next to an error", () => {
    const view = allowlistedView("Bash(echo secret-argument)\nthe run failed\n");
    assert.ok(view.includes("Bash(...)"));
    assert.ok(!view.includes("secret-argument"));
  });

  it("keeps a first-line-only error log, and reads CRLF lines", () => {
    assert.equal(allowlistedView("aborted"), "aborted\n");
    assert.equal(allowlistedView("Agent started\r\nAgent stopped\r\n"), "Agent started\nAgent stopped\n");
  });

  it("matches an error word only as a word, whatever its case", () => {
    assert.ok(allowlistedView("An ERROR happened").includes("ERROR"));
    assert.ok(!allowlistedView("terrorism and errorless").includes("terrorism"));
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

  it("keeps a view under the limit whole, and cuts a longer one to its last REPORT_LOG_LIMIT characters", () => {
    const log = (count: number) => Array.from({ length: count }, (_, i) => `Iteration ${i % 9}/9`).join("\n");
    const per = "Iteration 1/9\n".length;
    const fits = log(Math.floor(REPORT_LOG_LIMIT / per) - 1);
    assert.equal(copy(fits), allowlistedView(fits));
    const over = log(Math.ceil(REPORT_LOG_LIMIT / per) + 5);
    const cut = copy(over);
    assert.equal(cut.length, REPORT_LOG_LIMIT);
    assert.ok(allowlistedView(over).endsWith(cut));
  });

  it("doesn't start the kept part on half of a surrogate pair", () => {
    const line = `error ${String.fromCodePoint(0x1f600)}`;
    const many = Array.from({ length: Math.ceil(REPORT_LOG_LIMIT / 4) }, () => line).join("\n");
    for (const text of [many, `${many}\n`]) {
      assert.ok(!/^[\uDC00-\uDFFF]/.test(copy(text)));
    }
    const odd = copy(Array.from({ length: 30_000 }, () => `${String.fromCodePoint(0x1f600)} error`).join("\n"));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(odd));
  });

  it("leaves out a view that holds a secret value or a token shape, and says so", () => {
    for (const leak of [
      "the run failed with hunter2hunter2",
      `error ${"sk-ant-"}oat01-${"A".repeat(30)}`,
      `error ghp_${"B".repeat(25)}`,
      `error github_pat_${"C".repeat(25)}`,
    ]) {
      assert.match(copy(leak, ["hunter2hunter2"]), /^Left out: the view held something shaped like a secret\.\n$/, leak);
    }
  });

  it("leaves out a view whose token an error line printed spaced out, wrapped or between control characters", () => {
    const token = `ghp_${"D".repeat(25)}`;
    for (const leak of [
      `error ${token.split("").join(" ")}`,
      `error ${token.slice(0, 10)}\nfailed ${token.slice(10)}`,
      `error ${token.slice(0, 8)}​${token.slice(8)}`,
      `error ${token.slice(0, 8)}\u001b[0m${token.slice(8)}`,
    ]) {
      assert.match(copy(leak), /^Left out/, JSON.stringify(leak));
    }
  });

  it("publishes no secret that sits in prose or in a tool's arguments, whatever its form", () => {
    const secret = "hunter2hunter2";
    const base64 = Buffer.from(secret).toString("base64");
    const text = [
      "Agent started",
      `I will now print ${secret} and ${base64} and ${[...secret].reverse().join("")}`,
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
      assert.match(readFileSync(join(dir, "logs", "report", "a-reviewer.log"), "utf8"), /^Left out/);
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
