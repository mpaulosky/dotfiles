// The local review's ledger and its stamp: what `/pre-push-review` found on a
// branch's diff, what became of each finding, and the check
// `scripts/gate.sh` runs so nothing is pushed that the review didn't pass.
// Most of the threads GitHub's reviewers open on a PR are about behaviour a
// review before the push could have caught, so the gate asks for one.
//
// A ledger is keyed by the branch's own changes against its merge base with
// origin/main: their patch, with blob ids, line numbers and hunk headers left
// out (see diffKey). The key finds the ledger; the check then makes sure HEAD
// is the reviewed commit, or that commit with a clean merge of main and
// nothing else (see isReviewedCode). So a merge of main that leaves every hunk
// the branch changed as it was keeps the review, close to the rule PR
// Auto-Merge and Claude Review apply on GitHub, and a new commit, a conflict
// resolution or a main change inside one of the branch's hunks needs a new
// one.
//
// Ledgers live under the clone's .git (`review/<key>.json`, see ledgerDir), so
// every worktree of the clone sees them and nothing is committed. Sandcastle's
// sandboxes see an empty read-only folder there instead (protectedGitMounts in
// host-safety.mts): ledgers hold accepted security findings, which are never
// published. They are a process aid, not a security boundary against the
// person: anyone who can push can write one, as anyone can push with
// --no-verify.
//
// Run as a script: `scripts/review.sh <command>` (see USAGE below). Sandcastle
// doesn't run this review yet; the module lives in .sandcastle/lib/ for its
// type-check and tests.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { plainText, visibleLetters } from "./plain-text.mts";
import { NOT_OWNED_BASELINE_PATHS, REPO_SLUG } from "./repo-config.mts";

// The variable that skips the review check, for the gate runs that come
// before or during the review: the skill's own (each round's), and every gate
// in Sandcastle's sandbox until its reviewer runs the same review.
export const SKIP_REVIEW_ENV = "GATE_SKIP_REVIEW";

// The key of a branch with no changes against its base: nothing to review.
export const EMPTY_DIFF_KEY = "empty";

// The branch the Baseline's re-Apply pushes (repo-ci-baseline's reapply.sh).
export const REAPPLY_BRANCH = "chore/reapply-baseline";

// The Owned Baseline files, as the Template ships them (a test in dotfiles
// keeps this list and template/owned the same). A re-Apply overwrites only
// these (and writes any Seed file the repository lacks, which is not on this
// list and needs a review), and they're reviewed in the Template's own PRs; a
// repository must never change them, so a review there could only raise
// findings nobody there may fix.
export const OWNED_PATHS = [
  ".github/workflows/*.yml",
  ".github/hooks/**",
  ".github/scripts/**",
  ".github/instructions/*.md",
  ".github/pull_request_template.md",
  ".claude/agents/pre-push-reviewer.md",
  ".claude/skills/pre-push-review/**",
  ".sandcastle/main.mts",
  ".sandcastle/lib/*.mts",
  ".sandcastle/critique-prompt.md",
  ".sandcastle/intake-prompt.md",
  ".sandcastle/tsconfig.json",
  ".sandcastle/.env.example",
  ".sandcastle/.gitignore",
  ".sandcastle/.markdownlint-cli2.jsonc",
  "scripts/gate.sh",
  "scripts/check-branch-name.sh",
  "scripts/check-git-hooks.sh",
  "scripts/check-pr-title.sh",
  "scripts/review.sh",
  "scripts/tests/**",
  "docs/PROCESS.md",
  ".editorconfig",
  ".gitignore",
  ".markdownlint-cli2.jsonc",
  ".yamllint.yml",
  "codecov.yml",
  "GitVersion.yml",
  "global.json",
] as const;

// The files under an Owned pattern that the Template doesn't supply: its Seed
// repo-config.mts, and the files the repository lists in repo-config.mts's
// NOT_OWNED_BASELINE_PATHS (its own workflows, scripts and Sandcastle tests).
export const NOT_OWNED: ReadonlySet<string> = new Set([".sandcastle/lib/repo-config.mts", ...NOT_OWNED_BASELINE_PATHS]);

// A glob from OWNED_PATHS as a regular expression: `**` crosses folders, `*`
// doesn't.
const globPattern = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
const ownedPatterns = OWNED_PATHS.map(globPattern);

// Whether `path` falls under one of the Owned patterns, Owned or not.
export const underOwnedPattern = (path: string) => ownedPatterns.some((pattern) => pattern.test(path));

// Whether `path` is an Owned Baseline file.
export const isOwnedPath = (path: string) => !NOT_OWNED.has(path) && underOwnedPattern(path);

// How much a finding matters, which decides what happens to it. `critical`:
// a bug in code that runs (src/, tests/, the repository's tooling, which
// decides what merges and releases, and build and dependency configuration),
// or new or changed behaviour with no test, fixed in the review behind a regression
// test, and blocking until it is fixed, or until the person accepts one left
// open for them. `warning`: a security weakness, whatever file it's in, which
// blocks until the person fixes or accepts it. `advisory`: everything else
// (docs, comments, prompts, conventions), fixed in the review too, which never
// blocks: one left for a person goes to the branch's follow-up issue.
export const SEVERITIES = ["critical", "warning", "advisory"] as const;

export type Severity = (typeof SEVERITIES)[number];

// One finding. `fixed` needs the regression test that pins it, or the reason
// it has none (a workflow or prose finding); `dismissed` needs the evidence
// that the reviewer was wrong, read from the code; `accepted` needs the reason
// a person accepted it; `open` waits for a person, or for the follow-up issue
// when it's Advisory.
const findingFields = z.object({
  id: z.string().regex(/^R[1-9]\d{0,5}$/, "ids are R1, R2, ... up to R999999, with no leading zero"),
  lens: z.string().trim().min(1),
  // A repository path: no markup or backtick, and no whitespace but single
  // spaces between its parts (the Template's own files sit under "Support For
  // New Projects/"), so it can't carry anything into the PR description that
  // plainText would have to undo: renderReport and the notes run it through
  // plainText, and a tab, newline or double space never gets that far.
  path: z.string().trim().min(1).regex(/^[^\s<>`]+( [^\s<>`]+)*$/, "a path has no whitespace but single spaces between its parts, and no <, > or backtick"),
  line: z.number().int().nonnegative(),
  summary: z.string().trim().min(1),
  status: z.enum(["fixed", "dismissed", "accepted", "open"]),
  test: z.string().trim().min(1).nullable(),
  reason: z.string().trim().min(1).nullable(),
  // The reviewer's suggested fix, kept for the follow-up issue's Advisory
  // findings (renderAdvisories); the agent gives the person deciding an open
  // Critical or Warning finding its fix in the skill's step 9.
  fix: z.string().trim().min(1).nullable().optional(),
});

