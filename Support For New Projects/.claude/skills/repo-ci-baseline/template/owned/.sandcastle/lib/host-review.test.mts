import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REVIEWER_TOOLS } from "./agents.mts";
import { FIXED_ROLE_AGENTS, MAX_REVIEWERS_PER_ROUND, REVIEW_FIX_ROUNDS, REVIEW_WALL_CLOCK_MINUTES } from "./config.mts";
import { StalledStepError, TimeBudgetStopError, UncountedStopError } from "./errors.mts";
import {
  applyOutcomes,
  resolveRepeats,
  BAR_LENS,
  LENS_APPLIES,
  MAX_REVIEW_PATCH_BYTES,
  diffPath,
  advisoryIssueBody,
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

  it("gives a diff of only Markdown outside .claude/ and .sandcastle/ the Docs match the code and Repo conventions lenses, as the skill says", () => {
    assert.deepEqual(names(reviewersFor(["README.md", "docs/adr/0001-x.md"], lenses)), [BAR_LENS, "Docs match the code", "Repo conventions"]);
  });

  it("gives Markdown that steers an agent the Security lens too: an agent's tool list, a skill, a rule, a role prompt", () => {
    for (const path of [".claude/agents/x.md", ".claude/skills/pre-push-review/SKILL.md", ".claude/rules/sandcastle.md", ".sandcastle/roles/gate-fixer.md", "Support For New Projects/.claude/skills/y/SKILL.md"]) {
      assert.ok(names(reviewersFor([path], lenses)).includes("Security"), path);
    }
    assert.ok(!names(reviewersFor(["docs/PROCESS.md"], lenses)).includes("Security"));
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

  it("reads a quoted header holding an escaped quote or a tab, a path with ' b/' inside, and a path that itself starts with b/", () => {
    const patch =
      'diff --git "a/x\\"y.ts" "b/x\\"y.ts"\n--- "a/x\\"y.ts"\n+++ "b/x\\"y.ts"\n@@ -1 +1 @@\n-a\n+b\n' +
      'diff --git "a/t\\tab.ts" "b/t\\tab.ts"\n--- "a/t\\tab.ts"\n+++ "b/t\\tab.ts"\n@@ -1 +1 @@\n-a\n+b\n' +
      "diff --git a/a b/c.ts b/a b/c.ts\n--- a/a b/c.ts\n+++ b/a b/c.ts\n@@ -1 +1 @@\n-a\n+b\n" +
      "diff --git a/b/x.ts b/b/x.ts\n--- a/b/x.ts\n+++ b/b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

    assert.deepEqual(patchPaths(patch), ['x"y.ts', "t\tab.ts", "a b/c.ts", "b/x.ts"]);
  });

  it("doesn't throw on a header it can't read", () => {
    assert.doesNotThrow(() => patchPaths('diff --git "a/unterminated b/x\n--- a/x\n'));
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

  it("refuses an output with two blocks of valid findings, since a second answer or a quote after the answer can't be told apart", () => {
    const out = `${block([finding({ summary: "quoted from a file" })])}\nmy answer:\n${block([finding({ summary: "the real one" })])}`;

    assert.throws(() => parseReviewerAnswer(out), ReviewerAnswerError);
  });

  it("refuses an answer followed by a quote of the format, which would otherwise read as clean", () => {
    assert.throws(() => parseReviewerAnswer(`${block([finding({ summary: "the real one" })])}\nThe format is <findings>[]</findings>`), ReviewerAnswerError);
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

describe("diffPath", () => {
  it("strips every leading ./ and the worktree's prefix, and nothing else", () => {
    assert.equal(diffPath("././src/a.ts"), "src/a.ts");
    assert.equal(diffPath("/w/t/src/a.ts", "/w/t"), "src/a.ts");
    assert.equal(diffPath("/w/t/src/a.ts", "/w/t///"), "src/a.ts");
    assert.equal(diffPath("/w/t-other/x", "/w/t"), "/w/t-other/x", "a path that only shares the worktree's text is left alone");
    assert.equal(diffPath("/w/t", "/w/t"), "/w/t", "the worktree itself names no file");
    assert.equal(diffPath("/w/t/src/a.ts"), "/w/t/src/a.ts", "with no worktree given");
    assert.equal(diffPath("/w/t/./src/a.ts", "/w/t"), "src/a.ts");
  });

  it("never returns an empty path, which the ledger refuses: ./ and the worktree's own folder come back as written", () => {
    assert.equal(diffPath("./"), "./");
    assert.equal(diffPath("././"), "././");
    assert.equal(diffPath("/w/t/", "/w/t"), "/w/t/");
  });
});

describe("triageRound", () => {
  const triage = (reviewers: Record<string, ReviewerFinding[]>, firstId = 1, reviewOnly = false) =>
    triageRound({ raw: Object.entries(reviewers).map(([lens, findings]) => ({ reviewer: reviewer(lens), findings })), firstId, reviewOnly });

  it("takes a finding's lens from the reviewer the host ran, so an answer can't dodge the Security lens by naming another", () => {
    const got = triageRound({
      raw: [{ reviewer: reviewer("Security"), findings: [raw({ lens: "Edge cases", severity: "critical", security: false })] }],
      firstId: 1,
      reviewOnly: false,
    });

    assert.equal(got[0]!.lens, "Security");
    assert.equal(got[0]!.severity, "warning");
    assert.equal(got[0]!.security, true);
  });

  it("merges one problem reported under different spellings of its path", () => {
    const got = triageRound({
      raw: [
        { reviewer: reviewer("Edge cases"), findings: [raw({ path: "./src/a.ts" })] },
        { reviewer: reviewer("Tests"), findings: [raw({ lens: "Tests", path: "/work/tree/src/a.ts" })] },
        { reviewer: reviewer("Bar"), findings: [raw({ lens: "Bar", path: "src/a.ts" })] },
      ],
      firstId: 1,
      reviewOnly: false,
      worktree: "/work/tree",
    });

    assert.equal(got.length, 1);
    assert.equal(got[0]!.path, "src/a.ts");
    assert.equal(got[0]!.lens, "Edge cases/Tests/Bar");
  });

  it("writes a path the way the diff does: without a leading ./ and without the worktree's absolute prefix", () => {
    const worktree = "/work/tree";
    const got = triageRound({
      raw: [{ reviewer: reviewer("Edge cases"), findings: [raw({ path: "./src/a.ts" }), raw({ path: "/work/tree/src/b.ts", line: 2 }), raw({ path: "/elsewhere/c.ts", line: 3 })] }],
      firstId: 1,
      reviewOnly: false,
      worktree,
    });

    assert.deepEqual(got.map((found) => found.path), ["src/a.ts", "src/b.ts", "/elsewhere/c.ts"]);
  });

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

  it("reads a finding whose text quotes the opening tag, or a whole block, without reading the quote as the answer", () => {
    const quoted = raw({ summary: "The format is <findings>[]</findings>, and the parser must not stop at it.", fix: "Quote <findings> safely." });
    const second = raw({ line: 30, summary: "A second finding that must survive." });

    const got = parseReviewerAnswer(block([quoted, second]));

    assert.deepEqual(got.map((found) => found.summary), [quoted.summary, second.summary]);
  });

  it("reads an answer that follows a copy of the prompt's own example finding", async () => {
    const run = fake({});
    await runHostReview(run.host, input(run.startHead));
    const example = /<findings>\n([\s\S]*?)\n<\/findings>/.exec(run.reviewerRuns[0]!.prompt)![1]!;
    const answer = [raw()];

    assert.deepEqual(parseReviewerAnswer(`I will answer like <findings>${example}</findings>.\n${block(answer)}`).map((found) => found.summary), [answer[0]!.summary]);
  });

  it("ignores a quoted example block before the answer and prose that mentions the tags after it", () => {
    const answer = [raw()];
    const text = `The format is <findings>[{"lens":"x"}]</findings>. Here is my answer:\n${block(answer)}\nSee the <findings> block above, and the </findings> tag.`;

    assert.deepEqual(parseReviewerAnswer(text).map((found) => found.summary), [answer[0]!.summary]);
  });

  it("refuses a malformed or cut-short answer after a quoted block, instead of reading the quoted one as the answer", () => {
    const bad = `{ "lens": "Bar", }`;
    assert.throws(() => parseReviewerAnswer(`Format: <findings>[]</findings>\n<findings>[${bad}]</findings>`), ReviewerAnswerError);
    assert.throws(() => parseReviewerAnswer(`Format: <findings>[]</findings>\n<findings>[${bad}`), ReviewerAnswerError);
  });

  it("refuses a malformed or cut-short answer whose `[` comes after a long run of whitespace, and ignores a tag with no `[` after it", () => {
    const bad = `{ "lens": "Bar", }`;
    for (const gap of [" ".repeat(200), "\n ".repeat(100)]) {
      assert.throws(() => parseReviewerAnswer(`Format: <findings>[]</findings>\n<findings>${gap}[${bad}]</findings>`), /not valid JSON/);
      assert.throws(() => parseReviewerAnswer(`Format: <findings>[]</findings>\n<findings>${gap}[${bad}`), /not valid JSON/);
    }
    assert.deepEqual(parseReviewerAnswer(`<findings>[]</findings>\nThe tag is <findings>${" ".repeat(200)}and no array.`), []);
  });

  it("reads the real answer after more than the capped number of quoted blocks", () => {
    const answer = [raw()];
    const quotes = `<findings>[]</findings> `.repeat(25);

    assert.deepEqual(parseReviewerAnswer(`${quotes}\n${block(answer)}`).map((found) => found.summary), [answer[0]!.summary]);
  });

  it("reads an answer whose summary quotes an empty block, after more quoted blocks than the parser reads", () => {
    const quotes = `<findings>[]</findings> `.repeat(25);
    const answer = [raw({ summary: "The format is <findings>[]</findings>, and the parser must not stop at it." }), raw({ line: 30, summary: "A second finding that must survive." })];

    const got = parseReviewerAnswer(`${quotes}\n${block(answer)}`);

    assert.deepEqual(got.map((found) => found.summary), answer.map((found) => found.summary));
  });

  it("refuses a block of findings followed by more quoted blocks than the parser reads, rather than read the last one as clean", () => {
    const quote = "<findings>[]</findings> ";

    assert.throws(() => parseReviewerAnswer(`${block([raw()])}\n${quote.repeat(21)}`), ReviewerAnswerError);
    // 21 closing tags are one more than are read; with 20 the parser reads the first block itself and refuses on its own two-blocks rule.
    assert.throws(() => parseReviewerAnswer(`${block([raw()])}\n${quote.repeat(20)}`), /more <findings> tags than are read/);
    assert.throws(() => parseReviewerAnswer(`${block([raw()])}\n${quote.repeat(19)}`), /two blocks of findings/);
    assert.deepEqual(parseReviewerAnswer(`${quote.repeat(21)}\n${block([raw()])}`).map((found) => found.summary), [raw().summary]);
    assert.throws(() => parseReviewerAnswer(`<findings>[ \n {"x":1}]</findings> ${quote.repeat(21)}`), ReviewerAnswerError, "whitespace inside the opening");
  });

  it("refuses a block whose opening tag is among the middle ones the parser doesn't try, and only those, rather than read the last empty block as clean", () => {
    // `total` opening tags in all: the real block's is at `index`, the rest sit in prose, and a quoted empty block ends the output.
    const answer = (index: number, total: number, gap = " ") => {
      const prose = "A <findings> tag in prose. ";
      const real = `<findings>${gap}${JSON.stringify([raw()])}</findings>`;
      return `${prose.repeat(index)}${real}${prose.repeat(total - 2 - index)}<findings>[]</findings>`;
    };
    const refused = /more <findings> tags than are read/;
    const twoBlocks = /two blocks of findings/;

    assert.throws(() => parseReviewerAnswer(answer(15, 29)), refused);
    assert.throws(() => parseReviewerAnswer(answer(9, 29)), twoBlocks, "one of the first 10 is tried");
    assert.throws(() => parseReviewerAnswer(answer(10, 29)), refused, "the first one beyond them");
    assert.throws(() => parseReviewerAnswer(answer(18, 29)), refused, "the last one before the last 10");
    assert.throws(() => parseReviewerAnswer(answer(19, 29)), twoBlocks, "one of the last 10 is tried");
    assert.throws(() => parseReviewerAnswer(answer(10, 20)), twoBlocks, "20 opening tags are all tried");
    assert.throws(() => parseReviewerAnswer(answer(15, 29, "\n\n ")), refused, "whitespace after the tag");
    assert.throws(() => parseReviewerAnswer(answer(15, 29, " ".repeat(200))), refused, "a long run of whitespace after the tag");
  });

  it("tries a bounded number of tags", () => {
    const noise = "<findings>".repeat(5000) + "</findings>".repeat(5000);
    const started = Date.now();
    assert.throws(() => parseReviewerAnswer(noise), ReviewerAnswerError);
    assert.ok(Date.now() - started < 5000);
  });

  it("still refuses an answer with no block, an unclosed one and one that isn't a JSON array", () => {
    assert.throws(() => parseReviewerAnswer("no block"), ReviewerAnswerError);
    assert.throws(() => parseReviewerAnswer("<findings>[]"), ReviewerAnswerError);
    assert.throws(() => parseReviewerAnswer("</findings> then <findings>"), ReviewerAnswerError);
    assert.throws(() => parseReviewerAnswer(block("{}")), ReviewerAnswerError);
  });

  it("refuses a path the ledger would refuse, so the reviewer is asked again", () => {
    for (const path of ["`src/app.ts`", "src/a.ts (new)\tb", "<src/app.ts>", "src/a.ts\nsrc/b.ts"]) {
      assert.throws(() => parseReviewerAnswer(block([raw({ path })])), ReviewerAnswerError, path);
    }
  });

  it("accepts and refuses the same paths as the ledger's finding", () => {
    for (const path of ["src/app.ts", "Support For New Projects/a.md", "a b  c.ts", "`a.ts`", "a<b>.ts", "a\tb.ts", "a.ts "]) {
      const reviewer = (() => {
        try {
          parseReviewerAnswer(block([raw({ path })]));
          return true;
        } catch {
          return false;
        }
      })();
      const ledger = reviewInputSchema.safeParse({
        reviewedKey: "k",
        reviewedHead: "a".repeat(40),
        rounds: 1,
        findings: [{ id: "R1", lens: "Edge cases", path, line: 1, summary: "s", severity: "critical", security: false, status: "open", test: null, reason: null, fix: "f" }],
      }).success;
      assert.equal(reviewer, ledger, JSON.stringify(path));
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

  it("leaves a finding open when the backend names a source file it changed as the test, or any changed file that isn't a test", () => {
    for (const test of ["src/app.ts::blank", "src/other.ts::x", "README.md::x", "scripts/deploy.sh::x"]) {
      const got = apply(triaged(), [outcome({ test })], ["src/app.ts", "src/other.ts", "README.md", "scripts/deploy.sh"]);

      assert.equal(got.status, "open", test);
      assert.equal(got.fix, "Trim the name first.");
    }
    const warning = apply(triaged({ security: true, severity: "warning", lens: "Security" }), [outcome({ test: "src/app.ts::blank" })]);
    assert.equal(warning.status, "open", "a Warning isn't cleared behind the source file it edited");
  });

  it("takes a test in a test folder, a *.test.* or *_test.* file, a *Tests.cs file or the gate's checks as the test", () => {
    for (const test of ["tests/app.test.ts::x", "src/app.test.mts::x", "pkg/app_test.go::x", "tests/Web.Tests.Unit/OrderTests.cs::X", "test_app.py::x", ".github/ci/gate-checks.sh::review", "test.sh::x", "Support For New Projects/skill/test.sh::x", "pkg/Foo.Tests.ps1::x", "tests/a.bats::x", "web/app-spec.js::x"]) {
      const file = test.split("::")[0]!;
      assert.equal(apply(triaged(), [outcome({ test })], ["src/app.ts", file]).status, "fixed", test);
    }
  });

  it("leaves a finding open when the named test is a docs or data file, even in a test folder", () => {
    for (const test of ["docs/spec/notes.md::x", "tests/x.txt::x", "notes.test.md::x", "tests/data.json::x", "tests/cases.yml::x"]) {
      const file = test.split("::")[0]!;
      assert.equal(apply(triaged(), [outcome({ test })], ["src/app.ts", file]).status, "open", test);
    }
  });

  it("leaves a Critical fixed with no test open, with its fix, when the test's file wasn't changed in the round", () => {
    const got = apply(triaged(), [outcome({ test: "tests/other.test.ts::x" })], ["src/app.ts"]);

    assert.equal(got.status, "open");
    assert.equal(got.fix, "Trim the name first.");
    assert.doesNotThrow(() => recordable([got]));
  });

  it("leaves a Warning open when the backend names a test the round changed but the code at the finding's path wasn't touched", () => {
    const got = apply(triaged({ severity: "warning" }), [outcome()], ["tests/app.test.ts"]);

    assert.equal(got.status, "open");
    assert.equal(got.fix, "Trim the name first.");
  });

  it("leaves a security finding open when only an unrelated file changed beside its test", () => {
    const got = apply(triaged({ security: true, severity: "warning", lens: "Security" }), [outcome()], ["tests/app.test.ts", "src/other.ts"]);

    assert.equal(got.status, "open");
  });

  it("takes a Warning fixed when its own path starts with ./ (more than once) and the round changed that file without it", () => {
    const got = apply(triaged({ severity: "warning", path: "././src/app.ts" }), [outcome()], ["src/app.ts", "tests/app.test.ts"]);

    assert.equal(got.status, "fixed");
  });

  it("takes a Warning fixed when its path and its test's file both changed", () => {
    const got = apply(triaged({ severity: "warning" }), [outcome()], ["./src/app.ts", "tests/app.test.ts"]);

    assert.equal(got.status, "fixed");
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
  patches?: (round: number) => { patch: string; fixes?: string; readPatch?: string; readFixes?: string };
  fixer?: (run: number) => FixerRun;
  gates?: (string | undefined)[];
  taken?: number;
  repoLenses?: string;
  clock?: () => number;
  wallClockMs?: number;
};

// A host whose reviewers answer from a script, whose fixer moves HEAD when it is told it commits, and which records what happened in order.
function fake(options: Fake = {}) {
  const events: string[] = [];
  const reviewerRuns: { round: number; lens: string; prompt: string; attempt: number }[] = [];
  const fixerPrompts: string[] = [];
  const files: { path: string; content: string }[] = [];
  const removed: string[] = [];
  const prepares: Parameters<HostReviewHost["prepare"]>[0][] = [];
  const prepared: PreparedRound[] = [];
  const records: { input: ReviewInput; at: { head: string; branch: string } }[] = [];
  const logs: string[] = [];
  const changedCalls: { from: string; to: string }[] = [];
  let round = 0;
  let headNumber = 1;
  let fixerRuns = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let gateRuns = 0;
  let outcomesFile: string | undefined;
  let changed: string[] = [];
  const attempts = new Map<string, number>();
  const gates = [...(options.gates ?? [])];
  const patches: NonNullable<Fake["patches"]> = options.patches ?? ((n: number) => ({ patch: diffFor("src/app.ts"), ...(n > 1 ? { fixes: diffFor("src/app.ts", "tests/app.test.ts") } : {}) }));
  const host: HostReviewHost = {
    readSkillFiles: () => skillFiles(options.repoLenses),
    worktree: async () => "/home/agent/workspace",
    prepare: (opts) => {
      round++;
      events.push(`prepare ${round}`);
      prepares.push(opts);
      const { patch, fixes, readPatch, readFixes } = patches(round);
      const result: PreparedRound = {
        patch: Buffer.from(patch),
        fixes: fixes === undefined ? undefined : Buffer.from(fixes),
        // What the reviewers read: the whole diff unless a test says the verbatim Template mirrors were left out.
        readPatch: Buffer.from(readPatch ?? patch),
        readFixes: fixes === undefined ? undefined : Buffer.from(readFixes ?? fixes),
        key: `key-${round}`,
        head: opts.head ?? hex(headNumber),
        base: BASE,
      };
      prepared.push(result);
      return result;
    },
    takenIds: () => options.taken ?? 0,
    writeRunFile: async (path, content) => void files.push({ path, content: content.toString() }),
    removeRunFile: async (path) => void removed.push(path),
    runReviewer: async (reviewerToRun, prompt) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Yield, so reviewers the host started together would overlap here.
        await new Promise((resolve) => setImmediate(resolve));
        const key = `${round}:${reviewerToRun.lens}`;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        reviewerRuns.push({ round, lens: reviewerToRun.lens, prompt, attempt });
        const answer = options.answers?.(round, reviewerToRun, attempt) ?? [];
        if (answer instanceof Error) throw answer;
        return typeof answer === "string" ? answer : findingsBlock(answer);
      } finally {
        inFlight--;
      }
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
    ...(options.clock === undefined ? {} : { now: options.clock }),
    ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
  };
  return {
    host,
    events,
    reviewerRuns,
    maxInFlight: () => maxInFlight,
    fixerPrompts,
    files,
    removed,
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

  it("logs a size warning for a branch past 30 files, and still reviews it", async () => {
    const run = fake({ patches: () => ({ patch: diffFor(...Array.from({ length: 31 }, (_, index) => `src/f${index}.ts`)) }) });

    await runHostReview(run.host, input(run.startHead));

    assert.equal(run.logs.filter((line) => /⚠ this branch changes 31 files and 62 lines/.test(line)).length, 1, run.logs.join("\n"));
    assert.ok(run.reviewerRuns.length > 0, "the warning doesn't stop the review");
  });

  it("logs the size warning once across two rounds, since the patch of every round holds the same 31 files", async () => {
    const big = diffFor(...Array.from({ length: 31 }, (_, index) => `src/f${index}.ts`));
    const run = fake({
      answers: (round, who) => (who.lens === "Edge cases" && round === 1 ? [raw()] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      patches: (n) => ({ patch: big, ...(n > 1 ? { fixes: diffFor("src/f0.ts") } : {}) }),
    });

    await runHostReview(run.host, input(run.startHead));

    assert.ok(run.rounds() >= 2, "a second round ran");
    assert.equal(run.logs.filter((line) => line.includes("⚠")).length, 1, run.logs.join("\n"));
  });

  it("logs the size warning for 3,001 lines in one file, and none for 3,000", async () => {
    const oneFile = (lines: number) => `diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -0,0 +1,${lines} @@\n${"+x\n".repeat(lines)}`;
    const over = fake({ patches: () => ({ patch: oneFile(3001) }) });
    const at = fake({ patches: () => ({ patch: oneFile(3000) }) });

    await runHostReview(over.host, input(over.startHead));
    await runHostReview(at.host, input(at.startHead));

    assert.equal(over.logs.filter((line) => /⚠ this branch changes 1 file and 3,001 lines/.test(line)).length, 1, over.logs.join("\n"));
    assert.equal(at.logs.filter((line) => line.includes("⚠")).length, 0);
  });

  it("logs no size warning for a branch of exactly 30 files", async () => {
    const run = fake({ patches: () => ({ patch: diffFor(...Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`)) }) });

    await runHostReview(run.host, input(run.startHead));

    assert.equal(run.logs.filter((line) => line.includes("⚠")).length, 0);
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

  it("(a gate that stays red after the fixes) ends as failed at the last gated commit, which is published, and records nothing", async () => {
    const run = fake({
      answers: only("Edge cases", [raw()]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      gates: [undefined],
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, run.startHead, "no round passed the gate yet: the commit the review started on");
    assert.match(result.status === "failed" ? result.reason : "", /gate stayed red after round 1's fixes/);
    assert.equal(run.records.length, 0);
    assert.equal(run.rounds(), 1);
  });

  it("(a gate that goes red in round 2) keeps the commit round 1's fixes passed the gate on", async () => {
    const run = fake({
      answers: (round, who) => (who.lens === "Edge cases" && round <= 2 ? [raw()] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      gates: [hex(2), undefined],
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, hex(2));
    assert.match(result.status === "failed" ? result.reason : "", /after round 2's fixes/);
    assert.equal(run.records.length, 0);
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

  it("records a finding fixed in a later round as fixed in the earlier round too, when that round left it open, but not one that waits for a person", async () => {
    const run = fake({
      answers: (round, who) =>
        who.lens !== "Edge cases" ? [] : round === 1 ? [raw(), raw({ line: 30, summary: "Other.", needsPerson: true })] : round === 2 ? [raw(), raw({ line: 30, summary: "Other.", needsPerson: true })] : [],
      fixer: (n) =>
        n === 1
          ? { outcomes: [{ id: "R1", status: "open", test: null, reason: "The fix didn't hold." }], changed: ["tests/other.test.ts"] }
          : { outcomes: [fixedWithTest("R3")], changed: ["src/app.ts", "tests/app.test.ts"] },
    });

    recorded(await runHostReview(run.host, input(run.startHead)));

    const findings = run.records[0]!.input.findings;
    assert.equal(findings.find((found) => found.id === "R1")?.status, "fixed", "the earlier copy of a problem fixed later is fixed");
    assert.equal(findings.find((found) => found.id === "R1")?.test, "tests/app.test.ts::blank_name");
    assert.equal(findings.find((found) => found.id === "R2")?.status, "open", "a finding for a person stays open");
  });

  it("resolveRepeats clears only the same finding, and a Warning or security one only behind a test at no lower a grade", () => {
    const base = { path: "src/app.ts", line: 10, lens: "Edge cases", summary: "Blank name.", severity: "critical", security: false, test: null, reason: null, fix: "Trim." } as const;
    const open = (extra: object) => ({ ...base, id: "R1", status: "open", ...extra }) as ReviewInput["findings"][number];
    const fixed = (extra: object) => ({ ...base, id: "R3", status: "fixed", test: "tests/a.test.ts::x", ...extra }) as ReviewInput["findings"][number];
    const run = (earlier: object, later: object) => {
      const list = [open(earlier)];
      resolveRepeats(list, [fixed(later)], new Set());
      return list[0]!.status;
    };

    assert.equal(run({}, {}), "fixed", "the same finding");
    assert.equal(run({ summary: "BLANK   name." }, {}), "fixed", "case and spacing don't matter");
    assert.equal(run({}, { line: 11 }), "open", "another line");
    assert.equal(run({}, { lens: "Security" }), "open", "another lens");
    assert.equal(run({}, { path: "src/b.ts" }), "open", "another path");
    assert.equal(run({ severity: "warning", security: true }, { severity: "advisory", security: false, test: null, reason: "Reworded." }), "open", "a lower grade");
    assert.equal(run({ severity: "warning" }, { severity: "warning", test: null, reason: "Reworded." }), "open", "a Warning needs a test");
    assert.equal(run({ severity: "warning" }, { severity: "warning" }), "fixed", "a Warning behind a test");
    assert.equal(run({ security: true }, { security: true, test: null, reason: "Reworded." }), "open", "a security Critical needs a test");
    assert.equal(run({ security: true }, {}), "open", "only the security flag differs (earlier is security)");
    assert.equal(run({}, { security: true }), "open", "only the security flag differs (later is security)");
    assert.equal(run({ security: true }, { security: true }), "fixed", "a security Critical behind a test");
    assert.equal(run({}, { severity: "advisory" }), "open", "a Critical is not cleared by an Advisory");
    assert.equal(run({ severity: "advisory" }, { severity: "critical" }), "fixed", "a higher grade clears a lower one");
    const person = [open({})];
    resolveRepeats(person, [fixed({})], new Set(["R1"]));
    assert.equal(person[0]!.status, "open", "a finding for a person");
  });

  it("re-raises a Warning the backend claimed fixed after changing only an unrelated test: it stays open in round 1 and the next round's reviewer sees it as one to raise again", async () => {
    const run = fake({
      answers: (round, who) => (who.lens === "Security" && round <= 2 ? [raw({ lens: "Security", severity: "warning", summary: "Open redirect." })] : []),
      fixer: () => ({ outcomes: [{ id: "R1", status: "fixed", test: "tests/unrelated.test.ts::x", reason: null }], changed: ["tests/unrelated.test.ts"] }),
    });

    recorded(await runHostReview(run.host, input(run.startHead)));

    const findings = run.records[0]!.input.findings;
    assert.equal(findings.find((found) => found.id === "R1")?.status, "open", "round 1 doesn't take the Warning as fixed");
    assert.match(decisionsOf(run, 2), /R1 .*Raise again if still in the code/);
    assert.ok(findings.some((found) => found.id !== "R1" && found.severity === "warning" && found.status !== "fixed"), "round 2's re-raise is recorded");
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

// Criterion: no agent can read, write or run scripts/review.sh or .git/review; only the host records. (The sandbox-command half is checked
// against liveReviewHost in build.test.mts.)
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

// A real sandbox run showed reviewers started together race for the sandbox's git config lock (`git config --global` in each role's setup).
describe("runHostReview's reviewers", () => {
  it("fails the review, asking no reviewer, when a round has more reviewers than the time bounds allow", async () => {
    const rows = Array.from({ length: MAX_REVIEWERS_PER_ROUND }, (_, index) => `| Extra ${index} | Any code | Does it hold? |\n`).join("");
    const run = fake({ repoLenses: `| Lens | Applies to | Ask |\n| --- | --- | --- |\n${rows}` });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(run.reviewerRuns.length, 0);
  });

  it("runs the reviewers of a round one after another, never two in one sandbox at once", async () => {
    const run = fake({});

    await runHostReview(run.host, input(run.startHead));

    assert.ok(run.reviewerRuns.length > 1);
    assert.equal(run.maxInFlight(), 1);
  });
});

describe("runHostReview's time cap", () => {
  const minute = 60_000;
  // A clock that moves one minute every time the review looks at it.
  const ticking = () => {
    let calls = 0;
    return () => ++calls * minute;
  };

  it("starts no reviewer once the cap is spent, and ends as failed at the start commit, recording nothing", async () => {
    const run = fake({ clock: ticking(), wallClockMs: 3 * minute });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, run.startHead);
    assert.match(result.status === "failed" ? result.reason : "", /time cap/);
    assert.equal(run.reviewerRuns.length, 1, "the clock reads 2 and 3 minutes before the first two reviewers; the second is past the cap");
    assert.equal(run.records.length, 0);
    assert.ok(run.logs.some((line) => /time cap before the .* reviewer/.test(line)));
  });

  it("starts no fixer and no later round once the cap is spent, and ends at the last commit the gate passed on", async () => {
    let now = 0;
    let fixerRuns = 0;
    const run = fake({
      clock: () => now,
      wallClockMs: 10 * minute,
      answers: (round, who) => (who.lens === "Edge cases" && round === 1 ? [raw()] : []),
      fixer: () => {
        fixerRuns++;
        now = 11 * minute;
        return { outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] };
      },
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(fixerRuns, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, hex(2), "round 1's fixes passed the gate; round 2 never started");
    assert.equal(run.reviewerRuns.every((found) => found.round === 1), true);
    assert.equal(run.prepares.length, 1, "round 2 was not even prepared: the check at the start of the round fired");
    assert.ok(run.logs.some((line) => /time cap before round 2\b/.test(line)), run.logs.join("\n"));
  });

  it("starts a fixer only while it has time: the cap spent by the round's last reviewer stops the fixer, not a reviewer", async () => {
    let now = 0;
    const last = CODE_REVIEWERS.at(-1)!;
    const run = fake({
      clock: () => now,
      wallClockMs: 10 * minute,
      answers: (_round, who) => {
        if (who.lens === last) now = 11 * minute;
        return who.lens === "Edge cases" ? [raw()] : [];
      },
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(run.fixerPrompts.length, 0);
    assert.equal(run.reviewerRuns.length, CODE_REVIEWERS.length, "every reviewer of the round ran: only the fixer's own check is left");
    assert.ok(run.logs.some((line) => /time cap before round 1's fixer/.test(line)), run.logs.join("\n"));
  });

  it("lets a review that finishes inside the cap record as before", async () => {
    const run = fake({ clock: () => 0, wallClockMs: minute });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "recorded");
  });

  it("defaults to REVIEW_WALL_CLOCK_MINUTES", async () => {
    let now = 0;
    const run = fake({ clock: () => now });
    const first = run.host.prepare;
    run.host.prepare = (options) => {
      now += REVIEW_WALL_CLOCK_MINUTES * minute;
      return first(options);
    };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(run.reviewerRuns.length, 0);
  });
});

// A usage-limit stop (or a stalled sandbox) during the review leaves the branch for a later round; the run's time budget passing, or the
// review's own time cap, ends it as failed at the last commit the gate passed on, which is published with a note and no record. A
// reviewer that fails is reported, and the branch is not recorded as reviewed.
describe("runHostReview's stops and failures", () => {
  it("rejects with the UncountedStopError a reviewer hits at once, starting no later reviewer, and records nothing", async () => {
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

    const before = run.reviewerRuns.map((found) => found.lens);
    assert.equal(before.at(-1), "Security", "the stop ends the round: no reviewer runs after it");
    assert.equal(settled, CODE_REVIEWERS.indexOf("Security"));
    assert.equal(run.records.length, 0);
    assert.equal(run.fixerPrompts.length, 0);
  });

  it("ends as failed at the first reviewer that fails, starting no later reviewer of the round", async () => {
    let settled = 0;
    const run = fake({
      answers: (_round, who) => {
        if (who.lens === "Security") return new Error("the sandbox said no");
        settled++;
        return [];
      },
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.match(result.status === "failed" ? result.reason : "", /Security reviewer/);
    assert.equal(run.reviewerRuns.map((found) => found.lens).at(-1), "Security", "no reviewer runs after the one that failed");
    assert.equal(settled, CODE_REVIEWERS.indexOf("Security"));
    assert.equal(run.records.length, 0);
    assert.equal(run.fixerPrompts.length, 0);
  });

  it("rejects with the UncountedStopError the fixer hits, and records nothing", async () => {
    const stop = new UncountedStopError("Claude's usage limit was hit during the backend run");
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

  it("ends as failed at the last gated commit, publishing the work already gated, when the run's time budget passes in the fixer", async () => {
    const stop = new TimeBudgetStopError("the run's 240-minute time budget has passed");
    let fixerRuns = 0;
    const run = fake({
      answers: (round, who) => (who.lens === "Edge cases" && round <= 2 ? [raw()] : []),
      fixer: () => {
        if (++fixerRuns === 2) return { error: stop };
        return { outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] };
      },
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, hex(2), "the commit round 1's fixes passed the gate on");
    assert.equal(run.records.length, 0);
    assert.ok(run.logs.some((line) => /time budget/.test(line)));
  });

  it("ends as failed at the start commit when the time budget passes in a reviewer of round 1", async () => {
    const stop = new TimeBudgetStopError("the run's 240-minute time budget has passed");
    const run = fake({ answers: only("Security", [] as ReviewerFinding[]) });
    const answers = run.host.runReviewer;
    run.host.runReviewer = async (reviewer, prompt) => {
      if (reviewer.lens === "Security") throw stop;
      return answers(reviewer, prompt);
    };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(result, { status: "failed", head: run.startHead, reason: "the run's time budget passed during the review" });
  });

  it("still rethrows a usage-limit stop and a stalled sandbox, which a later round or a person must settle", async () => {
    for (const stop of [new UncountedStopError("Claude's usage limit was hit"), new StalledStepError("the step stalled")]) {
      const run = fake({ answers: only("Edge cases", [raw()]), fixer: () => ({ error: stop }) });

      await assert.rejects(() => runHostReview(run.host, input(run.startHead)), (error: unknown) => error === stop);
    }
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
    assert.equal((result as { reason: string }).reason, "the Security reviewer gave no valid answer after 2 attempts");
    assert.equal(run.reviewerRuns.filter((found) => found.lens === "Security").length, 2);
    assert.equal(run.records.length, 0);
    assert.equal(run.fixerPrompts.length, 0);
  });

  it("reports a reviewer that times out as a failed review that names its lens, and records nothing", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const run = fake({ answers: (_round, who) => (who.lens === "Error contract" ? timeout : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal((result as { reason: string }).reason, "the Error contract reviewer timed out");
    assert.equal(run.records.length, 0);
  });

  it("reports a reviewer that throws an ordinary error as a failed review too, not as a crash", async () => {
    const run = fake({ answers: (_round, who) => (who.lens === BAR_LENS ? new Error("sandbox went away") : []) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal((result as { reason: string }).reason, "the Bar reviewer failed", "the agent's own error text stays out of the reason");
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
    { name: "prepare", wrap: (host) => void (host.prepare = () => { throw new Error("prepare broke"); }) },
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
      name: "gate",
      options: { answers: only("Edge cases", [{ lens: "Edge cases", path: "src/app.ts", line: 1, severity: "critical", summary: "x", fix: "y", needsPerson: false, why: "" }]), fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }) },
      wrap: (host) => void (host.gate = async () => { throw new Error("gate exec failed"); }),
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

  it("fails the review at the start commit, with a host-written reason, when the lens table can't be parsed", async () => {
    const run = fake();
    run.host.readSkillFiles = () => ({ ...skillFiles(), lenses: "no table here" });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(result, { status: "failed", head: run.startHead, reason: "the review's lens table couldn't be read" });
    assert.equal(run.reviewerRuns.length, 0);
  });

  it("fails the review at the start commit with a host-written reason when a round can't be prepared", async () => {
    const run = fake();
    run.host.prepare = () => { throw new Error("prepare broke"); };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(result, { status: "failed", head: run.startHead, reason: "round 1 couldn't be prepared" });
  });

  it("fails the review at the last gated commit, not the fixer's, when the gate throws after the fixer's changes", async () => {
    const run = fake({
      answers: only("Edge cases", [{ lens: "Edge cases", path: "src/app.ts", line: 1, severity: "critical", summary: "x", fix: "y", needsPerson: false, why: "" }]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });
    run.host.gate = async () => { throw new Error("gate exec failed"); };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, run.startHead);
    assert.equal(run.records.length, 0);
  });

  it("fails the review at the round's commit, naming the backend role, when the fixer throws an ordinary error or times out", async () => {
    for (const [error, what] of [
      [new Error("sandbox went away"), "failed"],
      [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timed out"],
    ] as const) {
      const run = fake({ answers: only("Edge cases", [{ lens: "Edge cases", path: "src/app.ts", line: 1, severity: "critical", summary: "x", fix: "y", needsPerson: false, why: "" }]), fixer: () => ({ error }) });

      const result = await runHostReview(run.host, input(run.startHead));

      assert.equal(result.status, "failed");
      assert.equal(result.status === "failed" && result.reason, `the backend role's run fixing round 1's findings ${what}`);
      assert.equal(result.status === "failed" && result.head, run.startHead);
      assert.equal(run.records.length, 0);
    }
  });

  it("runs a round with exactly MAX_REVIEWERS_PER_ROUND reviewers", async () => {
    const rows = Array.from({ length: MAX_REVIEWERS_PER_ROUND - CODE_REVIEWERS.length }, (_, index) => `| Extra ${index} | Any code | Does it hold? |\n`).join("");
    const run = fake({ repoLenses: `| Lens | Applies to | Ask |\n| --- | --- | --- |\n${rows}` });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(run.reviewerRuns.length, MAX_REVIEWERS_PER_ROUND);
    assert.equal(result.status, "recorded", JSON.stringify(result));
  });

  it("keeps reviewing while the clock is one millisecond short of the cap", async () => {
    let time = 0;
    const run = fake();
    run.host.wallClockMs = 1000;
    run.host.now = () => time;
    const first = run.host.prepare;
    run.host.prepare = (opts) => {
      time = 999;
      return first(opts);
    };

    const short = await runHostReview(run.host, input(run.startHead));

    assert.equal(short.status, "recorded", JSON.stringify(short));
  });

  it("removes a stale fixes.patch before round 1 and writes the fixes of a later round", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
    });

    await runHostReview(run.host, input(run.startHead));

    assert.equal(run.removed.length, 1, "round 1 has no fixes: an earlier build's fixes.patch must not be left for the reviewers");
    assert.match(run.removed[0] ?? "", /review\/fixes\.patch$/);
    assert.equal(run.files.filter((file) => file.path.endsWith("fixes.patch")).length, 1, "round 2 writes its own");
  });

  it("starts round 2 from the commit the gate passed on, not the fixer's HEAD, and fails at it when a round 2 reviewer fails", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 ? (who.lens === "Edge cases" ? [raw()] : []) : who.lens === BAR_LENS ? new Error("sandbox went away") : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      gates: [hex(9)],
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(run.prepares[1]?.head, hex(9), "round 2 reads the gated commit");
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, hex(9));
    assert.equal(result.status === "failed" && result.reason, "the Bar reviewer failed");
    assert.equal(run.records.length, 0);
  });

  it("fails at the last gated commit when the fixer of round 2 throws", async () => {
    const run = fake({
      answers: (round, who) => (who.lens === "Edge cases" && round <= 2 ? [raw()] : []),
      fixer: (n) => (n === 1 ? { outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] } : { error: new Error("sandbox went away") }),
      gates: [hex(9)],
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.head, hex(9));
    assert.equal(result.status === "failed" && result.reason, "the backend role's run fixing round 2's findings failed");
  });

  it("returns the paths of every round's diff as the ones the review read, and no others", async () => {
    const run = fake({
      answers: (round, who) => (round === 1 && who.lens === "Edge cases" ? [raw()] : []),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      patches: (round) => (round === 1 ? { patch: diffFor("src/app.ts") } : { patch: diffFor("src/app.ts", "src/other.ts"), fixes: diffFor("src/other.ts") }),
    });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.deepEqual([...result.readPaths].sort(), ["src/app.ts", "src/other.ts"]);
  });

  it("keeps reviewing until the clock reaches REVIEW_WALL_CLOCK_MINUTES, whatever wallClockMs is left unset", async () => {
    let now = 0;
    const run = fake({ clock: () => now });
    const first = run.host.prepare;
    run.host.prepare = (options) => {
      now += REVIEW_WALL_CLOCK_MINUTES * 60_000 - 1;
      return first(options);
    };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "recorded", JSON.stringify(result));
  });

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

  it("still rethrows a usage-limit stop from a host call", async () => {
    const run = fake();
    const stop = new UncountedStopError("usage limit");
    run.host.worktree = async () => { throw stop; };

    await assert.rejects(() => runHostReview(run.host, input(run.startHead)), (error: unknown) => error === stop);
  });

  it("ends as failed at the start commit when the time budget passes in a host call", async () => {
    const run = fake();
    run.host.worktree = async () => { throw new TimeBudgetStopError("the run's 240-minute time budget has passed"); };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(result, { status: "failed", head: run.startHead, reason: "the run's time budget passed during the review" });
  });

  it("ends as failed, not as refused by the ledger, when the record throws for any reason", async () => {
    const run = fake();
    run.host.record = () => { throw Object.assign(new Error("git was killed"), { signal: "SIGKILL" }); };

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.reason, "the review couldn't be recorded");
  });

  it("records the round as read, and starts no second round, when the fixer moves HEAD without changing a file", async () => {
    const run = fake({ answers: only("Edge cases", [raw()]), fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: [] }) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "recorded", JSON.stringify(result));
    assert.equal(run.prepares.length, 1, "a second round would have nothing to read and fail to prepare");
    assert.equal(run.gateRuns(), 0, "no new code, so no gate");
    assert.equal(run.records[0]!.input.findings.find((found) => found.id === "R1")?.status, "open", "a fixed claim with no file changed isn't believed");
  });

  it("writes the reviewers' patch files from the read patches, with the key still that of the whole diff", async () => {
    const whole = diffFor("src/app.ts");
    const run = fake({
      answers: only("Edge cases", [raw()]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      patches: (n) => ({ patch: whole, readPatch: `${whole}# read\n`, ...(n > 1 ? { fixes: whole, readFixes: `${whole}# read fixes\n` } : {}) }),
    });

    await runHostReview(run.host, input(run.startHead));

    const written = (name: string) => run.files.filter((file) => file.path.endsWith(`/${name}`)).map((file) => file.content);
    assert.ok(written("diff.patch").length >= 2, "two rounds ran");
    assert.ok(written("diff.patch").every((text) => text === `${whole}# read\n`), written("diff.patch").join("|"));
    assert.ok(written("fixes.patch").length >= 1 && written("fixes.patch").every((text) => text === `${whole}# read fixes\n`), written("fixes.patch").join("|"));
    assert.equal(run.records[0]!.input.reviewedKey, run.prepared.at(-1)!.key, "the key recorded is the prepared round's, which covers the whole diff");
    assert.equal(run.records.length, 1, "the review was recorded");
  });

  it("applies the size limit to the read patches: a whole diff over it is reviewed when the read patch is under it, and the reverse fails", async () => {
    const big = "x".repeat(MAX_REVIEW_PATCH_BYTES + 1);
    const reviewed = fake({ patches: () => ({ patch: big, readPatch: diffFor("src/app.ts") }) });
    const refused = fake({ patches: () => ({ patch: diffFor("src/app.ts"), readPatch: big }) });

    await runHostReview(reviewed.host, input(reviewed.startHead));
    const result = await runHostReview(refused.host, input(refused.startHead));

    assert.ok(reviewed.reviewerRuns.length > 0);
    assert.equal(result.status === "failed" && result.reason, "the diff is too large to review");
    assert.equal(refused.reviewerRuns.length, 0);
  });

  it("chooses the lenses from the paths the reviewers read: a path left out as a verbatim mirror adds none", async () => {
    const run = fake({ patches: () => ({ patch: diffFor("src/app.ts", "README.md"), readPatch: diffFor("README.md") }) });

    await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(run.lensesIn(1), [BAR_LENS, "Docs match the code", "Repo conventions"].sort());
  });

  it("returns the paths of the read patches, not of a mirror left out", async () => {
    const run = fake({ patches: () => ({ patch: diffFor("src/app.ts", "mirror/app.ts"), readPatch: diffFor("src/app.ts") }) });

    const result = recorded(await runHostReview(run.host, input(run.startHead)));

    assert.deepEqual([...result.readPaths], ["src/app.ts"]);
  });

  it("applies the size limit to the read fixes of a later round, both ways", async () => {
    const big = "x".repeat(MAX_REVIEW_PATCH_BYTES + 1);
    const round2 = (fixes: string, readFixes: string) => (n: number) => ({ patch: diffFor("src/app.ts"), ...(n > 1 ? { fixes, readFixes } : {}) });
    const fixer = () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] });
    const reviewed = fake({ answers: only("Edge cases", [raw()]), fixer, patches: round2(big, diffFor("src/app.ts")) });
    const refused = fake({ answers: only("Edge cases", [raw()]), fixer, patches: round2(diffFor("src/app.ts"), big) });

    const ok = await runHostReview(reviewed.host, input(reviewed.startHead));
    const result = await runHostReview(refused.host, input(refused.startHead));

    assert.equal(ok.status, "recorded", JSON.stringify(ok));
    assert.equal(result.status === "failed" && result.reason, "the diff is too large to review");
  });

  it("chooses a later round's lenses from the paths of its read fixes", async () => {
    const run = fake({
      answers: only("Edge cases", [raw()]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      patches: (n) => ({ patch: diffFor("src/app.ts", "README.md"), ...(n > 1 ? { fixes: diffFor("src/app.ts"), readFixes: diffFor("README.md") } : {}) }),
    });

    await runHostReview(run.host, input(run.startHead));

    assert.deepEqual(run.lensesIn(2), [BAR_LENS, "Docs match the code", "Repo conventions"].sort());
  });

  it("tells the reviewers that mirrors were left out only when a read patch is shorter than its patch", async () => {
    const same = fake({ patches: () => ({ patch: diffFor("src/app.ts") }) });
    const shorter = fake({ patches: () => ({ patch: diffFor("src/app.ts", "mirror/app.ts"), readPatch: diffFor("src/app.ts") }) });

    await runHostReview(same.host, input(same.startHead));
    await runHostReview(shorter.host, input(shorter.startHead));

    for (const found of same.reviewerRuns) assert.doesNotMatch(found.prompt, /left out of the patch/, found.lens);
    assert.ok(shorter.reviewerRuns.length > 0);
    for (const found of shorter.reviewerRuns) assert.match(found.prompt, /left out of the patch/, found.lens);
  });

  it("says so in a later round when only its fixes had a mirror left out", async () => {
    const run = fake({
      answers: only("Edge cases", [raw()]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      patches: (n) => ({ patch: diffFor("src/app.ts"), ...(n > 1 ? { fixes: diffFor("src/app.ts", "mirror/app.ts"), readFixes: diffFor("src/app.ts") } : {}) }),
    });

    await runHostReview(run.host, input(run.startHead));

    for (const found of run.reviewerRuns.filter((entry) => entry.round === 1)) assert.doesNotMatch(found.prompt, /left out of the patch/, found.lens);
    const later = run.reviewerRuns.filter((entry) => entry.round === 2);
    assert.ok(later.length > 0);
    for (const found of later) assert.match(found.prompt, /left out of the patch/, found.lens);
  });

  it("fails the review, asking no reviewer, when a round's diff is past the size the sandbox command can carry", async () => {
    const run = fake({ patches: () => ({ patch: "x".repeat(MAX_REVIEW_PATCH_BYTES + 1) }) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.reason, "the diff is too large to review");
    assert.equal(run.reviewerRuns.length, 0);
    assert.equal(run.files.length, 0);
  });

  it("fails the review, asking no later reviewer, when a later round's fixes are past the size limit while its diff is not", async () => {
    const run = fake({
      answers: only("Edge cases", [raw()]),
      fixer: () => ({ outcomes: [fixedWithTest("R1")], changed: ["src/app.ts", "tests/app.test.ts"] }),
      patches: (round) => (round === 1 ? { patch: diffFor("src/app.ts") } : { patch: diffFor("src/app.ts"), fixes: "x".repeat(MAX_REVIEW_PATCH_BYTES + 1) }),
    });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.reason, "the diff is too large to review");
    assert.equal(result.status === "failed" && result.head, hex(2), "the commit round 1's fixes passed the gate on");
    assert.equal(run.reviewerRuns.every((found) => found.round === 1), true);
    assert.equal(run.files.some((file) => file.path.endsWith("fixes.patch")), false);
  });

  it("reviews a diff of exactly the largest size", async () => {
    const run = fake({ patches: () => ({ patch: "x".repeat(MAX_REVIEW_PATCH_BYTES) }) });

    const result = await runHostReview(run.host, input(run.startHead));

    assert.equal(result.status, "recorded");
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
    const note = openFindingsNote(manyOpen(150, "Short."), new Set(["src/app.ts"]));

    assert.equal(note.split("\n").filter((line) => line.startsWith("- R")).length, 20);
    assert.match(note, /130 more open findings are in the local review record/);
    assert.match(note, /\n\n130 more open findings/, "a blank line keeps the count out of the last bullet");
  });

  it("publishes none of a long summary or fix, so the note stays small", () => {
    const note = openFindingsNote(manyOpen(150, "x".repeat(5000)), new Set(["src/app.ts"]));

    assert.ok(note.length < 2_000, `the note is ${note.length} characters`);
    assert.doesNotMatch(note, /xxxx/);
  });
});

describe("openFindingsNote", () => {
  const APP = new Set(["src/app.ts"]);
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
    assert.equal(openFindingsNote(ledgerOf([]), new Set()), "");
    assert.equal(openFindingsNote(ledgerOf([found({ status: "fixed", test: "t::x" }), found({ id: "R2", status: "dismissed", reason: "a.ts:1 shows it." })]), new Set()), "");
  });

  it("lists an open finding by its id, severity and place only, without the reviewer's summary or fix", () => {
    const note = openFindingsNote(ledgerOf([found()]), APP);

    assert.match(note, /- R1 critical src\/app\.ts:12/);
    assert.doesNotMatch(note, /A blank name passes the guard/);
    assert.doesNotMatch(note, /Trim the name first/);
  });

  it("cuts a long path, and names the severity of a finding that has none", () => {
    const note = openFindingsNote(ledgerOf([found({ path: "a/" + "x".repeat(5000) }), found({ id: "R2", severity: undefined })]), new Set(["a/" + "x".repeat(5000), "src/app.ts"]));

    assert.ok(note.length < 1_500, `the note is ${note.length} characters`);
    assert.match(note, /- R2 warning /);
    assert.doesNotMatch(note, /undefined/);
  });

  it("lists an open Advisory finding that isn't a security one", () => {
    assert.match(openFindingsNote(ledgerOf([found({ severity: "advisory" })]), APP), /- R1 advisory src\/app\.ts:12/);
  });

  it("only counts security findings, whatever their grade, and never lists their summary, path or fix", () => {
    const note = openFindingsNote(
      ledgerOf([
        found({ id: "R1", severity: "warning", security: true, summary: "The token reaches a log line.", path: "src/log.ts", fix: "Redact it." }),
        found({ id: "R2", lens: "Security", severity: "critical", security: false, summary: "Open redirect.", path: "src/redirect.ts" }),
      ]),
      new Set(["src/log.ts", "src/redirect.ts"]),
    );

    assert.match(note, /2 security findings?/);
    assert.doesNotMatch(note, /token reaches/);
    assert.doesNotMatch(note, /Open redirect/);
    assert.doesNotMatch(note, /src\/(?:log|redirect)\.ts/);
    assert.doesNotMatch(note, /Redact it/);
  });

  it("lists a finding only when its path is a file the review read, and counts the rest", () => {
    const note = openFindingsNote(
      ledgerOf([
        found({ id: "R1" }),
        found({ id: "R2", path: "Closes #12" }),
        found({ id: "R3", path: "@octocat/x" }),
        found({ id: "R4", path: "[click](https://example.com/x)" }),
      ]),
      new Set(["src/app.ts"]),
    );

    assert.match(note, /- R1 critical src\/app\.ts:12/);
    assert.doesNotMatch(note, /Closes|octocat|click|example\.com|R2|R3|R4/);
    assert.match(note, /3 more open findings are in the local review record/);
  });

  it("doesn't list a path that GitHub would render as a link, even one the review read", () => {
    const paths = ["[docs](https:/evil.example)", "www.evil.example/x", "a/![img](b)", "x<y>.md", "x www.evil.example/a", "a_www.evil.example", "docs/WWW.evil.example"];
    const note = openFindingsNote(ledgerOf(paths.map((path, index) => found({ id: `R${index + 1}`, path }))), new Set(paths));

    assert.doesNotMatch(note, /- R\d/);
    assert.doesNotMatch(note, /evil|docs|img/);
    assert.match(note, /7 more open findings are in the local review record/);
  });

  it("lists a finding whose path starts with ./ when the review read the file without it", () => {
    assert.match(openFindingsNote(ledgerOf([found({ path: "./src/app.ts" })]), new Set(["src/app.ts"])), /- R1 critical src\/app\.ts:12/);
  });

  it("keeps listing the other findings when the host's check refuses one line", () => {
    const note = openFindingsNote(
      ledgerOf([found({ id: "R1", path: "docs/Review notes.md" }), found({ id: "R2" })]),
      new Set(["docs/Review notes.md", "src/app.ts"]),
      (line) => !/Review notes/.test(line),
    );

    assert.match(note, /- R2 critical src\/app\.ts:12/);
    assert.doesNotMatch(note, /R1|Review notes/);
    assert.match(note, /1 more open finding is in the local review record/);
  });

  it("lists nothing when the review read no file", () => {
    assert.doesNotMatch(openFindingsNote(ledgerOf([found()]), new Set()), /- R1/);
  });

  it("never publishes what the reviewers wrote, so a mention, an issue reference or encoded text in it cannot reach the PR", () => {
    const summary = "Calls @octocat, closes #12 and carries aGVsbG8gd29ybGQ=.";
    const note = openFindingsNote(ledgerOf([found({ summary, fix: summary })]), APP);

    assert.doesNotMatch(note, /octocat|#12|aGVsbG8/);
  });
});

// The follow-up issue for the open Advisory findings is public, and its text is a reviewer's, so it is held to the PR note's rules.
describe("advisoryIssueBody", () => {
  const DOCS = new Set(["docs/a.md"]);
  const ledgerOf = (findings: Ledger["findings"]): Ledger => ({
    version: 1,
    key: "k",
    branch: "feature/388-x",
    base: BASE,
    head: hex(2),
    recordedAt: "2026-01-01T00:00:00.000Z",
    rounds: 1,
    findings,
  });
  const advisory = (overrides: Partial<Ledger["findings"][number]> = {}): Ledger["findings"][number] => ({
    id: "R5",
    lens: "Docs match the code",
    path: "docs/a.md",
    line: 4,
    summary: "A stale sentence.",
    severity: "advisory",
    security: false,
    status: "open",
    test: null,
    reason: null,
    fix: "Reword it.",
    ...overrides,
  });
  const token = `${"gh"}p_${"A".repeat(36)}`;
  const clean = (line: string) => !line.includes("ghp_");

  it("is empty when no Advisory finding is open", () => {
    assert.equal(advisoryIssueBody(ledgerOf([advisory({ status: "fixed", reason: "Reworded." })]), DOCS), "");
  });

  it("lists an open Advisory finding with its summary and fix", () => {
    const body = advisoryIssueBody(ledgerOf([advisory()]), DOCS);
    assert.match(body, /R5 docs\/a\.md:4: A stale sentence\. Suggested fix: Reword it\./);
  });

  it("leaves out a finding whose path the review didn't read", () => {
    const body = advisoryIssueBody(ledgerOf([advisory(), advisory({ id: "R6", path: "docs/other.md" })]), DOCS);
    assert.match(body, /R5/);
    assert.doesNotMatch(body, /R6 docs/);
    assert.match(body, /1 more open Advisory finding is in the local review record/);
  });

  it("leaves out a finding whose path is not made of plain file-name characters", () => {
    const odd = "docs/[x](http://e.example).md";
    const body = advisoryIssueBody(ledgerOf([advisory(), advisory({ id: "R6", path: odd })]), new Set(["docs/a.md", odd]));
    assert.doesNotMatch(body, /R6 /);
    assert.match(body, /1 more open Advisory finding is in/);
  });

  it("leaves out a finding whose text the caller's public-text check refuses, and only that one", () => {
    const body = advisoryIssueBody(ledgerOf([advisory(), advisory({ id: "R6", summary: `The token ${token} is hard-coded.` })]), DOCS, clean);
    assert.match(body, /R5/);
    assert.doesNotMatch(body, /R6|ghp_/);
    assert.match(body, /1 more open Advisory finding is in/);
  });

  it("leaves out a suggested fix that holds a secret, not only a summary", () => {
    const body = advisoryIssueBody(ledgerOf([advisory({ fix: `Use ${token}.` })]), DOCS, clean);
    assert.equal(body, "");
  });

  it("is empty when every finding is left out", () => {
    assert.equal(advisoryIssueBody(ledgerOf([advisory({ path: "docs/other.md" })]), DOCS), "");
  });

  it("lists at most 20 findings and counts the rest", () => {
    const many = Array.from({ length: 21 }, (_, i) => advisory({ id: `R${i + 1}`, line: i + 1 }));
    const body = advisoryIssueBody(ledgerOf(many), DOCS);
    assert.equal(body.split("\n").filter((line) => line.startsWith("- R")).length, 20);
    assert.match(body, /1 more open Advisory finding is in/);
    assert.equal(advisoryIssueBody(ledgerOf(many.slice(0, 20)), DOCS).includes("more open"), false);
  });

  it("leaves out a finding whose line is over the length bound, and keeps one at the bound", () => {
    const at = (summary: string) => advisoryIssueBody(ledgerOf([advisory({ fix: null, summary })]), DOCS);
    const fits = at("x".repeat(1900));
    assert.match(fits, /R5/);
    const lineLength = fits.split("\n").find((line) => line.startsWith("- R5"))!.length;
    const room = 2000 - (lineLength - 1900);
    assert.match(at("x".repeat(room)), /R5/, "a line of exactly the bound stays");
    assert.equal(at("x".repeat(room + 1)), "", "a line one over is left out");
  });

  it("ends with the session marker and keeps the 'more' note above it", () => {
    const body = advisoryIssueBody(ledgerOf([advisory(), advisory({ id: "R6", path: "docs/other.md" })]), DOCS);
    assert.match(body, /isn't listed here\.\n\n<!-- claude-session -->\n$/);
  });
});
