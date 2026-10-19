// ---------------------------------------------------------------------------
// File overlap
//
// Before the critique, the host holds back, in code, any pick whose planned
// files share a path with a pick kept earlier in the planner's order or with
// an open PR into main (#248: two builds both rewrote build.mts's merge-main
// code and the second PR went DIRTY). The critique's own overlap check is a
// judgment and sees only this queue's PRs; this one is neither. A held pick
// is only skipped for the round, with no "blocked by" link: next round the
// earlier pick has an open PR, which this check sees.
// ---------------------------------------------------------------------------

import { publicErrorText } from "./build.mts";
import { TEMPLATE_OWNED_DIR, TEMPLATE_ROOT_COPIES } from "./config.mts";
import {
  commentOnIssue,
  openPullRequestsIntoMain,
  pullRequestFiles,
  type OpenPullRequest,
  type SandcastleIssue,
} from "./github.mts";
import { plainText } from "./intake.mts";
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

// The path two picks or a pick and a PR are compared by: a Template Owned
// file dotfiles carries a root copy of maps to that root path, since every
// change to one changes the other (test.sh fails when they differ). Only the
// files in TEMPLATE_ROOT_COPIES map: template/owned/scripts/gate.sh and
// dotfiles' own scripts/gate.sh are different files. Case-sensitive, as git is.
export function pathKey(path: string): string {
  const prefix = `${TEMPLATE_OWNED_DIR}/`;
  if (!path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  return ROOT_COPIES.has(rest) ? rest : path;
}

// Whether two paths are the same file, or one is a directory (ending in "/")
// that holds the other.
function sharesPath(a: string, b: string): boolean {
  const [left, right] = [pathKey(a), pathKey(b)];
  return left === right || (left.endsWith("/") && right.startsWith(left)) || (right.endsWith("/") && left.startsWith(right));
}

// The picks to hold back, and why, keyed by issue number. Pure, so the rules
// are pinned without GitHub. The picks are walked in the planner's order:
// - A pick with no files counts as changing every file. It's kept only when
//   it's the round's only pick and no PR into main is open; otherwise it waits
//   on the first other pick, or, with none, the lowest-numbered PR.
// - A pick with files is held on the first of its own paths that overlaps
//   something: behind the earliest kept pick that claims it, or else the
//   lowest-numbered PR that changes it.
// - A kept pick claims its paths. A held one claims nothing, since it isn't
//   built this round, so a pick behind it can still be.
export function findOverlaps(
  picks: readonly FilePick[],
  pullRequests: readonly ChangingPullRequest[],
): Map<number, Overlap> {
  const byNumber = [...pullRequests].sort((a, b) => a.number - b.number);
  const claimed: Claim[] = [];
  const held = new Map<number, Overlap>();

  for (const pick of picks) {
    if (pick.files.length === 0) {
      const waitsOn = noFilesBlocker(pick, picks, byNumber);
      if (waitsOn) held.set(pick.number, { kind: "no files", waitsOn });
      continue;
    }

    const overlap = firstOverlap(pick.files, claimed, byNumber);
    if (overlap) {
      held.set(pick.number, overlap);
    } else {
      claimed.push(...pick.files.map((path) => ({ number: pick.number, path })));
    }
  }
  return held;
}

// What a pick with no files waits on: the first other pick in the planner's
// order, or else the first of `pullRequests`. Undefined when it's the round's
// only pick and no PR is open, so it's built.
function noFilesBlocker(
  pick: FilePick,
  picks: readonly FilePick[],
  pullRequests: readonly ChangingPullRequest[],
): { kind: "pick" | "pr"; number: number } | undefined {
  const otherPick = picks.find((other) => other.number !== pick.number);
  if (otherPick) return { kind: "pick", number: otherPick.number };
  const [pullRequest] = pullRequests;
  if (pullRequest) return { kind: "pr", number: pullRequest.number };
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
// like the critique's deferral comment. The path comes from the planner, so it
// goes through publicErrorText and plainText: no secret, mention or
// cross-reference reaches a public issue. The blocker's "#N" stays live.
export function overlapComment(overlap: Overlap): string {
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
        "changing every file. Such an issue is built only when it's the round's only pick and no pull request into main is open; this " +
        `round it would wait on ${ref}.`
      );
    }
  }
}

// A planner-named path as it may appear on a public issue.
function publicPath(path: string): string {
  return plainText(publicErrorText(path, containsSandboxSecret));
}

// Splits the round's picks into those to build and those held back, both in
// the planner's order, before the critique runs. Each held pick is logged,
// reaches the run report as "deferred", and gets overlapComment unless the
// issue already carries it (each Actions run would post it again otherwise).
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

    const body = overlapComment(overlap);
    if (pick.comments.some((comment) => comment.trim() === body.trim())) continue;
    try {
      github.comment(pick.number, body);
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

// Why a pick is held, for the host's log, with the raw path.
function overlapLog(overlap: Overlap): string {
  switch (overlap.kind) {
    case "pick":
      return `it and #${overlap.blocker} both change ${overlap.path}`;
    case "pr":
      return `it and PR #${overlap.blocker} both change ${overlap.path}`;
    case "no files":
      return "the planner named no files for it";
  }
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

const liveGitHub: OverlapGitHub = { openPullRequestsIntoMain, pullRequestFiles, comment: commentOnIssue };

// The numbers of the held picks whose hold lasts the rest of the run: those behind an open PR, and those behind a pick
// in `published`, which opened one. A hold behind any other pick is released (#251).
export function lastingHolds(_overlaps: ReadonlyMap<number, Overlap>, _published: ReadonlySet<number>): number[] {
  throw new Error("Not implemented");
}

// The ready issues the critique sees as unpicked: those neither kept nor held back for sharing a file (#251).
export function critiqueUnpicked(
  _ready: readonly SandcastleIssue[],
  _kept: readonly { number: number }[],
  _heldForFiles: ReadonlySet<number>,
): SandcastleIssue[] {
  throw new Error("Not implemented");
}
