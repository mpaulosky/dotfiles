import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { forgetGatedHead, hostGitInvocation, runHostGit } from "./shell.mts";

describe("hostGitInvocation", () => {
  it("turns hooks off with -c and in the environment, and pins the git directories to the main checkout", () => {
    const { args, env } = hostGitInvocation("/repo", "/repo/.git", ["push", "origin", "abc:refs/heads/x"], { PATH: "/bin" });

    assert.deepEqual(args, ["-c", "core.hooksPath=/dev/null", "push", "origin", "abc:refs/heads/x"]);
    assert.equal(env.PATH, "/bin");
    assert.equal(env.GIT_DIR, "/repo/.git");
    assert.equal(env.GIT_COMMON_DIR, "/repo/.git");
    assert.equal(env.GIT_WORK_TREE, "/repo");
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.ok(env.GIT_GRAFT_FILE?.startsWith("/dev/null/"));
    assert.equal(env[`GIT_CONFIG_KEY_${Number(env.GIT_CONFIG_COUNT) - 1}`], "core.hooksPath");
    assert.equal(env[`GIT_CONFIG_VALUE_${Number(env.GIT_CONFIG_COUNT) - 1}`], "/dev/null");
  });

  it("pushes a commit by its id without running the branch's pre-push hook", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-push-")));
    try {
      const repo = join(root, "repo");
      const remote = join(root, "remote.git");
      mkdirSync(repo);
      const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
      run(root, ["init", "--quiet", "--bare", remote]);
      run(repo, ["init", "--quiet"]);
      run(repo, ["remote", "add", "origin", remote]);
      run(repo, ["config", "core.hooksPath", ".github/hooks"]);
      mkdirSync(join(repo, ".github/hooks"), { recursive: true });
      const ran = join(root, "hook-ran");
      writeFileSync(join(repo, ".github/hooks/pre-push"), `#!/bin/sh\ntouch "${ran}"\n`);
      chmodSync(join(repo, ".github/hooks/pre-push"), 0o755);
      run(repo, ["commit", "--quiet", "--allow-empty", "-m", "work"]);
      const commit = run(repo, ["rev-parse", "HEAD"]);

      const { args, env } = hostGitInvocation(repo, join(repo, ".git"), ["push", "--quiet", "origin", `${commit}:refs/heads/fix/1-x`]);
      run(repo, args, env);

      assert.equal(existsSync(ran), false, "the pre-push hook ran on the host");
      assert.equal(run(root, ["--git-dir", remote, "rev-parse", "refs/heads/fix/1-x"]), commit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runHostGit", () => {
  it("puts git's stderr in the error, so a caller can say why it failed", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-stderr-")));
    try {
      assert.throws(
        () => runHostGit(dir, hostGitInvocation(dir, join(dir, ".git"), ["rev-parse", "HEAD"])),
        /git rev-parse HEAD failed:\n.*(not a git repository|fatal)/s,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forgetGatedHead", () => {
  it("unsets the marker an earlier Sandcastle left", () => {
    const calls: string[][] = [];

    forgetGatedHead((...args) => {
      calls.push(args);
      return "";
    });

    assert.deepEqual(calls, [["config", "--local", "--unset-all", "sandcastle.gatedHead"]]);
  });

  it("carries on when there's no marker to unset", () => {
    assert.doesNotThrow(() =>
      forgetGatedHead(() => {
        throw new Error("exit 5");
      }),
    );
  });
});
