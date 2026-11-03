// The reviewer logs a run keeps for its report artifact. A reviewer whose claude-code aborted left a
// 641-byte report and no log, so nothing named why. The artifact of a public repository can be
// downloaded by any signed-in user and GitHub masks secrets in step logs, not artifacts, and a log
// holds what an agent printed: model prose and command text anyone who can write an issue can steer.
// So a log is never copied whole. Only an allowlisted view is: the host's own status lines, the name
// of each tool call without its arguments, and a few lines around any line that names an error or an
// abort. Whatever the view still holds is checked for the sandbox's secret values and for token
// shapes, also with its spacing taken out, and a view that fails the check is replaced by a note.
// A reviewer run the host gave up on may still be writing its log, so a copy is a snapshot.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecret, sandboxSecrets } from "./sandbox-env.mts";

// Where the copies go, under the logs directory the artifact step uploads.
export const REPORT_LOG_DIR = "report";

// The most of one view the artifact keeps: its end, where an abort shows.
export const REPORT_LOG_LIMIT = 100_000;

// The most of one kept line, so a long line of prose around an error can't carry much.
export const REPORT_LINE_LIMIT = 200;

// How many lines before and after a line that names an error or an abort the view keeps.
export const REPORT_ERROR_CONTEXT = 2;

// What copyReviewerLogs needs from the outside world; tests pass a stub.
export type RoleLogFs = {
  list(dir: string): string[];
  read(path: string): string;
  mkdir(path: string): void;
  write(path: string, text: string): void;
};

// The lines Sandcastle writes itself, matched whole, so a line of prose that only starts like one is not kept.
const hostLine = new RegExp(
  `^(?:${[
    String.raw`--- Run started: [0-9T:.Z-]+ ---`,
    String.raw`Iteration \d+/\d+`,
    String.raw`(?:Setting up sandbox|Collecting commits|Capturing session|Expanding shell expressions|No commits to sync out|Syncing \d+ commits? to host)(?: done \(\d+(?:\.\d+)?s\))?`,
    String.raw`Agent (?:started|stopped)`,
    String.raw`Agent signaled completion after \d+ iteration\(s\)\.`,
    String.raw`Context window: \d+k`,
    String.raw`Reached max iterations \(\d+\)\.`,
    String.raw`Run complete: (?:agent finished after \d+ iteration\(s\)|reached \d+ iteration\(s\) without completion signal)\.`,
  ].join("|")})$`,
);

// A tool call, which Sandcastle writes as `Name(arguments`, the arguments running over as many lines as they have.
const toolCall = /^([A-Za-z][A-Za-z0-9_:.-]{0,60})\(/;

// A tool call line with its arguments left out.
function toolName(line: string): string {
  return `${toolCall.exec(line)![1]}(...)`;
}

// A line that says a run went wrong, which the view keeps with its neighbours whoever wrote it.
const errorLine = /\b(?:abort(?:ed)?|error|errors|fail(?:ed|ure|ures)?|exception|fatal|panic|timed out|timeout|killed|terminated|exit(?:ed)? (?:code|with)|signal|crash(?:ed)?|unauthori[sz]ed|rate limit|overloaded)\b/i;

// A token shape without the word boundaries, for the view with its spacing taken out, where a boundary can't hold.
const looseTokenShape = /sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;

// The allowlisted view of a reviewer log: its host status lines and the names of its tool calls, with a run of
// `[... N lines left out]` where anything else was, and the lines around an error line cut to REPORT_LINE_LIMIT.
// Model prose, tool arguments and tool output are what it leaves out, since those are what a secret could ride in on.
export function allowlistedView(text: string): string {
  const lines = text.split(/\r?\n/);
  const keep = new Array<string | undefined>(lines.length).fill(undefined);
  lines.forEach((line, index) => {
    if (hostLine.test(line)) keep[index] = line;
    else if (toolCall.test(line)) keep[index] = toolName(line);
    if (errorLine.test(line)) {
      for (let near = Math.max(0, index - REPORT_ERROR_CONTEXT); near <= Math.min(lines.length - 1, index + REPORT_ERROR_CONTEXT); near++) {
        const neighbour = lines[near]!;
        if (neighbour.trim() === "") continue;
        keep[near] = toolCall.test(neighbour) ? toolName(neighbour) : neighbour.slice(0, REPORT_LINE_LIMIT);
      }
    }
  });
  const out: string[] = [];
  let left = 0;
  const flush = () => {
    if (left > 0) out.push(`[... ${left} line${left === 1 ? "" : "s"} left out]`);
    left = 0;
  };
  keep.forEach((kept, index) => {
    if (kept === undefined) {
      if (lines[index]!.trim() !== "") left++;
    } else {
      flush();
      out.push(kept);
    }
  });
  flush();
  return `${out.join("\n")}\n`;
}

// The last REPORT_LOG_LIMIT characters of `text`, never starting on half of a surrogate pair.
function tailOf(text: string): string {
  if (text.length <= REPORT_LOG_LIMIT) return text;
  const tail = text.slice(-REPORT_LOG_LIMIT);
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

// Whether the view holds one of the secrets or a token shape, as written or with whitespace and control and format
// characters taken out (and ANSI colour codes first), so a token an error line printed spaced out or wrapped is whole again for the check.
function looksLikeSecret(view: string, secrets: readonly string[]): boolean {
  const spaceless = view.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "");
  return [view, spaceless].some((form) => containsSecret(form, secrets) || looseTokenShape.test(form));
}

// Copy the allowlisted view of each `*-reviewer.log` in `logsDir` to `<logsDir>/report/`, keeping its end, with a short
// note in place of a view that looks like it holds a secret. The pre-push review's own log, `*-pre-push-reviewer.log`,
// is not a Sandcastle role's and is never copied. Never throws: it runs in the run's finally, and a missing log
// directory or an unreadable file is a warning. `secrets` defaults to the values .sandcastle/.env gives the sandbox,
// read once per call. Returns the names it wrote, including a log it wrote the note for.
export function copyReviewerLogs(
  logsDir: string,
  fs: RoleLogFs = liveRoleLogFs,
  warn: (line: string) => void = console.error,
  secrets?: readonly string[],
): string[] {
  const copied: string[] = [];
  try {
    const names = fs
      .list(logsDir)
      .filter((name) => name.endsWith("-reviewer.log") && !name.endsWith("-pre-push-reviewer.log"));
    if (names.length === 0) return copied;
    const known = secrets ?? [...sandboxSecrets().values()];
    const outDir = join(logsDir, REPORT_LOG_DIR);
    fs.mkdir(outDir);
    for (const name of names) {
      try {
        const view = tailOf(allowlistedView(fs.read(join(logsDir, name))));
        const held = looksLikeSecret(view, known);
        fs.write(join(outDir, name), held ? "Left out: the view held something shaped like a secret.\n" : view);
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
// A log that isn't a regular file (a symlink to a host file, say) is refused, not followed.
export const liveRoleLogFs: RoleLogFs = {
  list: (dir) => readdirSync(dir),
  read: (path) => {
    if (!lstatSync(path).isFile()) throw new Error("not a regular file");
    return readFileSync(path, "utf8");
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, text) => writeFileSync(path, text),
};
