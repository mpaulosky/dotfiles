// The reviewer logs a run keeps for its report artifact. A reviewer whose claude-code aborted left a
// 641-byte report and no log, so nothing named why. The artifact of a public repository can be
// downloaded by any signed-in user and GitHub masks secrets in step logs, not artifacts, and a log
// holds what an agent printed: model prose and command text anyone who can write an issue can steer.
// So a log is never copied whole. Only an allowlisted view is: the host's own status lines (the last few, the start line without its
// timestamp, since a forged line's digits are data), the name
// of each of the last few tool calls without its arguments (only a known tool's name, an MCP tool as `mcp__(...)`), and the few lines that name an
// error or an abort. Those error lines are the one
// place free text gets through, so they are cut short, limited in number, and left out when they hold a
// long run of token characters (where an encoded secret would sit). Whatever the view still holds is
// checked for the sandbox's secret values and for token shapes, also with its spacing taken out, and a
// view that fails the check is replaced by a note. This narrows what can leave the sandbox in a log; it
// can't promise that a steered reviewer cannot get a few words of its own onto an error line.
// The output folder is emptied before it is written, in case an earlier run left files in it.
// A reviewer run the host gave up on may still be writing its log, so a copy is a snapshot. A log is read only as far as its last REPORT_INPUT_LIMIT
// bytes, since the view keeps the last lines of each kind and the sandbox chooses how long a log is; a view of a longer log starts with the left-out marker.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecret, sandboxSecrets } from "./sandbox-env.mts";

// The folder inside the run report's folder (lib/report.mts#REPORT_DIR) that holds the views.
export const REVIEWER_LOGS_NAME = "reviewer-logs";

// Where the views go for a run report folder: its own subfolder, so emptying it before a copy can't remove the report.
export function reviewerLogsDir(reportDir: string): string {
  return join(reportDir, REVIEWER_LOGS_NAME);
}

// The most of one kept error line, so a long line can't carry much.
export const REPORT_LINE_LIMIT = 200;

// The most error lines of free text one view keeps (the last ones, where an abort shows), so a steered
// reviewer can't carry much out by printing the word `error` on many lines.
export const REPORT_ERROR_LINES = 20;

// The most host status lines one view keeps (the last ones): their numbers are the only data a line shaped like one can carry,
// and a real run prints a few per iteration.
export const REPORT_HOST_LINES = 30;

// The most tool-call lines one view keeps (the last ones): which tool a line names is data a forged line can choose.
export const REPORT_TOOL_LINES = 30;

// A run of this many token characters in an error line (base64, hex, a key) leaves the line out.
export const REPORT_TOKEN_RUN = 24;

// The marker the view puts in place of a run of lines it left out, and in front of a log it cut to its last REPORT_INPUT_LIMIT bytes, so a reader
// can tell a cut log from a quiet one. No count: the number of lines an attacker printed would be data.
const LEFT_OUT = "[... lines left out]";

// How much of a reviewer log the host reads: its last REPORT_INPUT_LIMIT bytes (characters, in allowlistedView), starting at a whole line. The sandbox writes
// the log, so its size is the sandbox's choice, and the view keeps only the last lines of each kind, so reading more only costs the host memory in
// proportion to the log (the string, then a line array and a same-length keep array) while generating its report.
export const REPORT_INPUT_LIMIT = 4 * 1024 * 1024;

// `text` from its first whole line on: a text cut at its start begins in the middle of a line (or of a multi-byte character), so everything up to the
// first line break goes, and a text with no line break is left empty.
function fromWholeLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1);
}

