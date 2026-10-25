import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
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
