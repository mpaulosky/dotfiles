import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hostGitEnv, mainGitDir, protectedGitMounts, withoutGitHooks, worktreeLinkProblems, worktreePathFor } from "./host-safety.mts";

describe("withoutGitHooks", () => {
  it("forces core.hooksPath to /dev/null through the environment", () => {
    const env = withoutGitHooks({ PATH: "/bin" });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
    assert.equal(env.GIT_CONFIG_VALUE_0, "/dev/null");
  });

  it("appends to GIT_CONFIG_* entries already set", () => {
    const env = withoutGitHooks({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "color.ui", GIT_CONFIG_VALUE_0: "never" });
    assert.equal(env.GIT_CONFIG_COUNT, "2");
    assert.equal(env.GIT_CONFIG_KEY_0, "color.ui");
    assert.equal(env.GIT_CONFIG_KEY_1, "core.hooksPath");
    assert.equal(env.GIT_CONFIG_VALUE_1, "/dev/null");
  });

  it("keeps a branch's hooks from running, though the repository's config points at them", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-hooks-")));
    try {
      const git = (env: NodeJS.ProcessEnv, ...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, env, stdio: "ignore" });
      git(process.env, "init", "--quiet");
      git(process.env, "config", "core.hooksPath", ".github/hooks");
      mkdirSync(join(repo, ".github/hooks"), { recursive: true });
      const ran = join(repo, "hook-ran");
      writeFileSync(join(repo, ".github/hooks/pre-commit"), `#!/bin/sh\ntouch "${ran}"\n`);
      chmodSync(join(repo, ".github/hooks/pre-commit"), 0o755);

      git(withoutGitHooks(process.env), "commit", "--quiet", "--allow-empty", "-m", "guarded");
      assert.equal(existsSync(ran), false, "the hook ran despite withoutGitHooks");

      // The control: without the override, git does run it.
      git(process.env, "commit", "--quiet", "--allow-empty", "-m", "unguarded");
      assert.equal(existsSync(ran), true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("protectedGitMounts", () => {
  it("mounts .git/config and .git/hooks read-only at their own paths", () => {
    assert.deepEqual(protectedGitMounts("/repo/.git", () => true), [
      { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true },
      { hostPath: "/repo/.git/hooks", sandboxPath: "/repo/.git/hooks", readonly: true },
    ]);
  });

  it("leaves out a path that doesn't exist", () => {
    assert.deepEqual(
      protectedGitMounts("/repo/.git", (path) => path.endsWith("config")).map((mount) => mount.hostPath),
      ["/repo/.git/config"],
    );
  });
});

describe("worktreeLinkProblems", () => {
  const setup = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-link-")));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "ignore" });
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
    const worktree = join(repo, ".sandcastle", "worktrees", "feature-1-x");
    git(repo, "worktree", "add", "--quiet", "-b", "feature/1-x", worktree);
    return { root, repo, worktree, commonDir: join(repo, ".git") };
  };

  it("finds nothing wrong with a worktree git made", () => {
    const { root, worktree, commonDir } = setup();
    try {
      assert.deepEqual(worktreeLinkProblems(worktree, commonDir), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("catches a .git file pointed at a directory of the agent's making", () => {
    const { root, worktree, commonDir } = setup();
    try {
      mkdirSync(join(worktree, "evil"));
      writeFileSync(join(worktree, ".git"), `gitdir: ${join(worktree, "evil")}\n`);
      assert.match(worktreeLinkProblems(worktree, commonDir).join(), /doesn't point into/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("catches a commondir that leads somewhere else", () => {
    const { root, worktree, commonDir } = setup();
    try {
      writeFileSync(join(commonDir, "worktrees", "feature-1-x", "commondir"), `${join(root, "evil")}\n`);
      assert.match(worktreeLinkProblems(worktree, commonDir).join(), /doesn't lead back/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("catches a worktree directory swapped for a symlink", () => {
    const { root, worktree, commonDir } = setup();
    try {
      const admin = join(commonDir, "worktrees", "feature-1-x");
      renameSync(admin, `${admin}-moved`);
      symlinkSync(`${admin}-moved`, admin);
      assert.match(worktreeLinkProblems(worktree, commonDir).join(), /symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hostGitEnv", () => {
  it("keeps git from reading the config of a directory a planted .git/commondir names", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-commondir-")));
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      const git = (env: NodeJS.ProcessEnv, ...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, env, stdio: "ignore" });
      git(process.env, "init", "--quiet");
      git(process.env, "commit", "--quiet", "--allow-empty", "-m", "init");

      // What an agent could plant: a directory sharing the real objects and
      // refs, with a config that runs a command, named by .git/commondir.
      const gitDir = join(repo, ".git");
      const evil = join(gitDir, "evil");
      mkdirSync(evil);
      symlinkSync("../objects", join(evil, "objects"));
      symlinkSync("../refs", join(evil, "refs"));
      writeFileSync(join(evil, "HEAD"), readFileSync(join(gitDir, "HEAD")));
      const ran = join(root, "fsmonitor-ran");
      writeFileSync(join(evil, "config"), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch '${ran}'; false"\n`);
      writeFileSync(join(gitDir, "commondir"), "evil\n");

      git(hostGitEnv(process.env, gitDir), "status");
      assert.equal(existsSync(ran), false, "git ran the planted config's command despite hostGitEnv");

      // The control: without it, git follows commondir and runs the command.
      try {
        git(process.env, "status");
      } catch {
        // The planted fsmonitor fails on purpose; only whether it ran matters.
      }
      assert.equal(existsSync(ran), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mainGitDir", () => {
  it("returns the checkout's .git directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
      assert.equal(mainGitDir(root), join(root, ".git"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a .git directory with a planted commondir", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
      writeFileSync(join(root, ".git", "commondir"), "evil\n");
      assert.throws(() => mainGitDir(root), /commondir exists/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a checkout without a .git directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      assert.throws(() => mainGitDir(root), /isn't a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("worktreePathFor", () => {
  it("puts a branch's worktree where Sandcastle does, with / turned into -", () => {
    assert.equal(worktreePathFor("/repo", "feature/4-add-search"), "/repo/.sandcastle/worktrees/feature-4-add-search");
  });
});
