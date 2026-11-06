import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type * as sandcastle from "@ai-hero/sandcastle";
import type { Sandbox, SandboxRunOptions } from "@ai-hero/sandcastle";
import type { AgentProvider } from "@ai-hero/sandcastle";
import {
  isRoleTimeout,
  LEAD_AGENT_NAME,
  LEAD_DENIED_TOOLS,
  LEAD_DESCRIPTION,
  LEAD_PROMPT,
  leadTools,
  LEDGER_DENIED_TOOLS,
  MAX_AGENTS_WORD_BYTES,
  restrictedClaudeCode,
  REVIEWER_TOOLS,
  roleAgent,
  backstopMsFor,
  roleBackstopMs,
  roleOptions,
  runRole,
  uiEnabled,
  runRoleInSandbox,
  runWithinLimits,
  withSharedRules,
  type SubagentDefinition,
} from "./agents.mts";
import { FIXED_ROLE_AGENTS, ROLE_RUN_GRACE_MINUTES } from "./config.mts";
import { StalledStepError, UncountedStopError } from "./errors.mts";
import { RunLimits } from "./limits.mts";
import { ROLE_AGENTS } from "./repo-config.mts";
import { usageReport } from "./report.mts";
import { timedProvider, timelineReport } from "./role-timeline.mts";
import { hostCallHasBeenAbandoned, MAX_TIMER_MS } from "./host-limit.mts";
import { limitSandboxExec, stalledStepOf } from "./step-limit.mts";
import { withUiRole } from "./ui-role-fixture.mts";

const sharedRules = readFileSync(new URL("../roles/shared-rules.md", import.meta.url), "utf8");
// roles/skills.md is the repo's own Seed file; withSharedRules passes its text trimmed as {{REPO_SKILLS}}.
const repoSkills = readFileSync(new URL("../roles/skills.md", import.meta.url), "utf8").trim();

describe("roleOptions", () => {
  it("builds the ui role's options from its ROLE_AGENTS entry, and refuses it when the repo has none", async () => {
    await withUiRole(true, () => {
      assert.equal(uiEnabled(), true);
      assert.equal(roleOptions("ui").name, "ui");
    });
    await withUiRole(false, () => {
      assert.equal(uiEnabled(), false);
      assert.throws(() => roleOptions("ui"), /no ui entry/);
    });
  });

  it("names the run after the role and applies its iteration cap", () => {
    const options = roleOptions("tester");

    assert.equal(options.name, "tester");
    assert.equal(options.maxIterations, ROLE_AGENTS.tester.maxIterations);
  });

  it("runs the role's model at its effort", () => {
    const { command } = roleOptions("scribe").agent.buildPrintCommand({ prompt: "", dangerouslySkipPermissions: true });

    assert.match(command, new RegExp(`--model '${ROLE_AGENTS.scribe.model}'`));
    assert.match(command, new RegExp(`--effort ${ROLE_AGENTS.scribe.effort}`));
  });

  it("aborts the run after the role's timeout", () => {
    const requested: number[] = [];
    const signal = new AbortController().signal;

    const options = roleOptions("backend", (ms) => {
      requested.push(ms);
      return signal;
    });

    assert.deepEqual(requested, [ROLE_AGENTS.backend.timeoutMinutes * 60_000]);
    assert.equal(options.signal, signal);
  });
});

