// What the sandbox looks like after a role fails and before a checkpoint's gate: free disk, free
// memory, the process count, the biggest processes and any core files. A reviewer whose claude-code
// aborted with a core dump, followed by a sandbox that could no longer fork, left logs that named
// no cause; this puts the sandbox's state in the host's log so the next failure does.

import type { Sandbox } from "@ai-hero/sandcastle";

// One read-only shell command. Each part falls back to a plainer form (busybox has no `ps --sort`)
// and the whole ends in `true`, so a missing tool shows as an empty section rather than a failed probe.
export const SANDBOX_PROBE = [
  "echo '== disk =='; df -h / /tmp . 2>&1",
  "echo '== memory =='; free -m 2>&1 || head -n 5 /proc/meminfo 2>&1",
  "echo '== processes =='; ps -e 2>/dev/null | wc -l",
  "echo '== biggest processes (pid rss-kb elapsed command) =='; (ps -eo pid,rss,etime,comm --sort=-rss 2>/dev/null || ps -eo pid,rss,etime,comm 2>&1) | head -n 8",
  "echo '== core files =='; find / -xdev -name 'core*' -type f -size +0 2>/dev/null | head -n 10",
  "true",
].join("; ");

// Log the sandbox's state under `reason`. Never throws: a probe that fails (the sandbox may be the
// thing that is broken, and a stalled step throws again on every later exec) is logged and changes
// nothing about the run. `scrub` makes the output safe to log, as it does the gate's.
export async function logSandboxState(
  sandbox: Pick<Sandbox, "exec">,
  reason: string,
  log: (line: string) => void,
  scrub: (text: string) => string = (text) => text,
): Promise<void> {
  try {
    const { stdout, exitCode } = await sandbox.exec(SANDBOX_PROBE);
    const status = exitCode === 0 ? "" : ` (exit ${exitCode})`;
    log(scrub(`sandbox state (${reason})${status}:\n${stdout.trimEnd()}`));
  } catch (error) {
    log(scrub(`sandbox state (${reason}): the probe failed: ${String(error).split("\n")[0]}`));
  }
}