// What copyReviewerLogs needs from the outside world; tests pass a stub.
export type RoleLogFs = {
  clear(path: string): void;
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

// The allowlisted view of a reviewer log, of its last REPORT_INPUT_LIMIT characters from a whole line (behind LEFT_OUT when it was longer):
// its last REPORT_HOST_LINES host status lines and the names of its last REPORT_TOOL_LINES known tool calls, with a
// `[... lines left out]` marker (no count) for each run of lines it left out. Of the lines that name an error, the last REPORT_ERROR_LINES
// are kept as free text cut to REPORT_LINE_LIMIT, unless one holds a run of REPORT_TOKEN_RUN token characters or
// `held` says it looks like a secret. Model prose, tool arguments and tool output are what it leaves out.
export function allowlistedView(text: string, held: (line: string) => boolean = () => false): string {
  // One character more than the limit, so a cut that lands on a line break leaves that line whole: the line break is the part dropped. A log
  // liveRoleLogFs.read already cut starts with the marker line, which this cut then drops (it reaches no further back than its own line break).
  const over = text.length > REPORT_INPUT_LIMIT;
  const bounded = over ? fromWholeLine(text.slice(-(REPORT_INPUT_LIMIT + 1))) : text;
  // The marker counts as a line left out, so the view starts with it whenever anything before the kept lines was dropped.
  const lines = `${over ? `${LEFT_OUT}\n` : ""}${bounded}`.split(/\r?\n/);
  const keep = new Array<string | undefined>(lines.length).fill(undefined);
  const errors: number[] = [];
  const hosts: number[] = [];
  const tools: number[] = [];
  lines.forEach((line, index) => {
    if (hostLine.test(line)) hosts.push(index);
    else {
      const tool = toolName(line);
      if (tool !== undefined) tools.push(index);
      else if (errorLine.test(line) && !tokenRun.test(line) && !held(line)) errors.push(index);
    }
  });
  // The start line's timestamp is free digits, so it is kept without it.
  for (const index of hosts.slice(-REPORT_HOST_LINES)) keep[index] = lines[index]!.startsWith("--- Run started") ? "--- Run started ---" : lines[index];
  for (const index of tools.slice(-REPORT_TOOL_LINES)) keep[index] = toolName(lines[index]!);
  for (const index of errors.slice(-REPORT_ERROR_LINES)) {
    keep[index] = cut(lines[index]!, REPORT_LINE_LIMIT);
  }
  const out: string[] = [];
  let left = 0;
  const flush = () => {
    if (left > 0) out.push(LEFT_OUT);
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

// Whether the view holds one of the secrets or a token shape, as written or with whitespace and control and format
// characters taken out (and ANSI colour codes first), so a token an error line printed spaced out or wrapped is whole again for the check.
function looksLikeSecret(view: string, secrets: readonly string[]): boolean {
  const spaceless = view.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "");
  return [view, spaceless].some((form) => containsSecret(form, secrets) || looseTokenShape.test(form));
}

// The file in the reviewers' folder that says which build each `reviewer-<n>.log` is, since the numbers carry no name.
export const REVIEWER_LOG_INDEX = "index.txt";

// The name Sandcastle gives a reviewer's log for a build's branch: the branch with the characters a file name can't hold replaced by a
// hyphen, then `-reviewer.log` (its buildLogFilename). A name that no longer matches this only leaves a log unlabelled in the index.
export function reviewerLogFileName(branch: string): string {
  return `${branch.replace(/[/\\:*?"<>|]/g, "-")}-reviewer.log`;
}

// The builds this run started, by the name of the reviewer log each one writes, so the index can say which build a numbered view is.
// Only the host's own issue numbers and branches go in, and only an issue number comes out: a log's name in the folder is whatever an
// agent that can write there chose, so it is looked up here and never printed. That lookup is by name, so an agent could name a file
// for another build's log and take its label: the label is a hint for a person reading a diagnostic, not proof of where a log came from.
export class BuildLogs {
  private readonly byFile = new Map<string, number>();

  add(issueNumber: number, branch: string): void {
    this.byFile.set(reviewerLogFileName(branch), issueNumber);
  }

  issueOf(fileName: string): number | undefined {
    return this.byFile.get(fileName);
  }
}

// The one record every build adds itself to.
export const buildLogs = new BuildLogs();

// Copy the allowlisted view of each `*-reviewer.log` in `logsDir` to `outDir`, as `reviewer-<n>.log` (reviewerLogsDir of the run report's folder, which is outside the checkout on Actions), with a short
// note in place of a view that looks like it holds a secret. The pre-push review's own logs, `*-pre-push-reviewer.log` and `*-pre-push-review-lead.log`,
// are not a Sandcastle role's and are never copied (the lead's lists the subagents' answers). Never throws: it runs in the run's finally, and an unreadable file
// or log directory is a warning (a directory that doesn't exist is no logs, and no warning).
// `secrets` defaults to the values .sandcastle/.env gives the sandbox, read once per call. Returns the names it wrote (`reviewer-<n>.log`), including a log it wrote the note for. Beside them it writes
// REVIEWER_LOG_INDEX, which says for each number the issue whose build wrote the log (from `builds`), or that the host started no build
// for it, and whether the view couldn't be copied. Each log is read only as far as its last REPORT_INPUT_LIMIT bytes (liveRoleLogFs.read).
export function copyReviewerLogs(
  logsDir: string,
  outDir: string,
  fs: RoleLogFs = liveRoleLogFs,
  warn: (line: string) => void = console.error,
  secrets?: readonly string[],
  builds: BuildLogs = buildLogs,
): string[] {
  const copied: string[] = [];
  try {
    // The folder the artifact uploads from is emptied first, whether or not a reviewer ran. It is outside the checkout, so no sandbox
    // can write into it; this only removes what an earlier run on the same machine left. If it can't be emptied nothing is written.
    try {
      fs.clear(outDir);
    } catch (error) {
      throw new Error(`the output folder could not be emptied, so nothing was written to it: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Sorted, so the numbers below don't depend on the order the filesystem lists in.
    const names = fs
      .list(logsDir)
      .filter((name) => name.endsWith("-reviewer.log") && !name.endsWith("-pre-push-reviewer.log"))
      .sort();
    if (names.length === 0) return copied;
    const known = secrets ?? [...sandboxSecrets().values()];
    fs.mkdir(outDir);
    // A view is written under a name the host makes, never the source's: the source name is whatever an agent that can write the logs
    // folder chose, and the content checks don't see it, so a file named for the sandbox's credential would put the credential in the
    // artifact's file list. The same goes for the warnings below, which reach the runner's public log. The number is the file's place
    // among the sorted names, and a log that can't be copied still takes its number.
    const index: string[] = [];
    names.forEach((name, position) => {
      const outName = `reviewer-${position + 1}.log`;
      const issue = builds.issueOf(name);
      const label = issue === undefined ? "a build this run did not start" : `issue #${issue}`;
      try {
        const view = allowlistedView(fs.read(join(logsDir, name)), (line) => looksLikeSecret(line, known));
        const held = looksLikeSecret(view, known);
        fs.write(join(outDir, outName), held ? "Left out: the view held something shaped like a secret.\n" : view);
        copied.push(outName);
        index.push(`${outName}: ${label}`);
      } catch (error) {
        // Only the error's code: its message names the path, and so the source file.
        const code = typeof (error as { code?: unknown })?.code === "string" ? ` (${(error as { code: string }).code})` : "";
        warn(`Couldn't copy reviewer log ${position + 1} to the report${code}`);
        index.push(`${outName}: ${label} (not copied)`);
      }
    });
    try {
      fs.write(join(outDir, REVIEWER_LOG_INDEX), `${index.join("\n")}\n`);
    } catch (error) {
      // Only the error's code, as for a view: its message names the path.
      const code = (error as { code?: unknown } | null)?.code;
      warn(`Couldn't write the index of the reviewer logs: ${typeof code === "string" ? code : "an error"}`);
    }
  } catch (error) {
    warn(`Couldn't copy the reviewer logs to the report: ${error instanceof Error ? error.message : String(error)}`);
  }
  return copied;
}

// A reviewer log's last REPORT_INPUT_LIMIT bytes, from a whole line, behind LEFT_OUT when the log was longer. `isRegular` is the check before the open: it
// refuses a symlink, device, FIFO, socket or directory without opening it (a device can have side effects when opened), on every platform. The open
// guards against the entry being swapped after that check, but only in part: O_NOFOLLOW refuses a symlink (ELOOP), O_NONBLOCK keeps the open of a
// FIFO from waiting for a writer (it does nothing to a regular file), O_NOCTTY keeps a terminal from becoming the host's controlling one, and fstat
// then refuses whatever was opened unless it is a regular file. A device node swapped in between the check and the open is still opened, and refused
// only after. The sandbox writes these logs, so it could win that race; it is accepted, since the host never reads the device and refuses it after the fstat. Windows has no O_NOFOLLOW, so there a swapped-in
// symlink is followed. `isRegular` is a parameter so a test can stand in the swap.
export function readLogTail(path: string, isRegular: (path: string) => boolean = (target) => lstatSync(target).isFile()): string {
  if (!isRegular(path)) throw new Error("not a regular file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    // One byte more than the limit when the log is over it, as in allowlistedView.
    const over = stat.size > REPORT_INPUT_LIMIT;
    const start = over ? stat.size - REPORT_INPUT_LIMIT - 1 : 0;
    const buffer = Buffer.alloc(stat.size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      // Zero is a log that shrank after fstat: what was read is what there is. No test reaches it without a race.
      if (count === 0) break;
      filled += count;
    }
    const text = buffer.subarray(0, filled).toString("utf8");
    return over ? `${LEFT_OUT}\n${fromWholeLine(text)}` : text;
  } finally {
    closeSync(fd);
  }
}

// The real filesystem, which copyReviewerLogs uses unless a test passes a stub.
// A log that isn't a regular file (a symlink to a host file, say) is refused, not followed.
export const liveRoleLogFs: RoleLogFs = {
  // A symlink at `path` is unlinked, not followed.
  clear: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  // A folder that isn't there is a run that started no role (the planner alone, say), so no logs, not a fault.
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") return [];
      throw error;
    }
  },
  read: (path) => readLogTail(path),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, text) => writeFileSync(path, text),
};