describe("runRoleInSandbox", () => {
  it("starts no role in a sandbox that stalled, and names the step", async () => {
    let ran = 0;
    const raw = {
      run: async () => (ran++, { iterations: [], commits: [] }),
      exec: async () => ({ stdout: "", stderr: "", exitCode: 124 }),
    } as unknown as Sandbox;
    const stalled = limitSandboxExec(raw, { log: () => undefined, now: ((time = 0) => () => (time += 11 * 60_000))() });
    await assert.rejects(stalled.exec("git fetch"), StalledStepError);

    await assert.rejects(
      runRoleInSandbox(stalled, "gate-fixer", { prompt: "" }),
      (error: unknown) => error instanceof StalledStepError && /the gate-fixer wasn't started: the step "git fetch"/.test(error.message),
    );

    assert.equal(ran, 0);
  });

  // The role's AbortSignal ends a run that answers it; a Docker exec that never answers would hold the run until the job's cap.
  it("gives up on a role run that never answers, with a StalledStepError, and starts no role after it in that sandbox", async () => {
    let ran = 0;
    const sandbox = { run: () => (ran++, new Promise<never>(() => undefined)) } as unknown as Sandbox;

    await assert.rejects(
      runRoleInSandbox(sandbox, "pre-push-reviewer", { prompt: "" }, new RunLimits(), undefined, { backstopMs: 20 }),
      (error: unknown) => error instanceof StalledStepError && /pre-push-reviewer run didn't finish/.test(error.message),
    );
    assert.match(stalledStepOf(sandbox) ?? "", /pre-push-reviewer/);
    // The host recorded the call it gave up on, so the process ends after its cleanup instead of waiting on a handle that never settles.
    assert.equal(hostCallHasBeenAbandoned(), true);
    await assert.rejects(runRoleInSandbox(sandbox, "backend", { prompt: "" }, new RunLimits(), undefined, { backstopMs: 20 }), /wasn't started/);
    assert.equal(ran, 1);
  });

  it("leaves a role run that answers in time alone, and clears its backstop timer so it can't stall the sandbox later", async () => {
    const sandbox = { run: async () => ({ iterations: [], commits: [] }) } as unknown as Sandbox;

    const result = await runRoleInSandbox(sandbox, "tester", { prompt: "" }, new RunLimits(), undefined, { backstopMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 90));

    assert.deepEqual(result, { iterations: [], commits: [] });
    assert.equal(stalledStepOf(sandbox), undefined, "the timer fired after the run answered");
  });

  it("clears its backstop timer when the run fails too", async () => {
    const sandbox = { run: () => Promise.reject(new Error("the agent failed")) } as unknown as Sandbox;

    await assert.rejects(runRoleInSandbox(sandbox, "tester", { prompt: "" }, new RunLimits(), undefined, { backstopMs: 30 }), /the agent failed/);
    await new Promise((resolve) => setTimeout(resolve, 90));

    assert.equal(stalledStepOf(sandbox), undefined);
  });

  it("waits for the role's timeoutMinutes plus ROLE_RUN_GRACE_MINUTES by default", () => {
    for (const role of ["backend", "pre-push-reviewer", "reviewer"] as const) {
      assert.equal(roleBackstopMs(role), (roleAgent(role).timeoutMinutes + ROLE_RUN_GRACE_MINUTES) * 60_000);
    }
  });

  it("refuses a timeout the host can't wait for, instead of giving up on every run at once", () => {
    assert.equal(backstopMsFor(45), (45 + ROLE_RUN_GRACE_MINUTES) * 60_000);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10 ** 9]) {
      assert.throws(() => backstopMsFor(bad), /timeoutMinutes/, String(bad));
    }
    assert.ok(backstopMsFor(Math.floor(MAX_TIMER_MS / 60_000) - ROLE_RUN_GRACE_MINUTES) <= MAX_TIMER_MS);
  });

  it("rejects a role whose timeoutMinutes the host can't wait for before it starts anything, and lists no role that never ran", async () => {
    const agent = ROLE_AGENTS.scribe as { timeoutMinutes: number };
    const original = agent.timeoutMinutes;
    let ran = 0;
    const sandbox = { run: async () => (ran++, { iterations: [], commits: [] }) } as unknown as Sandbox;
    agent.timeoutMinutes = 0;
    try {
      await assert.rejects(runRoleInSandbox(sandbox, "scribe", { prompt: "" }), /timeoutMinutes/);
    } finally {
      agent.timeoutMinutes = original;
    }

    assert.equal(ran, 0);
    assert.equal(stalledStepOf(sandbox), undefined);
    assert.equal(usageReport.totals().has("scribe"), false);
  });

  it("lists a role that ran even when its run fails", async () => {
    const failing = { run: () => Promise.reject(new Error("timed out")) } as unknown as Sandbox;

    await assert.rejects(runRoleInSandbox(failing, "tester", { prompt: "" }), /timed out/);

    assert.ok(usageReport.totals().has("tester"));
  });

  it("gives the role's prompt the shared rules alongside its own arguments", async () => {
    const runs: SandboxRunOptions[] = [];
    const sandbox = {
      run: async (options: SandboxRunOptions) => {
        runs.push(options);
        return { iterations: [], commits: [] };
      },
    } as unknown as Sandbox;

    await runRoleInSandbox(sandbox, "reviewer", { promptFile: "./review.md", promptArgs: { TASK_ID: "3" } });

    assert.deepEqual(runs[0]!.promptArgs, { TASK_ID: "3", SHARED_RULES: sharedRules, REPO_SKILLS: repoSkills });
  });

  // A run must stop cleanly at the time budget or Claude's usage limit,
  // without starting another role.
  it("never calls sandbox.run, and rejects with UncountedStopError, when the limits have already stopped the run", async () => {
    const limits = new RunLimits();
    limits.hitUsageLimit("usage limit reached during the backend run");
    let ran = false;
    const sandbox = {
      run: async () => {
        ran = true;
        return { iterations: [], commits: [] };
      },
    } as unknown as Sandbox;

    await assert.rejects(
      () => runRoleInSandbox(sandbox, "backend", { prompt: "" }, limits),
      (error: unknown) => error instanceof UncountedStopError,
    );
    assert.equal(ran, false);
  });
});

describe("runWithinLimits", () => {
  it("throws the stop reason before the run starts when the limits have already stopped the run", async () => {
    const limits = new RunLimits();
    limits.hitUsageLimit("usage limit reached");
    let started = false;

    await assert.rejects(
      () =>
        runWithinLimits(
          "backend",
          async () => {
            started = true;
            return "done";
          },
          limits,
        ),
      (error: unknown) => error instanceof UncountedStopError,
    );
    assert.equal(started, false);
  });

  it("records the usage limit and rethrows as an UncountedStopError carrying the original error as its cause", async () => {
    const limits = new RunLimits();
    const original = new Error("claude-code exited with code 1:\nClaude AI usage limit reached");

    await assert.rejects(
      () => runWithinLimits("backend", () => Promise.reject(original), limits),
      (error: unknown) => error instanceof UncountedStopError && error.cause === original,
    );
    assert.ok(limits.usageLimitReason()?.includes("backend"), String(limits.usageLimitReason()));
  });

  it("rethrows any other error unchanged, without recording a usage-limit stop", async () => {
    const limits = new RunLimits();
    const original = new Error("the backend failed: a real bug");

    await assert.rejects(
      () => runWithinLimits("backend", () => Promise.reject(original), limits),
      (error: unknown) => error === original,
    );
    assert.equal(limits.usageLimitReason(), undefined);
  });
});

describe("isRoleTimeout", () => {
  it("is true for AbortSignal.timeout's DOMException", () => {
    const error = new DOMException("The operation was aborted due to timeout", "TimeoutError");

    assert.equal(isRoleTimeout(error), true);
  });

  it("is true for an error tagged AgentIdleTimeoutError", () => {
    const error = Object.assign(new Error("Agent idle for 10 minutes"), { _tag: "AgentIdleTimeoutError" });

    assert.equal(isRoleTimeout(error), true);
  });

  it("is true for an Effect FiberFailure wrapping a TimeoutError", () => {
    const error = new Error("fiber failed");
    error.name = "(FiberFailure) TimeoutError";

    assert.equal(isRoleTimeout(error), true);
  });

  it("is true when the timeout is wrapped as a cause", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const error = new Error("the backend run failed", { cause: timeout });

    assert.equal(isRoleTimeout(error), true);
  });

  it("is true for a message saying the agent was idle", () => {
    const error = new Error("Agent idle for 600000ms, stopping");

    assert.equal(isRoleTimeout(error), true);
  });

  it("is false for an ordinary error", () => {
    assert.equal(isRoleTimeout(new Error("the backend failed: a real bug")), false);
  });

  it("is false for a network ConnectTimeoutError cause from a fetch failure", () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), { name: "ConnectTimeoutError" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });

    assert.equal(isRoleTimeout(error), false);
  });
});

