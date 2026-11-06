// The reviewer logs a run keeps for its report artifact. A reviewer whose claude-code aborted left a
// 641-byte report and no log, so nothing named why. The artifact of a public repository can be
// downloaded by any signed-in user and GitHub masks secrets in step logs, not artifacts, and a log
// holds what an agent printed: model prose and command text anyone who can write an issue can steer.
// So a log is never copied whole. Only an allowlisted view is, and it is three sorted sets of fixed lines, not a sequence: which of the host's own status
// lines appeared (every number in them masked as `#`, the start line without its timestamp, since a forged line's digits are data), which known tools
// were called (a known tool's name without its arguments, an MCP tool as `mcp__(...)`), and which error words appeared (as the fixed message
// `[error line: timed out]`, never the line itself, so no word of a log's free text reaches the view: a secret printed with invisible fillers between its
// characters, or as spaced-out hex, can't get through a check that only knows the shapes it looks for). A line holding a long run of token
// characters is not an error line here, it is left out. A view says nothing of how often, in what order or after what a line appeared, and has one
// `[... lines left out]` line, first, when anything else was in the log (or the log was cut). Whatever the view holds is still checked for the sandbox's
// secret values and for token shapes, also with its spacing taken out, and a view that fails the check is replaced by a note. Only the logs of builds this
// run started are copied (a sandbox that can write the logs folder could add files of its own), at most REPORT_LOG_LIMIT of them. What a steered reviewer can
// still choose, in the log of its own build, is which of the fixed lines appear: about 30 host kinds, 15 tools and 26 error words, one bit each, so about 72 bits
// a log; no text, no number, no order and no count. The index says only which issue each log is, whether it was copied, and two fixed lines about logs left out.
// The output folder is emptied before it is written, in case an earlier run left files in it.
// A reviewer run the host gave up on may still be writing its log, so a copy is a snapshot. A log is read only as far as its last REPORT_INPUT_LIMIT
// bytes, since the sandbox chooses how long a log is and the host's memory grows with what it reads; a view of a longer log starts with the left-out marker.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecret, sandboxSecrets } from "./sandbox-env.mts";

// The folder inside the run report's folder (lib/report.mts#REPORT_DIR) that holds the views.
export const REVIEWER_LOGS_NAME = "reviewer-logs";

// Where the views go for a run report folder: its own subfolder, so emptying it before a copy can't remove the report.
export function reviewerLogsDir(reportDir: string): string {
  return join(reportDir, REVIEWER_LOGS_NAME);
}

// The most reviewer logs one run report copies (those of builds this run started, by sorted name), so the report's size doesn't depend on how many builds a
// run had; the rest are named in the index only by one fixed line saying more were not copied (no count).
export const REPORT_LOG_LIMIT = 20;

// A run of this many token characters in an error line (base64, hex, a key) leaves the line out.
export const REPORT_TOKEN_RUN = 24;

// The marker the view starts with when it left lines out, or the log was cut to its last REPORT_INPUT_LIMIT bytes, so a reader can tell a log with more in it
// from a quiet one. No count and no place: the number of lines an attacker printed, and where, would be data.
const LEFT_OUT = "[... lines left out]";

// How much of a reviewer log the host reads: its last REPORT_INPUT_LIMIT bytes (characters, in allowlistedView), starting at a whole line. The sandbox writes
// the log, so its size is the sandbox's choice, and reading more only costs the host memory in proportion to the log (the string, then a line array)
// while generating its report.
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

// A host status line with every number replaced by `#`: the numbers are free digits a forged line could use to carry a secret out, and the
// view says which kind of line ran, not how many.
function maskedHostLine(line: string): string {
  return line.replace(/\d+/g, "#");
}

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

// A line that says a run went wrong, whose word the view keeps as a fixed message, whoever wrote the line.
// It must keep no `g` or `y` flag (`test` and `exec` would then depend on lastIndex) and no `u` flag (a Unicode case-insensitive match
// lets U+017F or U+212A stand for `s` or `k`, and the message would copy them).
const errorLine = /\b(?:abort(?:ed)?|error|errors|fail(?:ed|ure|ures)?|exception|fatal|panic|timed out|timeout|killed|terminated|exit(?:ed)? (?:code|with)|signal|crash(?:ed)?|unauthori[sz]ed|rate limit|overloaded)\b/i;

// A run of token characters long enough to be an encoded secret.
const tokenRun = new RegExp(`[A-Za-z0-9+/_=-]{${REPORT_TOKEN_RUN},}`);

// A token shape without the word boundaries, for the view with its spacing taken out, where a boundary can't hold.
const looseTokenShape = /sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;

// The fixed message that stands for an error line: the error word it matched, which only ASCII letters and single spaces can spell
// (a case-insensitive match without the `u` flag never lets a non-ASCII character stand for an ASCII one), never the line. Only a line `errorLine` matched comes here.
function errorMessage(line: string): string {
  return `[error line: ${errorLine.exec(line)![0].toLowerCase()}]`;
}

