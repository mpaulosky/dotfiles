import { execFileSync } from "node:child_process";
import { hostGitEnv, repoGitDir } from "./host-safety.mts";

// Run a command on the host in `cwd` and return trimmed stdout. Throws on failure.
export const sh = (cwd: string, cmd: string, ...args: string[]) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

// The environment and arguments for a host git command in the main checkout at
// `checkout`, whose .git directory is `gitDir`: hooks off, both in the
// environment and with -c, and GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE pinned,
// so no file an agent wrote decides which config git reads (see
// lib/host-safety.mts). Replace refs and grafts are off too: agents can write
// both, and they'd make git log show the host other commits than the ones
// git push sends.
export function hostGitInvocation(
  checkout: string,
  gitDir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; args: string[] } {
  return {
    env: {
      ...hostGitEnv(env, gitDir),
      GIT_DIR: gitDir,
      GIT_WORK_TREE: checkout,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_GRAFT_FILE: "/dev/null/no-grafts",
    },
    args: ["-c", "core.hooksPath=/dev/null", ...args],
  };
}

// Run git with the invocation's arguments and environment in `cwd`, and
// return trimmed stdout. On failure, throws with git's stderr in the message,
// so the caller can say why.
export function runHostGit(cwd: string, invocation: { env: NodeJS.ProcessEnv; args: string[] }): string {
  try {
    return execFileSync("git", invocation.args, {
      cwd,
      env: invocation.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The secret scan reads every patch the push would publish.
      maxBuffer: 512 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(`git ${invocation.args.slice(2).join(" ")} failed${detail ? `:\n${detail}` : ""}`, { cause: error });
  }
}

// Run git on the host, always in the main checkout and never in a worktree,
// and return trimmed stdout. Throws on failure, with git's stderr.
export function git(...args: string[]): string {
  const checkout = process.cwd();
  return runHostGit(checkout, hostGitInvocation(checkout, repoGitDir(), args));
}

// Remove a sandcastle.gatedHead marker an earlier version of Sandcastle left in
// .git/config. The pre-push hook skips the gate for the commit it names, and
// nothing writes or clears it any more: the host now pushes with hooks off.
// git exits non-zero when the key isn't set, which is the usual case.
export function forgetGatedHead(run: (...args: string[]) => string = git): void {
  try {
    run("config", "--local", "--unset-all", "sandcastle.gatedHead");
  } catch {
    // Not set.
  }
}
