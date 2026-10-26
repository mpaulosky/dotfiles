// A stand-in for a Sandcastle sandbox that runs its commands in a scratch git
// repository, with a home directory of its own. Tests use it where a stubbed
// `exec` can't show what git itself does: a merge with no committer identity
// fails here as it does in the real sandbox.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as sandcastle from "@ai-hero/sandcastle";
import { GATE_COMMAND } from "./repo-config.mts";

export type GitSandboxFake = {
  // Stands in for what makes the sandbox: resolves to the fake sandbox.
  create: (branch: string) => Promise<sandcastle.Sandbox>;
  // Every command run through `sandbox.exec`, in order.
  execs: string[];
  // The commit the branch is at, and the commit `main` is at: main has moved
  // on by a commit that touches no file the branch does, so merging it in is
  // clean.
  head: string;
  main: string;
  // The sandbox user's global git config, as the file holds it.
  globalConfig(): string;
  // The author and committer of the commit at HEAD, as "name <email>".
  headIdentity(): string;
  cleanup(): void;
};

// A sandbox whose home directory holds a global git config that forbids
// guessing an identity (`user.useConfigOnly`), so a commit made before anything
// sets user.name and user.email fails with "Committer identity unknown", as in
// the real sandbox. The repository is on branch "feature" with a gate script,
// one commit behind a "main" that has moved on.
export function gitSandboxFake(): GitSandboxFake {
  const root = mkdtempSync(join(tmpdir(), "git-sandbox-fake-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  const globalConfigPath = join(home, ".gitconfig");
  writeFileSync(globalConfigPath, "[user]\n\tuseConfigOnly = true\n");

  // No identity, config or editor leaks in from the machine running the tests.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const shell = (command: string, cwd: string) =>
    execFileSync("sh", ["-c", command], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const run = (command: string) => shell(command, repo).trim();
  // Setup commits carry an identity of their own, given per command, so the
  // global config stays what a fresh sandbox has.
  const setupCommit = (message: string) =>
    run(`git -c user.name=setup -c user.email=setup@example.com commit -q -m ${JSON.stringify(message)}`);

  run("git init -q -b main");
  // The gate script is a file at the base, as the gate guard needs (lib/checkpoint.mts#gateScriptChange).
  const gate = join(repo, GATE_COMMAND);
  mkdirSync(dirname(gate), { recursive: true });
  writeFileSync(gate, "#!/bin/sh\nexit 0\n");
  chmodSync(gate, 0o755);
  writeFileSync(join(repo, "base.txt"), "base\n");
  run("git add .");
  setupCommit("base");
  run("git checkout -q -b feature");
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  run("git add .");
  setupCommit("feature");
  const head = run("git rev-parse HEAD");
  run("git checkout -q main");
  writeFileSync(join(repo, "main.txt"), "main\n");
  run("git add main.txt");
  setupCommit("main moves on");
  const main = run("git rev-parse HEAD");
  run("git checkout -q feature");

  const execs: string[] = [];
  const sandbox = {
    branch: "feature",
    worktreePath: repo,
    exec: async (command: string, options?: { cwd?: string }) => {
      execs.push(command);
      try {
        return { stdout: shell(command, options?.cwd ?? repo), stderr: "", exitCode: 0 };
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; status?: number | null };
        return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", exitCode: failed.status ?? 1 };
      }
    },
    run: async () => {
      throw new Error("a role ran in the git sandbox fake");
    },
    close: async () => ({}),
  } as unknown as sandcastle.Sandbox;

  return {
    create: async () => sandbox,
    execs,
    head,
    main,
    globalConfig: () => readFileSync(globalConfigPath, "utf8"),
    headIdentity: () => run("git log -1 --format='%an <%ae>|%cn <%ce>'"),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
