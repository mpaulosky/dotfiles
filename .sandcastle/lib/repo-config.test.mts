import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { SANDCASTLE_CHECK, SANDCASTLE_WORKFLOW } from "./config.mts";
import { approvedHeadOf } from "./follow-up.mts";
import type { OpenPullRequest } from "./github.mts";
import { findOverlaps, holdOverlappingPicks, pathKey, type FilePick, type OverlapGitHub } from "./overlap.mts";
import { OutcomeReport } from "./report.mts";
import {
  CHECK_PATHS,
  GATE_COVERED_CHECKS,
  MAX_ITERATIONS,
  ROLE_AGENTS,
  SANDBOX_SKILLS,
  TEMPLATE_OWNED_DIR,
  TEMPLATE_ROOT_COPIES,
  copyToWorktree,
  hooks,
} from "./repo-config.mts";

// dotfiles' own values for the per-repo names the Owned modules read from lib/repo-config.mts. The Template's Owned tests pin none of
// them, so dotfiles pins them here. This file and lib/template.test.mts are dotfiles', not the Template's.

const sonnet = "claude-sonnet-5-5";

const root = new URL("../../", import.meta.url);
const skill = TEMPLATE_OWNED_DIR.replace("/template/owned", "");
const ownedFolder = new URL(`${TEMPLATE_OWNED_DIR}/.sandcastle/`, root);
const seedFolder = new URL(`${skill}/template/seed/.sandcastle/`, root);

