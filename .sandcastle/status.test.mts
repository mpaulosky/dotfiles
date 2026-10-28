import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

// The entry file of `pnpm run sandcastle:status` (see lib/status.mts): run as a program with a stand-in `gh` that records its calls, so what it
// does at startup, which exit code it ends with and what it never touches are checked as they happen.

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = join(here, "status.mts");
const tsx = join(root, "node_modules/.bin/tsx");
const source = readFileSync(entry, "utf8");

describe("status.mts as a program", () => {
  let scratch = "";
  let repo = "";
  let bin = "";
  let calls = "";

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "status-entry-"));
    repo = join(scratch, "repo");
    bin = join(scratch, "bin");
    calls = join(scratch, "gh-calls.log");
    const init = spawnSync("sh", ["-c", `mkdir -p "${repo}" "${bin}" && git init -q "${repo}"`], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    // A gh that records how it was called and always fails, as a gh with no token does.
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${calls}"\necho "boom: gh is not signed in" >&2\nexit 1\n`);
    chmodSync(join(bin, "gh"), 0o755);
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  function status(env: Record<string, string> = {}) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env };
    // A nested test runner reports into the parent's when it finds this variable; the scope variables are the test's to set.
    for (const name of ["NODE_TEST_CONTEXT", "GITHUB_ACTIONS", "SANDCASTLE_ISSUE", "SANDCASTLE_LABEL"]) {
      if (!(name in env)) delete childEnv[name];
    }
    return spawnSync(tsx, [entry], { cwd: repo, encoding: "utf8", env: childEnv, timeout: 60_000 });
  }
  const ghCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);

  it("exits 2 with the scope's message, before any gh call, for a bad SANDCASTLE_ISSUE", { timeout: 90_000 }, () => {
    const result = status({ SANDCASTLE_ISSUE: "abc" });

    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /SANDCASTLE_ISSUE must be an issue number/);
    assert.equal(result.stdout, "");
    assert.deepEqual(ghCalls(), []);
  });

  it("exits 2 for both scope variables set", { timeout: 90_000 }, () => {
    const result = status({ SANDCASTLE_ISSUE: "7", SANDCASTLE_LABEL: "Sandcastle:local" });

    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.deepEqual(ghCalls(), []);
  });

  it("exits 1, with the cause on stderr and nothing on stdout, when the open PRs can't be read, having asked gh for reads only", { timeout: 90_000 }, () => {
    const result = status();

    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /boom: gh is not signed in/);
    assert.equal(result.stdout, "");
    const made = ghCalls();
    assert.ok(made.length > 0, "the status should have asked gh something");
    for (const call of made) {
      assert.doesNotMatch(call, /\b(edit|comment|create|close|merge|delete|ready|review)\b|--method|-X |--add-label|--remove-label/, call);
    }
  });
});

describe("status.mts's source", () => {
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((match) => match[1] as string);

  it("starts no sandbox and no model: it imports neither Sandcastle nor the modules that do", () => {
    for (const from of imports) {
      assert.doesNotMatch(from, /@ai-hero|\/build\.mts|follow-up-pass|\/skills\.mts|\/agents\.mts|\/round\.mts|\/plan\.mts|\/intake\.mts|\/critique\.mts/, from);
    }
  });

  it("takes none of main.mts's startup steps that write", () => {
    for (const step of ["ensureLabels", "cacheHostLogin", "clearStaleBuildingLabels", "installBuildingLabelRelease", "releaseAllBuildingLabels"]) {
      assert.doesNotMatch(source, new RegExp(`\\b${step}\\b`), step);
    }
  });

  it("reads the scope first, then protects host git before the first gh call, then runs the command", () => {
    const scope = source.search(/\bstatusScopeFrom\(/);
    const protect = source.search(/\bprotectHostGit\(\)/);
    const command = source.search(/\bstatusCommand\(/);

    assert.ok(scope >= 0 && protect >= 0 && command >= 0, "status.mts should call statusScopeFrom, protectHostGit and statusCommand");
    assert.ok(scope < protect && protect < command, `order: scope ${scope}, protect ${protect}, command ${command}`);
  });

  it("uses the queue scope, exits 2 on a QueueScopeError and 1 when the PRs can't be read", () => {
    assert.match(source, /\buseQueueScope\(/);
    assert.match(source, /QueueScopeError/);
    assert.match(source, /process\.exit\(2\)/);
    assert.match(source, /process\.exit\(1\)|process\.exitCode = 1/);
  });

  it("opens with a header comment that says how to run it", () => {
    assert.match(source, /^\/\/ .*\n(\/\/.*\n)*\/\/ Usage:/);
    assert.match(source, /pnpm run sandcastle:status/);
  });
});
