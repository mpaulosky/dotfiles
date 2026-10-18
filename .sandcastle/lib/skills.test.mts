import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeAgentSandbox, skillMounts, type SkillMount } from "./skills.mts";

function skill(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
  return dir;
}

describe("skillMounts", () => {
  it("mounts a symlinked skill from its real path, read only", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const real = skill(join(root, "dotfiles", "dotnet-tdd"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir);
    symlinkSync(real, join(skillsDir, "dotnet-tdd"));

    const { mounts } = skillMounts(skillsDir, ["dotnet-tdd"]);

    assert.deepEqual(mounts, [
      { hostPath: realpathSync(real), sandboxPath: "/home/agent/.claude/skills/dotnet-tdd", readonly: true },
    ]);
  });

  it("reports skills that are absent or have no SKILL.md", () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    skill(join(skillsDir, "dotnet-xunit"));
    mkdirSync(join(skillsDir, "dotnet-inspect"));

    const { mounts, missing } = skillMounts(skillsDir, ["dotnet-xunit", "dotnet-inspect", "dotnet-tdd"]);

    assert.deepEqual(mounts.map((mount) => mount.sandboxPath), ["/home/agent/.claude/skills/dotnet-xunit"]);
    assert.deepEqual(missing, ["dotnet-inspect", "dotnet-tdd"]);
  });
});

describe("makeAgentSandbox", () => {
  type CreateOptions = { worktreePath: string; mounts: { hostPath: string; sandboxPath: string; readonly?: boolean }[] };

  function host(skillsDir: string) {
    const dockerCalls: { mounts: SkillMount[] }[] = [];
    const createCalls: CreateOptions[] = [];
    const logs: string[] = [];
    const provider = {
      tag: "bind-mount" as const,
      name: "stub-docker",
      create: async (options: CreateOptions) => {
        createCalls.push(options);
        return { worktreePath: "/home/agent/workspace" };
      },
    };
    return {
      dockerCalls,
      createCalls,
      logs,
      host: {
        skillsDir,
        gitMounts: () => [{ hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true as const }],
        docker: (options: { mounts: SkillMount[] }) => {
          dockerCalls.push(options);
          return provider;
        },
        log: (message: string) => logs.push(message),
      },
    };
  }

  const worktreeMounts = () => [
    { hostPath: "/repo/.sandcastle/worktrees/fix-1", sandboxPath: "/home/agent/workspace" },
    { hostPath: "/repo/.git", sandboxPath: "/repo/.git" },
  ];

  it("passes the found skills' mounts to every Docker sandbox it creates", () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    skill(join(skillsDir, "dotnet-tdd"));
    const stub = host(skillsDir);
    const agentSandbox = makeAgentSandbox(stub.host, ["dotnet-tdd"]);

    agentSandbox();
    agentSandbox();

    assert.deepEqual(stub.dockerCalls.map((call) => call.mounts.map((mount) => mount.sandboxPath)), [
      ["/home/agent/.claude/skills/dotnet-tdd"],
      ["/home/agent/.claude/skills/dotnet-tdd"],
    ]);
  });

  // Sandcastle's docker() refuses a file mount outside /home/agent, such as
  // .git/config, but not the mounts it passes to create() itself.
  it("adds the .git directory's read-only mounts to the ones Sandcastle creates the sandbox with", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);

    await makeAgentSandbox(stub.host, ["dotnet-tdd"])().create({
      worktreePath: "/repo/.sandcastle/worktrees/fix-1",
      mounts: worktreeMounts(),
    });

    assert.deepEqual(stub.dockerCalls[0]?.mounts, []);
    assert.deepEqual(stub.createCalls[0]?.mounts, [
      ...worktreeMounts(),
      { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true },
    ]);
    assert.equal(stub.createCalls[0]?.worktreePath, "/repo/.sandcastle/worktrees/fix-1");
  });

  it("keeps the provider's other members", () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);

    const sandbox = makeAgentSandbox(stub.host, [])();

    assert.equal(sandbox.tag, "bind-mount");
    assert.equal(sandbox.name, "stub-docker");
  });

  it("refuses a provider it can't add the .git mounts to", () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);
    const agentSandbox = makeAgentSandbox({ ...stub.host, docker: () => ({ tag: "isolated" as const, name: "x" }) }, []);

    assert.throws(() => agentSandbox(), /read-only/);
  });

  it("reports missing skills once, however many sandboxes it creates", () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);
    const agentSandbox = makeAgentSandbox(stub.host, ["dotnet-tdd", "dotnet-xunit"]);

    agentSandbox();
    agentSandbox();

    assert.equal(stub.logs.length, 1);
    assert.match(stub.logs[0] ?? "", /dotnet-tdd, dotnet-xunit/);
  });

  it("logs nothing when every skill is found", () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    skill(join(skillsDir, "dotnet-tdd"));
    const stub = host(skillsDir);

    makeAgentSandbox(stub.host, ["dotnet-tdd"])();

    assert.deepEqual(stub.logs, []);
  });
});
