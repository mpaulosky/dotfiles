// The reviewer logs a run keeps for its report artifact. A reviewer whose claude-code aborted left a
// 641-byte report and no log, so nothing named why. The artifact of a public repository can be
// downloaded by any signed-in user and GitHub masks secrets in step logs, not artifacts, so a log is
// copied only as its last part and only when nothing in the whole log, as written or with its escape
// codes and whitespace taken out, looks like a secret: a token shape, or one of the sandbox's secret values plain, reversed, hex,
// URL-encoded or base64. A reviewer run the host gave up on may still be
// writing its log, so a copy is a snapshot.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSandboxSecretInAnyForm, containsTokenShapeAnywhere } from "./sandbox-env.mts";

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

// The text with whitespace and every control, format (zero-width) and combining character taken out, so a secret an agent
// printed spaced out or wrapped across lines is whole again for the check.
function withoutSpacing(text: string): string {
  return text.replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "");
}

// The text with ANSI escapes (real, or written out as text), and JSON or C escape sequences written out as text
// (`\n`, `\u001b`, also with extra backslashes when JSON sits inside JSON), taken out before the spacing is, so a secret
// wrapped as JSON or split by a colour code is whole again. A real token holds no backslash.
function withoutEscapes(text: string): string {
  return withoutSpacing(
    text
      .replace(/\u001b\[[0-9:;<=>?]*[ -\/]*[@-~]/g, "")
      .replace(/\\+(?:u001b|x1b|033|e)\[[0-9:;<=>?]*[ -\/]*[@-~]/gi, "")
      .replace(/\\+(?:[nrtbfv0]|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})/g, ""),
  );
}

// The forms of a log the secret check looks at: as written, with the spacing out, and with the escapes out too. The escape
// strip takes the character after an escape's `[` as its end, so an escape written right before a wrapped token would take
// the token's first letter: the form without that strip keeps it.
function checkedForms(text: string): string[] {
  return [text, withoutSpacing(text), withoutEscapes(text)];
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
  secretIn: (text: string) => boolean = containsSandboxSecretInAnyForm,
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
        // The spaced-out forms have lost the word boundaries the token shapes need, so they are also checked without them. This leaves out a
        // log that quotes a bare token prefix in prose (`ghp_ followed by the rest`): over-redacting beats publishing a credential.
        const forms = checkedForms(text);
        const held = forms.some((form) => secretIn(form) || containsTokenShapeAnywhere(form));
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
