// The reviewer logs a run keeps for its report artifact. A reviewer whose claude-code aborted left a
// 641-byte report and no log, so nothing named why. The artifact of a public repository can be
// downloaded by any signed-in user and GitHub masks secrets in step logs, not artifacts, and a log
// holds what an agent printed: model prose and command text anyone who can write an issue can steer.
// So a log is never copied whole. Only an allowlisted view is: the host's own status lines (the last few, the start line without its
// timestamp, since a forged line's digits are data), the name
// of each tool call without its arguments (only a known tool's name), and the few lines that name an
// error or an abort. An MCP tool is kept only as `mcp__(...)`. Those error lines are the one
// place free text gets through, so they are cut short, limited in number, and left out when they hold a
// long run of token characters (where an encoded secret would sit). Whatever the view still holds is
// checked for the sandbox's secret values and for token shapes, also with its spacing taken out, and a
// view that fails the check is replaced by a note. This narrows what can leave the sandbox in a log; it
// can't promise that a steered reviewer cannot get a few words of its own onto an error line.
// A reviewer run the host gave up on may still be writing its log, so a copy is a snapshot.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecret, sandboxSecrets } from "./sandbox-env.mts";

// Where the copies go, under the logs directory the artifact step uploads.
export const REPORT_LOG_DIR = "report";

// The most of one view the artifact keeps: its end, where an abort shows.
export const REPORT_LOG_LIMIT = 100_000;

// The most of one kept error line, so a long line can't carry much.
export const REPORT_LINE_LIMIT = 200;

// The most error lines of free text one view keeps (the last ones, where an abort shows), so a steered
// reviewer can't carry much out by printing the word `error` on many lines.
export const REPORT_ERROR_LINES = 20;

// The most host status lines one view keeps (the last ones): their numbers are the only data a line shaped like one can carry,
// and a real run prints a few per iteration.
export const REPORT_HOST_LINES = 30;

// A run of this many token characters in an error line (base64, hex, a key) leaves the line out.
export const REPORT_TOKEN_RUN = 24;

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
    String.raw`--- Run started: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ---`,
    String.raw`Iteration \d{1,3}/\d{1,3}`,
    String.raw`(?:Setting up sandbox|Collecting commits|Capturing session|Expanding shell expressions|No commits to sync out|Syncing \d{1,3} commits? to host)(?: done \(\d{1,3}(?:\.\d{1,2})?s\))?`,
    String.raw`Agent (?:started|stopped)`,
    String.raw`Agent signaled completion after \d{1,3} iteration\(s\)\.`,
    String.raw`Context window: \d{1,3}k`,
    String.raw`Reached max iterations \(\d{1,3}\)\.`,
    String.raw`Run complete: (?:agent finished after \d{1,3} iteration\(s\)|reached \d{1,3} iteration\(s\) without completion signal)\.`,
  ].join("|")})$`,
);

// The tools a role is given, the only names the view keeps. An MCP tool (`mcp__<server>__<tool>`) is kept as `mcp__(...)`,
// since the names there are free text.
const knownTool = /^(?:Bash|Read|Grep|Glob|Edit|MultiEdit|Write|NotebookEdit|Task|Agent|TodoWrite|WebFetch|WebSearch|Skill)$/;

// A tool call, which Sandcastle writes as `Name(arguments`, the arguments running over as many lines as they have. The name part
// is at most 77 characters, the longest an MCP tool's can be.
const toolCall = /^([A-Za-z][A-Za-z0-9_:.-]{0,76})\(/;

// A tool call line with its arguments left out, or undefined for a line that only looks like one (a code line in
// a heredoc, a prose line, a chunk of an encoded secret followed by a parenthesis).
function toolName(line: string): string | undefined {
  const name = toolCall.exec(line)?.[1];
  if (name === undefined) return undefined;
  if (knownTool.test(name)) return `${name}(...)`;
  return /^mcp__[A-Za-z0-9-]{1,30}__[A-Za-z0-9_-]{1,40}$/.test(name) ? "mcp__(...)" : undefined;
}

// A line that says a run went wrong, which the view keeps as free text (the last REPORT_ERROR_LINES of them) whoever wrote it.
const errorLine = /\b(?:abort(?:ed)?|error|errors|fail(?:ed|ure|ures)?|exception|fatal|panic|timed out|timeout|killed|terminated|exit(?:ed)? (?:code|with)|signal|crash(?:ed)?|unauthori[sz]ed|rate limit|overloaded)\b/i;

// A run of token characters long enough to be an encoded secret.
const tokenRun = new RegExp(`[A-Za-z0-9+/_=-]{${REPORT_TOKEN_RUN},}`);

// A token shape without the word boundaries, for the view with its spacing taken out, where a boundary can't hold.
const looseTokenShape = /sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;

// `text` cut to `limit` characters, never ending on half of a surrogate pair.
function cut(text: string, limit: number): string {
  const head = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(head) && text.length > limit ? head.slice(0, -1) : head;
}

// The allowlisted view of a reviewer log: its last REPORT_HOST_LINES host status lines and the names of its known tool calls, with a run
// of `[... N lines left out]` where anything else was. Of the lines that name an error, the last REPORT_ERROR_LINES
// are kept as free text cut to REPORT_LINE_LIMIT, unless one holds a run of REPORT_TOKEN_RUN token characters or
// `held` says it looks like a secret. Model prose, tool arguments and tool output are what it leaves out.
export function allowlistedView(text: string, held: (line: string) => boolean = () => false): string {
  const lines = text.split(/\r?\n/);
  const keep = new Array<string | undefined>(lines.length).fill(undefined);
  const errors: number[] = [];
  const hosts: number[] = [];
  lines.forEach((line, index) => {
    if (hostLine.test(line)) hosts.push(index);
    else {
      const tool = toolName(line);
      if (tool !== undefined) keep[index] = tool;
      else if (errorLine.test(line) && !tokenRun.test(line) && !held(line)) errors.push(index);
    }
  });
  // The start line's timestamp is free digits, so it is kept without it.
  for (const index of hosts.slice(-REPORT_HOST_LINES)) keep[index] = lines[index]!.startsWith("--- Run started") ? "--- Run started ---" : lines[index];
  for (const index of errors.slice(-REPORT_ERROR_LINES)) {
    keep[index] = cut(lines[index]!, REPORT_LINE_LIMIT);
  }
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
        const view = tailOf(allowlistedView(fs.read(join(logsDir, name)), (line) => looksLikeSecret(line, known)));
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
