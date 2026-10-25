// A crashed run never reaches lib/build.mts#buildIssue's finally, so it leaves
// sandcastle:building on its issue, and the gate (lib/gate.mts) would hold the
// issue back forever. This module, run once at startup after ensureLabels (see
// main.mts), clears a label older than BUILDING_LABEL_MAX_AGE_MS, past the
// point any real build could still be running, and leaves a live run's alone.

import { BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS } from "./config.mts";
import {
  addIssueLabel,
  issueLabels,
  issuesWithLabel,
  labelTimeline,
  removeIssueLabel,
  timestamp,
  type TimelineLabelEvent,
} from "./github.mts";

// Whether `label`'s most recent "labeled" event in `timeline` happened more
// than `maxAgeMs` before `now`. No "labeled" event for `label` in `timeline`
// counts as not stale: there's nothing a crashed run could have left behind
// to clear.
export function labelIsStale(
  timeline: readonly TimelineLabelEvent[],
  label: string,
  maxAgeMs: number,
  now: number,
): boolean {
  const labelled = timeline
    .filter((event) => event.event === "labeled" && event.label.toLowerCase() === label.toLowerCase())
    .map((event) => timestamp(event.createdAt));
  if (labelled.length === 0) return false;
  return now - Math.max(...labelled) > maxAgeMs;
}

// What clearStaleBuildingLabels needs from GitHub; tests pass a stub.
export type BuildingGitHub = {
  // Numbers of the open issues currently carrying `label`.
  issuesWithLabel(label: string): number[];
  // The issue's own "labeled"/"unlabeled" timeline events.
  labelTimeline(issueNumber: number): TimelineLabelEvent[];
  removeLabel(issueNumber: number, label: string): void;
};

export const liveBuildingGitHub: BuildingGitHub = {
  issuesWithLabel: (label) => issuesWithLabel(label),
  labelTimeline: (issueNumber) => labelTimeline(issueNumber),
  removeLabel: (issueNumber, label) => removeIssueLabel(issueNumber, label),
};

// Clears `label` (sandcastle:building) from any issue whose most recent
// labelling is older than `maxAgeMs` (see labelIsStale), so a crashed run
// doesn't hold its issue back forever. A label a live run just added stays.
// Returns the numbers of the issues it cleared, for the startup log. A
// timeline that can't be read throws, failing the run before any work,
// rather than guess whether another run is still building the issue.
export function clearStaleBuildingLabels(
  github: BuildingGitHub = liveBuildingGitHub,
  label: string = BUILDING_LABEL,
  maxAgeMs: number = BUILDING_LABEL_MAX_AGE_MS,
  now: number = Date.now(),
): number[] {
  const cleared: number[] = [];
  for (const issueNumber of github.issuesWithLabel(label)) {
    if (!labelIsStale(github.labelTimeline(issueNumber), label, maxAgeMs, now)) continue;
    github.removeLabel(issueNumber, label);
    cleared.push(issueNumber);
  }
  return cleared;
}

// What claiming and releasing sandcastle:building needs from GitHub; tests
// pass a stub.
export type BuildingLabels = {
  issueLabels(issueNumber: number): string[];
  addLabel(issueNumber: number, label: string): void;
  removeLabel(issueNumber: number, label: string): void;
};

export const liveBuildingLabels: BuildingLabels = {
  issueLabels: (issueNumber) => issueLabels(issueNumber),
  addLabel: (issueNumber, label) => addIssueLabel(issueNumber, label),
  removeLabel: (issueNumber, label) => removeIssueLabel(issueNumber, label),
};

// The issues this process has marked sandcastle:building and not yet
// unmarked, each with when this run claimed it (Date.now()). main.mts
// releases them at the start of every round, so a removal that failed doesn't
// hold the issue back for the rest of the run, and from its exit listener,
// because Ctrl-C, SIGTERM and a crash skip buildIssue's finally.
export const markedByThisRun = new Map<number, number>();

