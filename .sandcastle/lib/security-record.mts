// The local, git-ignored record of security findings (`.security/` in the main checkout): one file per weakness, written
// by `scripts/review.sh record` and read by the two reviews by id, lens and path only. Nothing here is published.
//
// Why it exists: the review's ledgers (.git/review) hold findings per diff, and `latest` looks only at the same branch's
// commits, so a weakness one branch settled was raised again, and settled differently, on the next (one weakness took six
// rounds). An entry says the weakness, the policy that resolves it, what pins the policy, its status and where it came from,
// so a later branch reads the decision instead of remaking it. A policy that deserves a decision is promoted to docs/adr/
// by a person; nothing here does that.
//
// The directory is the main worktree's, not the current one's, so a review in any worktree reads and writes the same
// entries. It is git-ignored (the Template's .gitignore ignores `.security/*` but not its README) and never published: the
// follow-up issue, the PR's Review notes and the report never quote an entry, and Sandcastle's sandboxes see an empty
// read-only folder there (protectedRecordMounts in host-safety.mts). Entry text is data: a reviewer is handed an entry's id,
// lens, path and status only, never its words.
//
// The writers never throw for an environment problem (no main worktree, a symlinked directory, a directory git doesn't
// ignore, a write error): the ledger is what the gate checks, so a record that can't be written is a warning for the person,
// not a failed review.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainText } from "./plain-text.mts";
import type { Ledger } from "./review-ledger.mts";

// The directory's name, beside the main checkout's root.
export const SECURITY_DIR = ".security";

export type EntryStatus = "fixed" | "accepted" | "open";

// One entry as read back; `status` is "unknown" when the file's status can't be read, and such an entry never suppresses anything.
export type SecurityEntry = {
  id: string;
  file: string;
  path: string;
  status: EntryStatus | "unknown";
  lens: string;
  findingPath: string;
  fingerprint?: string;
};

// A finding as `record` hands it over.
export type SecurityInput = {
  id: string;
  lens: string;
  path: string;
  summary: string;
  status: "fixed" | "open";
  test: string | null;
  reason: string | null;
  fix: string | null;
  policy?: string | null;
  repeats?: string;
};

// What a call did: the entry files it wrote, the findings that repeated a weakness an entry held (and which entry),
// the entry each finding resolved to (written or repeated; finding id to entry id), and the problems it hit, as
// sentences for the person.
export type SecurityOutcome = { written: string[]; repeated: { finding: string; entry: string }[]; entries: Record<string, string>; warnings: string[] };

// The variables a hook sets, which would point a worktree's git at another checkout's.
const hookGitVariables = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"];

function git(cwd: string, args: readonly string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of hookGitVariables) {
    delete env[name];
  }
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// The main worktree's `.security`, found from any worktree of the clone, or undefined when there's no main worktree to
// hold it (a bare clone) or `cwd` isn't in a repository. The first entry of `git worktree list` is the main worktree.
export function securityDir(cwd: string): string | undefined {
  let fields: string[];
  try {
    fields = git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0");
  } catch {
    return undefined;
  }
  const [first, ...rest] = fields;
  if (first === undefined || !first.startsWith("worktree ")) return undefined;
  const block = rest.slice(0, Math.max(0, rest.indexOf("")));
  if (block.includes("bare")) return undefined;
  return join(first.slice("worktree ".length), SECURITY_DIR);
}

// The lens-free key of a weakness: path and summary, with the summary's case and spacing set aside, so the same
// finding worded with different spacing or capitals is the same weakness. Exact on purpose: a wrongly merged entry
// would hide a real weakness, while a reworded repeat only gets a second file (or names the entry in `repeats`).
export function fingerprint(path: string, summary: string): string {
  return createHash("sha256").update(`${path}\0${summary.toLowerCase().replace(/\s+/g, " ").trim()}`).digest("hex");
}

// An entry whose status can be read. One of unknown status never holds a weakness, so a hand edit can't hide a finding.
const holdsWeakness = (entry: SecurityEntry) => entry.status !== "unknown";

const isRegularFile = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;

const field = (text: string, name: string) => new RegExp(`^- ${name}: (.*)$`, "m").exec(text)?.[1]?.trim();

