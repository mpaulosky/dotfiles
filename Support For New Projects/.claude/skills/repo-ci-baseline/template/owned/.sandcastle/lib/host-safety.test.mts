import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { configIncludeProblem, hostGitEnv, mainGitDir, protectedGitMounts, withoutGitHooks, worktreeConfigProblem, worktreeLinkProblems, worktreePathFor } from "./host-safety.mts";

describe("worktreeConfigProblem", () => {
  const configIn = (setup: (gitDir: string) => void) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-worktree-config-")));
    try {
      execFileSync("git", ["init", "--quiet", join(root, "repo")], { stdio: "ignore" });
      setup(join(root, "repo", ".git"));
      return worktreeConfigProblem(join(root, "repo", ".git"));
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  const setExtension = (value: string) => (gitDir: string) =>
    execFileSync("git", ["config", "--file", join(gitDir, "config"), "extensions.worktreeConfig", value]);

  it("is undefined for a repository that doesn't turn it on", () => {
    assert.equal(configIn(() => {}), undefined);
    assert.equal(configIn(setExtension("false")), undefined);
  });

  it("names the config when extensions.worktreeConfig is on, however it is spelled", () => {
    for (const value of ["true", "yes", "on", "1"]) {
      assert.match(configIn(setExtension(value)) ?? "", /extensions\.worktreeConfig/, value);
    }
  });
});

describe("configIncludeProblem", () => {
  // setup gets the repo's config path and a directory outside the checkout and .git.
  const configIn = (setup: (config: string, outside: string) => void) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-config-include-")));
    try {
      execFileSync("git", ["init", "--quiet", join(root, "repo")], { stdio: "ignore" });
      mkdirSync(join(root, "outside"));
      const gitDir = join(root, "repo", ".git");
      setup(join(gitDir, "config"), join(root, "outside"));
      return configIncludeProblem(gitDir);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  const set = (key: string, value: string) => (config: string) => execFileSync("git", ["config", "--file", config, key, value]);

  it("is undefined for a repository whose config includes nothing", () => {
    assert.equal(configIn(() => {}), undefined);
  });

  it("names the include, whether relative, includeIf, or spelled in another case", () => {
    for (const [key, value] of [
      ["include.path", "local.inc"],
      ["includeIf.gitdir:/work/.path", "~/work.inc"],
      ["INCLUDE.PATH", "local.inc"],
    ] as const) {
      assert.match(configIn(set(key, value)) ?? "", /includes .*\.inc/, key);
    }
  });

  it("allows an absolute path outside .git and the checkout, as actions/checkout writes", () => {
    assert.equal(
      configIn((config, outside) => set("includeIf.gitdir:/work/repo/.git.path", join(outside, "git-credentials.config"))(config)),
      undefined,
    );
  });

  it("names an absolute path inside .git or the checkout", () => {
    assert.match(configIn((config) => set("include.path", join(config, "..", "local.inc"))(config)) ?? "", /includes .*local\.inc/);
    assert.match(configIn((config) => set("include.path", join(config, "..", "..", "local.inc"))(config)) ?? "", /includes .*local\.inc/);
  });

  it("names a path outside whose symlink leads inside", () => {
    const problem = configIn((config, outside) => {
      symlinkSync(join(config, ".."), join(outside, "link"));
      set("include.path", join(outside, "link", "local.inc"))(config);
    });
    assert.match(problem ?? "", /includes .*local\.inc/);
  });
});

describe("protectHostGit", () => {
  // Runs in a child process: repoGitDir() caches process.cwd() and protectHostGit() changes process.env.
  const protectIn = (setup: (gitDir: string) => void) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-protect-")));
    try {
      execFileSync("git", ["init", "--quiet", join(root, "repo")], { stdio: "ignore" });
      setup(join(root, "repo", ".git"));
      const module = pathToFileURL(join(import.meta.dirname, "host-safety.mts")).href;
      return spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", `import(${JSON.stringify(module)}).then((m) => m.protectHostGit())`], {
        cwd: join(root, "repo"),
        encoding: "utf8",
      });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };

  it("refuses a repository that has extensions.worktreeConfig on", () => {
    const result = protectIn((gitDir) => execFileSync("git", ["config", "--file", join(gitDir, "config"), "extensions.worktreeConfig", "true"]));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /extensions\.worktreeConfig/);
  });

  it("refuses a repository whose config includes another file", () => {
    const result = protectIn((gitDir) => execFileSync("git", ["config", "--file", join(gitDir, "config"), "include.path", "local.inc"]));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /includes local\.inc/);
  });

  it("succeeds in a repository that doesn't", () => {
    const result = protectIn(() => {});
    assert.equal(result.status, 0, result.stderr);
  });
});

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
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("protectedGitMounts", () => {
  it("mounts .git/config and .git/hooks read-only at their own paths", () => {
    assert.deepEqual(protectedGitMounts("/repo/.git", () => true, "/empty", () => {}).slice(0, 2), [
      { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true },
      { hostPath: "/repo/.git/hooks", sandboxPath: "/repo/.git/hooks", readonly: true },
    ]);
  });

  it("leaves out a path that doesn't exist", () => {
    assert.deepEqual(
      protectedGitMounts("/repo/.git", (path) => path.endsWith("config"), "/empty", () => {}).map((mount) => mount.hostPath),
      ["/repo/.git/config", "/empty"],
    );
  });

  it("covers the local review's ledgers with an empty read-only folder, whether or not they exist yet, so no agent reads an accepted security finding", () => {
    for (const exists of [() => true, () => false]) {
      assert.deepEqual(
        protectedGitMounts("/repo/.git", exists, "/empty", () => {}).find((mount) => mount.sandboxPath === "/repo/.git/review"),
        { hostPath: "/empty", sandboxPath: "/repo/.git/review", readonly: true },
      );
    }
  });

  it("makes the ledgers' folder on the host first, so Docker doesn't make it as root through the .git mount", () => {
    const made: string[] = [];

    protectedGitMounts("/repo/.git", () => false, "/empty", (path) => made.push(path));

    assert.deepEqual(made, ["/repo/.git/review"]);
  });

  it("makes the ledgers' folder itself when asked to again, as it is for every sandbox of a run", () => {
    const gitDir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      protectedGitMounts(gitDir, existsSync, "/empty");
      protectedGitMounts(gitDir, existsSync, "/empty");

      assert.equal(existsSync(join(gitDir, "review")), true);
    } finally {
      rmSync(gitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("stops when the ledgers' folder is a symlink, which would send the cover somewhere else", () => {
    const gitDir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      mkdirSync(join(gitDir, "elsewhere"));
      symlinkSync(join(gitDir, "elsewhere"), join(gitDir, "review"));

      assert.throws(() => protectedGitMounts(gitDir, existsSync, "/empty"), (error: Error) => error.message.startsWith(`${join(gitDir, "review")} isn't a real folder`));
    } finally {
      rmSync(gitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  for (const [kind, plant] of [
    ["a symlink to nothing", (path: string) => symlinkSync(join(path, "..", "gone"), path)],
    ["a file", (path: string) => writeFileSync(path, "")],
  ] as const) {
    it(`stops, saying what to look at, when the ledgers' folder is ${kind}`, () => {
      const gitDir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
      try {
        plant(join(gitDir, "review"));

        assert.throws(() => protectedGitMounts(gitDir, existsSync, "/empty"), (error: Error) => error.message.startsWith(`${join(gitDir, "review")} isn't a real folder`));
      } finally {
        rmSync(gitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }

  it("makes the ledgers' folder readable only by its owner, and narrows one that isn't", () => {
    const gitDir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      protectedGitMounts(gitDir, existsSync, "/empty");
      assert.equal(statSync(join(gitDir, "review")).mode & 0o777, 0o700);

      chmodSync(join(gitDir, "review"), 0o755);
      protectedGitMounts(gitDir, existsSync, "/empty");

      assert.equal(statSync(join(gitDir, "review")).mode & 0o777, 0o700);
    } finally {
      rmSync(gitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("covers them with a folder that is empty", () => {
    const review = protectedGitMounts("/repo/.git", () => false, undefined, () => {}).find((mount) => mount.sandboxPath === "/repo/.git/review");

    assert.ok(review !== undefined);
    assert.deepEqual(readdirSync(review.hostPath), []);
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
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("catches a .git file pointed at a directory of the agent's making", () => {
    const { root, worktree, commonDir } = setup();
    try {
      mkdirSync(join(worktree, "evil"));
      writeFileSync(join(worktree, ".git"), `gitdir: ${join(worktree, "evil")}\n`);
      assert.match(worktreeLinkProblems(worktree, commonDir).join(), /doesn't point into/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("catches a commondir that leads somewhere else", () => {
    const { root, worktree, commonDir } = setup();
    try {
      writeFileSync(join(commonDir, "worktrees", "feature-1-x", "commondir"), `${join(root, "evil")}\n`);
      assert.match(worktreeLinkProblems(worktree, commonDir).join(), /doesn't lead back/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refuses a .git directory with a planted commondir", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
      writeFileSync(join(root, ".git", "commondir"), "evil\n");
      assert.throws(() => mainGitDir(root), /commondir exists/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refuses a checkout without a .git directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gitdir-")));
    try {
      assert.throws(() => mainGitDir(root), /isn't a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("worktreePathFor", () => {
  it("puts a branch's worktree where Sandcastle does, with / turned into -", () => {
    assert.equal(worktreePathFor("/repo", "feature/4-add-search"), "/repo/.sandcastle/worktrees/feature-4-add-search");
  });
});
