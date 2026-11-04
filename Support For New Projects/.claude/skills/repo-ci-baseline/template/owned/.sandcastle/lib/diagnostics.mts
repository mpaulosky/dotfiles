// What the sandbox looks like after a role fails and before a checkpoint's gate: free disk, free
// memory, the process count, the zombies, the limits on forking, the biggest processes and any core files. A reviewer whose claude-code
// aborted with a core dump, followed by a sandbox that could no longer fork, left logs that named
// no cause; this puts the sandbox's state in the host's log so the next failure does.

import type { Sandbox } from "@ai-hero/sandcastle";

// The seconds the probe's own `timeout` allows. The sandbox's exec gives any command COMMAND_LIMIT_MINUTES
// and marks the whole sandbox stalled when one runs over (lib/step-limit.mts), so a probe that hung in a
// broken sandbox would end the run. This ends it far sooner, as a non-zero exit that is only logged. It
// covers a slow or hung probe, not a process stuck in uninterruptible I/O that keeps the exec's output pipe open.
export const PROBE_SECONDS = 20;

// The read-only script, with no single quote so it can sit inside `sh -c '...'`. Each part falls back to
// a plainer form (busybox has no `ps --sort`) and the script ends in `true`, so a missing tool shows as an
// empty section. The core-file search names the files a crash leaves (`core`, `core.<pid>`) and looks in
// the current directory and /tmp as well as /, since -xdev stops at a mount and a crashing claude-code
// writes its core to its working directory.
export const PROBE_SCRIPT = [
  'echo "== disk =="; df -h / /tmp . 2>&1',
  'echo "== memory =="; free -m 2>&1 || head -n 5 /proc/meminfo 2>&1',
  'echo "== processes =="; ps -e 2>/dev/null | wc -l',
  // Zombies are counted apart: a PID 1 that never waits leaves one per orphan, and they hold PIDs until a fork fails.
  'echo "== zombies =="; if command -v ps >/dev/null 2>&1; then ps -eo stat= 2>/dev/null | grep -c "^Z"; else echo "n/a (no ps)"; fi',
  // What decides whether a fork succeeds (CGROUP_ROOT is for the test's fixture folder; the sandbox leaves it unset): the per-user limit (`ulimit -u`, which dash lacks, so read from /proc; threads count, on the whole host) and the container's cgroup.
  'echo "== process limits =="; grep "Max processes" /proc/self/limits 2>&1; for f in pids.current pids.max pids/pids.current pids/pids.max; do [ -r "${CGROUP_ROOT:-/sys/fs/cgroup}/$f" ] && echo "$f: $(cat "${CGROUP_ROOT:-/sys/fs/cgroup}/$f" 2>&1)"; done',
  'echo "== biggest processes (pid rss-kb elapsed command) =="; (ps -eo pid,rss,etime,comm --sort=-rss 2>/dev/null || ps -eo pid,rss,etime,comm 2>&1) | head -n 8',
  'echo "== core files =="; find / "$PWD" /tmp -xdev -maxdepth 4 -type f -size +0 \\( -name core -o -name "core.[0-9]*" \\) 2>/dev/null | sort -u | head -n 10',
  "true",
].join("; ");

// The command the sandbox runs: the script under its own short limit.
export const SANDBOX_PROBE = `timeout -k 2 ${PROBE_SECONDS} sh -c '${PROBE_SCRIPT}'`;

// Log the sandbox's state under `reason`, which the host writes (a role's name, a checkpoint). Never
// throws: a probe that fails (the sandbox may be the thing that is broken) is logged and changes nothing
// about the run. `scrub` makes what the sandbox printed safe to log; its file and process names are
// written by agents, so the build passes the gate output's cleaning (a line starting `::` is a workflow
// command in Actions). Both streams are logged, since a shell that can't fork says so on stderr.
export async function logSandboxState(
  sandbox: Pick<Sandbox, "exec">,
  reason: string,
  log: (line: string) => void,
  scrub: (text: string) => string = (text) => text,
): Promise<void> {
  try {
    const { stdout, stderr, exitCode } = await sandbox.exec(SANDBOX_PROBE);
    // 137 is a KILL after the timeout, and also what the kernel's out-of-memory kill returns, so it isn't called a timeout.
    const status = exitCode === 0 ? "" : exitCode === 124 ? " (exit 124: the probe timed out)" : exitCode === 137 ? " (exit 137: the probe was killed, by its timeout or by the kernel)" : ` (exit ${exitCode})`;
    const printed = [stdout, stderr].map((text) => text.trimEnd()).filter((text) => text !== "").join("\n");
    log(`sandbox state (${reason})${status}:\n${scrub(printed === "" ? "(no output)" : printed)}`);
  } catch (error) {
    // The scrub or the log may be what threw, so this too is guarded, with a line that holds nothing from the sandbox.
    try {
      log(`sandbox state (${reason}): the probe failed:\n${scrub(String(error).split("\n")[0] ?? "")}`);
    } catch {
      try {
        log(`sandbox state (${reason}): the probe failed, and its output could not be logged`);
      } catch {
        // Nothing left to log with; the probe never changes the run's outcome.
      }
    }
  }
}
