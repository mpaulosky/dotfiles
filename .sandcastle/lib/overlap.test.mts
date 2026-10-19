import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TEMPLATE_OWNED_DIR } from "./config.mts";
import type { OpenPullRequest } from "./github.mts";
import {
  findOverlaps,
  holdOverlappingPicks,
  overlapComment,
  pathKey,
  type FilePick,
  type OverlapGitHub,
} from "./overlap.mts";
import { OutcomeReport } from "./report.mts";

const pick = (number: number, files: string[], comments: string[] = []): FilePick => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  labels: ["Sandcastle"],
  comments,
  files,
});

const ownedWorkflow = `${TEMPLATE_OWNED_DIR}/.github/workflows/pr-automerge.yml`;
const rootWorkflow = ".github/workflows/pr-automerge.yml";

// A GitHub stub: `prs` maps each open PR into main to the paths it changes.
// Writes are recorded instead of sent, and every call is logged in `calls`.
const github = (prs: Record<number, string[]> = {}, overrides: Partial<OverlapGitHub> = {}) => {
  const comments: [number, string][] = [];
  const calls: string[] = [];
  const stub: OverlapGitHub = {
    openPullRequestsIntoMain: () => {
      calls.push("list");
      return Object.keys(prs).map((number): OpenPullRequest => ({ number: Number(number), headRefName: `someone/pr-${number}` }));
    },
    pullRequestFiles: (pr) => {
      calls.push(`files ${pr}`);
      return prs[pr] ?? [];
    },
    comment: (issue, body) => {
      comments.push([issue, body]);
    },
    ...overrides,
  };
  return { stub, comments, calls };
};

const capture = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
};

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

  it("leaves any other path alone", () => {
    assert.equal(pathKey(".sandcastle/lib/build.mts"), ".sandcastle/lib/build.mts");
  });
});

describe("findOverlaps", () => {
  // AC: two picks naming the same file: only the first is built.
  it("holds the later of two picks that name the same file, behind the earlier", () => {
    const held = findOverlaps([pick(1, ["lib/build.mts"]), pick(2, ["lib/build.mts"])], []);

    assert.deepEqual([...held], [[2, { kind: "pick", blocker: 1, path: "lib/build.mts" }]]);
  });

  // AC: disjoint picks: both built.
  it("holds nothing when the picks name different files", () => {
    assert.equal(findOverlaps([pick(1, ["lib/a.mts"]), pick(2, ["lib/b.mts"])], []).size, 0);
  });

  // AC: a pick naming a file an open non-Sandcastle PR changes: deferred.
  it("holds a pick whose file an open PR changes, behind that PR", () => {
    const held = findOverlaps([pick(1, ["lib/a.mts", "lib/build.mts"])], [{ number: 9, files: ["lib/build.mts"] }]);

    assert.deepEqual([...held], [[1, { kind: "pr", blocker: 9, path: "lib/build.mts" }]]);
  });

  it("waits on the lowest-numbered PR that changes the file", () => {
    const held = findOverlaps(
      [pick(1, ["x"])],
      [{ number: 12, files: ["x"] }, { number: 9, files: ["x"] }],
    );

    assert.deepEqual(held.get(1), { kind: "pr", blocker: 9, path: "x" });
  });

  it("holds a later pick behind the PR too when an earlier pick for the same file is itself held, since a held pick claims nothing", () => {
    const held = findOverlaps([pick(1, ["x"]), pick(2, ["x"])], [{ number: 9, files: ["x"] }]);

    assert.deepEqual(held.get(1), { kind: "pr", blocker: 9, path: "x" });
    assert.deepEqual(held.get(2), { kind: "pr", blocker: 9, path: "x" });
  });

  it("names the first of the pick's own paths that overlaps", () => {
    const held = findOverlaps([pick(1, ["safe.mts", "second.mts", "first.mts"])], [{ number: 9, files: ["first.mts", "second.mts"] }]);

    assert.deepEqual(held.get(1), { kind: "pr", blocker: 9, path: "second.mts" });
  });

  // AC: a pick with no files alongside another pick: deferred.
  it("holds a pick with no files when there is another pick, whatever the order", () => {
    const first = findOverlaps([pick(1, []), pick(2, ["x"])], []);
    const second = findOverlaps([pick(1, ["x"]), pick(2, [])], []);

    assert.deepEqual([...first.keys()], [1]);
    assert.deepEqual(first.get(1), { kind: "no files", waitsOn: { kind: "pick", number: 2 } });
    assert.deepEqual(second.get(2), { kind: "no files", waitsOn: { kind: "pick", number: 1 } });
    assert.equal(second.size, 1);
  });

  // AC: a pick with no files is built only when it's the round's only pick and no open PR exists.
  it("keeps a lone pick with no files when no PR is open", () => {
    assert.equal(findOverlaps([pick(1, [])], []).size, 0);
  });

  it("holds a lone pick with no files while any PR into main is open, waiting on the lowest-numbered one", () => {
    const held = findOverlaps([pick(1, [])], [{ number: 12, files: [] }, { number: 9, files: ["x"] }]);

    assert.deepEqual(held.get(1), { kind: "no files", waitsOn: { kind: "pr", number: 9 } });
  });

  it("a held pick claims no path: a pick behind it is kept", () => {
    const held = findOverlaps([pick(1, ["x"]), pick(2, ["x", "y"]), pick(3, ["y"])], []);

    assert.deepEqual([...held.keys()], [2]);
  });

  it("a held no-files pick claims no path, so the other pick is built", () => {
    const held = findOverlaps([pick(1, []), pick(2, ["x"])], []);

    assert.equal(held.has(2), false);
  });

  // AC: a Template Owned file and its dotfiles root copy count as the same path.
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

  it("counts a directory entry as overlapping every path under it, either way round", () => {
    assert.equal(findOverlaps([pick(1, ["lib/"]), pick(2, ["lib/a.mts"])], []).get(2)?.kind, "pick");
    assert.equal(findOverlaps([pick(1, ["lib/a.mts"]), pick(2, ["lib/"])], []).get(2)?.kind, "pick");
    assert.equal(findOverlaps([pick(1, ["lib/"])], [{ number: 9, files: ["lib/a.mts"] }]).get(1)?.kind, "pr");
  });

  it("doesn't count a directory entry as overlapping a sibling that shares its prefix", () => {
    assert.equal(findOverlaps([pick(1, ["lib/"]), pick(2, ["library.mts"])], []).size, 0);
  });
});

