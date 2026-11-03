import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { containsEncodedSecret, containsSandboxSecret } from "./sandbox-env.mts";
import { copyReviewerLogs, REPORT_LOG_LIMIT, type RoleLogFs } from "./role-logs.mts";

function fakeFs(files: Record<string, string>, failOn?: string) {
  const written: Record<string, string> = {};
  const made: string[] = [];
  const fs: RoleLogFs = {
    list: () => Object.keys(files),
    read: (path) => {
      if (failOn !== undefined && path.endsWith(failOn)) throw new Error("EACCES");
      return files[path.split("/").at(-1)!]!;
    },
    mkdir: (path) => void made.push(path),
    write: (path, text) => void (written[path] = text),
  };
  return { fs, written, made };
}

const none = () => undefined;
const never = () => false;
const copy = (text: string, secretIn: (text: string) => boolean = never) => {
  const { fs, written } = fakeFs({ "a-reviewer.log": text });
  copyReviewerLogs("logs", fs, none, secretIn);
  return written["logs/report/a-reviewer.log"]!;
};

describe("copyReviewerLogs", () => {
  it("copies only the reviewer logs into the report folder", () => {
    const { fs, written } = fakeFs({ "a-reviewer.log": "aborted", "a-backend.log": "other" });
    assert.deepEqual(copyReviewerLogs("logs", fs, none, never), ["a-reviewer.log"]);
    assert.deepEqual(written, { "logs/report/a-reviewer.log": "aborted" });
  });

  it("makes no folder when there is no reviewer log", () => {
    const { fs, made } = fakeFs({ "a-backend.log": "other" });
    assert.deepEqual(copyReviewerLogs("logs", fs, none, never), []);
    assert.deepEqual(made, []);
  });

  it("keeps a log of n-1 and n characters whole, and drops only the first of n+1", () => {
    const text = (length: number) => `S${"x".repeat(length - 1)}`;
    assert.equal(copy(text(REPORT_LOG_LIMIT - 1)), text(REPORT_LOG_LIMIT - 1));
    assert.equal(copy(text(REPORT_LOG_LIMIT)), text(REPORT_LOG_LIMIT));
    const cut = copy(text(REPORT_LOG_LIMIT + 1));
    assert.equal(cut.length, REPORT_LOG_LIMIT);
    assert.ok(!cut.startsWith("S"));
  });

  it("keeps the end of a long log", () => {
    const text = copy(`${"x".repeat(REPORT_LOG_LIMIT)}END`);
    assert.equal(text.length, REPORT_LOG_LIMIT);
    assert.ok(text.endsWith("END"));
  });

  it("doesn't start the kept part on half of a surrogate pair", () => {
    const text = copy(`${String.fromCodePoint(0x1f600)}${"x".repeat(REPORT_LOG_LIMIT - 1)}`);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(text));
    assert.equal(text, "x".repeat(REPORT_LOG_LIMIT - 1));
  });

  it("leaves out a log with a secret in it, and says so", () => {
    const text = copy("token SECRET-VALUE-123", (t) => t.includes("SECRET-VALUE-123"));
    assert.match(text, /^Left out/);
    assert.ok(!text.includes("SECRET"));
  });

  it("leaves out a log whose secret the cut would split", () => {
    const secret = "SECRET-VALUE-123";
    const text = copy(`${secret}${"x".repeat(REPORT_LOG_LIMIT - 5)}`, (t) => t.includes(secret));
    assert.match(text, /^Left out/);
  });

  it("leaves out a log whose secret was printed spaced out, wrapped or between escape codes", () => {
    const secret = "SECRET-VALUE-123";
    const hasSecret = (t: string) => t.includes(secret);
    assert.match(copy("S E C R E T-VALUE-123", hasSecret), /^Left out/);
    assert.match(copy("SECRET-\nVALUE-\r\n123", hasSecret), /^Left out/);
    assert.match(copy("SECRET-\u001b[31mVALUE\u001b[0m-123", hasSecret), /^Left out/);
    assert.match(copy(`SEC${String.fromCodePoint(0x200b)}RET-VALUE-123`, hasSecret), /^Left out/);
  });

  it("leaves out a log whose secret was dropped in every kind of hidden or spacing character", () => {
    const secret = "SECRET-VALUE-123";
    const hasSecret = (t: string) => t.includes(secret);
    const between = [0xfeff, 0x2060, 0x0085, 0x2028, 0x2029, 0x200c, 0x200d, 0x200e, 0x200f, 0x007f, 0x00ad, 0x202e, 0x0301].map((code) => String.fromCodePoint(code));
    for (const hidden of [...between, "\t", "\u001b[?25l", "\u001b[1;31m"]) {
      assert.match(copy(`SECRET-${hidden}VALUE-123`, hasSecret), /^Left out/, JSON.stringify(hidden));
    }
  });

  it("still copies an ordinary log whose words are spaced and coloured", () => {
    const text = "the reviewer \u001b[31mfailed\u001b[0m\n  at step 3\n";
    assert.equal(copy(text, (t) => t.includes("SECRET-VALUE-123")), text);
  });

  it("with the real secret check, leaves out a token wrapped across lines or spaced out behind an ordinary word", () => {
    const run = (text: string) => copy(text, containsSandboxSecret);
    assert.match(run(`the token ghp_${"A".repeat(10)}\n${"A".repeat(16)}`), /^Left out/);
    assert.match(run(`my token g h p _${"A".repeat(30)}`), /^Left out/);
    assert.match(run(`see github_pat_${"B".repeat(12)}\n${"B".repeat(12)}`), /^Left out/);
    assert.match(run(`key sk-ant-oat01-${"C".repeat(8)}\n${"C".repeat(12)}`), /^Left out/);
    assert.equal(run("nothing secret here, just words\n"), "nothing secret here, just words\n");
  });

  it("with the real secret check, leaves out a wrapped token followed by a word with an underscore, or wrapped as JSON text", () => {
    const run = (text: string) => copy(text, containsSandboxSecret);
    assert.match(run(`the token ghp_${"A".repeat(10)}\n${"A".repeat(16)}\nsession_id: 5`), /^Left out/);
    assert.match(run(`ghp_${"A".repeat(10)}\\n${"A".repeat(16)}`), /^Left out/);
    assert.match(run(`ghp_${"A".repeat(10)}\\u001b[0m${"A".repeat(16)}`), /^Left out/);
    assert.match(run(`github_pat_${"B".repeat(10)}\\r\\n${"B".repeat(12)}`), /^Left out/);
  });

  it("leaves out a token wrapped with extra backslashes or split by a colon-form colour code, as text or with the real escape", () => {
    const run = (text: string) => copy(text, containsSandboxSecret);
    const head = `ghp_${"A".repeat(10)}`;
    const tail = "A".repeat(16);
    const esc = String.fromCharCode(27);
    assert.match(run(`${head}\\\\n${tail}`), /^Left out/);
    assert.match(run(`${head}\\\\\\u001b[0m${tail}`), /^Left out/);
    assert.match(run(`${head}${esc}[38:2::255:0:0m${tail}`), /^Left out/);
    assert.match(run(`${head}\\u001b[38:2::255:0:0m${tail}`), /^Left out/);
    assert.match(run(`${head}${esc}[?25l${tail}`), /^Left out/);
  });

  it("leaves out a wrapped token with an escape written right before it, which the escape strip would take a letter from", () => {
    const run = (text: string) => copy(text, containsSandboxSecret);
    const esc = String.fromCharCode(27);
    assert.match(run(`${esc}[ghp_${"A".repeat(10)}\n${"A".repeat(16)}`), /^Left out/);
    assert.match(run(`\\u001b[ghp_${"A".repeat(10)}\n${"A".repeat(16)}`), /^Left out/);
    assert.match(run(`\\x1b[github_pat_${"B".repeat(10)}\n${"B".repeat(12)}`), /^Left out/);
  });

  it("leaves out a token split by each kind of text escape, and keeps one split by something that is not an escape", () => {
    const run = (text: string) => copy(text, containsSandboxSecret);
    const head = `ghp_${"Z".repeat(10)}`;
    const tail = "Z".repeat(16);
    const text = (escape: string) => escape.replaceAll("@", "\\");
    const left = [
      "@x1b[0m", "@033[1;32m", "@e[0m", "@E[0m", "@u001B[0m", "@x1B[0m",
      "@u200b", "@u00a0", "@u00a0b", "@x41", "@x0a", "@t", "@r", "@n", "@b", "@f", "@v", "@0",
    ];
    for (const split of left.map(text)) assert.match(run(`${head}${split}${tail}`), /^Left out/, split);
    // One hex digit short (u00a, x0), or not an escape at all (q, an underscore, a bar), splits the token for good.
    for (const split of ["@u00a", "@x0", "@q", "@u12", "_", "|"].map(text)) {
      assert.equal(run(`${head}${split}${tail}`), `${head}${split}${tail}`, split);
    }
  });

  it("keeps an ordinary log with Windows paths and quoted regexes", () => {
    const log = "see C:@users@x and the regex @n@d+ in @e[0-9] and @u12 failed@n".replaceAll("@", "\\");
    assert.equal(copy(log, containsSandboxSecret), log);
  });

  it("leaves out a log holding the sandbox's secret reversed, in hex, URL-encoded or in base64, also wrapped across lines", () => {
    const secret = "s3cr3t-Value/with+chars=1234";
    const hasSecret = (t: string) => containsEncodedSecret(t, [secret]);
    const base64 = Buffer.from(`token=${secret}`).toString("base64");
    const wrapped = base64.match(/.{1,20}/g)!.join("\n");
    for (const form of [[...secret].reverse().join(""), Buffer.from(secret).toString("hex"), encodeURIComponent(secret), base64, wrapped]) {
      assert.match(copy(`the value was ${form} in the output`, hasSecret), /^Left out/, form);
    }
    assert.equal(copy("nothing to hide", hasSecret), "nothing to hide");
  });

  it("leaves out a log that only quotes a bare token prefix in prose, as the price of the wrapped-token check", () => {
    assert.match(copy("tokens starting with ghp_ followed by the rest of the string", containsSandboxSecret), /^Left out/);
    assert.equal(copy("tokens start with ghp_ and sk-ant-", containsSandboxSecret), "tokens start with ghp_ and sk-ant-");
  });

  it("warns and carries on when a log can't be read or the folder can't be listed", () => {
    const warnings: string[] = [];
    const { fs } = fakeFs({ "a-reviewer.log": "x", "b-reviewer.log": "y" }, "a-reviewer.log");
    assert.deepEqual(copyReviewerLogs("logs", fs, (line) => warnings.push(line), never), ["b-reviewer.log"]);
    copyReviewerLogs("logs", { ...fs, list: () => { throw new Error("ENOENT"); } }, (line) => warnings.push(line));
    assert.equal(warnings.length, 2);
  });

  it("uses the real filesystem and the real secret check by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "role-logs-"));
    try {
      writeFileSync(join(dir, "ok-reviewer.log"), "the reviewer aborted\n");
      writeFileSync(join(dir, "leak-reviewer.log"), `sk-ant-oat01-${"A".repeat(30)}\n`);
      writeFileSync(join(dir, "ok-backend.log"), "not copied\n");
      writeFileSync(join(dir, "target.txt"), "a host file\n");
      symlinkSync(join(dir, "target.txt"), join(dir, "link-reviewer.log"));
      mkdirSync(join(dir, "report"), { recursive: true });
      assert.deepEqual(copyReviewerLogs(dir, undefined, () => undefined).sort(), ["leak-reviewer.log", "ok-reviewer.log"]);
      assert.ok(!existsSync(join(dir, "report", "link-reviewer.log")), "a symlinked log was copied");
      assert.equal(readFileSync(join(dir, "report", "ok-reviewer.log"), "utf8"), "the reviewer aborted\n");
      assert.match(readFileSync(join(dir, "report", "leak-reviewer.log"), "utf8"), /^Left out/);
      assert.ok(!existsSync(join(dir, "report", "ok-backend.log")));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
