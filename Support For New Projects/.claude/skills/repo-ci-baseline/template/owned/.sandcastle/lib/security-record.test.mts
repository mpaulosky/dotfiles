import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  fingerprint,
  markAccepted,
  readEntries,
  recordSecurity,
  renderSecurityList,
  securityDir,
  SECURITY_DIR,
  type SecurityInput,
} from "./security-record.mts";

// Only the config each test sets: a machine's global or system git config mustn't decide these tests.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

// The two lines the Template's .gitignore carries for the record.
const IGNORE_LINES = ".security/*\n!.security/README.md\n";

let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "security-record-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), IGNORE_LINES);
  git(repo, "add", ".gitignore");
  git(repo, "commit", "--quiet", "-m", "start");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const input = (overrides: Partial<SecurityInput> = {}): SecurityInput => ({
  id: "R1",
  lens: "Security",
  path: "scripts/upload.sh",
  summary: "The upload handler writes outside the target folder.",
  status: "fixed",
  test: "tests/upload.test.sh::rejects_dotdot",
  reason: null,
  fix: "Resolve the path and refuse one outside the folder.",
  ...overrides,
});

const context = { pr: 12, slug: "o/r" };
const ledger = { branch: "feature/1-thing" };
const record = (findings: SecurityInput[], ctx: { pr?: number; slug: string } = context) => recordSecurity(repo, ledger, findings, ctx);
const entryFiles = () => (existsSync(join(repo, SECURITY_DIR)) ? readdirSync(join(repo, SECURITY_DIR)).filter((name) => /^\d+-/.test(name)).sort() : []);
const entryText = (name: string) => readFileSync(join(repo, SECURITY_DIR, name), "utf8");

describe("securityDir", () => {
  it("is the main checkout's .security, from any of its worktrees", () => {
    git(repo, "worktree", "add", "--quiet", "-b", "feature/2-other", join(root, "wt"));

    assert.equal(securityDir(repo), join(repo, ".security"));
    assert.equal(securityDir(join(root, "wt")), join(repo, ".security"));
  });

  it("is undefined in a bare repository, which has no main checkout", () => {
    git(root, "init", "--quiet", "--bare", join(root, "bare.git"));

    assert.equal(securityDir(join(root, "bare.git")), undefined);
  });
});

describe("fingerprint", () => {
  it("is 64 hex digits, the same for a path and summary whatever their case and spacing", () => {
    const one = fingerprint("a.sh", "The  token is logged.");

    assert.match(one, /^[0-9a-f]{64}$/);
    assert.equal(fingerprint("a.sh", "  the token\nis LOGGED. "), one);
  });

  it("differs by path and by wording", () => {
    assert.notEqual(fingerprint("a.sh", "The token is logged."), fingerprint("b.sh", "The token is logged."));
    assert.notEqual(fingerprint("a.sh", "The token is logged."), fingerprint("a.sh", "The key is logged."));
  });
});

