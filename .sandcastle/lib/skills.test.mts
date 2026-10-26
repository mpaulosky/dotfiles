import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { uiEnabled } from "./agents.mts";
import { SANDBOX_SKILLS } from "./repo-config.mts";
import { makeAgentSandbox, skillMounts, withCreateMounts, type SkillMount } from "./skills.mts";

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

describe("withCreateMounts", () => {
  it("covers a .git directory under a folder whose name starts with two dots", async () => {
    const calls: { mounts: { hostPath: string; sandboxPath: string }[] }[] = [];
    const provider = { tag: "bind-mount" as const, create: async (options: { mounts: { hostPath: string; sandboxPath: string }[] }) => calls.push(options) };
    const extra = [{ hostPath: "/empty", sandboxPath: "/srv/..repo/.git/review", readonly: true as const }];

    await withCreateMounts(provider, extra).create({ mounts: [{ hostPath: "/srv", sandboxPath: "/w" }] });

    assert.deepEqual(
      calls[0]?.mounts.filter((mount) => mount.hostPath === "/empty").map((mount) => mount.sandboxPath),
      ["/srv/..repo/.git/review", "/w/..repo/.git/review"],
    );
  });
});

describe("makeAgentSandbox", () => {
  type CreateOptions = { worktreePath: string; mounts: { hostPath: string; sandboxPath: string; readonly?: boolean }[] };

  function host(skillsDir: string) {
    const dockerCalls: { mounts: SkillMount[]; env: Record<string, string> }[] = [];
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
        gitMounts: () => [
          { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true as const },
          { hostPath: "/empty", sandboxPath: "/repo/.git/review", readonly: true as const },
        ],
        docker: (options: { mounts: SkillMount[]; env: Record<string, string> }) => {
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

  // Without it, every gate in the sandbox fails on .github/ci/gate-checks.sh's
  // review check, since Sandcastle's reviewer doesn't run /pre-push-review yet.
  it("starts every sandbox with the local review check skipped", () => {
    const stub = host(mkdtempSync(join(tmpdir(), "skills-")));

    makeAgentSandbox(stub.host, [])();

    assert.deepEqual(stub.dockerCalls[0]?.env, { GATE_SKIP_REVIEW: "1" });
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
      { hostPath: "/empty", sandboxPath: "/repo/.git/review", readonly: true },
    ]);
    assert.equal(stub.createCalls[0]?.worktreePath, "/repo/.sandcastle/worktrees/fix-1");
  });

  // Sandcastle's head mode (the planner, critique and intake) mounts the main
  // checkout itself, so its .git is also in the sandbox at the workspace's path.
  it("covers the .git directory wherever a mount puts it, not only at its own path", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);
    const headMode = [{ hostPath: "/repo", sandboxPath: "/home/agent/workspace" }];

    await makeAgentSandbox(stub.host, [])().create({ worktreePath: "/repo", mounts: headMode });

    assert.deepEqual(stub.createCalls[0]?.mounts, [
      ...headMode,
      { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true },
      { hostPath: "/repo/.git/config", sandboxPath: "/home/agent/workspace/.git/config", readonly: true },
      { hostPath: "/empty", sandboxPath: "/repo/.git/review", readonly: true },
      { hostPath: "/empty", sandboxPath: "/home/agent/workspace/.git/review", readonly: true },
    ]);
  });

  for (const [hostPath, sandboxPath, alias] of [
    ["/repo/", "/home/agent/workspace", "/home/agent/workspace/.git/review"],
    ["/repo/./.git/", "/w/.git/", "/w/.git/review"],
    ["/", "/host", "/host/repo/.git/review"],
  ] as const) {
    it(`covers the .git directory under a mount whose path isn't written plainly: ${hostPath}`, async () => {
      const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
      const stub = host(skillsDir);

      await makeAgentSandbox(stub.host, [])().create({ worktreePath: "/repo", mounts: [{ hostPath, sandboxPath }] });

      const covered = stub.createCalls[0]?.mounts.filter((mount) => mount.hostPath === "/empty").map((mount) => mount.sandboxPath);
      assert.deepEqual(covered, ["/repo/.git/review", alias]);
    });
  }

  for (const mount of [{ hostPath: "repo", sandboxPath: "/w" }, { hostPath: "/repo", sandboxPath: "w" }]) {
    it(`refuses a mount with a relative path, which it can't place: ${JSON.stringify(mount)}`, async () => {
      const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
      const stub = host(skillsDir);

      await assert.rejects(async () => makeAgentSandbox(stub.host, [])().create({ worktreePath: "/repo", mounts: [mount] }), /relative/);
    });
  }

  it("adds no cover outside a covered folder for a mount inside it", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);

    await makeAgentSandbox(stub.host, [])().create({ worktreePath: "/repo", mounts: [{ hostPath: "/repo/.git/review/x", sandboxPath: "/home/agent/x" }] });

    const covered = stub.createCalls[0]?.mounts.filter((mount) => mount.hostPath === "/empty").map((mount) => mount.sandboxPath);
    assert.deepEqual(covered, ["/repo/.git/review"]);
  });

  it("covers a path again where a mount shows exactly that path", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);
    const mounts = [{ hostPath: "/repo/.git/config", sandboxPath: "/home/agent/cfg" }];

    await makeAgentSandbox(stub.host, [])().create({ worktreePath: "/repo", mounts });

    assert.deepEqual(stub.createCalls[0]?.mounts, [
      ...mounts,
      { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true },
      { hostPath: "/repo/.git/config", sandboxPath: "/home/agent/cfg", readonly: true },
      { hostPath: "/empty", sandboxPath: "/repo/.git/review", readonly: true },
    ]);
  });

  it("adds no copy for a mount that only shares a prefix with the .git directory's path", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    const stub = host(skillsDir);
    const mounts = [{ hostPath: "/rep", sandboxPath: "/home/agent/other" }];

    await makeAgentSandbox(stub.host, [])().create({ worktreePath: "/rep", mounts });

    assert.deepEqual(stub.createCalls[0]?.mounts, [
      ...mounts,
      { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true },
      { hostPath: "/empty", sandboxPath: "/repo/.git/review", readonly: true },
    ]);
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

// The skills a role prompt's "# SKILLS" section lists, as `- \`name\`` bullets (a `: description` after the name is optional). Line
// endings may be CRLF, the heading may carry trailing spaces, and lines inside a code fence are neither headings nor bullets.
function listedSkills(prompt: string): string[] {
  const listed: string[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of prompt.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (inFence) continue;
    else if (/^# /.test(line)) inSection = /^# SKILLS\s*$/.test(line);
    else if (inSection) {
      const name = /^- `([^`]+)`/.exec(line)?.[1];
      if (name !== undefined) listed.push(name);
    }
  }
  return listed;
}

describe("listedSkills", () => {
  it("reads the bullets of the SKILLS section only", () => {
    const prompt = "# TASK\n\n- `not-a-skill`: x\n\n# SKILLS\n\nIntro.\n\n- `dotnet-tdd`: a\n- `dotnet-xunit`: b\n\n# EXECUTION\n\n- `also-not`: y\n";

    assert.deepEqual(listedSkills(prompt), ["dotnet-tdd", "dotnet-xunit"]);
  });

  it("reads a prompt with CRLF line endings, a heading with trailing spaces and a bullet without a colon", () => {
    const prompt = "# TASK\r\n\r\n# SKILLS  \r\n\r\n- `dotnet-tdd`: a\r\n- `dotnet-xunit`\r\n\r\n# EXECUTION\r\n";

    assert.deepEqual(listedSkills(prompt), ["dotnet-tdd", "dotnet-xunit"]);
  });

  it("ignores a heading or bullet inside a code fence", () => {
    const prompt = "# SKILLS\n\n- `dotnet-tdd`: a\n\n```markdown\n# EXECUTION\n- `in-fence`: b\n```\n\n- `dotnet-xunit`: c\n";

    assert.deepEqual(listedSkills(prompt), ["dotnet-tdd", "dotnet-xunit"]);
  });

  it("finds none in a prompt without the section", () => {
    assert.deepEqual(listedSkills("# TASK\n\n- `dotnet-tdd`: a\n"), []);
  });
});

