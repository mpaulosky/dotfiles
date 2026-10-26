import * as sandcastle from "@ai-hero/sandcastle";
import { z } from "zod";
import { runRole, uiEnabled } from "./agents.mts";
import { OPTIONAL_ROLES, type OptionalRole } from "./config.mts";
import { hooks } from "./repo-config.mts";
import type { SandcastleIssue } from "./github.mts";
import { plannerPromptArgs } from "./prompts.mts";
import { agentSandbox } from "./skills.mts";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev. There's no branch field: the host names branches
// (see branchFor), so a re-plan can't move an issue's work to a new branch.
// `roles` is left as unknown rather than validated here: an invalid value
// (not an array, or naming a role resolveRoles doesn't recognise) must fall
// back to every optional role, not abort the whole plan the way a schema
// mismatch would (see "Phase 4: Plan" in Blazor-Server's docs/plans/sandcastle-workflow.md).
// `files` is left unknown for the same reason: a bad value falls back to "no
// files" (resolveFiles), which lib/overlap.mts holds back unless no PR is
// open and no other pick naming files is built, and it's the first such pick,
// rather than aborting the plan.
const planSchema = z.object({
  issues: z.array(z.object({ id: z.string(), title: z.string(), roles: z.unknown().optional(), files: z.unknown().optional() })),
});

export type PlannedIssue = z.infer<typeof planSchema>["issues"][number];

// The optional roles (architect, UI developer, scribe) resolveRoles picks for
// one issue from the planner's raw `roles` field: the recognised ones,
// deduplicated and in build order, or every optional role when the field is
// missing, isn't an array, or names anything resolveRoles doesn't recognise
// (see OPTIONAL_ROLES in lib/config.mts). An empty array is valid on its own:
// it means the planner deliberately picked none. The `ui` role counts only in
// a repo that opted into it (see uiEnabled in lib/agents.mts): elsewhere it is
// neither recognised nor part of "every optional role".
export function resolveRoles(roles: unknown): OptionalRole[] {
  const available = OPTIONAL_ROLES.filter((role) => role !== "ui" || uiEnabled());
  const known: readonly string[] = available;
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string" && known.includes(role))) {
    return [...available];
  }
  return available.filter((role) => roles.includes(role));
}

// Where the repository is checked out inside the sandbox the planner runs in.
const SANDBOX_REPO_ROOT = "/home/agent/workspace";

// C0 and C1 control characters, DEL, and Unicode's line and paragraph
// separators. resolveFiles drops a path holding one, and lib/overlap.mts
// escapes them in the host's log, where a line starting "::" is a workflow
// command in Actions.
export const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// The paths the planner expects one issue to change, from its raw `files`
// field, cleaned up for lib/overlap.mts: trimmed, with backslashes as
// slashes, and empty, "." and repeated slashes' segments dropped, so "./x",
// "x/" and "x//" are all "x". A folder is a path like any other, which
// lib/overlap.mts treats as covering what's under it. The planner works in
// the sandbox, so an absolute path under `repoRoot` (the sandbox's checkout)
// is made relative to it; any other leading "/" is dropped. Entries
// that come out empty, such as the root itself, and repeats are dropped, and
// so is an entry with a control character or line break: it names no real
// file the planner meant, and it would reach the host's log, where a line
// starting "::" is a workflow command in Actions. The list is empty, meaning
// "no files", when the field isn't an array, when an entry isn't a string,
// or when an entry holds a glob (`*` or `?`), which can't be compared with a
// path, or climbs above the root with "..". Other ".." segments are folded into
// the one before, so two spellings of a file compare equal.
export function resolveFiles(files: unknown, repoRoot: string = SANDBOX_REPO_ROOT): string[] {
  const isPath = (file: unknown): file is string => typeof file === "string" && !/[*?]/.test(file);
  if (!Array.isArray(files) || !files.every(isPath)) return [];
  const segments = (path: string) => path.split("/").filter((segment) => segment !== "" && segment !== ".");
  // Folds each ".." into the segment before it, so "src/Web/../Web/a.cs" and
  // "src/Web/a.cs" compare equal. A path that climbs above the root names
  // nothing the host can compare, so it is undefined.
  const canonical = (parts: string[]): string[] | undefined => {
    const out: string[] = [];
    for (const part of parts) {
      if (part !== "..") out.push(part);
      else if (out.pop() === undefined) return undefined;
    }
    return out;
  };
  const root = segments(repoRoot.replace(/\\/g, "/"));
  const resolved = files.map((file) => {
    const path = file.trim().replace(/\\/g, "/");
    if (CONTROL_CHARACTER.test(path)) return [];
    const parts = canonical(segments(path));
    if (parts === undefined) return undefined;
    const underRoot = path.startsWith("/") && root.every((segment, i) => parts[i] === segment);
    return [(underRoot ? parts.slice(root.length) : parts).join("/")];
  });
  if (resolved.some((entry) => entry === undefined)) return [];
  const paths = resolved.flat() as string[];
  return [...new Set(paths.filter((path) => path !== ""))];
}

// The planner reads the ready issues, builds a dependency graph, and selects
// the issues that can be worked in parallel right now (i.e., no blocking
// dependencies on other open issues). Only issues that passed the blocker gate
// reach it, and the gate is enforced again in code afterwards, so a
// hallucinated or stale id can't start work on a blocked issue.
export async function planRound(ready: SandcastleIssue[]): Promise<PlannedIssue[]> {
  const plan = await runRole("planner", {
    hooks,
    sandbox: agentSandbox(),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: plannerPromptArgs(ready),
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  return readyPicks(plan.output.issues, ready);
}

// The planned issues that passed the blocker gate, in the planner's order, each
// once. A repeated id is dropped: two pipelines on one branch would race each
// other's sandboxes and pushes.
export function readyPicks(
  planned: readonly PlannedIssue[],
  ready: readonly Pick<SandcastleIssue, "number">[],
  log: (line: string) => void = console.log,
): PlannedIssue[] {
  const readyIds = new Set(ready.map((issue) => String(issue.number)));
  const picked = new Set<string>();
  return planned.filter((issue) => {
    if (!readyIds.has(issue.id)) {
      log(`  ⏸ Dropping #${issue.id} from the plan: it didn't pass the blocker gate.`);
      return false;
    }
    if (picked.has(issue.id)) return false;
    picked.add(issue.id);
    return true;
  });
}
