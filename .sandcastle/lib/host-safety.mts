// Keeping what agents write from running on the host.
//
// Agents can write two things the host later touches: the issue branch's files
// (its worktree), and the repository's shared .git directory, which Sandcastle
// mounts read-write into every sandbox so agents can commit. Git runs code from
// both: hooks from core.hooksPath (.github/hooks, which resolves inside the
// worktree a command runs in, so the branch's own pre-push hook, scripts/gate.sh
// and test code), and commands named in .git/config (core.fsmonitor, credential
// helpers, core.sshCommand, aliases and more).
//
// Git also finds the config it reads through files agents can write: a
// commondir file, in .git itself or in a worktree's directory under
// .git/worktrees, and a worktree's .git file. Pointed at a directory of the
// agent's making, they'd make git read a config the agent wrote.
//
// So, from protectHostGit() on:
// - the host never runs a git hook (withoutGitHooks);
// - every host git command, Sandcastle's included, takes its config, refs and
//   objects from this repository's .git, whatever a commondir file says
//   (GIT_COMMON_DIR, set by hostGitEnv). The host's own git commands also pin
//   GIT_DIR (see git in lib/shell.mts);
// - the sandbox can't change .git/config or .git/hooks, or read the local
//   review's ledgers in .git/review, at any path a mount puts .git
//   (protectedGitMounts, and withCreateMounts in lib/skills.mts);
// - the host runs its own git and gh in the main checkout, never in a worktree
//   (lib/build.mts and lib/branches.mts);
// - Sandcastle runs git in a worktree when it reuses one and when it closes
//   one, so the host first checks the worktree still points at this repository
//   (worktreeLinkProblems), and leaves one that doesn't for a person.
//
// What's left: a worktree's own files (HEAD, index) can still be redirected,
// which changes what git sees there but runs nothing. extensions.worktreeConfig
// would make git read a config.worktree from there, which agents can write, and
// so would an include.path or includeIf.*.path in .git/config that leads to a
// file they can write, so protectHostGit() refuses a repository that has either
// (worktreeConfigProblem, configIncludeProblem).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// A bind mount into the sandbox, in the shape Sandcastle's docker() takes.
export type ReadOnlyMount = { hostPath: string; sandboxPath: string; readonly: true };

// The environment with core.hooksPath forced to /dev/null for every git command
// started from it, Sandcastle's own included, appended to any GIT_CONFIG_*
// entries already there. Environment config outranks the repository's, so
// neither a branch's .github/hooks nor a changed .git/config can turn hooks on.
export function withoutGitHooks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  const index = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${index}`]: "/dev/null",
  };
}

// The environment every host git command runs in: hooks off, and the shared
// .git directory pinned to `commonDir`. GIT_COMMON_DIR outranks any commondir
// file, so a planted one can't point git at a config an agent wrote. GIT_DIR
// isn't set here: Sandcastle also runs git in worktrees, which each have their
// own git directory.
export function hostGitEnv(env: NodeJS.ProcessEnv, commonDir: string): NodeJS.ProcessEnv {
  return { ...withoutGitHooks(env), GIT_COMMON_DIR: commonDir };
}

// The main checkout's .git directory, which is this repository's shared one.
// Found on disk rather than by asking git, since git would follow a planted
// commondir. Throws when it isn't a real directory, or has a commondir file:
// a main checkout never has one, so an agent planted it.
export function mainGitDir(checkout: string): string {
  const gitDir = resolve(checkout, ".git");
  const stat = lstatSync(gitDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new Error(`${gitDir} isn't a directory. Run Sandcastle from the root of the main checkout.`);
  }
  if (existsSync(join(gitDir, "commondir"))) {
    throw new Error(`${gitDir}/commondir exists, so git would read another directory's config. Inspect it and remove it.`);
  }
  return gitDir;
}

let commonDir: string | undefined;

// This repository's shared .git directory, read once.
export function repoGitDir(): string {
  commonDir ??= mainGitDir(process.cwd());
  return commonDir;
}

// Why this repository can't be protected, or undefined when nothing is wrong:
// with extensions.worktreeConfig on, git also reads .git/config.worktree and
// each linked worktree's config.worktree, which agents can write and which can
// name a command (core.fsmonitor) for the host's next git command to run.
// .git/config is mounted read-only (protectedGitMounts), but those files aren't.
export function worktreeConfigProblem(gitDir: string): string | undefined {
  const enabled = execFileSync("git", ["config", "--file", join(gitDir, "config"), "--type=bool", "--default", "false", "extensions.worktreeConfig"], {
    encoding: "utf8",
  }).trim();
  return enabled === "true"
    ? `${join(gitDir, "config")} sets extensions.worktreeConfig, so git would read config.worktree files that agents can write. ` +
        "Move what's in them into the shared config and run `git config --unset extensions.worktreeConfig`."
    : undefined;
}

// A path with its symlinks followed, as far as it exists.
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return join(realPath(dirname(path)), basename(path));
  }
}

