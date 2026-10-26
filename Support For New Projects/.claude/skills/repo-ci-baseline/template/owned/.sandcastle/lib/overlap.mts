// ---------------------------------------------------------------------------
// File overlap
//
// Before the critique, the host holds back, in code, any pick whose planned
// files share a path with a pick kept earlier in the planner's order or with
// an open PR into main (two builds both rewrote build.mts's merge-main
// code and the second PR went DIRTY). The critique's own overlap check is a
// judgment and sees only this queue's PRs; this one is neither. A held pick
// is only skipped for the round, with no "blocked by" link: next round the
// earlier pick has an open PR, which this check sees.
// ---------------------------------------------------------------------------

import { publicErrorText } from "./build.mts";
import { OVERLAP_MARKER } from "./config.mts";
import { TEMPLATE_OWNED_DIR, TEMPLATE_ROOT_COPIES } from "./repo-config.mts";
import {
  commentOnIssue,
  openPullRequestsIntoMain,
  pullRequestFiles,
  type OpenPullRequest,
  type SandcastleIssue,
} from "./github.mts";
import { plainText } from "./plain-text.mts";
import { CONTROL_CHARACTER } from "./plan.mts";
import { outcomeReport, type OutcomeReport } from "./report.mts";
import { containsSandboxSecret } from "./sandbox-env.mts";

// A pick with the files the planner expects it to change (lib/plan.mts#resolveFiles); [] when it named none.
export type FilePick = SandcastleIssue & { files: string[] };

// An open PR into main and the paths it changes.
export type ChangingPullRequest = { number: number; files: string[] };

// Why a pick is held back.
export type Overlap =
  // An earlier kept pick, #blocker, also names `path`.
  | { kind: "pick"; blocker: number; path: string }
  // Open PR #blocker changes `path`.
  | { kind: "pr"; blocker: number; path: string }
  // The pick named no files, so it counts as changing every file.
  | { kind: "no files"; waitsOn: { kind: "pick" | "pr"; number: number } };

// The GitHub reads and writes the check needs; tests pass a stub.
export type OverlapGitHub = {
  openPullRequestsIntoMain(): OpenPullRequest[];
  pullRequestFiles(pr: number): string[];
  comment(issue: number, body: string): void;
};

// A path a kept pick claims, so no later pick can.
type Claim = { number: number; path: string };

const ROOT_COPIES: ReadonlySet<string> = new Set(TEMPLATE_ROOT_COPIES);

