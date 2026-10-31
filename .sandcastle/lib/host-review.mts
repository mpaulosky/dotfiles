// The host-side half of the pre-push review for a branch Sandcastle built: the reviewers (the Bar and one per lens
// whose files match), the triage of their findings, the backend role's fixes and the rounds that follow them, and the
// record. Only the host records; no agent gets a shell, a token or the ledger. The rounds follow the pre-push-review
// skill's steps 4 to 8 (.claude/skills/pre-push-review/SKILL.md), and host-review.test.mts fails when the skill's lens table,
// reviewer or round limit changes without this module following.

import { z } from "zod";
import { isRoleTimeout } from "./agents.mts";
import { REVIEW_FIX_ROUNDS, REVIEWER_ATTEMPTS } from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import { decisionsMarkdown, reviewerPrompt, reviewFixPrompt } from "./host-review-prompts.mts";
import { plainText } from "./plain-text.mts";
import { FINDING_PATH_SHAPE, isSecurity, type Ledger, type PreparedRound, type ReviewInput } from "./review-ledger.mts";

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
export const LENS_APPLIES: Record<string, { appliesTo: string; matches(path: string): boolean }> = {
  "Edge cases": { appliesTo: "Any code", matches: isCode },
  "Races and caches": { appliesTo: "Shared state, caches, async code, Sandcastle runs", matches: isCode },
  "Error contract": { appliesTo: "Handlers, services, components showing errors", matches: isCode },
  "Blazor lifecycle": { appliesTo: "`.razor`, `.razor.cs`", matches: (path) => /\.razor(?:\.cs)?$/.test(path) },
  Security: { appliesTo: "Pages, endpoints, auth, workflows, scripts", matches: isCode },
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
// counts. The last block wins, as the prompt says to write nothing after the answer; a quote of the format after it can't be told from the
// answer. It fails closed on an opening tag followed by `[` after the closing tag it reads (a later answer that is malformed or cut
// short, or prose after the answer that quotes the format with an opening tag), and the reviewer is asked again.
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
  return chosen.items.map((item, index) => {
    const parsed = reviewerFindingSchema.safeParse(item);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(finding)"}: ${issue.message}`);
    throw new ReviewerAnswerError(`finding ${index + 1} is invalid: ${issues.join("; ")}`);
  });
}

