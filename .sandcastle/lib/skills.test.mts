import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { uiEnabled } from "./agents.mts";
import { SANDBOX_SKILLS } from "./repo-config.mts";
import { agentSandboxHost, DAEMON_INFO_TIMEOUT_MS, makeAgentSandbox, parseDaemonCpus, readDaemonCpus, skillMounts, withCreateMounts, type SkillMount } from "./skills.mts";

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

  // `daemon.cpus` is what the Docker daemon reports; undefined is "can't be read" (a default parameter would turn it into 8).
  function host(skillsDir: string, daemon: { cpus: number | undefined } = { cpus: 8 }) {
    const dockerCalls: { mounts: SkillMount[]; env: Record<string, string>; cpus?: number }[] = [];
    let daemonCpusReads = 0;
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
      daemonCpusReads: () => daemonCpusReads,
      createCalls,
      logs,
      host: {
        skillsDir,
        gitMounts: () => [
          { hostPath: "/repo/.git/config", sandboxPath: "/repo/.git/config", readonly: true as const },
          { hostPath: "/empty", sandboxPath: "/repo/.git/review", readonly: true as const },
        ],
        daemonCpus: () => {
          daemonCpusReads++;
          return daemon.cpus;
        },
        docker: (options: { mounts: SkillMount[]; env: Record<string, string>; cpus?: number }) => {
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

  describe("the CPUs of a Docker sandbox (mpaulosky/dotfiles#423)", () => {
    const callsFor = (daemonCpus: number | undefined, sandboxes = 2) => {
      const stub = host(mkdtempSync(join(tmpdir(), "skills-")), { cpus: daemonCpus });
      const sandbox = makeAgentSandbox(stub.host, []);
      for (let i = 0; i < sandboxes; i++) sandbox();
      return stub;
    };

    it("is 4 where the daemon has more, and all of the daemon's where it has fewer", () => {
      assert.deepEqual(callsFor(64).dockerCalls.map((call) => call.cpus), [4, 4]);
      assert.deepEqual(callsFor(4).dockerCalls.map((call) => call.cpus), [4, 4]);
      assert.deepEqual(callsFor(3).dockerCalls.map((call) => call.cpus), [3, 3]);
      assert.deepEqual(callsFor(2).dockerCalls.map((call) => call.cpus), [2, 2]);
    });

    it("leaves the option out, so the sandbox is unlimited as before, when the daemon's count can't be read, and says so once", () => {
      const stub = callsFor(undefined, 3);

      assert.equal(stub.dockerCalls.length, 3);
      assert.ok(stub.dockerCalls.every((call) => !("cpus" in call)), JSON.stringify(stub.dockerCalls));
      assert.deepEqual(stub.logs.filter((line) => line.includes("CPU count")), ["  ⚠ Couldn't read Docker's CPU count, so sandboxes start with no CPU limit."]);
    });

    it("asks the daemon once, however many sandboxes it makes, even when it could not answer", () => {
      assert.equal(callsFor(8, 3).daemonCpusReads(), 1);
      assert.equal(callsFor(undefined, 3).daemonCpusReads(), 1);
    });

    it("asks the daemon only when a sandbox is made", () => {
      const stub = host(mkdtempSync(join(tmpdir(), "skills-")));
      makeAgentSandbox(stub.host, []);

      assert.equal(stub.daemonCpusReads(), 0);
    });
  });

  describe("parseDaemonCpus", () => {
    it("reads the whole number `docker info --format {{.NCPU}}` prints", () => {
      assert.equal(parseDaemonCpus("8\n"), 8);
      assert.equal(parseDaemonCpus("  12  "), 12);
      assert.equal(parseDaemonCpus("1"), 1);
    });

    it("gives undefined for anything else", () => {
      for (const text of ["", "\n", "abc", "0", "-2", "4.5", "8 CPUs", "1e3", "0x10", "99999999999999999999", "NaN"]) {
        assert.equal(parseDaemonCpus(text), undefined, JSON.stringify(text));
      }
    });
  });

  describe("readDaemonCpus", () => {
    it("runs `docker info --format {{.NCPU}}` with a time limit of its own", () => {
      const calls: { file: string; args: string[]; options: { encoding: string; timeout: number } }[] = [];

      const cpus = readDaemonCpus((file, args, options) => {
        calls.push({ file, args, options });
        return "6\n";
      });

      assert.equal(cpus, 6);
      assert.deepEqual(calls.map((call) => [call.file, call.args]), [["docker", ["info", "--format", "{{.NCPU}}"]]]);
      assert.equal(calls[0]?.options.encoding, "utf8");
      assert.equal(DAEMON_INFO_TIMEOUT_MS, 30_000);
      assert.equal(calls[0]?.options.timeout, DAEMON_INFO_TIMEOUT_MS);
    });

    it("gives undefined when docker fails, times out (execFileSync throws ETIMEDOUT) or prints something that is not a count", () => {
      const throwing = () => {
        throw new Error("Cannot connect to the Docker daemon");
      };
      const timedOut = () => {
        throw Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" });
      };

      assert.equal(readDaemonCpus(throwing), undefined);
      assert.equal(readDaemonCpus(timedOut), undefined);
      assert.equal(readDaemonCpus(() => ""), undefined);
      assert.equal(readDaemonCpus(() => "unknown"), undefined);
    });
  });

  // The production path: readDaemonCpus() with no argument runs the host's time-limited execFileSync, and agentSandboxHost, which
  // agentSandbox is made from, reads the daemon through it. A stub `docker` first on PATH stands in for the daemon.
  describe("the real exec path, with a stub docker on PATH", { skip: process.platform === "win32" ? "needs sh" : false }, () => {
    function withStubDocker<T>(script: string, body: () => T): T {
      const dir = mkdtempSync(join(tmpdir(), "stub-docker-"));
      const stub = join(dir, "docker");
      writeFileSync(stub, `#!/bin/sh\n${script}\n`);
      chmodSync(stub, 0o755);
      const saved = process.env["PATH"];
      process.env["PATH"] = `${dir}:${saved ?? ""}`;
      try {
        return body();
      } finally {
        if (saved === undefined) delete process.env["PATH"];
        else process.env["PATH"] = saved;
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
    const printsSix = '[ "$1 $2 $3" = "info --format {{.NCPU}}" ] && echo 6 || exit 9';

    it("reads the count the stub docker prints, through the exact arguments", () => {
      assert.equal(withStubDocker(printsSix, () => readDaemonCpus()), 6);
    });

    it("gives undefined when the stub docker exits non-zero or prints a bad count", () => {
      assert.equal(withStubDocker("exit 1", () => readDaemonCpus()), undefined);
      assert.equal(withStubDocker("echo not-a-number", () => readDaemonCpus()), undefined);
      assert.equal(withStubDocker("echo 0", () => readDaemonCpus()), undefined);
    });

    it("is what the production sandbox host reads the daemon's CPUs through", () => {
      assert.equal(withStubDocker(printsSix, () => agentSandboxHost.daemonCpus()), 6);
      assert.equal(withStubDocker("exit 1", () => agentSandboxHost.daemonCpus()), undefined);
    });
  });

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
  // review check: the host runs the review's rounds itself (lib/host-review.mts) and keeps the ledger out of the sandbox.
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

// SANDBOX_SKILLS mounts the skills; roles/skills.md tells the agent to use them, and withSharedRules hands its text to the prompts as
// {{REPO_SKILLS}} (mpaulosky/dotfiles#392). The two must agree, or the file promises a skill the sandbox doesn't have, or the sandbox
// mounts one nothing mentions.
describe("roles/skills.md and SANDBOX_SKILLS", () => {
  const rolesDir = new URL("../roles/", import.meta.url);
  const prompt = (role: string) => readFileSync(new URL(`${role}.md`, rolesDir), "utf8");
  const skillsFile = () => prompt("skills");

  it("lists no skill that SANDBOX_SKILLS doesn't mount, in roles/skills.md", () => {
    const unmounted = listedSkills(skillsFile()).filter((name) => !SANDBOX_SKILLS.includes(name));

    assert.deepEqual(unmounted, [], "roles/skills.md lists skills lib/repo-config.mts doesn't mount");
  });

  it("lists every mounted skill in roles/skills.md", () => {
    const listed = listedSkills(skillsFile());
    const missing = SANDBOX_SKILLS.filter((name) => !listed.includes(name));

    assert.deepEqual(
      missing,
      [],
      `roles/skills.md doesn't list skills lib/repo-config.mts mounts: add or complete its "# SKILLS" section, one "- \`name\`: when to use it" line per skill (the repo-ci-baseline skill's references/sandcastle.md shows the block)`,
    );
  });

  // The roles that write code and tests get the file's text; the ui role only in a repo that opted into it.
  for (const role of ["tester", "backend", "ui"]) {
    it(`puts {{REPO_SKILLS}} in the ${role} prompt, on a line of its own`, { skip: role === "ui" && !uiEnabled() && "the repo hasn't opted into the ui role" }, () => {
      const lines = prompt(role).split(/\r?\n/);
      const at = lines.indexOf("{{REPO_SKILLS}}");

      assert.notEqual(at, -1, `roles/${role}.md has no line holding only {{REPO_SKILLS}}`);
      assert.equal(lines.filter((line) => line.includes("{{REPO_SKILLS}}")).length, 1, `roles/${role}.md names {{REPO_SKILLS}} more than once`);
      assert.equal(lines[at - 1], "", "a blank line goes before it");
      assert.equal(lines[at + 1], "", "a blank line goes after it");
    });
  }

  it("leaves no # SKILLS section inline in a role prompt, since the block lives in roles/skills.md", () => {
    const owned = readdirSync(rolesDir)
      .filter((file) => file.endsWith(".md") && file !== "skills.md" && file !== "shared-rules.md")
      .map((file) => file.slice(0, -3));

    assert.ok(owned.includes("tester") && owned.includes("backend"), "the role prompts weren't found");
    for (const role of owned) assert.doesNotMatch(prompt(role), /^# SKILLS\s*$/m, `roles/${role}.md keeps its own # SKILLS section`);
  });
});
