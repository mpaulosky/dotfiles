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

// A glob from OWNED_PATHS as a test on a path, the way lib/review-ledger.mts reads it: `**` crosses folders, `*` doesn't.
const patternFor = (pattern: string) => {
  const regexp = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
  return (file: string) => regexp.test(file);
};

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

// mpaulosky/dotfiles#392: the nine prompts that instruct the pipeline's roles are Owned, each named as a single file. The pattern
// `.sandcastle/roles/*.md` would also catch the repo's own Seed roles/shared-rules.md and roles/skills.md.
const ROLE_PROMPTS = [
  ".sandcastle/plan-prompt.md",
  ".sandcastle/review-prompt.md",
  ...["architect", "backend", "tester", "follow-up", "gate-fixer", "scribe", "ui"].map((role) => `.sandcastle/roles/${role}.md`),
];

describe("the role prompts (mpaulosky/dotfiles#392)", () => {
  it("are Owned: a pattern covers each of the nine", () => {
    assert.equal(ROLE_PROMPTS.length, 9);
    for (const file of ROLE_PROMPTS) {
      assert.equal(underOwnedPattern(file), true, file);
      assert.equal(OWNED_PATHS.includes(file as never), true, `${file} is named in OWNED_PATHS as an explicit path`);
    }
  });

  it("leave the repo's own roles/shared-rules.md and roles/skills.md out of Owned", () => {
    for (const file of [".sandcastle/roles/shared-rules.md", ".sandcastle/roles/skills.md"]) {
      assert.equal(underOwnedPattern(file), false, file);
      assert.equal(isOwnedPath(file), false, file);
    }
  });

  it("are files in the Template's Owned folder, and none of them in its Seed", () => {
    const seeded = join(owned, "..", "seed");
    for (const file of ROLE_PROMPTS) {
      assert.ok(filesUnder(owned).includes(file), `${file} is not under template/owned/`);
      assert.equal(filesUnder(seeded).includes(file), false, `${file} is still in template/seed/`);
    }
    assert.ok(filesUnder(seeded).includes(".sandcastle/roles/skills.md"), "template/seed/ has no .sandcastle/roles/skills.md");
    assert.ok(filesUnder(seeded).includes(".sandcastle/roles/shared-rules.md"), "template/seed/ has no .sandcastle/roles/shared-rules.md");
  });
});