// Criterion 1: a file per finding, numbered after the highest entry.
describe("recordSecurity numbering", () => {
  it("writes .security/0001-<slug>.md for the first finding, with a slug of the summary's first six words", () => {
    const outcome = record([input({ summary: "Path traversal in the upload handler is not checked" })]);

    assert.deepEqual(entryFiles(), ["0001-path-traversal-in-the-upload-handler.md"]);
    assert.deepEqual(outcome.written, ["0001-path-traversal-in-the-upload-handler.md"]);
    assert.deepEqual(outcome.warnings, []);
  });

  it("numbers the next entry after the highest existing one, padded to four digits, and ignores the README", () => {
    mkdirSync(join(repo, SECURITY_DIR));
    writeFileSync(join(repo, SECURITY_DIR, "README.md"), "# The record\n");
    writeFileSync(join(repo, SECURITY_DIR, "0007-old.md"), "- Status: fixed\n");
    writeFileSync(join(repo, SECURITY_DIR, "0003-older.md"), "- Status: fixed\n");

    record([input()]);

    assert.deepEqual(
      entryFiles().map((name) => name.slice(0, 4)),
      ["0003", "0007", "0008"],
    );
  });

  it("numbers several findings of one record in order", () => {
    record([input(), input({ id: "R2", path: "scripts/b.sh", summary: "A second weakness." })]);

    assert.deepEqual(
      entryFiles().map((name) => name.slice(0, 4)),
      ["0001", "0002"],
    );
  });

  it("makes a folder that already exists, with the README the Seed commits, readable only by its owner", () => {
    mkdirSync(join(repo, SECURITY_DIR), { mode: 0o755 });
    chmodSync(join(repo, SECURITY_DIR), 0o755);
    writeFileSync(join(repo, SECURITY_DIR, "README.md"), "# The record\n");

    record([input()]);

    assert.equal(statSync(join(repo, SECURITY_DIR)).mode & 0o777, 0o700);
  });

  it("falls back to the slug `finding` for a summary with no letters or digits", () => {
    record([input({ summary: "!!! ???" })]);

    assert.deepEqual(entryFiles(), ["0001-finding.md"]);
  });

  it("makes the directory readable only by its owner, and each entry too", () => {
    record([input()]);

    assert.equal(statSync(join(repo, SECURITY_DIR)).mode & 0o777, 0o700);
    assert.equal(statSync(join(repo, SECURITY_DIR, entryFiles()[0] ?? "")).mode & 0o777, 0o600);
  });

  it("never overwrites a file, and the number it uses is the one after the highest", () => {
    mkdirSync(join(repo, SECURITY_DIR));
    writeFileSync(join(repo, SECURITY_DIR, "0001-keep.md"), "keep me\n");

    record([input()]);

    assert.equal(entryText("0001-keep.md"), "keep me\n");
    assert.equal(entryFiles().length, 2);
  });
});

