// The host-side half of the pre-push review for a branch Sandcastle built: the reviewers (the Bar and one per lens
// whose files match), the triage of their findings, the backend role's fixes and the rounds that follow them, and the
// record. Only the host records; no agent gets a shell, a token or the ledger. The rounds follow the pre-push-review
// skill's steps 4 to 8 (.claude/skills/pre-push-review/SKILL.md), and host-review.test.mts fails when the skill's lens table,
// reviewer or round limit changes without this module following.

import { z } from "zod";
import { isRoleTimeout } from "./agents.mts";
import { MAX_REVIEWERS_PER_ROUND, REVIEW_FIX_ROUNDS, REVIEW_WALL_CLOCK_MINUTES, REVIEWER_ATTEMPTS } from "./config.mts";
import { TimeBudgetStopError, UncountedStopError } from "./errors.mts";
import { decisionsMarkdown, reviewerPrompt, reviewFixPrompt } from "./host-review-prompts.mts";
import { plainText } from "./plain-text.mts";
import { FINDING_PATH_SHAPE, isSecurity, severityOf, type Ledger, type PreparedRound, type ReviewInput } from "./review-ledger.mts";

// One row of lenses.md's table (or of a repo's own lenses table).
export type Lens = { name: string; appliesTo: string; row: string };

// Reads the `| Lens | Applies to | Ask |` table. Throws when it finds none, or a row with fewer than three cells: a lens
// the host half-read would be reviewed wrongly, so it fails closed.
export function parseLensTable(markdown: string): Lens[] {
  const lines = markdown.split("\n").map((line) => line.trim());
  const cells = (line: string) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const header = lines.findIndex((line) => line.startsWith("|") && /^lens$/i.test(cells(line)[0] ?? "") && /^applies to$/i.test(cells(line)[1] ?? ""));
  if (header < 0) throw new Error("no `| Lens | Applies to | Ask |` table found");
  const lenses: Lens[] = [];
  // The separator line follows the header; the table ends at the first line that isn't a row.
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const [name, appliesTo, ...ask] = cells(line);
    if (name === undefined || appliesTo === undefined || ask.join("|") === "" || name === "") {
      throw new Error(`a row of the lens table has fewer than three cells: ${line.slice(0, 80)}`);
    }
    lenses.push({ name, appliesTo, row: line });
  }
  if (lenses.length === 0) throw new Error("the lens table has no rows");
  return lenses;
}

// Whether a path is code: not prose. Comments live in code, so a lens about docs still reads it.
const isCode = (path: string) => !/\.(?:md|txt)$/i.test(path);
const under = (folder: string) => (path: string) => path.startsWith(`${folder}/`) || path.includes(`/${folder}/`);

// For each lens lenses.md names, the "Applies to" text the table holds and the paths the host reviews it for. Where the
// table speaks of content ("shared state", "async code") the host is generous: reviewing too much is the safe side.
// A lens in a table with no entry here (a repo's own) runs for every changed file.
// One deliberate difference from the skill, which gives a Markdown-only diff just the Docs and Repo conventions reviewers: the Security lens also
// reads Markdown under .claude/ and .sandcastle/ here, since an unattended branch could use it to widen what an agent may do.
export const LENS_APPLIES: Record<string, { appliesTo: string; matches(path: string): boolean }> = {
  "Edge cases": { appliesTo: "Any code", matches: isCode },
  "Races and caches": { appliesTo: "Shared state, caches, async code, Sandcastle runs", matches: isCode },
  "Error contract": { appliesTo: "Handlers, services, components showing errors", matches: isCode },
  "Blazor lifecycle": { appliesTo: "`.razor`, `.razor.cs`", matches: (path) => /\.razor(?:\.cs)?$/.test(path) },
  // Prose that steers an agent (an agent's tool list, a skill, a rule, a role prompt) is security-relevant too: a change to it can widen what an agent that
  // holds a shell and a token may do, so the Security lens reads the folders that hold it even when the files are Markdown.
  Security: { appliesTo: "Pages, endpoints, auth, workflows, scripts", matches: (path) => isCode(path) || under(".claude")(path) || under(".sandcastle")(path) },
  Tests: { appliesTo: "Any behaviour change", matches: isCode },
  "Docs match the code": { appliesTo: "Comments, `README.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/`, prompts", matches: () => true },
  "Sandcastle host": { appliesTo: "`.sandcastle/`", matches: under(".sandcastle") },
  Shell: { appliesTo: "`*.sh`, hooks", matches: (path) => path.endsWith(".sh") || under(".github/hooks")(path) },
  "GitHub Actions": { appliesTo: "`.github/workflows/`, `.github/scripts/`", matches: (path) => under(".github/workflows")(path) || under(".github/scripts")(path) },
  "Repo conventions": { appliesTo: "Any file", matches: () => true },
};