// The entries in `directory`, sorted by number. A file that isn't a regular file (a symlink, say) is not read, so
// nothing is followed out of the directory; a hand edit that leaves the status unreadable gives "unknown".
function entriesIn(directory: string): SecurityEntry[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const entries: SecurityEntry[] = [];
  for (const file of names) {
    const id = /^(\d+)-.*\.md$/.exec(file)?.[1];
    const path = join(directory, file);
    if (id === undefined || !isRegularFile(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const status = /^- Status: (fixed|accepted|open)\s*$/m.exec(text)?.[1] as EntryStatus | undefined;
    const print = /^- Fingerprint: ([0-9a-f]{64})\s*$/m.exec(text)?.[1];
    entries.push({
      id,
      file,
      path,
      status: status ?? "unknown",
      lens: field(text, "Lens") ?? "",
      findingPath: field(text, "Path") ?? "",
      ...(print === undefined ? {} : { fingerprint: print }),
    });
  }
  return entries.sort((a, b) => Number(a.id) - Number(b.id) || a.file.localeCompare(b.file));
}

// Every entry of the record, sorted by id; empty when the directory is missing, not a real directory, or there's no main
// worktree.
export function readEntries(cwd: string): SecurityEntry[] {
  const directory = securityDir(cwd);
  if (directory === undefined || !lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return entriesIn(directory);
}

// The number after the highest `NNNN-` file name in `directory` (any such name counts, whatever it is), padded to four digits.
function nextId(directory: string): string {
  const highest = Math.max(0, ...readdirSync(directory).flatMap((name) => /^(\d+)-/.exec(name)?.[1] ?? []).map(Number));
  return String(highest + 1).padStart(4, "0");
}

// A file-name slug from the summary: its first six words, lower-case, at most 48 characters.
function slugOf(summary: string): string {
  const words = summary.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");
  return words.slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "") || "finding";
}

// The `- PR:` value: the PR the review recorded, or that none was.
function prLine(context: { pr?: number; slug: string }): string {
  if (context.pr === undefined || !Number.isInteger(context.pr) || context.pr <= 0) return "none when recorded";
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.slug) ? `${context.slug}#${context.pr}` : String(context.pr);
}

const policyOf = (finding: SecurityInput) => plainText(finding.policy ?? finding.reason ?? finding.fix ?? "") || "None recorded.";

const pinOf = (finding: SecurityInput) =>
  plainText(finding.test ?? "") || (finding.status === "open" ? "Nothing yet: the entry is open." : "None recorded.");

// An entry's text. Every field goes through plainText, so a summary can't start a line that reads as a heading or a field.
function entryText(id: string, finding: SecurityInput, branch: string, context: { pr?: number; slug: string }): string {
  const weakness = plainText(finding.summary);
  return [
    `# ${id}: ${weakness.slice(0, 80)}`,
    "",
    `- Status: ${finding.status}`,
    `- Lens: ${plainText(finding.lens)}`,
    `- Path: ${plainText(finding.path)}`,
    `- Branch: ${plainText(branch)}`,
    `- PR: ${prLine(context)}`,
    `- Fingerprint: ${fingerprint(finding.path, finding.summary)}`,
    "",
    "## Weakness",
    "",
    weakness,
    "",
    "## Policy",
    "",
    policyOf(finding),
    "",
    "## Pinned by",
    "",
    pinOf(finding),
    "",
  ].join("\n");
}

// `text` with the body of its `## heading` section replaced.
function withSection(text: string, heading: string, body: string): string {
  const marker = `\n## ${heading}\n\n`;
  const start = text.indexOf(marker);
  if (start === -1) return `${text.replace(/\n*$/, "\n")}${marker}${body}\n`;
  const from = start + marker.length;
  const next = text.indexOf("\n## ", from);
  return `${text.slice(0, from)}${body}\n${next === -1 ? "" : text.slice(next)}`;
}

const withStatus = (text: string, status: EntryStatus) => text.replace(/^- Status: .*$/m, `- Status: ${status}`);

// Why `.security` can't be written under `main`, or undefined when it can: a symlink or file there would take an entry
// out of the directory, and one git doesn't ignore would show in `git status` (and fail the next record's clean check).
function directoryProblem(main: string, directory: string): string | undefined {
  const found = lstatSync(directory, { throwIfNoEntry: false });
  if (found !== undefined && !found.isDirectory()) return `${directory} isn't a real folder, so nothing is written to it. Inspect it and remove it.`;
  try {
    git(main, ["check-ignore", "-q", "--", `${SECURITY_DIR}/0000-probe.md`]);
    return undefined;
  } catch {
    return `${SECURITY_DIR}/ isn't git-ignored in ${main}; re-Apply the Baseline so its .gitignore has the line`;
  }
}

// Write the record's entries for `findings`: the security findings of a review, each recorded fixed or open. A finding
// that repeats a weakness an entry holds writes no second file: the entry a finding names in `repeats`, else the one with
// the same fingerprint. An open entry the weakness is now recorded fixed for is updated in place (status, policy and
// pin; its branch and PR stay where it was first raised); any other repeat leaves the entry as it is. Call it holding
// the ledger lock, so the numbering is safe across worktrees. Never throws.
export function recordSecurity(
  cwd: string,
  ledger: Pick<Ledger, "branch">,
  findings: SecurityInput[],
  context: { pr?: number; slug: string },
): SecurityOutcome {
  const outcome: SecurityOutcome = { written: [], repeated: [], entries: {}, warnings: [] };
  if (findings.length === 0) return outcome;
  try {
    const directory = securityDir(cwd);
    if (directory === undefined) {
      outcome.warnings.push("this clone has no main worktree (a bare repository), so no security entry is written");
      return outcome;
    }
    const main = join(directory, "..");
    const problem = directoryProblem(main, directory);
    if (problem !== undefined) {
      outcome.warnings.push(problem);
      return outcome;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to a folder it creates; the Seed's README makes the folder at checkout, with the umask's
    // mode, and the entries' file names (summary slugs) would be listable by other local users.
    chmodSync(directory, 0o700);
    const known = entriesIn(directory);
    for (const finding of findings) {
      const print = fingerprint(finding.path, finding.summary);
      let holder = known.find((entry) => holdsWeakness(entry) && entry.fingerprint === print);
      if (finding.repeats !== undefined) {
        const named = known.find((entry) => holdsWeakness(entry) && Number(entry.id) === Number(finding.repeats));
        if (named === undefined) outcome.warnings.push(`${finding.id} says it repeats ${finding.repeats}, but no entry has that number; recorded by its text instead`);
        else holder = named;
      }
      if (holder !== undefined) {
        outcome.repeated.push({ finding: finding.id, entry: holder.id });
        outcome.entries[finding.id] = holder.id;
        if (holder.status === "open" && finding.status === "fixed") {
          let text = withStatus(readFileSync(holder.path, "utf8"), "fixed");
          text = withSection(text, "Policy", policyOf(finding));
          text = withSection(text, "Pinned by", pinOf(finding));
          writeFileSync(holder.path, text);
          holder.status = "fixed";
        }
        continue;
      }
      const id = nextId(directory);
      const file = `${id}-${slugOf(finding.summary)}.md`;
      const path = join(directory, file);
      // "wx": never over a file that's there, whatever it is.
      writeFileSync(path, entryText(id, finding, ledger.branch, context), { flag: "wx", mode: 0o600 });
      outcome.written.push(file);
      outcome.entries[finding.id] = id;
      known.push({ id, file, path, status: finding.status, lens: finding.lens, findingPath: finding.path, fingerprint: print });
    }
  } catch (error) {
    outcome.warnings.push(`the security record couldn't be written: ${(error as Error).message ?? String(error)}`);
  }
  return outcome;
}

// Turn the entry that holds `finding`'s weakness accepted, with the person's reason, and return its id; undefined when
// nothing was accepted. The entry is the one `entryId` names (the one the finding was recorded against, which also covers
// a finding matched through `repeats` in other words), else the one with the finding's fingerprint. Only an open entry is
// changed: an accepted one is left as it is, and a fixed one, which other branches rely on, is left alone with a `warn`ing,
// since a branch-local acceptance mustn't downgrade it. Throws on a write error, which the caller reports.
export function markAccepted(
  cwd: string,
  finding: { path: string; summary: string },
  reason: string,
  entryId?: string,
  warn?: (message: string) => void,
): string | undefined {
  const entries = readEntries(cwd);
  const print = fingerprint(finding.path, finding.summary);
  const entry =
    (entryId === undefined ? undefined : entries.find((candidate) => holdsWeakness(candidate) && Number(candidate.id) === Number(entryId))) ??
    entries.find((candidate) => holdsWeakness(candidate) && candidate.fingerprint === print);
  if (entry === undefined) return undefined;
  if (entry.status === "accepted") return entry.id;
  if (entry.status !== "open") {
    warn?.(`${entry.id} is ${entry.status}, so it stays ${entry.status}: a fixed entry is a record other branches rely on`);
    return undefined;
  }
  const text = withSection(withStatus(readFileSync(entry.path, "utf8"), "accepted"), "Accepted", plainText(reason));
  writeFileSync(entry.path, text);
  return entry.id;
}

// The `security` command's output: a tab-separated line per entry of id, status, lens, finding path and file. Never an
// entry's words: the reviewer is handed these columns only, and the file is for the session to read itself.
export function renderSecurityList(entries: readonly SecurityEntry[]): string {
  if (entries.length === 0) return "No security entries.";
  return entries
    .map((entry) => [entry.id, entry.status, plainText(entry.lens), plainText(entry.findingPath), entry.path.replace(/[\t\r\n]/g, "?")].join("\t"))
    .join("\n");
}