// The allowlisted view of a reviewer log, of its last REPORT_INPUT_LIMIT characters from a whole line: the host status lines that appeared (numbers masked), the
// known tools called (names only) and the fixed `[error line: <word>]` messages for the error words that appeared, each set sorted and each line once.
// A line that holds a run of REPORT_TOKEN_RUN token characters, or that `held` says looks like a secret, is no error line. Model prose, tool arguments and tool
// output are left out, and `[... lines left out]` comes first when any was, or the log was cut.
export function allowlistedView(text: string, held: (line: string) => boolean = () => false): string {
  // One character more than the limit, so a cut that lands on a line break leaves that line whole: the line break is the part dropped.
  const over = text.length > REPORT_INPUT_LIMIT;
  const lines = (over ? fromWholeLine(text.slice(-(REPORT_INPUT_LIMIT + 1))) : text).split(/\r?\n/);
  let left = over;
  const hosts = new Set<string>();
  const tools = new Set<string>();
  const errors = new Set<string>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (hostLine.test(line)) {
      // The start line's timestamp is free digits, so it is kept without it.
      hosts.add(line.startsWith("--- Run started") ? "--- Run started ---" : maskedHostLine(line));
      continue;
    }
    const tool = toolName(line);
    if (tool !== undefined) tools.add(tool);
    else if (errorLine.test(line) && !tokenRun.test(line) && !held(line)) errors.add(errorMessage(line));
    else left = true;
  }
  const out = [...(left ? [LEFT_OUT] : []), ...[...hosts].sort(), ...[...tools].sort(), ...[...errors].sort()];
  return `${out.join("\n")}\n`;
}

// Whether the text holds one of the secrets or a token shape, as written or with whitespace and control and format
// characters taken out (and ANSI colour codes first), so a token printed spaced out or wrapped is whole again for the check. It runs on
// each error line (one that matched `errorLine` and holds no long run of token characters) before it is reduced to its fixed message (the `held`
// callback), and on the finished view as a second check.
function looksLikeSecret(view: string, secrets: readonly string[]): boolean {
  const spaceless = view.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "");
  return [view, spaceless].some((form) => containsSecret(form, secrets) || looseTokenShape.test(form));
}

// The file in the reviewers' folder that says which build each `reviewer-<n>.log` is, since the numbers carry no name.
export const REVIEWER_LOG_INDEX = "index.txt";

// The name Sandcastle gives a reviewer's log for a build's branch: the branch with the characters a file name can't hold replaced by a
// hyphen, then `-reviewer.log` (its buildLogFilename). A name that no longer matches this means the log is not copied at all (copyReviewerLogs copies only the logs a BuildLogs record knows).
export function reviewerLogFileName(branch: string): string {
  return `${branch.replace(/[/\\:*?"<>|]/g, "-")}-reviewer.log`;
}

// The builds this run started, by the name of the reviewer log each one writes, so the index can say which build a numbered view is and the report copies only the logs of these builds.
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

// The one record every build adds itself to. It says which build wrote each log, and so which logs the report copies.
export const buildLogs = new BuildLogs();

// Copy the allowlisted view of each `*-reviewer.log` in `logsDir` to `outDir`, as `reviewer-<n>.log` (reviewerLogsDir of the run report's folder, which is outside the checkout on Actions), with a short
// note in place of a view that looks like it holds a secret. The pre-push review's own logs, `*-pre-push-reviewer.log` and `*-pre-push-review-lead.log`,
// are not a Sandcastle role's and are never copied (the lead's lists the subagents' answers). Never throws: it runs in the run's finally, and an unreadable file
// or log directory is a warning (a directory that doesn't exist is no logs, and no warning).
// `secrets` defaults to the values .sandcastle/.env gives the sandbox, read once per call. Returns the names it wrote (`reviewer-<n>.log`), including a log it wrote the note for. Beside them it writes
// REVIEWER_LOG_INDEX, which says for each number the issue whose build wrote the log (from `builds`) and whether the view couldn't be copied. Only the logs of builds
// this run started are copied, at most REPORT_LOG_LIMIT of them by sorted name; the index ends with one fixed line (no count) for each of: more such logs than that,
// and other `*-reviewer.log` files in the folder, which a sandbox could have added. The returned names and the numbering cover only the copied logs. Each log is read only as far as its last REPORT_INPUT_LIMIT bytes (liveRoleLogFs.read).
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
    const all = fs
      .list(logsDir)
      .filter((name) => name.endsWith("-reviewer.log") && !name.endsWith("-pre-push-reviewer.log"))
      .sort();
    if (all.length === 0) return copied;
    // Only the logs of builds this run started are copied: a sandbox that can write the logs folder could add files of its own, and each view is
    // a few dozen bits it would choose, so copying them would multiply the channel by a number it picks.
    const names = all.filter((name) => builds.issueOf(name) !== undefined);
    const unknown = names.length < all.length;
    const omitted = names.length > REPORT_LOG_LIMIT;
    names.splice(REPORT_LOG_LIMIT);
    const known = secrets ?? [...sandboxSecrets().values()];
    fs.mkdir(outDir);
    // A view is written under a name the host makes, never the source's: the source name is whatever an agent that can write the logs
    // folder chose, and the content checks don't see it, so a file named for the sandbox's credential would put the credential in the
    // artifact's file list. The same goes for the warnings below, which reach the runner's public log. The number is the file's place
    // among the copied logs' sorted names, and a log that can't be copied still takes its number.
    const index: string[] = [];
    names.forEach((name, position) => {
      const outName = `reviewer-${position + 1}.log`;
      const label = `issue #${builds.issueOf(name)}`;
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
    if (omitted) index.push(`more than ${REPORT_LOG_LIMIT} reviewer logs: the rest were not copied`);
    if (unknown) index.push("other reviewer logs in the folder were not copied: no build of this run wrote them");
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
// only after. The sandbox writes these logs, so it could win that race and have the device opened (O_NONBLOCK and O_NOCTTY limit what an open does).
// That is accepted: fstat refuses the node before any read. Windows has no O_NOFOLLOW, so there a swapped-in
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
