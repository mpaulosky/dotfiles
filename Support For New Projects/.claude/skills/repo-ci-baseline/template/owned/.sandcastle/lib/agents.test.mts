import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Sandbox, SandboxRunOptions } from "@ai-hero/sandcastle";
import type { AgentProvider } from "@ai-hero/sandcastle";
import {
  isRoleTimeout,
  LEDGER_DENIED_TOOLS,
  restrictedClaudeCode,
  REVIEWER_TOOLS,
  roleAgent,
  roleOptions,
  uiEnabled,
  runRoleInSandbox,
  runWithinLimits,
  withSharedRules,
} from "./agents.mts";
import { FIXED_ROLE_AGENTS } from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import { RunLimits } from "./limits.mts";
import { ROLE_AGENTS } from "./repo-config.mts";
import { usageReport } from "./report.mts";
import { withUiRole } from "./ui-role-fixture.mts";

const sharedRules = readFileSync(new URL("../roles/shared-rules.md", import.meta.url), "utf8");

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

    assert.deepEqual(runs[0]!.promptArgs, { TASK_ID: "3", SHARED_RULES: sharedRules });
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
  it("adds the shared rules to a prompt file's arguments", () => {
    const options = withSharedRules({ promptFile: "./plan.md" });

    assert.deepEqual(options.promptArgs, { SHARED_RULES: sharedRules });
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
