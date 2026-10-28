import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { TEMPLATE_OWNED_DIR } from "./repo-config.mts";

// The Template's .sandcastle/ as Apply writes it into a repo that isn't dotfiles: the Owned files, plus each Seed file Owned lacks.
// The Owned modules must type-check and pass their own tests there, with the Seed's lib/repo-config.mts, so an Owned module that reads a
// dotfiles-only value fails here and not in an older repo's migration. This file is dotfiles', not the Template's.

const root = fileURLToPath(new URL("../../", import.meta.url));
const skill = join(root, TEMPLATE_OWNED_DIR.replace("/template/owned", ""));
const owned = join(skill, "template/owned");
const seed = join(skill, "template/seed");

const filesUnder = (folder: string): string[] =>
  (readdirSync(folder, { recursive: true }) as string[]).filter((entry) => statSync(join(folder, entry)).isFile()).map((entry) => entry.split("\\").join("/"));

describe("the Template's .sandcastle/ in a repo that isn't dotfiles", () => {
  let scratch = "";
  let sandcastle = "";

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "template-sandcastle-"));
    sandcastle = join(scratch, ".sandcastle");
    cpSync(join(owned, ".sandcastle"), sandcastle, { recursive: true, preserveTimestamps: true });
    for (const file of filesUnder(join(seed, ".sandcastle"))) {
      if (existsSync(join(sandcastle, file))) continue;
      mkdirSync(join(sandcastle, file, ".."), { recursive: true });
      cpSync(join(seed, ".sandcastle", file), join(sandcastle, file));
    }
    // lib/branches.test.mts runs scripts/check-branch-name.sh, an Owned file outside .sandcastle/.
    mkdirSync(join(scratch, "scripts"));
    const script = join(scratch, "scripts/check-branch-name.sh");
    cpSync(join(owned, "scripts/check-branch-name.sh"), script);
    chmodSync(script, statSync(join(owned, "scripts/check-branch-name.sh")).mode);
    // lib/pre-push-review-skill.test.mts reads the skill and its agent from .claude/.
    cpSync(join(owned, ".claude"), join(scratch, ".claude"), { recursive: true });
    // lib/pre-push-review-skill.test.mts checks the workflow's accepted-findings step against the ledger's markers.
    mkdirSync(join(scratch, ".github/workflows"), { recursive: true });
    cpSync(join(owned, ".github/workflows/claude-review.yml"), join(scratch, ".github/workflows/claude-review.yml"));
    // lib/review-ledger.test.mts runs scripts/review.sh the same way.
    const review = join(scratch, "scripts/review.sh");
    cpSync(join(owned, "scripts/review.sh"), review);
    chmodSync(review, statSync(join(owned, "scripts/review.sh")).mode);
    // lib/config.test.mts runs scripts/watch-pr.sh --would-skip on every Sandcastle marker.
    const watcher = join(scratch, "scripts/watch-pr.sh");
    cpSync(join(owned, "scripts/watch-pr.sh"), watcher);
    chmodSync(watcher, statSync(join(owned, "scripts/watch-pr.sh")).mode);
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  // A nested test runner reports into the parent's when it finds this variable.
  const childEnv = () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return env;
  };

  it("type-checks with the Seed's repo-config.mts", { timeout: 120_000 }, () => {
    const result = spawnSync(join(root, "node_modules/.bin/tsc"), ["--noEmit", "-p", sandcastle], { cwd: scratch, encoding: "utf8", env: childEnv() });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  // The Seed's commented `ui` line is what a repo opting into the UI developer uncomments, so it must be a valid entry
  // under the Seed's own `satisfies` clause, next to the Owned modules that read it.
  it("type-checks with the Seed's ui entry uncommented", { timeout: 120_000 }, () => {
    const config = join(sandcastle, "lib/repo-config.mts");
    const original = readFileSync(config, "utf8");
    const optedIn = original.replace(/^\/\/ {3}(ui: .*)$/m, "  $1");
    assert.notEqual(optedIn, original, "the Seed's repo-config.mts has no commented ui entry");

    writeFileSync(config, optedIn);
    try {
      const result = spawnSync(join(root, "node_modules/.bin/tsc"), ["--noEmit", "-p", sandcastle], { cwd: scratch, encoding: "utf8", env: childEnv() });

      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      writeFileSync(config, original);
    }
  });

  // config.test.mts skips its check of the ui prompts in a repo that hasn't opted in, which is every config this repo runs it under, so
  // here it runs where it can fail: a scratch repo with the Seed's ui entry uncommented, first without the planner's ui bullet, then
  // with the bullet but without roles/ui.md, then with both, then with backend.md lacking {{UI_DEVELOPER}}.
  it("fails config.test.mts's ui prompt check for an opted-in repo without the planner's ui bullet, roles/ui.md or backend.md's {{UI_DEVELOPER}}, and passes with all three", { timeout: 120_000 }, () => {
    const config = join(sandcastle, "lib/repo-config.mts");
    const plan = join(sandcastle, "plan-prompt.md");
    const uiPrompt = join(sandcastle, "roles/ui.md");
    const backend = join(sandcastle, "roles/backend.md");
    const originals = new Map([config, plan, uiPrompt, backend].map((file) => [file, readFileSync(file, "utf8")]));
    const optedIn = originals.get(config)!.replace(/^\/\/ {3}(ui: .*)$/m, "  $1");
    assert.notEqual(optedIn, originals.get(config), "the Seed's repo-config.mts has no commented ui entry");
    const bullet = "\n- `ui`: the issue adds or changes Blazor components or pages. Leave it out when the issue changes no markup.\n";
    const run = () =>
      spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", "--test-reporter=spec", ".sandcastle/lib/config.test.mts"], { cwd: scratch, encoding: "utf8", env: childEnv() });
    // The check's own failure line, not just its name, which the reporter prints whether the test passed or not. The spec reporter is
    // pinned: Node 22 prints TAP instead when stdout is a pipe.
    const failedCheck = /✖[^\n]*has the prompts the ui role needs/;

    try {
      writeFileSync(config, optedIn);

      const withoutBullet = run();
      assert.notEqual(withoutBullet.status, 0, "the check should fail without the planner's ui bullet");
      assert.match(withoutBullet.stdout, failedCheck);
      assert.match(withoutBullet.stdout, /plan-prompt|\^- `ui`/);

      writeFileSync(plan, `${originals.get(plan)}${bullet}`);
      rmSync(uiPrompt);
      const withoutPrompt = run();
      assert.notEqual(withoutPrompt.status, 0, "the check should fail without roles/ui.md");
      assert.match(withoutPrompt.stdout, failedCheck);
      assert.match(withoutPrompt.stdout, /roles\/ui\.md is missing/);

      writeFileSync(uiPrompt, originals.get(uiPrompt)!);
      const complete = run();
      assert.equal(complete.status, 0, `${complete.stdout}${complete.stderr}`);
      assert.match(complete.stdout, /skipped 0/, "the check should run, not be skipped");

      writeFileSync(backend, originals.get(backend)!.replace("{{UI_DEVELOPER}}", ""));
      const withoutPlaceholder = run();
      assert.notEqual(withoutPlaceholder.status, 0, "the check should fail when backend.md drops {{UI_DEVELOPER}}");
      assert.match(withoutPlaceholder.stdout, failedCheck);
      assert.match(withoutPlaceholder.stdout, /UI_DEVELOPER/);
    } finally {
      for (const [file, text] of originals) writeFileSync(file, text);
    }
  });

  // skills.test.mts checks the role prompts against SANDBOX_SKILLS, which is empty under the Seed's values and so passes without
  // checking anything. Here a skill is mounted, to show it fails when a prompt lacks it or lists one that isn't mounted.
  it("fails skills.test.mts when a role prompt and SANDBOX_SKILLS disagree, and passes when they agree", { timeout: 120_000 }, () => {
    const config = join(sandcastle, "lib/repo-config.mts");
    const tester = join(sandcastle, "roles/tester.md");
    const backend = join(sandcastle, "roles/backend.md");
    const uiPrompt = join(sandcastle, "roles/ui.md");
    const originals = new Map([config, tester, backend, uiPrompt].map((file) => [file, readFileSync(file, "utf8")]));
    const mounted = originals.get(config)!.replace(/^(export const SANDBOX_SKILLS: readonly string\[\] = )\[\];$/m, '$1["dotnet-tdd"];');
    assert.notEqual(mounted, originals.get(config), "the Seed's repo-config.mts has no empty SANDBOX_SKILLS");
    // The ui prompt is checked only in a repo that opted into the role.
    const optedIn = mounted.replace(/^\/\/ {3}(ui: .*)$/m, "  $1");
    assert.notEqual(optedIn, mounted, "the Seed's repo-config.mts has no commented ui entry");
    const section = (...names: string[]) => `\n# SKILLS\n\n${names.map((name) => `- \`${name}\`: x\n`).join("")}`;
    const run = () =>
      spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", "--test-reporter=spec", ".sandcastle/lib/skills.test.mts"], {
        cwd: scratch,
        encoding: "utf8",
        env: childEnv(),
      });

    try {
      writeFileSync(config, optedIn);

      const unlisted = run();
      assert.notEqual(unlisted.status, 0, "the check should fail when the prompts omit a mounted skill");
      assert.match(unlisted.stdout, /✖[^\n]*lists every mounted skill in the tester prompt/);

      for (const file of [tester, backend]) writeFileSync(file, `${originals.get(file)}${section("dotnet-tdd")}`);
      const uiUnlisted = run();
      assert.notEqual(uiUnlisted.status, 0, "the check should fail when the ui prompt omits a mounted skill");
      assert.match(uiUnlisted.stdout, /✖[^\n]*lists every mounted skill in the ui prompt/);

      writeFileSync(uiPrompt, `${originals.get(uiPrompt)}${section("dotnet-tdd")}`);
      const agreeing = run();
      assert.equal(agreeing.status, 0, `${agreeing.stdout}${agreeing.stderr}`);
      assert.match(agreeing.stdout, /skipped 0/, "the ui prompt's check should run, not be skipped");

      writeFileSync(tester, `${originals.get(tester)}${section("dotnet-tdd", "dotnet-nope")}`);
      const unmounted = run();
      assert.notEqual(unmounted.status, 0, "the check should fail when a prompt lists a skill that isn't mounted");
      assert.match(unmounted.stdout, /✖[^\n]*lists no skill that SANDBOX_SKILLS doesn't mount/);
    } finally {
      for (const [file, text] of originals) writeFileSync(file, text);
    }
  });

  it("passes its Owned tests with the Seed's values", { timeout: 120_000 }, () => {
    const tests = filesUnder(sandcastle)
      .filter((file) => file.endsWith(".test.mts"))
      .map((file) => relative(scratch, join(sandcastle, file)));

    assert.ok(tests.length > 0, "the Template's .sandcastle/ holds no tests");
    const result = spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", ...tests], { cwd: scratch, encoding: "utf8", env: childEnv() });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  it("has no file that is both Owned and Seed", () => {
    const seeded = new Set(filesUnder(join(seed, ".sandcastle")));
    const both = filesUnder(join(owned, ".sandcastle")).filter((file) => seeded.has(file));

    assert.deepEqual(both, []);
  });
});

// A test removes its scratch git repository while git may still be writing into it (background maintenance after a commit), which fails a
// bare recursive rmSync with ENOTEMPTY and turned a green run red. rmSync retries that error when it is given maxRetries.
describe("the Template's tests remove scratch directories with retries", () => {
  it("passes maxRetries to every recursive rmSync in the Owned lib/ modules", () => {
    const lib = join(owned, ".sandcastle/lib");
    const bare: string[] = [];
    let found = 0;
    for (const file of filesUnder(lib).filter((entry) => entry.endsWith(".mts"))) {
      for (const call of readFileSync(join(lib, file), "utf8").matchAll(/rmSync\([^;]*?recursive: true[^;]*?\)/g)) {
        found += 1;
        if (!call[0].includes("maxRetries")) bare.push(`${file}: ${call[0].replace(/\s+/g, " ")}`);
      }
    }

    assert.ok(found > 0, "no recursive rmSync found in the Owned lib/ modules: the scan checks nothing");
    assert.deepEqual(bare, []);
  });
});

// `pnpm run sandcastle:status` (lib/status.mts, status.mts): the script is in the Seed package.json, which Apply writes only once, so
// a repo that already has one adds it by hand, and the reference says so.
describe("pnpm run sandcastle:status in the Template", () => {
  const packageScripts = (file: string): Record<string, string> => JSON.parse(readFileSync(file, "utf8")).scripts;

  it("is a script of the Seed package.json, right after sandcastle", () => {
    const scripts = packageScripts(join(seed, "package.json"));
    const names = Object.keys(scripts);

    assert.equal(scripts["sandcastle:status"], "tsx .sandcastle/status.mts");
    assert.equal(names.indexOf("sandcastle:status"), names.indexOf("sandcastle") + 1);
  });

  it("leaves dotfiles' package.json scripts the Seed's", () => {
    assert.deepEqual(packageScripts(join(root, "package.json")), packageScripts(join(seed, "package.json")));
  });

  describe("in references/sandcastle.md", () => {
    const reference = readFileSync(join(skill, "references/sandcastle.md"), "utf8");

    it("is described: what it shows and that it is read-only", () => {
      assert.match(reference, /pnpm run sandcastle:status/);
      assert.match(reference, /read-only/i);
      for (const part of [/passes/i, /bot/, /owner/]) assert.match(reference, part);
    });

    it("is in the migration notes, since a Seed package.json already written isn't changed", () => {
      const migrating = reference.slice(reference.indexOf("## Migrating a repo"));

      assert.notEqual(migrating, reference, "the reference has no migration section");
      assert.match(migrating, /sandcastle:status/);
    });
  });
});