describe("the files a re-Apply may write without a review", () => {
  const singleFiles: string[] = OWNED_PATHS.filter((pattern) => !pattern.includes("*"));

  it("has every single-file Owned pattern either reviewed on a re-Apply or audited as text", () => {
    const unclassified = singleFiles.filter((file) => !REVIEWED_ON_REAPPLY.has(file) && !EXEMPT_ON_REAPPLY_AUDITED.includes(file));

    assert.deepEqual(unclassified, [], "a new Owned file skips the review on a re-Apply by its path alone: put it in REVIEWED_ON_REAPPLY if it carries behaviour, or in EXEMPT_ON_REAPPLY_AUDITED here once someone has read it");
  });

  it("reviews the files whose content widens what the review, the pipeline's roles or the build can do", () => {
    for (const file of [
      ".claude/agents/pre-push-reviewer.md",
      ".claude/skills/pre-push-review/SKILL.md",
      ".claude/skills/pre-push-review/lenses.md",
      ".claude/skills/pre-push-review/review-bar.md",
      ".sandcastle/critique-prompt.md",
      ".sandcastle/intake-prompt.md",
      ".sandcastle/check.sh",
      "global.json",
      ...ROLE_PROMPTS,
    ]) {
      assert.equal(REVIEWED_ON_REAPPLY.has(file), true, file);
    }
  });

  it("reviews every pre-push-review skill file lib/build.mts reads into the unattended reviewers' prompts", () => {
    const source = readFileSync(join(root, ".sandcastle/lib/build.mts"), "utf8");
    const read = [...source.matchAll(/read\(`\$\{skill\}\/([^`]+)`\)/g)].map((match) => `.claude/skills/pre-push-review/${match[1]}`);

    assert.ok(read.length >= 3, "build.mts no longer reads the skill's files the way this test looks for");
    for (const file of read) assert.equal(REVIEWED_ON_REAPPLY.has(file), true, `${file} is read into a reviewer's prompt, so a re-Apply that rewrites it needs a review`);
    assert.equal(underOwnedPattern(".claude/skills/pre-push-review/new-file.md"), false, "a new file in the skill's folder is not Owned, so it is never exempt unseen");
  });

  it("lists no file in both, and no file that isn't a single-file Owned pattern", () => {
    for (const file of REVIEWED_ON_REAPPLY) assert.equal(EXEMPT_ON_REAPPLY_AUDITED.includes(file), false, `${file} is in both lists`);
    const stale = [...REVIEWED_ON_REAPPLY, ...EXEMPT_ON_REAPPLY_AUDITED].filter((file) => !singleFiles.includes(file));

    assert.deepEqual(stale, []);
  });
});

// mpaulosky/dotfiles#394: a glob in OWNED_PATHS exempts every file under it from the re-Apply review by path, so a new file under one is exempt
// unseen. Each glob is a decision here, in one of two forms: `files`, the exact set of files the glob may hold (a new file under it fails the
// test below until someone adds it), or `allowed`, the kind of file it may hold (a test that can fail only when the kind is narrower than the
// glob's own pattern). A file REVIEWED_ON_REAPPLY names is classified wherever it sits, since checkReview reviews it whatever glob it falls under.
type GlobEntry = { why: string } & ({ files: readonly string[]; allowed?: never } | { allowed: RegExp; files?: never });

const EXEMPT_GLOBS_AUDITED: Readonly<Record<string, GlobEntry>> = {
  ".github/workflows/*.yml": {
    files: [
      ".github/workflows/backfill-blog-posts.yml", ".github/workflows/ci.yml", ".github/workflows/claude-review.yml", ".github/workflows/code-metrics.yml",
      ".github/workflows/codeql-analysis.yml", ".github/workflows/copilot-review-sync.yml", ".github/workflows/dependabot-auto-merge.yml",
      ".github/workflows/lint-actions.yml", ".github/workflows/lint-markdown.yml", ".github/workflows/lint-yaml.yml", ".github/workflows/pr-automerge.yml",
      ".github/workflows/pr-review-submitted.yml", ".github/workflows/pr-title.yml", ".github/workflows/release.yml", ".github/workflows/sandcastle.yml",
    ],
    why: "the Template's gate runs actionlint, zizmor, yamllint and the workflow tests over them",
  },
  ".github/hooks/**": { allowed: /(?:^|\/)(?:[^./]+|[^/]*\.sh)$/, why: "the bash hook tests and shellcheck run over them" },
  ".github/scripts/**": { allowed: /\.(?:py|mjs)$/, why: "pytest and node --test run over them" },
  ".github/instructions/*.md": {
    files: [".github/instructions/blog.instructions.md", ".github/instructions/git-commit-instructions.md", ".github/instructions/markdown.instructions.md"],
    why: "steer Copilot's review and commit messages, linted by markdownlint; they widen no tool and run no code",
  },
  ".claude/skills/hardening-review/**": { allowed: /\.(?:md|py)$/, why: "text a person's session reads when they run the hardening review, and its two .py scripts, which pytest covers; no unattended role reads them" },
  ".sandcastle/lib/*.mts": {
    files: [
      "agents.mts", "agents.test.mts", "branches.mts", "branches.test.mts", "build.mts", "build.test.mts", "building.mts", "building.test.mts", "checkpoint.mts",
      "checkpoint.test.mts", "config.mts", "config.test.mts", "critique.mts", "critique.test.mts", "diagnostics.mts", "diagnostics.test.mts", "errors.mts",
      "follow-up-pass.mts", "follow-up-pass.test.mts", "follow-up-run.mts", "follow-up-run.test.mts", "follow-up.mts", "follow-up.test.mts", "gate.mts",
      "gate.test.mts", "git-sandbox-fake.mts", "github.mts", "github.test.mts", "handback.mts", "handback.test.mts", "host-limit.mts", "host-limit.test.mts",
      "host-review-prompts.mts", "host-review-prompts.test.mts", "host-review.mts", "host-review.test.mts", "host-safety.mts", "host-safety.test.mts",
      "intake.mts", "intake.test.mts", "limits.mts", "limits.test.mts", "overlap.mts", "overlap.test.mts", "plain-text.mts", "plain-text.test.mts", "plan.mts",
      "plan.test.mts", "pre-push-review-skill.test.mts", "prompts.mts", "prompts.test.mts", "queue.mts", "queue.test.mts", "report.mts", "report.test.mts",
      "review-ledger.mts", "review-ledger.test.mts", "role-logs.mts", "role-logs.test.mts", "role-timeline.mts", "role-timeline.test.mts", "round.mts",
      "round.test.mts", "sandbox-env.mts", "sandbox-env.test.mts", "scan.mts", "scan.test.mts", "security-record.mts", "security-record.test.mts", "shell.mts",
      "shell.test.mts", "skills.mts", "skills.test.mts", "status.mts", "status.test.mts", "step-limit.mts", "step-limit.test.mts", "ui-role-fixture.mts",
      "ui-role-fixture.test.mts", "umbrella.mts", "umbrella.test.mts", "work.mts", "work.test.mts",
    ].map((name) => `.sandcastle/lib/${name}`),
    why: "tsc and the Sandcastle tests run over them; they run on the host, so a new module is a decision, not a default",
  },
  "scripts/tests/**": { allowed: /\.test\.sh$/, why: "test.sh runs them" },
};

// The files under the exempt globs that the audit doesn't classify, as "<file> (under <glob>)". A file REVIEWED_ON_REAPPLY names is reviewed on a
// re-Apply wherever it sits, so it is classified even under a glob.
const unclassifiedUnderGlobs = (files: readonly string[], audited: Readonly<Record<string, GlobEntry>>, reviewed: ReadonlySet<string>): string[] => {
  const unexpected: string[] = [];
  for (const [glob, entry] of Object.entries(audited)) {
    const under = patternFor(glob);
    for (const file of files) {
      if (!under(file) || reviewed.has(file)) continue;
      const classified = entry.files === undefined ? entry.allowed.test(file) : entry.files.includes(file);
      if (!classified) unexpected.push(`${file} (under ${glob})`);
    }
  }
  return unexpected;
};

describe("the globs that exempt a whole folder from the re-Apply review (mpaulosky/dotfiles#394)", () => {
  const globs = OWNED_PATHS.filter((pattern) => pattern.includes("*"));

  it("has every glob in OWNED_PATHS classified in EXEMPT_GLOBS_AUDITED", () => {
    const unclassified = globs.filter((glob) => !Object.hasOwn(EXEMPT_GLOBS_AUDITED, glob));

    assert.deepEqual(unclassified, [], "a new glob exempts every file under it from the re-Apply review: add it to EXEMPT_GLOBS_AUDITED with the files or the kind of file it may hold and why skipping the review is safe, or name the files as single-file patterns");
  });

  it("has no EXEMPT_GLOBS_AUDITED entry that isn't a glob in OWNED_PATHS", () => {
    const stale = Object.keys(EXEMPT_GLOBS_AUDITED).filter((glob) => !(globs as string[]).includes(glob));

    assert.deepEqual(stale, []);
  });

  it("gives each entry a reason", () => {
    for (const [glob, { why }] of Object.entries(EXEMPT_GLOBS_AUDITED)) assert.ok(why.trim().length > 0, glob);
  });

  it("holds under each exempt glob only the files or the kind of file its entry allows", () => {
    const unexpected = unclassifiedUnderGlobs(filesUnder(owned), EXEMPT_GLOBS_AUDITED, REVIEWED_ON_REAPPLY);

    assert.deepEqual(unexpected, [], "a new file under an exempt glob would skip the re-Apply review unseen: add it to the entry's `files` (or widen `allowed`) once someone has read it, or name it as a single-file pattern in OWNED_PATHS and put it in REVIEWED_ON_REAPPLY if it carries behaviour");
  });

  it("lists in each `files` entry exactly the files that exist under its glob", () => {
    const present = filesUnder(owned);
    for (const [glob, entry] of Object.entries(EXEMPT_GLOBS_AUDITED)) {
      if (entry.files === undefined) continue;
      const under = patternFor(glob);

      assert.deepEqual([...entry.files].sort(), present.filter(under).sort(), glob);
    }
  });

  it("finds files under every exempt glob, so a check isn't vacuous", () => {
    const files = filesUnder(owned);
    for (const glob of Object.keys(EXEMPT_GLOBS_AUDITED)) assert.ok(files.some(patternFor(glob)), glob);
  });

  it("reports a new file under each glob as unclassified, whatever its extension fits", () => {
    const present = filesUnder(owned);
    const fabricated: Readonly<Record<string, string>> = {
      ".github/workflows/*.yml": ".github/workflows/new.yml",
      ".github/instructions/*.md": ".github/instructions/new.md",
      ".sandcastle/lib/*.mts": ".sandcastle/lib/new.mts",
    };
    for (const [glob, file] of Object.entries(fabricated)) {
      assert.ok(patternFor(glob)(file), `${file} is under ${glob}`);
      assert.deepEqual(unclassifiedUnderGlobs([...present, file], EXEMPT_GLOBS_AUDITED, REVIEWED_ON_REAPPLY), [`${file} (under ${glob})`]);
    }
  });

  it("reports a file of another kind under a kind glob, and passes one of the kind", () => {
    assert.deepEqual(unclassifiedUnderGlobs(["scripts/tests/x.json", "scripts/tests/x.test.sh"], EXEMPT_GLOBS_AUDITED, new Set()), ["scripts/tests/x.json (under scripts/tests/**)"]);
  });

  it("accepts a file REVIEWED_ON_REAPPLY names even when it sits under an exempt glob", () => {
    const file = ".github/scripts/policy.json";

    assert.deepEqual(unclassifiedUnderGlobs([file], EXEMPT_GLOBS_AUDITED, new Set()), [`${file} (under .github/scripts/**)`]);
    assert.deepEqual(unclassifiedUnderGlobs([file], EXEMPT_GLOBS_AUDITED, new Set([file])), []);
  });
});
