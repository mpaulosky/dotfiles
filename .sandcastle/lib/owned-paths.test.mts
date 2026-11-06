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
// Why they stay exempt: text or tooling config no Sandcastle role reads as a prompt (a wrong one only misleads a person or fails a lint the Template
// runs), or Sandcastle's entrypoint and status command, which neither run the review nor the gate and which the Sandcastle tests cover.
const EXEMPT_ON_REAPPLY_AUDITED: readonly string[] = [
  ".github/pull_request_template.md",
  ".sandcastle/main.mts",
  ".sandcastle/status.mts",
  ".sandcastle/status.test.mts",
  ".sandcastle/tsconfig.json",
  ".sandcastle/.env.example",
  ".sandcastle/.gitignore",
  ".sandcastle/.markdownlint-cli2.jsonc",
  "scripts/check-branch-name.sh",
  "scripts/check-git-hooks.sh",
  "scripts/check-pr-title.sh",
  "scripts/sync-copilot-review.sh",
  "scripts/watch-pr.sh",
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

// The files that run the review and the gate: the Template's checks run in the Template, so in a repo they judge whatever bytes a re-Apply wrote.
const GATE_CHAIN = [
  "scripts/gate.sh",
  "scripts/review.sh",
  ".github/hooks/pre-push",
  ".sandcastle/lib/review-ledger.mts",
  ".sandcastle/lib/host-safety.mts",
  ".sandcastle/lib/sandbox-env.mts",
  ".sandcastle/lib/host-review.mts",
  ".sandcastle/lib/host-review-prompts.mts",
  ".sandcastle/lib/build.mts",
];

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
      "docs/PROCESS.md",
      ...GATE_CHAIN,
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

  it("lists no file in both, no audited file that isn't a single-file Owned pattern, and no reviewed file outside every Owned pattern", () => {
    for (const file of REVIEWED_ON_REAPPLY) assert.equal(EXEMPT_ON_REAPPLY_AUDITED.includes(file), false, `${file} is in both lists`);
    const stale = [
      ...EXEMPT_ON_REAPPLY_AUDITED.filter((file) => !singleFiles.includes(file)),
      ...[...REVIEWED_ON_REAPPLY].filter((file) => !underOwnedPattern(file)),
    ];

    assert.deepEqual(stale, []);
  });
});