describe("withSharedRules", () => {
  it("adds the shared rules and the repo's skills to a prompt file's arguments", () => {
    const options = withSharedRules({ promptFile: "./plan.md" });

    assert.deepEqual(options.promptArgs, { SHARED_RULES: sharedRules, REPO_SKILLS: repoSkills });
  });

  it("adds roles/skills.md's text as REPO_SKILLS, trimmed, and the shared rules as they are", () => {
    const { promptArgs } = withSharedRules({ promptFile: "./plan.md" });

    assert.equal(promptArgs?.REPO_SKILLS, repoSkills);
    assert.equal(promptArgs?.REPO_SKILLS, String(promptArgs?.REPO_SKILLS).trim());
    assert.equal(promptArgs?.SHARED_RULES, sharedRules);
  });

  it("keeps the arguments the caller passed alongside the two it adds", () => {
    const { promptArgs } = withSharedRules({ promptFile: "./plan.md", promptArgs: { TASK_ID: "7", ISSUES_JSON: "[]" } });

    assert.deepEqual(promptArgs, { TASK_ID: "7", ISSUES_JSON: "[]", SHARED_RULES: sharedRules, REPO_SKILLS: repoSkills });
  });

  // Sandcastle warns "provided but not referenced" for every argument a prompt doesn't use, so REPO_SKILLS goes only to a prompt that has the placeholder.
  describe("REPO_SKILLS", () => {
    const withPrompt = (text: string | undefined, run: (promptFile: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "prompt-"));
      try {
        const promptFile = join(dir, "prompt.md");
        if (text !== undefined) writeFileSync(promptFile, text);
        run(promptFile);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    };

    it("is left out for a prompt that doesn't reference it, so Sandcastle logs no warning", () => {
      withPrompt("# TASK\n\n{{SHARED_RULES}}\n", (promptFile) => {
        assert.deepEqual(withSharedRules({ promptFile }).promptArgs, { SHARED_RULES: sharedRules });
      });
    });

    it("is passed to a prompt that references it, with or without spaces inside the braces", () => {
      for (const placeholder of ["{{REPO_SKILLS}}", "{{ REPO_SKILLS }}", "{{\tREPO_SKILLS\n}}"]) {
        withPrompt(`# TASK\n\n${placeholder}\n\n{{SHARED_RULES}}\n`, (promptFile) => {
          assert.deepEqual(withSharedRules({ promptFile }).promptArgs, { SHARED_RULES: sharedRules, REPO_SKILLS: repoSkills }, placeholder);
        });
      }
    });

    it("is not matched by a longer name, a lowercase name or one cut short", () => {
      for (const text of ["{{REPO_SKILLS_X}}", "{{XREPO_SKILLS}}", "{{repo_skills}}", "{REPO_SKILLS}", "{{REPO_SKILLS}", "REPO_SKILLS"]) {
        withPrompt(text, (promptFile) => {
          assert.equal(withSharedRules({ promptFile }).promptArgs?.REPO_SKILLS, undefined, text);
        });
      }
    });

    it("is passed when the prompt file can't be read, so Sandcastle reports the missing file rather than a missing argument", () => {
      withPrompt(undefined, (promptFile) => {
        assert.equal(withSharedRules({ promptFile }).promptArgs?.REPO_SKILLS, repoSkills);
      });
    });

    it("is passed to the prompts that carry the placeholder in the Template, and left off the rest", () => {
      // fileURLToPath, not .pathname: the Template sits under a folder with spaces, which .pathname leaves as %20.
      const sandcastle = fileURLToPath(new URL("../", import.meta.url));
      const has = (file: string) => {
        const promptFile = join(sandcastle, file);
        assert.equal(existsSync(promptFile), true, `${file} can't be read: an unreadable prompt is passed REPO_SKILLS, which would hide a wrong path`);
        return withSharedRules({ promptFile }).promptArgs?.REPO_SKILLS !== undefined;
      };

      for (const file of ["roles/tester.md", "roles/backend.md", "roles/ui.md"]) assert.equal(has(file), true, file);
      for (const file of ["roles/architect.md", "roles/scribe.md", "roles/gate-fixer.md", "roles/follow-up.md", "plan-prompt.md", "review-prompt.md", "intake-prompt.md", "critique-prompt.md"]) {
        assert.equal(has(file), false, file);
      }
    });

    it("keeps the argument empty, not undefined, when roles/skills.md holds nothing, since Sandcastle accepts an empty string and refuses undefined", () => {
      withPrompt("{{REPO_SKILLS}}", (promptFile) => {
        assert.equal(typeof withSharedRules({ promptFile }).promptArgs?.REPO_SKILLS, "string");
      });
    });
  });

  it("leaves an inline prompt alone, since Sandcastle rejects arguments for one", () => {
    assert.deepEqual(withSharedRules({ prompt: "Say hi" }), { prompt: "Say hi" });
  });
});

// The host-side review (lib/host-review.mts) runs the pre-push-review skill's reviewers on text people without write access wrote, so
// they get only Read, Grep and Glob, and no agent may reach the ledger the host alone records.
describe("the pre-push reviewer role", () => {
  const printed = (agent: AgentProvider, prompt = "the prompt") => agent.buildPrintCommand({ prompt, dangerouslySkipPermissions: true });

  it("is read from FIXED_ROLE_AGENTS, which a repo's ROLE_AGENTS doesn't name", () => {
    assert.deepEqual(roleAgent("pre-push-reviewer"), FIXED_ROLE_AGENTS["pre-push-reviewer"]);
  });

  it("runs sonnet at high effort for the time FIXED_ROLE_AGENTS gives it", () => {
    const requested: number[] = [];
    const options = roleOptions("pre-push-reviewer", (ms) => {
      requested.push(ms);
      return new AbortController().signal;
    });
    const { command } = printed(options.agent);

    assert.equal(options.name, "pre-push-reviewer");
    assert.equal(options.maxIterations, 1);
    assert.deepEqual(requested, [FIXED_ROLE_AGENTS["pre-push-reviewer"].timeoutMinutes * 60_000]);
    assert.match(command, /--model 'sonnet'/);
    assert.match(command, /--effort high/);
  });

  it("gets exactly Read, Grep and Glob, the tools the agent file gives it", () => {
    const agentFile = readFileSync(new URL("../../.claude/agents/pre-push-reviewer.md", import.meta.url), "utf8");
    const tools = /^tools: (.+)$/m.exec(agentFile)?.[1];

    assert.deepEqual([...REVIEWER_TOOLS], ["Read", "Grep", "Glob"]);
    assert.equal(tools, REVIEWER_TOOLS.join(", "));
  });
});

