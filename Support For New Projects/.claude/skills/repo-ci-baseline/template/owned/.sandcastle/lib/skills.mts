// A skill the roles use from the host user's ~/.claude/skills, rather than
// from the repo, is bind-mounted, read only, into the sandbox user's
// ~/.claude/skills, since the sandbox only sees the worktree. A skill there is usually a
// symlink into a dotfiles checkout, which a mount of the folder wouldn't
// follow, so each skill's real path is mounted on its own.
//
// Every sandbox also gets .git/config and .git/hooks read-only, over
// Sandcastle's read-write mount of the shared .git directory, so no agent can
// plant a command there for the host's git to run, and an empty read-only
// folder over .git/review, so no agent reads the local review's ledgers (see
// lib/host-safety.mts). They go in through the provider's create(), not
// docker({ mounts }): docker() refuses a file mount outside /home/agent, and
// .git/config is one.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { protectedGitMounts, repoGitDir, type ReadOnlyMount } from "./host-safety.mts";
import { SANDBOX_SKILLS } from "./repo-config.mts";

export type SkillMount = ReadOnlyMount;

// Mounts for the named skills found in skillsDir, and the names it lacks.
export function skillMounts(
  skillsDir: string,
  names: readonly string[],
): { mounts: SkillMount[]; missing: string[] } {
  const mounts: SkillMount[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const hostPath = join(skillsDir, name);
    if (!existsSync(join(hostPath, "SKILL.md"))) {
      missing.push(name);
      continue;
    }
    mounts.push({
      hostPath: realpathSync(hostPath),
      sandboxPath: `/home/agent/.claude/skills/${name}`,
      readonly: true,
    });
  }
  return { mounts, missing };
}

// What makeAgentSandbox needs from outside; tests pass stubs.
export type SandboxHost<TProvider> = {
  skillsDir: string;
  // The read-only mounts over the shared .git directory's config, hooks and
  // review folder.
  gitMounts(): ReadOnlyMount[];
  docker(options: { mounts: ReadOnlyMount[]; env: Record<string, string> }): TProvider;
  log(message: string): void;
};

// The create() of a Sandcastle bind-mount provider, which docker() returns.
// SandboxProvider's public type declares neither tag nor create(), so they're
// checked at run time, and a provider without them is refused rather than run
// without the .git mounts.
type MountSpec = { hostPath: string; sandboxPath: string; readonly?: boolean };
type BindMountProvider = { tag: "bind-mount"; create(options: { mounts: MountSpec[] }): Promise<unknown> };

// The provider with `extra` added to the mounts Sandcastle creates each sandbox
// with: the worktree and the shared .git directory, which docker() mounts as
// given. Each extra mount covers a host path, so it's added at that path and
// again wherever another mount puts the same host path in the sandbox: head
// mode (the planner, critique and intake) mounts the main checkout itself at
// the workspace, and its .git with it.
export function withCreateMounts<TProvider>(provider: TProvider, extra: readonly ReadOnlyMount[]): TProvider {
  const inner = provider as Partial<BindMountProvider>;
  if (inner.tag !== "bind-mount" || typeof inner.create !== "function") {
    throw new Error("The sandbox provider has no bind-mount create(), so .git/config, .git/hooks and .git/review can't be mounted read-only.");
  }
  const create = inner.create.bind(provider);
  return {
    ...provider,
    create: <TOptions extends { mounts: MountSpec[] }>(options: TOptions) =>
      create({ ...options, mounts: [...options.mounts, ...extra.flatMap((mount) => [mount, ...aliases(mount, options.mounts)])] }),
  };
}

// `mount` again at each place another mount shows its path in the sandbox.
// Paths are compared normalized, so a trailing slash or a `.` can't hide a
// mount; a relative one is refused, since where it lands can't be known.
function aliases(mount: ReadOnlyMount, mounts: readonly MountSpec[]): ReadOnlyMount[] {
  return mounts.flatMap((other) => {
    if (!posix.isAbsolute(other.hostPath) || !posix.isAbsolute(other.sandboxPath)) {
      throw new Error(`The sandbox mount ${other.hostPath} -> ${other.sandboxPath} is relative, so .git/config, .git/hooks and .git/review can't be covered in it.`);
    }
    const inner = posix.relative(posix.resolve(other.hostPath), posix.resolve(mount.sandboxPath));
    if (inner === ".." || inner.startsWith("../")) return [];
    const sandboxPath = posix.join(posix.resolve(other.sandboxPath), inner);
    return sandboxPath === posix.resolve(mount.sandboxPath) ? [] : [{ ...mount, sandboxPath }];
  });
}

// The environment every sandbox starts with. scripts/gate.sh refuses a diff
// /pre-push-review hasn't passed, and Sandcastle's reviewer doesn't run that
// review yet, so every gate in the sandbox (the host's checkpoints and the
// agents' own) skips the check. Set at `docker run`, not in the image, so a
// local image built before the check existed still gets it.
export const SANDBOX_ENV: Readonly<Record<string, string>> = { GATE_SKIP_REVIEW: "1" };

// A factory for the Docker sandbox every role runs in, with the host's skills
// mounted, .git/config and .git/hooks read-only, .git/review hidden, and
// SANDBOX_ENV set. The skills are looked up on
// the first call and reused after it, so a missing skill is reported once and
// skipped: the agent works without it.
export function makeAgentSandbox<TProvider>(
  host: SandboxHost<TProvider>,
  names: readonly string[] = SANDBOX_SKILLS,
): () => TProvider {
  let hostSkills: SkillMount[] | undefined;
  return () => {
    if (!hostSkills) {
      const { mounts, missing } = skillMounts(host.skillsDir, names);
      if (missing.length > 0) {
        host.log(`  ⚠ Skills not in ~/.claude/skills, so not in the sandbox: ${missing.join(", ")}`);
      }
      hostSkills = mounts;
    }
    return withCreateMounts(host.docker({ mounts: hostSkills, env: { ...SANDBOX_ENV } }), host.gitMounts());
  };
}

export const agentSandbox = makeAgentSandbox({
  skillsDir: join(homedir(), ".claude", "skills"),
  gitMounts: () => protectedGitMounts(repoGitDir()),
  docker,
  log: console.log,
});
