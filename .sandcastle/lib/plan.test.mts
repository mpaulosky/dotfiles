import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPTIONAL_ROLES } from "./config.mts";
import { readyPicks, resolveFiles, resolveRoles } from "./plan.mts";

describe("readyPicks", () => {
  const ready = [{ number: 4 }, { number: 5 }];

  it("keeps each ready pick once, in the planner's order", () => {
    const picks = readyPicks(
      [
        { id: "5", title: "B" },
        { id: "4", title: "A" },
        { id: "5", title: "B again" },
      ],
      ready,
      () => {},
    );

    assert.deepEqual(picks.map((pick) => pick.id), ["5", "4"]);
  });

  it("drops a pick that didn't pass the blocker gate, and says so", () => {
    const lines: string[] = [];

    const picks = readyPicks([{ id: "6", title: "C" }, { id: "4", title: "A" }], ready, (line) => lines.push(line));

    assert.deepEqual(picks.map((pick) => pick.id), ["4"]);
    assert.match(lines.join("\n"), /#6/);
  });

  it("keeps a pick's roles field unchanged", () => {
    const picks = readyPicks([{ id: "4", title: "A", roles: ["scribe"] }], ready, () => {});

    assert.deepEqual(picks[0]?.roles, ["scribe"]);
  });

  it("keeps a pick's files field unchanged", () => {
    const picks = readyPicks([{ id: "4", title: "A", files: ["lib/a.mts"] }], ready, () => {});

    assert.deepEqual(picks[0]?.files, ["lib/a.mts"]);
  });
});

// Covers "A plan with a missing or invalid roles field runs every role for
// that issue" from issue #72: resolveRoles is what main.mts asks for that
// fallback, since the plan schema itself can't reject an invalid field
// without aborting the whole plan (see plan.mts).
describe("resolveRoles", () => {
  it("runs every optional role when the field is missing", () => {
    assert.deepEqual(resolveRoles(undefined), [...OPTIONAL_ROLES]);
  });

  it("runs every optional role when the field isn't an array", () => {
    assert.deepEqual(resolveRoles("architect"), [...OPTIONAL_ROLES]);
    assert.deepEqual(resolveRoles(null), [...OPTIONAL_ROLES]);
    assert.deepEqual(resolveRoles({ architect: true }), [...OPTIONAL_ROLES]);
  });

  it("runs every optional role when the array names something resolveRoles doesn't recognise", () => {
    assert.deepEqual(resolveRoles(["architect", "backend"]), [...OPTIONAL_ROLES]);
    assert.deepEqual(resolveRoles(["frontend"]), [...OPTIONAL_ROLES]);
  });

  it("keeps only the roles the planner picked, in build order", () => {
    assert.deepEqual(resolveRoles(["scribe"]), ["scribe"]);
    assert.deepEqual(resolveRoles(["scribe", "architect"]), ["architect", "scribe"]);
  });

  it("deliberately picking none is valid: an empty array runs no optional role", () => {
    assert.deepEqual(resolveRoles([]), []);
  });

  it("drops a repeated role rather than running it twice", () => {
    assert.deepEqual(resolveRoles(["scribe", "scribe"]), ["scribe"]);
  });
});

// Issue #248: resolveFiles is what main.mts asks for each pick's files. The
// plan schema leaves the field unknown so a bad value means "no files" (the
// pick is held back unless it's alone) rather than aborting the whole plan.
describe("resolveFiles", () => {
  it("is empty when the field is missing", () => {
    assert.deepEqual(resolveFiles(undefined), []);
  });

  it("is empty when the field isn't an array", () => {
    assert.deepEqual(resolveFiles("lib/a.mts"), []);
    assert.deepEqual(resolveFiles(null), []);
    assert.deepEqual(resolveFiles({ "lib/a.mts": true }), []);
  });

  it("is empty when any entry isn't a string", () => {
    assert.deepEqual(resolveFiles(["lib/a.mts", 4]), []);
    assert.deepEqual(resolveFiles([null]), []);
  });

  it("is empty when any entry holds a glob, which can't be compared", () => {
    assert.deepEqual(resolveFiles(["lib/a.mts", "lib/*.mts"]), []);
    assert.deepEqual(resolveFiles(["lib/?.mts"]), []);
  });

  it("keeps the paths as named, in order", () => {
    assert.deepEqual(resolveFiles(["lib/b.mts", "lib/a.mts"]), ["lib/b.mts", "lib/a.mts"]);
  });

  it("trims entries, turns backslashes into slashes and strips leading ./ and /", () => {
    assert.deepEqual(resolveFiles(["  lib/a.mts  ", "lib\\b.mts", "./lib/c.mts", "/lib/d.mts", "././/lib/e.mts"]), [
      "lib/a.mts",
      "lib/b.mts",
      "lib/c.mts",
      "lib/d.mts",
      "lib/e.mts",
    ]);
  });

  it("drops empty entries and repeats, keeping the first", () => {
    assert.deepEqual(resolveFiles(["lib/a.mts", "", "  ", "./", "lib/b.mts", "./lib/a.mts"]), ["lib/a.mts", "lib/b.mts"]);
  });

  it("keeps a trailing slash, which marks a directory", () => {
    assert.deepEqual(resolveFiles(["lib/new/"]), ["lib/new/"]);
  });

  it("deliberately naming none is an empty list", () => {
    assert.deepEqual(resolveFiles([]), []);
  });
});