describe("restrictedClaudeCode", () => {
  const reviewer = { tools: REVIEWER_TOOLS, denied: LEDGER_DENIED_TOOLS, strictMcp: true };
  const command = (restrictions: Parameters<typeof restrictedClaudeCode>[2]) =>
    restrictedClaudeCode("sonnet", "high", restrictions).buildPrintCommand({ prompt: "the prompt", dangerouslySkipPermissions: true });
  // The command with every single-quoted word removed: what the shell would see unquoted.
  const unquoted = (text: string) => text.replace(/'[^']*'/g, "''");

  it("names the reviewer's tools once as --tools Read,Grep,Glob, and no shell", () => {
    const { command: text } = command(reviewer);

    assert.equal(text.split("--tools").length - 1, 1, text);
    assert.match(text, /--tools '?Read,Grep,Glob'?(?= |$)/);
    // The ledger's deny rules name Bash(scripts/review.sh:*), which takes a shell tool away; what is granted holds no shell.
    assert.doesNotMatch(text.replace(/--disallowedTools(?: '[^']*')+/, ""), /Bash/);
    assert.match(text, /--model 'sonnet'/);
    assert.match(text, /--effort high/);
  });

  it("starts the reviewer without any MCP server but the ones it names", () => {
    assert.match(command(reviewer).command, /--strict-mcp-config/);
  });

  it("denies the ledger and scripts/review.sh to the reviewer", () => {
    const { command: text } = command(reviewer);

    assert.match(text, /--disallowedTools/);
    for (const rule of LEDGER_DENIED_TOOLS) assert.ok(text.includes(rule), `missing ${rule} in ${text}`);
  });

  it("keeps the prompt on stdin and the flags before -p -", () => {
    const result = command(reviewer);

    assert.equal(result.stdin, "the prompt");
    assert.match(result.command, /^claude --print /);
    assert.ok(result.command.endsWith(" -p -"), result.command);
  });

  it("quotes every rule, so a glob or a parenthesis reaches claude and not the shell", () => {
    assert.doesNotMatch(unquoted(command(reviewer).command), /[()*]/);
  });

  it("gives the fixer the ledger's deny rules but no --tools list or MCP restriction", () => {
    const { command: text } = command({ denied: LEDGER_DENIED_TOOLS });

    assert.doesNotMatch(text, /--tools/);
    assert.doesNotMatch(text, /--strict-mcp-config/);
    for (const rule of LEDGER_DENIED_TOOLS) assert.ok(text.includes(rule), `missing ${rule} in ${text}`);
  });

  it("changes nothing when it is given no restrictions", () => {
    assert.equal(command({}).command, restrictedClaudeCode("sonnet", "high", {}).buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true }).command);
    assert.doesNotMatch(command({}).command, /--tools|--disallowedTools|--strict-mcp-config/);
  });

  it("refuses a command Sandcastle builds in a shape it doesn't know, rather than run an agent without its restrictions", () => {
    const strange = (_model: string) =>
      ({ buildPrintCommand: () => ({ command: "node run-claude.js -p -", stdin: "x" }) }) as unknown as AgentProvider;

    assert.throws(() => restrictedClaudeCode("sonnet", "high", reviewer, strange as never), /claude --print/);
  });

  it("denies Read, Edit and Write on the ledger folder and its files, and running scripts/review.sh", () => {
    for (const tool of ["Read", "Edit", "Write"]) {
      assert.ok(LEDGER_DENIED_TOOLS.includes(`${tool}(//**/.git/review)`), `${tool} of the folder`);
      assert.ok(LEDGER_DENIED_TOOLS.includes(`${tool}(//**/.git/review/**)`), `${tool} of its files`);
    }
    assert.ok(LEDGER_DENIED_TOOLS.includes("Bash(scripts/review.sh:*)"));
  });
});

// Issue 399: one `claude -p` lead starts a round's reviewers as parallel subagents, defined on the command line with `--agents`.
describe("the pre-push review lead role", () => {
  it("is read from FIXED_ROLE_AGENTS, and its run is cut at that role's timeout", () => {
    const requested: number[] = [];
    const options = roleOptions("pre-push-review-lead", (ms) => {
      requested.push(ms);
      return new AbortController().signal;
    });

    assert.deepEqual(roleAgent("pre-push-review-lead"), FIXED_ROLE_AGENTS["pre-push-review-lead"]);
    assert.equal(options.name, "pre-push-review-lead");
    assert.equal(options.maxIterations, 1);
    assert.deepEqual(requested, [FIXED_ROLE_AGENTS["pre-push-review-lead"].timeoutMinutes * 60_000]);
  });

  it("gets Agent restricted to the lens-<id> agents of the round, Read, Grep and Glob, and no shell, no network and no write tool", () => {
    const tools = leadTools(["lens-1", "lens-2", "lens-10"]);

    assert.deepEqual(tools, ["Agent(lens-1,lens-2,lens-10)", ...REVIEWER_TOOLS]);
    assert.ok(!tools.includes("Agent"), "a bare Agent starts any subagent type");
    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "NotebookEdit"]) assert.ok(!tools.includes(tool), tool);
  });

  it("refuses no agents and a name that isn't plain, so the allowlist is never empty, wildcard or a shell surprise", () => {
    assert.throws(() => leadTools([]), /agent/i);
    for (const name of ["", "Lens-1", "lens 1", "lens-1)", "lens,x", "*", "lens-1;x"]) assert.throws(() => leadTools([name]), /agent|name/i, JSON.stringify(name));
  });
});