// mpaulosky/dotfiles#394: a glob in OWNED_PATHS exempts every file under it from the re-Apply review by path, so a new file under one is exempt
// unseen. Each glob is a decision here: `files` is the exact set of files the glob may hold, so a new file under it fails the tests below until
// someone adds it (a kind of file, such as "any .py", would let a new script through unseen). A file REVIEWED_ON_REAPPLY names is classified
// wherever it sits, since checkReview reviews it whatever glob it falls under: it stays out of `files`.
type GlobEntry = { why: string; files: readonly string[] };

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
  ".github/hooks/**": { files: [
      ".github/hooks/post-checkout",
      ".github/hooks/pre-commit",
      ".github/hooks/tests/pre-commit.test.sh",
      ".github/hooks/tests/pre-push.test.sh",
    ], why: "the bash hook tests and shellcheck run over them; they run on the host, so a new hook is a decision" },
  ".github/scripts/**": { files: [
      ".github/scripts/backfill_blog_posts.py",
      ".github/scripts/check_gh_repo.py",
      ".github/scripts/detect_changes.py",
      ".github/scripts/discover_tests.py",
      ".github/scripts/draft_release.py",
      ".github/scripts/load_test_env.py",
      ".github/scripts/post_claude_review.py",
      ".github/scripts/release_post.py",
      ".github/scripts/release_queue.py",
      ".github/scripts/tests/conftest.py",
      ".github/scripts/tests/pr-automerge.test.mjs",
      ".github/scripts/tests/test_backfill_blog_posts.py",
      ".github/scripts/tests/test_claude_review_copilot_gate.py",
      ".github/scripts/tests/test_claude_review_merge_check.py",
      ".github/scripts/tests/test_claude_review_resolved_threads.py",
      ".github/scripts/tests/test_claude_review_review_notes.py",
      ".github/scripts/tests/test_claude_review_split_diff.py",
      ".github/scripts/tests/test_detect_changes.py",
      ".github/scripts/tests/test_discover_tests.py",
      ".github/scripts/tests/test_draft_release.py",
      ".github/scripts/tests/test_load_test_env.py",
      ".github/scripts/tests/test_pat_calls.py",
      ".github/scripts/tests/test_post_claude_review.py",
      ".github/scripts/tests/test_release_post.py",
      ".github/scripts/tests/test_release_queue.py",
    ], why: "pytest and node --test run over them; they run in CI with tokens, so a new script is a decision" },
  ".github/instructions/*.md": {
    files: [".github/instructions/blog.instructions.md", ".github/instructions/git-commit-instructions.md", ".github/instructions/markdown.instructions.md"],
    why: "steer Copilot's review and commit messages, linted by markdownlint; they widen no tool and run no code, so a wrong instruction can only shape advice",
  },
  ".claude/skills/hardening-review/**": { files: [
      ".claude/skills/hardening-review/SKILL.md",
      ".claude/skills/hardening-review/references/brief.md",
      ".claude/skills/hardening-review/references/mutations.md",
      ".claude/skills/hardening-review/references/state.md",
      ".claude/skills/hardening-review/references/triage.md",
      ".claude/skills/hardening-review/scripts/known_open.py",
      ".claude/skills/hardening-review/scripts/mutate.py",
    ], why: "text a person's session reads when they run the hardening review, and its two .py scripts, which pytest covers; no Sandcastle role reads them" },
  ".sandcastle/lib/*.mts": {
    files: [
      "agents.mts", "agents.test.mts", "branches.mts", "branches.test.mts", "build.test.mts", "building.mts", "building.test.mts", "checkpoint.mts",
      "checkpoint.test.mts", "config.mts", "config.test.mts", "critique.mts", "critique.test.mts", "diagnostics.mts", "diagnostics.test.mts", "errors.mts",
      "follow-up-pass.mts", "follow-up-pass.test.mts", "follow-up-run.mts", "follow-up-run.test.mts", "follow-up.mts", "follow-up.test.mts", "gate.mts",
      "gate.test.mts", "git-sandbox-fake.mts", "github.mts", "github.test.mts", "handback.mts", "handback.test.mts", "host-limit.mts", "host-limit.test.mts",
      "host-review-prompts.test.mts", "host-review.test.mts", "host-safety.test.mts",
      "intake.mts", "intake.test.mts", "limits.mts", "limits.test.mts", "overlap.mts", "overlap.test.mts", "plain-text.mts", "plain-text.test.mts", "plan.mts",
      "plan.test.mts", "pre-push-review-skill.test.mts", "prompts.mts", "prompts.test.mts", "queue.mts", "queue.test.mts", "report.mts", "report.test.mts",
      "review-ledger.test.mts", "role-logs.mts", "role-logs.test.mts", "role-timeline.mts", "role-timeline.test.mts", "round.mts",
      "round.test.mts", "sandbox-env.test.mts", "scan.mts", "scan.test.mts", "security-record.mts", "security-record.test.mts", "shell.mts",
      "shell.test.mts", "skills.mts", "skills.test.mts", "status.mts", "status.test.mts", "step-limit.mts", "step-limit.test.mts", "ui-role-fixture.mts",
      "ui-role-fixture.test.mts", "umbrella.mts", "umbrella.test.mts", "work.mts", "work.test.mts",
    ].map((name) => `.sandcastle/lib/${name}`),
    why: "tsc and the Sandcastle tests run over them; they run on the host, so a new module is a decision, not a default",
  },
  "scripts/tests/**": { files: [
      "scripts/tests/check-branch-name.test.sh",
      "scripts/tests/check-git-hooks.test.sh",
      "scripts/tests/check-pr-title.test.sh",
      "scripts/tests/sync-copilot-review.test.sh",
      "scripts/tests/watch-pr.test.sh",
    ], why: "test.sh runs them" },
};

// The files under the exempt globs that the audit doesn't list, as "<file> (under <glob>)". A file REVIEWED_ON_REAPPLY names is reviewed on a
// re-Apply wherever it sits, so it is classified even under a glob.
const unclassifiedUnderGlobs = (files: readonly string[], audited: Readonly<Record<string, GlobEntry>>, reviewed: ReadonlySet<string>): string[] => {
  const unexpected: string[] = [];
  for (const [glob, entry] of Object.entries(audited)) {
    const under = patternFor(glob);
    for (const file of files) {
      if (!under(file) || reviewed.has(file)) continue;
      if (!entry.files.includes(file)) unexpected.push(`${file} (under ${glob})`);
    }
  }
  return unexpected;
};

// The globs whose `files` entry differs from the files present under the glob. A file REVIEWED_ON_REAPPLY names is reviewed wherever it sits,
// so it is not listed.
const filesDrift = (present: readonly string[], audited: Readonly<Record<string, GlobEntry>>, reviewed: ReadonlySet<string>): string[] =>
  Object.entries(audited)
    .filter(([glob, entry]) => JSON.stringify([...entry.files].sort()) !== JSON.stringify(present.filter((file) => patternFor(glob)(file) && !reviewed.has(file)).sort()))
    .map(([glob]) => glob);