// Marks the issue sandcastle:building for this run's build, before its
// sandbox is created. The gate reads labels from the snapshot taken at the
// start of the round, so a second run that started meanwhile can pick the
// same issue: the labels are read again here, and an issue that already
// carries the label (in any case, as GitHub matches it) is left to the run
// that marked it. Returns whether this run marked it. Two runs reading within
// the same second can still both add it; this narrows the window from a
// round's planning to one round trip.
export function claimBuildingLabel(
  issueNumber: number,
  github: BuildingLabels = liveBuildingLabels,
  marked: Map<number, number> = markedByThisRun,
  now: number = Date.now(),
): boolean {
  if (github.issueLabels(issueNumber).some((label) => label.toLowerCase() === BUILDING_LABEL)) return false;
  // Remembered before the add: an add that times out or gets a proxy's 502
  // may still have applied the label. So a failed add is undone at once, and
  // if that fails too the issue stays remembered for a later release.
  marked.set(issueNumber, now);
  try {
    github.addLabel(issueNumber, BUILDING_LABEL);
  } catch (error) {
    try {
      releaseBuildingLabel(issueNumber, github, marked);
    } catch {
      // Left in `marked`; releaseAllBuildingLabels reports it if it fails again.
    }
    throw error;
  }
  return true;
}

// Removes sandcastle:building from an issue this run marked. The issue is
// forgotten only once the label is gone, so a removal that throws is tried
// again by releaseAllBuildingLabels.
export function releaseBuildingLabel(
  issueNumber: number,
  github: BuildingLabels = liveBuildingLabels,
  marked: Map<number, number> = markedByThisRun,
): void {
  github.removeLabel(issueNumber, BUILDING_LABEL);
  marked.delete(issueNumber);
}

// Removes sandcastle:building from every issue this run still holds: called
// by main.mts at the start of each round, when no build of this run is going,
// and from its exit listener, so a run stopped by Ctrl-C, SIGTERM or a crash
// doesn't hold its issues back for BUILDING_LABEL_MAX_AGE_MS. Exit listeners
// can't wait, which suits the synchronous gh calls. A label this run claimed
// more than `maxAgeMs` ago is forgotten without being removed: another run's
// startup may have cleared it as stale and claimed the issue since, so the
// label there now may be that run's. A removal that fails is reported and the
// rest carry on. Returns the issues released.
export function releaseAllBuildingLabels(
  github: BuildingLabels = liveBuildingLabels,
  marked: Map<number, number> = markedByThisRun,
  warn: (message: string) => void = console.error,
  now: number = Date.now(),
  maxAgeMs: number = BUILDING_LABEL_MAX_AGE_MS,
): number[] {
  const released: number[] = [];
  for (const [issueNumber, claimedAt] of [...marked]) {
    if (now - claimedAt > maxAgeMs) {
      marked.delete(issueNumber);
      warn(
        `  ⚠ #${issueNumber}: left ${BUILDING_LABEL} in place: this run claimed it over ${maxAgeMs / 3_600_000} hours ago, ` +
          "so another run may have cleared it as stale and claimed the issue since.",
      );
      continue;
    }
    try {
      releaseBuildingLabel(issueNumber, github, marked);
      released.push(issueNumber);
    } catch (error) {
      warn(`  ⚠ #${issueNumber}: removing ${BUILDING_LABEL} failed, so it's tried again next round or when the run exits: ${error}`);
    }
  }
  return released;
}

// Wires releaseAllBuildingLabels to the process's end (`proc` is `process` in
// main.mts), because Ctrl-C, SIGTERM and a crash skip buildIssue's finally,
// which would leave sandcastle:building holding the issue back for
// BUILDING_LABEL_MAX_AGE_MS. A label goes on before its sandbox exists, while
// Node's default signal handling would end the process without an exit event,
// so the signals exit here. Sandcastle's own signal handler, installed while a
// sandbox is open, never runs then, but the exit listener it installs
// alongside runs the same container teardown. Only SIGKILL gets past this,
// and clearStaleBuildingLabels at a later startup covers that.
export function installBuildingLabelRelease(
  proc: { on(event: "SIGINT" | "SIGTERM" | "exit", handler: () => void): unknown; exit(code: number): unknown },
  release: () => number[] = () => releaseAllBuildingLabels(),
  log: (line: string) => void = console.log,
): void {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    proc.on(signal, () => proc.exit(code));
  }
  proc.on("exit", () => {
    for (const issueNumber of release()) {
      log(`  🧹 #${issueNumber}: removed ${BUILDING_LABEL} as the run stopped.`);
    }
  });
}
