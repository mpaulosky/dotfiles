import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OVERLAP_MARKER } from "./config.mts";
import type { OpenPullRequest } from "./github.mts";
import {
  critiqueUnpicked,
  findOverlaps,
  holdOverlappingPicks,
  lastingHolds,
  overlapComment,
  pathKey,
  type FilePick,
  type Overlap,
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

  it("counts a directory entry as overlapping every path under it, either way round", () => {
    assert.equal(findOverlaps([pick(1, ["lib/"]), pick(2, ["lib/a.mts"])], []).get(2)?.kind, "pick");
    assert.equal(findOverlaps([pick(1, ["lib/a.mts"]), pick(2, ["lib/"])], []).get(2)?.kind, "pick");
    assert.equal(findOverlaps([pick(1, ["lib/"])], [{ number: 9, files: ["lib/a.mts"] }]).get(1)?.kind, "pr");
  });

  it("doesn't count a directory entry as overlapping a sibling that shares its prefix", () => {
    assert.equal(findOverlaps([pick(1, ["lib/"]), pick(2, ["library.mts"])], []).size, 0);
  });
});

// Picks that name no files block no one but a pick that can be built.
describe("findOverlaps with several picks that name no files", () => {
  it("never makes two picks with no files wait on each other: the first is kept and the second waits behind it", () => {
    const held = findOverlaps([pick(1, []), pick(2, [])], []);

    assert.deepEqual([...held], [[2, { kind: "no files", waitsOn: { kind: "pick", number: 1 } }]]);
  });

  it("keeps the first of three picks with no files, and the other two wait behind it", () => {
    const held = findOverlaps([pick(1, []), pick(2, []), pick(3, [])], []);

    assert.deepEqual([...held.keys()], [2, 3]);
    assert.deepEqual(held.get(2), { kind: "no files", waitsOn: { kind: "pick", number: 1 } });
    assert.deepEqual(held.get(3), { kind: "no files", waitsOn: { kind: "pick", number: 1 } });
  });

  it("holds every pick with no files while a PR into main is open, all waiting on the PR", () => {
    const held = findOverlaps([pick(1, []), pick(2, [])], [{ number: 9, files: ["x"] }]);

    assert.deepEqual(held.get(1), { kind: "no files", waitsOn: { kind: "pr", number: 9 } });
    assert.deepEqual(held.get(2), { kind: "no files", waitsOn: { kind: "pr", number: 9 } });
  });

  it("holds each pick with no files behind a kept pick that names files", () => {
    const held = findOverlaps([pick(1, ["x"]), pick(2, []), pick(3, [])], []);

    assert.deepEqual([...held.keys()], [2, 3]);
    assert.deepEqual(held.get(2), { kind: "no files", waitsOn: { kind: "pick", number: 1 } });
    assert.deepEqual(held.get(3), { kind: "no files", waitsOn: { kind: "pick", number: 1 } });
  });

  it("holds both picks with no files behind a pick that names files, even when it comes last", () => {
    const held = findOverlaps([pick(1, []), pick(2, []), pick(3, ["x"])], []);

    assert.deepEqual([...held.keys()], [1, 2]);
    assert.deepEqual(held.get(1), { kind: "no files", waitsOn: { kind: "pick", number: 3 } });
    assert.equal(held.get(2)?.kind, "no files");
  });

  it("doesn't wait on a pick that is itself held: a pick with files held by a PR leaves the PR as what the pick with no files waits on", () => {
    const held = findOverlaps([pick(1, []), pick(2, ["x"])], [{ number: 9, files: ["x"] }]);

    assert.deepEqual(held.get(1), { kind: "no files", waitsOn: { kind: "pr", number: 9 } });
    assert.deepEqual(held.get(2), { kind: "pr", blocker: 9, path: "x" });
  });
});

// A folder named without a trailing slash covers the paths under it too.
describe("findOverlaps with folders", () => {
  it("counts a folder as overlapping every path under it, either way round, whether or not it ends in a slash", () => {
    assert.equal(findOverlaps([pick(1, ["lib"]), pick(2, ["lib/a.mts"])], []).get(2)?.kind, "pick");
    assert.equal(findOverlaps([pick(1, ["lib/a.mts"]), pick(2, ["lib"])], []).get(2)?.kind, "pick");
    assert.equal(findOverlaps([pick(1, ["lib/deep"])], [{ number: 9, files: ["lib/deep/a/b.mts"] }]).get(1)?.kind, "pr");
    assert.equal(findOverlaps([pick(1, ["lib/deep/a/b.mts"])], [{ number: 9, files: ["lib/deep"] }]).get(1)?.kind, "pr");
  });

  it("doesn't count a folder as overlapping a path that only shares its prefix", () => {
    assert.equal(findOverlaps([pick(1, ["lib"]), pick(2, ["library.mts"])], []).size, 0);
    assert.equal(findOverlaps([pick(1, ["lib"]), pick(2, ["lib2/a.mts"])], []).size, 0);
  });
});