function checkOutcome(finding: z.infer<typeof findingFields>, context: z.RefinementCtx): void {
  if (finding.status === "fixed" && finding.test === null && finding.reason === null) {
    context.addIssue({ code: "custom", message: `${finding.id} is fixed but names neither its test nor why it has none` });
  }
  if ((finding.status === "accepted" || finding.status === "dismissed") && finding.reason === null) {
    context.addIssue({ code: "custom", message: `${finding.id} is ${finding.status} without a reason` });
  }
}

// A finding a review records: triage must grade every one, and decide whether
// it's a security weakness. The grade alone doesn't decide what's published: a
// weakness misgraded Critical or Advisory under a lens that doesn't say
// security would reach the follow-up issue or the notes, so `security` is
// always given, and a security weakness is always a Warning. A finding whose
// lens names security is never Advisory: it would pass the check without a
// person deciding it, and go to the public follow-up issue.
// Its `fix` is always given, null when unused, and given for every open
// finding: the person deciding it, or the follow-up issue, needs it. A security
// weakness (isSecurity) is recorded fixed only with a test, which may name a
// gate check: a reason alone leaves it open.
export const findingSchema = findingFields
  .extend({ severity: z.enum(SEVERITIES), security: z.boolean(), fix: z.string().trim().min(1).nullable() })
  .strict()
  .superRefine(checkOutcome)
  .superRefine((finding, context) => {
    if (finding.status === "open" && finding.fix === null) {
      context.addIssue({ code: "custom", message: `${finding.id} is open without a suggested fix` });
    }
    // isSecurity is what the check and the notes use, so the agent-written `security` flag alone can't dodge this.
    if (finding.status === "fixed" && finding.test === null && isSecurity(finding)) {
      context.addIssue({ code: "custom", message: `${finding.id} is a security weakness recorded fixed without a test: name its test or gate check, or leave it open with its suggested fix` });
    }
    if (finding.security && finding.severity !== "warning") {
      context.addIssue({ code: "custom", message: `${finding.id} is a security weakness: grade it warning, not ${finding.severity}` });
    }
    if (finding.severity === "advisory" && /security/i.test(finding.lens)) {
      context.addIssue({ code: "custom", message: `${finding.id}'s lens names security, so it's a security weakness: grade it warning, not advisory` });
    }
  });

// A finding as stored. A ledger recorded before `severity` existed has none,
// nor a `fix`, and still parses, so check, accept, report and latest read it;
// one recorded before `security` existed, or by a version that graded
// findings without requiring the mark, has no `security` mark. A finding with no severity counts as a Warning (see
// severityOf), so it blocks until a person decides it, and one with no mark
// counts as a security finding (see isSecurity).
export const storedFindingSchema = findingFields
  .extend({ severity: z.enum(SEVERITIES).optional(), security: z.boolean().optional() })
  .strict()
  .superRefine(checkOutcome);

export type Finding = z.infer<typeof storedFindingSchema>;

// A finding's severity, a Warning when it has none.
export const severityOf = (finding: Finding): Severity => finding.severity ?? "warning";

// Whether a finding is a security weakness: one graded Warning, one whose lens
// names security whatever it was graded, or one triage didn't mark as no
// security weakness, so a misgraded or unmarked one isn't published. The report's mark,
// the notes, the follow-up issue and the check all ask this, so they never
// disagree.
export const isSecurity = (finding: Finding) =>
  finding.severity === "warning" || finding.security !== false || /security/i.test(finding.lens);

// Whether a finding blocks the push: open, and not Advisory, or a security
// finding whatever its grade.
const isBlocking = (finding: Finding) => finding.status === "open" && (severityOf(finding) !== "advisory" || isSecurity(finding));

// An agent type name, with the optional plugin namespace (plugin:agent). No dot: www.example would autolink in the PR body.
const reviewerAgentSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$/, "reviewerAgent is an agent type name");

// What the skill hands to `record`: the key and the HEAD `scripts/review.sh
// prepare` printed when the last round started, from the patch its reviewers
// read; how many rounds ran; and every finding this run raised, with its
// outcome. Never `accepted`: only a person running `scripts/review.sh accept`
// accepts a finding, on the ledger it was raised in, so no acceptance carries
// from one ledger to another.
export const reviewInputSchema = z
  .object({
    reviewedKey: z.string().min(1),
    reviewedHead: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "reviewedHead is the commit id prepare printed"),
    rounds: z.number().int().min(1),
    // The agent type that read the diff (pre-push-reviewer, or the one that
    // stood in for it), so the report and the notes show who reviewed.
    reviewerAgent: reviewerAgentSchema.optional(),
    findings: z.array(findingSchema),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.findings.map((finding) => finding.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length > 0) {
      context.addIssue({ code: "custom", message: `finding ids repeat: ${[...new Set(repeated)].join(", ")}` });
    }
    const accepted = input.findings.filter((finding) => finding.status === "accepted").map((finding) => finding.id);
    if (accepted.length > 0) {
      context.addIssue({
        code: "custom",
        message: `${accepted.join(", ")} can't be recorded as accepted: record it open, and the person accepts it with scripts/review.sh accept`,
      });
    }
  });

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const ledgerSchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1),
    branch: z.string(),
    base: z.string().min(1),
    head: z.string().min(1),
    recordedAt: z.string().min(1),
    rounds: z.number().int().min(1),
    reviewerAgent: reviewerAgentSchema.optional(),
    findings: z.array(storedFindingSchema),
    // The highest id any review of the branch had used when this one was
    // recorded, so a review that found nothing still holds the ids taken.
    lastId: z.number().int().min(0).optional(),
  })
  .strict();

export type Ledger = z.infer<typeof ledgerSchema>;

// The variables a hook sets, which would point a worktree's git at another
// checkout's, and the ones that change what `git diff` prints.
const hookGitVariables = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF"];