// The path two picks or a pick and a PR are compared by. In a repo that holds
// the Template itself and carries root copies of some of its Owned files
// (lib/repo-config.mts#TEMPLATE_ROOT_COPIES), such a Template file maps to its
// root copy, since every change to one changes the other. Only the files in
// that list map: an Owned scripts/gate.sh under TEMPLATE_OWNED_DIR and the
// repo's own scripts/gate.sh are different files. In any other repo the list
// is empty and every path is its own key. Case-sensitive, as git is.
export function pathKey(path: string): string {
  const prefix = `${TEMPLATE_OWNED_DIR}/`;
  if (!path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  return ROOT_COPIES.has(rest) ? rest : path;
}

// Whether two paths are the same file, or one is a folder that holds the
// other, with or without a trailing "/" (resolveFiles drops it). Each
// path is compared under every name it goes by: a root copy is also its
// Template file, so a folder holding either holds both.
function sharesPath(a: string, b: string): boolean {
  const covers = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`);
  return aliases(a).some((left) => aliases(b).some((right) => covers(left, right) || covers(right, left)));
}

// The names `path` goes by, without a trailing "/": itself, and for a
// Template file the repo carries a root copy of, the other one of the pair.
function aliases(path: string): string[] {
  const trimmed = path.replace(/\/+$/, "");
  const key = pathKey(trimmed);
  if (key !== trimmed) return [trimmed, key];
  return ROOT_COPIES.has(trimmed) ? [trimmed, `${TEMPLATE_OWNED_DIR}/${trimmed}`] : [trimmed];
}

// The picks to hold back, and why, keyed by issue number in the planner's
// order. Pure, so the rules are pinned without GitHub:
// - A pick with files is held on the first of its own paths that overlaps
//   something: behind the earliest kept pick that claims it, or else the
//   lowest-numbered PR that changes it. The picks with files are walked in
//   the planner's order.
// - A kept pick claims its paths. A held one claims nothing, since it isn't
//   built this round, so a pick behind it can still be.
// - A pick with no files counts as changing every file, so it waits on the
//   lowest-numbered open PR, or else the first kept pick with files. With
//   neither, the first pick with no files is built and the others wait on it:
//   two such picks never wait on each other, which would build neither.
export function findOverlaps(
  picks: readonly FilePick[],
  pullRequests: readonly ChangingPullRequest[],
): Map<number, Overlap> {
  const byNumber = [...pullRequests].sort((a, b) => a.number - b.number);
  const claimed: Claim[] = [];
  const held = new Map<number, Overlap>();

  for (const pick of picks) {
    if (pick.files.length === 0) continue;
    const overlap = firstOverlap(pick.files, claimed, byNumber);
    if (overlap) {
      held.set(pick.number, overlap);
    } else {
      claimed.push(...pick.files.map((path) => ({ number: pick.number, path })));
    }
  }

  const noFiles = picks.filter((pick) => pick.files.length === 0);
  const blocker = noFilesBlocker(byNumber, claimed, noFiles);
  for (const pick of noFiles) {
    if (blocker && !(blocker.kind === "pick" && blocker.number === pick.number)) {
      held.set(pick.number, { kind: "no files", waitsOn: blocker });
    }
  }

  const inPlannerOrder = new Map<number, Overlap>();
  for (const pick of picks) {
    const overlap = held.get(pick.number);
    if (overlap) inPlannerOrder.set(pick.number, overlap);
  }
  return inPlannerOrder;
}

// What the picks with no files wait on: the lowest-numbered open PR, or else
// the first kept pick with files, or else the first pick with no files, which
// is itself built. Undefined when there's none of these.
function noFilesBlocker(
  pullRequests: readonly ChangingPullRequest[],
  claimed: readonly Claim[],
  noFiles: readonly FilePick[],
): { kind: "pick" | "pr"; number: number } | undefined {
  const [pullRequest] = pullRequests;
  if (pullRequest) return { kind: "pr", number: pullRequest.number };
  const [kept] = claimed;
  if (kept) return { kind: "pick", number: kept.number };
  const [first] = noFiles;
  if (first) return { kind: "pick", number: first.number };
  return undefined;
}

// The overlap of the first of `files` that a kept pick claims or a PR changes,
// or undefined when none does. A kept pick wins over a PR for the same path.
function firstOverlap(
  files: readonly string[],
  claimed: readonly Claim[],
  pullRequests: readonly ChangingPullRequest[],
): Overlap | undefined {
  for (const path of files) {
    const pick = claimed.find((claim) => sharesPath(path, claim.path));
    if (pick) return { kind: "pick", blocker: pick.number, path };
    const pr = pullRequests.find((candidate) => candidate.files.some((file) => sharesPath(path, file)));
    if (pr) return { kind: "pr", blocker: pr.number, path };
  }
  return undefined;
}

// The comment on a held pick, naming the file and the pick or PR it waits on,
// like the critique's deferral comment, after OVERLAP_MARKER, which is how a
// later run sees it's already there. The path comes from the planner,
// so it goes through publicErrorText and plainText: no secret, mention,
// cross-reference or forged marker reaches a public issue. The blocker's "#N"
// stays live.
export function overlapComment(overlap: Overlap): string {
  return `${overlapMarker(overlap)}\n${overlapReason(overlap)}`;
}

// The marker of overlapComment: OVERLAP_MARKER and what the hold waits on, so
// holdOverlappingPicks posts again when the blocker changes, not when only the
// path does. The numbers come from the host, never the planner.
export function overlapMarker(overlap: Overlap): string {
  const waitsOn = overlap.kind === "no files" ? overlap.waitsOn : { kind: overlap.kind, number: overlap.blocker };
  const why = overlap.kind === "no files" ? "no-files " : "";
  return `${OVERLAP_MARKER} ${why}${waitsOn.kind}#${waitsOn.number} -->`;
}

// overlapComment's text.
function overlapReason(overlap: Overlap): string {
  switch (overlap.kind) {
    case "pick": {
      const path = publicPath(overlap.path);
      const n = overlap.blocker;
      return (
        `Sandcastle held this issue back this round: the planner expects it to change ${path}, which #${n}, built this round, changes ` +
        `too, so their pull requests would conflict. Sandcastle plans it again in its next run, and holds it back while #${n}'s pull ` +
        "request is open."
      );
    }
    case "pr": {
      const path = publicPath(overlap.path);
      const n = overlap.blocker;
      return (
        `Sandcastle held this issue back this round: the planner expects it to change ${path}, which pull request #${n} changes too, ` +
        `so the two would conflict. Sandcastle plans it again in its next run, and holds it back while #${n} is open.`
      );
    }
    case "no files": {
      const { kind, number } = overlap.waitsOn;
      const ref = kind === "pick" ? `#${number}` : `pull request #${number}`;
      return (
        "Sandcastle held this issue back this round: the planner didn't name the files it expects the issue to change, so it counts as " +
        "changing every file. Such an issue is built only when no pull request into main is open and no other pick that names files " +
        `is built that round, and then only the first of them; this round it would wait on ${ref}.`
      );
    }
  }
}

// A planner-named path as it may appear on a public issue.
function publicPath(path: string): string {
  return plainText(publicErrorText(path, containsSandboxSecret));
}

// Splits the round's picks into those to build and those held back, both in
// the planner's order, before the critique runs, and says why each was held,
// by issue number. Each held pick is logged, reaches the run report as
// "deferred", and gets overlapComment unless the newest comment with an
// OVERLAP_MARKER on the issue has this hold's overlapMarker, whatever path it
// named: a pick behind an open PR is held again every run until the PR
// closes, and each run would post another otherwise. A later hold
// behind another blocker has another marker, so it is explained too.
// A failed read of the open PRs or of one PR's files throws, ending the run
// red: building without knowing what's open is the unsafe direction. A
// failed comment is only logged, and the pick stays held.
export function holdOverlappingPicks<T extends FilePick>(
  picks: T[],
  github: OverlapGitHub = liveGitHub,
  log: (line: string) => void = console.log,
  report: OutcomeReport = outcomeReport,
): { kept: T[]; held: T[]; overlaps: Map<number, Overlap> } {
  if (picks.length === 0) return { kept: [], held: [], overlaps: new Map() };

  const pullRequests = github
    .openPullRequestsIntoMain()
    .map(({ number }) => ({ number, files: github.pullRequestFiles(number) }));
  const overlaps = findOverlaps(picks, pullRequests);

  for (const pick of picks) {
    const overlap = overlaps.get(pick.number);
    if (!overlap) continue;
    const ref = `#${pick.number}`;
    log(`  ⏸ Holding ${ref} back this round: ${overlapLog(overlap)}.`);
    report.record({ kind: "issue", number: pick.number, outcome: "deferred", detail: overlapDetail(overlap) });

    const newest = pick.comments.findLast((comment) => comment.includes(OVERLAP_MARKER));
    if (newest?.includes(overlapMarker(overlap))) continue;
    try {
      github.comment(pick.number, overlapComment(overlap));
    } catch (error) {
      log(`  ⚠ ${ref} is held back, but the comment explaining why couldn't be posted (${error}).`);
    }
  }

  return {
    kept: picks.filter((pick) => !overlaps.has(pick.number)),
    held: picks.filter((pick) => overlaps.has(pick.number)),
    overlaps,
  };
}

// Why a pick is held, for the host's log, with the path's control characters
// escaped: a PR's path can hold a line break, and a log line starting "::" is
// a workflow command in Actions.
function overlapLog(overlap: Overlap): string {
  switch (overlap.kind) {
    case "pick":
      return `it and #${overlap.blocker} both change ${logPath(overlap.path)}`;
    case "pr":
      return `it and PR #${overlap.blocker} both change ${logPath(overlap.path)}`;
    case "no files":
      return "the planner named no files for it";
  }
}

// Every match of lib/plan.mts#CONTROL_CHARACTER, for logPath.
const CONTROL_CHARACTERS = new RegExp(CONTROL_CHARACTER, "g");

// `path` with each control character, line break included, written as \uXXXX.
function logPath(path: string): string {
  return path.replace(CONTROL_CHARACTERS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Why a pick is held, for the run report: host text only, never the path,
// since the summary is public on a public repository.
function overlapDetail(overlap: Overlap): string {
  switch (overlap.kind) {
    case "pick":
      return `behind #${overlap.blocker}`;
    case "pr":
      return `behind PR #${overlap.blocker}`;
    case "no files":
      return "names no files";
  }
}

// The numbers of the held picks whose hold lasts the rest of the run: those
// behind an open PR, and those behind a pick in `published`, which opened one
// and so stays open for the next round's check to see. holdOverlappingPicks
// decides before the critique and the build, so a hold behind a pick the
// critique deferred, or whose build opened no PR, is released, and the held
// pick can be planned again next round.
export function lastingHolds(overlaps: ReadonlyMap<number, Overlap>, published: ReadonlySet<number>): number[] {
  return [...overlaps].flatMap(([number, overlap]) => {
    const waitsOn = overlap.kind === "no files" ? overlap.waitsOn : { kind: overlap.kind, number: overlap.blocker };
    return waitsOn.kind === "pr" || published.has(waitsOn.number) ? [number] : [];
  });
}

// The note critiqueUnpicked puts on an issue the host held back, which
// critique-prompt.md tells the critique how to read. It says only what is true
// of every hold (a shared file, no files named, or a hold from an earlier
// round), so it doesn't name a reason.
export const HELD_NOTE =
  "Held back by the host, so it won't be built this round. It is still an open issue, so a pick that depends on it must wait for it.";

// The ready issues the critique sees as unpicked: every one that wasn't kept.
// An issue the host held back is among them, marked with
// HELD_NOTE. The critique's dependency check is the safety net for a
// dependency the planner missed, so it has to see a held issue: when issue 2
// is held behind 1 and the kept 3 depends on 2, the critique can only defer
// 3 behind 2 if 2 is in front of it.
export function critiqueUnpicked(
  ready: readonly SandcastleIssue[],
  kept: readonly { number: number }[],
  heldForFiles: ReadonlySet<number>,
): (SandcastleIssue & { heldNote?: string })[] {
  const keptNumbers = new Set(kept.map((pick) => pick.number));
  return ready
    .filter((issue) => !keptNumbers.has(issue.number))
    .map((issue) => (heldForFiles.has(issue.number) ? { ...issue, heldNote: HELD_NOTE } : issue));
}

const liveGitHub: OverlapGitHub = { openPullRequestsIntoMain, pullRequestFiles, comment: commentOnIssue };
