import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type * as sandcastle from "@ai-hero/sandcastle";
import type { Sandbox, SandboxRunOptions } from "@ai-hero/sandcastle";
import type { AgentProvider } from "@ai-hero/sandcastle";
import {
  isRoleTimeout,
  LEDGER_DENIED_TOOLS,
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
} from "./agents.mts";
import { FIXED_ROLE_AGENTS, ROLE_RUN_GRACE_MINUTES } from "./config.mts";
import { StalledStepError, UncountedStopError } from "./errors.mts";
import { RunLimits } from "./limits.mts";
import { ROLE_AGENTS } from "./repo-config.mts";
import { usageReport } from "./report.mts";
import { timelineReport } from "./role-timeline.mts";
import { hostCallHasBeenAbandoned, MAX_TIMER_MS } from "./host-limit.mts";
import { limitSandboxExec, stalledStepOf } from "./step-limit.mts";
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

  it("gives roleOptions' agent no timing when it is given no run, and the same command with one", () => {
    const toolEvents = roleOptions("tester").agent.parseStreamLine(toolLine("Bash"));
    assert.deepEqual(toolEvents, [{ type: "tool_call", name: "Bash", args: "ls" }]);
    timelineReport.reset();
    assert.deepEqual(timelineReport.lines(), []);

    const restrictions = { tools: REVIEWER_TOOLS, denied: LEDGER_DENIED_TOOLS, strictMcp: true };
    const print = { prompt: "p", dangerouslySkipPermissions: true };
    const plain = roleOptions("pre-push-reviewer", undefined, restrictions).agent.buildPrintCommand(print);
    const timed = roleOptions("pre-push-reviewer", undefined, restrictions, timelineReport.begin("pre-push-reviewer")).agent.buildPrintCommand(print);
    assert.deepEqual(timed, plain);
  });
});