// Run git in `cwd` and return its stdout as bytes, with the hook variables
// dropped. Replace refs are off, so the review reads and keys commits as they
// are, not as a replace ref shows them.
function gitBytes(cwd: string, args: readonly string[]): Buffer {
  // GIT_ATTR_NOSYSTEM: not the machine's system-wide gitattributes file
  // either, which could mark text files binary for one person's review only.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" };
  for (const name of hookGitVariables) {
    delete env[name];
  }
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

const git = (cwd: string, ...args: string[]) => gitBytes(cwd, args).toString("utf8").trim();

// Whether `ancestor` is an ancestor of (or is) `commit`. A commit git doesn't
// have counts as not.
function isAncestor(cwd: string, ancestor: string, commit: string): boolean {
  try {
    gitBytes(cwd, ["merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}

// Where this branch left origin/main. Throws when there's no origin/main: the
// review can't say what the branch changed, so the check fails closed.
export function mergeBase(cwd: string): string {
  try {
    return git(cwd, "merge-base", "origin/main", "HEAD");
  } catch (error) {
    throw new Error("can't find where this branch left origin/main: run `git fetch origin main` first", { cause: error });
  }
}

// HEAD's commit id, resolved once so a key and the head a ledger records
// describe the same commit even if HEAD moves meanwhile.
export const headCommit = (cwd: string) => git(cwd, "rev-parse", "--verify", "HEAD^{commit}");

// The `git diff` settings the patch's text depends on, pinned, so a key
// depends on the two trees and not on whose config made it (the explicit
// prefixes also override diff.noprefix and diff.mnemonicPrefix). A binary file is
// keyed by its blob ids, not its compressed bytes, so zlib's settings don't
// matter either. core.bigFileThreshold is git's default, since a file above it
// is printed as binary and reviewPatch would refuse a text file the person's
// config made look like one. Submodules are never ignored: a pointer bump is
// a change to review. A different git version could still print a patch
// differently; that fails closed, with a new review.
const pinnedDiff = [
  "-c", "core.quotePath=true",
  "-c", "core.bigFileThreshold=512m",
  "-c", "core.attributesFile=/dev/null",
  "-c", "diff.relative=false",
  "-c", "diff.suppressBlankEmpty=false",
  "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--full-index",
  "--unified=3", "--inter-hunk-context=0", "--diff-algorithm=myers", "--no-indent-heuristic",
  "--submodule=short", "--ignore-submodules=none", "-O/dev/null", "--src-prefix=a/", "--dst-prefix=b/",
];

// The extensions of files that are binary by nature: only files named as one
// of these may have a NUL in their first 8000 bytes, and git then shows the
// reviewers only their names, so a source or text file with a stray NUL is
// refused. (A byte order mark, and a binary file turned into text, are refused
// whatever the name.) The list errs short: a binary file with another
// extension is refused, and the person adds it here.
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "avif", "bmp", "tif", "tiff", "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "jar", "nupkg", "snupkg",
  "wasm", "dll", "exe", "pdb", "so", "dylib", "bin", "db", "sqlite", "mp3", "mp4", "webm", "ogg", "wav", "mov",
]);

// The pinned patch of `head` against `base`: what the reviewers read. Throws
// when it shows text only as "Binary files differ", since the reviewers
// couldn't read it: a text file a diff attribute (in .gitattributes or the
// clone's info/attributes) marks binary, a binary file the branch turns into
// text, which git prints whole as binary because one side is, or UTF-16 or
// UTF-32 text (known by its byte order mark), whose NULs make it look binary,
// or a file with a NUL that isn't a binary format by its extension. A real
// binary file has a NUL byte in its first 8000 bytes, as git's own test for
// one does: a NUL past them doesn't make git print a text file as binary.
export function reviewPatch(cwd: string, base: string, head: string = headCommit(cwd)): Buffer {
  const patch = gitBytes(cwd, [...pinnedDiff, base, head]);
  const text = patch.toString("latin1");
  const absent = (blob: string | undefined) => blob === undefined || /^0+$/.test(blob);
  const binary = (blob: string | undefined) => !absent(blob) && gitBytes(cwd, ["cat-file", "blob", blob as string]).subarray(0, 8000).includes(0);
  for (const section of text.split(/^(?=diff --git )/m)) {
    if (!/^Binary files .* differ$/m.test(section)) continue;
    const [before, after] = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(section)?.slice(1) ?? [];
    const file = /^diff --git (.*)$/m.exec(section)?.[1] ?? "a file";
    const start = absent(after) ? Buffer.alloc(0) : gitBytes(cwd, ["cat-file", "blob", after as string]).subarray(0, 4);
    if ([[0xff, 0xfe], [0xfe, 0xff], [0, 0, 0xfe, 0xff]].some((bom) => Buffer.from(bom).equals(start.subarray(0, bom.length)))) {
      // Rewriting a file main already holds this way would look like binary
      // turned into text (below), so that file needs a new path.
      const where = absent(before) ? "" : " at a new path, and delete this one";
      throw new Error(`${file}: this text is UTF-16 or UTF-32, which git shows only as "Binary files differ", so the reviewers couldn't read it. Re-encode it as UTF-8${where}.`);
    }
    // A file git prints as binary that isn't a binary format may be text
    // with a stray NUL (R42): the bytes can't tell them apart, since one
    // invalid UTF-8 byte makes text look like a real binary file, so the
    // extension does.
    const extension = /\.([a-z0-9]+)"?$/i.exec(file)?.[1]?.toLowerCase() ?? "";
    if (!absent(after) && binary(after) && !BINARY_EXTENSIONS.has(extension)) {
      throw new Error(`${file}: this file holds a NUL byte, so git shows it only as "Binary files differ" and the reviewers couldn't read it, and its extension isn't a binary format's. Remove the NUL; or, for a real binary file, give it its format's extension (see BINARY_EXTENSIONS in review-ledger.mts).`);
    }
    // An emptied file has no text to read, so there's nothing hidden to refuse.
    const emptied = !absent(after) && gitBytes(cwd, ["cat-file", "blob", after as string]).length === 0;
    if (binary(before) && !absent(after) && !binary(after) && !emptied) {
      throw new Error(`${file}: the branch turns a binary file (or UTF-16 or UTF-32 text) into text, which git shows only as "Binary files differ", so the reviewers couldn't read the text. Add the text at a new path instead.`);
    }
    // Not for a deleted or emptied file either: the old text is on main and the new side has none.
    if (!absent(after) && !emptied && !binary(before) && !binary(after)) {
      throw new Error(`${file}: a diff attribute marks this text file binary, so the reviewers couldn't read its change. Remove the attribute.`);
    }
  }
  return patch;
}

// The ledger key of a patch: a SHA-256 of each file's part of it. A text
// file's `index` line (blob ids, which change when main changes another part
// of the same file) is left out and its hunk headers (line numbers, and the
// function names .gitattributes can change) are reduced to `@@`, leaving each
// hunk's context and changed lines: the branch's own change. A binary file
// has only its header, so its `index` line, with full blob ids, is kept.
export function patchKey(patch: Buffer): string {
  if (patch.length === 0) return EMPTY_DIFF_KEY;
  const hash = createHash("sha256");
  let section: Buffer[] = [];
  const flush = () => {
    const binary = section.some((line) => line.subarray(0, 13).toString("latin1") === "Binary files ");
    for (const line of section) {
      const text = line.subarray(0, 6).toString("latin1");
      if (!binary && text === "index ") continue;
      hash.update(!binary && text.startsWith("@@ ") ? Buffer.from("@@\n") : line);
    }
    section = [];
  };
  let start = 0;
  while (start < patch.length) {
    const newline = patch.indexOf(10, start);
    const end = newline === -1 ? patch.length : newline + 1;
    const line = patch.subarray(start, end);
    if (line.subarray(0, 11).toString("latin1") === "diff --git ") flush();
    section.push(line);
    start = end;
  }
  flush();
  return hash.digest("hex");
}

// The ledger key for `head`'s diff against `base`.
export const diffKey = (cwd: string, base: string, head: string = headCommit(cwd)) => patchKey(reviewPatch(cwd, base, head));

// Whether `head` is the code reviewed at `reviewedHead`: that commit, or it
// with a clean merge of `base` and nothing else. The key alone can't tell: an
// edit moved to an identical block elsewhere in a file keeps it. Anything git
// can't answer (a commit it doesn't have, a conflict) counts as not.
export function isReviewedCode(cwd: string, reviewedHead: string, base: string, head: string): boolean {
  if (head === reviewedHead) return true;
  try {
    const merged = git(cwd, "merge-tree", "--write-tree", reviewedHead, base).split("\n")[0];
    return merged === git(cwd, "rev-parse", `${head}^{tree}`);
  } catch {
    return false;
  }
}

// Whether this git has `merge-tree --write-tree` (2.38 and later), which
// isReviewedCode needs to see a merge of main as the reviewed code.
function mergeTreeWorks(cwd: string): boolean {
  const head = headCommit(cwd);
  try {
    git(cwd, "merge-tree", "--write-tree", head, head);
    return true;
  } catch {
    return false;
  }
}

// The folder ledgers live in, shared by every worktree of the clone: the
// review folder in the common directory git names.
export function ledgerDir(cwd: string): string {
  const common = git(cwd, "rev-parse", "--git-common-dir");
  return join(isAbsolute(common) ? common : join(cwd, common), "review");
}

const ledgerPath = (cwd: string, key: string) => join(ledgerDir(cwd), `${key}.json`);

// The ledger recorded for `key`, or undefined when there's none. Throws on a
// ledger that doesn't parse, naming it: a damaged ledger isn't a passed
// review.
export function readLedger(cwd: string, key: string): Ledger | undefined {
  const path = ledgerPath(cwd, key);
  if (!existsSync(path)) return undefined;
  try {
    return ledgerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`the review recorded at ${path} is damaged, so it doesn't count: run /pre-push-review again to record a new one`, { cause: error });
  }
}

// Write a ledger whole: to a file of its own, then renamed over the old one,
// so a reader never sees half a ledger.
function writeLedger(cwd: string, ledger: Ledger): void {
  const path = ledgerPath(cwd, ledger.key);
  const temporary = `${path}.${process.pid}.tmp`;
  // Owner-only: a ledger can hold accepted security findings.
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// Run `change` holding the review folder's lock, so two writers (a `record`
// and an `accept`) can't interleave. One lock for every key, not one per key:
// a record reads every review of the branch for the ids taken (takenIds), so a
// record on another diff mustn't write between that read and its own write.
// Fails at once, naming the lock, when another holds it.
function withLock<T>(cwd: string, change: () => T): T {
  mkdirSync(ledgerDir(cwd), { recursive: true, mode: 0o700 });
  chmodSync(ledgerDir(cwd), 0o700);
  const lock = join(ledgerDir(cwd), ".lock");
  let handle: number;
  try {
    handle = openSync(lock, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`another review command is writing a review; try again, or delete ${lock} if none is running`, { cause: error });
    }
    throw error;
  }
  try {
    return change();
  } finally {
    closeSync(handle);
    rmSync(lock, { force: true });
  }
}

// The nearest earlier review of this branch's own work: the ledger recorded
// at the commit nearest HEAD among HEAD's ancestors that main doesn't have.
// Context for the next review: its reviewers don't raise again what was fixed
// or dismissed, and raise again what was accepted or left open, for the person
// to decide for the new code. Nothing is carried from it. A file that doesn't
// read or parse is skipped.
export function latestLedger(cwd: string, base: string, head: string = headCommit(cwd)): Ledger | undefined {
  let latest: { ledger: Ledger; distance: number } | undefined;
  for (const { ledger, distance } of branchLedgers(cwd, base, head)) {
    if (latest === undefined || distance < latest.distance || (distance === latest.distance && ledger.recordedAt > latest.ledger.recordedAt)) {
      latest = { ledger, distance };
    }
  }
  return latest?.ledger;
}

// Every review recorded at one of the branch's own commits (HEAD's ancestors
// that main doesn't have), with how many commits each is behind HEAD.
function branchLedgers(cwd: string, base: string, head: string): { ledger: Ledger; distance: number }[] {
  const dir = ledgerDir(cwd);
  if (!existsSync(dir)) return [];
  const found: { ledger: Ledger; distance: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let ledger: Ledger;
    try {
      const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (!parsed.success) continue;
      ledger = parsed.data;
    } catch {
      continue;
    }
    if (!isAncestor(cwd, ledger.head, head) || isAncestor(cwd, ledger.head, base)) continue;
    found.push({ ledger, distance: Number(git(cwd, "rev-list", "--count", `${ledger.head}..${head}`)) });
  }
  return found;
}

// The highest id a review had taken, its own or one it held from earlier
// reviews; 0 for none.
const highestId = (ledger: Ledger | undefined): number =>
  Math.max(ledger?.lastId ?? 0, ...(ledger?.findings ?? []).map((finding) => Number(finding.id.slice(1))));

// The highest id the ledger at `key` or any review of the branch's own
// commits took; 0 for none.
export function takenIds(cwd: string, base: string, head: string = headCommit(cwd), key: string = diffKey(cwd, base, head)): number {
  let replaced: Ledger | undefined;
  try {
    replaced = readLedger(cwd, key);
  } catch {
    // A damaged ledger can't be accepted against, so its ids name nothing.
  }
  return Math.max(highestId(replaced), ...branchLedgers(cwd, base, head).map(({ ledger }) => highestId(ledger)));
}

// Record a review of HEAD's diff, replacing any ledger at the same diff.
// Refuses a dirty worktree, and a HEAD that isn't the code the last round
// reviewed: the review would vouch for code it never read. Also refuses any id
// at or below the highest the ledger it replaces or any earlier review of the
// branch's own commits took, so an id names one finding along the branch: a
// person who read a report before a review was recorded again can't accept a
// different finding by its id. (A rebase or an amend leaves the branch's
// earlier commits behind, and their ids with them, unless the diff is the same.)
export function recordReview(
  cwd: string,
  base: string,
  input: ReviewInput,
  now: Date = new Date(),
  taken: typeof takenIds = takenIds,
): Ledger {
  const parsed = reviewInputSchema.parse(input);
  const dirty = git(cwd, "status", "--porcelain", "--untracked-files=all");
  if (dirty !== "") {
    throw new Error(`the worktree has uncommitted changes, so the review can't vouch for HEAD:\n${dirty}`);
  }
  const head = headCommit(cwd);
  const key = diffKey(cwd, base, head);
  if (key !== parsed.reviewedKey || !isReviewedCode(cwd, parsed.reviewedHead, base, head)) {
    throw new Error("HEAD isn't the code the last review round read: commits landed after it started. Review again before recording.");
  }
  let ledger: Ledger = {
    version: 1,
    key,
    branch: git(cwd, "branch", "--show-current"),
    base,
    head,
    recordedAt: now.toISOString(),
    rounds: parsed.rounds,
    ...(parsed.reviewerAgent === undefined ? {} : { reviewerAgent: parsed.reviewerAgent }),
    findings: parsed.findings,
  };
  withLock(cwd, () => {
    const floor = taken(cwd, base, head, key);
    const reused = parsed.findings.filter((finding) => Number(finding.id.slice(1)) <= floor).map((finding) => finding.id);
    if (reused.length > 0) {
      throw new Error(`ids up to R${floor} are taken by earlier reviews of this branch, so ${reused.join(", ")} can't be used: number this run's findings after R${floor}`);
    }
    ledger = { ...ledger, lastId: Math.max(floor, highestId(ledger)) };
    writeLedger(cwd, ledger);
  });
  return ledger;
}

// Accept an open finding on the ledger for HEAD's diff, with the person's
// reason. A finding that isn't open stays as it is.
export function acceptFinding(cwd: string, base: string, id: string, reason: string): Ledger {
  if (reason.trim() === "") throw new Error("say why the finding is accepted");
  const key = diffKey(cwd, base);
  return withLock(cwd, () => {
    const ledger = readLedger(cwd, key);
    if (ledger === undefined) throw new Error("no review is recorded for this diff: run /pre-push-review first");
    const finding = ledger.findings.find((candidate) => candidate.id === id);
    if (finding === undefined) throw new Error(`the review has no finding ${id}`);
    if (finding.status !== "open") throw new Error(`${id} is already ${finding.status}`);
    finding.status = "accepted";
    finding.reason = reason.trim();
    writeLedger(cwd, ledgerSchema.parse(ledger));
    return ledger;
  });
}

export type ReviewCheck = { ok: boolean; message: string };

// The gate's review check: HEAD's diff has a recorded review with no open
// Critical or Warning finding. Three things pass without one: `GATE_SKIP_REVIEW=1` (that value
// only), a branch with no changes against the base, and a Baseline re-Apply
// on REAPPLY_BRANCH that changes only Owned files.
export function checkReview(cwd: string, base: string, env: NodeJS.ProcessEnv = process.env): ReviewCheck {
  if (env[SKIP_REVIEW_ENV] === "1") {
    return { ok: true, message: `Review check skipped (${SKIP_REVIEW_ENV}=1).` };
  }
  const head = headCommit(cwd);
  const key = diffKey(cwd, base, head);
  if (key === EMPTY_DIFF_KEY) return { ok: true, message: "No changes against origin/main to review." };
  if (git(cwd, "branch", "--show-current") === REAPPLY_BRANCH) {
    // The key's own pins: no renames (a file moved into an Owned folder is
    // still a change elsewhere), no ignored submodules, no relative paths, and
    // no trimming, so a name starting with a space keeps it. The raw form, not
    // just the names, because Apply only adds or overwrites regular files and
    // never deletes: a deleted Owned file, a symlink or a submodule under an
    // Owned path is not what a re-Apply writes, and is reviewed.
    const raw = gitBytes(cwd, ["-c", "diff.relative=false", "diff", "--raw", "--no-renames", "--ignore-submodules=none", "-z", base, head])
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry !== "");
    const changes: { status: string; mode: string; path: string }[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const [, mode = "", , , status = ""] = raw[index]!.split(" ");
      changes.push({ status, mode, path: raw[index + 1]! });
    }
    const writtenByApply = (change: { status: string; mode: string; path: string }) =>
      (change.status === "A" || change.status === "M") && (change.mode === "100644" || change.mode === "100755") && isOwnedPath(change.path);
    if (changes.length > 0 && changes.every(writtenByApply)) {
      return { ok: true, message: "A Baseline re-Apply that changes only Owned files: the Template's own review covers them." };
    }
  }
  const ledger = readLedger(cwd, key);
  if (ledger !== undefined && ledger.head !== head && !mergeTreeWorks(cwd)) {
    return {
      ok: false,
      message: `${git(cwd, "version")} can't check the review across a merge of main: that needs git 2.38 or later (merge-tree --write-tree). Upgrade git.`,
    };
  }
  if (ledger === undefined || !isReviewedCode(cwd, ledger.head, base, head)) {
    return { ok: false, message: "No review is recorded for this diff. Run /pre-push-review, which reviews, fixes and records it." };
  }
  const blocking = ledger.findings.filter(isBlocking);
  if (blocking.length > 0) {
    const lines = blocking.map((finding) => `  ${finding.id} ${severityOf(finding)} ${finding.path}:${finding.line} (${finding.lens}): ${finding.summary}`);
    return {
      ok: false,
      message: [
        `${blocking.length} review finding(s) wait for a person. Fix them and run /pre-push-review again, or the person you work for accepts each one (never an agent on their behalf):`,
        ...lines,
        '  scripts/review.sh accept <id> "<reason>"',
      ].join("\n"),
    };
  }
  const advisory = ledger.findings.filter((finding) => finding.status === "open").length;
  const followUp = advisory === 0 ? "" : ` ${advisory} Advisory finding(s) open for the follow-up issue.`;
  return { ok: true, message: `Reviewed clean: ${ledger.findings.length} finding(s), none blocking.${followUp}` };
}

// Reviewer and person text as one line of plain Markdown (plainText, in
// lib/plain-text.mts: no mention, reference, closing keyword, tag or code span gets
// through), with pipes escaped for a table cell.
const cell = (text: string) => plainText(text).replace(/\|/g, "\\|");

const where = (finding: Finding) => cell(`${finding.path}:${finding.line}`);

const severityHeadings: Record<Severity, string> = { critical: "Critical", warning: "Warning", advisory: "Advisory" };

// The review report: every finding, grouped by severity, where it is, what
// happened to it, and the test or reason behind that. A severity no finding
// has gets no section.
export function renderReport(ledger: Ledger): string {
  const header = `Review of ${ledger.branch === "" ? "HEAD" : cell(ledger.branch)} at ${ledger.head.slice(0, 12)}: ${ledger.rounds} round(s), ${ledger.findings.length} finding(s), reviewed by ${plainText(ledger.reviewerAgent ?? "an unrecorded agent")}.`;
  if (ledger.findings.length === 0) return `${header}\n\nNo findings.\n`;
  const sections = SEVERITIES.flatMap((severity) => {
    const rows = ledger.findings
      .filter((finding) => severityOf(finding) === severity)
      .map(
        (finding) =>
          `| ${finding.id} | ${cell(finding.lens)}${isSecurity(finding) ? " (security)" : ""} | ${where(finding)} | ${cell(finding.summary)} | ${finding.status} | ${cell(finding.test ?? finding.reason ?? "")} |`,
      );
    if (rows.length === 0) return [];
    return ["", `### ${severityHeadings[severity]}`, "", "| Id | Lens | Where | Finding | Status | Test or reason |", "| --- | --- | --- | --- | --- | --- |", ...rows];
  });
  return [header, ...sections, ""].join("\n");
}

// The markers around the PR description's `## Review notes`, so the section
// can be replaced without touching what follows it (`Fixes #`, the footer).
// The release blog drops HTML comments, so the markers don't reach the published
// notes.
export const REVIEW_NOTES_START = "<!-- review-notes -->";
export const REVIEW_NOTES_END = "<!-- /review-notes -->";

// The PR description's `## Review notes`, between its markers: the Critical and Advisory findings a
// person accepted, for people reading the PR. Security findings (see
// isSecurity: graded Warning, a lens naming security, or unmarked) are only
// counted, so the maintainer knows to wait for the
// private report. Claude Review reads the notes' accepted non-security findings on an owner's same-repo PR, but
// raises a security finding again (the notes only count it), and Copilot isn't known to read them, so
// a thread one opens on an accepted finding gets the same "Left for the
// owner." reply as every thread left for the owner (docs/PROCESS.md), which doesn't
// say which thread a security finding is on; the reason stays in the ledger
// and, for a finding that isn't a security one, in these notes. Empty when
// none was accepted and the reviewer was the pre-push-reviewer (or unrecorded).
export function renderReviewNotes(ledger: Ledger): string {
  const accepted = ledger.findings.filter((finding) => finding.status === "accepted");
  // An accepted security finding is a known weakness left as it is, and the
  // description becomes public release notes: it's tracked privately instead
  // (docs/SECURITY.md), and only counted here.
  const security = accepted.filter(isSecurity);
  const listed = accepted.filter((finding) => !security.includes(finding));
  const standIn = ledger.reviewerAgent !== undefined && ledger.reviewerAgent !== "pre-push-reviewer";
  if (accepted.length === 0 && !standIn) return "";
  const privately =
    security.length === 0
      ? []
      : ["", `${security.length} accepted security finding(s) are left out here and reported privately, as docs/SECURITY.md describes.`];
  const section = (...body: string[]) => [REVIEW_NOTES_START, "## Review notes", ...body, REVIEW_NOTES_END, ""].join("\n");
  const reviewer = standIn ? ["", `Reviewed by ${plainText(ledger.reviewerAgent ?? "")}, not the read-only pre-push-reviewer.`] : [];
  if (listed.length === 0) return section(...privately, ...reviewer);
  const lines = listed.map(
    (finding) => `- ${plainText(`${finding.path}:${finding.line}`)}: ${plainText(finding.summary)} Accepted: ${plainText(finding.reason ?? "")}`,
  );
  return section("", "The local review raised these and they were accepted, not changed:", "", ...lines, ...privately, ...reviewer);
}

// Which lines of a Markdown text are inside a fenced code block (the fence
// lines included), and whether one is still open at the end. A fence opens
// with ``` or ~~~, up to 3 spaces in or after a list item's marker, but not a
// ``` whose line has another backtick (that's a code span); it closes with a
// line of only the same character, at least as many.
function codeBlocks(lines: readonly string[]): { fenced: boolean[]; open: boolean } {
  let fence: string | undefined;
  const fenced = lines.map((line) => {
    if (fence === undefined) {
      const [, mark, rest] = /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/.exec(line) ?? [];
      if (mark === undefined || (mark[0] === "`" && (rest ?? "").includes("`"))) return false;
      fence = mark;
      return true;
    }
    const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
    if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) fence = undefined;
    return true;
  });
  return { fenced, open: fence !== undefined };
}

