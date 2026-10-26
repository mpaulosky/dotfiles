import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptFinding,
  checkReview,
  diffKey,
  EMPTY_DIFF_KEY,
  isOwnedPath,
  underOwnedPattern,
  ledgerDir,
  main,
  mergeBase,
  OWNED_PATHS,
  latestLedger,
  readLedger,
  recordReview,
  repoSlugProblem,
  takenIds,
  renderAdvisories,
  renderReport,
  renderReviewNotes,
  REVIEW_NOTES_END,
  REVIEW_NOTES_START,
  reviewPatch,
  spliceReviewNotes,
  type Ledger,
  type ReviewInput,
} from "./review-ledger.mts";
import { NOT_OWNED_BASELINE_PATHS } from "./repo-config.mts";

// Only the config each test sets: a machine's global or system git config
// (commit signing, a hooks path, merge.ff=only, colour) mustn't decide these
// tests. Child processes inherit it too.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// A finding as a review records it, with its severity graded.
type Finding = ReviewInput["findings"][number];

const moduleFile = fileURLToPath(new URL("./review-ledger.mts", import.meta.url));
const reviewScript = fileURLToPath(new URL("../../scripts/review.sh", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// A clone with an origin whose main has two files, checked out on a feature
// branch that changed line 3 of the 50-line `app.cs`.
let root: string;
let repo: string;
let upstream: string;

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  run(cwd, "add", file);
  run(cwd, "commit", "--quiet", "-m", message);
}

const lines = (count: number, change: (index: number) => string | undefined = () => undefined) =>
  `${Array.from({ length: count }, (_, index) => change(index) ?? `line ${index}`).join("\n")}\n`;

// Bring main's latest commits into the branch with a merge commit.
function mergeMain(): void {
  run(repo, "fetch", "--quiet", "origin");
  run(repo, "merge", "--quiet", "--no-edit", "origin/main");
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "R1",
  lens: "Edge cases",
  path: "app.cs",
  line: 3,
  summary: "An email of only spaces passes the guard.",
  severity: "critical",
  security: false,
  status: "fixed",
  test: "tests/AppTests.cs::Guard_WhitespaceEmail_Fails",
  reason: null,
  fix: "Trim the email before the guard.",
  ...overrides,
});

// Record a review of HEAD's diff, as the skill does once its last round read it.
const reviewed = () => ({ reviewedKey: diffKey(repo, mergeBase(repo)), reviewedHead: run(repo, "rev-parse", "HEAD") });
// A finding given as accepted (with its reason) is recorded open and then
// accepted, the only way a ledger gets an acceptance.
function record(findings: Finding[], rounds = 1, now?: Date): Ledger {
  const toAccept = findings.filter((found) => found.status === "accepted" && found.reason !== null);
  const input = findings.map((found) => (toAccept.includes(found) ? { ...found, status: "open" as const, reason: null } : found));
  const ledger = recordReview(repo, mergeBase(repo), { ...reviewed(), rounds, findings: input }, now);
  if (toAccept.length === 0) return ledger;
  let accepted = ledger;
  for (const found of toAccept) accepted = acceptFinding(repo, mergeBase(repo), found.id, found.reason ?? "");
  return accepted;
}

// Rewrite every finding in the ledger file at `path`, as an older version of
// the ledger would have written it.
function rewriteFindings(path: string, change: (finding: Record<string, unknown>) => Record<string, unknown>): void {
  const ledger = JSON.parse(readFileSync(path, "utf8")) as { findings: Record<string, unknown>[] };
  writeFileSync(path, JSON.stringify({ ...ledger, findings: ledger.findings.map(change) }));
}

// The branch's nearest earlier review.
const nearest = () => latestLedger(repo, mergeBase(repo));

