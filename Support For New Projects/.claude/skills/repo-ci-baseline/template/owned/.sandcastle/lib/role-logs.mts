// The reviewer logs a run keeps for its report artifact. A reviewer whose claude-code aborted left a
// 641-byte report and no log, so nothing named why. The artifact of a public repository can be
// downloaded by any signed-in user and GitHub masks secrets in step logs, not artifacts, so a log is
// copied only as its last part and only when nothing in the whole log, as written or with its escape
// codes and whitespace taken out, looks like a secret. A reviewer run the host gave up on may still be
// writing its log, so a copy is a snapshot.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSandboxSecret } from "./sandbox-env.mts";

// Where the copies go, under the logs directory the artifact step uploads.
export const REPORT_LOG_DIR = "report";

// The most of one log the artifact keeps: its end, where an abort shows.
export const REPORT_LOG_LIMIT = 100_000;

// What copyReviewerLogs needs from the outside world; tests pass a stub.
export type RoleLogFs = {
  list(dir: string): string[];
  read(path: string): string;
  mkdir(path: string): void;
  write(path: string, text: string): void;
};

// The text with ANSI escapes, whitespace, control and zero-width characters taken out, so a secret an
// agent printed spaced out, wrapped across lines or between escape codes is whole again for the check.
function squeezed(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "");
}

// The last REPORT_LOG_LIMIT characters of `text`, never starting on half of a surrogate pair.
function tailOf(text: string): string {
  if (text.length <= REPORT_LOG_LIMIT) return text;
  const tail = text.slice(-REPORT_LOG_LIMIT);
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

// Copy the end of each `*-reviewer.log` in `logsDir` to `<logsDir>/report/`, leaving out any log that
// holds a secret anywhere in it, not only in the part kept (a secret the cut splits would lose the
// prefix the check looks for), with a short note in its place. Never throws: it runs in the run's
// finally, and a missing log directory or an unreadable file is a warning. Returns the names it copied.
export function copyReviewerLogs(
  logsDir: string,
  fs: RoleLogFs = liveRoleLogFs,
  warn: (line: string) => void = console.error,
  secretIn: (text: string) => boolean = containsSandboxSecret,
): string[] {
  const copied: string[] = [];
  try {
    const names = fs.list(logsDir).filter((name) => name.endsWith("-reviewer.log"));
    if (names.length === 0) return copied;
    const outDir = join(logsDir, REPORT_LOG_DIR);
    fs.mkdir(outDir);
    for (const name of names) {
      try {
        const text = fs.read(join(logsDir, name));
        const held = secretIn(text) || secretIn(squeezed(text));
        fs.write(join(outDir, name), held ? "Left out: the log held something shaped like a secret.\n" : tailOf(text));
        copied.push(name);
      } catch (error) {
        warn(`Couldn't copy ${name} to the report: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    warn(`Couldn't copy the reviewer logs to the report: ${error instanceof Error ? error.message : String(error)}`);
  }
  return copied;
}

// The real filesystem, which copyReviewerLogs uses unless a test passes a stub.
export const liveRoleLogFs: RoleLogFs = {
  list: (dir) => readdirSync(dir),
  read: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, text) => writeFileSync(path, text),
};