// SANDBOX_SKILLS mounts the skills; the prompts tell the agent to use them. The two must agree, or a prompt promises a skill the
// sandbox doesn't have, or the sandbox mounts one no prompt mentions.
describe("role prompts and SANDBOX_SKILLS", () => {
  const rolesDir = new URL("../roles/", import.meta.url);
  const prompt = (role: string) => readFileSync(new URL(`${role}.md`, rolesDir), "utf8");
  const roles = readdirSync(rolesDir).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3));

  it("lists no skill that SANDBOX_SKILLS doesn't mount, in any role prompt", () => {
    for (const role of roles) {
      const unmounted = listedSkills(prompt(role)).filter((name) => !SANDBOX_SKILLS.includes(name));

      assert.deepEqual(unmounted, [], `roles/${role}.md lists skills lib/repo-config.mts doesn't mount`);
    }
  });

  // The roles that write code and tests each list every mounted skill; the ui role only in a repo that opted into it.
  for (const role of ["tester", "backend", "ui"]) {
    it(`lists every mounted skill in the ${role} prompt`, { skip: role === "ui" && !uiEnabled() && "the repo hasn't opted into the ui role" }, () => {
      const listed = listedSkills(prompt(role));
      const missing = SANDBOX_SKILLS.filter((name) => !listed.includes(name));

      assert.deepEqual(missing, [], `roles/${role}.md doesn't list skills lib/repo-config.mts mounts`);
    });
  }
});