describe("ROLE_AGENTS", () => {
  it("configures every role with the spec's model, effort, iterations and timeout", () => {
    assert.deepEqual(ROLE_AGENTS, {
      intake: { model: sonnet, effort: "medium", maxIterations: 1, timeoutMinutes: 15 },
      planner: { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      critique: { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      architect: { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      tester: { model: sonnet, effort: "high", maxIterations: 3, timeoutMinutes: 45 },
      backend: { model: sonnet, effort: "high", maxIterations: 10, timeoutMinutes: 45 },
      scribe: { model: sonnet, effort: "medium", maxIterations: 1, timeoutMinutes: 15 },
      reviewer: { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      "gate-fixer": { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 20 },
      "follow-up": { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 30 },
    });
  });
});

describe("dotfiles' other per-repo values", () => {
  it("runs at most 10 rounds, copies node_modules into the worktree and mounts no skills", () => {
    assert.equal(MAX_ITERATIONS, 10);
    assert.deepEqual(copyToWorktree, ["node_modules"]);
    assert.deepEqual([...SANDBOX_SKILLS], []);
  });

  it("installs dependencies when the sandbox is ready", () => {
    assert.match(hooks.sandbox.onSandboxReady[0]!.command, /^pnpm install --frozen-lockfile/);
  });
});

describe("GATE_COVERED_CHECKS", () => {
  it(`is ["Template tests"], the one job scripts/gate.sh reproduces here`, () => {
    assert.deepEqual([...GATE_COVERED_CHECKS], ["Template tests"]);
  });

  // A rename of the job without this list would send a gate-reproducible failure to the follow-up role instead of a re-run.
  it("names a job in repo-ci-baseline.yml", () => {
    const workflow = readFileSync(new URL(".github/workflows/repo-ci-baseline.yml", root), "utf8");

    for (const name of GATE_COVERED_CHECKS) {
      assert.match(workflow, new RegExp(`^    name: ${name}$`, "m"), `no job named ${name}`);
    }
  });
});

// The record-head job builds its comment in shell, so only a read of the workflow's text with the real approvedHeadOf shows the sweep reads it back.
// This file is dotfiles' own: the Template's Owned tests run in a scratch copy of .sandcastle/ alone, where there is no workflow to read.
describe("the Sandcastle workflow's record-head comment", () => {
  it("is read back by approvedHeadOf once the head is put in", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/sandcastle.yml", import.meta.url), "utf8");
    const firstLine = /^ +body="(.*)$/m.exec(workflow)?.[1];
    assert.ok(firstLine !== undefined, 'sandcastle.yml\'s record-head script must build its comment as body="..."');
    const head = "0123456789abcdef0123456789abcdef01234567";

    assert.equal(approvedHeadOf(`${firstLine.replace("$HEAD_SHA", head)}\nSandcastle follows this pull request up.`), head);
  });
});

describe("SANDCASTLE_CHECK and SANDCASTLE_WORKFLOW", () => {
  // The sweep leaves out the check named SANDCASTLE_CHECK as its own, so renaming the workflow's job without it would bring the bug back.
  it("is the name of the Sandcastle workflow's job", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/sandcastle.yml", import.meta.url), "utf8");

    assert.match(workflow, new RegExp(`^jobs:\\n  sandcastle:\\n    name: ${SANDCASTLE_CHECK}\\n`, "m"));
  });

  it("is the name of the Sandcastle workflow", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/sandcastle.yml", import.meta.url), "utf8");

    assert.match(workflow, new RegExp(`^name: ${SANDCASTLE_WORKFLOW}$`, "m"));
  });
});

// lib/overlap.mts counts each Owned file and its root copy as one path, so the list must be the one test.sh's copy check walks.
describe("TEMPLATE_ROOT_COPIES", () => {
  it("is the list test.sh's copy check of dotfiles' root copies walks, entry for entry and in the same order", () => {
    const testSh = readFileSync(new URL(`${skill}/test.sh`, root), "utf8");
    const loop = /for file in ((?:.|\n)*?); do/.exec(testSh.slice(testSh.indexOf("dotfiles' copies of Template files")));

    assert.ok(loop, "test.sh has no copy-check loop");
    const listed = loop[1]!.replace(/\\\n/g, " ").split(/\s+/).filter(Boolean);
    assert.deepEqual([...TEMPLATE_ROOT_COPIES], listed);
  });

  it("names a file that exists under the Template's owned folder and at the root", () => {
    for (const file of TEMPLATE_ROOT_COPIES) {
      assert.ok(existsSync(new URL(`${TEMPLATE_OWNED_DIR}/${file}`, root)), `${TEMPLATE_OWNED_DIR}/${file}`);
      assert.ok(existsSync(new URL(file, root)), file);
    }
  });

  // The Template's Sandcastle section is Owned files under .sandcastle/. A new one must reach the list (and so test.sh's copy check and
  // the overlap rule) before it can drift from dotfiles' copy unseen.
  it("lists every Owned file the Template carries under .sandcastle/", () => {
    assert.ok(existsSync(ownedFolder), "the Template has no owned/.sandcastle/ folder");
    const owned = (readdirSync(ownedFolder, { recursive: true }) as string[])
      .filter((entry) => statSync(new URL(entry, ownedFolder)).isFile())
      .map((entry) => `.sandcastle/${entry.split("\\").join("/")}`)
      .sort();

    assert.ok(owned.length > 0, "owned/.sandcastle/ holds no files");
    for (const file of owned) {
      assert.ok((TEMPLATE_ROOT_COPIES as readonly string[]).includes(file), `${file} is missing from TEMPLATE_ROOT_COPIES`);
    }
  });

  it("lists its .sandcastle/ entries in LC_ALL=C sort order, after the others", () => {
    const sandcastle = TEMPLATE_ROOT_COPIES.filter((file) => file.startsWith(".sandcastle/"));
    const sorted = [...sandcastle].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    assert.deepEqual(sandcastle, sorted);
    assert.deepEqual([...TEMPLATE_ROOT_COPIES.slice(TEMPLATE_ROOT_COPIES.length - sandcastle.length)], sandcastle);
  });
});

describe("the Template owns Sandcastle's code", () => {
  // Acceptance: the modules move into the Template's Owned .sandcastle/, with their tests. The files left behind are dotfiles' own.
  it("owns every Sandcastle module dotfiles has, except its own files", () => {
    const own = new Set([
      "lib/repo-config.mts",
      "lib/repo-config.test.mts",
      "lib/template.test.mts",
      "lib/dockerfile.test.mts",
      "lib/role-prompts.test.mts",
      "lib/owned-paths.test.mts",
    ]);
    const here = new URL("../", import.meta.url);
    const expected = [
      "main.mts",
      "status.mts",
      "status.test.mts",
      ...readdirSync(new URL("lib/", here))
        .filter((name) => name.endsWith(".mts"))
        .map((name) => `lib/${name}`),
    ]
      .filter((file) => !own.has(file))
      .sort();
    const owned = (readdirSync(ownedFolder, { recursive: true }) as string[])
      .map((entry) => entry.split("\\").join("/"))
      .filter((entry) => entry.endsWith(".mts"))
      .sort();

    assert.deepEqual(owned, expected);
  });

  it("carries lib/repo-config.mts as a Seed file, not an Owned one", () => {
    assert.ok(existsSync(new URL("lib/repo-config.mts", seedFolder)), "the Seed has no lib/repo-config.mts");
    assert.equal(existsSync(new URL("lib/repo-config.mts", ownedFolder)), false);
  });
});

const ownedWorkflow = `${TEMPLATE_OWNED_DIR}/.github/workflows/pr-automerge.yml`;
const rootWorkflow = ".github/workflows/pr-automerge.yml";

const pick = (number: number, files: string[]): FilePick => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  labels: ["Sandcastle"],
  comments: [],
  files,
});

