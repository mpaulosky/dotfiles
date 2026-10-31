import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { isOwnedPath, OWNED_PATHS, REVIEWED_ON_REAPPLY, underOwnedPattern } from "./review-ledger.mts";
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

// The single Owned files a Baseline re-Apply may write without a review, each judged to be text or
// tooling the Template's own review covers. A file that carries behaviour goes in REVIEWED_ON_REAPPLY
// instead. checkReview exempts a path by its name, so a new single-file pattern in OWNED_PATHS is
// exempt by default: it fails the test below until someone puts it in one list or the other.
const EXEMPT_ON_REAPPLY_AUDITED: readonly string[] = [
  ".github/pull_request_template.md",
  ".sandcastle/main.mts",
  ".sandcastle/status.mts",
  ".sandcastle/status.test.mts",
  ".sandcastle/tsconfig.json",
  ".sandcastle/.env.example",
  ".sandcastle/.gitignore",
  ".sandcastle/.markdownlint-cli2.jsonc",
  "scripts/gate.sh",
  "scripts/check-branch-name.sh",
  "scripts/check-git-hooks.sh",
  "scripts/check-pr-title.sh",
  "scripts/sync-copilot-review.sh",
  "scripts/review.sh",
  "scripts/watch-pr.sh",
  "docs/PROCESS.md",
  "docs/CODE_OF_CONDUCT.md",
  ".claude/skills/README.md",
  ".security/README.md",
  "LICENSE",
  ".editorconfig",
  ".gitignore",
  ".markdownlint-cli2.jsonc",
  ".yamllint.yml",
  "codecov.yml",
  "GitVersion.yml",
];

describe("the files a re-Apply may write without a review", () => {
  const singleFiles: string[] = OWNED_PATHS.filter((pattern) => !pattern.includes("*"));

  it("has every single-file Owned pattern either reviewed on a re-Apply or audited as text", () => {
    const unclassified = singleFiles.filter((file) => !REVIEWED_ON_REAPPLY.has(file) && !EXEMPT_ON_REAPPLY_AUDITED.includes(file));

    assert.deepEqual(unclassified, [], "a new Owned file skips the review on a re-Apply by its path alone: put it in REVIEWED_ON_REAPPLY if it carries behaviour, or in EXEMPT_ON_REAPPLY_AUDITED here once someone has read it");
  });

  it("reviews the files whose content widens what the review, the judging roles or the build can do", () => {
    for (const file of [".claude/agents/pre-push-reviewer.md", ".sandcastle/critique-prompt.md", ".sandcastle/intake-prompt.md", "global.json"]) {
      assert.equal(REVIEWED_ON_REAPPLY.has(file), true, file);
    }
  });

  it("lists no file in both, and no file that isn't a single-file Owned pattern", () => {
    for (const file of REVIEWED_ON_REAPPLY) assert.equal(EXEMPT_ON_REAPPLY_AUDITED.includes(file), false, `${file} is in both lists`);
    const stale = [...REVIEWED_ON_REAPPLY, ...EXEMPT_ON_REAPPLY_AUDITED].filter((file) => !singleFiles.includes(file));

    assert.deepEqual(stale, []);
  });
});
