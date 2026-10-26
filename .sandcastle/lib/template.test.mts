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
  // with the bullet but without roles/ui.md, then with both.
  it("fails config.test.mts's ui prompt check for an opted-in repo without the planner's ui bullet or roles/ui.md, and passes with both", { timeout: 120_000 }, () => {
    const config = join(sandcastle, "lib/repo-config.mts");
    const plan = join(sandcastle, "plan-prompt.md");
    const uiPrompt = join(sandcastle, "roles/ui.md");
    const originals = new Map([config, plan, uiPrompt].map((file) => [file, readFileSync(file, "utf8")]));
    const optedIn = originals.get(config)!.replace(/^\/\/ {3}(ui: .*)$/m, "  $1");
    assert.notEqual(optedIn, originals.get(config), "the Seed's repo-config.mts has no commented ui entry");
    const bullet = "\n- `ui`: the issue adds or changes Blazor components or pages. Leave it out when the issue changes no markup.\n";
    const run = () =>
      spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", ".sandcastle/lib/config.test.mts"], { cwd: scratch, encoding: "utf8", env: childEnv() });
    // The check's own failure line, not just its name, which the reporter prints whether the test passed or not.
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