// A line that reads "Review notes" first, in any form a reader sees those
// words in: a heading of any kind, in a quote or a list, with emphasis, tags,
// character references or invisible characters (see visibleLetters).
const readsReviewNotes = (line: string) => visibleLetters(line).split(" ").some((reading) => reading.startsWith("reviewnotes"));

// A closing line (`Fixes #n`, `Closes #n` or `Resolves #n`), or the footer.
const isClosingLine = (line: string) => /^(?:fixes|closes|resolves) #\d+/i.test(line);
const isFooter = (line: string) => line.startsWith("🤖 Generated with");

// `body` with its Review notes section replaced by `notes` (renderReviewNotes'
// output; empty removes the section). A marker counts only as a line of its
// own, unindented and outside a code block, so one quoted in the text or shown
// in an example isn't taken for it. A body with no section gets one above its
// closing line (the last `Fixes`, `Closes` or `Resolves #n` that starts a
// paragraph), else above the footer, else at the end. Throws, rather than
// guess, on an empty body (a `gh pr view` that failed, which would publish
// the notes alone) or one that removing the section leaves empty, on a code
// block that never closes, on markers that don't make one pair, on a closing
// line or the footer inside the section (replacing it would delete them), and
// on any other line outside it that reads "Review notes", such as an unmarked
// section, which would otherwise stay beside the new one. CRLF, as GitHub may
// store a description, comes back as LF, and the result ends in one newline.
export function spliceReviewNotes(body: string, notes: string): string {
  const ask = (problem: string) =>
    new Error(`the PR description ${problem}, so its Review notes can't be replaced safely: show it to the person and ask the person what to keep`);
  if (body.trim() === "") throw ask("is empty");
  const lines = body.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const { fenced, open } = codeBlocks(lines);
  if (open) throw ask("has a code block that never closes");
  const outside = (test: (line: string, index: number) => boolean) =>
    lines.flatMap((line, index) => (!fenced[index] && test(line, index) ? [index] : []));
  const starts = outside((line) => line.trimEnd() === REVIEW_NOTES_START);
  const ends = outside((line) => line.trimEnd() === REVIEW_NOTES_END);
  if (starts.length > 1 || ends.length > 1) throw ask("has more than one Review notes section");
  if (starts.length !== ends.length || (starts[0] ?? 0) > (ends[0] ?? 0)) throw ask("has Review notes markers that don't make one pair");
  const [first, last] = [starts[0] ?? lines.length, ends[0] ?? -1];
  const unmarked = (index: number) => !fenced[index] && (index < first || index > last);
  if (outside((line, index) => unmarked(index) && readsReviewNotes(line)).length > 0) throw ask("has a Review notes section without markers");
  // A heading can span lines (setext text, an <h2> broken across two), so each
  // paragraph is read as one text as well, its line endings kept (a tag or a
  // blockquote's marker depends on them).
  let paragraph: string[] = [];
  for (const [index, line] of [...lines, ""].entries()) {
    if (index < lines.length && line.trim() !== "" && unmarked(index)) {
      paragraph.push(line);
      continue;
    }
    if (paragraph.length > 1 && readsReviewNotes(paragraph.join("\n"))) throw ask("has a Review notes section without markers");
    paragraph = [];
  }
  if (lines.slice(first, last + 1).some((line) => isClosingLine(line) || isFooter(line))) throw ask("has its closing line or footer inside the Review notes markers");
  const added = notes === "" ? [] : notes.replace(/\n+$/, "").split("\n");
  let start: number;
  let removed: number;
  if (starts.length === 1) {
    start = starts[0] as number;
    removed = (ends[0] as number) - start + 1;
    if (added.length === 0) {
      // Take one blank line with it, so no gap is left where it was.
      if (lines[start + removed] === "") {
        removed += 1;
      } else if (start > 0 && lines[start - 1] === "") {
        start -= 1;
        removed += 1;
      }
    }
  } else {
    if (added.length === 0) return `${lines.join("\n")}\n`;
    const closing = outside((line, index) => isClosingLine(line) && (index === 0 || lines[index - 1] === "")).at(-1);
    const footer = outside(isFooter).at(-1);
    start = closing ?? footer ?? lines.length;
    removed = 0;
    // A blank line between it and what it's added above, or after the text
    // it's added below.
    if (start === lines.length) {
      added.unshift("");
    } else {
      added.push("");
    }
  }
  lines.splice(start, removed, ...added);
  // The section was all the body held and nothing is accepted any more.
  if (lines.every((line) => line.trim() === "")) throw ask("would be empty without its Review notes");
  return `${lines.join("\n")}\n`;
}