// Run main() with stdout and stderr captured.
function cli(args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string) => (out.push(chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => (err.push(chunk), true)) as typeof process.stderr.write;
  try {
    const code = main(args, cwd, env);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "review-ledger-")));
  upstream = join(root, "upstream");
  repo = join(root, "repo");
  run(root, "init", "--quiet", "-b", "main", upstream);
  commit(upstream, "app.cs", lines(50), "start");
  commit(upstream, "other.cs", "x\n", "other");
  run(root, "clone", "--quiet", upstream, repo);
  run(repo, "switch", "--quiet", "-c", "feature/1-thing");
  commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed" : undefined)), "change app");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("diffKey", () => {
  it("keeps the key when main moves on in files the branch didn't change and is merged in cleanly", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(upstream, "other.cs", "y\n", "main moves on");
    mergeMain();

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("keeps the key when main changes a distant part of a file the branch changed and is merged in cleanly", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(upstream, "app.cs", lines(50, (index) => (index === 44 ? "main's change" : undefined)), "main edits line 45");
    mergeMain();

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("changes the key when main changes a line inside one of the branch's hunks", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(upstream, "app.cs", lines(50, (index) => (index === 4 ? "main's change" : undefined)), "main edits line 5");
    mergeMain();

    assert.notEqual(diffKey(repo, mergeBase(repo)), before);
  });

  it("keeps the key when a clean merge of main moves one of the branch's hunks down the file", () => {
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed" : index === 29 ? "deep change" : undefined)), "two hunks");
    const before = diffKey(repo, mergeBase(repo));
    const mainLines = lines(50).split("\n");
    mainLines.splice(15, 0, "main's new line");
    commit(upstream, "app.cs", mainLines.join("\n"), "main inserts a line between the hunks");
    mergeMain();

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("keeps the key when a clean merge of main adds a .gitattributes that changes hunk headers", () => {
    // Indented filler matches no function-name pattern; only csharp's matches
    // the method line, so the attribute really changes the hunk's header.
    const file = (change: string) =>
      `${Array.from({ length: 20 }, (_, index) => (index === 5 ? "public void M()" : index === 12 ? `  ${change}` : `  filler ${index}`)).join("\n")}\n`;
    commit(upstream, "app.cs", file("original"), "a method");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "app.cs", file("changed"), "change inside the method");
    const header = () => run(repo, "diff", mergeBase(repo), "HEAD").split("\n").find((line) => line.startsWith("@@")) ?? "";
    const before = diffKey(repo, mergeBase(repo));
    const headerBefore = header();
    commit(upstream, ".gitattributes", "*.cs diff=csharp\n", "attributes");
    mergeMain();

    assert.notEqual(header(), headerBefore);
    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("doesn't depend on the diff settings of whoever computes it", () => {
    const before = diffKey(repo, mergeBase(repo));
    for (const [name, value] of [
      ["core.abbrev", "12"],
      ["diff.context", "5"],
      ["diff.noprefix", "true"],
      ["diff.algorithm", "patience"],
      ["diff.interHunkContext", "10"],
      ["diff.suppressBlankEmpty", "true"],
      ["core.compression", "9"],
    ]) {
      run(repo, "config", name as string, value as string);
    }
    const saved = process.env.GIT_DIFF_OPTS;
    process.env.GIT_DIFF_OPTS = "-u1";
    try {
      assert.equal(diffKey(repo, mergeBase(repo)), before);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIFF_OPTS;
      else process.env.GIT_DIFF_OPTS = saved;
    }
  });

  it("doesn't depend on config or attributes that change how a richer diff is printed", () => {
    // A blank line inside a hunk, two hunks 8 lines apart, a non-ASCII name,
    // a swap that myers and patience print differently, and a binary file:
    // each pinned setting has something to change.
    const two = (a: string, b: string) =>
      `${["x0", "x1", "", "x3", a, "x5", "", "x7", "x8", "x9", "x10", "x11", "x12", "x13", "x14", b, "x16", "", "x18"].join("\n")}\n`;
    commit(upstream, "two.cs", two("a", "b"), "two");
    commit(upstream, "café.cs", "one\n", "accent");
    commit(upstream, "swap.txt", "}\n}\nA\n}\n}\nB\n}\n}\nC\n", "swap");
    commit(upstream, "slide.txt", "1\n2\na\n\nb\n3\n4\n", "slide");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "two.cs", two("A", "B"), "two hunks");
    commit(repo, "café.cs", "two\n", "accent change");
    commit(repo, "swap.txt", "}\n}\nB\n}\n}\nA\n}\n}\nC\n}\n", "swap A and B");
    // A block the indent heuristic slides, and a rename.
    commit(repo, "slide.txt", "1\n2\na\n\nb\na\n\nb\n3\n4\n", "slide");
    run(repo, "mv", "other.cs", "renamed.cs");
    run(repo, "commit", "--quiet", "-m", "rename");
    writeFileSync(join(repo, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(repo, "add", "logo.png");
    run(repo, "commit", "--quiet", "-m", "image");
    const before = diffKey(repo, mergeBase(repo));
    const script = join(root, "script.sh");
    writeFileSync(script, "#!/bin/sh\necho external\n");
    execFileSync("chmod", ["+x", script]);
    writeFileSync(join(root, "attributes"), "*.cs diff=rev binary\n*.png diff\n");
    writeFileSync(join(root, "order"), "two.cs\n*\n");
    for (const [name, value] of [
      ["core.quotePath", "false"],
      ["core.abbrev", "12"],
      ["core.attributesFile", join(root, "attributes")],
      ["diff.mnemonicPrefix", "true"],
      ["diff.noprefix", "true"],
      ["diff.suppressBlankEmpty", "true"],
      ["diff.interHunkContext", "10"],
      ["diff.algorithm", "patience"],
      ["diff.indentHeuristic", "false"],
      ["diff.renames", "false"],
      ["color.diff", "always"],
      ["color.ui", "always"],
      ["diff.orderFile", join(root, "order")],
      ["diff.external", script],
      ["diff.rev.textconv", "rev"],
    ]) {
      run(repo, "config", name as string, value as string);
    }
    writeFileSync(join(repo, ".git", "info", "attributes"), "*.cs diff=rev\n");

    assert.equal(diffKey(repo, mergeBase(repo)), before);
    // From a folder with no changes of its own, diff.relative would key nothing.
    run(repo, "config", "diff.relative", "true");
    mkdirSync(join(repo, "empty-folder"));
    assert.equal(diffKey(join(repo, "empty-folder"), mergeBase(repo)), before);
  });

  it("keys a binary file by its content, whatever zlib or attributes do with it", () => {
    writeFileSync(join(repo, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(repo, "add", "logo.png");
    run(repo, "commit", "--quiet", "-m", "image");
    const before = diffKey(repo, mergeBase(repo));
    run(repo, "config", "core.compression", "1");
    assert.equal(diffKey(repo, mergeBase(repo)), before);

    writeFileSync(join(repo, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 254]));
    run(repo, "commit", "--quiet", "-am", "new image");

    assert.notEqual(diffKey(repo, mergeBase(repo)), before);
  });

  it("keys a text file as text whatever core.bigFileThreshold says, rather than refuse it as binary", () => {
    const before = diffKey(repo, mergeBase(repo));

    run(repo, "config", "core.bigFileThreshold", "1");

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  for (const [change, after] of [
    ["deletes", undefined],
    ["turns into text", "now text\n"],
  ] as const) {
    it(`${after === undefined ? "reviews" : "refuses"} a branch that ${change} a binary file`, () => {
      writeFileSync(join(upstream, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
      run(upstream, "add", "logo.png");
      run(upstream, "commit", "--quiet", "-m", "image");
      run(repo, "fetch", "--quiet", "origin");
      run(repo, "reset", "--quiet", "--hard", "origin/main");
      if (after === undefined) {
        run(repo, "rm", "--quiet", "logo.png");
        run(repo, "commit", "--quiet", "-m", "delete the image");
      } else {
        commit(repo, "logo.png", after, "replace the image with text");
      }

      if (after === undefined) {
        assert.notEqual(diffKey(repo, mergeBase(repo)), EMPTY_DIFF_KEY);
        assert.match(reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")).toString("latin1"), /^Binary files .*logo\.png.* differ$/m);
      } else {
        // git prints the whole change as "Binary files differ", so the
        // reviewers would never read the new text.
        assert.throws(() => diffKey(repo, mergeBase(repo)), /logo\.png.*into text/);
      }
    });
  }

  it("reviews a branch that empties a binary file, which has no text to read", () => {
    writeFileSync(join(upstream, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(upstream, "add", "logo.png");
    run(upstream, "commit", "--quiet", "-m", "image");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    writeFileSync(join(repo, "logo.png"), "");
    run(repo, "commit", "--quiet", "-am", "empty the image");

    assert.notEqual(diffKey(repo, mergeBase(repo)), EMPTY_DIFF_KEY);
  });

  // git calls a file binary when a NUL is among its first 8000 bytes: the byte
  // at index 7999 is the last it looks at. A text file git takes for binary is
  // refused, and git taking it for text is no concern.
  for (const [index, binary] of [
    [7999, true],
    [8000, false],
  ] as const) {
    it(`takes a NUL at byte ${index} of a new file ${binary ? "for" : "not for"} binary, as git does`, () => {
      const bytes = Buffer.alloc(8100, "a");
      bytes[index] = 0;
      writeFileSync(join(repo, "n.cs"), bytes);
      run(repo, "add", "n.cs");
      run(repo, "commit", "--quiet", "-m", "a file with a NUL");

      if (binary) {
        assert.throws(() => diffKey(repo, mergeBase(repo)), /n\.cs.*NUL/);
      } else {
        assert.doesNotMatch(reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")).toString("latin1"), /^Binary files/m);
      }
    });
  }

  // R74 (R42): git prints a text file with a stray NUL as "Binary files
  // differ", so the reviewers would never read it. Only a file with a binary
  // format's extension may be binary: whatever its bytes, since one 0xff
  // byte would otherwise make it look like a real binary file.
  for (const [scenario, name, bytes] of [
    ["a stray NUL", "n.cs", Buffer.from("class A { }\0\n")],
    ["a NUL and multi-byte text", "n.md", Buffer.from("// \u00fc \u691c\0\nclass A { }\n")],
    ["a NUL at the very start", "n.sh", Buffer.from("\0echo hi\n")],
    ["a NUL and an 0xff byte, which isn't UTF-8", "n.mts", Buffer.from("// \0\xff\nexport {};\n")],
    ["a NUL and a Latin-1 letter", "n.cs", Buffer.from("// \0\xe9\nclass A { }\n")],
    ["no extension", "script", Buffer.from("echo hi\0\xff\n")],
    ["the name of a binary format and no dot", "png", Buffer.from("echo hi\0\xff\n")],
    ["an extension that only ends like a binary one", "n.cs.png.txt", Buffer.from("echo hi\0\xff\n")],
    ["a name git quotes, with a non-ASCII letter", "n\u00f6te.cs", Buffer.from("class A { }\0\n")],
    ["a name git quotes, with a backslash", "n\\te.cs", Buffer.from("class A { }\0\n")],
  ] as const) {
    it(`refuses a new ${name} holding ${scenario}`, () => {
      writeFileSync(join(repo, name), bytes);
      run(repo, "add", name);
      run(repo, "commit", "--quiet", "-m", "a text file with a NUL");

      assert.throws(() => diffKey(repo, mergeBase(repo)), /NUL/);
    });
  }

  it("reviews a branch that deletes a binary file whose extension isn't a binary format's", () => {
    writeFileSync(join(upstream, "fixture.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(upstream, "add", "fixture.dat");
    run(upstream, "commit", "--quiet", "-m", "a fixture");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    run(repo, "rm", "--quiet", "fixture.dat");
    run(repo, "commit", "--quiet", "-m", "delete the fixture");

    assert.doesNotThrow(() => diffKey(repo, mergeBase(repo)));
  });

  it("refuses a change that adds a stray NUL to a text file", () => {
    writeFileSync(join(repo, "app.cs"), "class A { }\0\n");
    run(repo, "commit", "--quiet", "-am", "add a NUL");

    assert.throws(() => diffKey(repo, mergeBase(repo)), /app\.cs.*NUL/);
  });

  for (const [scenario, name, bytes] of [
    ["a PNG header", "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])],
    ["bytes that aren't UTF-8", "logo.png", Buffer.from([0, 1, 2, 3, 0, 255])],
    ["only NUL bytes", "logo.png", Buffer.alloc(16)],
    ["bytes all below 0x80, as an empty WebAssembly module is", "m.wasm", Buffer.from("\0asm\x01\0\0\0", "latin1")],
    ["an empty ZIP's bytes", "a.zip", Buffer.from("PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0", "latin1")],
    ["an upper-case extension", "LOGO.PNG", Buffer.from([0, 1, 2, 3])],
    ["a name with a dot before the extension", "my.logo.v2.ico", Buffer.from([0, 0, 1, 0])],
    ["a name git quotes, with a non-ASCII letter", "l\u00f6go.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])],
    ["a name git quotes, with a double quote", 'a"b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])],
  ] as const) {
    it(`still reviews a new binary file, ${name}, holding ${scenario}`, () => {
      writeFileSync(join(repo, name), bytes);
      run(repo, "add", name);
      run(repo, "commit", "--quiet", "-m", "a binary file");

      assert.match(reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")).toString("latin1"), /^Binary files .* differ$/m);
    });
  }

  it("reviews a text file emptied or deleted, and an empty file added", () => {
    run(repo, "rm", "--quiet", "other.cs");
    writeFileSync(join(repo, "empty.txt"), "");
    run(repo, "add", "empty.txt");
    run(repo, "commit", "--quiet", "-m", "delete one, add an empty one");
    writeFileSync(join(repo, "app.cs"), "");
    run(repo, "commit", "--quiet", "-am", "empty app.cs");

    assert.doesNotThrow(() => diffKey(repo, mergeBase(repo)));
  });

  it("refuses a binary file turned into text with a NUL past git's first 8000 bytes, which git still prints as text", () => {
    writeFileSync(join(upstream, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(upstream, "add", "logo.png");
    run(upstream, "commit", "--quiet", "-m", "image");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    writeFileSync(join(repo, "logo.png"), Buffer.concat([Buffer.from("text\n".repeat(1800)), Buffer.from([0]), Buffer.from("\n")]));
    run(repo, "commit", "--quiet", "-am", "replace the image with text");

    assert.throws(() => diffKey(repo, mergeBase(repo)), /logo\.png.*into text/);
  });

  // "class A { }\n" as code units of 2 or 4 bytes, in either byte order.
  const units = (width: 2 | 4, littleEndian: boolean) =>
    Buffer.concat(
      [..."class A { }\n"].map((character) => {
        const unit = Buffer.alloc(width);
        if (width === 2) unit.writeUInt16LE(character.charCodeAt(0));
        else unit.writeUInt32LE(character.charCodeAt(0));
        return littleEndian ? unit : Buffer.from(unit).reverse();
      }),
    );
  for (const [encoding, bom, body] of [
    ["UTF-16LE", Buffer.from([0xff, 0xfe]), units(2, true)],
    ["UTF-16BE", Buffer.from([0xfe, 0xff]), units(2, false)],
    ["UTF-32LE", Buffer.from([0xff, 0xfe, 0, 0]), units(4, true)],
    ["UTF-32BE", Buffer.from([0, 0, 0xfe, 0xff]), units(4, false)],
  ] as const) {
    it(`refuses a ${encoding} text file, which git shows only as binary`, () => {
      writeFileSync(join(repo, "a.cs"), Buffer.concat([bom, body]));
      run(repo, "add", "a.cs");
      run(repo, "commit", "--quiet", "-m", "a UTF-16 file");

      assert.throws(() => diffKey(repo, mergeBase(repo)), /a\.cs.*UTF-8/);
    });
  }

  it("tells a UTF-16 file main already holds to be re-encoded at a new path, since the old blob makes the rewrite look like binary to text", () => {
    writeFileSync(join(upstream, "a.cs"), Buffer.concat([Buffer.from([0xff, 0xfe]), units(2, true)]));
    run(upstream, "add", "a.cs");
    run(upstream, "commit", "--quiet", "-m", "a UTF-16 file");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    writeFileSync(join(repo, "a.cs"), Buffer.concat([Buffer.from([0xff, 0xfe]), units(2, true), Buffer.from("x\0", "utf16le")]));
    run(repo, "commit", "--quiet", "-am", "edit it, still UTF-16");

    assert.throws(() => diffKey(repo, mergeBase(repo)), /a\.cs.*UTF-8 at a new path/);
  });

  it("reads git's attributes without the system-wide file, which whoever's machine this is may have set", () => {
    const bin = mkdtempSync(join(tmpdir(), "attr-git-"));
    const real = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    // Stands in for a system gitattributes that marks every file binary: git
    // has no way to point at another one, so the stub asks for the variable
    // that turns the file off.
    writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$GIT_ATTR_NOSYSTEM" = 1 ] || { echo "system attributes read" >&2; exit 3; }\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      assert.doesNotThrow(() => diffKey(repo, mergeBase(repo)));
    } finally {
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("sees a submodule pointer bump even when git is told to ignore submodules", () => {
    const sub = join(root, "sub");
    run(root, "init", "--quiet", "-b", "main", sub);
    commit(sub, "s.txt", "1\n", "one");
    const first = run(sub, "rev-parse", "HEAD");
    commit(sub, "s.txt", "2\n", "two");
    const second = run(sub, "rev-parse", "HEAD");
    run(repo, "switch", "--quiet", "-C", "feature/1-thing", "origin/main");
    run(repo, "update-index", "--add", "--cacheinfo", `160000,${first},lib`);
    run(repo, "commit", "--quiet", "-m", "add submodule");
    run(repo, "config", "diff.ignoreSubmodules", "all");
    const before = diffKey(repo, mergeBase(repo));
    run(repo, "update-index", "--cacheinfo", `160000,${second},lib`);
    // The override lets git 2.39, the sandbox's, commit a bump it's told to ignore.
    run(repo, "-c", "diff.ignoreSubmodules=none", "commit", "--quiet", "-m", "bump submodule");

    assert.notEqual(before, EMPTY_DIFF_KEY);
    const after = diffKey(repo, mergeBase(repo));
    assert.notEqual(after, before);
    run(repo, "config", "diff.submodule", "log");
    assert.equal(diffKey(repo, mergeBase(repo)), after);
  });

  it("changes the key when the branch commits again", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed again" : undefined)), "fix");

    assert.notEqual(diffKey(repo, mergeBase(repo)), before);
  });

  for (const where of ["the branch's .gitattributes", "the clone's info/attributes"]) {
    it(`refuses a text file ${where} marks binary, which would hide its change from the reviewers`, () => {
      if (where.startsWith("the branch")) {
        commit(repo, ".gitattributes", "*.cs -diff\n", "attributes");
      } else {
        mkdirSync(join(repo, ".git", "info"), { recursive: true });
        writeFileSync(join(repo, ".git", "info", "attributes"), "*.cs -diff\n");
      }

      assert.throws(() => reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")), /app\.cs .*binary/);
      assert.throws(() => diffKey(repo, mergeBase(repo)), /binary/);
    });
  }

  it("lets a branch delete or empty a text file a diff attribute marks binary, since the new side has no text to hide", () => {
    commit(repo, ".gitattributes", "*.cs -diff\n", "attributes");
    run(repo, "rm", "--quiet", "app.cs");
    run(repo, "commit", "--quiet", "-m", "delete");

    assert.doesNotThrow(() => reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")));
    assert.doesNotThrow(() => diffKey(repo, mergeBase(repo)));
  });

  it("lets a branch empty a text file a diff attribute marks binary", () => {
    commit(repo, ".gitattributes", "*.cs -diff\n", "attributes");
    commit(repo, "app.cs", "", "empty it");

    assert.doesNotThrow(() => reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")));
  });

  it("reads and keys commits as they are, not as a replace ref shows them", () => {
    const base = mergeBase(repo);
    const key = diffKey(repo, base);
    const patch = reviewPatch(repo, base, run(repo, "rev-parse", "HEAD"));
    const real = run(repo, "rev-parse", "HEAD:app.cs");
    const substitute = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: lines(50), encoding: "utf8" }).trim();
    run(repo, "replace", real, substitute);

    assert.equal(diffKey(repo, base), key);
    assert.equal(reviewPatch(repo, base, run(repo, "rev-parse", "HEAD")).toString(), patch.toString());
  });

  it("says there's nothing to review when the branch has no changes", () => {
    run(repo, "switch", "--quiet", "main");

    assert.equal(diffKey(repo, mergeBase(repo)), EMPTY_DIFF_KEY);
  });

  it("ignores the git variables a hook sets, which would point it at another repository", () => {
    const expected = diffKey(repo, mergeBase(repo));
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
    process.env.GIT_DIR = join(upstream, ".git");
    process.env.GIT_COMMON_DIR = join(upstream, ".git");
    try {
      assert.equal(diffKey(repo, mergeBase(repo)), expected);
      assert.equal(ledgerDir(repo), join(repo, ".git", "review"));
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("checkReview", () => {
  it("fails when no review is recorded for the diff", () => {
    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, false);
    assert.match(result.message, /\/pre-push-review/);
  });

  it("passes when every finding is fixed, dismissed or accepted", () => {
    record([
      finding(),
      finding({ id: "R2", status: "accepted", test: null, reason: "Out of scope, #81." }),
      finding({ id: "R3", status: "dismissed", test: null, reason: "The guard trims first: app.cs:2." }),
    ]);

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("fails and names each finding that waits for a person", () => {
    record([finding({ id: "R4", status: "open", test: null })], 3);

    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, false);
    assert.match(result.message, /R4 critical app\.cs:3 \(Edge cases\)/);
    assert.match(result.message, /scripts\/review\.sh accept/);
    assert.match(result.message, /the person you work for accepts each one \(never an agent on their behalf\)/);
  });

  for (const severity of ["critical", "warning"] as const) {
    it(`fails with an open ${severity} finding`, () => {
      record([finding({ severity, status: "open", test: null })]);

      const result = checkReview(repo, mergeBase(repo), {});

      assert.equal(result.ok, false);
      assert.match(result.message, new RegExp(`R1 ${severity} app\\.cs:3`));
    });
  }

  it("passes with open Advisory findings, which never block, and counts them for the follow-up issue", () => {
    record([finding(), finding({ id: "R2", severity: "advisory", status: "open", test: null }), finding({ id: "R3", severity: "advisory", status: "open", test: null })]);

    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, true);
    assert.match(result.message, /2 Advisory finding\(s\) open for the follow-up issue/);
  });

  it("fails with a stored open Advisory finding whose lens names security, which record no longer takes", () => {
    const ledger = record([finding({ severity: "advisory", status: "open", test: null })]);
    rewriteFindings(join(ledgerDir(repo), `${ledger.key}.json`), (stored) => ({ ...stored, lens: "Security" }));

    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, false);
    assert.match(result.message, /R1 advisory app\.cs:3 \(Security\)/);
  });

  for (const lens of ["GitHub Actions", "Edge cases"]) {
    it(`fails with a stored open Advisory finding from ${lens} with no security decision, since nobody decided it isn't one`, () => {
      const ledger = record([finding({ lens, severity: "advisory", status: "open", test: null })]);
      rewriteFindings(join(ledgerDir(repo), `${ledger.key}.json`), ({ security: _, ...rest }) => rest);

      const result = checkReview(repo, mergeBase(repo), {});

      assert.equal(result.ok, false);
    });
  }

  it("names only the blocking findings when Advisory ones are open beside them", () => {
    record([finding({ status: "open", test: null }), finding({ id: "R2", severity: "advisory", status: "open", test: null })]);

    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, false);
    assert.match(result.message, /^1 review finding\(s\) wait/);
    assert.doesNotMatch(result.message, /R2/);
  });

  it("fails again once a new commit changes the diff the review vouched for", () => {
    record([]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed later" : undefined)), "unreviewed change");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("fails when an edit moves to an identical block, which keeps the key but isn't the reviewed code", () => {
    const block = (button: string) => `<div>\n  <p>a</p>\n  <p>b</p>\n  ${button}\n  <p>c</p>\n  <p>d</p>\n</div>\n`;
    commit(upstream, "page.razor", `${block("<button/>")}${block("<button/>")}`, "two identical blocks");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "page.razor", `${block("<button disabled/>")}${block("<button/>")}`, "edit the first block");
    const reviewed = diffKey(repo, mergeBase(repo));
    record([]);
    commit(repo, "page.razor", `${block("<button/>")}${block("<button disabled/>")}`, "move the edit to the second block");

    assert.equal(diffKey(repo, mergeBase(repo)), reviewed);
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("isn't passed by a replace ref that shows the moved edit as the reviewed commit", () => {
    const block = (button: string) => `<div>\n  <p>a</p>\n  <p>b</p>\n  ${button}\n  <p>c</p>\n  <p>d</p>\n</div>\n`;
    commit(upstream, "page.razor", `${block("<button/>")}${block("<button/>")}`, "two identical blocks");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "page.razor", `${block("<button disabled/>")}${block("<button/>")}`, "edit the first block");
    const reviewed = run(repo, "rev-parse", "HEAD");
    record([]);
    commit(repo, "page.razor", `${block("<button/>")}${block("<button disabled/>")}`, "move the edit to the second block");
    run(repo, "replace", run(repo, "rev-parse", "HEAD"), reviewed);

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("fails when git can't tell whether HEAD is the reviewed code", () => {
    const ledger = record([]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace(ledger.head, "1".repeat(40)));

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  // Run `check` with a git 2.34 on the PATH, which has no merge-tree --write-tree.
  function checkWithOldGit(): ReturnType<typeof checkReview> {
    const bin = mkdtempSync(join(tmpdir(), "old-git-"));
    const real = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = version ]; then echo "git version 2.34.1"; exit 0; fi\nfor a in "$@"; do [ "$a" = --write-tree ] && { echo "error: unknown option" >&2; exit 129; }; done\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      return checkReview(repo, mergeBase(repo), {});
    } finally {
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  it("names a git too old to check the review across a merge of main, and its version, rather than say there's none", () => {
    record([]);
    commit(upstream, "other.cs", "y\n", "main moves on");
    mergeMain();

    const result = checkWithOldGit();

    assert.equal(result.ok, false);
    assert.match(result.message, /git 2\.38 or later/);
    assert.match(result.message, /^git version 2\.34\.1 can't check/);
  });

  it("passes the reviewed commit itself on a git too old to check across a merge, which it doesn't need", () => {
    record([]);

    const result = checkWithOldGit();

    assert.equal(result.ok, true, result.message);
  });

  it("passes the reviewed commit with a clean merge of main and nothing else", () => {
    record([]);
    commit(upstream, "other.cs", "y\n", "main moves on");
    mergeMain();

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("throws, naming the file, on a ledger that doesn't match the schema, rather than pass it", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace('"open"', '"OPEN"'));

    assert.throws(() => checkReview(repo, mergeBase(repo), {}), (error: Error) => error.message.includes(path));
  });

  it("throws on a truncated ledger rather than pass it", () => {
    const ledger = record([]);
    writeFileSync(join(ledgerDir(repo), `${ledger.key}.json`), '{"version": 1, "key":');

    assert.throws(() => checkReview(repo, mergeBase(repo), {}), /damaged/);
  });

  it("passes a Baseline re-Apply that changes only Owned files", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    mkdirSync(join(repo, "scripts"));
    commit(repo, "global.json", "{}\n", "re-Apply");
    commit(repo, "scripts/check-branch-name.sh", "#!/bin/sh\n", "re-Apply");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("reviews a re-Apply branch that changes anything not Owned", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    commit(repo, "global.json", "{}\n", "re-Apply");
    commit(repo, "app.cs", "sneaked in\n", "not Owned");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply that moves a file that isn't Owned into an Owned folder", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    mkdirSync(join(repo, "scripts/tests"), { recursive: true });
    run(repo, "mv", "app.cs", "scripts/tests/app.cs");
    run(repo, "commit", "--quiet", "-m", "move");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply with a submodule bump that git is told to ignore", () => {
    const sub = join(root, "sub");
    run(root, "init", "--quiet", "-b", "main", sub);
    commit(sub, "s.txt", "1\n", "one");
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    run(repo, "update-index", "--add", "--cacheinfo", `160000,${run(sub, "rev-parse", "HEAD")},vendor`);
    run(repo, "-c", "diff.ignoreSubmodules=none", "commit", "--quiet", "-m", "submodule");
    commit(repo, "global.json", "{}\n", "re-Apply");
    run(repo, "config", "diff.ignoreSubmodules", "all");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply checked from a folder, whatever diff.relative says", () => {
    // From sub/, a relative diff would list sub/global.json as global.json,
    // which is Owned.
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    mkdirSync(join(repo, "sub"));
    commit(repo, "sub/global.json", "not Owned\n", "not Owned");
    run(repo, "config", "diff.relative", "true");

    assert.equal(checkReview(join(repo, "sub"), mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply whose first path starts with whitespace", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    commit(repo, "global.json", "{}\n", "re-Apply");
    commit(repo, "\tglobal.json", "sneaked in\n", "not Owned");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply that deletes an Owned file, which Apply never does", () => {
    commit(upstream, "global.json", "{}\n", "main has an Owned file");
    run(repo, "fetch", "--quiet", "origin", "main");
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    run(repo, "rm", "--quiet", "global.json");
    run(repo, "commit", "--quiet", "-m", "delete an Owned file");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply that turns an Owned path into a symlink", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    symlinkSync("/etc/passwd", join(repo, "global.json"));
    run(repo, "add", "global.json");
    run(repo, "commit", "--quiet", "-m", "symlink");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply that adds a submodule at an Owned path", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    run(repo, "update-index", "--add", "--cacheinfo", `160000,${run(repo, "rev-parse", "HEAD")},scripts/tests/vendor`);
    run(repo, "commit", "--quiet", "-m", "gitlink");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("still passes a re-Apply that adds a new executable Owned file and edits one main already has", () => {
    commit(upstream, "global.json", "[]\n", "main has an Owned file");
    run(repo, "fetch", "--quiet", "origin", "main");
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts/check-pr-title.sh"), "#!/bin/sh\n");
    chmodSync(join(repo, "scripts/check-pr-title.sh"), 0o755);
    run(repo, "add", "scripts/check-pr-title.sh");
    run(repo, "commit", "--quiet", "-m", "re-Apply");
    commit(repo, "global.json", "{}\n", "re-Apply");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("reviews Owned-only changes on any other branch", () => {
    run(repo, "switch", "--quiet", "-C", "chore/edit-global", "origin/main");
    commit(repo, "global.json", "{}\n", "edit");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("is skipped when GATE_SKIP_REVIEW is 1", () => {
    assert.equal(checkReview(repo, mergeBase(repo), { GATE_SKIP_REVIEW: "1" }).ok, true);
  });

  it("is not skipped by any other value of GATE_SKIP_REVIEW", () => {
    assert.equal(checkReview(repo, mergeBase(repo), { GATE_SKIP_REVIEW: "true" }).ok, false);
  });

  it("passes a branch with nothing to review", () => {
    run(repo, "switch", "--quiet", "main");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });
});

describe("recordReview", () => {
  it("refuses a dirty worktree, since the review couldn't vouch for HEAD", () => {
    writeFileSync(join(repo, "new.cs"), "untracked\n");

    assert.throws(() => record([]), /uncommitted changes/);
  });

  it("refuses a HEAD whose diff isn't the one the last round reviewed", () => {
    const round = reviewed();
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fixed after the round" : undefined)), "late fix");

    assert.throws(() => recordReview(repo, mergeBase(repo), { ...round, rounds: 3, findings: [] }), /Review again/);
  });

  it("refuses a clean merge of main that changed a line inside one of the branch's hunks after the round", () => {
    const round = reviewed();
    commit(upstream, "app.cs", lines(50, (index) => (index === 4 ? "main's change" : undefined)), "main edits line 5");
    mergeMain();

    assert.throws(() => recordReview(repo, mergeBase(repo), { ...round, rounds: 1, findings: [] }), /Review again/);
  });

  it("refuses a commit that keeps the key but isn't the code the last round read", () => {
    const block = (button: string) => `<div>\n  <p>a</p>\n  <p>b</p>\n  ${button}\n  <p>c</p>\n  <p>d</p>\n</div>\n`;
    commit(upstream, "page.razor", `${block("<button/>")}${block("<button/>")}`, "two identical blocks");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "page.razor", `${block("<button disabled/>")}${block("<button/>")}`, "edit the first block");
    const round = reviewed();
    commit(repo, "page.razor", `${block("<button/>")}${block("<button disabled/>")}`, "move the edit after the round");

    assert.throws(() => recordReview(repo, mergeBase(repo), { ...round, rounds: 1, findings: [] }), /Review again/);
  });

  it("replaces a damaged ledger, so the review the error asks for can be recorded", () => {
    const ledger = record([]);
    writeFileSync(join(ledgerDir(repo), `${ledger.key}.json`), '{"version": 2');

    record([]);

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("refuses a security weakness recorded fixed on a reason alone, and takes one that names its test", () => {
    const weakness = { severity: "warning" as const, security: true, status: "fixed" as const };

    assert.throws(() => record([finding({ ...weakness, test: null, reason: "Reworded." })]), /R1 is a security weakness recorded fixed without a test/);
    assert.equal(record([finding({ ...weakness, test: ".github/ci/gate-checks.sh::no-token-in-env", reason: null })]).findings[0]?.status, "fixed");
  });

  it("holds a Warning marked security: false, or a finding whose lens names security, to the same rule", () => {
    assert.throws(() => record([finding({ severity: "warning", security: false, status: "fixed", test: null, reason: "Reworded." })]), /recorded fixed without a test/);
    assert.throws(() => record([finding({ lens: "Security", severity: "critical", security: false, status: "fixed", test: null, reason: "Reworded." })]), /recorded fixed without a test/);
  });

  it("refuses a fixed finding that names neither a test nor why it has none", () => {
    assert.throws(() => record([finding({ test: null })]), /neither its test/);
  });

  it("refuses an accepted finding without a reason", () => {
    assert.throws(() => record([finding({ status: "accepted", test: null })]), /accepted without a reason/);
  });

  it("refuses a dismissed finding without the evidence", () => {
    assert.throws(() => record([finding({ status: "dismissed", test: null })]), /dismissed without a reason/);
  });

  for (const path of ["a<b.cs", "a>b.cs", "a`b.cs", "a\tb.cs", "a\nb.cs", "a  b.cs", "a\u2028b.cs"]) {
    it(`refuses a path that isn't a plain repository path: ${JSON.stringify(path)}`, () => {
      assert.throws(() => record([finding({ path })]), /a path has no whitespace/);
    });
  }

  it("takes a path with single spaces, as every file of the Template has under \"Support For New Projects/\"", () => {
    const path = "Support For New Projects/.claude/skills/repo-ci-baseline/apply.sh";

    const ledger = record([finding({ path })]);

    assert.match(renderReport(ledger), /Support For New Projects/);
  });

  it("refuses a finding given as accepted: only the person accepts, with scripts/review.sh accept", () => {
    assert.throws(
      () => recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, findings: [finding({ status: "accepted", test: null, reason: "Says the agent." })] }),
      /R1 can't be recorded as accepted/,
    );
  });

  it("carries no acceptance into a new review: the person accepts again", () => {
    record([finding({ status: "accepted", test: null, reason: "Accepted on the earlier code." })]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    const ledger = record([finding({ id: "R2", status: "open", test: null })]);

    assert.equal(ledger.findings[0]?.status, "open");
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("replaces the same diff's ledger and carries none of its acceptances", () => {
    record([finding({ status: "accepted", test: null, reason: "Accepted on the first review." })]);

    const ledger = record([finding({ id: "R2", status: "open", test: null })]);

    assert.deepEqual(readLedger(repo, ledger.key)?.findings.map((found) => [found.id, found.status]), [["R2", "open"]]);
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("refuses an id a review of the same diff at the same commit used, so an accept read from it can't land on another finding", () => {
    record([finding({ status: "open", test: null }), finding({ id: "R2", lens: "Security", severity: "warning", status: "open", test: null })]);

    assert.throws(() => record([finding({ lens: "Security", severity: "warning", status: "open", test: null })]), /after R2/);
  });

  it("refuses an id the branch's earlier review used, so the two are never confused", () => {
    record([finding({ id: "R3", status: "open", test: null })]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.throws(() => record([finding({ id: "R2" })]), /after R3/);
    assert.doesNotThrow(() => record([finding({ id: "R4" })]));
  });

  it("compares ids by number, refuses the highest one itself, and leaves the ledger as it was when it refuses", () => {
    const first = record([finding({ id: "R10", status: "open", test: null }), finding({ id: "R9", status: "open", test: null })]);

    assert.throws(() => record([finding({ id: "R10" })]), /after R10/);
    assert.throws(() => record([finding({ id: "R9" })]), /after R10/);
    assert.deepEqual(readLedger(repo, first.key), first);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");
    assert.doesNotThrow(() => record([finding({ id: "R11" })]));
  });

  it("keeps the ids taken through a review that found nothing, on the same diff and after it", () => {
    record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    record([]);
    assert.throws(() => record([finding()]), /after R2/);

    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");
    record([]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 2" : undefined)), "fix 2");

    assert.throws(() => record([finding()]), /after R2/);
  });

  it("refuses an id the same diff's review used after a rebase, though that review is no longer the branch's", () => {
    record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    commit(upstream, "other.cs", "y\n", "main moves on");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "rebase", "--quiet", "origin/main");

    assert.equal(nearest(), undefined);
    assert.equal(cli(["next"]).out, "R3\n");
    assert.throws(() => record([finding()]), /after R2/);
  });

  it("takes the ids from every earlier review of the branch, not only the nearest", () => {
    const first = run(repo, "rev-parse", "HEAD");
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");
    const second = run(repo, "rev-parse", "HEAD");
    record([finding({ status: "open", test: null })]);
    run(repo, "reset", "--quiet", "--hard", first);
    record([finding({ id: "R5", status: "open", test: null })]);
    run(repo, "reset", "--quiet", "--hard", second);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 2" : undefined)), "fix 2");

    assert.equal(nearest()?.findings[0]?.id, "R1");
    assert.throws(() => record([finding({ id: "R2" })]), /after R5/);
  });

  it("still takes the ids of a review recorded before ledgers held the highest id", () => {
    const ledger = record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/,\s*"lastId": \d+/, ""));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.equal(nearest()?.key, ledger.key);
    assert.throws(() => record([finding()]), /after R2/);
  });

  for (const id of ["R100", "R999999"]) {
    it(`records an id as high as ${id}`, () => {
      assert.doesNotThrow(() => record([finding({ id })]));
    });
  }

  for (const id of ["R0", "R007", "R1234567", "XR1", " R1", "R1 "]) {
    it(`refuses an id that isn't R1 to R999999 written plainly: ${id}`, () => {
      assert.throws(() => record([finding({ id })]), /ids are R1, R2/);
    });
  }

  it("still reads and checks a ledger recorded before findings had a security mark or a severity", () => {
    const ledger = record([finding({ status: "accepted", test: null, reason: "Old acceptance." })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    rewriteFindings(path, ({ severity: _, fix: _fix, ...rest }) => rest);

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
    const latest = latestLedger(repo, mergeBase(repo));
    assert.equal(latest?.key, ledger.key);
    assert.equal(latest?.findings[0]?.severity, undefined);
  });

  it("still takes the ids of a ledger recorded before findings had a severity or a fix", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    rewriteFindings(join(ledgerDir(repo), `${ledger.key}.json`), ({ severity: _, fix: _fix, ...rest }) => ({ ...rest, security: false }));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.equal(cli(["next"]).out, "R2\n");
    assert.equal(latestLedger(repo, mergeBase(repo))?.key, ledger.key);
  });

  it("accepts an open finding on a ledger recorded before findings had a severity, so the check passes", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    rewriteFindings(join(ledgerDir(repo), `${ledger.key}.json`), ({ severity: _, fix: _fix, ...rest }) => ({ ...rest, security: false }));

    acceptFinding(repo, mergeBase(repo), "R1", "Old.");

    assert.equal(readLedger(repo, ledger.key)?.findings[0]?.status, "accepted");
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("still reads a ledger recorded with a security mark and no severity, and treats its open finding as a Warning that blocks", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    rewriteFindings(path, ({ severity: _, fix: _fix, ...rest }) => ({ ...rest, security: false }));

    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, false);
    assert.match(result.message, /R1 warning app\.cs:3/);
  });

  it("refuses a finding without a severity", () => {
    const { severity: _, ...ungraded } = finding();

    assert.throws(() => record([ungraded as Finding]), /severity/);
  });

  for (const lens of ["Security", "Edge/Security", "security"]) {
    it(`refuses an Advisory finding whose lens names security (${lens}), which would pass the check and be published`, () => {
      assert.throws(() => record([finding({ lens, severity: "advisory", status: "open", test: null })]), /names security.*warning/);
    });
  }

  it("refuses a finding without the fix field, which is null when unused", () => {
    const { fix: _, ...fixless } = finding();

    assert.throws(() => record([fixless as Finding]), /fix/);
  });

  for (const severity of ["critical", "warning", "advisory"] as const) {
    it(`refuses an open ${severity} finding with no suggested fix, which the person or the follow-up issue needs`, () => {
      assert.throws(() => record([finding({ severity, status: "open", test: null, fix: null })]), /R1 is open without a suggested fix/);
    });
  }

  it("keeps a finding's suggested fix", () => {
    const ledger = record([finding({ severity: "advisory", status: "open", test: null, fix: "Reword the comment." })]);

    assert.equal(readLedger(repo, ledger.key)?.findings[0]?.fix, "Reword the comment.");
  });

  it("refuses a severity that isn't critical, warning or advisory", () => {
    assert.throws(() => record([finding({ severity: "minor" as Finding["severity"] })]), /severity/);
  });

  // Triage decides every finding's security mark, so a weakness misgraded
  // under a lens that doesn't say security is still held back (a real review's case).
  it("refuses a finding without its security decision", () => {
    const { security: _, ...undecided } = finding();

    assert.throws(() => record([undecided as Finding]), /security/);
  });

  for (const severity of ["critical", "advisory"] as const) {
    it(`refuses a ${severity} finding marked security, since a security weakness is graded warning`, () => {
      assert.throws(() => record([finding({ severity, security: true, status: "open", test: null })]), /R1 is a security weakness: grade it warning/);
    });
  }

  it("records a Warning marked security, which blocks and which the notes only count", () => {
    const ledger = record([finding({ severity: "warning", security: true, status: "open", test: null })]);

    assert.equal(readLedger(repo, ledger.key)?.findings[0]?.security, true);
    assert.match(checkReview(repo, mergeBase(repo), {}).message, /R1 warning/);
  });

  it("refuses findings that share an id", () => {
    assert.throws(() => record([finding(), finding()]), /repeat: R1/);
  });

  it("refuses while another review command holds the ledger's lock", () => {
    const key = diffKey(repo, mergeBase(repo));
    mkdirSync(ledgerDir(repo), { recursive: true });
    writeFileSync(join(ledgerDir(repo), ".lock"), "held");

    assert.throws(() => record([]), /another review command/);
    assert.equal(readFileSync(join(ledgerDir(repo), ".lock"), "utf8"), "held");
  });

  it("reads the ids taken while it holds the lock, so no other record writes in between", () => {
    let locked: boolean | undefined;
    const taken = (...args: Parameters<typeof takenIds>) => {
      locked = existsSync(join(ledgerDir(repo), ".lock"));
      return takenIds(...args);
    };

    recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, findings: [] }, undefined, taken);

    assert.equal(locked, true);
  });

  it("refuses while another review command holds the lock, though it records another diff, since both read every review's ids", () => {
    record([]);
    writeFileSync(join(ledgerDir(repo), ".lock"), "");
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.throws(() => record([]), /another review command/);
  });

  it("keeps ledgers readable only by their owner, in a folder only they can open", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(ledgerDir(repo)).mode & 0o777, 0o700);

    chmodSync(ledgerDir(repo), 0o755);
    acceptFinding(repo, mergeBase(repo), "R1", "Fine.");

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(ledgerDir(repo)).mode & 0o777, 0o700);
  });

  it("leaves no lock or temporary file behind", () => {
    const ledger = record([]);

    assert.deepEqual(readdirSync(ledgerDir(repo)), [`${ledger.key}.json`]);
  });

  it("replaces a ledger with a new file rather than rewriting it in place, so a reader never sees half of one", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    const before = statSync(path).ino;
    const copy = join(root, "hard-link.json");
    linkSync(path, copy);

    acceptFinding(repo, mergeBase(repo), "R1", "Fine.");

    assert.notEqual(statSync(path).ino, before);
    assert.match(readFileSync(copy, "utf8"), /"open"/);
  });

  it("is shared by every worktree of the clone", () => {
    record([]);
    const other = join(root, "other");
    run(repo, "worktree", "add", "--quiet", "--detach", other, "HEAD");

    assert.equal(checkReview(other, mergeBase(other), {}).ok, true);
  });
});

describe("ledgerDir", () => {
  it("finds the clone's .git from a worktree, whose .git file names its folder by an absolute or a relative path", () => {
    const other = join(root, "other");
    run(repo, "worktree", "add", "--quiet", "--detach", other, "HEAD");
    assert.equal(realpathSync(ledgerDir(other).replace(/\/review$/, "")), join(repo, ".git"));

    writeFileSync(join(other, ".git"), "gitdir: ../repo/.git/worktrees/other\n");

    assert.equal(realpathSync(ledgerDir(other).replace(/\/review$/, "")), join(repo, ".git"));
  });
});

describe("acceptFinding", () => {
  it("accepts an open finding with the person's reason, so the check passes", () => {
    record([finding({ status: "open", test: null })], 3);

    acceptFinding(repo, mergeBase(repo), "R1", "The spec asks for it; tracked in #81.");

    const ledger = readLedger(repo, diffKey(repo, mergeBase(repo)));
    assert.equal(ledger?.findings[0]?.status, "accepted");
    assert.equal(ledger?.findings[0]?.reason, "The spec asks for it; tracked in #81.");
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("refuses a finding that is already fixed", () => {
    record([finding()]);

    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /already fixed/);
  });

  it("refuses an empty reason", () => {
    record([finding({ status: "open", test: null })]);

    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "  "), /say why/);
  });

  it("refuses when no review is recorded for the diff", () => {
    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /no review is recorded/);
  });

  it("refuses while another review command holds the ledger's lock", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    writeFileSync(join(ledgerDir(repo), ".lock"), "");

    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /another review command/);
  });

  it("releases the lock when it refuses, so the next command can run", () => {
    record([finding(), finding({ id: "R2", status: "open", test: null })]);
    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /already fixed/);

    assert.equal(readdirSync(ledgerDir(repo)).filter((name) => name.endsWith(".lock")).length, 0);
    assert.doesNotThrow(() => acceptFinding(repo, mergeBase(repo), "R2", "why"));
  });
});

describe("latestLedger", () => {
  it("returns the review nearest HEAD after fix commits changed the key", () => {
    record([finding({ status: "accepted", test: null, reason: "First." })], 1, new Date("2026-10-20T10:00:00Z"));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 1" : undefined)), "fix 1");
    record([finding({ id: "R2", status: "accepted", test: null, reason: "Second." })], 1, new Date("2026-10-20T09:00:00Z"));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 2" : undefined)), "fix 2");

    assert.equal(nearest()?.findings[0]?.reason, "Second.");
  });

  it("finds it after a rename, since the commits are the same work", () => {
    record([finding({ status: "accepted", test: null, reason: "Before the rename." })]);
    run(repo, "branch", "-m", "chore/renamed-branch");
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.equal(nearest()?.findings[0]?.reason, "Before the rename.");
  });

  it("ignores a review from an earlier branch of the same name that HEAD doesn't contain", () => {
    record([finding({ status: "accepted", test: null, reason: "Old branch." })]);
    run(repo, "switch", "--quiet", "-C", "feature/1-thing", "origin/main");
    commit(repo, "other.cs", "new work\n", "new branch, same name");

    assert.equal(nearest(), undefined);
  });

  it("ignores a review at a commit main already has", () => {
    record([finding({ status: "accepted", test: null, reason: "Merged long ago." })]);
    run(upstream, "fetch", "--quiet", repo, "feature/1-thing:merged");
    run(upstream, "merge", "--quiet", "--ff-only", "merged");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "switch", "--quiet", "-c", "feature/2-next", "origin/main");
    commit(repo, "other.cs", "next\n", "next work");

    assert.equal(nearest(), undefined);
  });

  it("returns nothing when no review was ever recorded", () => {
    assert.equal(nearest(), undefined);
  });

  it("skips a file in the review folder that doesn't parse", () => {
    record([finding({ status: "accepted", test: null, reason: "Kept." })]);
    writeFileSync(join(ledgerDir(repo), "broken.json"), '{"version": 1, "key":');
    mkdirSync(join(ledgerDir(repo), "folder.json"));

    assert.equal(nearest()?.findings[0]?.reason, "Kept.");
  });
});

describe("renderReport", () => {
  it("says which agent reviewed, or that none was recorded", () => {
    const named = recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, reviewerAgent: "general-purpose", findings: [] });
    assert.equal(named.reviewerAgent, "general-purpose");
    assert.match(renderReport(named), /reviewed by general-purpose\./);
    assert.match(renderReport(record([finding()])), /reviewed by an unrecorded agent\./);
  });

  it("refuses a reviewerAgent that isn't an agent type name", () => {
    for (const reviewerAgent of ["", "two words", "a|b", "x\ny", "-lead", "a".repeat(65), "www.evil.example", "a:", ":b", "a:b:c"]) {
      assert.throws(() => recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, reviewerAgent, findings: [] }), /agent type name/, reviewerAgent);
    }
  });

  it("records a plugin agent type, and the notes break a cross-reference in it", () => {
    const ledger = recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, reviewerAgent: "my-plugin:GH-12", findings: [] });

    assert.equal(ledger.reviewerAgent, "my-plugin:GH-12");
    assert.doesNotMatch(renderReport(ledger), /GH-12/);
    assert.doesNotMatch(renderReviewNotes(ledger), /GH-12/);
  });

  it("writes Review notes for a stand-in reviewer even when nothing was accepted, and none for the pre-push-reviewer", () => {
    const standIn = recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, reviewerAgent: "general-purpose", findings: [] });
    assert.match(renderReviewNotes(standIn), /^<!-- review-notes -->\n## Review notes\n[\s\S]*Reviewed by general-purpose, not the read-only pre-push-reviewer\./);

    const proper = recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, reviewerAgent: "pre-push-reviewer", findings: [] });
    assert.equal(renderReviewNotes(proper), "");
    assert.equal(renderReviewNotes(record([])), "");
  });

  it("names a stand-in reviewer beside an accepted finding that the notes list", () => {
    recordReview(repo, mergeBase(repo), {
      ...reviewed(),
      rounds: 1,
      reviewerAgent: "general-purpose",
      findings: [finding({ id: "R2", severity: "advisory", security: false, status: "open", test: null, reason: null, fix: "Do it." })],
    });
    const notes = renderReviewNotes(acceptFinding(repo, mergeBase(repo), "R2", "Spec."));

    assert.match(notes, /were accepted, not changed/);
    assert.match(notes, /Accepted: Spec\./);
    assert.match(notes, /Reviewed by general-purpose, not the read-only pre-push-reviewer\./);
  });

  it("names a stand-in reviewer in the Review notes, but not the pre-push-reviewer", () => {
    const accepted = (reviewerAgent: string, id: string) => {
      recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, reviewerAgent, findings: [finding({ id, status: "open", test: null, reason: null, fix: "Do it.", severity: "warning" })] });
      return renderReviewNotes(acceptFinding(repo, mergeBase(repo), id, "Fine."));
    };

    assert.match(accepted("general-purpose", "R1"), /Reviewed by general-purpose, not the read-only pre-push-reviewer\./);
    assert.doesNotMatch(accepted("pre-push-reviewer", "R2"), /Reviewed by/);
  });

  it("lists every finding with its status and its test or reason, with pipes escaped", () => {
    const ledger = record([finding({ summary: "a | b" }), finding({ id: "R2", status: "accepted", test: null, reason: "Spec." })], 2);

    const report = renderReport(ledger);

    assert.match(report, /2 round\(s\), 2 finding\(s\)/);
    assert.match(report, /\| R1 \| Edge cases \| app\.cs:3 \| a \\\| b \| fixed \| tests\/AppTests\.cs::Guard_WhitespaceEmail_Fails \|/);
    assert.match(report, /\| R2 .* \| accepted \| Spec\. \|/);
  });

  it("groups the findings by severity, Critical first, then Warning, then Advisory", () => {
    const report = renderReport(
      record([finding({ severity: "advisory", status: "open", test: null }), finding({ id: "R2" }), finding({ id: "R3", severity: "warning", status: "open", test: null })]),
    );

    const sections = report.split(/^### /m).slice(1);
    assert.deepEqual(
      sections.map((section) => section.split("\n")[0]),
      ["Critical", "Warning", "Advisory"],
    );
    assert.deepEqual(
      sections.map((section) => [...section.matchAll(/^\| (R\d+) \|/gm)].map((match) => match[1])),
      [["R2"], ["R3"], ["R1"]],
    );
  });

  it("leaves out a severity no finding has", () => {
    const report = renderReport(record([finding()]));

    assert.match(report, /^### Critical$/m);
    assert.doesNotMatch(report, /^### (Warning|Advisory)$/m);
  });

  it("marks every Warning as security, so a person can see what the notes will leave out", () => {
    const report = renderReport(record([finding({ severity: "warning" }), finding({ id: "R2" })]));

    assert.match(report, /\| R1 \| Edge cases \(security\) \|/);
    assert.match(report, /\| R2 \| Edge cases \|/);
  });

  it("marks a finding whose lens names security as security, whatever its severity, as the notes hold it back", () => {
    const report = renderReport(record([finding({ lens: "Security", severity: "critical" })]));

    assert.match(report, /\| R1 \| Security \(security\) \|/);
  });

  it("shows a stored finding with no severity under Warning, as the check treats it, marked security unless its old mark said it isn't", () => {
    const { severity: _, fix: _fix, security: _security, ...ungraded } = finding();
    const ledger: Ledger = { ...record([]), findings: [{ ...ungraded, security: false }, { ...ungraded, id: "R2" }] };

    const report = renderReport(ledger);

    assert.match(report, /^### Warning$/m);
    assert.match(report, /\| R1 \| Edge cases \|/);
    assert.match(report, /\| R2 \| Edge cases \(security\) \|/);
  });

  it("says there were no findings when a review found nothing", () => {
    const report = renderReport(record([]));

    assert.match(report, /0 finding\(s\)/);
    assert.match(report, /No findings\./);
  });

  it("can't mention anyone or hide text in a tag", () => {
    const ledger = record([finding({ status: "accepted", test: null, summary: "Uses <details> <!-- x -->.", reason: "@someone agreed." })]);

    const report = renderReport(ledger);

    assert.doesNotMatch(report, /<details>|<!--|@someone/);
    assert.match(report, /&lt;details>/);
  });

  it("keeps a path's mentions, references and pipes from doing anything", () => {
    const ledger = record([finding({ path: "src/@someone/a|b#12.cs", status: "accepted", test: null, reason: "Fine." })]);

    const row = renderReport(ledger).split("\n").find((line) => line.startsWith("| R1")) ?? "";
    const notes = renderReviewNotes(ledger);

    assert.equal(row.split(/(?<!\\)\|/).length, 8);
    assert.doesNotMatch(row, /@someone|#12/);
    assert.doesNotMatch(notes, /@someone|#12/);
  });

  it("names HEAD when the review was recorded on a detached HEAD", () => {
    const ledger: Ledger = { ...record([]), branch: "" };

    assert.match(renderReport(ledger), /^Review of HEAD at /);
  });

  it("keeps each finding on one row, whatever its text holds", () => {
    const ledger = record([finding({ summary: "first line\nsecond line \\| still one cell" })]);

    const rows = renderReport(ledger).split("\n").filter((line) => line.startsWith("| R1"));

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.split(/(?<!\\)\|/).length, 8);
  });
});

describe("renderReviewNotes", () => {
  it("lists only the accepted findings, under the heading the PR description uses", () => {
    const ledger = record([finding(), finding({ id: "R2", status: "accepted", test: null, reason: "Spec." })]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /^<!-- review-notes -->\n## Review notes\n/);
    assert.match(notes, /Accepted: Spec\./);
    assert.doesNotMatch(notes, /Guard_WhitespaceEmail_Fails/);
  });

  it("counts accepted security findings without listing them, whichever lens raised them, since the notes become public", () => {
    const ledger = record([
      finding({ status: "accepted", test: null, lens: "GitHub Actions", severity: "warning", summary: "A fork reaches the token.", reason: "Later." }),
      finding({ id: "R2", status: "accepted", test: null, lens: "Edge/Security", summary: "The token reaches the log.", reason: "Later." }),
      finding({ id: "R3", status: "accepted", test: null, reason: "Spec." }),
    ]);

    const notes = renderReviewNotes(ledger);

    assert.doesNotMatch(notes, /reaches the/);
    assert.match(notes, /2 accepted security finding\(s\) are left out here and reported privately/);
    assert.match(notes, /Accepted: Spec\./);
  });

  it("lists accepted Critical and Advisory findings and only counts Warnings", () => {
    const ledger = record([
      finding({ status: "accepted", test: null, summary: "A critical bug.", reason: "Spec." }),
      finding({ id: "R2", severity: "advisory", status: "accepted", test: null, summary: "A stale comment.", reason: "Fine." }),
      finding({ id: "R3", severity: "warning", status: "accepted", test: null, summary: "A weak permission.", reason: "Later." }),
    ]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /A critical bug\. Accepted: Spec\./);
    assert.match(notes, /A stale comment\. Accepted: Fine\./);
    assert.doesNotMatch(notes, /weak permission/);
    assert.match(notes, /1 accepted security finding/);
  });

  it("leaves out an open Advisory finding, which goes to the follow-up issue instead", () => {
    const ledger = record([finding({ severity: "advisory", status: "open", test: null, summary: "A stale comment." })]);

    assert.equal(renderReviewNotes(ledger), "");
  });

  it("lists an accepted stored finding with no severity whose old mark said it isn't a security weakness", () => {
    const { severity: _, fix: _fix, ...old } = finding({ status: "accepted", test: null, summary: "An old finding.", reason: "Spec." });
    const ledger: Ledger = { ...record([]), findings: [{ ...old, security: false }] };

    assert.match(renderReviewNotes(ledger), /An old finding\. Accepted: Spec\./);
    assert.doesNotMatch(renderReviewNotes(ledger), /accepted security finding/);
  });

  it("counts a stored finding with neither a severity nor a security mark, since nobody decided it isn't one", () => {
    const { severity: _, fix: _fix, security: _security, ...unmarked } = finding({ status: "accepted", test: null, summary: "An unmarked finding.", reason: "Later." });
    const ledger: Ledger = { ...record([]), findings: [unmarked] };

    assert.doesNotMatch(renderReviewNotes(ledger), /unmarked finding/);
    assert.match(renderReviewNotes(ledger), /1 accepted security finding/);
  });

  it("counts an accepted Critical finding with no security decision, since nobody decided it isn't one", () => {
    const { security: _, ...undecided } = finding({ lens: "GitHub Actions", status: "accepted", test: null, summary: "A fork reaches the token.", reason: "Later." });
    const ledger: Ledger = { ...record([]), findings: [undecided] };

    assert.doesNotMatch(renderReviewNotes(ledger), /reaches the token/);
    assert.match(renderReviewNotes(ledger), /1 accepted security finding/);
  });

  // A ledger recorded before severity existed marks its security findings
  // with security: true alone. record refuses a Critical one marked so, but a
  // hand-edited ledger, or one an earlier build wrote, can hold one.
  for (const severity of [undefined, "critical"] as const) {
    it(`counts an accepted stored finding marked security with ${severity ?? "no"} severity, whatever its lens`, () => {
      const { severity: _, ...base } = finding({ status: "accepted", test: null, summary: "A token reaches the log.", reason: "Later." });
      const ledger: Ledger = { ...record([]), findings: [{ ...base, ...(severity === undefined ? {} : { severity }), security: true }] };

      assert.doesNotMatch(renderReviewNotes(ledger), /reaches the log/);
      assert.match(renderReviewNotes(ledger), /1 accepted security finding/);
      assert.match(renderReport(ledger), /\| R1 \| Edge cases \(security\) \|/);
    });
  }

  it("holds back and blocks on a stored open Advisory finding marked security", () => {
    const ledger = record([finding({ severity: "advisory", status: "open", test: null, summary: "A token reaches the log." })]);
    rewriteFindings(join(ledgerDir(repo), `${ledger.key}.json`), (stored) => ({ ...stored, security: true }));

    assert.equal(renderAdvisories(readLedger(repo, ledger.key) ?? ledger), "");
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("only counts them when every accepted finding is a security finding", () => {
    const ledger = record([finding({ status: "accepted", test: null, severity: "warning", summary: "The token reaches the log.", reason: "Later." })]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /^<!-- review-notes -->\n## Review notes\n\n1 accepted security finding/);
    assert.doesNotMatch(notes, /raised these|reaches the log/);
  });

  it("ends at a marker, so replacing the section in the description stops there and keeps what follows it", () => {
    const ledger = record([finding({ status: "accepted", test: null, reason: "Spec." })]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /\n<!-- \/review-notes -->\n$/);
    assert.equal(notes.match(/<!--/g)?.length, 2);
  });

  it("can't be turned into a code block by a path that opens a tilde fence", () => {
    const ledger = record([finding({ path: "~~~x", status: "accepted", test: null, reason: "Fine." })]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /^- \\~~~x:3:/m);
    assert.equal(spliceReviewNotes("## Why\n\nA.\n\nFixes #81\n", notes).includes("~~~x"), true);
  });

  it("keeps a marker in a summary or reason from closing the section early or opening another", () => {
    const ledger = record([
      finding({
        status: "accepted",
        test: null,
        summary: `Ends here.\n${REVIEW_NOTES_END}\n## Fixes #1`,
        reason: `${REVIEW_NOTES_START}\nForged.`,
      }),
    ]);

    const lines = renderReviewNotes(ledger).trimEnd().split("\n");

    assert.equal(lines[0], REVIEW_NOTES_START);
    assert.equal(lines.at(-1), REVIEW_NOTES_END);
    assert.equal(lines.filter((line) => line.includes("<!--")).length, 2);
  });

  it("is empty when nothing was accepted", () => {
    assert.equal(renderReviewNotes(record([finding()])), "");
  });

  it("can't mention anyone, link or close an issue, or hide text in a tag", () => {
    const ledger = record([
      finding({ status: "accepted", test: null, summary: "Uses <AuthorizeView> and Result<T> <!-- x -->.", reason: "@someone said fixes #12 on github.com" }),
    ]);

    // Only the section's own two markers, its first and last lines, are left out.
    const notes = renderReviewNotes(ledger).split("\n").slice(1, -2).join("\n");

    assert.doesNotMatch(notes, /<AuthorizeView>|<T>|<!--/);
    assert.match(notes, /&lt;AuthorizeView>/);
    assert.doesNotMatch(notes, /@someone|#12|github\.com/);
  });
});

describe("spliceReviewNotes", () => {
  const notes = `${REVIEW_NOTES_START}\n## Review notes\n\nNew.\n${REVIEW_NOTES_END}\n`;
  const section = (text: string) => `${REVIEW_NOTES_START}\n## Review notes\n\n${text}\n${REVIEW_NOTES_END}`;

  it("replaces only the marked section, keeping what follows it", () => {
    const body = `## Why\n\nA.\n\n${section("Old.")}\n\nFixes #81\n\n🤖 Footer\n`;

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n\n🤖 Footer\n`);
  });

  it("removes the marked section when nothing is accepted any more", () => {
    const body = `## Why\n\nA.\n\n${section("Old.")}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, ""), "## Why\n\nA.\n\nFixes #81\n");
  });

  it("adds the section above the closing line when the body has none", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.\n\nFixes #81\n", notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("adds the section above the footer when the body closes no issue", () => {
    assert.equal(
      spliceReviewNotes("## Why\n\nA.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n", notes),
      `## Why\n\nA.\n\n${section("New.")}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`,
    );
  });

  it("adds the section at the end of a body with neither", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.\n", notes), `## Why\n\nA.\n\n${section("New.")}\n`);
  });

  it("leaves a body with no section and no notes as it is", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.\n", ""), "## Why\n\nA.\n");
  });

  it("takes a marker only as a line of its own, not one quoted in the text", () => {
    const body = `## What changed\n\nWraps it in \`${REVIEW_NOTES_START}\` and \`${REVIEW_NOTES_END}\`.\n\n${section("Old.")}\n\nFixes #81\n`;

    assert.equal(
      spliceReviewNotes(body, notes),
      `## What changed\n\nWraps it in \`${REVIEW_NOTES_START}\` and \`${REVIEW_NOTES_END}\`.\n\n${section("New.")}\n\nFixes #81\n`,
    );
  });

  it("finds the markers in a body GitHub stored with CRLF line endings", () => {
    const body = `## Why\r\n\r\nA.\r\n\r\n${section("Old.").replaceAll("\n", "\r\n")}\r\n\r\nFixes #81\r\n`;

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("removes a section at the end of the body with the blank line before it", () => {
    assert.equal(spliceReviewNotes(`## Why\n\nA.\n\n${section("Old.")}\n`, ""), "## Why\n\nA.\n");
  });

  it("gives back the body it added a section to once the section is removed", () => {
    for (const body of ["## Why\n\nA.\n", "## Why\n\nA.\n\nFixes #81\n", "## Why\n\nA.\n\n🤖 Generated with x\n"]) {
      assert.equal(spliceReviewNotes(spliceReviewNotes(body, notes), ""), body);
    }
  });

  it("adds the section above the closing line, not the footer below it", () => {
    assert.equal(
      spliceReviewNotes("## Why\n\nA.\n\nFixes #81\n\n🤖 Generated with x\n", notes),
      `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n\n🤖 Generated with x\n`,
    );
  });

  for (const closing of ["Closes #4", "resolves #4"]) {
    it(`takes "${closing}" as the closing line too`, () => {
      assert.equal(spliceReviewNotes(`## Why\n\nA.\n\n${closing}\n`, notes), `## Why\n\nA.\n\n${section("New.")}\n\n${closing}\n`);
    });
  }

  it("takes the last closing line that starts a paragraph, not one quoted earlier or wrapped into a sentence", () => {
    const body = "## Why\n\nFixes #12 was\nresolves #40 too.\n\nFixes #12\nalso.\n\nFixes #81\n";

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nFixes #12 was\nresolves #40 too.\n\nFixes #12\nalso.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("ignores markers, a heading and a closing line shown in a code block", () => {
    const example = `\`\`\`markdown\n${section("Example.")}\n## Review notes\nFixes #1\n\`\`\``;
    const body = `## What changed\n\n${example}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), `## What changed\n\n${example}\n\n${section("New.")}\n\nFixes #81\n`);
    assert.equal(spliceReviewNotes(`${body.replace("Fixes #81\n", "")}${section("Old.")}\n\nFixes #81\n`, ""), body);
  });

  it("takes a line that opens with a code span of three backticks for text, not a code block", () => {
    const body = `## Verification\n\n\`\`\`pnpm test\`\`\` passes.\n\n${section("Old.")}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), body.replace(section("Old."), section("New.")));
  });

  it("sees a code block that opens on a list item's line close, rather than take its closing fence for an opening one", () => {
    const body = `## Verification\n\n1. \`\`\`bash\n   scripts/gate.sh\n   \`\`\`\n\n${section("Old.")}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), body.replace(section("Old."), section("New.")));
  });

  it("takes a marker with trailing spaces, as an editor may leave it, for the marker", () => {
    const body = `## Why\n\nA.\n\n${section("Old.").replace(REVIEW_NOTES_END, `${REVIEW_NOTES_END}  `)}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("doesn't take an indented marker, which shows as code, for the marker", () => {
    const body = `## What changed\n\n    ${REVIEW_NOTES_START}\n    ${REVIEW_NOTES_END}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), body.replace("Fixes #81", `${section("New.")}\n\nFixes #81`));
  });

  it("adds the section above a closing line that is the body's first line", () => {
    assert.equal(spliceReviewNotes("Fixes #81\n", notes), `${section("New.")}\n\nFixes #81\n`);
  });

  it("ignores a marked example in a ~~~ block, which a ``` line inside it doesn't close", () => {
    const example = `~~~markdown\n\`\`\`\n${section("Example.")}\n~~~`;
    const body = `## What changed\n\n${example}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), `## What changed\n\n${example}\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("closes a longer fence only with one at least as long", () => {
    const example = `\`\`\`\`markdown\n\`\`\`\n${section("Example.")}\n\`\`\`\`\n`;
    const body = `## What changed\n\n${example}\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), `## What changed\n\n${example}\n${section("New.")}\n\nFixes #81\n`);
  });

  it("refuses to publish an empty description when the section was all the body held", () => {
    assert.throws(() => spliceReviewNotes(`${section("Old.")}\n`, ""), /empty/);
  });

  it("removes a section at the very start of the body without leaving a gap", () => {
    assert.equal(spliceReviewNotes(`${section("Old.")}\n\n## Why\n\nA.\n`, ""), "## Why\n\nA.\n");
  });

  it("removes a section whose neighbours are text on the next line, with no blank line either side", () => {
    assert.equal(spliceReviewNotes(`## Why\nA.\n${section("Old.")}\nFixes #81\n`, ""), "## Why\nA.\nFixes #81\n");
  });

  it("reads a body whose line endings are lone carriage returns", () => {
    const body = `## Why\r\rA.\r\r${section("Old.").replaceAll("\n", "\r")}\r\rFixes #81\r`;

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("takes notes with no trailing newline the same as notes with one", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.\n", notes.trimEnd()), spliceReviewNotes("## Why\n\nA.\n", notes));
  });

  it("takes a body with no trailing newline the same as one with it", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.", notes), spliceReviewNotes("## Why\n\nA.\n", notes));
  });

  it("closes a fence with a longer one, and doesn't close it with one followed by text", () => {
    const closed = `\`\`\`markdown\n${section("Example.")}\n\`\`\`\`\`\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(closed, notes), closed.replace("Fixes #81", `${section("New.")}\n\nFixes #81`));
    assert.throws(() => spliceReviewNotes(`\`\`\`markdown\n\`\`\` not a closer\n${section("Old.")}\n`, notes), /never closes/);
  });

  it("lets a line that mentions review notes in the middle of a sentence stand", () => {
    const body = "## Why\n\nSee the review notes below.\nThey were agreed.\n\nFixes #81\n";

    assert.equal(spliceReviewNotes(body, notes), body.replace("Fixes #81", `${section("New.")}\n\nFixes #81`));
  });

  it("lets a heading about something else, with similar words, stand", () => {
    const body = "## Reviewing the notes\n\nA.\n\n## Preview\n\nB.\n\nFixes #81\n";

    assert.equal(spliceReviewNotes(body, notes), body.replace("Fixes #81", `${section("New.")}\n\nFixes #81`));
  });

  it("ends the result in one newline, however many the body ended in", () => {
    const once = spliceReviewNotes("## Why\n\nA.\n", notes);

    assert.equal(spliceReviewNotes(`${once}\n\n`, notes), once);
  });

  for (const [shape, body] of [
    ["an empty body", ""],
    ["a body of only whitespace", " \n\n"],
    ["a Review notes heading indented and closed with hashes", "## Why\n\n   ## Review notes ##\n\nOld.\n"],
    ["a Review notes heading in emphasis with a colon", "## Why\n\n## **Review notes:**\n\nOld.\n"],
    ["a setext Review notes heading", "## Why\n\nReview notes\n---\n\nOld.\n"],
    ["an HTML Review notes heading", "## Why\n\n<h2>Review notes</h2>\n\nOld.\n"],
    ["an escaped tag-shaped Review notes heading", "## Why\n\n## \\<Review notes>\n\nOld.\n"],
    ["a Review notes heading made of an image", '## Why\n\n<h2><img alt="Review notes" src="x"></h2>\n\nOld.\n'],
    ["a Review notes heading after a comment that closes at once", "## Why\n\n<!--><h2>Review notes</h2><!-- -->\n\nOld.\n"],
    ["a Review notes heading in the form of a declaration", "## Why\n\n## <! Review notes>\n\nOld.\n"],
    ["a Review notes heading in the form of a processing instruction", "## Why\n\n## <? Review notes >\n\nOld.\n"],
    ["a Review notes heading in an unclosed comment", "## Why\n\n## <!-- Review notes >\n\nOld.\n"],
    ["a Review notes heading after a comment closed by --!>", "## Why\n\n<!-- x --!><h2>Review notes</h2><!-- -->\n\nOld.\n"],
    ["a Review notes heading made of a tag only a browser reads", "## Why\n\n<h2><x_>Review notes</h2>\n\nOld.\n"],
    ["a Review notes heading across a blockquote's line", "## Why\n\n> <h2 class=x\n> id=y>Review notes</h2>\n\nOld.\n"],
    ["an HTML Review notes heading with an attribute", '## Why\n\n<h2 align="left">Review notes</h2>\n\nOld.\n'],
    ["an HTML Review notes heading with an id", '## Why\n\n<h2 id="notes">Review notes</h2>\n\nOld.\n'],
    ["a Review notes heading inside a span with a title", '## Why\n\n## <span title="x">Review notes</span>\n\nOld.\n'],
    ["a setext Review notes heading underlined with =", "## Why\n\nReview notes\n===\n\nOld.\n"],
    ["a Review notes heading in a quote", "## Why\n\n> ## Review notes\n\nOld.\n"],
    ["a Review notes heading in a list item", "## Why\n\n- ## Review notes\n\nOld.\n"],
    ["emphasis on one word of a Review notes heading", "## Why\n\n## **Review** notes\n\nOld.\n"],
    ["a Review notes heading with more words after it", "## Why\n\n## Review notes (round 2)\n\nOld.\n"],
    ["a character reference in a Review notes heading", "## Why\n\n## Re&#118;iew&#32;notes\n\nOld.\n"],
    ["an invisible character in a Review notes heading", "## Why\n\n## Review\u200e\u034f notes\n\nOld.\n"],
    ["an unmarked Review notes heading beside a marked section", `## Review notes\n\nOld.\n\n${section("Old.")}\n`],
    ["an unmarked Review notes heading after a marked section", `${section("Old.")}\n\n## Review notes\n\nOld.\n`],
    ["a setext Review notes heading split over two lines", "## Why\n\nReview\nnotes\n---\n\nOld.\n"],
    ["an HTML Review notes heading split over two lines", "## Why\n\n<h2>Review\nnotes</h2>\n\nOld.\n"],
    ["a closing line inside the marked section", `${section("Old.\n\nFixes #81")}\n`],
    ["the footer inside the marked section", `${section("Old.\n\n🤖 Generated with x")}\n`],
    ["a code block that never closes", `## Why\n\n\`\`\`\n${section("Old.")}\n`],
    ["an end marker with no start", `## Why\n\n${REVIEW_NOTES_END}\n`],
    ["two marked sections", `${section("A.")}\n\n${section("B.")}\n`],
    ["a start marker with no end", `${REVIEW_NOTES_START}\n## Review notes\n\nFixes #81\n`],
    ["an end marker before the start", `${REVIEW_NOTES_END}\n\n${REVIEW_NOTES_START}\n`],
    ["a Review notes section written before the markers", "## Why\n\nA.\n\n## Review notes\n\nOld.\n\nFixes #81\n"],
  ] as const) {
    it(`refuses a body with ${shape}, rather than guess where the section ends`, () => {
      assert.throws(() => spliceReviewNotes(body, notes), /ask the person/);
    });
  }
});

describe("renderAdvisories", () => {
  it("lists each open Advisory finding with where it is, what goes wrong and the suggested fix, ending with the session marker", () => {
    const ledger = record([
      finding({ id: "R2", severity: "advisory", status: "open", test: null, summary: "The comment is stale.", fix: "Reword it." }),
      finding({ id: "R3", severity: "advisory", status: "open", test: null, summary: "A list misses a check.", fix: "Add it." }),
    ]);

    const body = renderAdvisories(ledger);

    assert.match(body, /^- R2 app\.cs:3: The comment is stale\. Suggested fix: Reword it\.$/m);
    assert.match(body, /^- R3 app\.cs:3: A list misses a check\. Suggested fix: Add it\.$/m);
    assert.match(body, /<!-- claude-session -->\n$/);
  });

  it("opens with the branch it was reviewed on, the line step 9 keeps on a comment", () => {
    const body = renderAdvisories(record([finding({ severity: "advisory", status: "open", test: null })]));

    assert.equal(body.split("\n")[0], "Advisory findings from the local review of feature/1-thing, left for a follow-up:");
  });

  it("can't mention anyone or link an issue through a finding's path or the branch's name", () => {
    const ledger: Ledger = {
      ...record([finding({ path: "src/@someone/a#12.cs", severity: "advisory", status: "open", test: null })]),
      branch: "feature/1-@someone-#12",
    };

    const body = renderAdvisories(ledger);

    assert.match(body, /^- R1 /m);
    assert.doesNotMatch(body.replace(/<!-- claude-session -->\n$/, ""), /@someone|#12|<!--/);
  });

  it("names HEAD for a ledger recorded on a detached HEAD", () => {
    const ledger: Ledger = { ...record([finding({ severity: "advisory", status: "open", test: null })]), branch: "" };

    assert.equal(renderAdvisories(ledger).split("\n")[0], "Advisory findings from the local review of HEAD, left for a follow-up:");
  });

  it("ends a stored finding with no suggested fix at its summary", () => {
    const { fix: _, ...fixless } = finding({ severity: "advisory", status: "open", test: null, summary: "An old one." });
    const ledger: Ledger = { ...record([]), findings: [fixless] };

    assert.match(renderAdvisories(ledger), /^- R1 app\.cs:3: An old one\.$/m);
  });

  it("leaves out every finding that isn't an open Advisory one", () => {
    const ledger = record([
      finding({ summary: "A fixed bug." }),
      finding({ id: "R2", severity: "warning", status: "open", test: null, summary: "A weak permission." }),
      finding({ id: "R3", severity: "advisory", status: "dismissed", test: null, reason: "Wrong.", summary: "A dismissed one." }),
      finding({ id: "R4", severity: "advisory", status: "accepted", test: null, reason: "Fine.", summary: "An accepted one." }),
      finding({ id: "R5", severity: "critical", status: "open", test: null, summary: "Left for a person." }),
    ]);

    assert.equal(renderAdvisories(ledger), "");
  });

  it("leaves out a stored Advisory finding whose lens names security, though record no longer takes one", () => {
    const ledger: Ledger = { ...record([]), findings: [{ ...finding({ severity: "advisory", status: "open", test: null, summary: "A token leaks." }), lens: "Security" }] };

    assert.equal(renderAdvisories(ledger), "");
  });

  it("leaves out a stored Advisory finding with no security decision, whatever its lens", () => {
    const { security: _, ...undecided } = finding({ lens: "GitHub Actions", severity: "advisory", status: "open", test: null, summary: "A fork reaches the token." });
    const ledger: Ledger = { ...record([]), findings: [undecided] };

    assert.equal(renderAdvisories(ledger), "");
  });

  it("can't mention anyone, link or close an issue, or hide text in a tag", () => {
    const ledger = record([
      finding({ severity: "advisory", status: "open", test: null, summary: "Uses <!-- sandcastle:x --> for @someone", fix: "fixes #12 on github.com" }),
    ]);

    const body = renderAdvisories(ledger);

    assert.doesNotMatch(body.replace(/<!-- claude-session -->\n$/, ""), /<!--|@someone|#12|github\.com/);
  });
});

describe("main", () => {
  it("check exits 1 with no review recorded, and 0 once a clean one is", () => {
    assert.equal(cli(["check"]).code, 1);

    record([]);

    assert.equal(cli(["check"]).code, 0);
  });

  it("check exits 1 when there is no origin/main to diff against", () => {
    run(repo, "remote", "remove", "origin");

    const result = cli(["check"]);

    assert.equal(result.code, 1);
    assert.match(result.err, /git fetch origin main/);
  });

  it("check uses the base it's given", () => {
    record([]);
    const base = mergeBase(repo);
    run(repo, "remote", "remove", "origin");

    assert.equal(cli(["check", base]).code, 0);
  });

  it("prepare writes the diff the reviewers read and prints the key record expects", () => {
    const dir = join(root, "run");

    const result = cli(["prepare", dir]);

    assert.equal(result.code, 0);
    assert.deepEqual(result.out.trim().split("\n"), [diffKey(repo, mergeBase(repo)), run(repo, "rev-parse", "HEAD")]);
    assert.match(readFileSync(join(dir, "diff.patch"), "utf8"), /^\+changed$/m);
  });

  it("prepare given the HEAD an earlier round read also writes the diff of the fixes since, beside the whole diff", () => {
    const dir = join(root, "run");
    const before = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";
    commit(repo, "other.cs", "fixed\n", "fix");

    const result = cli(["prepare", dir, before]);

    assert.equal(result.code, 0, result.err);
    const fixes = readFileSync(join(dir, "fixes.patch"), "utf8");
    assert.match(fixes, /^\+fixed$/m);
    assert.doesNotMatch(fixes, /^\+changed$/m);
    assert.match(readFileSync(join(dir, "diff.patch"), "utf8"), /^\+changed$/m);
    assert.deepEqual(result.out.trim().split("\n"), [diffKey(repo, mergeBase(repo)), run(repo, "rev-parse", "HEAD")]);
  });

  it("prepare refuses an earlier HEAD that isn't one of HEAD's commits, whose diff would hold more than the fixes", () => {
    run(repo, "switch", "--quiet", "-c", "elsewhere", "origin/main");
    commit(repo, "other.cs", "elsewhere\n", "elsewhere");
    const elsewhere = run(repo, "rev-parse", "HEAD");
    run(repo, "switch", "--quiet", "feature/1-thing");

    const result = cli(["prepare", join(root, "run"), elsewhere]);

    assert.equal(result.code, 1);
    assert.match(result.err, /isn't one of HEAD's commits/);
    assert.equal(existsSync(join(root, "run", "fixes.patch")), false);
  });

  // An amend or a rebase replaces the commit the round before printed, so no
  // commit gives the fixes alone: the review starts again.
  it("prepare tells a later round to start again at round 1 after the HEAD it printed was amended", () => {
    const dir = join(root, "run");
    const before = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";
    run(repo, "commit", "--amend", "--quiet", "--allow-empty", "-m", "amended");

    const result = cli(["prepare", dir, before]);

    assert.equal(result.code, 1);
    assert.match(result.err, /After an amend or a rebase there's none: start again at round 1/);
  });

  it("prepare refuses the HEAD it just printed when nothing was committed since, whose fixes patch would be empty", () => {
    const dir = join(root, "run");
    const before = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";

    const result = cli(["prepare", dir, before]);

    assert.equal(result.code, 1);
    assert.match(result.err, /no fixes since/);
    assert.equal(existsSync(join(dir, "fixes.patch")), false);
  });

  it("prepare refuses a commit that isn't the HEAD the round before printed, so no fix goes unread", () => {
    const dir = join(root, "run");
    cli(["prepare", dir]);
    commit(repo, "other.cs", "first fix\n", "first fix");
    const afterFirst = run(repo, "rev-parse", "HEAD");
    commit(repo, "other.cs", "second fix\n", "second fix");

    const result = cli(["prepare", dir, afterFirst]);

    assert.equal(result.code, 1);
    assert.match(result.err, /later than the HEAD prepare printed in the round before/);
    assert.equal(existsSync(join(dir, "fixes.patch")), false);
  });

  it("prepare takes the same since again when a round is prepared twice, and its fixes patch then holds every commit since", () => {
    const dir = join(root, "run");
    const first = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";
    commit(repo, "other.cs", "first fix\n", "first fix");
    assert.equal(cli(["prepare", dir, first]).code, 0);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "second fix" : undefined)), "second fix");

    const result = cli(["prepare", dir, first]);

    assert.equal(result.code, 0, result.err);
    const fixes = readFileSync(join(dir, "fixes.patch"), "utf8");
    assert.match(fixes, /^\+first fix$/m);
    assert.match(fixes, /^\+second fix$/m);
  });

  it("prepare follows the rounds: a third round's fixes patch holds only the fixes since the second", () => {
    const dir = join(root, "run");
    const first = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";
    commit(repo, "other.cs", "first fix\n", "first fix");
    const second = cli(["prepare", dir, first]).out.trim().split("\n")[1] ?? "";
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "second fix" : undefined)), "second fix");

    const result = cli(["prepare", dir, second]);

    assert.equal(result.code, 0, result.err);
    const fixes = readFileSync(join(dir, "fixes.patch"), "utf8");
    assert.match(fixes, /^\+second fix$/m);
    assert.doesNotMatch(fixes, /first fix/);
  });

  it("prepare refuses a later round in a folder no round was prepared in", () => {
    const since = run(repo, "rev-parse", "HEAD");
    commit(repo, "other.cs", "fixed\n", "fix");
    const dir = join(root, "run");

    const result = cli(["prepare", dir, since]);

    assert.equal(result.code, 1);
    assert.match(result.err, /none in this folder/);
    assert.equal(existsSync(join(dir, "fixes.patch")), false);
  });

  for (const [what, args] of [
    ["without a since", (_since: string) => [] as string[]],
    ["with a since it refuses", (since: string) => [`${since}x`]],
  ] as const) {
    it(`prepare ${what} leaves no earlier round's fixes patch behind for the reviewers to read`, () => {
      const dir = join(root, "run");
      const first = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";
      commit(repo, "other.cs", "first fix\n", "first fix");
      assert.equal(cli(["prepare", dir, first]).code, 0);
      commit(repo, "other.cs", "second fix\n", "second fix");

      cli(["prepare", dir, ...args(first)]);

      assert.equal(existsSync(join(dir, "fixes.patch")), false);
    });
  }

  it("prepare refuses a later round after main was merged in, whose fixes patch would hold main's changes", () => {
    const dir = join(root, "run");
    const before = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";
    commit(upstream, "other.cs", "main moves on\n", "main moves on");
    mergeMain();

    const result = cli(["prepare", dir, before]);

    assert.equal(result.code, 1);
    assert.match(result.err, /main was merged in/);
    assert.equal(existsSync(join(dir, "fixes.patch")), false);
  });

  // Only a merge of main moves the branch's fork point: a fetch alone, while
  // the review runs, leaves the later round's fixes patch as it was.
  it("prepare takes a later round after a fetch moved origin/main without a merge, and its fixes patch holds only the fix", () => {
    const dir = join(root, "run");
    const before = cli(["prepare", dir]).out.trim().split("\n")[1] ?? "";
    commit(upstream, "main.cs", "main moves on\n", "main moves on");
    run(repo, "fetch", "--quiet", "origin");
    commit(repo, "fix.cs", "the fix\n", "the fix");

    const result = cli(["prepare", dir, before]);

    assert.equal(result.code, 0, result.err);
    const fixes = readFileSync(join(dir, "fixes.patch"), "utf8");
    assert.match(fixes, /the fix/);
    assert.doesNotMatch(fixes, /main moves on/);
  });

  for (const dir of ["", "relative/run"]) {
    it(`prepare refuses a folder that isn't absolute: ${JSON.stringify(dir)}`, () => {
      assert.equal(cli(["prepare", dir]).code, 1);
    });
  }

  it("accept stores every word of the reason", () => {
    record([finding({ status: "open", test: null })]);

    assert.equal(cli(["accept", "R1", "two", "words"]).code, 0);

    assert.equal(readLedger(repo, diffKey(repo, mergeBase(repo)))?.findings[0]?.reason, "two words");
  });

  it("body refuses an output that is its input under another name, and leaves the input as it was", () => {
    record([]);
    const input = join(root, "old-body.md");
    writeFileSync(input, "## Why\n\nA.\n");
    symlinkSync(input, join(root, "link.md"));

    for (const output of [join(root, "./old-body.md"), join(root, "link.md"), join(root, "sub", "..", "old-body.md")]) {
      const result = cli(["body", input, output]);

      assert.equal(result.code, 1, output);
      assert.equal(readFileSync(input, "utf8"), "## Why\n\nA.\n");
    }
  });

  it("body fails, and leaves nothing, when the output's folder doesn't exist", () => {
    record([]);
    const input = join(root, "old-body.md");
    writeFileSync(input, "## Why\n\nA.\n");
    const output = join(root, "missing", "body.md");

    const result = cli(["body", input, output]);

    assert.equal(result.code, 1);
    assert.equal(existsSync(output), false);
  });

  it("body fails when the input file doesn't exist, and leaves no output", () => {
    record([]);
    const output = join(root, "body.md");
    writeFileSync(output, "an earlier run's description\n");

    const result = cli(["body", join(root, "nope.md"), output]);

    assert.equal(result.code, 1);
    assert.equal(existsSync(output), false);
  });

  it("body names the input when the output has the same name", () => {
    const result = cli(["body", "in.md", "in.md"]);

    assert.equal(result.code, 1);
    assert.match(result.err, /is the input file/);
  });

  it("body refuses an output that exists and isn't a regular file", () => {
    record([]);
    const input = join(root, "old-body.md");
    writeFileSync(input, "## Why\n\nA.\n");
    mkdirSync(join(root, "out-dir"));

    const result = cli(["body", input, join(root, "out-dir")]);

    assert.equal(result.code, 1);
    assert.equal(existsSync(join(root, "out-dir")), true);
  });

  it("body writes the PR description from a file with its Review notes section replaced", () => {
    record([finding({ status: "accepted", test: null, reason: "Spec." })]);
    const input = join(root, "old-body.md");
    const output = join(root, "body.md");
    writeFileSync(input, "## Why\n\nA.\n\nFixes #81\n");

    const result = cli(["body", input, output]);

    assert.equal(result.code, 0, result.err);
    assert.match(readFileSync(output, "utf8"), /^## Why\n\nA\.\n\n<!-- review-notes -->\n## Review notes\n[\s\S]*Accepted: Spec\.\n<!-- \/review-notes -->\n\nFixes #81\n$/);
  });

  // Each leaves no file behind, not even an earlier run's, so a `gh pr edit
  // --body-file` after it fails rather than publish a wrong description.
  for (const [failure, body, recorded] of [
    ["a body it can't splice", "## Review notes\n\nOld.\n", true],
    ["an empty body, as a failed gh pr view leaves", "", true],
    ["no review recorded for the diff", "## Why\n\nA.\n", false],
  ] as const) {
    it(`body fails, and leaves no output file, on ${failure}`, () => {
      if (recorded) record([]);
      const input = join(root, "old-body.md");
      const output = join(root, "body.md");
      writeFileSync(input, body);
      writeFileSync(output, "an earlier run's description\n");

      const result = cli(["body", input, output]);

      assert.equal(result.code, 1);
      assert.equal(existsSync(output), false);
      assert.match(result.err, recorded ? /ask the person/ : /No review is recorded/);
    });
  }

  it("report prints the table and notes prints the Review notes", () => {
    record([finding(), finding({ id: "R2", status: "accepted", test: null, reason: "Spec." })]);

    assert.match(cli(["report"]).out, /\| Id \| Lens \|/);
    assert.match(cli(["notes"]).out, /^<!-- review-notes -->\n## Review notes/);
  });

  it("advisory prints the follow-up issue's body, or says there's none", () => {
    record([finding()]);
    assert.match(cli(["advisory"]).out, /No open Advisory findings/);

    record([finding({ id: "R2", severity: "advisory", status: "open", test: null })]);

    assert.match(cli(["advisory"]).out, /^- R2 app\.cs:3:/m);
  });

  it("latest prints the branch's earlier review after a fix commit", () => {
    record([finding({ status: "accepted", test: null, reason: "Kept." })]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.match(cli(["latest"]).out, /"Kept\."/);
  });

  for (const args of [["bogus"], [], ["record"], ["accept", "R1"], ["body"], ["body", "in.md"], ["body", "in.md", "-"]]) {
    it(`exits 1 with the usage for ${JSON.stringify(args)}`, () => {
      const result = cli(args);

      assert.equal(result.code, 1);
      assert.match(result.err, /Usage: scripts\/review\.sh/);
    });
  }

  it("report, notes and advisory exit 1 when no review is recorded", () => {
    assert.equal(cli(["report"]).code, 1);
    assert.equal(cli(["notes"]).code, 1);
    const advisory = cli(["advisory"]);
    assert.equal(advisory.code, 1);
    assert.doesNotMatch(advisory.out, /No open Advisory findings/);
  });

  it("record exits 1 with the schema's message on a review that doesn't parse", () => {
    const file = join(root, "review.json");
    writeFileSync(file, JSON.stringify({ ...reviewed(), rounds: 1, findings: [{ id: "X" }] }));

    const result = cli(["record", file]);

    assert.equal(result.code, 1);
    assert.match(result.err, /doesn't parse/);
  });

  it("latest prints {} when there is no earlier review", () => {
    assert.equal(cli(["latest"]).out.trim(), "{}");
  });

  it("next prints the first id this run may use, after every id the branch's reviews took", () => {
    assert.equal(cli(["next"]).out, "R1\n");
    record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    record([]);

    assert.equal(cli(["next"]).out, "R3\n");
  });
});

describe("scripts/review.sh", () => {
  // The gate runs these tests with GATE_SKIP_REVIEW=1 set, which the command
  // would honour.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GATE_SKIP_REVIEW"));
  const script = (cwd: string, ...args: string[]) => spawnSync("bash", [reviewScript, ...args], { cwd, encoding: "utf8", env });

  it("exits 1 on an unreviewed diff, as the gate needs", () => {
    const result = script(repo, "check", mergeBase(repo));

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No review is recorded/);
  });

  it("exits 0 once the diff was reviewed clean", () => {
    record([]);

    assert.equal(script(repo, "check", mergeBase(repo)).status, 0);
  });

  it("records a review read from stdin, as the skill does", () => {
    const input = JSON.stringify({ ...reviewed(), rounds: 1, findings: [] });

    const result = spawnSync("bash", [reviewScript, "record", "-"], { cwd: repo, encoding: "utf8", env, input });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(readLedger(repo, diffKey(repo, mergeBase(repo))));
  });

  it("splices a PR description read from stdin, as gh pr view can pipe it", () => {
    record([]);
    const output = join(root, "body.md");

    const result = spawnSync("bash", [reviewScript, "body", "-", output], { cwd: repo, encoding: "utf8", env, input: "## Why\n\nA.\n" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), "## Why\n\nA.\n");
  });

  it("works when the caller's shell sets CDPATH", () => {
    const result = spawnSync("bash", ["scripts/review.sh", "bogus"], { cwd: repoRoot, encoding: "utf8", env: { ...env, CDPATH: "." } });

    assert.match(result.stderr, /Usage: scripts\/review\.sh/);
  });

  // A repo-config.mts that exports the given names, as the Seed's does.
  const configWith = (names: string[]) => names.map((name) => `export const ${name} = ${name === "REPO_SLUG" ? '"o/r"' : "[]"};\n`).join("");

  // A copy of scripts/review.sh in a checkout with no packages, and a stub
  // pnpm (or none) on a PATH of its own. The stub logs its arguments; "works"
  // creates tsx, "no-tsx" succeeds without creating it, "fails" exits 1.
  function bareCheckout(pnpm: "works" | "no-tsx" | "fails" | "missing") {
    const checkout = join(root, "bare");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    const script = join(checkout, "scripts", "review.sh");
    writeFileSync(script, readFileSync(reviewScript, "utf8"));
    mkdirSync(join(checkout, ".sandcastle", "lib"), { recursive: true });
    writeFileSync(join(checkout, ".sandcastle", "lib", "repo-config.mts"), configWith(["REPO_SLUG", "NOT_OWNED_BASELINE_PATHS"]));
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["dirname", "mkdir", "chmod", "printf", "grep"]) {
      symlinkSync(execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
    }
    const log = join(root, "pnpm.log");
    const makeTsx = `mkdir -p "${checkout}/node_modules/.bin"\nprintf '#!/bin/sh\\necho "tsx $*"\\n' > "${checkout}/node_modules/.bin/tsx"\nchmod +x "${checkout}/node_modules/.bin/tsx"\n`;
    if (pnpm !== "missing") {
      const body = { works: `echo installing\n${makeTsx}`, "no-tsx": "echo installing\n", fails: "exit 1\n" }[pnpm];
      writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> "${log}"\n${body}`);
      execFileSync("chmod", ["+x", join(bin, "pnpm")]);
    }
    const shell = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
    const runScript = (command: string) => spawnSync(shell, [script, command], { cwd: repo, encoding: "utf8", env: { ...env, PATH: bin } });
    return { checkout, log, runScript };
  }

  it("installs the packages when tsx is missing, as the re-Apply's fresh worktree needs, keeping stdout for the command", () => {
    const { checkout, log, runScript } = bareCheckout("works");

    const result = runScript("key");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, "utf8").trim(), `--dir ${checkout} install --frozen-lockfile`);
    assert.match(result.stderr, /installing/);
    assert.match(result.stdout, /^tsx .*review-ledger\.mts key$/m);
    assert.doesNotMatch(result.stdout, /installing/);
  });

  for (const pnpm of ["fails", "no-tsx"] as const) {
    it(`fails when the install ${pnpm === "fails" ? "fails" : "leaves no tsx"}`, () => {
      const result = bareCheckout(pnpm).runScript("check");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /not found after pnpm install/);
    });
  }

  for (const missing of [["REPO_SLUG"], ["NOT_OWNED_BASELINE_PATHS"], ["REPO_SLUG", "NOT_OWNED_BASELINE_PATHS"]]) {
    it(`says to add ${missing.join(" and ")} to repo-config.mts, before any install, when the repo's copy lacks ${missing.length > 1 ? "both" : "it"}`, () => {
      const { checkout, log, runScript } = bareCheckout("works");
      const present = ["REPO_SLUG", "NOT_OWNED_BASELINE_PATHS"].filter((name) => !missing.includes(name));
      writeFileSync(join(checkout, ".sandcastle", "lib", "repo-config.mts"), configWith(present));

      const result = runScript("check");

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`no export of ${missing[0]}`));
      assert.equal(existsSync(log), false, "installed packages before checking the config");
    });
  }

  it("refuses names that only look exported: a longer name, a comment, an indented line", () => {
    const { checkout, runScript } = bareCheckout("works");
    const decoys = `export const REPO_SLUG_OLD = 1;\n// export const REPO_SLUG = "o/r";\n  export const REPO_SLUG = "o/r";\n${configWith(["NOT_OWNED_BASELINE_PATHS"])}`;
    writeFileSync(join(checkout, ".sandcastle", "lib", "repo-config.mts"), decoys);

    const result = runScript("check");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no export of REPO_SLUG/);
  });

  it("takes names exported with let, or with extra spaces", () => {
    const { checkout, runScript } = bareCheckout("works");
    writeFileSync(join(checkout, ".sandcastle", "lib", "repo-config.mts"), `export  let   REPO_SLUG = "o/r";\nexport   const   NOT_OWNED_BASELINE_PATHS = [];\n`);

    const result = runScript("key");

    assert.equal(result.status, 0, result.stderr);
  });

  it("says the config doesn't exist, rather than blaming its contents", () => {
    const { checkout, runScript } = bareCheckout("works");
    rmSync(join(checkout, ".sandcastle", "lib", "repo-config.mts"));

    const result = runScript("check");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /doesn't exist/);
  });

  it("says to enable pnpm when it isn't installed", () => {
    const result = bareCheckout("missing").runScript("check");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /corepack enable pnpm/);
  });

  it("runs the command through a symlinked path to the module too", () => {
    const link = join(root, "link.mts");
    symlinkSync(moduleFile, link);

    const result = spawnSync(join(repoRoot, "node_modules/.bin/tsx"), [link, "check", mergeBase(repo)], { cwd: repo, encoding: "utf8", env });

    assert.equal(result.status, 1, result.stderr);
  });
});

// The Seed's value before Apply fills it in, spelled so this Owned file carries no placeholder.
const UNFILLED = `{{${"OWNER"}}}/{{${"REPO"}}}`;

describe("repoSlugProblem and the repo command", () => {
  it("accepts OWNER/REPO and nothing else", () => {
    for (const slug of ["mpaulosky/dotfiles", "o/r", "my-org/my.repo_1"]) assert.equal(repoSlugProblem(slug), undefined, slug);
    for (const slug of [UNFILLED, "", "o", "o/r/x", "github.com/o/r", "o/r\n", " o/r", "o /r", "/r", "o/"]) {
      assert.match(repoSlugProblem(slug) ?? "", /not OWNER\/REPO/, JSON.stringify(slug));
    }
  });

  it("prints a valid slug alone on one line and exits 0", () => {
    const written: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((text: string) => (written.push(text), true)) as typeof process.stdout.write;
    try {
      assert.equal(main(["repo"], repo, {}, "mpaulosky/dotfiles"), 0);
    } finally {
      process.stdout.write = write;
    }

    assert.deepEqual(written, ["mpaulosky/dotfiles\n"]);
  });

  it("exits 1 and prints nothing to stdout for the unfilled Seed value", () => {
    const written: string[] = [];
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = ((text: string) => (written.push(text), true)) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      assert.equal(main(["repo"], repo, {}, UNFILLED), 1);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }

    assert.deepEqual(written, []);
  });
});

describe("OWNED_PATHS", () => {
  it("matches folders and globs as the rule means them", () => {
    for (const path of [".github/workflows/ci.yml", ".github/hooks/tests/pre-push.test.sh", ".github/scripts/a/b/c.sh", "global.json", ".claude/skills/pre-push-review/SKILL.md", ".sandcastle/lib/build.mts"]) {
      assert.equal(isOwnedPath(path), true, path);
    }
    for (const path of [
      ".sandcastle/lib/repo-config.mts",
      ".github/workflows/nested/ci.yml",
      ".github/instructions/a/b.md",
      ".sandcastle/lib/nested/build.mts",
      ".github/ci/gate-checks.sh",
      "scripts/gate.shx",
      "global.json.bak",
      "globalxjson",
      "xglobal.json",
    ]) {
      assert.equal(isOwnedPath(path), false, path);
    }
  });

  it("leaves out the files the repository lists as its own, which are Owned patterns' otherwise", () => {
    for (const path of NOT_OWNED_BASELINE_PATHS) {
      // A file, exactly as git names it: NOT_OWNED is matched by exact string, so a folder, a "./" or a stray space excludes nothing.
      assert.ok(!path.endsWith("/") && !path.startsWith("./") && path === path.trim(), `${JSON.stringify(path)} must be a file path, not a folder, "./" or padded`);
      assert.equal(underOwnedPattern(path), true, `${path} isn't under an Owned pattern, so listing it does nothing`);
      assert.equal(isOwnedPath(path), false, path);
    }
  });
});