// A finding as triage leaves it: ready to record, plus what the host needs to route it.
export type TriageFinding = ReviewInput["findings"][number] & { needsPerson: boolean; fixable: boolean };

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
}: {
  raw: { reviewer: Reviewer; findings: ReviewerFinding[] }[];
  firstId: number;
  reviewOnly: boolean;
}): TriageFinding[] {
  const merged = new Map<string, ReviewerFinding>();
  for (const { findings } of raw) {
    for (const found of findings) {
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

// Turn the backend's verdicts into final statuses, enforcing the skill's rules. The backend's word is self-reported, so each
// claim needs what the host can check: `fixed` needs HEAD to have moved and a test whose file the round changed (a Warning, or
// any security finding, needs the test; another finding may give a reason instead); `dismissed` needs a reason citing
// `file:line` and is never accepted for a Warning or a security finding. Everything else, and every finding that waits for a person, stays open with its suggested fix. Nothing is
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
    if (test !== null) {
      return changed.has((test.split("::")[0] ?? "").replace(/^\.\//, "")) ? { ...open, status: "fixed", test, reason, fix: null } : open;
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
  runReviewer(reviewer: Reviewer, prompt: string): Promise<string>;
  runFixer(prompt: string): Promise<void>;
  readOutcomes(): Promise<string | undefined>;
  head(): Promise<string | undefined>;
  changedFiles(from: string, to: string): string[];
  // Checkpoint 3: the gate (and gate-fixer) after a round's fixes. The commit it passed on, or undefined when red.
  gate(): Promise<string | undefined>;
  record(input: ReviewInput, at: { head: string; branch: string }): Ledger;
  log(line: string): void;
};

// How a review ends: recorded, failed (with the last commit the gate passed on, which is published), or the gate stayed red.
export type HostReviewResult =
  | { status: "recorded"; head: string; rounds: number; ledger: Ledger }
  | { status: "failed"; head: string; reason: string }
  | { status: "gate failed" };

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

// Runs the review's rounds on `startHead` against `main`, and records them. A usage or time stop (UncountedStopError) from a
// reviewer or the fixer rejects, after the round's other reviewers have settled, so the branch is left for a later round. A
// reviewer that fails (a timeout, a bad answer twice, an error) ends the review as `failed`, recording nothing.
export async function runHostReview(
  host: HostReviewHost,
  input: { issue: { number: number; title: string; body: string }; branch: string; main: string; startHead: string },
): Promise<HostReviewResult> {
  const progress = { head: input.startHead };
  try {
    return await runRounds(host, input, progress);
  } catch (error) {
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
  const nextId = host.takenIds(input.startHead) + 1;
  let head = input.startHead;
  let previous: PreparedRound | undefined;
  let fixingRounds = 0;

  for (let round = 1; ; round++) {
    const reviewOnly = fixingRounds >= REVIEW_FIX_ROUNDS;
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
    await host.writeRunFile(`${runRel}/diff.patch`, prepared.patch);
    if (prepared.fixes !== undefined) await host.writeRunFile(`${runRel}/fixes.patch`, prepared.fixes);
    await host.writeRunFile(`${runRel}/decisions.md`, decisionsMarkdown(recorded));
    const reviewers = reviewersFor(patchPaths((prepared.fixes ?? prepared.patch).toString("utf8")), lenses);
    host.log(`  review round ${round}: ${reviewers.map((reviewer) => reviewer.lens).join(", ")}`);

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
    const settled = await Promise.allSettled(reviewers.map(ask));
    const stop = settled.find((result): result is PromiseRejectedResult => result.status === "rejected" && result.reason instanceof UncountedStopError);
    if (stop !== undefined) throw stop.reason;
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
    const triaged = triageRound({ raw, firstId: nextId + recorded.length, reviewOnly });
    const fixable = triaged.filter((finding) => finding.fixable);

    let advanced = false;
    let final: ReviewInput["findings"];
    if (fixable.length === 0) {
      final = applyOutcomes(triaged, [], [], false);
    } else {
      try {
        await host.runFixer(reviewFixPrompt({ issue, branch, round, findings: fixable, outcomesPath: `${runDir}/outcomes.json` }));
      } catch (error) {
        if (error instanceof UncountedStopError) throw error;
        host.log(`  ✗ the local review failed: the backend role's run for round ${round} ended in an error: ${errorText(error)}`);
        return { status: "failed", head: prepared.head, reason: `the backend role's run fixing round ${round}'s findings ${failureText(error)}` };
      }
      const after = await host.head();
      const moved = after !== undefined && after !== prepared.head ? after : undefined;
      advanced = moved !== undefined;
      const changed = moved === undefined ? [] : host.changedFiles(prepared.head, moved);
      final = applyOutcomes(triaged, parseOutcomes(await host.readOutcomes(), host.log), changed, advanced);
    }
    recorded.push(...final);
    previous = prepared;

    // Only a round that changed the code is followed by another: the last round must have read the commit that is recorded.
    // Whether the backend's word that something was fixed holds is applyOutcomes' business; commits that landed are reviewed
    // either way, since the branch carries them.
    if (!advanced) return record(host, input, prepared, round, recorded);
    host.log(`  review round ${round}: ${final.filter((finding) => finding.status === "fixed").length} fixed, running the gate (checkpoint 3)`);
    fixingRounds++;
    const gated = await host.gate();
    if (gated === undefined) return { status: "gate failed" };
    head = gated;
    progress.head = gated;
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

// One reviewer's findings. A usage or time stop is rethrown at once; an invalid answer is asked for again, quoting what was
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
function record(host: HostReviewHost, input: { branch: string }, last: PreparedRound, rounds: number, findings: ReviewInput["findings"]): HostReviewResult {
  try {
    const ledger = host.record(
      { reviewedKey: last.key, reviewedHead: last.head, rounds, reviewerAgent: "pre-push-reviewer", findings },
      { head: last.head, branch: input.branch },
    );
    return { status: "recorded", head: last.head, rounds, ledger };
  } catch (error) {
    host.log(`  ✗ the local review's record was refused: ${errorText(error)}`);
    return { status: "failed", head: last.head, reason: "the ledger refused the review's record" };
  }
}

// The most findings the PR note lists, and the most characters of each field of one: the note is appended to a description that may
// already be near GitHub's limit, and its text is a reviewer's, so its size is bounded here.
const NOTE_FINDINGS = 20;
const NOTE_FIELD_LIMIT = 300;
const cut = (text: string) => (text.length <= NOTE_FIELD_LIMIT ? text : `${[...text].slice(0, NOTE_FIELD_LIMIT).join("")}…`);

// The PR note listing the findings the review left open: each non-security one with its place, summary and suggested fix, as
// plain text. A security finding (isSecurity: a Warning, a lens that names security, or one not marked otherwise) is only
// counted, since nothing security is published. Empty when nothing is open.
export function openFindingsNote(ledger: Ledger): string {
  const open = ledger.findings.filter((finding) => finding.status === "open");
  if (open.length === 0) return "";
  const listed = open.filter((finding) => !isSecurity(finding));
  const hidden = open.length - listed.length;
  const shown = listed.slice(0, NOTE_FINDINGS);
  const lines = shown.map((finding) => {
    const fix = finding.fix == null ? "" : ` Suggested fix: ${cut(plainText(finding.fix))}`;
    return `- ${finding.id} ${cut(plainText(`${finding.path}:${finding.line}`))}: ${cut(plainText(finding.summary))}${fix}`;
  });
  const more = listed.length - shown.length;
  return [
    "The local review left these findings open:",
    "",
    ...lines,
    ...(more > 0 ? [...(lines.length > 0 ? [""] : []), `${more} more open finding${more === 1 ? " is" : "s are"} in the local review record and aren't listed here.`] : []),
    ...(hidden > 0 ? [...(lines.length > 0 ? [""] : []), `${hidden} security finding${hidden === 1 ? " is" : "s are"} left open in the local review record and aren't listed here.`] : []),
  ].join("\n");
}
