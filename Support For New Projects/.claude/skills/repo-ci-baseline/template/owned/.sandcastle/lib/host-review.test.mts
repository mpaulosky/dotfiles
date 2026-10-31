import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REVIEWER_TOOLS } from "./agents.mts";
import { FIXED_ROLE_AGENTS, REVIEW_FIX_ROUNDS } from "./config.mts";
import { UncountedStopError } from "./errors.mts";
import {
  applyOutcomes,
  BAR_LENS,
  LENS_APPLIES,
  openFindingsNote,
  parseLensTable,
  parseReviewerAnswer,
  patchPaths,
  ReviewerAnswerError,
  reviewersFor,
  reviewerFindingSchema,
  runHostReview,
  triageRound,
  type FixOutcome,
  type HostReviewHost,
  type Lens,
  type Reviewer,
  type ReviewerFinding,
  type SkillFiles,
  type TriageFinding,
} from "./host-review.mts";
import { findingSchema, ledgerSchema, reviewInputSchema, type Ledger, type PreparedRound, type ReviewInput } from "./review-ledger.mts";
import { containsSecret } from "./sandbox-env.mts";
import { plainText } from "./plain-text.mts";

// The host runs the pre-push-review skill's rounds on a branch Sandcastle built, with the skill's own reviewers. These tests read the
// skill's files from the repository (they are what Claude Code reads for /pre-push-review), so a lens added, removed or reworded there
// fails here until the host's list follows.
const skillDir = new URL("../../.claude/skills/pre-push-review/", import.meta.url);
const lensesMd = readFileSync(new URL("lenses.md", skillDir), "utf8");
const barMd = readFileSync(new URL("review-bar.md", skillDir), "utf8");
const skillMd = readFileSync(new URL("SKILL.md", skillDir), "utf8");
const agentMd = readFileSync(new URL("../../.claude/agents/pre-push-reviewer.md", import.meta.url), "utf8");

const agentBody = agentMd.replace(/^---\n[\s\S]*?\n---\n/, "");
const severities = /^## Severities\n[\s\S]*?(?=^## )/m.exec(skillMd)?.[0] ?? "";
const skillFiles = (repoLenses?: string): SkillFiles => ({ lenses: lensesMd, bar: barMd, severities, agentBody, ...(repoLenses === undefined ? {} : { repoLenses }) });

// Read at load so every test shares them; a parser that throws leaves them empty and fails the tests that name a lens, not the whole file.
let lenses: Lens[] = [];
try {
  lenses = parseLensTable(lensesMd);
} catch {
  // parseLensTable's own tests report why.
}
const names = (reviewers: readonly Reviewer[]) => reviewers.map((reviewer) => reviewer.lens);
const CODE_LENSES = ["Edge cases", "Races and caches", "Error contract", "Security", "Tests"];
const CODE_REVIEWERS = [BAR_LENS, ...CODE_LENSES, "Docs match the code", "Repo conventions"];

describe("parseLensTable", () => {
  it("reads every row of lenses.md with its name, Applies to text and row", () => {
    assert.deepEqual(
      lenses.map((lens) => lens.name),
      [
        "Edge cases",
        "Races and caches",
        "Error contract",
        "Blazor lifecycle",
        "Security",
        "Tests",
        "Docs match the code",
        "Sandcastle host",
        "Shell",
        "GitHub Actions",
        "Repo conventions",
      ],
    );
    for (const lens of lenses) {
      assert.notEqual(lens.appliesTo.trim(), "", lens.name);
      assert.notEqual(lens.row.trim(), "", lens.name);
    }
    assert.equal(lenses.find((lens) => lens.name === "Blazor lifecycle")?.appliesTo, "`.razor`, `.razor.cs`");
  });

  it("throws when the markdown holds no lens table", () => {
    assert.throws(() => parseLensTable("# Lenses\n\nNothing tabular here.\n"));
  });

  it("throws on a row with fewer than three cells, rather than review a lens it half-read", () => {
    assert.throws(() => parseLensTable("| Lens | Applies to | Ask |\n| --- | --- | --- |\n| Edge cases | Any code |\n"));
  });

  it("reads a repository's own lenses table of the same shape", () => {
    const own = parseLensTable("| Lens | Applies to | Ask |\n| --- | --- | --- |\n| Billing | Invoices | Does every total round to the cent? |\n");

    assert.deepEqual(own.map((lens) => [lens.name, lens.appliesTo]), [["Billing", "Invoices"]]);
  });
});

// Criterion: a built branch is reviewed by the same reviewers as /pre-push-review starts, with a test that fails if the two lists diverge.
describe("the host's reviewers against /pre-push-review's own", () => {
  it("has a path rule for every lens in lenses.md, with the same Applies to text, and for no other", () => {
    assert.ok(lenses.length > 0, "lenses.md holds a lens table");
    assert.deepEqual(Object.keys(LENS_APPLIES).sort(), lenses.map((lens) => lens.name).sort());
    for (const lens of lenses) assert.equal(LENS_APPLIES[lens.name]?.appliesTo, lens.appliesTo, `${lens.name}: reworded in lenses.md?`);
  });

  it("uses the model, effort, tools and round limit the skill names", () => {
    assert.match(skillMd, /`subagent_type: "pre-push-reviewer"`/);
    assert.equal(/`model: "(\w+)"`/.exec(skillMd)?.[1], FIXED_ROLE_AGENTS["pre-push-reviewer"].model);
    assert.equal(/`effort: "(\w+)"`/.exec(skillMd)?.[1], FIXED_ROLE_AGENTS["pre-push-reviewer"].effort);
    assert.equal(/^tools: (.+)$/m.exec(agentMd)?.[1], REVIEWER_TOOLS.join(", "));
    assert.match(skillMd, new RegExp(`After ${REVIEW_FIX_ROUNDS} rounds that fixed something`));
  });

  it("starts the Bar first and then each matching lens in the table's order", () => {
    assert.deepEqual(names(reviewersFor(["src/app.ts"], lenses)), CODE_REVIEWERS.slice(0, 1).concat(["Edge cases", "Races and caches", "Error contract", "Security", "Tests", "Docs match the code", "Repo conventions"]));
  });

  it("gives a diff of only Markdown the Docs match the code and Repo conventions lenses, as the skill says", () => {
    assert.deepEqual(names(reviewersFor(["README.md", "docs/adr/0001-x.md"], lenses)), [BAR_LENS, "Docs match the code", "Repo conventions"]);
  });

  it("adds Blazor lifecycle for .razor and .razor.cs files", () => {
    const got = names(reviewersFor(["src/Pages/Index.razor"], lenses));
    assert.ok(got.includes("Blazor lifecycle"), got.join(", "));
    assert.ok(names(reviewersFor(["src/Pages/Index.razor.cs"], lenses)).includes("Blazor lifecycle"));
    assert.ok(!names(reviewersFor(["src/app.ts"], lenses)).includes("Blazor lifecycle"));
  });

  it("adds Sandcastle host for files under .sandcastle/", () => {
    assert.ok(names(reviewersFor([".sandcastle/lib/build.mts"], lenses)).includes("Sandcastle host"));
    assert.ok(!names(reviewersFor(["src/app.ts"], lenses)).includes("Sandcastle host"));
  });

  it("adds Shell for shell scripts and hooks", () => {
    assert.ok(names(reviewersFor(["scripts/gate.sh"], lenses)).includes("Shell"));
    assert.ok(names(reviewersFor([".github/hooks/pre-push"], lenses)).includes("Shell"));
    assert.ok(!names(reviewersFor(["src/app.ts"], lenses)).includes("Shell"));
  });

  it("adds GitHub Actions for workflows and workflow scripts", () => {
    assert.ok(names(reviewersFor([".github/workflows/ci.yml"], lenses)).includes("GitHub Actions"));
    assert.ok(names(reviewersFor([".github/scripts/post.py"], lenses)).includes("GitHub Actions"));
    assert.ok(!names(reviewersFor(["src/app.ts"], lenses)).includes("GitHub Actions"));
  });

  it("matches the Template's own folder, whose name holds spaces", () => {
    const files = ["Support For New Projects/.claude/skills/repo-ci-baseline/template/owned/.sandcastle/lib/build.mts"];
    assert.ok(names(reviewersFor(files, lenses)).includes("Edge cases"));
  });

  it("runs a repository's own lens, which the host has no path rule for, for every changed file, even a Markdown-only diff", () => {
    const own = [...lenses, ...parseLensTable("| Lens | Applies to | Ask |\n| --- | --- | --- |\n| Billing | Invoices | Does every total round? |\n")];

    assert.ok(names(reviewersFor(["README.md"], own)).includes("Billing"));
    assert.ok(names(reviewersFor(["src/app.ts"], own)).includes("Billing"));
  });

  it("gives each reviewer its lens's row, and the Bar none", () => {
    const reviewers = reviewersFor(["src/app.ts"], lenses);

    assert.equal(reviewers[0]?.lens, BAR_LENS);
    assert.equal(reviewers[0]?.row, "");
    for (const reviewer of reviewers.slice(1)) assert.equal(reviewer.row, lenses.find((lens) => lens.name === reviewer.lens)?.row);
  });
});

