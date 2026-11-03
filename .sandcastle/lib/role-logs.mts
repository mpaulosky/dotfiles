// The reviewer logs a run keeps for its report artifact. A reviewer whose claude-code aborted left a
// 641-byte report and no log, so nothing named why. The artifact of a public repository can be
// downloaded by any signed-in user and GitHub masks secrets in step logs, not artifacts, so a log is
// copied only as its last part and only when nothing in it looks like a secret.

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

export const liveRoleLogFs: RoleLogFs = {
  list: (dir) => readdirSync(dir),
  read: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, text) => writeFileSync(path, text),
};

// Copy the end of each `*-reviewer.log` in `logsDir` to `<logsDir>/report/`, leaving out any log that
// holds a secret (a short note takes its place). Never throws: it runs in the run's finally, and a
// missing log directory or an unreadable file is a warning. Returns the names it copied.
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
        const kept = text.length > REPORT_LOG_LIMIT ? text.slice(-REPORT_LOG_LIMIT) : text;
        fs.write(join(outDir, name), secretIn(kept) ? "Left out: the log held something shaped like a secret.\n" : kept);
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
