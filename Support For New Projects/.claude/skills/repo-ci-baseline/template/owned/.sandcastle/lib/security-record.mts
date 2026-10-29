// The local, git-ignored record of security findings (`.security/` in the main checkout): one file per weakness, written
// by `scripts/review.sh record` and read by the two reviews by id, lens and path only. Nothing here is published.
// Not implemented yet: the tests in security-record.test.mts and review-ledger.test.mts describe it.
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

export type SecurityOutcome = { written: string[]; repeated: { finding: string; entry: string }[]; warnings: string[] };

export function securityDir(_cwd: string): string | undefined {
  throw new Error("Not implemented");
}

export function readEntries(_cwd: string): SecurityEntry[] {
  throw new Error("Not implemented");
}

export function fingerprint(_path: string, _summary: string): string {
  throw new Error("Not implemented");
}

export function recordSecurity(
  _cwd: string,
  _ledger: Pick<Ledger, "branch">,
  _findings: SecurityInput[],
  _context: { pr?: number; slug: string },
): SecurityOutcome {
  throw new Error("Not implemented");
}

export function markAccepted(_cwd: string, _finding: { path: string; summary: string }, _reason: string): string | undefined {
  throw new Error("Not implemented");
}

export function renderSecurityList(_entries: readonly SecurityEntry[]): string {
  throw new Error("Not implemented");
}