describe("patchPaths", () => {
  const header = (path: string, other = path) => `diff --git a/${path} b/${other}\n--- a/${path}\n+++ b/${other}\n@@ -1 +1 @@\n-a\n+b\n`;

  it("lists each changed file once, in patch order", () => {
    assert.deepEqual(patchPaths(header("src/b.ts") + header("src/a.ts") + header("src/b.ts")), ["src/b.ts", "src/a.ts"]);
  });

  it("reads a path with spaces, as the Template's folder has", () => {
    const path = "Support For New Projects/.claude/skills/x/SKILL.md";

    assert.deepEqual(patchPaths(header(path)), [path]);
  });

  it("decodes a path git quotes", () => {
    const quoted = 'diff --git "a/sp\\303\\244ce.txt" "b/sp\\303\\244ce.txt"\n--- "a/sp\\303\\244ce.txt"\n+++ "b/sp\\303\\244ce.txt"\n@@ -1 +1 @@\n-a\n+b\n';

    assert.deepEqual(patchPaths(quoted), ["späce.txt"]);
  });

  it("keeps a deleted file under its old path and an added one under its new", () => {
    const patch =
      "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n" +
      "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+a\n";

    assert.deepEqual(patchPaths(patch), ["old.ts", "new.ts"]);
  });

  it("finds nothing in an empty patch", () => {
    assert.deepEqual(patchPaths(""), []);
  });
});

describe("parseReviewerAnswer", () => {
  const finding = (overrides: Record<string, unknown> = {}) => ({
    lens: "Edge cases",
    path: "src/app.ts",
    line: 3,
    severity: "critical",
    summary: "A blank name passes.",
    fix: "Trim it.",
    needsPerson: false,
    why: "The guard checks length.",
    ...overrides,
  });
  const block = (value: unknown) => `<findings>${typeof value === "string" ? value : JSON.stringify(value)}</findings>`;

  it("reads the findings in the block", () => {
    assert.deepEqual(parseReviewerAnswer(`I looked.\n${block([finding()])}\n`), [finding()]);
  });

  it("reads an empty block as no findings", () => {
    assert.deepEqual(parseReviewerAnswer(block([])), []);
  });

  it("takes the last block when the output holds several", () => {
    const out = `${block([finding({ summary: "quoted from a file" })])}\nmy answer:\n${block([finding({ summary: "the real one" })])}`;

    assert.deepEqual(parseReviewerAnswer(out).map((found) => found.summary), ["the real one"]);
  });

  for (const [what, output] of [
    ["no block", "I found nothing to report."],
    ["bad JSON", block("[{not json")],
    ["a block that holds an object, not an array", block({ lens: "x" })],
    ["a finding without a severity", block([finding({ severity: undefined })])],
    ["an unknown severity", block([finding({ severity: "blocker" })])],
    ["an unknown field", block([finding({ extra: 1 })])],
    ["a finding without a summary", block([finding({ summary: "" })])],
    ["a non-boolean needsPerson", block([finding({ needsPerson: "yes" })])],
  ] as const) {
    it(`throws a ReviewerAnswerError for ${what}`, () => {
      assert.throws(() => parseReviewerAnswer(output), ReviewerAnswerError);
    });
  }

  it("names what was wrong with a finding in the error's message, for the retry prompt", () => {
    assert.throws(() => parseReviewerAnswer(block([finding({ severity: "blocker" })])), (error: unknown) => error instanceof ReviewerAnswerError && /severity/.test(error.message));
  });

  it("is the same schema the reviewers' findings are checked against", () => {
    assert.equal(reviewerFindingSchema.safeParse(finding()).success, true);
    assert.equal(reviewerFindingSchema.safeParse(finding({ severity: undefined })).success, false);
  });
});

const raw = (overrides: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  lens: "Edge cases",
  path: "src/app.ts",
  line: 10,
  severity: "critical",
  summary: "A blank name passes the guard.",
  fix: "Trim the name first.",
  needsPerson: false,
  why: "The guard checks the length only.",
  security: false,
  ...overrides,
});
const reviewer = (lens: string): Reviewer => ({ lens, row: lens === BAR_LENS ? "" : (lenses.find((found) => found.name === lens)?.row ?? `| ${lens} | x | y |`) });