// The patch of the fixes a later round reviews: `since`, the HEAD the round
// before read, to `head`. The reasons it can't be, as a message: a commit that
// isn't one of HEAD's, no round prepared in `dir`, a commit later than the
// HEAD the last prepare in `dir` printed (it would leave fixes unread; an
// earlier one only rereads more, as when a round is prepared twice), a merge
// of main since (the patch would hold main's changes), or no fixes at all.
function fixesPatch(cwd: string, dir: string, since: string, base: string, head: string): Buffer | string {
  if (!isAncestor(cwd, since, head)) {
    return `${since} isn't one of HEAD's commits: give the HEAD prepare printed in the round before. After an amend or a rebase there's none: start again at round 1 (prepare without <since>).`;
  }
  const headFile = join(dir, "head");
  const before = existsSync(headFile) ? readFileSync(headFile, "utf8").trim() : undefined;
  if (before === undefined || !isAncestor(cwd, since, before)) {
    return `${since} is later than the HEAD prepare printed in the round before (${before ?? "none in this folder"}): give that one, so no fix goes unread.`;
  }
  if (git(cwd, "merge-base", "origin/main", since) !== base) {
    return "main was merged in since the round before, so the fixes can't be told from main's changes: start again at round 1.";
  }
  const fixes = reviewPatch(cwd, since, head);
  if (fixes.length === 0) return `no fixes since ${since}: a later round follows a round that fixed something, after its fix commits.`;
  return fixes;
}