// A GitHub stub: `prs` maps each open PR into main to the paths it changes. Every call is logged in `calls`.
const github = (prs: Record<number, string[]> = {}) => {
  const calls: string[] = [];
  const stub: OverlapGitHub = {
    openPullRequestsIntoMain: () => Object.keys(prs).map((number): OpenPullRequest => ({ number: Number(number), headRefName: `someone/pr-${number}` })),
    pullRequestFiles: (pr) => {
      calls.push(`files ${pr}`);
      return prs[pr] ?? [];
    },
    comment: () => {},
  };
  return { stub, calls };
};

// The root-copy mapping lib/overlap.mts applies is dotfiles': a repo with no root copies maps nothing.
describe("pathKey", () => {
  it("maps a Template Owned file to its dotfiles root copy", () => {
    assert.equal(pathKey(ownedWorkflow), rootWorkflow);
  });

  it("leaves the root copy as it is", () => {
    assert.equal(pathKey(rootWorkflow), rootWorkflow);
  });

  it("leaves an Owned file with no root copy alone: template/owned/scripts/gate.sh is not dotfiles' scripts/gate.sh", () => {
    assert.equal(pathKey(`${TEMPLATE_OWNED_DIR}/scripts/gate.sh`), `${TEMPLATE_OWNED_DIR}/scripts/gate.sh`);
    assert.notEqual(pathKey(`${TEMPLATE_OWNED_DIR}/scripts/gate.sh`), pathKey("scripts/gate.sh"));
  });

  // The Template's Sandcastle Owned files are copied into dotfiles' own .sandcastle/, so a change to either is one path.
  it("maps a Template Owned Sandcastle file to dotfiles' own .sandcastle/ copy", () => {
    assert.equal(pathKey(`${TEMPLATE_OWNED_DIR}/.sandcastle/tsconfig.json`), ".sandcastle/tsconfig.json");
  });

  it("maps a Template Owned Sandcastle module to dotfiles' own copy", () => {
    assert.equal(pathKey(`${TEMPLATE_OWNED_DIR}/.sandcastle/lib/build.mts`), ".sandcastle/lib/build.mts");
  });
});