// The bytes of a path git quoted (C-style escapes, octal for non-ASCII), as text.
function unquote(quoted: string): string {
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let index = 0; index < quoted.length; index++) {
    const char = quoted[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(quoted.slice(index + 1, index + 4))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
    } else {
      bytes.push(escapes[quoted[index + 1] ?? ""] ?? (quoted[index + 1] ?? "\\").charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// The path in a `diff --git` header's second half, and the rest after a quoted first half.
function quotedToken(text: string): [string, string] | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  return match === null ? undefined : [unquote(match[1]!), text.slice(match[0].length).trimStart()];
}

// The repository paths a patch changes, in patch order, once each, read from its `diff --git` headers. The review's patch
// has renames off, so both halves of a header name the same path; a deleted file keeps its old one.
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const rest = line.slice("diff --git ".length);
    let path: string | undefined;
    const first = quotedToken(rest);
    if (first !== undefined) {
      const second = quotedToken(first[1]);
      path = (second === undefined ? first[1] : second[0]).replace(/^b\//, "");
    } else {
      // Unquoted: "a/<p> b/<p>". With spaces in <p> only the midpoint splits it.
      const half = (rest.length - 5) / 2;
      path = Number.isInteger(half) && rest.slice(0, 2) === "a/" && rest.slice(2, 2 + half) === rest.slice(half + 5) ? rest.slice(2, 2 + half) : /^a\/.+ b\/(.+)$/.exec(rest)?.[1];
    }
    // A header it can't read still counts as a changed file, so no lens is skipped for it.
    paths.add(path ?? rest);
  }
  return [...paths];
}

// A reviewer to start: the Bar or one lens. The Bar's `row` is empty.
export type Reviewer = { lens: string; row: string };

// The lens name the Bar reviewer's findings carry.
export const BAR_LENS = "Bar";

// The reviewers for the files a round reads: the Bar first, then each lens whose "Applies to" matches one of the files, in the
// table's order. A lens with no path rule here runs whenever any file changed.
export function reviewersFor(files: readonly string[], lenses: readonly Lens[]): Reviewer[] {
  const matching = lenses.filter((lens) => {
    const rule = LENS_APPLIES[lens.name];
    return rule === undefined ? files.length > 0 : files.some((file) => rule.matches(file));
  });
  return [{ lens: BAR_LENS, row: "" }, ...matching.map((lens) => ({ lens: lens.name, row: lens.row }))];
}

// A finding as a reviewer answers it, in the strict shape the ledger will take: anything else is refused, and the reviewer asked again.
// `security` is the reviewer's own call: true for a weakness, or when unsure; only an explicit false lets the PR note list the finding.
export const reviewerFindingSchema = z
  .object({
    lens: z.string().trim().min(1),
    path: z.string().trim().min(1).regex(FINDING_PATH_SHAPE, "a path has no whitespace but single spaces, and no <, > or backtick"),
    line: z.number().int().nonnegative(),
    severity: z.enum(["critical", "warning", "advisory"]),
    summary: z.string().trim().min(1),
    fix: z.string(),
    needsPerson: z.boolean(),
    why: z.string(),
    security: z.boolean().optional(),
  })
  .strict();

// A finding as a reviewer answered it.
export type ReviewerFinding = z.infer<typeof reviewerFindingSchema>;

// How many opening tags (from each end of the output) and closing tags (the last ones) the parser tries, so tags a reviewer quotes
// from a file the branch planted can't make it quadratic, and a real answer is never out of reach: it is among the last ones.
const MAX_TAG_CANDIDATES = 10;

// Thrown for a reviewer answer that holds no valid findings block.
export class ReviewerAnswerError extends Error {}

// The findings in a reviewer's output: the span from the earliest opening tag to the latest closing tag that parses as a JSON
// array. A reviewer may quote the format, or text it read, before its answer, and prose after it may mention a lone tag; neither
// counts. It fails closed, and the reviewer is asked again, on two blocks of valid findings (the quote of an answer can't be told from a second
// answer) and on an opening tag followed by `[` after the closing tag it reads (a later answer that is malformed or cut
// short, or prose after the answer that quotes the format with an opening tag).
export function parseReviewerAnswer(stdout: string): ReviewerFinding[] {
  const starts = [...stdout.matchAll(/<findings>/g)].map((match) => match.index! + "<findings>".length);
  const ends = [...stdout.matchAll(/<\/findings>/g)].map((match) => match.index!);
  if (starts.length === 0 || ends.length === 0 || starts[0]! > ends.at(-1)!) throw new ReviewerAnswerError("the answer has no <findings>[...]</findings> block");
  // A finding may quote either tag, and prose may quote the format before or after the answer, so the first tag isn't always the
  // block's. The block is the one that ends at the latest closing tag that leaves a JSON array, and starts at the earliest opening tag
  // that does: a quoted `<findings>[]</findings>` inside a finding sits inside the real block and can't cut it short to read as clean,
  // and an example before the answer, or prose after it, doesn't make the answer unreadable.
  const candidateStarts = [...new Set([...starts.slice(0, MAX_TAG_CANDIDATES), ...starts.slice(-MAX_TAG_CANDIDATES)])];
  const spans: { start: number; end: number; items: unknown[] }[] = [];
  let value: unknown;
  let jsonError: unknown;
  for (const end of ends.slice(-MAX_TAG_CANDIDATES * 2).reverse()) {
    if (spans.length === 0 && starts.some((start) => start > end && /^\s*\[/.test(stdout.slice(start, start + 64)))) {
      throw new ReviewerAnswerError(`the findings block is not valid JSON: ${jsonError === undefined ? "it is cut short" : (jsonError as Error).message}`);
    }
    for (const start of candidateStarts) {
      if (start > end) break;
      try {
        const parsed: unknown = JSON.parse(stdout.slice(start, end));
        if (Array.isArray(parsed)) {
          spans.push({ start, end, items: parsed });
          break;
        }
        value ??= parsed;
      } catch (error) {
        jsonError ??= error;
      }
    }
  }
  const chosen = spans[0];
  if (chosen === undefined) {
    if (value === undefined) throw new ReviewerAnswerError(`the findings block is not valid JSON: ${(jsonError as Error).message}`);
    throw new ReviewerAnswerError("the findings block must hold a JSON array of findings");
  }
  // Two answers: a block of valid findings before the one read. A quote of the format that an answer follows is `[]` or isn't valid
  // findings, so it never counts. A second block of valid findings does, whether it is a second answer or a quote of the format after
  // the answer (which is the one read, being last): taking either silently could record a review as clean, so the reviewer is asked again.
  const earlier = spans.find((span) => span.end < chosen.start && span.items.length > 0 && span.items.every((item) => reviewerFindingSchema.safeParse(item).success));
  if (earlier !== undefined) throw new ReviewerAnswerError("the answer holds two blocks of findings: end with one block, and write nothing after it");
  return chosen.items.map((item, index) => {
    const parsed = reviewerFindingSchema.safeParse(item);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(finding)"}: ${issue.message}`);
    throw new ReviewerAnswerError(`finding ${index + 1} is invalid: ${issues.join("; ")}`);
  });
}

// A finding as triage leaves it: ready to record, plus what the host needs to route it.
export type TriageFinding = ReviewInput["findings"][number] & { needsPerson: boolean; fixable: boolean };

// A finding's path the way a diff names the file: without a leading `./` and without the worktree's absolute prefix.
// A path that nothing is left of (`./`, or the worktree's own folder) is returned as written, since the ledger refuses an empty one.
export function diffPath(path: string, worktree?: string): string {
  let out = path;
  if (worktree !== undefined && worktree !== "" && out.startsWith(`${worktree.replace(/\/+$/, "")}/`)) out = out.slice(worktree.replace(/\/+$/, "").length + 1);
  out = out.replace(/^(?:\.\/)+/, "");
  return out === "" ? path : out;
}

const RANK = { advisory: 0, critical: 1, warning: 2 } as const;
const sameProblem = (finding: ReviewerFinding) => `${finding.path}\0${finding.line}\0${finding.summary.toLowerCase().replace(/\s+/g, " ").trim()}`;

// Merge duplicates, number the findings, grade security, and decide which the backend role fixes. Duplicates agree on path,
// line and summary (ignoring case and spacing): distinct problems on one line stay separate, since a wrong merge loses a
// finding and a missed one costs a fix. A merge joins the lenses, takes the higher severity (a Warning always wins) and
// ORs needsPerson.
export function triageRound({
  raw,
  firstId,
  reviewOnly,
  worktree,
}: {
  raw: { reviewer: Reviewer; findings: ReviewerFinding[] }[];
  firstId: number;
  reviewOnly: boolean;
  // The worktree's absolute path: a reviewer reads files by absolute path and may write a finding's path that way.
  worktree?: string;
}): TriageFinding[] {
  const merged = new Map<string, ReviewerFinding>();
  for (const { reviewer, findings } of raw) {
    // The path is normalised before the key is made, so one problem a reviewer wrote as `./src/a.ts` and another as the absolute path merge.
    // The lens is the reviewer's the host ran, not the one its answer names: an answer is text an injected reviewer could write, and
    // whether a finding names a security lens decides whether it is a Warning and whether the PR note may list it.
    for (const original of findings) {
      const found = { ...original, lens: reviewer.lens, path: diffPath(original.path, worktree) };
      const key = sameProblem(found);
      const earlier = merged.get(key);
      if (earlier === undefined) {
        merged.set(key, found);
        continue;
      }
      const lenses = earlier.lens.split("/");
      merged.set(key, {
        ...earlier,
        lens: (lenses.includes(found.lens) ? lenses : [...lenses, found.lens]).join("/"),
        severity: RANK[found.severity] > RANK[earlier.severity] ? found.severity : earlier.severity,
        fix: earlier.fix.trim() === "" ? found.fix : earlier.fix,
        needsPerson: earlier.needsPerson || found.needsPerson,
        // Not a weakness only when every reviewer that raised it said so.
        security: earlier.security === false && found.security === false ? false : true,
      });
    }
  }
  return [...merged.values()].map((found, index) => {
    // A reviewer's own mark counts: a finding is non-security only when it said so, since the PR note publishes non-security ones. A
    // finding that is security, or not marked otherwise, is graded Warning whatever its reviewer graded it (the review bar: a security
    // weakness is always a Warning, and a Warning when in doubt), so it never clears on a reason alone.
    const security = found.severity === "warning" || /security/i.test(found.lens) || found.security !== false;
    return {
      id: `R${firstId + index}`,
      lens: found.lens,
      path: found.path,
      line: found.line,
      summary: found.summary,
      severity: security ? "warning" : found.severity,
      security,
      status: "open",
      test: null,
      reason: null,
      fix: found.fix.trim() === "" ? `Decide with the reviewer's reason: ${found.why.trim() === "" ? "none was given" : found.why.trim()}` : found.fix,
      needsPerson: found.needsPerson,
      fixable: !found.needsPerson && !reviewOnly,
    };
  });
}

// What the backend role says became of one finding.
export type FixOutcome = { id: string; status: "fixed" | "dismissed" | "open"; test: string | null; reason: string | null };

// Whether a path reads as a test or a gate check: a code file (not markdown, text, JSON or YAML) in a test folder, named *.test.*, *.spec.*, *-test.*, *_test.*,
// test_*, test.* or tests.*, *Tests.* or *.bats, or the gate's checks. `fixed` is accepted only behind such a file, which keeps a backend from clearing a
// finding by naming a docs or data file it touched. The path's shape is all the host checks: it doesn't read that the file pins this finding.
const TEST_CODE_FILE = /\.(?:[cm]?[jt]sx?|py|sh|bash|bats|cs|ps1|psm1|go|rs|java|kt|rb|php|swift|c|cc|cpp|h|hpp|fs|vb)$/i;
export const looksLikeTest = (file: string): boolean =>
  /(^|\/)gate-checks\.sh$/.test(file) ||
  (TEST_CODE_FILE.test(file) &&
    (/(^|\/)(tests?|__tests__|specs?)\//i.test(file) ||
      /[._-](test|spec)\.[^/]+$/i.test(file) ||
      /(^|\/)(test_[^/]+|tests?\.[^/]+)$/i.test(file) ||
      /Tests?\.[A-Za-z0-9]+$/.test(file) ||
      /\.bats$/i.test(file)));

// Turn the backend's verdicts into final statuses, enforcing the skill's rules. The backend's word is self-reported, so each
// claim needs what the host can check: `fixed` needs HEAD to have moved and a test whose file the round changed and that looks like a test (a Warning, or
// any security finding, needs the test; another finding may give a reason instead); `dismissed` needs a reason citing
// `file:line` and is never accepted for a Warning or a security finding. A Warning or security finding also needs the file at its
// `path` to have changed in the round. Everything else, and every finding that waits for a person, stays open with its suggested fix. Nothing is
// ever `accepted`: only a person accepts.
export function applyOutcomes(
  findings: readonly TriageFinding[],
  outcomes: readonly FixOutcome[],
  changedFiles: readonly string[],
  headAdvanced: boolean,
): ReviewInput["findings"] {
  const changed = new Set(changedFiles.map((file) => file.replace(/^\.\//, "")));
  return findings.map(({ needsPerson: _needsPerson, fixable, ...open }) => {
    const outcome = outcomes.find((candidate) => candidate.id === open.id);
    if (!fixable || outcome === undefined) return open;
    const reason = outcome.reason?.trim() ? outcome.reason.trim() : null;
    if (outcome.status === "dismissed") {
      // A Warning or a security finding is never cleared on the backend's word alone: the host can't check the line it cites, so the
      // finding stays open, counted in the PR note, for a person.
      if (open.security || open.severity === "warning") return open;
      return reason !== null && /\S+:\d+/.test(reason) ? { ...open, status: "dismissed", test: null, reason, fix: null } : open;
    }
    if (outcome.status !== "fixed" || !headAdvanced) return open;
    const test = outcome.test?.trim() ? outcome.test.trim() : null;
    // A Warning or a security finding is fixed in code, so the code at its path must have changed too: a backend that touches any
    // test file and claims `fixed` leaves the defect in place otherwise (the next round reads only the fixes, so nothing would look again).
    if ((open.security || open.severity === "warning") && !changed.has(diffPath(open.path))) return open;
    if (test !== null) {
      const testFile = (test.split("::")[0] ?? "").replace(/^\.\//, "");
      return changed.has(testFile) && looksLikeTest(testFile) ? { ...open, status: "fixed", test, reason, fix: null } : open;
    }
    return !open.security && open.severity !== "warning" && reason !== null ? { ...open, status: "fixed", test: null, reason, fix: null } : open;
  });
}

// The skill files the host reads from the main checkout, never the worktree: the worktree is branch-controlled.
export type SkillFiles = { lenses: string; bar: string; severities: string; agentBody: string; repoLenses?: string };

// What the review needs from outside; tests pass stubs.
export type HostReviewHost = {
  readSkillFiles(): SkillFiles;
  // The worktree's absolute path inside the sandbox.
  worktree(): Promise<string>;
  prepare(opts: { main?: string; head?: string; since?: { commit: string; preparedHead: string | undefined } }): PreparedRound;
  takenIds(head: string): number;
  // Writes a file under the run's folder inside the sandbox.
  writeRunFile(path: string, content: Buffer | string): Promise<void>;
  // Removes a file under the run's folder. Round 1 has no fixes, and an earlier build of the same branch may have left a fixes.patch there.
  removeRunFile(path: string): Promise<void>;
  runReviewer(reviewer: Reviewer, prompt: string): Promise<string>;
  runFixer(prompt: string): Promise<void>;
  readOutcomes(): Promise<string | undefined>;
  head(): Promise<string | undefined>;
  changedFiles(from: string, to: string): string[];
  // Checkpoint 3: the gate (and gate-fixer) after a round's fixes. The commit it passed on, or undefined when red.
  gate(): Promise<string | undefined>;
  record(input: ReviewInput, at: { head: string; branch: string }): Ledger;
  log(line: string): void;
  // The clock, in milliseconds, for the review's time cap (REVIEW_WALL_CLOCK_MINUTES); Date.now when absent. For tests.
  now?: () => number;
  // How long the whole review may run, in milliseconds; REVIEW_WALL_CLOCK_MINUTES when absent. For tests.
  wallClockMs?: number;
};

// The most a round's diff, or the fixes a later round reads, may hold, in bytes. The host sends each to the sandbox through one command with a time limit, and each reviewer reads
// it: a generated file or a lockfile past this would stall that command, and the build with it, on every run. A larger diff ends the review as
// failed, which publishes the branch with a note.
export const MAX_REVIEW_PATCH_BYTES = 4 * 1024 * 1024;

// How a review ends: recorded, or failed (with the last commit the gate passed on, which is published).
export type HostReviewResult =
  | { status: "recorded"; head: string; rounds: number; ledger: Ledger; readPaths: ReadonlySet<string> }
  | { status: "failed"; head: string; reason: string };

const outcomesSchema = z.object({ outcomes: z.array(z.unknown()) });
const outcomeSchema = z.object({
  id: z.string(),
  status: z.enum(["fixed", "dismissed", "open"]),
  test: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

// The backend's outcomes file as outcomes. Anything unreadable is no outcome, which leaves its findings open.
function parseOutcomes(text: string | undefined, log: (line: string) => void): FixOutcome[] {
  if (text === undefined) return [];
  try {
    const parsed = outcomesSchema.parse(JSON.parse(text));
    return parsed.outcomes.flatMap((item) => {
      const outcome = outcomeSchema.safeParse(item);
      return outcome.success ? [{ id: outcome.data.id, status: outcome.data.status, test: outcome.data.test ?? null, reason: outcome.data.reason ?? null }] : [];
    });
  } catch {
    log("  ⚠ the backend's outcomes file isn't valid, so every finding of the round stays open");
    return [];
  }
}

// How one reviewer's run ended, for the failure reason: host-written words only, never the agent's.
type ReviewerFailure = { lens: string; what: string };

// Runs the review's rounds on `startHead` against `main`, and records them. A usage-limit stop or a stalled sandbox (an UncountedStopError) from a
// reviewer or the fixer rejects, so the branch is left for a later round. The run's time budget passing (TimeBudgetStopError) and the
// review's own time cap (REVIEW_WALL_CLOCK_MINUTES) end it as `failed` at the last commit the gate passed on, so work already gated is
// published rather than lost with a discarded runner. A reviewer that fails (a timeout, a bad answer twice, an error) ends the review as `failed` at once, recording nothing, and so does a gate that stays red after a round's fixes.
export async function runHostReview(
  host: HostReviewHost,
  input: { issue: { number: number; title: string; body: string }; branch: string; main: string; startHead: string },
): Promise<HostReviewResult> {
  const progress = { head: input.startHead };
  try {
    return await runRounds(host, input, progress);
  } catch (error) {
    if (error instanceof TimeBudgetStopError) {
      host.log(`  ✗ the local review stopped: ${error.message}`);
      return { status: "failed", head: progress.head, reason: "the run's time budget passed during the review" };
    }
    if (error instanceof UncountedStopError) throw error;
    // Any host step (reading the skill files, the sandbox, git) that throws ends the review as failed, so the finished and gated work
    // is still published with a note. The reason is host-written: the error's own text may hold an agent's words.
    host.log(`  ✗ the local review failed: a host step threw: ${errorText(error)}`);
    return { status: "failed", head: progress.head, reason: "a step of the review on the host failed" };
  }
}

// The rounds. `progress.head` is the last commit the gate passed on, for a failure that comes from outside them.
async function runRounds(
  host: HostReviewHost,
  input: { issue: { number: number; title: string; body: string }; branch: string; main: string; startHead: string },
  progress: { head: string },
): Promise<HostReviewResult> {
  const { issue, branch, main } = input;
  const now = host.now ?? Date.now;
  const startedAt = now();
  const spent = (): boolean => now() - startedAt >= (host.wallClockMs ?? REVIEW_WALL_CLOCK_MINUTES * 60_000);
  const skill = host.readSkillFiles();
  let lenses: Lens[];
  try {
    lenses = [...parseLensTable(skill.lenses), ...(skill.repoLenses === undefined ? [] : parseLensTable(skill.repoLenses))];
  } catch (error) {
    host.log(`  ✗ the lens table couldn't be read: ${(error as Error).message}`);
    return { status: "failed", head: input.startHead, reason: "the review's lens table couldn't be read" };
  }
  const worktree = await host.worktree();
  const runRel = `.sandcastle/work/${issue.number}/review`;
  const runDir = `${worktree}/${runRel}`;
  const recorded: ReviewInput["findings"] = [];
  // The ids of findings that wait for a person: a later round fixing the same problem never clears those.
  const personRequired = new Set<string>();
  const nextId = host.takenIds(input.startHead) + 1;
  let head = input.startHead;
  let previous: PreparedRound | undefined;
  let fixingRounds = 0;
  // The review's own clock: checked before each round, reviewer and fixer run, so a review never starts a step it has no time for.
  const outOfTime = (at: string): HostReviewResult => {
    host.log(`  ✗ the local review stopped: it used its ${REVIEW_WALL_CLOCK_MINUTES}-minute time cap before ${at}`);
    return { status: "failed", head, reason: `the review used its ${REVIEW_WALL_CLOCK_MINUTES}-minute time cap` };
  };
  // Every file any round's diff holds: the files the reviewers read, which the PR note may name.
  const readPaths = new Set<string>();

  for (let round = 1; ; round++) {
    const reviewOnly = fixingRounds >= REVIEW_FIX_ROUNDS;
    if (spent()) return outOfTime(`round ${round}`);
    let prepared: PreparedRound;
    try {
      prepared = host.prepare({
        main,
        head,
        ...(previous === undefined ? {} : { since: { commit: previous.head, preparedHead: previous.head } }),
      });
    } catch (error) {
      host.log(`  ✗ the local review failed: round ${round} couldn't be prepared: ${(error as Error).message}`);
      return { status: "failed", head, reason: `round ${round} couldn't be prepared` };
    }
    // Both files go through the same time-limited sandbox command; the fixes of a later round are a diff between two commits, so they can
    // outgrow the whole diff (a fixer rewriting a large file holds it twice).
    const largest = Math.max(prepared.patch.length, prepared.fixes?.length ?? 0);
    if (largest > MAX_REVIEW_PATCH_BYTES) {
      host.log(`  ✗ the local review failed: round ${round}'s diff is ${largest} bytes, past the limit of ${MAX_REVIEW_PATCH_BYTES}`);
      return { status: "failed", head: prepared.head, reason: "the diff is too large to review" };
    }
    for (const path of patchPaths(prepared.patch.toString("utf8"))) readPaths.add(path);
    await host.writeRunFile(`${runRel}/diff.patch`, prepared.patch);
    if (prepared.fixes !== undefined) await host.writeRunFile(`${runRel}/fixes.patch`, prepared.fixes);
    else await host.removeRunFile(`${runRel}/fixes.patch`);
    await host.writeRunFile(`${runRel}/decisions.md`, decisionsMarkdown(recorded));
    const reviewers = reviewersFor(patchPaths((prepared.fixes ?? prepared.patch).toString("utf8")), lenses);
    host.log(`  review round ${round}: ${reviewers.map((reviewer) => reviewer.lens).join(", ")}`);
    if (reviewers.length > MAX_REVIEWERS_PER_ROUND) {
      host.log(`  ✗ the local review failed: round ${round} has ${reviewers.length} reviewers, past the limit of ${MAX_REVIEWERS_PER_ROUND} that its time bounds allow`);
      return { status: "failed", head: prepared.head, reason: "the round has more reviewers than the review's time bounds allow" };
    }

    const ask = (reviewer: Reviewer) =>
      reviewerFindings(host, reviewer, (problem) =>
        reviewerPrompt({
          agentBody: skill.agentBody,
          bar: skill.bar,
          severities: skill.severities,
          lens: reviewer,
          worktree,
          runDir,
          round,
          issue,
          hasFixes: prepared.fixes !== undefined,
        }) + (problem === undefined ? "" : retryNote(problem)),
      );
    // One after another, never together: each role run sets up the sandbox's global git config, and runs started together race for its lock
    // (a real run lost four of ten reviewers to `could not lock config file`). The round ends at the first reviewer that fails: the review ends
    // as failed anyway, so the reviewers after it would only spend the review's time. A usage-limit stop or a stalled sandbox ends the round at
    // once too, by rethrowing (the time budget's stop does too, and runHostReview turns it into a failed review).
    const settled: PromiseSettledResult<ReviewerFinding[]>[] = [];
    for (const reviewer of reviewers) {
      if (spent()) return outOfTime(`the ${reviewer.lens} reviewer`);
      const result = await ask(reviewer).then(
        (value): PromiseFulfilledResult<ReviewerFinding[]> => ({ status: "fulfilled", value }),
        (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
      );
      if (result.status === "rejected" && result.reason instanceof UncountedStopError) throw result.reason;
      settled.push(result);
      if (result.status === "rejected") break;
    }
    const failures = settled.flatMap((result, index): ReviewerFailure[] =>
      result.status === "rejected" ? [{ lens: reviewers[index]!.lens, what: failureText(result.reason) }] : [],
    );
    if (failures.length > 0) {
      // The raw errors go to the host's log only (its sink makes them safe for a terminal); the reason, which goes into the PR, stays host-written.
      settled.forEach((result, index) => {
        if (result.status === "rejected") host.log(`  ✗ the ${reviewers[index]!.lens} reviewer's error: ${errorText(result.reason)}`);
      });
      const reason = `the ${failures.map((failure) => `${failure.lens} reviewer ${failure.what}`).join(", the ")}`;
      host.log(`  ✗ the local review failed in round ${round}: ${reason}`);
      return { status: "failed", head: prepared.head, reason };
    }
    const raw = settled.map((result, index) => ({ reviewer: reviewers[index]!, findings: result.status === "fulfilled" ? result.value : [] }));
    const triaged = triageRound({ raw, firstId: nextId + recorded.length, reviewOnly, worktree });
    const fixable = triaged.filter((finding) => finding.fixable);

    let advanced = false;
    let final: ReviewInput["findings"];
    if (fixable.length === 0) {
      final = applyOutcomes(triaged, [], [], false);
    } else {
      if (spent()) return outOfTime(`round ${round}'s fixer`);
      try {
        await host.runFixer(reviewFixPrompt({ issue, branch, round, findings: fixable, outcomesPath: `${runDir}/outcomes.json` }));
      } catch (error) {
        if (error instanceof UncountedStopError) throw error;
        host.log(`  ✗ the local review failed: the backend role's run for round ${round} ended in an error: ${errorText(error)}`);
        return { status: "failed", head: prepared.head, reason: `the backend role's run fixing round ${round}'s findings ${failureText(error)}` };
      }
      const after = await host.head();
      const moved = after !== undefined && after !== prepared.head ? after : undefined;
      const changed = moved === undefined ? [] : host.changedFiles(prepared.head, moved);
      // A move of HEAD that changes no file (an empty commit, a change and its revert) is no new code to review: the next round would have
      // no fixes to read and fail to prepare, so the round is recorded as it was read.
      advanced = moved !== undefined && changed.length > 0;
      final = applyOutcomes(triaged, parseOutcomes(await host.readOutcomes(), host.log), changed, advanced);
    }
    for (const found of triaged) if (found.needsPerson) personRequired.add(found.id);
    resolveRepeats(recorded, final, personRequired);
    recorded.push(...final);
    previous = prepared;

    // Only a round that changed the code is followed by another: the last round must have read the commit that is recorded.
    // Whether the backend's word that something was fixed holds is applyOutcomes' business; commits that landed are reviewed
    // either way, since the branch carries them.
    if (!advanced) return record(host, input, prepared, round, recorded, readPaths);
    host.log(`  review round ${round}: ${final.filter((finding) => finding.status === "fixed").length} fixed, running the gate (checkpoint 3)`);
    fixingRounds++;
    const gated = await host.gate();
    if (gated === undefined) {
      // The fixes of this round didn't pass the gate, but every earlier round's did: the last gated commit is what's published, as for any
      // other review that can't finish, rather than discarding the branch and spending a failed attempt on it.
      host.log(`  ✗ the local review failed: the gate stayed red after round ${round}'s fixes`);
      return { status: "failed", head, reason: `the gate stayed red after round ${round}'s fixes` };
    }
    head = gated;
    progress.head = gated;
  }
}

// A problem an earlier round left open (the fix failed) and a later round raised again and fixed is fixed: the earlier copy takes the later
// one's test or reason, so the ledger doesn't count it unresolved. Only the same finding counts (same path, line, lens, security grading and
// summary) and one at least as strictly fixed: a Warning or security finding is cleared only behind a test, by a later copy graded as high.
// A finding that waits for a person is left as it was. A repeat on a line the fixes moved is a different finding here and stays open beside the earlier one:
// matching loosely could clear a Warning by an unrelated repeat.
export function resolveRepeats(recorded: ReviewInput["findings"], later: ReviewInput["findings"], personRequired: ReadonlySet<string>): void {
  type Found = ReviewInput["findings"][number];
  const text = (found: Found) => found.summary.toLowerCase().replace(/\s+/g, " ").trim();
  const rank = { advisory: 0, critical: 1, warning: 2 } as const;
  const same = (a: Found, b: Found) => a.path === b.path && a.line === b.line && a.lens === b.lens && a.security === b.security && text(a) === text(b);
  for (const fixed of later) {
    if (fixed.status !== "fixed") continue;
    for (const [index, earlier] of recorded.entries()) {
      if (earlier.status !== "open" || personRequired.has(earlier.id) || !same(earlier, fixed)) continue;
      if (rank[fixed.severity] < rank[earlier.severity]) continue;
      if ((earlier.security || earlier.severity === "warning") && fixed.test === null) continue;
      recorded[index] = { ...earlier, status: "fixed", test: fixed.test, reason: fixed.reason, fix: null };
    }
  }
}

// An error's message, or the thrown value as text when it isn't an Error.
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The text added to a reviewer's prompt when its last answer wasn't valid.
function retryNote(problem: string): string {
  return `\n\nYour last answer was refused: ${problem}\nAnswer again, ending with a valid <findings>[...]</findings> block.`;
}

// What a reviewer's rejection says in the failure reason: a fixed phrase per kind, never the agent's own text.
function failureText(error: unknown): string {
  if (error instanceof ReviewerAnswerError) return `gave no valid answer after ${REVIEWER_ATTEMPTS} attempts`;
  return isRoleTimeout(error) ? "timed out" : "failed";
}

// One reviewer's findings. A usage-limit stop, a stalled sandbox or the time budget's stop (any UncountedStopError) is rethrown at once
// (runHostReview decides what it ends the review as); an invalid answer is asked for again, quoting what was
// wrong, up to REVIEWER_ATTEMPTS times in all.
async function reviewerFindings(host: HostReviewHost, reviewer: Reviewer, prompt: (problem: string | undefined) => string): Promise<ReviewerFinding[]> {
  let problem: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const stdout = await host.runReviewer(reviewer, prompt(problem));
    try {
      return parseReviewerAnswer(stdout);
    } catch (error) {
      if (!(error instanceof ReviewerAnswerError) || attempt >= REVIEWER_ATTEMPTS) throw error;
      problem = error.message;
      host.log(`  ⚠ the ${reviewer.lens} reviewer's answer was refused (${problem}); asking again`);
    }
  }
}

// Records the rounds as the ledger for the commit the last round read. A record the ledger refuses ends the review as failed.
function record(
  host: HostReviewHost,
  input: { branch: string },
  last: PreparedRound,
  rounds: number,
  findings: ReviewInput["findings"],
  readPaths: ReadonlySet<string>,
): HostReviewResult {
  try {
    const ledger = host.record(
      { reviewedKey: last.key, reviewedHead: last.head, rounds, reviewerAgent: "pre-push-reviewer", findings },
      { head: last.head, branch: input.branch },
    );
    return { status: "recorded", head: last.head, rounds, ledger, readPaths };
  } catch (error) {
    host.log(`  ✗ the local review couldn't be recorded: ${errorText(error)}`);
    return { status: "failed", head: last.head, reason: "the review couldn't be recorded" };
  }
}

// The characters a listed path may hold: letters, digits, `.`, `_`, `-`, `+`, `/` and a space. Anything else is counted, not listed.
const SAFE_NOTE_PATH = /^[A-Za-z0-9._+\-/ ]+$/;

// The most findings the PR note lists: the note is appended to a description that may already be near GitHub's limit.
const NOTE_FINDINGS = 20;
// A path is the reviewer's text too, so its length is bounded.
const NOTE_PATH_LIMIT = 300;
const cut = (text: string) => (text.length <= NOTE_PATH_LIMIT ? text : `${[...text].slice(0, NOTE_PATH_LIMIT).join("")}…`);

// The PR note listing the findings the review left open: each non-security one by its id, severity and place only. A reviewer's own
// words (summary, suggested fix) stay in the local review record and are never published, since they are written by an agent that
// read text anyone could edit. A security finding (isSecurity: a Warning, a lens that names security, or one not marked otherwise)
// is only counted. Empty when nothing is open.
export function openFindingsNote(ledger: Ledger, readPaths: ReadonlySet<string>, publishable: (line: string) => boolean = () => true): string {
  const open = ledger.findings.filter((finding) => finding.status === "open");
  if (open.length === 0) return "";
  // A path is a reviewer's text, and one that reads untrusted content can put anything in it, so a finding is listed only when its path
  // is one of the files the review read; the rest are counted.
  const security = open.filter((finding) => isSecurity(finding));
  const lineOf = (finding: Ledger["findings"][number]) => `- ${finding.id} ${severityOf(finding)} ${cut(plainText(`${diffPath(finding.path)}:${finding.line}`))}`;
  // Only a path made of plain file-name characters is listed, so one that GitHub would render (a Markdown link, an image, a www. address,
  // HTML, or `www.` anywhere in it: GitHub links one after a space or an underscore too) is counted, never published; so is a line the caller's check (`publishable`) refuses. One odd path leaves out its own line only.
  const listed = open.filter(
    (finding) => !isSecurity(finding) && readPaths.has(diffPath(finding.path)) && SAFE_NOTE_PATH.test(diffPath(finding.path)) && !/www\./i.test(diffPath(finding.path)) && publishable(lineOf(finding)),
  );
  const hidden = security.length;
  const unlisted = open.length - listed.length - hidden;
  const shown = listed.slice(0, NOTE_FINDINGS);
  const lines = shown.map(lineOf);
  const more = listed.length - shown.length + unlisted;
  return [
    "The local review left these findings open (their details are in the local review record):",
    "",
    ...lines,
    ...(more > 0 ? [...(lines.length > 0 ? [""] : []), `${more} more open finding${more === 1 ? " is" : "s are"} in the local review record and aren't listed here.`] : []),
    ...(hidden > 0 ? [...(lines.length > 0 ? [""] : []), `${hidden} security finding${hidden === 1 ? " is" : "s are"} left open in the local review record and aren't listed here.`] : []),
  ].join("\n");
}