describe("LEAD_DENIED_TOOLS", () => {
  // A deny list can't name a tool a later release adds, so this is a second layer behind the definition's tools, not a guarantee.
  it("also denies the known tools that run commands, write files, reach the network, load skills or enter worktrees, so a lead that starts without its definition's tools is still held back from them", () => {
    const known = ["Bash", "BashOutput", "KillShell", "Monitor", "PowerShell", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Skill", "EnterWorktree"];
    for (const tool of known) assert.ok(LEAD_DENIED_TOOLS.includes(tool), `${tool} isn't denied`);
    // `Task` is the old name of the Agent tool and may alias it in deny rules, and a bare `Agent` is the tool itself: denying either could leave the lead unable to start a lens.
    // The Agent(...) allowlist already controls what it spawns.
    for (const tool of ["Task", "Agent"]) assert.ok(!LEAD_DENIED_TOOLS.includes(tool), `${tool} would deny the lead its Agent tool`);
  });

  it("holds the ledger deny list and denies every built-in subagent type, so the lead starts only the lens-<id> agents defined for it", () => {
    for (const rule of LEDGER_DENIED_TOOLS) assert.ok(LEAD_DENIED_TOOLS.includes(rule), rule);
    for (const type of ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "output-style-setup"]) {
      assert.ok(LEAD_DENIED_TOOLS.includes(`Agent(${type})`), `Agent(${type}) isn't denied`);
    }
  });
});

