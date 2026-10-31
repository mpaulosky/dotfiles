import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { isOwnedPath, OWNED_PATHS, underOwnedPattern } from "./review-ledger.mts";
import { NOT_OWNED_BASELINE_PATHS, TEMPLATE_OWNED_DIR } from "./repo-config.mts";

// The local review lets a Baseline re-Apply through when it changes only Owned files (lib/review-ledger.mts#checkReview, REVIEWED_ON_REAPPLY apart), by the
// patterns in OWNED_PATHS. They are written by hand, so they are held to the Template's template/owned/ folder here. This file is
// dotfiles', not the Template's.

const root = fileURLToPath(new URL("../../", import.meta.url));
const owned = join(root, TEMPLATE_OWNED_DIR);

const filesUnder = (folder: string): string[] =>
  (readdirSync(folder, { recursive: true }) as string[])
    .filter((entry) => statSync(join(folder, entry)).isFile())
    .map((entry) => entry.split("\\").join("/"))
    // Test runs leave these behind in the working tree; git ignores them.
    .filter((entry) => !/(^|\/)(__pycache__|\.pytest_cache|node_modules)(\/|$)/.test(entry));

describe("OWNED_PATHS against the Template's template/owned/", () => {
  it("covers every file the Template's Owned folder holds", () => {
    const uncovered = filesUnder(owned).filter((file) => !underOwnedPattern(file));

    assert.deepEqual(uncovered, [], "add a pattern to OWNED_PATHS in lib/review-ledger.mts, and in the Template's copy");
  });

  it("has no pattern that matches none of them", () => {
    const files = filesUnder(owned);
    const patternFor = (pattern: string) => {
      const regexp = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
      return (file: string) => regexp.test(file);
    };
    const idle = OWNED_PATHS.filter((pattern) => !files.some(patternFor(pattern)));

    assert.deepEqual(idle, []);
  });

  it("lists as NOT_OWNED_BASELINE_PATHS exactly the files under a pattern that aren't copies of the Template's", () => {
    const present = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    const templateFiles = new Set(filesUnder(owned));
    // A copy of the Template's file is Owned; one that differs, or has no Template file, is dotfiles' own.
    const isCopy = (file: string) => templateFiles.has(file) && readFileSync(join(root, file)).equals(readFileSync(join(owned, file)));
    const own = present
      .filter((file) => underOwnedPattern(file) && !isCopy(file) && file !== ".sandcastle/lib/repo-config.mts")
      .sort();

    assert.deepEqual([...NOT_OWNED_BASELINE_PATHS].sort(), own);
    for (const file of own) assert.equal(isOwnedPath(file), false, file);
  });
});
