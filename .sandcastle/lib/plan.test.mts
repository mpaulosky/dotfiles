import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPTIONAL_ROLES } from "./config.mts";
import { uiEnabled } from "./agents.mts";
import { ROLE_AGENTS } from "./repo-config.mts";
import { readyPicks, resolveFiles, resolveRoles } from "./plan.mts";

// Runs `run` with the repo's `ui` role opted in or out of ROLE_AGENTS, whatever
// lib/repo-config.mts says, then puts ROLE_AGENTS back as it was.
async function withUiRole<T>(enabled: boolean, run: () => T | Promise<T>): Promise<T> {
  const agents: Record<string, unknown> = ROLE_AGENTS;
  const original = agents.ui;
  if (enabled) agents.ui = { ...ROLE_AGENTS.backend };
  else delete agents.ui;
  try {
    return await run();
  } finally {
    if (original === undefined) delete agents.ui;
    else agents.ui = original;
  }
}

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
// that issue" from Blazor-Server#72: resolveRoles is what main.mts asks for that
// fallback, since the plan schema itself can't reject an invalid field
// without aborting the whole plan (see plan.mts).
describe("resolveRoles", () => {
  // The roles a plan without a valid `roles` field runs: the optional ones, `ui` only when the repo opted in.
  const everyOptionalRole = () => OPTIONAL_ROLES.filter((role) => role !== "ui" || uiEnabled());

  it("runs every optional role when the field is missing", () => {
    assert.deepEqual(resolveRoles(undefined), everyOptionalRole());
  });

  it("runs every optional role when the field isn't an array", () => {
    assert.deepEqual(resolveRoles("architect"), everyOptionalRole());
    assert.deepEqual(resolveRoles(null), everyOptionalRole());
    assert.deepEqual(resolveRoles({ architect: true }), everyOptionalRole());
  });

  it("runs every optional role when the array names something resolveRoles doesn't recognise", () => {
    assert.deepEqual(resolveRoles(["architect", "backend"]), everyOptionalRole());
    assert.deepEqual(resolveRoles(["frontend"]), everyOptionalRole());
  });

  it("keeps only the roles the planner picked, in build order", () => {
    assert.deepEqual(resolveRoles(["scribe"]), ["scribe"]);
    assert.deepEqual(resolveRoles(["scribe", "architect"]), ["architect", "scribe"]);
  });

  it("deliberately picking none is valid: an empty array runs no optional role", () => {
    assert.deepEqual(resolveRoles([]), []);
  });

  it("leaves the ui role out of every optional role, and refuses a plan that picks it, in a repo that hasn't opted in", async () => {
    await withUiRole(false, () => {
      const everyOtherRole = OPTIONAL_ROLES.filter((role) => role !== "ui");
      assert.deepEqual(resolveRoles(undefined), everyOtherRole);
      assert.deepEqual(resolveRoles(["ui"]), everyOtherRole);
      assert.deepEqual(resolveRoles(["architect"]), ["architect"]);
    });
  });

  it("includes the ui role, in build order, in a repo that opted in", async () => {
    await withUiRole(true, () => {
      assert.deepEqual(resolveRoles(undefined), ["architect", "ui", "scribe"]);
      assert.deepEqual(resolveRoles(["scribe", "ui", "architect"]), ["architect", "ui", "scribe"]);
    });
  });

  it("drops a repeated role rather than running it twice", () => {
    assert.deepEqual(resolveRoles(["scribe", "scribe"]), ["scribe"]);
  });
});

