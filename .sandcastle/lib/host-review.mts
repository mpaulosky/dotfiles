// The host-side half of the pre-push review for a branch Sandcastle built: the reviewers (the Bar and one per lens
// whose files match), the triage of their findings, the backend role's fixes and the rounds that follow them, and the
// record. Only the host records; no agent gets a shell, a token or the ledger. The rounds follow the pre-push-review
// skill's steps 4 to 8 (.claude/skills/pre-push-review/SKILL.md), and host-review.test.mts fails when the skill's lens table,
// reviewer or round limit changes without this module following.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { isRoleTimeout } from "./agents.mts";
import { MAX_REVIEWERS_PER_ROUND, REVIEW_FIX_ROUNDS, REVIEW_WALL_CLOCK_MINUTES, REVIEWER_ATTEMPTS, SESSION_REPLY_MARKER } from "./config.mts";
import { TimeBudgetStopError, UncountedStopError } from "./errors.mts";
import { decisionsMarkdown, leadPrompt, reviewerPrompt, reviewFixPrompt, reviewTag } from "./host-review-prompts.mts";
import { plainText } from "./plain-text.mts";
import { hasHiddenText } from "./status.mts";
import { FINDING_PATH_SHAPE, isSecurity, patchPaths, renderAdvisories, severityOf, sizeWarning, type Ledger, type PreparedRound, type ReviewInput } from "./review-ledger.mts";

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

// The patch's changed paths are read in lib/review-ledger.mts, which counts a branch's size from the same headers.
export { patchPaths };

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
// from a file the branch planted can't make it quadratic. A real answer is normally among the last tags, but one that holds a block of
// findings among more tags than are read is refused (see parseReviewerAnswer), not read from the tags in reach.
const MAX_TAG_CANDIDATES = 10;