describe("overlapComment", () => {
  it("names the file and the pick the held issue waits on", () => {
    const body = overlapComment({ kind: "pick", blocker: 7, path: "lib/build.mts" });

    assert.match(body, /lib\/build\.mts/);
    assert.match(body, /#7/);
  });

  it("names the file and the pull request the held issue waits on", () => {
    const body = overlapComment({ kind: "pr", blocker: 9, path: "lib/build.mts" });

    assert.match(body, /lib\/build\.mts/);
    assert.match(body, /pull request #9/);
  });

  it("says the planner named no files, and what the issue waits on", () => {
    assert.match(overlapComment({ kind: "no files", waitsOn: { kind: "pick", number: 7 } }), /didn't name the files[\s\S]*#7/);
    assert.match(overlapComment({ kind: "no files", waitsOn: { kind: "pr", number: 9 } }), /pull request #9/);
  });

  it("breaks mentions and cross-references in a path", () => {
    const body = overlapComment({ kind: "pick", blocker: 7, path: "docs/@someone/#12.md" });

    assert.doesNotMatch(body, /(^|[^\w])@someone\b/);
    assert.doesNotMatch(body, /(^|[^\w&])#12\b/);
  });

  it("withholds a path that looks like it holds a secret", () => {
    const body = overlapComment({ kind: "pr", blocker: 9, path: `ghp_${"a".repeat(36)}.txt` });

    assert.doesNotMatch(body, /ghp_/);
  });
});

describe("holdOverlappingPicks", () => {
  // AC: two picks naming the same file: only the first is built.
  it("builds only the first of two picks that name the same file, and says why on the held one", () => {
    const gh = github();
    const report = new OutcomeReport();
    const { lines, log } = capture();

    const { kept, held } = holdOverlappingPicks([pick(1, ["lib/build.mts"]), pick(2, ["lib/build.mts"])], gh.stub, log, report);

    assert.deepEqual(kept.map((p) => p.number), [1]);
    assert.deepEqual(held.map((p) => p.number), [2]);
    assert.equal(gh.comments.length, 1);
    const [issue, body] = gh.comments[0]!;
    assert.equal(issue, 2);
    assert.match(body, /lib\/build\.mts/);
    assert.match(body, /#1/);
    assert.deepEqual(report.items(), [{ kind: "issue", number: 2, outcome: "deferred", detail: "behind #1" }]);
    assert.match(lines.join("\n"), /#2[\s\S]*#1[\s\S]*lib\/build\.mts/);
  });

  // AC: a pick naming a file an open non-Sandcastle PR changes: deferred.
  it("holds a pick that names a file an open PR from someone else changes", () => {
    const gh = github({ 9: ["lib/build.mts"] });
    const report = new OutcomeReport();

    const { kept, held } = holdOverlappingPicks([pick(1, ["lib/build.mts"])], gh.stub, () => {}, report);

    assert.deepEqual(kept, []);
    assert.deepEqual(held.map((p) => p.number), [1]);
    const [issue, body] = gh.comments[0]!;
    assert.equal(issue, 1);
    assert.match(body, /lib\/build\.mts/);
    assert.match(body, /pull request #9/);
    assert.deepEqual(report.items(), [{ kind: "issue", number: 1, outcome: "deferred", detail: "behind PR #9" }]);
  });

  // AC: a pick with no files alongside another pick: deferred.
  it("holds a pick with no files alongside another pick, and builds the other", () => {
    const gh = github();
    const report = new OutcomeReport();

    const { kept, held } = holdOverlappingPicks([pick(1, []), pick(2, ["x"])], gh.stub, () => {}, report);

    assert.deepEqual(kept.map((p) => p.number), [2]);
    assert.deepEqual(held.map((p) => p.number), [1]);
    assert.match(gh.comments[0]![1], /didn't name the files/);
    assert.deepEqual(report.items(), [{ kind: "issue", number: 1, outcome: "deferred", detail: "names no files" }]);
  });

  // AC: a pick with no files is built only when it's the round's only pick and no open PR exists.
  it("builds a lone pick with no files when no PR into main is open", () => {
    const gh = github();

    const { kept, held } = holdOverlappingPicks([pick(1, [])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(kept.map((p) => p.number), [1]);
    assert.deepEqual(held, []);
  });

  it("holds a lone pick with no files while a PR into main is open", () => {
    const gh = github({ 9: ["x"] });

    const { kept, held } = holdOverlappingPicks([pick(1, [])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(kept, []);
    assert.deepEqual(held.map((p) => p.number), [1]);
    assert.match(gh.comments[0]![1], /pull request #9/);
  });

  // AC: disjoint picks: both built.
  it("builds both of two picks that name different files, with no comment and no report entry", () => {
    const gh = github({ 9: ["elsewhere.mts"] });
    const report = new OutcomeReport();

    const { kept, held } = holdOverlappingPicks([pick(1, ["a.mts"]), pick(2, ["b.mts"])], gh.stub, () => {}, report);

    assert.deepEqual(kept.map((p) => p.number), [1, 2]);
    assert.deepEqual(held, []);
    assert.deepEqual(gh.comments, []);
    assert.deepEqual(report.items(), []);
  });

  it("keeps each pick's other fields, such as its roles", () => {
    const gh = github();
    const withRoles = { ...pick(1, ["a.mts"]), roles: ["scribe"] };

    const { kept } = holdOverlappingPicks([withRoles], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(kept[0]?.roles, ["scribe"]);
  });

  it("reads the PRs' files, not the picks', with the Template and root copies as one path", () => {
    const gh = github({ 9: [rootWorkflow] });

    const { held } = holdOverlappingPicks([pick(1, [ownedWorkflow])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(held.map((p) => p.number), [1]);
    assert.ok(gh.calls.includes("files 9"));
  });

  it("reads nothing when there are no picks", () => {
    const gh = github({ 9: ["x"] });

    const result = holdOverlappingPicks([], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(result, { kept: [], held: [] });
    assert.deepEqual(gh.calls, []);
  });

  it("doesn't post a comment the issue already carries", () => {
    const gh = github({ 9: ["lib/build.mts"] });
    const body = overlapComment({ kind: "pr", blocker: 9, path: "lib/build.mts" });
    const report = new OutcomeReport();

    const { held } = holdOverlappingPicks([pick(1, ["lib/build.mts"], [`${body}\n`])], gh.stub, () => {}, report);

    assert.deepEqual(held.map((p) => p.number), [1]);
    assert.deepEqual(gh.comments, []);
    assert.equal(report.items().length, 1);
  });

  it("logs a comment that fails and still holds the pick", () => {
    const gh = github({ 9: ["x"] }, {
      comment: () => {
        throw new Error("rate limited");
      },
    });
    const { lines, log } = capture();

    const { kept, held } = holdOverlappingPicks([pick(1, ["x"])], gh.stub, log, new OutcomeReport());

    assert.deepEqual(kept, []);
    assert.deepEqual(held.map((p) => p.number), [1]);
    assert.match(lines.join("\n"), /#1 is held back, but the comment explaining why couldn't be posted[\s\S]*rate limited/);
  });

  it("throws when the open PRs can't be read, and comments nothing", () => {
    const gh = github({}, {
      openPullRequestsIntoMain: () => {
        throw new Error("gh failed");
      },
    });

    assert.throws(() => holdOverlappingPicks([pick(1, ["x"]), pick(2, ["x"])], gh.stub, () => {}, new OutcomeReport()), /gh failed/);
    assert.deepEqual(gh.comments, []);
  });

  it("throws when a PR's files can't be read, and comments nothing", () => {
    const gh = github({ 9: ["x"] }, {
      pullRequestFiles: () => {
        throw new Error("no such PR");
      },
    });

    assert.throws(() => holdOverlappingPicks([pick(1, ["x"]), pick(2, ["x"])], gh.stub, () => {}, new OutcomeReport()), /no such PR/);
    assert.deepEqual(gh.comments, []);
  });

  it("keeps the planner's order in both lists", () => {
    const gh = github();

    const { kept, held } = holdOverlappingPicks(
      [pick(5, ["a"]), pick(3, ["a"]), pick(4, ["b"]), pick(2, ["b"])],
      gh.stub,
      () => {},
      new OutcomeReport(),
    );

    assert.deepEqual(kept.map((p) => p.number), [5, 4]);
    assert.deepEqual(held.map((p) => p.number), [3, 2]);
  });
});