// Whether `path` is `dir` or lies under it.
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Why this repository can't be protected, or undefined when nothing is wrong:
// git follows include.path and includeIf.*.path in .git/config, resolving a
// relative path against .git, which agents can write outside config and hooks.
// A file reached that way can name a command (core.fsmonitor) just as a
// config.worktree can. So an include is refused unless its path is absolute and
// lies outside both .git and the checkout, which is everywhere agents write:
// actions/checkout includes its credentials file from $RUNNER_TEMP that way.
// A `~/` path is refused since where it leads depends on who runs git.
export function configIncludeProblem(gitDir: string): string | undefined {
  const config = join(gitDir, "config");
  let output: string;
  try {
    output = execFileSync("git", ["config", "--file", config, "--get-regexp", "-z", "^include(if\\..*)?\\.path$"], { encoding: "utf8" });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined; // git exits 1 when nothing matches
    throw error;
  }
  const writable = [realPath(gitDir), realPath(dirname(gitDir))];
  const risky = output
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(entry.indexOf("\n") + 1))
    .filter((path) => !isAbsolute(path) || writable.some((dir) => isWithin(realPath(path), dir)));
  return risky.length === 0
    ? undefined
    : `${config} includes ${risky.join(", ")}, and git would read it, but agents can write there or it isn't a fixed absolute path. ` +
        "Move what's in it into the config and remove the include.";
}

// Protect this process and everything it starts (see hostGitEnv). Call before
// the first git command and before any agent runs.
export function protectHostGit(): void {
  const problem = worktreeConfigProblem(repoGitDir()) ?? configIncludeProblem(repoGitDir());
  if (problem) throw new Error(problem);
  Object.assign(process.env, hostGitEnv(process.env, repoGitDir()));
}

let emptyDir: string | undefined;

// An empty folder to mount over what agents mustn't read, made once.
function emptyFolder(): string {
  emptyDir ??= mkdtempSync(join(tmpdir(), "sandcastle-empty-"));
  return emptyDir;
}

// Read-only mounts over the parts of the shared .git directory that make git
// run commands, laid over Sandcastle's read-write mount of the directory at the
// same path. Agents only need the objects, refs and index to commit. A path
// that doesn't exist is left out: Docker can't mount it.
//
// The local review's ledgers (.git/review, scripts/review.sh) hold accepted
// security findings, which are never published, while agents read untrusted
// text and the host publishes what they write. So an empty read-only folder
// covers them, whether or not they exist yet: a ledger recorded during the run
// lands in the hidden folder too. The host makes the folder first, or Docker
// would make it through the .git mount, perhaps as root.
export function protectedGitMounts(
  gitDir: string,
  exists: (path: string) => boolean = existsSync,
  empty: string = emptyFolder(),
  makeDir: (path: string) => void = (path) => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  },
): ReadOnlyMount[] {
  const review = join(gitDir, "review");
  // A symlink there would take Docker's cover to its target, leaving the
  // ledgers open at their own path; checked before makeDir, whose own errors
  // wouldn't say what to look at.
  const found = lstatSync(review, { throwIfNoEntry: false });
  if (found !== undefined && !found.isDirectory()) {
    throw new Error(`${review} isn't a real folder, so the ledgers can't be hidden from the sandbox. Inspect it and remove it.`);
  }
  makeDir(review);
  const commands: ReadOnlyMount[] = ["config", "hooks"]
    .map((name) => join(gitDir, name))
    .filter((path) => exists(path))
    .map((path) => ({ hostPath: path, sandboxPath: path, readonly: true }));
  return [...commands, { hostPath: empty, sandboxPath: join(gitDir, "review"), readonly: true }];
}

// Where Sandcastle 0.12 puts a branch's worktree (its worktree mode's create()).
export function worktreePathFor(checkout: string, branch: string): string {
  return join(checkout, ".sandcastle", "worktrees", branch.replaceAll("/", "-"));
}

// What's wrong with how the worktree at `worktreePath` finds its repository,
// whose shared .git directory is `gitDir`; empty when nothing is. Its .git must
// be a file naming its directory under <gitDir>/worktrees, that directory must
// be a real one whose commondir leads back to `gitDir`, and none of them may be
// a symlink.
export function worktreeLinkProblems(worktreePath: string, gitDir: string): string[] {
  const kind = (path: string) => {
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    } catch {
      return "missing";
    }
  };
  const expectKind = (path: string, wanted: string) => {
    const found = kind(path);
    return found === wanted ? [] : [`${path} is ${found === "missing" ? "missing" : `a ${found}`}, not a ${wanted}`];
  };

  const gitFile = join(worktreePath, ".git");
  const problems = [...expectKind(worktreePath, "directory"), ...expectKind(gitFile, "file")];
  if (problems.length > 0) return problems;

  const gitdir = /^gitdir: (.+)$/.exec(readFileSync(gitFile, "utf8").trim())?.[1];
  const worktreesDir = join(gitDir, "worktrees");
  const adminDir = gitdir === undefined ? undefined : resolve(worktreePath, gitdir);
  if (adminDir === undefined || adminDir !== join(worktreesDir, basename(adminDir))) {
    return [`${gitFile} doesn't point into ${worktreesDir}`];
  }
  const commondirFile = join(adminDir, "commondir");
  problems.push(...expectKind(worktreesDir, "directory"), ...expectKind(adminDir, "directory"), ...expectKind(commondirFile, "file"));
  if (problems.length > 0) return problems;

  if (resolve(adminDir, readFileSync(commondirFile, "utf8").trim()) !== resolve(gitDir)) {
    problems.push(`${commondirFile} doesn't lead back to ${gitDir}`);
  }
  return problems;
}