// Whether the text from `at` is `[` (after any whitespace, as JSON.parse takes it), and whether it is `[` and then `{`: an array of findings.
// A sticky match scans only the whitespace after the tag, so the check stays linear however many tags there are.
const opensArray = (text: string, at: number): boolean => {
  const found = /\s*\[/y;
  found.lastIndex = at;
  return found.test(text);
};
const opensFindings = (text: string, at: number): boolean => {
  const found = /\s*\[\s*\{/y;
  found.lastIndex = at;
  return found.test(text);
};

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
  // The parser looks at a bounded number of closing tags. A block with findings in the text before the first one it looks at could be
  // out of its reach, and the last block (say an empty one) be read as the whole answer: such an output is refused and the reviewer asked
  // again. Quoted empty blocks out of reach are harmless.
  if (ends.length > MAX_TAG_CANDIDATES * 2 && /<findings>\s*\[\s*\{/.test(stdout.slice(0, ends[ends.length - MAX_TAG_CANDIDATES * 2]!))) {
    throw new ReviewerAnswerError("the answer holds a block of findings among more <findings> tags than are read: quote no tag, and end with one block");
  }
  // The same for opening tags: one in the middle, beyond the first and last MAX_TAG_CANDIDATES the parser tries, that opens a block with findings.
  if (starts.length > MAX_TAG_CANDIDATES * 2) {
    for (const start of starts.slice(MAX_TAG_CANDIDATES, -MAX_TAG_CANDIDATES)) {
      if (opensFindings(stdout, start)) {
        throw new ReviewerAnswerError("the answer holds a block of findings among more <findings> tags than are read: quote no tag, and end with one block");
      }
    }
  }
  // A finding may quote either tag, and prose may quote the format before or after the answer, so the first tag isn't always the
  // block's. The block is the one that ends at the latest closing tag that leaves a JSON array, and starts at the earliest opening tag
  // that does: a quoted `<findings>[]</findings>` inside a finding sits inside the real block and can't cut it short to read as clean,
  // and an example before the answer, or prose after it, doesn't make the answer unreadable.
  const candidateStarts = [...new Set([...starts.slice(0, MAX_TAG_CANDIDATES), ...starts.slice(-MAX_TAG_CANDIDATES)])];
  const spans: { start: number; end: number; items: unknown[] }[] = [];
  let value: unknown;
  let jsonError: unknown;
  for (const end of ends.slice(-MAX_TAG_CANDIDATES * 2).reverse()) {
    if (spans.length === 0 && starts.some((start) => start > end && opensArray(stdout, start))) {
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
  // Only the first span is the answer; the later ones (found for earlier closing tags) are read only by the two-blocks check below, so
  // the parses that never become the answer are an accepted cost, not worth restructuring the loop.
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
    // weakness is always a Warning, and a Warning when in doubt), so it never clears on a reason alone. This collapses a reviewer's own
    // grade into the mark, an accepted trade-off: the grade isn't kept apart from the mark, so a finding with `security` omitted or true is a Warning.
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
    // A non-security Critical or Advisory finding is recorded fixed on a reason alone, with no test: an accepted trade-off. The host can't
    // tell a prose or workflow finding (a doc, a comment, a workflow step), which has no test to point at, from a code defect, so a
    // Critical code bug clears on the backend's reason too, and the host can't check that the reason is true. A Warning or a security
    // finding never clears this way: it needs both a changed test file (the `test !== null` branch above) and a change to the file at
    // its path (the check above); with no test it stays open here.
    return !open.security && open.severity !== "warning" && reason !== null ? { ...open, status: "fixed", test: null, reason, fix: null } : open;
  });
}

// The skill files the host reads from the main checkout, never the worktree: the worktree is branch-controlled.
export type SkillFiles = { lenses: string; bar: string; severities: string; agentBody: string; repoLenses?: string };

// One reviewer of a team: its 1-based id in the round, the subagent's name, the absolute path of its prompt file and its lens.
export type TeamMember = { id: number; agent: string; file: string; reviewer: Reviewer };

// What each requested id of a lead's answer came to: its findings, or why they were refused.
export type TeamAnswer = Map<number, { findings: ReviewerFinding[] } | { error: ReviewerAnswerError }>;

// Why the lead's answer is refused when its last wrapper has no closing tag: the lead's reply was most likely cut off at its output limit.
const UNCLOSED_WRAPPER = "a wrapper is not closed";

// Reads the lead's output into each requested id's findings. Only the tags `<review-{nonce}-{n}>` and `</review-{nonce}-{n}>` count; the nonce is
// the host's, fresh for each lead run, and kept out of the subagents' definitions and instructions. It is defence in depth only: the lead's prompt holds it, and Claude Code may save that prompt
// to a session file the subagents' Read could reach, so safety rests on the checks below, not on the nonce being secret. Every anomaly in those tags fails every
// requested id, so a forged or duplicated wrapper can never clear another lens's findings: an id nobody asked for, a tag twice, a closing tag
// before its opening tag, wrappers nested or overlapping, an opening tag with no closing tag. Otherwise each id's block goes to
// parseReviewerAnswer, and an id with no wrapper gets an error of its own. Text outside the wrappers is ignored. A lead that empties or
// shortens a subagent's `<findings>` block inside its wrapper cannot be told from the subagent's own answer (the host sees only the lead's output):
// a residual this parser cannot close. Every subagent's text reaches the lead, so one lens's injected text can try to change what the lead relays for another lens;
// the lead's prompt forbids it and it has no write tool, which limits what it can do but does not stop it. The default stays sequential for that reason.
export function parseTeamAnswer(stdout: string, nonce: string, ids: readonly number[]): TeamAnswer {
  const answer: TeamAnswer = new Map();
  const malformed = (why: string) => {
    for (const id of ids) answer.set(id, { error: new ReviewerAnswerError(`the lead's answer is malformed: ${why}`) });
    return answer;
  };
  const escaped = nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tags = [...stdout.matchAll(new RegExp(`<(/?)review-${escaped}-(\\d+)>`, "g"))];
  const blocks = new Map<number, string>();
  let open: { id: number; end: number } | undefined;
  for (const tag of tags) {
    const closing = tag[1] === "/";
    const id = Number(tag[2]);
    if (!ids.includes(id)) return malformed("it has a wrapper for a lens that was not asked for");
    if (!closing) {
      if (open !== undefined) return malformed("its wrappers are nested or overlap");
      if (blocks.has(id)) return malformed("a lens appears twice");
      open = { id, end: tag.index + tag[0].length };
    } else {
      if (open === undefined) return malformed("a closing tag comes before its opening tag");
      if (open.id !== id) return malformed("its wrappers are nested or overlap");
      blocks.set(id, stdout.slice(open.end, tag.index));
      open = undefined;
    }
  }
  if (open !== undefined) return malformed(UNCLOSED_WRAPPER);
  for (const id of ids) {
    const block = blocks.get(id);
    if (block === undefined) {
      answer.set(id, { error: new ReviewerAnswerError("the lead returned no block for this lens") });
      continue;
    }
    try {
      answer.set(id, { findings: parseReviewerAnswer(block) });
    } catch (error) {
      if (!(error instanceof ReviewerAnswerError)) throw error;
      answer.set(id, { error });
    }
  }
  return answer;
}

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
  // Runs a round's reviewers as parallel subagents of one lead run and returns the lead's output. When present, the round uses it, not runReviewer.
  runReviewerTeam?(members: TeamMember[], prompt: string): Promise<string>;
  // A fresh nonce for each lead run's wrapper tags; random when absent. For tests.
  nonce?: () => string;
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
// failed, which publishes the branch as a draft, with a note.
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
    // is still published, as a draft with a note. The reason is host-written: the error's own text may hold an agent's words.
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
    const largest = Math.max(prepared.readPatch.length, prepared.readFixes?.length ?? 0);
    if (largest > MAX_REVIEW_PATCH_BYTES) {
      host.log(`  ✗ the local review failed: round ${round}'s diff is ${largest} bytes, past the limit of ${MAX_REVIEW_PATCH_BYTES}`);
      return { status: "failed", head: prepared.head, reason: "the diff is too large to review" };
    }
    for (const path of patchPaths(prepared.readPatch.toString("utf8"))) readPaths.add(path);
    // The branch is the same in every round, so only the first says so. It advises and never stops the review.
    const size = round === 1 ? sizeWarning(prepared.patch) : undefined;
    if (size !== undefined) host.log(`  ⚠ ${size}`);
    await host.writeRunFile(`${runRel}/diff.patch`, prepared.readPatch);
    if (prepared.readFixes !== undefined) await host.writeRunFile(`${runRel}/fixes.patch`, prepared.readFixes);
    else await host.removeRunFile(`${runRel}/fixes.patch`);
    await host.writeRunFile(`${runRel}/decisions.md`, decisionsMarkdown(recorded));
    const reviewers = reviewersFor(patchPaths((prepared.readFixes ?? prepared.readPatch).toString("utf8")), lenses);
    host.log(`  review round ${round}: ${reviewers.map((reviewer) => reviewer.lens).join(", ")}`);
    if (reviewers.length > MAX_REVIEWERS_PER_ROUND) {
      host.log(`  ✗ the local review failed: round ${round} has ${reviewers.length} reviewers, past the limit of ${MAX_REVIEWERS_PER_ROUND} that its time bounds allow`);
      return { status: "failed", head: prepared.head, reason: "the round has more reviewers than the review's time bounds allow" };
    }

    const promptFor = (reviewer: Reviewer, problem: string | undefined) =>
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
        // A reader patch is shorter than the whole one exactly when a verbatim mirror was left out of it.
        mirrorsLeftOut: prepared.readPatch.length !== prepared.patch.length || (prepared.readFixes?.length ?? 0) !== (prepared.fixes?.length ?? 0),
      }) + (problem === undefined ? "" : retryNote(problem));
    // Two ways to start the round's reviewers. With `runReviewerTeam` they are parallel subagents of one lead run (askTeam); without it they run
    // one after another, below. Everything after them is shared.
    let settled: PromiseSettledResult<ReviewerFinding[]>[] = [];
    if (host.runReviewerTeam !== undefined) {
      const team = await askTeam(host, host.runReviewerTeam, reviewers, promptFor, { round, runRel, runDir, spent, outOfTime });
      if ("stopped" in team) return team.stopped;
      settled = team.settled;
    } else {
      // The sequential mode: one after another, never together: each role run sets up the sandbox's global git config, and runs started together race for its lock
      // (a real run lost four of ten reviewers to `could not lock config file`). The round ends at the first reviewer that fails: the review ends
      // as failed anyway, so the reviewers after it would only spend the review's time. A usage-limit stop or a stalled sandbox ends the round at
      // once too, by rethrowing (the time budget's stop does too, and runHostReview turns it into a failed review).
      for (const reviewer of reviewers) {
        if (spent()) return outOfTime(`the ${reviewer.lens} reviewer`);
        const result = await reviewerFindings(host, reviewer, (problem) => promptFor(reviewer, problem)).then(
          (value): PromiseFulfilledResult<ReviewerFinding[]> => ({ status: "fulfilled", value }),
          (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
        );
        if (result.status === "rejected" && result.reason instanceof UncountedStopError) throw result.reason;
        settled.push(result);
        if (result.status === "rejected") break;
      }
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

// The round's reviewers as parallel subagents of one lead run. Each lens's full prompt is a file under the run's folder, which its subagent reads; the lead only starts
// the subagents and returns each answer between that lens's tags, and the host parses every lens's block itself (parseTeamAnswer). A lens whose block is missing or
// invalid is asked for again, alone, quoting what was wrong (REVIEWER_ATTEMPTS asks per lens); the others' findings are kept. When the relay was cut off at the lead's
// output limit (UNCLOSED_WRAPPER for every requested lens), the next attempt asks the lenses in two halves, each its own lead run with its own nonce, so a round
// spends at most 2 * REVIEWER_ATTEMPTS - 1 lead runs (three while REVIEWER_ATTEMPTS is 2); the time cap is checked before each lead run. A lead that times out or fails ends the round at once with no retry
// (a retry would spend another timeout), as the sequential path never retries a timeout, and blames every lens of the attempt that has no answer yet. An
// UncountedStopError is rethrown. The result is aligned with `reviewers`, or says the review ran out of time.
async function askTeam(
  host: HostReviewHost,
  runReviewerTeam: NonNullable<HostReviewHost["runReviewerTeam"]>,
  reviewers: readonly Reviewer[],
  promptFor: (reviewer: Reviewer, problem: string | undefined) => string,
  { round, runRel, runDir, spent, outOfTime }: { round: number; runRel: string; runDir: string; spent: () => boolean; outOfTime: (at: string) => HostReviewResult },
): Promise<{ settled: PromiseSettledResult<ReviewerFinding[]>[] } | { stopped: HostReviewResult }> {
  const settled: PromiseSettledResult<ReviewerFinding[]>[] = reviewers.map(() => ({ status: "rejected", reason: new ReviewerAnswerError("the lens was not asked") }));
  // Positions in `reviewers` still to answer, each with what was wrong with its last answer.
  let pending = new Map<number, string | undefined>(reviewers.map((_, index) => [index, undefined]));
  // True when the last lead run's relay was cut off (see UNCLOSED_WRAPPER): asking for the same lenses again would be cut off at the same place.
  let cutOff: boolean = false;
  for (let attempt = 1; pending.size > 0; attempt++) {
    if (spent()) return { stopped: outOfTime("the review lead") };
    const members: TeamMember[] = [];
    for (const [index, problem] of pending) {
      const id = index + 1;
      const member = { id, agent: `lens-${id}`, file: `${runDir}/lens-${id}.md`, reviewer: reviewers[index]! };
      await host.writeRunFile(`${runRel}/lens-${id}.md`, promptFor(member.reviewer, problem));
      members.push(member);
    }
    // After a relay cut off at the lead's output limit, the lenses are asked for in two halves, each in a lead run of its own, so each relay is about half as long.
    const middle: number = cutOff ? Math.ceil(members.length / 2) : members.length;
    const waves: TeamMember[][] = [members.slice(0, middle), members.slice(middle)].filter((wave) => wave.length > 0);
    cutOff = false;
    const next = new Map<number, string | undefined>();
    for (const wave of waves) {
      if (spent()) return { stopped: outOfTime("the review lead") };
      host.log(`  review round ${round}: ${wave.length} reviewers as parallel subagents of one lead run`);
      // Drawn for each lead run, a retry or the second half included: a wrapper left from an earlier run must not speak for a lens in this one.
      const nonce = (host.nonce ?? (() => randomBytes(12).toString("hex")))();
      let stdout: string;
      try {
        stdout = await runReviewerTeam(wave, leadPrompt({ nonce, members: wave.map((member) => ({ id: member.id, agent: member.agent, lens: member.reviewer.lens })) }));
      } catch (error) {
        if (error instanceof UncountedStopError) throw error;
        // This wave's lenses and those of the halves still to run are blamed on this error: their attempt-1 answer error ("gave no valid answer") would be false
        // for a lens that was never asked again. An earlier half's answers stay as they are.
        for (const pendingMember of [...wave, ...waves.slice(waves.indexOf(wave) + 1).flat()]) settled[pendingMember.id - 1] = { status: "rejected", reason: error };
        return { settled };
      }
      const answer = parseTeamAnswer(stdout, nonce, wave.map((member) => member.id));
      cutOff = cutOff || wave.every((member) => {
        const got = answer.get(member.id);
        return got !== undefined && "error" in got && got.error.message.includes(UNCLOSED_WRAPPER);
      });
      for (const member of wave) {
        const index = member.id - 1;
        const got = answer.get(member.id);
        if (got !== undefined && "findings" in got) {
          settled[index] = { status: "fulfilled", value: got.findings };
          continue;
        }
        const error = got?.error ?? new ReviewerAnswerError("the lead returned no block for this lens");
        settled[index] = { status: "rejected", reason: error };
        if (attempt < REVIEWER_ATTEMPTS) {
          next.set(index, error.message);
          host.log(`  ⚠ the ${member.reviewer.lens} reviewer's answer was refused (${error.message}); asking again`);
        }
      }
    }
    pending = next;
  }
  return { settled };
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

// The most findings the follow-up issue lists, and the longest line it keeps. The issue is public, so a reviewer's text is bounded.
const ADVISORY_ISSUE_FINDINGS = 20;
const ADVISORY_LINE_LIMIT = 2000;

// What GitHub renders as a link or an image, or fetches: an address with a scheme (`://`, `mailto:`), a www. address (GitHub links one anywhere after a space or
// an underscore too, in a path as well as in prose), an inline, reference or image link (`](`, `][`, `![`), and a link reference definition (`]:`). A finding whose
// line holds one is not published: a reviewer that read untrusted text can be made to put one in a summary or fix, and the host would publish it under its own account.
const RENDERED_LINK = /:\/\/|mailto:|www\.|\]\(|\]\[|!\[|\]:/i;

// The public follow-up issue's body for the review's open Advisory findings (review-ledger.mts#renderAdvisories), held to the PR note's rules: a
// finding is listed only when its path is one of the files the review read and is made of plain file-name characters, its line (id, place, summary and fix)
// is no longer than ADVISORY_LINE_LIMIT and holds no link or image GitHub would render (RENDERED_LINK), and `publishable` leaves that line as it is
// (the host's public-text check: a reviewer that read untrusted text can quote a secret in a summary or fix). Hidden text is held to ADR 0010's rule
// (status.mts#hasHiddenText: what terminalText would drop). It is asked of the branch the header quotes together with the fields (id, path, summary,
// fix) of the findings listed so far and the next one, never of the rendered line, whose zero-width spaces the host adds itself after an @, a # or "github.com".
// So a branch that holds hidden text leaves every finding out (and the body empty), and the issue as a whole keeps no more than eight joiners and no more than eight private-use or unassigned
// code points, as one text does, and no run of more than eight marks: a finding that would exceed that is left out. A next-line character (U+0085) is left
// out too, since terminalText reads it as a space but plainText, which writes the issue, does not. `publishable` sees the finding's rendered line, then its path, summary and fix as the reviewer wrote them (trimmed, since publicError trims), never the header with the branch name.
// At most ADVISORY_ISSUE_FINDINGS are listed; the findings left out are counted, and stay in the local review record. Empty when nothing can be listed.
export function advisoryIssueBody(ledger: Ledger, readPaths: ReadonlySet<string>, publishable: (text: string) => boolean = () => true): string {
  const rendered = ledger.findings
    .map((finding) => ({ finding, text: renderAdvisories({ ...ledger, findings: [finding] }) }))
    .filter((entry) => entry.text !== "");
  const listed: Ledger["findings"] = [];
  let shown = ledger.branch;
  for (const { finding, text } of rendered) {
    if (listed.length >= ADVISORY_ISSUE_FINDINGS) break;
    const path = diffPath(finding.path);
    const line = text.split("\n").find((candidate) => candidate.startsWith("- ")) ?? "";
    const together = `${shown} ${finding.id} ${finding.path} ${finding.summary} ${finding.fix ?? ""}`;
    if (!readPaths.has(path) || !SAFE_NOTE_PATH.test(path) || line.length > ADVISORY_LINE_LIMIT || RENDERED_LINK.test(line)) continue;
    // U+0085 is whitespace to terminalText but not to plainText, which would publish it raw. The secret check sees each field as the reviewer wrote it as well as the
    // rendered line: plainText escapes & < \ ` and breaks @ and #, so a secret holding one of them no longer matches there.
    if (hasHiddenText(together) || together.includes("\u0085") || !publishable(line)) continue;
    if (![finding.path, finding.summary, finding.fix ?? ""].every((field) => publishable(field.trim()))) continue;
    listed.push(finding);
    shown = together;
  }
  // With nothing listed renderAdvisories answers "", which the caller reads as no issue to file.
  const body = renderAdvisories({ ...ledger, findings: listed });
  const left = rendered.length - listed.length;
  if (left === 0) return body;
  const note = `${left} more open Advisory finding${left === 1 ? " is" : "s are"} in the local review record and ${left === 1 ? "isn't" : "aren't"} listed here.`;
  return body.replace(`\n${SESSION_REPLY_MARKER}`, `\n${note}\n\n${SESSION_REPLY_MARKER}`);
}