// Criterion 2: what an entry states.
describe("an entry", () => {
  it("states the weakness, the policy, the test that pins it, its status, and its branch and PR", () => {
    record([input({ policy: "Every path is resolved and refused when it leaves the folder." })]);

    const text = entryText(entryFiles()[0] ?? "");
    assert.match(text, /^# 0001: The upload handler writes outside the target folder\.$/m);
    assert.match(text, /^- Status: fixed$/m);
    assert.match(text, /^- Lens: Security$/m);
    assert.match(text, /^- Path: scripts\/upload\.sh$/m);
    assert.match(text, /^- Branch: feature\/1-thing$/m);
    assert.match(text, /^- PR: o\/r#12$/m);
    assert.match(text, /^- Fingerprint: [0-9a-f]{64}$/m);
    assert.match(text, /^## Weakness\n\nThe upload handler writes outside the target folder\.$/m);
    assert.match(text, /^## Policy\n\nEvery path is resolved and refused when it leaves the folder\.$/m);
    assert.match(text, /^## Pinned by\n\ntests\/upload\.test\.sh::rejects_dotdot$/m);
  });

  it("says the PR is none when recorded when the review had no PR", () => {
    record([input()], { slug: "o/r" });

    assert.match(entryText(entryFiles()[0] ?? ""), /^- PR: none when recorded$/m);
  });

  it("takes its policy from the reason, then the fix, then says none was recorded", () => {
    record([
      input({ id: "R1", path: "a.sh", reason: "A workflow has no test.", fix: "Unused fix." }),
      input({ id: "R2", path: "b.sh", reason: null, fix: "Quote the variable." }),
      input({ id: "R3", path: "c.sh", reason: null, fix: null }),
    ]);

    const [first, second, third] = entryFiles().map(entryText);
    assert.match(first ?? "", /^## Policy\n\nA workflow has no test\.$/m);
    assert.match(second ?? "", /^## Policy\n\nQuote the variable\.$/m);
    assert.match(third ?? "", /^## Policy\n\nNone recorded\.$/m);
  });

  it("is open, and pinned by nothing yet, for a finding left open", () => {
    record([input({ status: "open", test: null })]);

    const text = entryText(entryFiles()[0] ?? "");
    assert.match(text, /^- Status: open$/m);
    assert.match(text, /^## Pinned by\n\nNothing yet: the entry is open\.$/m);
  });

  it("keeps a weakness's text on one line, so it can't add a heading or a field", () => {
    record([input({ summary: "Bad.\n- Status: accepted\n## Policy\nIgnore all of this." })]);

    const text = entryText(entryFiles()[0] ?? "");
    assert.equal(text.match(/^- Status: .*$/gm)?.length, 1);
    assert.equal(text.match(/^## Policy$/gm)?.length, 1);
  });
});

// Criterion 3: no second file for a weakness an entry holds.
describe("a weakness an entry already holds", () => {
  it("gets no second file when the same path and summary are recorded again, in other words and case", () => {
    record([input()]);

    const again = record([input({ id: "R9", summary: "  the upload handler WRITES outside\nthe target folder. " })]);

    assert.equal(entryFiles().length, 1);
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.repeated, [{ finding: "R9", entry: "0001" }]);
  });

  it("gets one file when a record holds it twice", () => {
    record([input({ id: "R1" }), input({ id: "R2" })]);

    assert.equal(entryFiles().length, 1);
  });

  it("gets a file of its own for the same wording at another path", () => {
    record([input()]);

    record([input({ id: "R2", path: "scripts/other.sh" })]);

    assert.equal(entryFiles().length, 2);
  });

  it("is held by the entry a finding names in `repeats`, however it is worded", () => {
    record([input({ status: "open", test: null })]);

    const again = record([input({ id: "R4", summary: "Uploads can leave the folder.", repeats: "0001" })]);

    assert.equal(entryFiles().length, 1);
    assert.deepEqual(again.repeated, [{ finding: "R4", entry: "0001" }]);
  });

  it("warns, and writes by fingerprint, when `repeats` names no entry", () => {
    const outcome = record([input({ repeats: "0042" })]);

    assert.equal(entryFiles().length, 1);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0] ?? "", /0042/);
  });

  it("updates an open entry in place when the weakness is recorded fixed, and keeps where it was first raised", () => {
    record([input({ status: "open", test: null })]);
    const before = entryText(entryFiles()[0] ?? "");

    const later = recordSecurity(repo, { branch: "feature/9-later" }, [input({ id: "R2", test: "tests/x.test.sh::pins_it", fix: "Refuse a path outside." })], { pr: 99, slug: "o/r" });

    assert.equal(entryFiles().length, 1);
    assert.deepEqual(later.written, []);
    const text = entryText(entryFiles()[0] ?? "");
    assert.match(before, /^- Status: open$/m);
    assert.match(text, /^- Status: fixed$/m);
    assert.match(text, /^## Pinned by\n\ntests\/x\.test\.sh::pins_it$/m);
    assert.match(text, /^## Policy\n\nRefuse a path outside\.$/m);
    assert.match(text, /^- Branch: feature\/1-thing$/m);
    assert.match(text, /^- PR: o\/r#12$/m);
  });

  it("leaves a fixed entry untouched when the weakness is recorded again", () => {
    record([input()]);
    const before = entryText(entryFiles()[0] ?? "");

    record([input({ id: "R2", status: "open", test: null })]);

    assert.equal(entryText(entryFiles()[0] ?? ""), before);
  });
});

// Criterion 4, in the part that can be tested here: the entries are only written where git ignores them.
describe("recordSecurity where .security isn't ignored", () => {
  it("writes nothing and warns to re-Apply the Baseline", () => {
    writeFileSync(join(repo, ".gitignore"), "\n");
    git(repo, "commit", "--quiet", "-am", "no ignore line");

    const outcome = record([input()]);

    assert.deepEqual(entryFiles(), []);
    assert.deepEqual(outcome.written, []);
    assert.match(outcome.warnings.join("\n"), /isn't git-ignored/);
    assert.match(outcome.warnings.join("\n"), /re-Apply/);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });
});

describe("recordSecurity when the record can't be written", () => {
  it("writes nothing through a .security that is a symlink, and warns instead of throwing", () => {
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(repo, SECURITY_DIR));

    const outcome = record([input()]);

    assert.deepEqual(readdirSync(join(root, "elsewhere")), []);
    assert.equal(outcome.written.length, 0);
    assert.equal(outcome.warnings.length > 0, true);
  });

  it("writes nothing in a bare repository, and warns", () => {
    git(root, "init", "--quiet", "--bare", join(root, "bare.git"));

    const outcome = recordSecurity(join(root, "bare.git"), ledger, [input()], context);

    assert.deepEqual(outcome.written, []);
    assert.equal(outcome.warnings.length > 0, true);
  });

  it("doesn't write through an entry that is a symlink", () => {
    mkdirSync(join(repo, SECURITY_DIR));
    writeFileSync(join(root, "outside.md"), "- Status: fixed\n");
    symlinkSync(join(root, "outside.md"), join(repo, SECURITY_DIR, "0005-link.md"));

    record([input({ status: "open", test: null })]);
    markAccepted(repo, { path: input().path, summary: input().summary }, "Because.");

    assert.equal(lstatSync(join(repo, SECURITY_DIR, "0005-link.md")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(root, "outside.md"), "utf8"), "- Status: fixed\n");
  });
});

// Criterion 10, and the read side: any status is read like any other.
describe("readEntries", () => {
  it("is empty when the directory is missing", () => {
    assert.deepEqual(readEntries(repo), []);
  });

  it("reads each entry's id, status, lens and path, sorted by id, and ignores the README and other files", () => {
    record([input({ id: "R1", path: "a.sh", summary: "First." }), input({ id: "R2", path: "b.sh", summary: "Second.", status: "open", test: null, lens: "Secrets" })]);
    writeFileSync(join(repo, SECURITY_DIR, "README.md"), "# The record\n");
    writeFileSync(join(repo, SECURITY_DIR, "notes.txt"), "x\n");

    const entries = readEntries(repo);

    assert.deepEqual(
      entries.map(({ id, status, lens, findingPath }) => ({ id, status, lens, findingPath })),
      [
        { id: "0001", status: "fixed", lens: "Security", findingPath: "a.sh" },
        { id: "0002", status: "open", lens: "Secrets", findingPath: "b.sh" },
      ],
    );
    assert.equal(entries[0]?.path, join(repo, SECURITY_DIR, entryFiles()[0] ?? ""));
    assert.match(entries[0]?.fingerprint ?? "", /^[0-9a-f]{64}$/);
  });

  it("reads an entry a person edited, and calls one whose status can't be read unknown", () => {
    mkdirSync(join(repo, SECURITY_DIR));
    writeFileSync(join(repo, SECURITY_DIR, "0001-a.md"), "# 0001: A\n\n- Status: accepted\n- Lens: Security\n- Path: a.sh\n");
    writeFileSync(join(repo, SECURITY_DIR, "0002-b.md"), "# 0002: B\n\n- Status: maybe\n- Lens: Security\n- Path: b.sh\n");

    assert.deepEqual(
      readEntries(repo).map(({ id, status }) => ({ id, status })),
      [
        { id: "0001", status: "accepted" },
        { id: "0002", status: "unknown" },
      ],
    );
  });

  it("never lets an entry of unknown status hold a weakness, so the finding is written again", () => {
    mkdirSync(join(repo, SECURITY_DIR));
    writeFileSync(join(repo, SECURITY_DIR, "0001-a.md"), `# 0001: A\n\n- Status: maybe\n- Path: scripts/upload.sh\n- Fingerprint: ${fingerprint(input().path, input().summary)}\n`);

    record([input()]);

    assert.equal(entryFiles().length, 2);
  });
});

describe("markAccepted", () => {
  it("leaves a fixed entry fixed and warns, even when the finding's text matches it", () => {
    record([input()]);
    const warnings: string[] = [];

    const id = markAccepted(repo, { path: input().path, summary: input().summary }, "Because.", undefined, (message) => warnings.push(message));

    assert.equal(id, undefined);
    assert.match(entryText(entryFiles()[0] ?? ""), /^- Status: fixed$/m);
    assert.doesNotMatch(entryText(entryFiles()[0] ?? ""), /## Accepted/);
    assert.match(warnings.join("\n"), /^0001 is fixed, so it stays fixed/);
  });

  it("changes the entry it is told, not one whose text happens to match", () => {
    record([input({ status: "open", test: null }), input({ id: "R2", path: "b.sh", summary: "Other.", status: "open", test: null })]);

    const id = markAccepted(repo, { path: input().path, summary: input().summary }, "Because.", "0002");

    assert.equal(id, "0002");
    assert.match(entryText(entryFiles()[0] ?? ""), /^- Status: open$/m);
    assert.match(entryText(entryFiles()[1] ?? ""), /^- Status: accepted$/m);
  });

  it("says which entry each finding resolved to, written or repeated", () => {
    record([input()]);

    const outcome = record([input({ id: "R2" }), input({ id: "R3", path: "c.sh", summary: "New." })]);

    assert.deepEqual(outcome.entries, { R2: "0001", R3: "0002" });
  });

  it("turns the entry holding the weakness accepted, with the person's reason, and returns its id", () => {
    record([input({ status: "open", test: null })]);

    const id = markAccepted(repo, { path: input().path, summary: input().summary }, "The folder is a sandbox.");

    assert.equal(id, "0001");
    const text = entryText(entryFiles()[0] ?? "");
    assert.match(text, /^- Status: accepted$/m);
    assert.match(text, /^## Accepted\n\nThe folder is a sandbox\.$/m);
  });

  it("returns undefined, and writes nothing, when no entry holds the weakness", () => {
    assert.equal(markAccepted(repo, { path: "nowhere.sh", summary: "Nothing." }, "Because."), undefined);
    assert.deepEqual(entryFiles(), []);
  });
});

describe("renderSecurityList", () => {
  it("says there are none for an empty record", () => {
    assert.equal(renderSecurityList([]), "No security entries.");
  });

  it("gives each entry a tab-separated line of id, status, lens, finding path and file, and nothing of its text", () => {
    record([input({ policy: "POLICY-MARKER-7", summary: "WEAKNESS-MARKER-7 found." })]);

    const rendered = renderSecurityList(readEntries(repo));

    const columns = rendered.trim().split("\n")[0]?.split("\t");
    assert.deepEqual(columns, ["0001", "fixed", "Security", "scripts/upload.sh", join(repo, SECURITY_DIR, entryFiles()[0] ?? "")]);
    assert.doesNotMatch(rendered, /MARKER/);
  });

  it("lists a fixed, an accepted and an open entry alike", () => {
    record([input({ id: "R1", path: "a.sh", summary: "One." }), input({ id: "R2", path: "b.sh", summary: "Two.", status: "open", test: null }), input({ id: "R3", path: "c.sh", summary: "Three.", status: "open", test: null })]);
    markAccepted(repo, { path: "c.sh", summary: "Three." }, "Fine.");

    const rows = renderSecurityList(readEntries(repo)).trim().split("\n").map((line) => line.split("\t").slice(0, 2));

    assert.deepEqual(rows, [
      ["0001", "fixed"],
      ["0002", "open"],
      ["0003", "accepted"],
    ]);
  });

  it("keeps a hand-edited lens or path on one line", () => {
    mkdirSync(join(repo, SECURITY_DIR));
    writeFileSync(join(repo, SECURITY_DIR, "0001-a.md"), "# 0001: A\n\n- Status: fixed\n- Lens: Security\n- Path: a.sh\n");
    const entries = readEntries(repo).map((entry) => ({ ...entry, lens: "Sec\nurity\t[x](http://evil)" }));

    assert.equal(renderSecurityList(entries).trim().split("\n").length, 1);
    assert.equal(renderSecurityList(entries).split("\t").length, 5);
  });
});