describe("triageRound", () => {
  const triage = (reviewers: Record<string, ReviewerFinding[]>, firstId = 1, reviewOnly = false) =>
    triageRound({ raw: Object.entries(reviewers).map(([lens, findings]) => ({ reviewer: reviewer(lens), findings })), firstId, reviewOnly });

  it("numbers the findings from the first id, in reviewer order", () => {
    const got = triage({ "Edge cases": [raw(), raw({ line: 20, summary: "Another." })], Tests: [raw({ lens: "Tests", path: "tests/a.test.ts", summary: "No test." })] }, 5);

    assert.deepEqual(got.map((found) => found.id), ["R5", "R6", "R7"]);
  });

  it("gives each finding open, with no test or reason, and its suggested fix", () => {
    const [found] = triage({ "Edge cases": [raw()] });

    assert.equal(found?.status, "open");
    assert.equal(found?.test, null);
    assert.equal(found?.reason, null);
    assert.equal(found?.fix, "Trim the name first.");
    assert.equal(found?.lens, "Edge cases");
  });

  it("leaves a plain Critical fixable and not a security finding", () => {
    const [found] = triage({ "Edge cases": [raw()] });

    assert.equal(found?.fixable, true);
    assert.equal(found?.needsPerson, false);
    assert.equal(found?.security, false);
    assert.equal(found?.severity, "critical");
  });

  it("treats a finding as a security one unless its reviewer said it isn't", () => {
    const { security: _unsaid, ...unmarked } = raw();

    const [found] = triage({ "Edge cases": [unmarked as ReviewerFinding] });

    assert.equal(found?.security, true);
    assert.equal(found?.severity, "warning");
  });

  it("keeps a merged finding a security one when any reviewer who raised it didn't say it isn't", () => {
    const got = triage({
      "Edge cases": [raw()],
      "Error contract": [raw({ lens: "Error contract", security: true })],
    });

    assert.equal(got.length, 1);
    assert.equal(got[0]?.security, true);
  });

  it("leaves a finding that needs a person open and not fixable, with its fix", () => {
    const [found] = triage({ "Edge cases": [raw({ needsPerson: true })] });

    assert.equal(found?.fixable, false);
    assert.equal(found?.needsPerson, true);
    assert.equal(found?.status, "open");
    assert.equal(found?.fix, "Trim the name first.");
  });

  it("gives a finding with an empty suggested fix a fix to record, since an open finding needs one", () => {
    const [found] = triage({ "Edge cases": [raw({ fix: "", needsPerson: true })] });

    assert.match(found?.fix ?? "", /\S/);
  });

  it("leaves every finding of the review-only round open and not fixable", () => {
    const got = triage({ "Edge cases": [raw()], Tests: [raw({ lens: "Tests", summary: "No test.", path: "tests/a.test.ts" })] }, 1, true);

    assert.deepEqual(got.map((found) => [found.status, found.fixable]), [["open", false], ["open", false]]);
    assert.ok(got.every((found) => found.fix !== null && found.fix.trim() !== ""));
  });

  it("marks a Warning a security finding", () => {
    const [found] = triage({ "Edge cases": [raw({ severity: "warning" })] });

    assert.equal(found?.security, true);
    assert.equal(found?.severity, "warning");
  });

  it("marks a finding from a lens that names security a security finding, and grades it a Warning, never Advisory or Critical", () => {
    const got = triage({
      Security: [raw({ lens: "Security", severity: "advisory", summary: "Weak." }), raw({ lens: "Security", severity: "critical", line: 30, summary: "Open redirect." })],
    });

    assert.deepEqual(got.map((found) => [found.security, found.severity]), [[true, "warning"], [true, "warning"]]);
  });

  it("produces findings the ledger accepts to record", () => {
    const got = triage({ "Edge cases": [raw(), raw({ severity: "advisory", line: 2, summary: "A stale comment." })], Security: [raw({ lens: "Security", severity: "critical", line: 7, summary: "Open redirect." })] });

    for (const found of got) {
      const { needsPerson: _needsPerson, fixable: _fixable, ...recorded } = found;
      assert.doesNotThrow(() => findingSchema.parse(recorded), found.id);
    }
  });

  it("merges findings that agree on path, line and summary (ignoring case and spacing), joining their lenses and keeping the higher severity", () => {
    const got = triage({
      "Edge cases": [raw({ severity: "advisory", summary: "A blank name passes the guard." })],
      "Error contract": [raw({ lens: "Error contract", severity: "critical", summary: "a  blank NAME passes the guard." })],
    });

    assert.equal(got.length, 1);
    assert.equal(got[0]?.lens, "Edge cases/Error contract");
    assert.equal(got[0]?.severity, "critical");
  });

  it("lets a Warning win a merge and marks the merged finding a security one", () => {
    const got = triage({
      "Edge cases": [raw({ severity: "critical" })],
      Security: [raw({ lens: "Security", severity: "warning", summary: "A blank name passes the guard.  " })],
    });

    assert.equal(got.length, 1);
    assert.equal(got[0]?.lens, "Edge cases/Security");
    assert.equal(got[0]?.severity, "warning");
    assert.equal(got[0]?.security, true);
  });

  it("merges needsPerson with OR, so a finding one lens says needs a person isn't fixed", () => {
    const got = triage({ "Edge cases": [raw()], "Error contract": [raw({ lens: "Error contract", needsPerson: true })] });

    assert.equal(got.length, 1);
    assert.equal(got[0]?.needsPerson, true);
    assert.equal(got[0]?.fixable, false);
  });

  it("keeps two problems on one line apart", () => {
    const got = triage({ "Edge cases": [raw({ summary: "A blank name passes." }), raw({ summary: "A null name throws." })] });

    assert.equal(got.length, 2);
  });

  it("keeps the same summary on different lines or files apart", () => {
    const got = triage({ "Edge cases": [raw({ line: 1 }), raw({ line: 2 }), raw({ path: "src/b.ts", line: 1 })] });

    assert.equal(got.length, 3);
  });

  it("returns nothing for reviewers with no findings", () => {
    assert.deepEqual(triage({ [BAR_LENS]: [], "Edge cases": [] }), []);
  });
});

describe("parseReviewerAnswer's edges", () => {
  const block = (findings: unknown) => `<findings>${typeof findings === "string" ? findings : JSON.stringify(findings)}</findings>`;

  it("reads a finding whose text quotes the closing tag", () => {
    const quoted = raw({ summary: "The parser stops at </findings> inside a summary." });

    const got = parseReviewerAnswer(block([quoted]));

    assert.equal(got[0]?.summary, quoted.summary);
  });

  it("refuses a path the ledger would refuse, so the reviewer is asked again", () => {
    for (const path of ["`src/app.ts`", "src/a.ts (new)\tb", "<src/app.ts>", "src/a.ts\nsrc/b.ts"]) {
      assert.throws(() => parseReviewerAnswer(block([raw({ path })])), ReviewerAnswerError, path);
    }
  });

  it("refuses a whitespace-only summary or lens, and trims the text it keeps", () => {
    assert.throws(() => parseReviewerAnswer(block([raw({ summary: "   " })])), ReviewerAnswerError);
    assert.throws(() => parseReviewerAnswer(block([raw({ lens: " " })])), ReviewerAnswerError);
    assert.equal(parseReviewerAnswer(block([raw({ summary: "  Padded.  ", path: " src/app.ts " })]))[0]?.summary, "Padded.");
    assert.equal(parseReviewerAnswer(block([raw({ path: " src/app.ts " })]))[0]?.path, "src/app.ts");
  });
});