// A hold lasts the run only behind an open PR or a pick that opened one.
describe("lastingHolds", () => {
  const overlaps = new Map<number, Overlap>([
    [2, { kind: "pick", blocker: 1, path: "x" }],
    [3, { kind: "pr", blocker: 9, path: "x" }],
    [4, { kind: "no files", waitsOn: { kind: "pick", number: 1 } }],
    [5, { kind: "no files", waitsOn: { kind: "pr", number: 9 } }],
    [6, { kind: "pick", blocker: 7, path: "y" }],
  ]);
  const sorted = (numbers: number[]) => [...numbers].sort((a, b) => a - b);

  it("keeps the holds behind a pick that opened a PR, and the holds behind an open PR", () => {
    assert.deepEqual(sorted(lastingHolds(overlaps, new Set([1]))), [2, 3, 4, 5]);
  });

  it("releases the holds behind a pick that was deferred by the critique or opened no PR, and keeps only the holds behind an open PR", () => {
    assert.deepEqual(sorted(lastingHolds(overlaps, new Set())), [3, 5]);
  });

  it("releases a hold behind a pick that isn't among those that opened a PR, whichever other pick did", () => {
    assert.deepEqual(sorted(lastingHolds(overlaps, new Set([7]))), [3, 5, 6]);
  });

  it("holds nothing when nothing was held", () => {
    assert.deepEqual(lastingHolds(new Map(), new Set([1])), []);
  });
});