describe("restrictedClaudeCode's --agents", () => {
  const definition = (overrides: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
    description: "Reviews the branch through the Edge cases lens",
    prompt: "Read the file and follow it.",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet",
    ...overrides,
  });
  const lead = { tools: leadTools(["lens-1"]), denied: LEAD_DENIED_TOOLS, strictMcp: true, userSettingsOnly: true };
  // The lead's restrictions for these agents: its Agent tool names exactly them.
  const leadFor = (agents: Record<string, SubagentDefinition>) => ({ ...lead, tools: leadTools(Object.keys(agents)), agents });
  const commandOf = (restrictions: Parameters<typeof restrictedClaudeCode>[2]) =>
    restrictedClaudeCode("sonnet", "high", restrictions).buildPrintCommand({ prompt: "the prompt", dangerouslySkipPermissions: true }).command;
  // The words the shell hands claude, one per line, after `claude --print`: read back through a real shell, so quoting is tested, not assumed.
  // JSON.stringify never writes a raw newline, so the --agents word is one line.
  const wordsOf = (command: string): string[] => {
    const shell = spawnSync("sh", ["-c", `printf '%s\n' ${command.slice("claude --print ".length)}`], { encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
    return shell.stdout.split("\n");
  };
  const agentsJson = (command: string): unknown => {
    const words = wordsOf(command);
    const at = words.indexOf("--agents");
    assert.ok(at >= 0, `no --agents in ${command}`);
    return JSON.parse(words[at + 1]!);
  };
  // The definitions `--agents` carries besides the lead's own.
  const lensesOf = (command: string): unknown => {
    const { [LEAD_AGENT_NAME]: _lead, ...lenses } = agentsJson(command) as Record<string, unknown>;
    return lenses;
  };

  it("hands claude the definitions as one JSON word, by name", () => {
    const agents = { "lens-1": definition(), "lens-2": definition({ description: "Reviews through the Tests lens" }) };

    assert.deepEqual(lensesOf(commandOf(leadFor(agents))), agents);
  });

  it("keeps a single quote, a double quote, a dollar sign and a backtick in a definition intact through the shell", () => {
    const agents = { "lens-1": definition({ description: `it's the "Edge cases" lens $HOME \`id\``, prompt: `Don't $(touch /tmp/x); read 'the file'` }) };

    assert.deepEqual(lensesOf(commandOf(leadFor(agents))), agents);
  });

  it("defines the lead in --agents with the Agent allowlist as its own tools and starts it with --agent, since --tools gives a session no Agent tool for Agent(name,...)", () => {
    const command = commandOf(leadFor({ "lens-1": definition(), "lens-2": definition() }));
    const words = wordsOf(command);
    const lead = (agentsJson(command) as Record<string, { tools: string[]; model: string }>)[LEAD_AGENT_NAME]!;

    assert.equal(LEAD_AGENT_NAME, "pre-push-review-lead");
    assert.deepEqual(lead.tools, ["Agent(lens-1,lens-2)", ...REVIEWER_TOOLS]);
    assert.equal(lead.model, "sonnet");
    assert.equal(words[words.indexOf("--agent") + 1], LEAD_AGENT_NAME);
    assert.ok(!words.includes("--tools"), "--tools would leave the lead no Agent tool");
  });

  it("still emits --strict-mcp-config, --setting-sources user and the deny list beside --agents", () => {
    const command = commandOf(leadFor({ "lens-1": definition() }));
    const words = wordsOf(command);

    assert.ok(words.includes("--strict-mcp-config"));
    assert.equal(words[words.indexOf("--setting-sources") + 1], "user");
    assert.ok(words.includes("--disallowedTools"));
    for (const rule of LEAD_DENIED_TOOLS) assert.ok(words.includes(rule), rule);
    assert.equal(words.filter((word) => word === "--agents").length, 1);
  });

  it("fails closed when the lead's Agent tool isn't restricted to exactly the defined agents", () => {
    const agents = { "lens-1": definition(), "lens-2": definition() };
    const refused = (tools: readonly string[]) => () => restrictedClaudeCode("sonnet", "high", { ...lead, tools, agents });

    assert.doesNotThrow(refused(leadTools(["lens-1", "lens-2"])));
    assert.throws(refused(["Agent", ...REVIEWER_TOOLS]), /Agent/, "a bare Agent starts any subagent type");
    assert.throws(refused(["Agent(*)", ...REVIEWER_TOOLS]), /Agent/);
    assert.throws(refused(REVIEWER_TOOLS), /Agent/, "no Agent tool at all");
    assert.throws(refused(leadTools(["lens-1"])), /Agent/, "an agent the lead can't start");
    assert.throws(refused(leadTools(["lens-1", "lens-2", "lens-3"])), /Agent/, "an agent that isn't defined");
    assert.throws(refused([...leadTools(["lens-1", "lens-2"]), "Agent"]), /Agent/, "a bare Agent beside the list");
    assert.throws(() => restrictedClaudeCode("sonnet", "high", { ...lead, tools: undefined, agents }), /Agent/, "no --tools at all");
  });

  it("reserves the lead's own name: a subagent called pre-push-review-lead is refused, not silently replaced by the lead, and the allowlist can't name the lead", () => {
    const agents = { "lens-1": definition(), [LEAD_AGENT_NAME]: definition() };

    assert.throws(() => restrictedClaudeCode("sonnet", "high", { ...lead, tools: ["Agent(lens-1,pre-push-review-lead)", ...REVIEWER_TOOLS], agents }), /reserved/);
    assert.throws(() => leadTools([LEAD_AGENT_NAME]), /reserved/);
    assert.throws(() => leadTools(["lens-1", LEAD_AGENT_NAME]), /reserved/);
  });

  it("refuses a lead that holds a tool beyond the Agent allowlist and the reviewers' own, since its definition is now the only tool ceiling", () => {
    const agents = { "lens-1": definition() };
    const withTools = (tools: readonly string[]) => () => restrictedClaudeCode("sonnet", "high", { ...lead, tools, agents });

    assert.doesNotThrow(withTools(leadTools(["lens-1"])));
    // Anything that isn't exactly Agent(...) or one of the reviewers' own tools lands in the refusal, an odd spelling of Agent and a scoped Read among them.
    const extras = ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "NotebookEdit", "Bash(git status)", "mcp__x__y", "Task", "Agent (lens-1)", "agent", "AgentFoo", "Read(//**)", ""];
    for (const extra of extras) {
      assert.throws(withTools([...leadTools(["lens-1"]), extra]), /may hold only Agent\(\.\.\.\) and Read, Grep, Glob/, JSON.stringify(extra));
    }
  });

  it("writes the lead's description and prompt from LEAD_DESCRIPTION and LEAD_PROMPT, which are not empty", () => {
    const command = commandOf(leadFor({ "lens-1": definition() }));
    const defined = (agentsJson(command) as Record<string, { description: string; prompt: string }>)[LEAD_AGENT_NAME]!;

    assert.ok(LEAD_DESCRIPTION.trim().length > 0 && LEAD_PROMPT.trim().length > 0);
    assert.equal(defined.description, LEAD_DESCRIPTION);
    assert.equal(defined.prompt, LEAD_PROMPT);
  });

  it("keeps the prompt on stdin and the flags before -p -", () => {
    const result = restrictedClaudeCode("sonnet", "high", leadFor({ "lens-1": definition() })).buildPrintCommand({
      prompt: "the prompt",
      dangerouslySkipPermissions: true,
    });

    assert.equal(result.stdin, "the prompt");
    assert.match(result.command, /^claude --print /);
    assert.ok(result.command.endsWith(" -p -"), result.command);
  });

  it("adds no --agents when none are given", () => {
    assert.doesNotMatch(commandOf(lead), /--agents/);
    assert.doesNotMatch(commandOf({ tools: REVIEWER_TOOLS }), /--agents/);
    // `--agent` would start a reviewer as an agent nobody defined for it.
    for (const restrictions of [lead, { tools: REVIEWER_TOOLS }]) assert.ok(!wordsOf(commandOf(restrictions)).includes("--agent"));
  });

  it("applies --agents with the lead's required companions", () => {
    assert.ok(wordsOf(commandOf(leadFor({ "lens-1": definition() }))).includes("--agents"));
  });

  it("refuses subagents without the layers that back the lead's definition: its denied tools, strict MCP and the user's settings only", () => {
    const agents = { "lens-1": definition() };
    const build = (restrictions: Partial<typeof lead>) => () => restrictedClaudeCode("sonnet", "high", { ...lead, tools: leadTools(["lens-1"]), agents, ...restrictions });

    assert.doesNotThrow(build({}));
    assert.throws(build({ denied: undefined }), /must also/);
    assert.throws(build({ denied: [] }), /must also/);
    for (const rule of LEAD_DENIED_TOOLS) assert.throws(build({ denied: LEAD_DENIED_TOOLS.filter((one) => one !== rule) }), /must also/, rule);
    assert.throws(build({ strictMcp: false }), /must also/);
    assert.throws(build({ strictMcp: undefined }), /must also/);
    assert.throws(build({ userSettingsOnly: false }), /must also/);
    assert.throws(build({ userSettingsOnly: undefined }), /must also/);
  });

  // The restrictions with the lead's tools written by hand, so leadTools' own validation is not in the way and only agentsJson can refuse a name or an empty set.
  const byHand = (names: readonly string[], agents: Record<string, SubagentDefinition>) =>
    ({ ...lead, tools: [`Agent(${names.join(",")})`, ...REVIEWER_TOOLS], agents });

  it("refuses, where the provider is built, a subagent whose tools aren't a non-empty subset of the reviewers' own", () => {
    for (const tools of [["Bash"], ["Agent"], ["WebFetch"], ["Write"], ["Read", "Bash"], ["Read", "Grep", "Glob", "Edit"], [], ["read"]]) {
      assert.throws(() => restrictedClaudeCode("sonnet", "high", leadFor({ "lens-1": definition({ tools }) })), /the subagent lens-1 must hold/, JSON.stringify(tools));
    }
    for (const tools of [["Read"], ["Glob", "Read", "Grep"], ["Grep", "Glob"], ["Read", "Grep", "Glob"]]) {
      assert.doesNotThrow(() => restrictedClaudeCode("sonnet", "high", leadFor({ "lens-1": definition({ tools }) })), JSON.stringify(tools));
    }
  });

  it("refuses, where the provider is built, a name that isn't lowercase ASCII letters, digits and hyphens starting with a letter", () => {
    // `a,b` is one name that checkLeadAgentTool's comparison accepts (`Agent(a,b)`), so only agentsJson's name check stops it.
    for (const name of ["", "Lens-1", "1lens", "-lens", "lens_1", "lens 1", "lens-é", "lens;touch", "lens\n1", "../lens", "a,b", "*"]) {
      assert.throws(() => restrictedClaudeCode("sonnet", "high", byHand([name], { [name]: definition() })), /an agent name for --agents/, JSON.stringify(name));
    }
    for (const name of ["a", "lens-1", "lens-14", "a1-b2"]) {
      assert.doesNotThrow(() => restrictedClaudeCode("sonnet", "high", byHand([name], { [name]: definition() })), name);
    }
  });

  it("refuses an empty set of definitions, which is not the same as giving none", () => {
    assert.throws(() => restrictedClaudeCode("sonnet", "high", byHand([], {})), /for --agents are empty/);
    assert.throws(() => restrictedClaudeCode("sonnet", "high", leadFor({})), /agent/i, "leadTools refuses it too");
  });

  it("matches the lead's Agent tool to the agents by their names and order, wherever the tool sits among the others", () => {
    const agents = { "lens-1": definition(), "lens-2": definition() };
    const build = (tools: readonly string[]) => () => restrictedClaudeCode("sonnet", "high", { ...lead, tools, agents });

    assert.doesNotThrow(build([...REVIEWER_TOOLS, "Agent(lens-1,lens-2)"]), "the Agent tool last");
    assert.doesNotThrow(build(["Read", "Agent(lens-1,lens-2)", "Grep", "Glob"]), "the Agent tool among the others");
    assert.throws(build(["Agent(lens-2,lens-1)", ...REVIEWER_TOOLS]), /Agent/, "the same agents in another order are not the definitions' order");
  });

  // The size of the word the shell is handed: the JSON in single quotes, each single quote inside it written as four bytes ('\'').
  // The lead's own definition goes in the word too, so the test builds the same JSON restrictedClaudeCode does (the real function throws over the cap).
  const wordBytes = (agents: Record<string, SubagentDefinition>) => {
    const lead = { description: LEAD_DESCRIPTION, prompt: LEAD_PROMPT, tools: leadTools(Object.keys(agents)), model: "sonnet" };
    return Buffer.byteLength(`'${JSON.stringify({ ...agents, [LEAD_AGENT_NAME]: lead }).replaceAll("'", `'\\''`)}'`);
  };
  const build = (agents: Record<string, SubagentDefinition>) => () => restrictedClaudeCode("sonnet", "high", leadFor(agents));
  // One definition whose word is exactly `bytes` long, padded with `filler` (one byte per character unless it says otherwise).
  const sized = (bytes: number, filler = "d", perFiller = 1) => {
    const base = wordBytes({ "lens-1": definition({ description: "" }) });
    const agents = { "lens-1": definition({ description: filler.repeat(Math.floor((bytes - base) / perFiller)) }) };
    return agents;
  };

  it("refuses an --agents word over MAX_AGENTS_WORD_BYTES and accepts it at n-1 and n bytes, so it fails at build time and not at exec", () => {
    assert.equal(MAX_AGENTS_WORD_BYTES, 60_000);
    for (const bytes of [MAX_AGENTS_WORD_BYTES - 1, MAX_AGENTS_WORD_BYTES]) {
      const agents = sized(bytes);
      assert.equal(wordBytes(agents), bytes);
      assert.doesNotThrow(build(agents));
    }
    const over = sized(MAX_AGENTS_WORD_BYTES + 1);
    assert.equal(wordBytes(over), MAX_AGENTS_WORD_BYTES + 1);
    assert.throws(build(over), /byte|too (large|long)|limit/i);
  });

  it("counts the cap in bytes, not characters: multi-byte text over it is refused", () => {
    // Each é is one character and two bytes in UTF-8; JSON.stringify leaves it as it is.
    const agents = sized(MAX_AGENTS_WORD_BYTES + 2, "é", 2);

    assert.ok(JSON.stringify(agents).length <= MAX_AGENTS_WORD_BYTES);
    assert.ok(wordBytes(agents) > MAX_AGENTS_WORD_BYTES);
    assert.throws(build(agents), /byte|too (large|long)|limit/i);
  });

  // `shellWord` writes each ' as '\'' (four bytes), so JSON of apostrophes only a quarter of the cap long is already over it.
  it("counts the apostrophes the shell word escapes: JSON under the cap that quotes to a word over it is refused", () => {
    const agents = sized(MAX_AGENTS_WORD_BYTES + 4, "'", 4);

    assert.ok(Buffer.byteLength(JSON.stringify(agents)) < MAX_AGENTS_WORD_BYTES / 2);
    assert.ok(wordBytes(agents) > MAX_AGENTS_WORD_BYTES);
    assert.throws(build(agents), /byte|too (large|long)|limit/i);
    // And at the edge: one apostrophe fewer is four bytes fewer.
    const edge = sized(MAX_AGENTS_WORD_BYTES, "'", 4);
    assert.ok(wordBytes(edge) <= MAX_AGENTS_WORD_BYTES);
    assert.doesNotThrow(build(edge));
  });
});

describe("runRoleInSandbox with restrictions", () => {
  const sandboxRecording = (runs: SandboxRunOptions[]) =>
    ({
      run: async (options: SandboxRunOptions) => {
        runs.push(options);
        return { iterations: [], commits: [] };
      },
    }) as unknown as Sandbox;
  const commandOf = (options: SandboxRunOptions) => options.agent.buildPrintCommand({ prompt: "p", dangerouslySkipPermissions: true }).command;

  it("runs the role's agent with the restrictions it was given", async () => {
    const runs: SandboxRunOptions[] = [];

    await runRoleInSandbox(
      sandboxRecording(runs),
      "pre-push-reviewer",
      { prompt: "review" },
      new RunLimits(),
      { tools: REVIEWER_TOOLS, denied: LEDGER_DENIED_TOOLS, strictMcp: true },
    );

    const command = commandOf(runs[0]!);
    assert.match(command, /--tools '?Read,Grep,Glob'?(?= |$)/);
    assert.match(command, /--disallowedTools/);
    assert.match(command, /--model 'sonnet'/);
  });

  it("reads only the user's settings when asked, not the branch's hooks", async () => {
    const runs: SandboxRunOptions[] = [];

    await runRoleInSandbox(sandboxRecording(runs), "pre-push-reviewer", { prompt: "review" }, new RunLimits(), { tools: REVIEWER_TOOLS, userSettingsOnly: true });

    assert.match(commandOf(runs[0]!), /--setting-sources '?user'?(?= |$)/);
  });

  it("runs a role given no restrictions as before, with no --tools or deny list", async () => {
    const runs: SandboxRunOptions[] = [];

    await runRoleInSandbox(sandboxRecording(runs), "backend", { prompt: "build" });

    assert.doesNotMatch(commandOf(runs[0]!), /--tools|--disallowedTools|--strict-mcp-config/);
  });
});

// The role's tool calls are timed from the agent's stream (lib/role-timeline.mts), so the run report can say where a role's time went.
describe("role timing", () => {
  const toolLine = (...names: string[]) =>
    JSON.stringify({ type: "assistant", message: { content: names.map((name) => ({ type: "tool_use", name, input: { command: "ls", file_path: "/a" } })) } });
  // The stretches a role's line names, sorted: with the end of the run, a run with n calls has n + 1.
  // runRole's options need a sandbox provider; the stubbed run never looks at it.
  const hostOptions = { prompt: "" } as unknown as Parameters<typeof runRole>[1];
  const stretchesOf = (role: string): string[] => {
    const line = timelineReport.lines().find((entry) => entry.startsWith(`${role}:`)) ?? "";
    return [...line.matchAll(/ s after (\w+)/g)].map((match) => match[1]!).sort();
  };

  it("times the tool calls of a role run in a sandbox, also the ones Sandcastle's parser doesn't report, and ends the run", async () => {
    timelineReport.reset();
    const sandbox = {
      run: async (options: SandboxRunOptions) => {
        options.agent.parseStreamLine(toolLine("Bash"));
        options.agent.parseStreamLine(toolLine("Read"));
        return { iterations: [], commits: [] };
      },
    } as unknown as Sandbox;

    await runRoleInSandbox(sandbox, "scribe", { prompt: "" }, new RunLimits(), undefined, { backstopMs: 1000 });

    assert.match(timelineReport.lines()[0]!, /^scribe: 1 run, 2 tool calls, /);
    // The end of the run closes the stretch after the last call: without it there would be two stretches, not three.
    assert.deepEqual(stretchesOf("scribe"), ["Bash", "Read", "start"]);
  });

  it("ends the timing of a run that fails, and times a restricted role", async () => {
    timelineReport.reset();
    const sandbox = {
      run: async (options: SandboxRunOptions) => {
        options.agent.parseStreamLine(toolLine("Read"));
        throw new Error("the agent failed");
      },
    } as unknown as Sandbox;

    await assert.rejects(
      runRoleInSandbox(sandbox, "pre-push-reviewer", { prompt: "" }, new RunLimits(), { tools: REVIEWER_TOOLS }, { backstopMs: 1000 }),
      /the agent failed/,
    );

    assert.match(timelineReport.lines()[0]!, /^pre-push-reviewer: 1 run, 1 tool calls, /);
    assert.deepEqual(stretchesOf("pre-push-reviewer"), ["Read", "start"]);
  });

  it("lists no run for a role the run's limits refuse to start", async () => {
    timelineReport.reset();
    const limits = new RunLimits();
    limits.hitUsageLimit("Claude usage limit reached");
    let ran = 0;
    const sandbox = { run: async () => (ran++, { iterations: [], commits: [] }) } as unknown as Sandbox;

    await assert.rejects(runRoleInSandbox(sandbox, "tester", { prompt: "" }, limits, undefined, { backstopMs: 1000 }));
    await assert.rejects(runRole("planner", hostOptions, limits, (async () => (ran++, { iterations: [], commits: [] })) as unknown as typeof sandcastle.run));

    assert.equal(ran, 0);
    assert.deepEqual(timelineReport.lines(), []);
  });

  it("ignores the events of a run the host gave up on", async () => {
    timelineReport.reset();
    let agent: SandboxRunOptions["agent"] | undefined;
    const sandbox = { run: (options: SandboxRunOptions) => ((agent = options.agent), new Promise<never>(() => undefined)) } as unknown as Sandbox;

    await assert.rejects(runRoleInSandbox(sandbox, "backend", { prompt: "" }, new RunLimits(), undefined, { backstopMs: 20 }), StalledStepError);
    const before = timelineReport.lines();
    agent!.parseStreamLine(toolLine("Bash"));

    assert.deepEqual(timelineReport.lines(), before);
    assert.match(before[0]!, /^backend: 1 run, 0 tool calls, /);
  });

  it("times a host-side role run through runRole, and ends it when the run throws", async () => {
    timelineReport.reset();
    const ok = (async (options: { agent: { parseStreamLine(line: string): unknown } }) => {
      options.agent.parseStreamLine(toolLine("Grep"));
      return { iterations: [], commits: [] };
    }) as unknown as typeof sandcastle.run;
    await runRole("planner", hostOptions, new RunLimits(), ok);
    assert.match(timelineReport.lines()[0]!, /^planner: 1 run, 1 tool calls, /);
    assert.deepEqual(stretchesOf("planner"), ["Grep", "start"]);

    timelineReport.reset();
    const failing = (async (options: { agent: { parseStreamLine(line: string): unknown } }) => {
      options.agent.parseStreamLine(toolLine("Glob"));
      throw new Error("the run failed");
    }) as unknown as typeof sandcastle.run;
    await assert.rejects(runRole("planner", hostOptions, new RunLimits(), failing), /the run failed/);
    assert.deepEqual(stretchesOf("planner"), ["Glob", "start"]);
  });

  it("lists no run for a role whose options can't be built", async () => {
    timelineReport.reset();
    let ran = 0;
    const sandbox = { run: async () => (ran++, { iterations: [], commits: [] }) } as unknown as Sandbox;

    await withUiRole(false, async () => {
      await assert.rejects(runRoleInSandbox(sandbox, "ui", { prompt: "" }, new RunLimits(), undefined, { backstopMs: 1000 }), /no ui entry/);
      await assert.rejects(runRole("ui", hostOptions, new RunLimits(), (async () => (ran++, { iterations: [], commits: [] })) as unknown as typeof sandcastle.run), /no ui entry/);
    });

    assert.equal(ran, 0);
    assert.deepEqual(timelineReport.lines(), []);
  });

  it("leaves roleOptions' agent alone, and the wrapper changes neither its events nor its restricted command", () => {
    timelineReport.reset();
    const events = roleOptions("tester").agent.parseStreamLine(toolLine("Bash"));
    assert.deepEqual(events, [{ type: "tool_call", name: "Bash", args: "ls" }]);
    assert.deepEqual(timelineReport.lines(), [], "roleOptions timed a call with no run to time it");

    const restrictions = { tools: REVIEWER_TOOLS, denied: LEDGER_DENIED_TOOLS, strictMcp: true };
    const print = { prompt: "p", dangerouslySkipPermissions: true };
    const plain = roleOptions("pre-push-reviewer", undefined, restrictions).agent;
    const timed = timedProvider(plain, timelineReport.begin("pre-push-reviewer"));
    assert.deepEqual(timed.buildPrintCommand(print), plain.buildPrintCommand(print));
  });
});