describe("the globs that exempt a whole folder from the re-Apply review (mpaulosky/dotfiles#394)", () => {
  const globs = OWNED_PATHS.filter((pattern) => pattern.includes("*"));

  it("has every glob in OWNED_PATHS classified in EXEMPT_GLOBS_AUDITED", () => {
    const unclassified = globs.filter((glob) => !Object.hasOwn(EXEMPT_GLOBS_AUDITED, glob));

    assert.deepEqual(unclassified, [], "a new glob exempts every file under it from the re-Apply review: add it to EXEMPT_GLOBS_AUDITED with the files it may hold and why skipping the review is safe, or name the files as single-file patterns");
  });

  it("has no EXEMPT_GLOBS_AUDITED entry that isn't a glob in OWNED_PATHS", () => {
    const stale = Object.keys(EXEMPT_GLOBS_AUDITED).filter((glob) => !(globs as string[]).includes(glob));

    assert.deepEqual(stale, []);
  });

  it("gives each entry a reason", () => {
    for (const [glob, { why }] of Object.entries(EXEMPT_GLOBS_AUDITED)) assert.ok(why.trim().length > 0, glob);
  });

  it("holds under each exempt glob only the files its entry lists", () => {
    const unexpected = unclassifiedUnderGlobs(filesUnder(owned), EXEMPT_GLOBS_AUDITED, REVIEWED_ON_REAPPLY);

    assert.deepEqual(unexpected, [], "a new file under an exempt glob would skip the re-Apply review unseen: add it to the entry's `files` once someone has read it, or name it as a single-file pattern in OWNED_PATHS and put it in REVIEWED_ON_REAPPLY if it carries behaviour");
  });

  it("lists in each `files` entry exactly the files that exist under its glob", () => {
    assert.deepEqual(filesDrift(filesUnder(owned), EXEMPT_GLOBS_AUDITED, REVIEWED_ON_REAPPLY), []);
  });

  it("leaves a file REVIEWED_ON_REAPPLY names out of its glob's `files`, and reports it when it is listed anyway", () => {
    const file = ".sandcastle/lib/new.mts";
    const glob = ".sandcastle/lib/*.mts";
    const entry = EXEMPT_GLOBS_AUDITED[glob]!;
    const present = [...filesUnder(owned), file];
    const withoutFile = { ...EXEMPT_GLOBS_AUDITED, [glob]: entry };
    const reviewedWithFile = new Set([...REVIEWED_ON_REAPPLY, file]);

    assert.deepEqual(filesDrift(present, withoutFile, reviewedWithFile), []);
    assert.deepEqual(filesDrift(present, withoutFile, REVIEWED_ON_REAPPLY), [glob]);
    assert.deepEqual(filesDrift(present, { ...withoutFile, [glob]: { ...entry, files: [...entry.files!, file] } }, reviewedWithFile), [glob]);
  });

  it("matches paths the way checkReview does: patternFor agrees with underOwnedPattern", () => {
    const paths = [...filesUnder(owned), ".sandcastle/lib/new.mts", ".sandcastle/lib/sub/new.mts", ".github/hooks/tests/x.sh", "scripts/tests/a/b.sh", "src/Program.cs", ".github/workflows/a/b.yml"];
    for (const file of paths) assert.equal(OWNED_PATHS.some((pattern) => patternFor(pattern)(file)), underOwnedPattern(file), file);
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
      ".github/hooks/**": ".github/hooks/post-merge",
      ".github/scripts/**": ".github/scripts/new.py",
      ".claude/skills/hardening-review/**": ".claude/skills/hardening-review/scripts/new.py",
      "scripts/tests/**": "scripts/tests/new.test.sh",
    };
    assert.deepEqual(Object.keys(fabricated).sort(), Object.keys(EXEMPT_GLOBS_AUDITED).sort(), "a new exempt glob needs a fabricated file here");
    for (const [glob, file] of Object.entries(fabricated)) {
      assert.ok(patternFor(glob)(file), `${file} is under ${glob}`);
      assert.deepEqual(unclassifiedUnderGlobs([...present, file], EXEMPT_GLOBS_AUDITED, REVIEWED_ON_REAPPLY), [`${file} (under ${glob})`]);
    }
  });

  it("accepts a file REVIEWED_ON_REAPPLY names even when it sits under an exempt glob", () => {
    const file = ".github/scripts/policy.json";

    assert.deepEqual(unclassifiedUnderGlobs([file], EXEMPT_GLOBS_AUDITED, new Set()), [`${file} (under .github/scripts/**)`]);
    assert.deepEqual(unclassifiedUnderGlobs([file], EXEMPT_GLOBS_AUDITED, new Set([file])), []);
  });
});