// The critique's dependency check is the safety net for a dependency the planner missed, so a pick held back
// for a file is still one of the open ready issues it has to see, marked as held.
describe("critiqueUnpicked", () => {
  const issue = (number: number) => pick(number, []);
  const noteOf = (unpicked: ReturnType<typeof critiqueUnpicked>, number: number) => {
    const found = unpicked.find((i) => i.number === number);
    assert.ok(found, `#${number} isn't among the unpicked issues`);
    return found.heldNote;
  };

  it("passes on every ready issue that was not kept, the issues held back for a file included", () => {
    const ready = [1, 2, 3, 4, 5].map(issue);

    const unpicked = critiqueUnpicked(ready, [{ number: 1 }], new Set([2, 4]));

    assert.deepEqual(unpicked.map((i) => i.number), [2, 3, 4, 5]);
  });

  it("marks each held issue with a note that says it is held", () => {
    const unpicked = critiqueUnpicked([1, 2, 3, 4].map(issue), [{ number: 1 }], new Set([2, 4]));

    for (const number of [2, 4]) {
      const note = noteOf(unpicked, number);
      assert.ok(typeof note === "string", `#${number} has no heldNote`);
      assert.match(note, /held/i);
    }
  });

  it("gives no note to an issue that is not held", () => {
    const unpicked = critiqueUnpicked([1, 2, 3].map(issue), [{ number: 1 }], new Set([2]));

    assert.equal(noteOf(unpicked, 3), undefined);
  });

  it("passes on every ready issue that was not kept, with no note, when none is held back", () => {
    const unpicked = critiqueUnpicked([1, 2, 3].map(issue), [{ number: 2 }], new Set());

    assert.deepEqual(unpicked.map((i) => i.number), [1, 3]);
    assert.deepEqual(unpicked.map((i) => i.heldNote), [undefined, undefined]);
  });

  it("leaves a kept pick out even when it is also in the held set", () => {
    const unpicked = critiqueUnpicked([1, 2].map(issue), [{ number: 1 }], new Set([1, 2]));

    assert.deepEqual(unpicked.map((i) => i.number), [2]);
  });

  it("keeps the held issue's own fields, so the critique can read its title and body", () => {
    const [held] = critiqueUnpicked([issue(2)], [], new Set([2]));

    assert.equal(held!.title, "Issue 2");
    assert.equal(held!.body, "Body of 2");
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

describe("overlapComment's marker", () => {
  it("carries the overlap marker, whatever the overlap", () => {
    const overlaps: Overlap[] = [
      { kind: "pick", blocker: 7, path: "lib/build.mts" },
      { kind: "pr", blocker: 9, path: "lib/build.mts" },
      { kind: "no files", waitsOn: { kind: "pick", number: 7 } },
      { kind: "no files", waitsOn: { kind: "pr", number: 9 } },
    ];

    for (const overlap of overlaps) {
      assert.ok(overlapComment(overlap).includes(OVERLAP_MARKER), JSON.stringify(overlap));
    }
  });

  it("doesn't let a path forge the marker", () => {
    const body = overlapComment({ kind: "pr", blocker: 9, path: `${OVERLAP_MARKER}.md` });

    assert.equal(body.split(OVERLAP_MARKER).length - 1, 1);
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

  it("reads nothing when there are no picks", () => {
    const gh = github({ 9: ["x"] });

    const result = holdOverlappingPicks([], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(result, { kept: [], held: [], overlaps: new Map() });
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

describe("holdOverlappingPicks with several picks that name no files", () => {
  it("builds the first pick with no files and holds the rest, commenting only on the held ones", () => {
    const gh = github();

    const { kept, held } = holdOverlappingPicks([pick(1, []), pick(2, []), pick(3, [])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(kept.map((p) => p.number), [1]);
    assert.deepEqual(held.map((p) => p.number), [2, 3]);
    assert.deepEqual(gh.comments.map(([issue]) => issue), [2, 3]);
  });

  it("returns why each pick was held, by issue number", () => {
    const gh = github({ 9: ["lib/build.mts"] });

    const { overlaps } = holdOverlappingPicks([pick(1, ["lib/build.mts"]), pick(2, ["lib/a.mts"])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual([...overlaps], [[1, { kind: "pr", blocker: 9, path: "lib/build.mts" }]]);
  });
});

// A pick behind an open PR is held every run until the PR closes, so its comment must not be posted every run.
describe("holdOverlappingPicks's comment once", () => {
  it("doesn't post another comment when the issue carries one with the overlap marker, though the earlier run named another path", () => {
    const gh = github({ 9: ["lib/build.mts"] });
    const earlier = overlapComment({ kind: "pr", blocker: 9, path: "lib/other.mts" });

    const { held } = holdOverlappingPicks([pick(1, ["lib/build.mts"], ["an unrelated comment", earlier])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(held.map((p) => p.number), [1]);
    assert.deepEqual(gh.comments, []);
  });

  it("still reports the pick as deferred when it doesn't comment again", () => {
    const gh = github({ 9: ["lib/build.mts"] });
    const report = new OutcomeReport();
    const earlier = overlapComment({ kind: "pr", blocker: 9, path: "lib/other.mts" });

    holdOverlappingPicks([pick(1, ["lib/build.mts"], [earlier])], gh.stub, () => {}, report);

    assert.deepEqual(report.items().map((item) => [item.number, item.outcome]), [[1, "deferred"]]);
  });

  it("comments again when the newest overlap comment names another blocker", () => {
    const gh = github({ 30: ["lib/b.mts"] });
    const earlier = overlapComment({ kind: "pr", blocker: 9, path: "lib/a.mts" });

    holdOverlappingPicks([pick(1, ["lib/b.mts"], [earlier])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(gh.comments.map(([issue]) => issue), [1]);
    assert.ok(gh.comments[0]![1].includes("pull request #30"));
  });

  it("comments again when an older comment named this blocker but the newest names another", () => {
    const gh = github({ 9: ["lib/a.mts"] });
    const first = overlapComment({ kind: "pr", blocker: 9, path: "lib/a.mts" });
    const second = overlapComment({ kind: "pr", blocker: 30, path: "lib/b.mts" });

    holdOverlappingPicks([pick(1, ["lib/a.mts"], [first, second])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(gh.comments.map(([issue]) => issue), [1]);
  });

  it("comments again when a pick that named files now names none", () => {
    const gh = github({ 9: ["lib/a.mts"] });
    const earlier = overlapComment({ kind: "pr", blocker: 9, path: "lib/a.mts" });

    holdOverlappingPicks([pick(1, [], [earlier])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(gh.comments.map(([issue]) => issue), [1]);
  });

  it("comments on a held pick whose comments carry no overlap marker", () => {
    const gh = github({ 9: ["lib/build.mts"] });

    holdOverlappingPicks([pick(1, ["lib/build.mts"], ["Sandcastle's plan critique deferred this issue behind #4"])], gh.stub, () => {}, new OutcomeReport());

    assert.deepEqual(gh.comments.map(([issue]) => issue), [1]);
  });
});

// A line starting with "::" in a log is a workflow command in Actions.
describe("holdOverlappingPicks's log", () => {
  it("writes a path with a line break on one line, so no log line starts a workflow command", () => {
    const gh = github({ 9: ["x\n::error::pwned"] });
    const { lines, log } = capture();

    holdOverlappingPicks([pick(1, ["x\n::error::pwned"])], gh.stub, log, new OutcomeReport());

    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.doesNotMatch(line, /[\x00-\x08\x0a-\x1f\x7f]/);
      assert.doesNotMatch(line, /^\s*::/);
    }
  });
});