describe("applyOutcomes", () => {
  const triaged = (overrides: Partial<TriageFinding> = {}): TriageFinding => ({
    id: "R1",
    lens: "Edge cases",
    path: "src/app.ts",
    line: 10,
    summary: "A blank name passes the guard.",
    severity: "critical",
    security: false,
    status: "open",
    test: null,
    reason: null,
    fix: "Trim the name first.",
    needsPerson: false,
    fixable: true,
    ...overrides,
  });
  const outcome = (overrides: Partial<FixOutcome> = {}): FixOutcome => ({ id: "R1", status: "fixed", test: "tests/app.test.ts::blank", reason: null, ...overrides });
  const apply = (finding: TriageFinding, outcomes: FixOutcome[], changed: string[] = ["src/app.ts", "tests/app.test.ts"], advanced = true) =>
    applyOutcomes([finding], outcomes, changed, advanced)[0]!;
  const recordable = (findings: ReviewInput["findings"]) => reviewInputSchema.parse({ reviewedKey: "k", reviewedHead: "a".repeat(40), rounds: 1, findings });

  it("records a finding fixed behind a test whose file the round changed", () => {
    const got = apply(triaged(), [outcome()]);

    assert.equal(got.status, "fixed");
    assert.equal(got.test, "tests/app.test.ts::blank");
  });

  it("keeps a Warning open when the backend dismisses it, whatever line the reason cites", () => {
    const got = apply(triaged({ severity: "warning" }), [outcome({ status: "dismissed", test: null, reason: "x:1" })]);

    assert.equal(got.status, "open");
    assert.equal(got.fix, "Trim the name first.");
  });

  it("keeps a security finding open when the backend dismisses it", () => {
    const got = apply(triaged({ security: true, severity: "warning", lens: "Security" }), [outcome({ status: "dismissed", test: null, reason: "src/app.ts:10 is guarded." })]);

    assert.equal(got.status, "open");
  });

  it("still dismisses an ordinary finding whose reason cites file:line", () => {
    const got = apply(triaged({ severity: "advisory" }), [outcome({ status: "dismissed", test: null, reason: "src/app.ts:10 is guarded." })]);

    assert.equal(got.status, "dismissed");
  });

  it("hands back findings the ledger takes, without the host's own fields", () => {
    const got = applyOutcomes([triaged(), triaged({ id: "R2", line: 11, summary: "Other." })], [outcome(), outcome({ id: "R2", status: "dismissed", test: null, reason: "src/app.ts:11 shows the guard." })], ["tests/app.test.ts"], true);

    assert.doesNotThrow(() => recordable(got));
    assert.ok(got.every((found) => !("needsPerson" in found) && !("fixable" in found)));
  });

  it("leaves a Critical fixed with no test open, with its fix, when the test's file wasn't changed in the round", () => {
    const got = apply(triaged(), [outcome({ test: "tests/other.test.ts::x" })], ["src/app.ts"]);

    assert.equal(got.status, "open");
    assert.equal(got.fix, "Trim the name first.");
    assert.doesNotThrow(() => recordable([got]));
  });

  it("leaves a finding open when HEAD didn't move, whatever the backend says", () => {
    const got = apply(triaged(), [outcome()], [], false);

    assert.equal(got.status, "open");
  });

  it("takes a non-security finding fixed with a reason and no test, when HEAD advanced", () => {
    const got = apply(triaged({ severity: "advisory" }), [outcome({ test: null, reason: "A prose fix: no test can pin it." })], ["docs/a.md"]);

    assert.equal(got.status, "fixed");
    assert.equal(got.reason, "A prose fix: no test can pin it.");
  });

  it("leaves a Warning fixed with only a reason open", () => {
    const got = apply(triaged({ severity: "warning", security: true }), [outcome({ test: null, reason: "No test needed." })]);

    assert.equal(got.status, "open");
    assert.equal(got.fix, "Trim the name first.");
    assert.doesNotThrow(() => recordable([got]));
  });

  it("records a Warning fixed behind a test as fixed", () => {
    const got = apply(triaged({ severity: "warning", security: true }), [outcome()]);

    assert.equal(got.status, "fixed");
    assert.equal(got.test, "tests/app.test.ts::blank");
  });

  it("treats a security finding graded Critical by a lens that names security like a Warning: a test is needed", () => {
    const got = apply(triaged({ lens: "Security", security: true, severity: "warning" }), [outcome({ test: null, reason: "Done." })]);

    assert.equal(got.status, "open");
  });

  it("keeps a dismissal whose reason cites file:line", () => {
    const got = apply(triaged(), [outcome({ status: "dismissed", test: null, reason: "src/app.ts:12 already trims the name." })], [], false);

    assert.equal(got.status, "dismissed");
    assert.equal(got.reason, "src/app.ts:12 already trims the name.");
  });

  it("leaves a dismissal with no file:line in its reason open", () => {
    const got = apply(triaged(), [outcome({ status: "dismissed", test: null, reason: "The reviewer was wrong." })], [], false);

    assert.equal(got.status, "open");
  });

  it("leaves a dismissal with no reason open", () => {
    const got = apply(triaged(), [outcome({ status: "dismissed", test: null, reason: null })], [], false);

    assert.equal(got.status, "open");
  });

  it("leaves a finding the backend reports open, open", () => {
    const got = apply(triaged(), [outcome({ status: "open", test: null })], [], false);

    assert.equal(got.status, "open");
  });

  it("leaves a finding with no outcome open", () => {
    const got = apply(triaged(), [], [], false);

    assert.equal(got.status, "open");
  });

  it("ignores an outcome for an id that isn't a finding of the round", () => {
    const got = applyOutcomes([triaged()], [outcome({ id: "R9" })], ["tests/app.test.ts"], true);

    assert.deepEqual(got.map((found) => [found.id, found.status]), [["R1", "open"]]);
  });

  it("leaves a finding that needs a person open whatever the backend says", () => {
    const got = apply(triaged({ needsPerson: true, fixable: false }), [outcome()]);

    assert.equal(got.status, "open");
  });

  it("never records a finding as accepted", () => {
    const got = applyOutcomes([triaged()], [{ ...outcome(), status: "accepted" as never }], ["tests/app.test.ts"], true);

    assert.notEqual(got[0]?.status, "accepted");
  });
});

// ---- the rounds, with fake reviewers -------------------------------------------------------------------------------------------------

const BASE = "b".repeat(40);
const hex = (n: number) => n.toString(16).padStart(40, "0");
const diffFor = (...paths: string[]) => paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`).join("");
const findingsBlock = (found: ReviewerFinding[]) => `Done.\n<findings>${JSON.stringify(found)}</findings>\n`;

type FixerRun = { outcomes?: FixOutcome[] | string; changed?: string[]; advance?: boolean; error?: Error };
type Fake = {
  answers?: (round: number, reviewer: Reviewer, attempt: number) => ReviewerFinding[] | string | Error;
  patches?: (round: number) => { patch: string; fixes?: string };
  fixer?: (run: number) => FixerRun;
  gates?: (string | undefined)[];
  taken?: number;
  repoLenses?: string;
};

// A host whose reviewers answer from a script, whose fixer moves HEAD when it is told it commits, and which records what happened in order.
function fake(options: Fake = {}) {
  const events: string[] = [];
  const reviewerRuns: { round: number; lens: string; prompt: string; attempt: number }[] = [];
  const fixerPrompts: string[] = [];
  const files: { path: string; content: string }[] = [];
  const prepares: Parameters<HostReviewHost["prepare"]>[0][] = [];
  const prepared: PreparedRound[] = [];
  const records: { input: ReviewInput; at: { head: string; branch: string } }[] = [];
  const logs: string[] = [];
  const changedCalls: { from: string; to: string }[] = [];
  let round = 0;
  let headNumber = 1;
  let fixerRuns = 0;
  let gateRuns = 0;
  let outcomesFile: string | undefined;
  let changed: string[] = [];
  const attempts = new Map<string, number>();
  const gates = [...(options.gates ?? [])];
  const patches = options.patches ?? ((n: number) => ({ patch: diffFor("src/app.ts"), ...(n > 1 ? { fixes: diffFor("src/app.ts", "tests/app.test.ts") } : {}) }));
  const host: HostReviewHost = {
    readSkillFiles: () => skillFiles(options.repoLenses),
    worktree: async () => "/home/agent/workspace",
    prepare: (opts) => {
      round++;
      events.push(`prepare ${round}`);
      prepares.push(opts);
      const { patch, fixes } = patches(round);
      const result: PreparedRound = {
        patch: Buffer.from(patch),
        fixes: fixes === undefined ? undefined : Buffer.from(fixes),
        key: `key-${round}`,
        head: opts.head ?? hex(headNumber),
        base: BASE,
      };
      prepared.push(result);
      return result;
    },
    takenIds: () => options.taken ?? 0,
    writeRunFile: async (path, content) => void files.push({ path, content: content.toString() }),
    runReviewer: async (reviewerToRun, prompt) => {
      const key = `${round}:${reviewerToRun.lens}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      reviewerRuns.push({ round, lens: reviewerToRun.lens, prompt, attempt });
      const answer = options.answers?.(round, reviewerToRun, attempt) ?? [];
      if (answer instanceof Error) throw answer;
      return typeof answer === "string" ? answer : findingsBlock(answer);
    },
    runFixer: async (prompt) => {
      fixerRuns++;
      events.push(`fixer ${fixerRuns}`);
      fixerPrompts.push(prompt);
      const run = options.fixer?.(fixerRuns) ?? {};
      if (run.error !== undefined) throw run.error;
      outcomesFile = run.outcomes === undefined ? undefined : typeof run.outcomes === "string" ? run.outcomes : JSON.stringify({ outcomes: run.outcomes });
      changed = run.changed ?? [];
      if (run.advance ?? true) headNumber++;
    },
    readOutcomes: async () => outcomesFile,
    head: async () => hex(headNumber),
    changedFiles: (from, to) => {
      changedCalls.push({ from, to });
      return changed;
    },
    gate: async () => {
      gateRuns++;
      events.push(`gate ${gateRuns}`);
      return gates.length > 0 ? gates.shift() : hex(headNumber);
    },
    record: (input, at) => {
      events.push("record");
      records.push({ input, at });
      const parsed = reviewInputSchema.parse(input);
      return ledgerSchema.parse({
        version: 1,
        key: parsed.reviewedKey,
        branch: at.branch,
        base: BASE,
        head: at.head,
        recordedAt: "2026-01-01T00:00:00.000Z",
        rounds: parsed.rounds,
        ...(parsed.reviewerAgent === undefined ? {} : { reviewerAgent: parsed.reviewerAgent }),
        findings: parsed.findings.map(({ policy: _policy, repeats: _repeats, ...stored }) => stored),
        lastId: 0,
      });
    },
    log: (line) => void logs.push(line),
  };
  return {
    host,
    events,
    reviewerRuns,
    fixerPrompts,
    files,
    prepares,
    prepared,
    records,
    logs,
    changedCalls,
    gateRuns: () => gateRuns,
    rounds: () => round,
    startHead: hex(1),
    lensesIn: (n: number) => reviewerRuns.filter((run) => run.round === n && run.attempt === 1).map((run) => run.lens).sort(),
  };
}