// The follow-up issue's list of the open Advisory findings, each with where it
// is, what goes wrong and the suggested fix, as plain Markdown (plainText: no
// mention, reference, closing keyword, tag or code span gets through), ending
// with the session marker. A finding isSecurity marks is left out, whatever
// its grade: the issue is public. Empty when there's none.
export function renderAdvisories(ledger: Ledger): string {
  const open = ledger.findings.filter((finding) => finding.status === "open" && severityOf(finding) === "advisory" && !isSecurity(finding));
  if (open.length === 0) return "";
  const lines = open.map((finding) => {
    const fix = finding.fix == null ? "" : ` Suggested fix: ${plainText(finding.fix)}`;
    return `- ${finding.id} ${plainText(`${finding.path}:${finding.line}`)}: ${plainText(finding.summary)}${fix}`;
  });
  const branch = ledger.branch === "" ? "HEAD" : plainText(ledger.branch);
  return [`Advisory findings from the local review of ${branch}, left for a follow-up:`, "", ...lines, "", "<!-- claude-session -->", ""].join("\n");
}

const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

// Whether `a` and `b` are one file, by path, symlink or hard link: `body`
// removes its output first, which would delete an input it names.
function sameFile(cwd: string, a: string, b: string): boolean {
  if (resolve(cwd, a) === resolve(cwd, b)) return true;
  try {
    const [first, second] = [statSync(resolve(cwd, a)), statSync(resolve(cwd, b))];
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

const USAGE = `Usage: scripts/review.sh <command>
  prepare <absolute dir> [<since>]
                         write HEAD's diff to <dir>/diff.patch for the reviewers, and with <since> (the HEAD
                         the round before printed) the fixes since to <dir>/fixes.patch; print the key, then HEAD
  key                    print the ledger key of HEAD's diff against origin/main
  check [<base>]         the gate's check: exit 1 unless HEAD's diff was reviewed clean
  record <file>          record a review from JSON ({ reviewedKey, reviewedHead, rounds, reviewerAgent, findings }); - reads stdin
  accept <id> <reason>   accept an open finding on HEAD's review
  report                 print HEAD's review report
  notes                  print the "## Review notes" section for the PR description
  advisory               print the follow-up issue's list of open Advisory findings
  body <in> <out>        write to <out> the PR description in <in> (- reads stdin) with its Review notes replaced;
                         <out> is removed first and written only on success
  latest                 print the nearest earlier review of this branch's work as JSON ({} when none)
  repo                   print this repository as OWNER/REPO, for GH_REPO (lib/repo-config.mts's REPO_SLUG)
  next                   print the first finding id this run may use`;

// Why `slug` isn't a repository gh can be told (GH_REPO), or undefined when it is: exactly OWNER/REPO, each
// part a GitHub name, with nothing around it. The Seed's unfilled owner-and-repo placeholder fails.
export function repoSlugProblem(slug: string): string | undefined {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) ? undefined : `REPO_SLUG in lib/repo-config.mts is ${JSON.stringify(slug)}, not OWNER/REPO.`;
}

// The command line. Returns the exit code: 0 only for a command that did
// what it was asked, so the gate can't pass on a failure.
export function main(args: readonly string[], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, slug: string = REPO_SLUG): number {
  const [command, ...rest] = args;
  const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  const fail = (text: string) => {
    process.stderr.write(`${text}\n`);
    return 1;
  };
  try {
    switch (command) {
      case "key":
        out(diffKey(cwd, mergeBase(cwd)));
        return 0;
      case "prepare": {
        // An absolute folder only: an empty shell variable would otherwise
        // write the diff somewhere no reviewer is told to look.
        if (rest[0] === undefined || !isAbsolute(rest[0])) return fail(USAGE);
        // One read of the patch gives both, so the key names exactly the text
        // the reviewers get.
        // A fixes patch is only ever this prepare's: an earlier round's would
        // have the reviewers read old fixes.
        rmSync(join(rest[0], "fixes.patch"), { force: true });
        const head = headCommit(cwd);
        const base = mergeBase(cwd);
        const patch = reviewPatch(cwd, base, head);
        const fixes = rest[1] === undefined ? undefined : fixesPatch(cwd, rest[0], rest[1], base, head);
        if (typeof fixes === "string") return fail(fixes);
        mkdirSync(rest[0], { recursive: true });
        writeFileSync(join(rest[0], "diff.patch"), patch);
        if (fixes !== undefined) writeFileSync(join(rest[0], "fixes.patch"), fixes);
        // The HEAD this round reads, for the next round's fixesPatch.
        writeFileSync(join(rest[0], "head"), `${head}\n`);
        out(`${patchKey(patch)}\n${head}`);
        return 0;
      }
      case "check": {
        const result = checkReview(cwd, rest[0] || mergeBase(cwd), env);
        if (!result.ok) return fail(result.message);
        out(result.message);
        return 0;
      }
      case "record": {
        if (rest[0] === undefined) return fail(USAGE);
        const text = readFileSync(rest[0] === "-" ? 0 : rest[0], "utf8");
        out(renderReport(recordReview(cwd, mergeBase(cwd), JSON.parse(text) as ReviewInput)));
        return 0;
      }
      case "accept": {
        const [id, ...reason] = rest;
        if (id === undefined || reason.length === 0) return fail(USAGE);
        out(renderReport(acceptFinding(cwd, mergeBase(cwd), id, reason.join(" "))));
        return 0;
      }
      case "report":
      case "notes":
      case "advisory": {
        const ledger = readLedger(cwd, diffKey(cwd, mergeBase(cwd)));
        if (ledger === undefined) return fail("No review is recorded for this diff.");
        if (command === "report") out(renderReport(ledger));
        else if (command === "notes") out(renderReviewNotes(ledger) || "No accepted findings.");
        else out(renderAdvisories(ledger) || "No open Advisory findings.");
        return 0;
      }
      case "body": {
        const [input, output] = rest;
        if (input === undefined || output === undefined || output === "-") return fail(USAGE);
        if (input !== "-" && sameFile(cwd, input, output)) return fail(`${output} is the input file: give the new description its own file.`);
        const existing = lstatOrUndefined(resolve(cwd, output));
        if (existing !== undefined && !existing.isFile() && !existing.isSymbolicLink()) return fail(`${output} exists and isn't a regular file.`);
        // Removed first, so a refusal leaves no file for `gh pr edit
        // --body-file` to publish, neither empty nor an earlier run's.
        rmSync(output, { force: true });
        const ledger = readLedger(cwd, diffKey(cwd, mergeBase(cwd)));
        if (ledger === undefined) return fail("No review is recorded for this diff.");
        const body = spliceReviewNotes(readFileSync(input === "-" ? 0 : input, "utf8"), renderReviewNotes(ledger));
        writeFileSync(output, body);
        out(`Wrote the PR description with its Review notes to ${output}.`);
        return 0;
      }
      case "latest": {
        const ledger = latestLedger(cwd, mergeBase(cwd));
        out(ledger === undefined ? "{}" : JSON.stringify(ledger, null, 2));
        return 0;
      }
      case "next":
        out(`R${takenIds(cwd, mergeBase(cwd)) + 1}`);
        return 0;
      case "repo": {
        // gh ignores an empty GH_REPO and falls back to its default repository, so a slug that isn't
        // OWNER/REPO fails here with a non-zero exit, and the skill stops its command chain on it.
        const problem = repoSlugProblem(slug);
        if (problem !== undefined) return fail(problem);
        out(slug);
        return 0;
      }
      default:
        return fail(USAGE);
    }
  } catch (error) {
    return fail(error instanceof z.ZodError ? `The review doesn't parse:\n${z.prettifyError(error)}` : String((error as Error).message ?? error));
  }
}

// Whether this module is the script being run. Real paths are compared, so a
// symlinked checkout still runs the command: a guard that silently didn't
// match would exit 0 and let the gate pass.
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
