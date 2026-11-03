import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyReviewerLogs, REPORT_LOG_LIMIT, type RoleLogFs } from "./role-logs.mts";

function fakeFs(files: Record<string, string>, failOn?: string) {
  const written: Record<string, string> = {};
  const fs: RoleLogFs = {
    list: () => Object.keys(files),
    read: (path) => {
      if (failOn !== undefined && path.endsWith(failOn)) throw new Error("EACCES");
      return files[path.split("/").at(-1)!]!;
    },
    mkdir: () => undefined,
    write: (path, text) => void (written[path] = text),
  };
  return { fs, written };
}

describe("copyReviewerLogs", () => {
  it("copies only the reviewer logs into the report folder", () => {
    const { fs, written } = fakeFs({ "a-reviewer.log": "aborted", "a-backend.log": "other" });
    assert.deepEqual(copyReviewerLogs("logs", fs, () => undefined, () => false), ["a-reviewer.log"]);
    assert.deepEqual(written, { "logs/report/a-reviewer.log": "aborted" });
  });

  it("keeps only the end of a long log", () => {
    const { fs, written } = fakeFs({ "a-reviewer.log": `${"x".repeat(REPORT_LOG_LIMIT)}END` });
    copyReviewerLogs("logs", fs, () => undefined, () => false);
    const text = written["logs/report/a-reviewer.log"]!;
    assert.equal(text.length, REPORT_LOG_LIMIT);
    assert.ok(text.endsWith("END"));
  });

  it("leaves out a log with a secret in it, and says so", () => {
    const { fs, written } = fakeFs({ "a-reviewer.log": "token sk-ant-oat01-secret" });
    copyReviewerLogs("logs", fs, () => undefined, (text) => text.includes("sk-ant"));
    assert.ok(!written["logs/report/a-reviewer.log"]!.includes("sk-ant"));
    assert.match(written["logs/report/a-reviewer.log"]!, /Left out/);
  });

  it("warns and carries on when a log can't be read or the folder can't be listed", () => {
    const warnings: string[] = [];
    const { fs } = fakeFs({ "a-reviewer.log": "x", "b-reviewer.log": "y" }, "a-reviewer.log");
    assert.deepEqual(copyReviewerLogs("logs", fs, (line) => warnings.push(line), () => false), ["b-reviewer.log"]);
    copyReviewerLogs("logs", { ...fs, list: () => { throw new Error("ENOENT"); } }, (line) => warnings.push(line));
    assert.equal(warnings.length, 2);
  });
});