const issueText = { number: 387, title: "Run the pre-push review's rounds on a built branch on the host", body: "Add the host-side review loop." };
const input = (startHead: string) => ({ issue: issueText, branch: "feature/387-the-host-review", main: BASE, startHead });
const only = (lens: string, found: ReviewerFinding[]) => (_round: number, who: Reviewer) => (who.lens === lens ? found : []);
const fixedWithTest = (id: string): FixOutcome => ({ id, status: "fixed", test: "tests/app.test.ts::blank_name", reason: null });
const recorded = (result: Awaited<ReturnType<typeof runHostReview>>) => {
  assert.equal(result.status, "recorded", JSON.stringify(result));
  return result as Extract<typeof result, { status: "recorded" }>;
};

// Criterion: a round that fixes something is followed by a round reviewing the fixes only, and the review ends after a round that fixes
// nothing, or after the review-only round, as the skill says.
describe("runHostReview's rounds", () => {
  it("reviews with the Bar and the lenses the diff's files match in round 1", async () => {
    const run = fake();

    await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(run.lensesIn(1), [...CODE_REVIEWERS].sort());
    assert.deepEqual(run.reviewerRuns.map((found) => found.attempt), run.reviewerRuns.map(() => 1));
  });

  it("starts the reviewers for a Markdown-only diff the Bar, Docs match the code and Repo conventions", async () => {
    const run = fake({ patches: () => ({ patch: diffFor("README.md") }) });

    await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(run.lensesIn(1), [BAR_LENS, "Docs match the code", "Repo conventions"].sort());
  });

  it("starts a repository's own lens beside the skill's", async () => {
    const run = fake({ repoLenses: "| Lens | Applies to | Ask |\n| --- | --- | --- |\n| Billing | Invoices | Does every total round? |\n" });

    await runHostReview(run.host, input(run.startHead));

    assert.ok(run.lensesIn(1).includes("Billing"), run.lensesIn(1).join(", "));
  });

  it("gives every reviewer the Bar's text, and each lens reviewer its lens's Ask", async () => {
    const run = fake();

    await runHostReview(run.host, input(run.startHead));

    for (const found of run.reviewerRuns) {
      assert.ok(found.prompt.includes(barMd.trim()), `${found.lens} lacks review-bar.md`);
      if (found.lens === BAR_LENS) continue;
      const ask = lensesMd.split("\n").find((line) => line.startsWith(`| ${found.lens} |`))?.split("|")[3]?.trim();
      assert.ok(ask !== undefined && found.prompt.includes(ask), `${found.lens} lacks its Ask`);
    }
  });

  it("(no findings) ends after one round: no fixer, no gate, one record", async () => {
    const run = fake();

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.equal(result.rounds, 1);
    assert.equal(run.fixerPrompts.length, 0);
    assert.equal(run.gateRuns(), 0);
    assert.equal(run.records.length, 1);
    assert.equal(run.records[0]?.input.rounds, 1);
    assert.deepEqual(run.records[0]?.input.findings, []);
    assert.deepEqual(run.events, ["prepare 1", "record"]);
  });

  it("(a fixable Critical) has the backend fix it, runs the gate, reviews the fixes only in round 2, and ends when that finds nothing", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.deepEqual(run.events, ["prepare 1", "fixer 1", "gate 1", "prepare 2", "record"]);
    assert.equal(result.rounds, 2);
    const [found] = run.records[0]!.input.findings;
    assert.equal(found?.id, "R1");
    assert.equal(found?.status, "fixed");
    assert.equal(found?.test, "tests/app.test.ts::blank_name");
  });

  it("starts round 2's prepare from the commit round 1 read, so only the fixes are read", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    await runHostReview(run.host, input(run.startHead));

    assert.equal(run.prepares[0]?.head, run.startHead);
    assert.equal(run.prepares[0]?.main, BASE);
    assert.equal(run.prepares[0]?.since, undefined);
    assert.equal(run.prepares[1]?.since?.commit, run.prepared[0]?.head);
    assert.equal(run.prepares[1]?.main, BASE);
  });

  it("chooses round 2's reviewers by the files the fixes change, and tells them to read fixes.patch with diff.patch as context", async () => {
    const run = fake({
      answers: (round, who) =>
        round === 1 && who.lens === "Docs match the code" ? [raw({ lens: "Docs match the code", severity: "advisory", path: "README.md", summary: "The README is stale." })] : [],
      patches: (n) => ({ patch: diffFor("src/app.ts"), ...(n > 1 ? { fixes: diffFor("README.md") } : {}) }),
      fixer: () => ({ outcomes: [{ id: "R1", status: "fixed", test: null, reason: "A prose fix: no test can pin it." }], changed: ["README.md"] }),
    });

    await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(run.lensesIn(2), [BAR_LENS, "Docs match the code", "Repo conventions"].sort());
    for (const found of run.reviewerRuns.filter((entry) => entry.round === 2)) {
      assert.match(found.prompt, /fixes\.patch/);
      assert.match(found.prompt, /diff\.patch/);
    }
    for (const found of run.reviewerRuns.filter((entry) => entry.round === 1)) assert.doesNotMatch(found.prompt, /fixes\.patch/);
  });

  it("numbers findings after the ids already taken, and on across rounds", async () => {
    const run = fake({
      taken: 4,
      answers: (round, who) => {
        if (round === 1 && who.lens === "Edge cases") return [raw()];
        if (round === 2 && who.lens === "Tests") return [raw({ lens: "Tests", path: "tests/app.test.ts", summary: "No test for the empty name.", needsPerson: true })];
        return [];
      },
      fixer: () => ({ outcomes: [fixedWithTest("R5")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.deepEqual(run.records[0]?.input.findings.map((found) => [found.id, found.status]), [["R5", "fixed"], ["R6", "open"]]);
    assert.equal(result.rounds, 2);
  });

  it("(a finding that needs a person) records it open with its fix, runs no fixer and no gate, and ends after round 1", async () => {
    const run = fake({ answers: only("Edge cases", [raw({ needsPerson: true })]) });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.equal(result.rounds, 1);
    assert.equal(run.fixerPrompts.length, 0);
    assert.equal(run.gateRuns(), 0);
    const [found] = run.records[0]!.input.findings;
    assert.equal(found?.status, "open");
    assert.equal(found?.fix, "Trim the name first.");
  });

  it("(a Warning) is recorded fixed when the backend names its test", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Security" ? [raw({ lens: "Security", severity: "warning", summary: "Open redirect." })] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    recorded(await runHostReview(run.host, input(run.startHead)));

    const [found] = run.records[0]!.input.findings;
    assert.equal(found?.status, "fixed");
    assert.equal(found?.security, true);
    assert.equal(found?.severity, "warning");
  });

  it("(a Warning) is recorded open, with its fix, when the backend gives only a reason, and the review ends after that round", async () => {
    const run = fake({
      answers: only("Security", [raw({ lens: "Security", severity: "warning", summary: "Open redirect." })]),
      fixer: () => ({ outcomes: [{ id: "R1", status: "fixed", test: null, reason: "No test is needed." }], changed: ["src/app.ts"], advance: false }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    const [found] = run.records[0]!.input.findings;
    assert.equal(found?.status, "open");
    assert.equal(found?.fix, "Trim the name first.");
    assert.equal(result.rounds, 1);
    assert.equal(run.gateRuns(), 0);
  });

  it("(three fixing rounds, then the review-only round) leaves its finding open, never sends it to the fixer, and runs no fifth round", async () => {
    const run = fake({
      answers: (round, who) => (who.lens === "Edge cases" ? [raw({ line: round * 10, summary: `Problem number ${round}.` })] : []),
      fixer: (n) => ({ outcomes: [fixedWithTest(`R${n}`)], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.equal(REVIEW_FIX_ROUNDS, 3);
    assert.equal(result.rounds, 4);
    assert.equal(run.rounds(), 4);
    assert.equal(run.fixerPrompts.length, 3);
    assert.equal(run.gateRuns(), 3);
    assert.deepEqual(run.records[0]?.input.findings.map((found) => [found.id, found.status]), [["R1", "fixed"], ["R2", "fixed"], ["R3", "fixed"], ["R4", "open"]]);
    assert.equal(run.records[0]?.input.rounds, 4);
    assert.match(run.records[0]?.input.findings[3]?.fix ?? "", /\S/);
    assert.deepEqual(run.events.slice(-3), ["gate 3", "prepare 4", "record"]);
  });

  it("leaves a finding open when the backend says fixed but the test's file isn't among the files it changed, and goes on to review the other fixes", async () => {
    const run = fake({
      answers: (round, who) =>
        round === 1 && who.lens === "Edge cases" ? [raw(), raw({ line: 30, summary: "Second problem." })] : [],
      fixer: () => ({
        outcomes: [fixedWithTest("R1"), { id: "R2", status: "fixed", test: "tests/elsewhere.test.ts::x", reason: null }],
        changed: ["src/app.ts", "tests/app.test.ts"],
      }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.deepEqual(run.records[0]?.input.findings.map((found) => [found.id, found.status]), [["R1", "fixed"], ["R2", "open"]]);
    assert.equal(result.rounds, 2);
  });

  it("leaves a finding open when the backend says fixed but HEAD didn't move", async () => {
    const run = fake({
      answers: only("Edge cases", [raw()]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: [], advance: false }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.equal(run.records[0]?.input.findings[0]?.status, "open");
    assert.equal(result.rounds, 1);
    assert.equal(run.gateRuns(), 0);
  });

  it("records a dismissal that cites file:line, and leaves one that doesn't open", async () => {
    const run = fake({
      answers: only("Edge cases", [raw(), raw({ line: 30, summary: "Second problem." })]),
      fixer: () => ({
        outcomes: [
          { id: "R1", status: "dismissed", test: null, reason: "src/app.ts:12 already trims the name." },
          { id: "R2", status: "dismissed", test: null, reason: "The reviewer is wrong." },
        ],
        advance: false,
      }),
    });

    recorded(await runHostReview(run.host, input(run.startHead)));

    assert.deepEqual(run.records[0]?.input.findings.map((found) => [found.id, found.status]), [["R1", "dismissed"], ["R2", "open"]]);
  });

  it("leaves every finding of the round open when the backend wrote no outcomes", async () => {
    const run = fake({ answers: only("Edge cases", [raw()]), fixer: () => ({ advance: false }) });

    recorded(await runHostReview(run.host, input(run.startHead)));

    assert.equal(run.records[0]?.input.findings[0]?.status, "open");
  });

  it("leaves every finding of the round open when the outcomes aren't valid JSON", async () => {
    const run = fake({ answers: only("Edge cases", [raw()]), fixer: () => ({ outcomes: "{not json", advance: false }) });

    recorded(await runHostReview(run.host, input(run.startHead)));

    assert.equal(run.records[0]?.input.findings[0]?.status, "open");
  });

  it("merges one problem two lenses raised into a single finding for the backend and the record, with the Warning winning", async () => {
    const run = fake({
      answers: (round, who) => {
        if (round !== 1) return [];
        if (who.lens === "Edge cases") return [raw()];
        if (who.lens === "Security") return [raw({ lens: "Security", severity: "warning" })];
        return [];
      },
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    recorded(await runHostReview(run.host, input(run.startHead)));

    const found = run.records[0]!.input.findings;
    assert.equal(found.length, 1);
    assert.equal(found[0]?.lens, "Edge cases/Security");
    assert.equal(found[0]?.severity, "warning");
    assert.equal(run.fixerPrompts.length, 1);
  });

  it("(a gate that stays red after the fixes) ends as a gate failure and records nothing", async () => {
    const run = fake({
      answers: only("Edge cases", [raw()]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      gates: [undefined],
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(result, { status: "gate failed" });
    assert.equal(run.records.length, 0);
    assert.equal(run.rounds(), 1);
  });

  it("records what the last round read, as the reviewer agent that read it", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    const last = run.prepared[1]!;
    const record = run.records[0]!;
    assert.equal(record.input.reviewedKey, last.key);
    assert.equal(record.input.reviewedHead, last.head);
    assert.equal(record.input.reviewerAgent, "pre-push-reviewer");
    assert.equal(record.input.rounds, 2);
    assert.deepEqual(record.at, { head: last.head, branch: "feature/387-the-host-review" });
    assert.equal(result.head, last.head);
    assert.equal(result.ledger.head, last.head);
    assert.doesNotThrow(() => reviewInputSchema.parse(record.input));
  });

  it("records no host-only fields on a finding", async () => {
    const run = fake({ answers: only("Edge cases", [raw({ needsPerson: true })]) });

    recorded(await runHostReview(run.host, input(run.startHead)));

    for (const found of run.records[0]!.input.findings) {
      assert.ok(!("needsPerson" in found) && !("fixable" in found), JSON.stringify(found));
    }
  });
});

// Criterion: no agent can read, write or run scripts/review.sh or .git/review; only the host records.
describe("runHostReview's decisions file", () => {
  const decisionsOf = (run: ReturnType<typeof fake>, round: number) => {
    const writes = run.files.filter((file) => file.path.endsWith("decisions.md"));
    return writes[round - 1]?.content ?? "";
  };

  it("says nothing was decided in round 1, and lists round 1's findings and their outcomes in round 2", async () => {
    const run = fake({ answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []), fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["tests/app.test.ts"] }) });

    recorded(await runHostReview(run.host, input(run.startHead)));

    assert.match(decisionsOf(run, 1), /Nothing has been decided yet/);
    assert.match(decisionsOf(run, 2), /R1 \(Edge cases, src\/app\.ts:10\) fixed, pinned by tests\/app\.test\.ts::blank_name/);
  });

  it("marks a finding left open to be raised again", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw(), raw({ line: 30, summary: "Other.", needsPerson: true })] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["tests/app.test.ts"] }),
    });

    recorded(await runHostReview(run.host, input(run.startHead)));

    assert.match(decisionsOf(run, 2), /R2 .*Other\..*Raise again if still in the code/);
  });
});

describe("runHostReview's access", () => {
  const withoutAgentBody = (prompt: string) => prompt.replace(agentBody, "").replace(agentBody.trim(), "");
  const forbidden: [string, RegExp][] = [
    ["a shell", /\bBash\b/],
    ["gh", /\bgh\b/],
    ["scripts/review.sh", /review\.sh/],
    [".git/review", /\.git\/review/],
    ["GH_TOKEN", /GH_TOKEN/],
    ["GITHUB_TOKEN", /GITHUB_TOKEN/],
  ];

  it("holds no shell, gh, token, scripts/review.sh or .git/review in any reviewer's prompt", async () => {
    const run = fake({ answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []), fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["tests/app.test.ts"] }) });

    await runHostReview(run.host, input(run.startHead));

    assert.ok(run.reviewerRuns.length > 8);
    for (const found of run.reviewerRuns) {
      const prompt = withoutAgentBody(found.prompt);
      for (const [what, pattern] of forbidden) assert.doesNotMatch(prompt, pattern, `${found.lens}'s prompt names ${what}`);
      assert.equal(containsSecret(found.prompt, []), false, `${found.lens}'s prompt holds a token shape`);
    }
  });

  it("holds no gh, token, scripts/review.sh or .git/review in the fixer's prompt", async () => {
    const run = fake({ answers: only("Edge cases", [raw()]), fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["tests/app.test.ts"] }) });

    await runHostReview(run.host, input(run.startHead));

    assert.equal(run.fixerPrompts.length >= 1, true);
    for (const prompt of run.fixerPrompts) {
      for (const [what, pattern] of forbidden) assert.doesNotMatch(prompt, pattern, `the fixer's prompt names ${what}`);
      assert.equal(containsSecret(prompt, []), false);
    }
  });

  it("writes only under the run's folder in the work directory, which the sandbox git-ignores", async () => {
    const run = fake({ answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []), fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["tests/app.test.ts"] }) });

    await runHostReview(run.host, input(run.startHead));

    assert.ok(run.files.length > 0);
    for (const file of run.files) assert.ok(file.path.startsWith(".sandcastle/work/387/review/"), file.path);
  });

  it("writes each round's whole diff, and the fixes of a later round, for the reviewers to read", async () => {
    const run = fake({ answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []), fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["tests/app.test.ts"] }) });

    await runHostReview(run.host, input(run.startHead));

    assert.ok(run.files.some((file) => /diff\.patch$/.test(file.path) && file.content.includes("diff --git a/src/app.ts")));
    assert.ok(run.files.some((file) => /fixes\.patch$/.test(file.path) && file.content.includes("tests/app.test.ts")));
  });

  it("gives each reviewer the issue's title as data to review the branch against", async () => {
    const run = fake();

    await runHostReview(run.host, input(run.startHead));

    for (const found of run.reviewerRuns) assert.ok(found.prompt.includes(issueText.title), found.lens);
  });

  it("names the diff and the worktree by absolute path in each reviewer's prompt", async () => {
    const run = fake();

    await runHostReview(run.host, input(run.startHead));

    for (const found of run.reviewerRuns) {
      assert.match(found.prompt, /\/home\/agent\/workspace\/\.sandcastle\/work\/387\/review\/(?:[^\s]*\/)?diff\.patch/);
    }
  });
});

