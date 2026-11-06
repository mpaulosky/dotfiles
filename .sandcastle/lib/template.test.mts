import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { TEMPLATE_OWNED_DIR } from "./repo-config.mts";
import { copyReviewerLogs, liveRoleLogFs } from "./role-logs.mts";

// The Template's .sandcastle/ as Apply writes it into a repo that isn't dotfiles: the Owned files, plus each Seed file Owned lacks.
// The Owned modules must type-check and pass their own tests there, with the Seed's lib/repo-config.mts, so an Owned module that reads a
// dotfiles-only value fails here and not in an older repo's migration. This file is dotfiles', not the Template's.

const root = fileURLToPath(new URL("../../", import.meta.url));
const skill = join(root, TEMPLATE_OWNED_DIR.replace("/template/owned", ""));
const owned = join(skill, "template/owned");
const seed = join(skill, "template/seed");

const filesUnder = (folder: string): string[] =>
  (readdirSync(folder, { recursive: true }) as string[]).filter((entry) => statSync(join(folder, entry)).isFile()).map((entry) => entry.split("\\").join("/"));

describe("the Template's .sandcastle/ in a repo that isn't dotfiles", () => {
  let scratch = "";
  let sandcastle = "";

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "template-sandcastle-"));
    sandcastle = join(scratch, ".sandcastle");
    cpSync(join(owned, ".sandcastle"), sandcastle, { recursive: true, preserveTimestamps: true });
    for (const file of filesUnder(join(seed, ".sandcastle"))) {
      if (existsSync(join(sandcastle, file))) continue;
      mkdirSync(join(sandcastle, file, ".."), { recursive: true });
      cpSync(join(seed, ".sandcastle", file), join(sandcastle, file));
    }
    // lib/branches.test.mts runs scripts/check-branch-name.sh, an Owned file outside .sandcastle/.
    mkdirSync(join(scratch, "scripts"));
    const script = join(scratch, "scripts/check-branch-name.sh");
    cpSync(join(owned, "scripts/check-branch-name.sh"), script);
    chmodSync(script, statSync(join(owned, "scripts/check-branch-name.sh")).mode);
    // lib/pre-push-review-skill.test.mts reads the skill and its agent from .claude/.
    cpSync(join(owned, ".claude"), join(scratch, ".claude"), { recursive: true });
    // lib/pre-push-review-skill.test.mts checks the workflow's accepted-findings step against the ledger's markers.
    mkdirSync(join(scratch, ".github/workflows"), { recursive: true });
    cpSync(join(owned, ".github/workflows/claude-review.yml"), join(scratch, ".github/workflows/claude-review.yml"));
    // lib/review-ledger.test.mts reads the Template's .gitignore for the security record's two lines.
    cpSync(join(owned, ".gitignore"), join(scratch, ".gitignore"));
    // lib/review-ledger.test.mts runs scripts/review.sh the same way.
    const review = join(scratch, "scripts/review.sh");
    cpSync(join(owned, "scripts/review.sh"), review);
    chmodSync(review, statSync(join(owned, "scripts/review.sh")).mode);
    // lib/config.test.mts runs scripts/watch-pr.sh --would-skip on every Sandcastle marker.
    const watcher = join(scratch, "scripts/watch-pr.sh");
    cpSync(join(owned, "scripts/watch-pr.sh"), watcher);
    chmodSync(watcher, statSync(join(owned, "scripts/watch-pr.sh")).mode);
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  // A nested test runner reports into the parent's when it finds this variable.
  const childEnv = () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return env;
  };

  it("type-checks with the Seed's repo-config.mts", { timeout: 120_000 }, () => {
    const result = spawnSync(join(root, "node_modules/.bin/tsc"), ["--noEmit", "-p", sandcastle], { cwd: scratch, encoding: "utf8", env: childEnv() });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  // The Seed's commented `ui` line is what a repo opting into the UI developer uncomments, so it must be a valid entry
  // under the Seed's own `satisfies` clause, next to the Owned modules that read it.
  it("type-checks with the Seed's ui entry uncommented", { timeout: 120_000 }, () => {
    const config = join(sandcastle, "lib/repo-config.mts");
    const original = readFileSync(config, "utf8");
    const optedIn = original.replace(/^\/\/ {3}(ui: .*)$/m, "  $1");
    assert.notEqual(optedIn, original, "the Seed's repo-config.mts has no commented ui entry");

    writeFileSync(config, optedIn);
    try {
      const result = spawnSync(join(root, "node_modules/.bin/tsc"), ["--noEmit", "-p", sandcastle], { cwd: scratch, encoding: "utf8", env: childEnv() });

      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      writeFileSync(config, original);
    }
  });

  // config.test.mts skips its check of the ui prompts in a repo that hasn't opted in, which is every config this repo runs it under, so
  // here it runs where it can fail: a scratch repo with the Seed's ui entry uncommented. The role is Owned and opt-in
  // (mpaulosky/dotfiles#392), so the Template's own prompts pass it as shipped, and it fails when roles/ui.md, the planner's {{UI_ROLE}} or
  // backend.md's {{UI_DEVELOPER}} is missing, or the repo's roles/shared-rules.md has no UI developer section for them to point at.
  it("passes config.test.mts's ui prompt check for an opted-in repo as the Template ships, and fails it without roles/ui.md, plan-prompt.md's {{UI_ROLE}}, backend.md's {{UI_DEVELOPER}} or a UI developer section in roles/shared-rules.md", { timeout: 120_000 }, () => {
    const config = join(sandcastle, "lib/repo-config.mts");
    const plan = join(sandcastle, "plan-prompt.md");
    const uiPrompt = join(sandcastle, "roles/ui.md");
    const backend = join(sandcastle, "roles/backend.md");
    const rules = join(sandcastle, "roles/shared-rules.md");
    const originals = new Map([config, plan, uiPrompt, backend, rules].map((file) => [file, readFileSync(file, "utf8")]));
    const optedIn = originals.get(config)!.replace(/^\/\/ {3}(ui: .*)$/m, "  $1");
    assert.notEqual(optedIn, originals.get(config), "the Seed's repo-config.mts has no commented ui entry");
    const run = () =>
      spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", "--test-reporter=spec", ".sandcastle/lib/config.test.mts"], { cwd: scratch, encoding: "utf8", env: childEnv() });
    // The check's own failure line, not just its name, which the reporter prints whether the test passed or not. The spec reporter is
    // pinned: Node 22 prints TAP instead when stdout is a pipe.
    const failedCheck = /✖[^\n]*has the prompts the ui role needs/;

    try {
      writeFileSync(config, optedIn);

      const complete = run();
      assert.equal(complete.status, 0, `${complete.stdout}${complete.stderr}`);
      assert.match(complete.stdout, /✔[^\n]*has the prompts the ui role needs/, "the check should run and pass, not be skipped");

      assert.ok(originals.get(plan)!.includes("{{UI_ROLE}}"), "the Template's plan-prompt.md has no {{UI_ROLE}}");
      writeFileSync(plan, originals.get(plan)!.replace("{{UI_ROLE}}", ""));
      const withoutSlot = run();
      assert.notEqual(withoutSlot.status, 0, "the check should fail without the planner's {{UI_ROLE}}");
      assert.match(withoutSlot.stdout, failedCheck);
      assert.match(withoutSlot.stdout, /UI_ROLE/);

      writeFileSync(plan, originals.get(plan)!);
      rmSync(uiPrompt);
      const withoutPrompt = run();
      assert.notEqual(withoutPrompt.status, 0, "the check should fail without roles/ui.md");
      assert.match(withoutPrompt.stdout, failedCheck);
      assert.match(withoutPrompt.stdout, /roles\/ui\.md is missing/);

      writeFileSync(uiPrompt, originals.get(uiPrompt)!);
      writeFileSync(backend, originals.get(backend)!.replace("{{UI_DEVELOPER}}", ""));
      const withoutPlaceholder = run();
      assert.notEqual(withoutPlaceholder.status, 0, "the check should fail when backend.md drops {{UI_DEVELOPER}}");
      assert.match(withoutPlaceholder.stdout, failedCheck);
      assert.match(withoutPlaceholder.stdout, /UI_DEVELOPER/);

      // The section is a heading: a line that only mentions the UI developer (as dotfiles' own rules do, to say there is none) is not one.
      writeFileSync(backend, originals.get(backend)!);
      assert.match(originals.get(rules)!, /^## UI developer$/m, "the Template's shared-rules.md has no UI developer section");
      writeFileSync(rules, originals.get(rules)!.replace(/^## UI developer$/m, "There is no UI developer here."));
      const withoutSection = run();
      assert.notEqual(withoutSection.status, 0, "the check should fail when roles/shared-rules.md has no UI developer section");
      assert.match(withoutSection.stdout, failedCheck);
      assert.match(withoutSection.stdout, /roles\/shared-rules\.md has no "## UI developer" section/);
    } finally {
      for (const [file, text] of originals) writeFileSync(file, text);
    }
  });

  // skills.test.mts checks roles/skills.md against SANDBOX_SKILLS, which is empty under the Seed's values and so passes without
  // checking anything. Here a skill is mounted, to show it fails when the file lacks it or lists one that isn't mounted, and when a
  // prompt that should receive the file as {{REPO_SKILLS}} lacks the placeholder.
  it("fails skills.test.mts when roles/skills.md and SANDBOX_SKILLS disagree or a prompt lacks {{REPO_SKILLS}}, and passes when they agree", { timeout: 120_000 }, () => {
    const config = join(sandcastle, "lib/repo-config.mts");
    const skillsFile = join(sandcastle, "roles/skills.md");
    const tester = join(sandcastle, "roles/tester.md");
    const uiPrompt = join(sandcastle, "roles/ui.md");
    const originals = new Map([config, skillsFile, tester, uiPrompt].map((file) => [file, readFileSync(file, "utf8")]));
    const mounted = originals.get(config)!.replace(/^(export const SANDBOX_SKILLS: readonly string\[\] = )\[\];$/m, '$1["dotnet-tdd"];');
    assert.notEqual(mounted, originals.get(config), "the Seed's repo-config.mts has no empty SANDBOX_SKILLS");
    // The ui prompt is checked only in a repo that opted into the role.
    const optedIn = mounted.replace(/^\/\/ {3}(ui: .*)$/m, "  $1");
    assert.notEqual(optedIn, mounted, "the Seed's repo-config.mts has no commented ui entry");
    const section = (...names: string[]) => `\n# SKILLS\n\n${names.map((name) => `- \`${name}\`: x\n`).join("")}`;
    const run = () =>
      spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", "--test-reporter=spec", ".sandcastle/lib/skills.test.mts"], {
        cwd: scratch,
        encoding: "utf8",
        env: childEnv(),
      });

    try {
      writeFileSync(config, optedIn);
      assert.equal(originals.get(skillsFile), "", "the Seed's roles/skills.md should be empty");

      const unlisted = run();
      assert.notEqual(unlisted.status, 0, "the check should fail when roles/skills.md omits a mounted skill");
      assert.match(unlisted.stdout, /✖[^\n]*lists every mounted skill in roles\/skills\.md/);

      writeFileSync(skillsFile, section("dotnet-tdd"));
      const agreeing = run();
      assert.equal(agreeing.status, 0, `${agreeing.stdout}${agreeing.stderr}`);
      assert.match(agreeing.stdout, /skipped 0/, "the ui prompt's check should run, not be skipped");

      writeFileSync(skillsFile, section("dotnet-tdd", "dotnet-nope"));
      const unmounted = run();
      assert.notEqual(unmounted.status, 0, "the check should fail when roles/skills.md lists a skill that isn't mounted");
      assert.match(unmounted.stdout, /✖[^\n]*lists no skill that SANDBOX_SKILLS doesn't mount, in roles\/skills\.md/);

      writeFileSync(skillsFile, section("dotnet-tdd"));
      writeFileSync(tester, originals.get(tester)!.replace("{{REPO_SKILLS}}", ""));
      const testerWithout = run();
      assert.notEqual(testerWithout.status, 0, "the check should fail when the tester prompt lacks {{REPO_SKILLS}}");
      assert.match(testerWithout.stdout, /✖[^\n]*puts \{\{REPO_SKILLS\}\} in the tester prompt/);

      writeFileSync(tester, originals.get(tester)!);
      writeFileSync(uiPrompt, originals.get(uiPrompt)!.replace("{{REPO_SKILLS}}", ""));
      const uiWithout = run();
      assert.notEqual(uiWithout.status, 0, "the check should fail when the ui prompt lacks {{REPO_SKILLS}}");
      assert.match(uiWithout.stdout, /✖[^\n]*puts \{\{REPO_SKILLS\}\} in the ui prompt/);

      writeFileSync(uiPrompt, originals.get(uiPrompt)!);
      writeFileSync(tester, `${originals.get(tester)}${section("dotnet-tdd")}`);
      const inline = run();
      assert.notEqual(inline.status, 0, "the check should fail when a role prompt keeps its own # SKILLS section");
      assert.match(inline.stdout, /✖[^\n]*leaves no # SKILLS section inline/);
    } finally {
      for (const [file, text] of originals) writeFileSync(file, text);
    }
  });

  // agents.test.mts compares REPO_SKILLS with the file under the Seed's empty roles/skills.md, which can't show the text is passed whole and
  // trimmed. Here the file has text with blank lines around it.
  it("passes agents.test.mts with a roles/skills.md that has text and blank lines around it", { timeout: 120_000 }, () => {
    const skillsFile = join(sandcastle, "roles/skills.md");
    const original = readFileSync(skillsFile, "utf8");
    const run = () =>
      spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", "--test-reporter=spec", ".sandcastle/lib/agents.test.mts"], { cwd: scratch, encoding: "utf8", env: childEnv() });

    try {
      writeFileSync(skillsFile, "\n\n# SKILLS\n\n- `dotnet-tdd`: when to use it\n\n\n");
      const withText = run();
      assert.equal(withText.status, 0, `${withText.stdout}${withText.stderr}`);
      assert.match(withText.stdout, /✔[^\n]*adds roles\/skills\.md's text as REPO_SKILLS, trimmed/);
    } finally {
      writeFileSync(skillsFile, original);
    }
  });

  it("passes its Owned tests with the Seed's values", { timeout: 120_000 }, () => {
    const tests = filesUnder(sandcastle)
      .filter((file) => file.endsWith(".test.mts"))
      .map((file) => relative(scratch, join(sandcastle, file)));

    assert.ok(tests.length > 0, "the Template's .sandcastle/ holds no tests");
    const result = spawnSync(join(root, "node_modules/.bin/tsx"), ["--test", ...tests], { cwd: scratch, encoding: "utf8", env: childEnv() });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  it("has no file that is both Owned and Seed", () => {
    const seeded = new Set(filesUnder(join(seed, ".sandcastle")));
    const both = filesUnder(join(owned, ".sandcastle")).filter((file) => seeded.has(file));

    assert.deepEqual(both, []);
  });
});

// A test removes its scratch git repository while git may still be writing into it (background maintenance after a commit), which fails a
// bare recursive rmSync with ENOTEMPTY and turned a green run red. rmSync retries that error when it is given maxRetries.
describe("the Template's tests remove scratch directories with retries", () => {
  it("passes maxRetries to every recursive rmSync in the Owned lib/ modules", () => {
    const lib = join(owned, ".sandcastle/lib");
    const bare: string[] = [];
    let found = 0;
    for (const file of filesUnder(lib).filter((entry) => entry.endsWith(".mts"))) {
      for (const call of readFileSync(join(lib, file), "utf8").matchAll(/rmSync\([^;]*?recursive: true[^;]*?\)/g)) {
        found += 1;
        if (!call[0].includes("maxRetries")) bare.push(`${file}: ${call[0].replace(/\s+/g, " ")}`);
      }
    }

    assert.ok(found > 0, "no recursive rmSync found in the Owned lib/ modules: the scan checks nothing");
    assert.deepEqual(bare, []);
  });
});

// `pnpm run sandcastle:status` (lib/status.mts, status.mts): the script is in the Seed package.json, which Apply writes only once, so
// a repo that already has one adds it by hand, and the reference says so.
describe("pnpm run sandcastle:status in the Template", () => {
  const packageScripts = (file: string): Record<string, string> => JSON.parse(readFileSync(file, "utf8")).scripts;

  it("is a script of the Seed package.json, right after sandcastle", () => {
    const scripts = packageScripts(join(seed, "package.json"));
    const names = Object.keys(scripts);

    assert.equal(scripts["sandcastle:status"], "tsx .sandcastle/status.mts");
    assert.equal(names.indexOf("sandcastle:status"), names.indexOf("sandcastle") + 1);
  });

  it("leaves dotfiles' package.json scripts the Seed's", () => {
    assert.deepEqual(packageScripts(join(root, "package.json")), packageScripts(join(seed, "package.json")));
  });

  describe("in references/sandcastle.md", () => {
    const reference = readFileSync(join(skill, "references/sandcastle.md"), "utf8");

    it("is described: what it shows and that it is read-only", () => {
      assert.match(reference, /pnpm run sandcastle:status/);
      assert.match(reference, /read-only/i);
      for (const part of [/passes/i, /bot/, /owner/]) assert.match(reference, part);
    });

    it("is in the migration notes, since a Seed package.json already written isn't changed", () => {
      const migrating = reference.slice(reference.indexOf("## Migrating a repo"));

      assert.notEqual(migrating, reference, "the reference has no migration section");
      assert.match(migrating, /sandcastle:status/);
    });
  });
});

// The cap on combining marks in a row (MAX_MARKS in lib/status.mts, 8 by the owner's decision on mpaulosky/dotfiles#348) is stated in the
// code's comment, ADR 0010 and the reference, which must agree with it. ADR 0010 also says "assigned" pictographs, as the code does.
describe("the combining-mark cap and ADR 0010's wording", () => {
  const adr = readFileSync(join(skill, "docs/adr/0010-status-text-is-sanitised-and-stderr-is-captured.md"), "utf8").replace(/\s+/g, " ");
  const reference = readFileSync(join(skill, "references/sandcastle.md"), "utf8").replace(/\s+/g, " ");
  const source = readFileSync(join(owned, ".sandcastle/lib/status.mts"), "utf8");

  it("is 8 in lib/status.mts, and its comment says so", () => {
    assert.match(source, /const MAX_MARKS = 8;/);
    assert.match(source, /no more than MAX_MARKS combining marks in a row/);
    assert.doesNotMatch(source, /const MAX_MARKS = 3;/);
  });

  it("is 8 in ADR 0010, and the owner's call on the number is settled", () => {
    assert.match(adr, /no more than eight combining marks in a row/);
    assert.match(adr, /stacks more than eight combining marks/);
    assert.doesNotMatch(adr, /three combining marks/);
    assert.doesNotMatch(adr, /more than three combining marks/);
    assert.doesNotMatch(adr, /Whether three is the right number/);
  });

  it("is 8 in references/sandcastle.md", () => {
    assert.match(reference, /no more than eight combining marks in a row/);
    assert.doesNotMatch(reference, /three combining marks/);
  });

  it("says assigned pictographs in ADR 0010's Decisions bullet", () => {
    assert.match(adr, /a zero-width joiner between two assigned pictographs/);
    assert.match(adr, /variation selector right after an assigned pictograph/);
    assert.doesNotMatch(adr, /between two pictographs/);
    assert.doesNotMatch(adr, /right after a pictograph/);
  });
});

// A run that starts no role (the planner alone) has no .sandcastle/logs, so the report holds no reviewer-logs/ folder and no index.txt, and the
// copy step says nothing (liveRoleLogFs.list treats a missing folder as no logs: mpaulosky/dotfiles#432). The reference's bullet on the reviewers' logs
// has to say so, or a reader of the artifact can't tell that an absent folder is normal (mpaulosky/dotfiles#433).
describe("references/sandcastle.md's bullet on the reviewers' logs, for a run that starts no role", () => {
  const reference = readFileSync(join(skill, "references/sandcastle.md"), "utf8").replace(/\s+/g, " ");
  const start = reference.indexOf("The run report artifact holds an allowlisted view of the reviewers' logs");
  const next = reference.indexOf(" - **", start + 1);
  const bullet = start === -1 ? "" : reference.slice(start, next === -1 ? undefined : next);
  const sentences = bullet.split(/(?<=\.)\s+(?=[A-Z`])/);
  const noRole = sentences.filter((sentence) => /\bno role\b/i.test(sentence));

  it("is found, and keeps its existing description of the view", () => {
    assert.notEqual(start, -1, "the bullet on the reviewers' logs is not in the reference");
    assert.match(bullet, /`index\.txt`/);
    assert.match(bullet, /`reviewer-<n>\.log`/);
  });

  it("has a sentence about a run that starts no role", () => {
    assert.notEqual(noRole.length, 0, "no sentence in the bullet mentions a run with no role");
  });

  it("says such a run has no .sandcastle/logs folder, as copyReviewerLogs' listing finds", () => {
    assert.ok(noRole.some((sentence) => sentence.includes(".sandcastle/logs")), `the sentence doesn't name .sandcastle/logs: ${noRole.join(" | ")}`);
  });

  it("says such a run leaves no reviewer-logs/ folder and no index.txt", () => {
    assert.ok(
      noRole.some((sentence) => /no `reviewer-logs\/` folder/.test(sentence) && /no `index\.txt`/.test(sentence)),
      `the sentence doesn't say "no \`reviewer-logs/\` folder" and "no \`index.txt\`": ${noRole.join(" | ")}`,
    );
  });

  it("says the copy step warns about nothing", () => {
    assert.ok(
      noRole.some((sentence) => /\b(says nothing|warns? (about )?nothing|prints no warning|no warning|without (a )?warning)\b/i.test(sentence)),
      `the sentence doesn't say that nothing is warned about: ${noRole.join(" | ")}`,
    );
  });

  // copyReviewerLogs returns at `names.length === 0`, before the mkdir and the index, so what decides the folder is a `*-reviewer.log`, not whether
  // .sandcastle/logs exists (off Actions the summary and hand-backs create it with no role run).
  it("names the condition the code uses: no *-reviewer.log to copy, which a run with other logs only also has", () => {
    assert.ok(noRole.some((sentence) => sentence.includes("`*-reviewer.log`")), `the sentence doesn't name \`*-reviewer.log\`: ${noRole.join(" | ")}`);
    assert.ok(
      noRole.some((sentence) => /pre-push review/i.test(sentence) && /non-reviewer|other role/i.test(sentence)),
      `the sentence doesn't say that a logs folder with only other logs also leaves no folder: ${noRole.join(" | ")}`,
    );
  });

  it("is true of the code: a logs folder with no reviewer log (other roles' and the pre-push review's only) gives no warning, folder or index", () => {
    const scratch = mkdtempSync(join(tmpdir(), "other-role-logs-"));
    try {
      const logs = join(scratch, ".sandcastle", "logs");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "feature-1-developer.log"), "a developer log\n");
      writeFileSync(join(logs, "feature-1-pre-push-reviewer.log"), "the pre-push review's log\n");
      const out = join(scratch, "report", "reviewer-logs");
      const warnings: string[] = [];
      const copied = copyReviewerLogs(logs, out, liveRoleLogFs, (line) => warnings.push(line), []);

      assert.deepEqual(copied, []);
      assert.deepEqual(warnings, []);
      assert.equal(existsSync(out), false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("is true of the code: a missing logs folder gives no warning and writes no folder and no index", () => {
    const scratch = mkdtempSync(join(tmpdir(), "no-role-logs-"));
    try {
      const out = join(scratch, "report", "reviewer-logs");
      const warnings: string[] = [];
      const copied = copyReviewerLogs(join(scratch, ".sandcastle", "logs"), out, liveRoleLogFs, (line) => warnings.push(line), []);

      assert.deepEqual(copied, []);
      assert.deepEqual(warnings, []);
      assert.equal(existsSync(out), false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// The host holds a built branch's PR as a draft while a Critical or Warning finding is open, and files the open Advisory ones in a follow-up issue
// (mpaulosky/dotfiles#388). The docs must say so, and none may still say Sandcastle skips the review or leaves the follow-up issue unfiled.
describe("the docs on the host-side review's PR state, record and follow-up issue", () => {
  const read = (relative: string) => readFileSync(join(skill, relative), "utf8").replace(/\s+/g, " ");
  const docs = {
    "SKILL.md": read("SKILL.md"),
    "CONTEXT.md": read("CONTEXT.md"),
    "references/sandcastle.md": read("references/sandcastle.md"),
    "references/pre-push-review.md": read("references/pre-push-review.md"),
    "docs/adr/0003-github-settings-as-code.md": read("docs/adr/0003-github-settings-as-code.md"),
    "docs/adr/0008-review-before-the-push.md": read("docs/adr/0008-review-before-the-push.md"),
  };
  const section = (docs["references/pre-push-review.md"].split("## Sandcastle runs the review on the host")[1] ?? "").split(/ ## /)[0] ?? "";

  it("no doc says Sandcastle skips or doesn't run the pre-push review", () => {
    for (const [name, text] of Object.entries(docs)) {
      assert.doesNotMatch(text, /sandcastle[^.]{0,60}\b(skips?|doesn't run|does not run|never runs)\b[^.]{0,40}(pre-push|local) review/i, name);
      assert.doesNotMatch(text, /(pre-push|local) review[^.]{0,40}\b(is|are) skipped\b[^.]{0,40}sandcastle/i, name);
    }
  });

  it("the host-side section is found, and no longer says the follow-up Advisory issue isn't filed", () => {
    assert.notEqual(section, "", "the section 'Sandcastle runs the review on the host' is not in references/pre-push-review.md");
    assert.doesNotMatch(section, /follow-up Advisory issue isn't filed/);
    assert.match(section, /follow-up (Advisory )?issue/i);
  });

  it("the host-side section says open Critical or Warning findings hold the PR as a draft until a person accepts them and marks it ready", () => {
    assert.match(section, /draft/i);
    assert.match(section, /Critical or Warning/);
    assert.match(section, /`scripts\/review\.sh accept`/);
    assert.match(section, /`gh pr ready`/);
  });

  it("the host-side section says the PR's ## Review notes hold only a person's acceptances", () => {
    assert.match(section, /Review notes/);
    assert.match(section, /only a person's acceptances|a person's acceptances only/i);
  });

  it("CONTEXT.md's Host-side review entry and ADR 0008 say a PR with open findings is held as a draft", () => {
    const entry = (docs["CONTEXT.md"].split("**Host-side review**:")[1] ?? "").split("**Sandcastle section**")[0] ?? "";
    assert.match(entry, /draft/i);
    assert.match(docs["docs/adr/0008-review-before-the-push.md"], /draft/i);
  });

  it("references/sandcastle.md says the host holds the PR as a draft while Critical or Warning findings are open", () => {
    assert.match(docs["references/sandcastle.md"], /draft[^.]{0,200}(Critical or Warning|Warning or Critical)|(Critical or Warning|Warning or Critical)[^.]{0,200}draft/i);
  });
});

// A round's reviewers can run as parallel subagents of one lead session, behind a switch that stays on the sequential path until a run in a real sandbox
// has settled the questions the unit tests can't see (mpaulosky/dotfiles#399). The docs must say how to switch, who the lead is and how its answer is read.
describe("the docs on the reviewers as parallel subagents of one lead session", () => {
  const text = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
  const reference = text(join(skill, "references/pre-push-review.md"));
  const section = (reference.split("## Sandcastle runs the review on the host")[1] ?? "").split(/ ## /)[0] ?? "";
  const rules = text(fileURLToPath(new URL("../../.claude/rules/sandcastle.md", import.meta.url)));

  it("the host-side section is found", () => {
    assert.notEqual(section, "", "the section 'Sandcastle runs the review on the host' is not in references/pre-push-review.md");
  });

  it("the host-side section names both modes and the switch, and says the default stays sequential until a real-sandbox run", () => {
    assert.match(section, /`SANDCASTLE_REVIEWERS`/);
    assert.match(section, /`sequential`/);
    assert.match(section, /`subagents`/);
    assert.match(section, /default[^.]{0,80}sequential|sequential[^.]{0,80}default/i);
    assert.match(section, /real sandbox/i);
  });

  it("the host-side section names the lead role and says the host reads each lens's block itself and fails a missing lens", () => {
    assert.match(section, /`pre-push-review-lead`/);
    assert.match(section, /nonce/i);
    assert.match(section, /each lens|per lens|every lens/i);
    assert.match(section, /missing|no block/i);
  });

  it("the host-side section says what the lead may do: Agent, Read, Grep and Glob, no shell", () => {
    assert.match(section, /`Agent`/);
    assert.match(section, /Read, Grep and Glob/);
  });

  it("the host-side section records an answer for each of the issue's four open questions", () => {
    assert.match(section, /--tools/);
    assert.match(section, /--setting-sources/);
    assert.match(section, /--agents/);
    assert.match(section, /timeout/i);
    assert.match(section, /verbatim/i);
  });

  it("the host-side section says what the lead can't be caught doing: shortening or emptying a block it relays", () => {
    assert.match(section, /(shorten|empt)[^.]{0,120}(accepted|can't be (told|detected|caught)|cannot be)/i);
  });

  it("the rule's Host safety section says the lead holds Agent, Read, Grep and Glob and the subagents Read, Grep and Glob only", () => {
    assert.match(rules, /pre-push-review-lead/);
    assert.match(rules, /Agent,Read,Grep,Glob|Agent, Read, Grep and Glob/);
    assert.match(rules, /subagents?[^.]{0,120}Read, Grep and Glob only/i);
  });

  it("the rule says the lead's Agent tool is an allowlist of the round's lens agents, not a bare Agent", () => {
    assert.match(rules, /Agent\(lens-[^)]*\)/);
    assert.match(rules, /leadTools/);
    assert.match(rules, /restrictedClaudeCode/);
    assert.doesNotMatch(rules, /holds `Agent,Read,Grep,Glob`/);
  });

  it("liveReviewHost's header, in the live build.mts and the Template's copy, says the lead's Agent tool is limited to the round's lens agents (leadTools)", () => {
    for (const file of [
      new URL("./build.mts", import.meta.url),
      new URL(`../../${TEMPLATE_OWNED_DIR}/.sandcastle/lib/build.mts`, import.meta.url),
    ]) {
      const header = text(fileURLToPath(file)).split("export function liveReviewHost")[0] ?? "";
      assert.match(header, /Agent` tool limited to the round's lens-<id> agents \(leadTools\)/, fileURLToPath(file));
      assert.doesNotMatch(header, /The lead holds Agent, Read, Grep and Glob/, fileURLToPath(file));
    }
  });
});

// mpaulosky/dotfiles#392: the role prompts are Owned, so a repo's own content has to be moved into roles/shared-rules.md and roles/skills.md
// before an Apply overwrites them. The docs say so, and the records of the decision agree.
describe("the docs of the Owned role prompts (mpaulosky/dotfiles#392)", () => {
  const reference = readFileSync(join(skill, "references/sandcastle.md"), "utf8");
  const migrating = reference.slice(reference.indexOf("## Migrating a repo"));
  const adr = (name: string) => readFileSync(join(skill, "docs/adr", name), "utf8");

  it("names roles/skills.md and the {{REPO_SKILLS}} and {{UI_ROLE}} placeholders the host fills in", () => {
    assert.match(reference, /roles\/skills\.md/);
    assert.match(reference, /\{\{REPO_SKILLS\}\}/);
    assert.match(reference, /\{\{UI_ROLE\}\}/);
  });

  it("says in the migration steps that a repo moves its pointers, repo bullets and UI notes to roles/shared-rules.md and its SKILLS block to roles/skills.md before Apply", () => {
    assert.notEqual(migrating, reference, "the reference has no migration section");
    assert.match(migrating, /before (?:the )?Apply/i);
    assert.match(migrating, /roles\/shared-rules\.md/);
    assert.match(migrating, /roles\/skills\.md/);
    assert.match(migrating, /docs\/CODING_STANDARDS\.md/);
    assert.match(migrating, /Blazor-Server/);
    assert.match(migrating, /auth0-management-app/);
  });

  it("lists the nine prompts as Owned and roles/shared-rules.md and roles/skills.md as Seed, in the reference's tables", () => {
    const ownedTable = /\n## Owned files\n([\s\S]*?)\n## /.exec(reference)?.[1] ?? "";
    const seedTable = /\n## Seed files\n([\s\S]*?)\n## /.exec(reference)?.[1] ?? "";

    assert.ok(ownedTable.length > 0 && seedTable.length > 0, "the reference's Owned and Seed tables weren't found");
    // The Owned table may write the seven role prompts as one row, so each is looked for by name.
    for (const name of ["plan-prompt.md", "review-prompt.md", "architect", "backend", "tester", "follow-up", "gate-fixer", "scribe", "ui"]) {
      assert.ok(ownedTable.includes(name), `${name} isn't in the Owned table`);
    }
    for (const file of ["plan-prompt.md", "review-prompt.md"]) assert.ok(!seedTable.includes(file), `${file} is still in the Seed table`);
    assert.doesNotMatch(seedTable, /roles\/\*\.md/, "the Seed table still lists the role prompts");
    assert.match(seedTable, /roles\/shared-rules\.md/);
    assert.match(seedTable, /roles\/skills\.md/);
  });

  it("amends ADR 0006: Owned prompts, Seed shared-rules.md and skills.md, and the rejected option of keeping them Seed", () => {
    const text = adr("0006-sandcastle-section-of-the-template.md");

    assert.match(text, /Amended by mpaulosky\/dotfiles#392/);
    assert.match(text, /roles\/skills\.md/);
    assert.match(text, /Keeping the role prompts Seed/);
  });

  it("says in ADR 0007 that roles/ui.md is Owned", () => {
    assert.match(adr("0007-sandcastle-code-is-owned-with-a-seed-repo-config.md"), /`roles\/ui\.md` is Owned/);
  });

  it("names the prompts among the files a re-Apply reviews, in references/pre-push-review.md", () => {
    const text = readFileSync(join(skill, "references/pre-push-review.md"), "utf8");

    assert.match(text, /REVIEWED_ON_REAPPLY[\s\S]*?plan-prompt\.md/);
    assert.match(text, /REVIEWED_ON_REAPPLY[\s\S]*?review-prompt\.md/);
  });
});