// resolveFiles is what main.mts asks for each pick's files. The
// plan schema leaves the field unknown so a bad value means "no files" (the
// pick is held behind an open PR or another pick, unless it's the first) rather than aborting the whole plan.
describe("resolveFiles", () => {
  it("is empty when the field is missing", () => {
    assert.deepEqual(resolveFiles(undefined), []);
  });

  it("is empty when the field isn't an array", () => {
    assert.deepEqual(resolveFiles("lib/a.mts"), []);
    assert.deepEqual(resolveFiles(null), []);
    assert.deepEqual(resolveFiles({ "lib/a.mts": true }), []);
  });

  it("folds a parent segment into the one before it, so two spellings of a file compare equal", () => {
    assert.deepEqual(resolveFiles(["src/Web/../Web/Program.cs", "src/Web/Program.cs"]), ["src/Web/Program.cs"]);
    assert.deepEqual(resolveFiles(["a/b/../../c.txt"]), ["c.txt"]);
  });

  it("is empty when a path climbs above the root, since it names nothing to compare", () => {
    assert.deepEqual(resolveFiles(["../outside.txt"]), []);
    assert.deepEqual(resolveFiles(["lib/a.mts", "a/../../b.txt"]), []);
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

  // A folder is a path like any other, and overlap treats it as covering what's under it.
  it("drops a trailing slash, so a folder and the same folder with a slash are one path", () => {
    assert.deepEqual(resolveFiles(["lib/new/", "lib/new", "lib/other//"]), ["lib/new", "lib/other"]);
  });

  it("deliberately naming none is an empty list", () => {
    assert.deepEqual(resolveFiles([]), []);
  });
});

// The planner works in the sandbox, where the repository is at /home/agent/workspace, and may name a path from there.
describe("resolveFiles paths from the sandbox", () => {
  it("turns an absolute path under the repository root into a repo-relative one", () => {
    assert.deepEqual(resolveFiles(["/home/agent/workspace/.sandcastle/lib/build.mts"]), [".sandcastle/lib/build.mts"]);
  });

  it("treats an absolute path and the same path written relatively as one path", () => {
    assert.deepEqual(resolveFiles(["/home/agent/workspace/lib/a.mts", "lib/a.mts", "./lib/a.mts"]), ["lib/a.mts"]);
  });

  it("turns an absolute path to a folder under the root into a folder, without the trailing slash", () => {
    assert.deepEqual(resolveFiles(["/home/agent/workspace/.sandcastle/lib/"]), [".sandcastle/lib"]);
  });

  it("drops the repository root itself, which names no file", () => {
    assert.deepEqual(resolveFiles(["/home/agent/workspace", "/home/agent/workspace/", "lib/a.mts"]), ["lib/a.mts"]);
  });

  it("doesn't treat a path that only shares the root's prefix as under the root", () => {
    assert.deepEqual(resolveFiles(["/home/agent/workspace-other/x.mts"]), ["home/agent/workspace-other/x.mts"]);
  });

  it("takes the repository root as its second argument", () => {
    assert.deepEqual(resolveFiles(["/srv/repo/lib/a.mts", "/srv/repo/"], "/srv/repo"), ["lib/a.mts"]);
  });

  it("drops ./ and trailing spaces", () => {
    assert.deepEqual(resolveFiles(["./lib/a.mts ", " ./lib/b.mts\t"]), ["lib/a.mts", "lib/b.mts"]);
  });

  it("drops entries that are blank, or only ./ or slashes", () => {
    assert.deepEqual(resolveFiles(["", "   ", "./", "/", "//", "lib/a.mts"]), ["lib/a.mts"]);
  });

  it("drops an entry with a line break, keeping the other entries", () => {
    assert.deepEqual(resolveFiles(["lib/a.mts", "lib/b.mts\n::error::injected", "lib/c\r.mts"]), ["lib/a.mts"]);
  });

  it("drops an entry with a control character, keeping the other entries", () => {
    assert.deepEqual(
      resolveFiles(["lib/a.mts", "lib/\u0000b.mts", "lib/\u001b[31mc.mts", "lib/d\u007f.mts", "lib/e\u0085.mts", "lib/f.mts"]),
      ["lib/a.mts", "lib/f.mts"],
    );
  });

  it("is empty when every entry was dropped", () => {
    assert.deepEqual(resolveFiles(["x\ny", ""]), []);
  });
});