describe("findOverlaps with the Template and root copies", () => {
  it("counts a Template Owned file and its root copy as one path between two picks", () => {
    const held = findOverlaps([pick(1, [ownedWorkflow]), pick(2, [rootWorkflow])], []);

    assert.deepEqual(held.get(2), { kind: "pick", blocker: 1, path: rootWorkflow });
  });

  it("counts a Template Owned file and its root copy as one path between a pick and an open PR", () => {
    const held = findOverlaps([pick(1, [ownedWorkflow])], [{ number: 9, files: [rootWorkflow] }]);

    assert.deepEqual(held.get(1), { kind: "pr", blocker: 9, path: ownedWorkflow });
  });

  it("doesn't count template/owned/scripts/gate.sh and dotfiles' scripts/gate.sh as one path", () => {
    const held = findOverlaps([pick(1, [`${TEMPLATE_OWNED_DIR}/scripts/gate.sh`]), pick(2, ["scripts/gate.sh"])], []);

    assert.equal(held.size, 0);
  });
});

describe("holdOverlappingPicks with the Template and root copies", () => {
  it("reads the PRs' files, not the picks', with the Template and root copies as one path", () => {
    const gh = github({ 9: [rootWorkflow] });

    const { held } = holdOverlappingPicks([pick(1, [ownedWorkflow])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(held.map((p) => p.number), [1]);
    assert.ok(gh.calls.includes("files 9"));
  });
});

// mpaulosky/dotfiles#339 (R43, R44): the gh-repo check reads the repo's skills and agents, so a change to them reruns the CI and shows
// in a PR's list of changed check files.
describe("the places the gate's checks are read from (mpaulosky/dotfiles#339)", () => {
  const seedConfig = readFileSync(new URL("lib/repo-config.mts", seedFolder), "utf8");
  const stepEight = (): string => {
    const reference = readFileSync(new URL(`${skill}/references/sandcastle.md`, root), "utf8");
    const start = reference.indexOf("\n8. Set `GATE_SCRIPT`");
    assert.notEqual(start, -1, "references/sandcastle.md has no step 8 that sets GATE_SCRIPT");
    return reference.slice(start + 1, reference.indexOf("\n\n", start));
  };

  it("lists .claude/skills/ in dotfiles' own CHECK_PATHS, beside the Template's folders", () => {
    assert.ok(CHECK_PATHS.includes(".claude/skills/"), "CHECK_PATHS lacks the root .claude/skills/");
  });

  it("reruns the Template CI on a push that changes .claude/skills/ or .claude/agents/", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/repo-ci-baseline.yml", import.meta.url), "utf8");
    const pushPaths = /^ {2}push:\n(?:.*\n)*? {4}paths:\n((?: {6}- .*\n)+)/m.exec(workflow)?.[1] ?? "";

    assert.notEqual(pushPaths, "", "repo-ci-baseline.yml has no push paths filter");
    assert.match(pushPaths, /^ {6}- "\.claude\/skills\/\*\*"$/m);
    assert.match(pushPaths, /^ {6}- "\.claude\/agents\/\*\*"$/m);
  });

  it("lists the checker and .claude/skills/ in the Seed lib/repo-config.mts CHECK_PATHS", () => {
    const declaration = /export const CHECK_PATHS[^=]*=\s*\[([^\]]*)\]/.exec(seedConfig)?.[1] ?? "";
    const listed = [...declaration.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    assert.notEqual(declaration, "", "the Seed has no CHECK_PATHS list");
    assert.ok(listed.includes(".github/scripts/check_gh_repo.py"), `the Seed CHECK_PATHS ${JSON.stringify(listed)} lacks the checker`);
    assert.ok(listed.includes(".claude/skills/"), `the Seed CHECK_PATHS ${JSON.stringify(listed)} lacks .claude/skills/`);
  });

  it("names the checker and .claude/skills/ in references/sandcastle.md's step 8", () => {
    const step = stepEight();

    assert.match(step, /check_gh_repo\.py/);
    assert.match(step, /\.claude\/skills\//);
  });
});