// Criterion: a usage or time stop during the review leaves the branch for a later round and is not published as reviewed. A reviewer that
// fails is reported, and the branch is not recorded as reviewed.
describe("runHostReview's stops and failures", () => {
  it("rejects with the UncountedStopError a reviewer hits, after the other reviewers settle, and records nothing", async () => {
    const stop = new UncountedStopError("Claude's usage limit was hit during the pre-push-reviewer run");
    let settled = 0;
    const run = fake({
      answers: (_round, who) => {
        if (who.lens === "Security") return stop;
        settled++;
        return [];
      },
    });

    await assert.rejects(() => runHostReview(run.host, input(run.startHead)), (error: unknown) => error === stop);

    assert.equal(settled, CODE_REVIEWERS.length - 1);
    assert.equal(run.records.length, 0);
    assert.equal(run.fixerPrompts.length, 0);
  });

  it("rejects with the UncountedStopError the fixer hits, and records nothing", async () => {
    const stop = new UncountedStopError("the run's 240-minute time budget has passed");
    const run = fake({ answers: only("Edge cases", [raw()]), fixer: () => ({ error: stop }) });

    await assert.rejects(() => runHostReview(run.host, input(run.startHead)), (error: unknown) => error === stop);

    assert.equal(run.records.length, 0);
  });

  it("rethrows a stop in a later round too, without recording the earlier rounds", async () => {
    const stop = new UncountedStopError("usage limit");
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : round === 2 ? stop : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    await assert.rejects(() => runHostReview(run.host, input(run.startHead)), (error: unknown) => error === stop);

    assert.equal(run.records.length, 0);
  });

  it("asks a reviewer whose answer is garbage a second time, quoting what was wrong, and goes on when the second answer is valid", async () => {
    const run = fake({ answers: (_round, who, attempt) => (who.lens === "Tests" && attempt === 1 ? "I have no findings block." : []) });
    let problem = "";
    try {
      parseReviewerAnswer("I have no findings block.");
    } catch (error) {
      problem = (error as Error).message;
    }

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "recorded");
    const tests = run.reviewerRuns.filter((found) => found.lens === "Tests");
    assert.equal(tests.length, 2);
    assert.notEqual(tests[1]?.prompt, tests[0]?.prompt);
    assert.ok(tests[1]!.prompt.includes(problem), "the retry prompt quotes the validation error");
  });

  it("reports a reviewer that answers garbage twice as a failed review that names its lens, and records nothing", async () => {
    const run = fake({ answers: (_round, who) => (who.lens === "Security" ? "no block, twice" : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.match((result as { reason: string }).reason, /Security/);
    assert.equal(run.reviewerRuns.filter((found) => found.lens === "Security").length, 2);
    assert.equal(run.records.length, 0);
    assert.equal(run.fixerPrompts.length, 0);
  });

  it("reports a reviewer that times out as a failed review that names its lens, and records nothing", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const run = fake({ answers: (_round, who) => (who.lens === "Error contract" ? timeout : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.match((result as { reason: string }).reason, /Error contract/);
    assert.equal(run.records.length, 0);
  });

  it("reports a reviewer that throws an ordinary error as a failed review too, not as a crash", async () => {
    const run = fake({ answers: (_round, who) => (who.lens === BAR_LENS ? new Error("sandbox went away") : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.match((result as { reason: string }).reason, /Bar/);
    assert.equal(run.records.length, 0);
  });

  it("gives a failed review the commit it stopped at", async () => {
    const run = fake({ answers: (_round, who) => (who.lens === BAR_LENS ? "nothing" : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal((result as { head: string }).head, run.startHead);
  });

  // Every host call outside the reviewers and the fixer can throw (a missing file, a failed git, a sandbox exec): none may escape.
  const throwing: { name: string; options?: Fake; wrap: (host: HostReviewHost) => void }[] = [
    { name: "readSkillFiles", wrap: (host) => void (host.readSkillFiles = () => { throw new Error("no agent file"); }) },
    { name: "worktree", wrap: (host) => void (host.worktree = async () => { throw new Error("rev-parse failed"); }) },
    { name: "takenIds", wrap: (host) => void (host.takenIds = () => { throw new Error("no merge base"); }) },
    { name: "writeRunFile", wrap: (host) => void (host.writeRunFile = async () => { throw new Error("exec failed"); }) },
    {
      name: "head",
      options: { answers: only("Edge cases", [{ lens: "Edge cases", path: "src/app.ts", line: 1, severity: "critical", summary: "x", fix: "y", needsPerson: false, why: "" }]) },
      wrap: (host) => void (host.head = async () => { throw new Error("head failed"); }),
    },
    {
      name: "changedFiles",
      options: { answers: only("Edge cases", [{ lens: "Edge cases", path: "src/app.ts", line: 1, severity: "critical", summary: "x", fix: "y", needsPerson: false, why: "" }]) },
      wrap: (host) => void (host.changedFiles = () => { throw new Error("diff failed"); }),
    },
    {
      name: "readOutcomes",
      options: { answers: only("Edge cases", [{ lens: "Edge cases", path: "src/app.ts", line: 1, severity: "critical", summary: "x", fix: "y", needsPerson: false, why: "" }]) },
      wrap: (host) => void (host.readOutcomes = async () => { throw new Error("cat failed"); }),
    },
  ];
  for (const { name, options, wrap } of throwing) {
    it(`reports a ${name} that throws as a failed review with a host-written reason, not as a crash`, async () => {
      const run = fake(options);
      wrap(run.host);

      const result = await runHostReview(run.host, input(run.startHead));

      assert.equal(result.status, "failed");
      assert.doesNotMatch((result as { reason: string }).reason, /failed:|no agent file|exec failed/);
      assert.equal(run.records.length, 0);
    });
  }

  it("fails with the last gated commit when a host call throws after an earlier round's fixes passed the gate", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [{ lens: "Edge cases", path: "src/app.ts", line: 1, severity: "critical", summary: "x", fix: "y", needsPerson: false, why: "" }] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["tests/app.test.ts"] }),
    });
    const prepare = run.host.prepare;
    run.host.prepare = (opts) => {
      const result = prepare(opts);
      if (run.prepared.length === 2) run.host.writeRunFile = async () => { throw new Error("exec failed"); };
      return result;
    };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal((result as { head: string }).head, hex(2));
  });

  it("still rethrows a usage or time stop from a host call", async () => {
    const run = fake();
    const stop = new UncountedStopError("usage limit");
    run.host.worktree = async () => { throw stop; };

    await assert.rejects(() => runHostReview(run.host, input(run.startHead)), (error: unknown) => error === stop);
  });

  it("logs a failing reviewer's own error for the operator, and keeps it out of the reason", async () => {
    const run = fake({ answers: (_round, who) => (who.lens === "Tests" ? new Error("docker image missing") : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.ok(run.logs.some((line) => line.includes("Tests") && line.includes("docker image missing")), run.logs.join("\n"));
    assert.doesNotMatch((result as { reason: string }).reason, /docker image missing/);
  });

  it("logs a thrown value that isn't an Error as text, not as undefined", async () => {
    const run = fake();
    run.host.worktree = async () => {
      throw "plain string thrown";
    };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.ok(run.logs.some((line) => line.includes("plain string thrown")), run.logs.join("\n"));
  });

  it("puts nothing from the reviewer's failure text that is the agent's own in the reason: the reason is host-written", async () => {
    const run = fake({ answers: (_round, who) => (who.lens === "Tests" ? new Error(`${"gh"}p_${"0123456789abcdef".repeat(2)}0123 leaked`) : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.doesNotMatch((result as { reason: string }).reason, /ghp_/);
  });
});

describe("openFindingsNote's size", () => {
  const manyOpen = (count: number, summary: string): Ledger => ({
    version: 1,
    key: "k",
    branch: "feature/387-x",
    base: BASE,
    head: hex(2),
    recordedAt: "2026-01-01T00:00:00.000Z",
    rounds: 1,
    findings: Array.from({ length: count }, (_, index) => ({
      id: `R${index + 1}`,
      lens: "Edge cases",
      path: "src/app.ts",
      line: index + 1,
      summary,
      severity: "critical" as const,
      security: false,
      status: "open" as const,
      test: null,
      reason: null,
      fix: summary,
    })),
  });

  it("lists at most 20 findings and counts the rest", () => {
    const note = openFindingsNote(manyOpen(150, "Short."));

    assert.equal(note.split("\n").filter((line) => line.startsWith("- R")).length, 20);
    assert.match(note, /130 more open findings are in the local review record/);
  });

  it("cuts a long summary and fix, so the note stays well under GitHub's limit", () => {
    const note = openFindingsNote(manyOpen(150, "x".repeat(5000)));

    assert.ok(note.length < 15_000, `the note is ${note.length} characters`);
    assert.match(note, /…/);
  });
});

describe("openFindingsNote", () => {
  const ledgerOf = (findings: Ledger["findings"]): Ledger => ({
    version: 1,
    key: "k",
    branch: "feature/387-x",
    base: BASE,
    head: hex(2),
    recordedAt: "2026-01-01T00:00:00.000Z",
    rounds: 1,
    findings,
  });
  const found = (overrides: Partial<Ledger["findings"][number]> = {}): Ledger["findings"][number] => ({
    id: "R1",
    lens: "Edge cases",
    path: "src/app.ts",
    line: 12,
    summary: "A blank name passes the guard.",
    severity: "critical",
    security: false,
    status: "open",
    test: null,
    reason: null,
    fix: "Trim the name first.",
    ...overrides,
  });

  it("is empty when nothing is open", () => {
    assert.equal(openFindingsNote(ledgerOf([])), "");
    assert.equal(openFindingsNote(ledgerOf([found({ status: "fixed", test: "t::x" }), found({ id: "R2", status: "dismissed", reason: "a.ts:1 shows it." })])), "");
  });

  it("lists an open finding with its id, place, summary and suggested fix", () => {
    const note = openFindingsNote(ledgerOf([found()]));

    assert.match(note, /R1/);
    assert.match(note, /src\/app\.ts:12/);
    assert.match(note, /A blank name passes the guard\./);
    assert.match(note, /Suggested fix: Trim the name first\./);
  });

  it("lists an open Advisory finding that isn't a security one", () => {
    assert.match(openFindingsNote(ledgerOf([found({ severity: "advisory", summary: "A stale comment." })])), /A stale comment\./);
  });

  it("only counts security findings, whatever their grade, and never lists their summary, path or fix", () => {
    const note = openFindingsNote(
      ledgerOf([
        found({ id: "R1", severity: "warning", security: true, summary: "The token reaches a log line.", path: "src/log.ts", fix: "Redact it." }),
        found({ id: "R2", lens: "Security", severity: "critical", security: false, summary: "Open redirect.", path: "src/redirect.ts" }),
      ]),
    );

    assert.match(note, /2 security findings?/);
    assert.doesNotMatch(note, /token reaches/);
    assert.doesNotMatch(note, /Open redirect/);
    assert.doesNotMatch(note, /src\/(?:log|redirect)\.ts/);
    assert.doesNotMatch(note, /Redact it/);
  });

  it("neutralises mentions and issue references in what the reviewers wrote, as plainText does", () => {
    const summary = "Calls @octocat and closes #12.";
    const note = openFindingsNote(ledgerOf([found({ summary })]));

    assert.ok(note.includes(plainText(summary)), note);
    assert.ok(!note.includes(summary), note);
  });
});
