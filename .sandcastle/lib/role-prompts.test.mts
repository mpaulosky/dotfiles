import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SANDBOX_SKILLS } from "./skills.mts";

const sandcastleFile = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(sandcastleFile(path), "utf8");

describe("developer role prompts", () => {
  it("retires implement-prompt.md", () => {
    assert.equal(existsSync(sandcastleFile("implement-prompt.md")), false);
  });

  for (const role of ["architect", "tester", "backend", "scribe", "follow-up"]) {
    it(`gives the ${role} the shared rules`, () => {
      assert.match(read(`roles/${role}.md`), /\{\{SHARED_RULES\}\}/);
    });
  }

  for (const role of ["tester", "backend"]) {
    it(`lists every skill mounted into the sandbox for the ${role}`, () => {
      const prompt = read(`roles/${role}.md`);

      for (const skill of SANDBOX_SKILLS) {
        assert.match(prompt, new RegExp(`^- \`${skill}\`:`, "m"));
      }
    });
  }
});

// Sandcastle builds dotfiles' Template (JavaScript, Python and shell, each with
// its own tests) and its own TypeScript, so the developer roles carry each
// stack's test and stub instructions.
describe("developer roles across stacks", () => {
  it("gives the test commands for the Template's stacks and Sandcastle's TypeScript in the shared rules", () => {
    const rules = read("roles/shared-rules.md");

    assert.match(rules, /node --test/);
    assert.match(rules, /python3 -m pytest/);
    assert.match(rules, /\.test\.sh/);
    assert.match(rules, /pnpm exec tsc --noEmit -p \.sandcastle/);
    assert.match(rules, /pnpm exec tsx --test/);
  });

  it("tells the developers to keep dotfiles' copies of Owned files in step with the Template", () => {
    assert.match(read("roles/shared-rules.md"), /copy it over the root copy/);
    assert.match(read("roles/backend.md"), /copy the Template's file over the copy/);
  });

  it("tells the tester how to stub and where to put tests in each stack", () => {
    const prompt = read("roles/tester.md");

    assert.match(prompt, /pr-automerge\.test\.mjs/);
    assert.match(prompt, /throw new Error\("Not implemented"\)/);
    assert.match(prompt, /<module>\.test\.mts/);
  });

  it("points the tester and backend at the Sandcastle rule for TypeScript work", () => {
    for (const role of ["tester", "backend"]) {
      assert.match(read(`roles/${role}.md`), /\.claude\/rules\/sandcastle\.md/, role);
    }
  });

  it("names every node:test, pytest and test-script way to skip or todo a test as weakening it", () => {
    for (const role of ["backend", "gate-fixer"]) {
      const prompt = read(`roles/${role}.md`);

      for (const form of ["`.skip`", "`.todo`", "`{ skip }`", "`{ todo }`", "`t.skip()`", "`t.todo()`", "`skipif`", "`xfail`", "`pytest.skip()`", "`exit 0`"]) {
        assert.ok(prompt.includes(form), `${role} doesn't name ${form}`);
      }
    }
  });
});

// Issue #72: the optional roles the planner picks, and the design note the
// architect passes to the roles after it.
describe("optional role prompts", () => {
  it("asks the planner for a roles field naming architect and scribe, and no UI developer", () => {
    const prompt = read("plan-prompt.md");

    assert.match(prompt, /"roles": \[/);
    for (const role of ["architect", "scribe"]) {
      assert.match(prompt, new RegExp(`^- \`${role}\`:`, "m"), role);
    }
    assert.doesNotMatch(prompt, /^- `ui`:/m);
    assert.equal(existsSync(sandcastleFile("roles/ui.md")), false);
  });

  it("has the architect write its design note to .sandcastle/work/{n}/design.md, with its earlier note as input", () => {
    const prompt = read("roles/architect.md");

    assert.match(prompt, /\.sandcastle\/work\/\{\{TASK_ID\}\}\/design\.md/);
    assert.match(prompt, /\{\{DESIGN_NOTE\}\}/);
    assert.match(prompt, /docs\/adr\//);
  });

  it("points the tester, the developers and the reviewer at the design note", () => {
    for (const prompt of ["roles/tester.md", "roles/backend.md", "review-prompt.md"]) {
      assert.match(read(prompt), /\.sandcastle\/work\/\{\{TASK_ID\}\}\/design\.md/, prompt);
    }
  });

  it("tells the developer its run is the last developer run", () => {
    assert.match(read("roles/backend.md"), /last developer run/);
  });

  it("keeps the scribe off release-generated files, ADRs and the Template's own Markdown", () => {
    const prompt = read("roles/scribe.md");

    for (const path of ["docs/blogs/", "docs/README.md", "docs/index.html", "docs/adr/", "template/owned/"]) {
      assert.ok(prompt.includes(`\`${path}\``), path);
    }
    assert.match(prompt, /commit nothing/i);
    assert.match(prompt, /markdownlint-cli2/);
  });
});

// #78: the follow-up role resolves a PR's merge conflicts and review
// threads, writing its verdicts to a file the host reads back, never
// rewriting history itself.
describe("follow-up role prompt", () => {
  const prompt = () => read("roles/follow-up.md");

  it("takes the PR number, the merge note and the threads given to it", () => {
    for (const placeholder of ["{{PR_NUMBER}}", "{{MERGE}}", "{{THREADS_JSON}}", "{{CODEQL_LOG}}"]) {
      assert.ok(prompt().includes(placeholder), placeholder);
    }
  });

  it("writes its verdicts to .sandcastle/follow-up.json, naming every verdict", () => {
    const text = prompt();

    assert.match(text, /\.sandcastle\/follow-up\.json/);
    for (const verdict of ["fixed", "declined", "outdated"]) {
      assert.ok(text.includes(verdict), verdict);
    }
  });

  it("forbids rebasing, amending or force-pushing: the host pushes without force", () => {
    const text = prompt();

    assert.match(text, /rebase/i);
    assert.match(text, /force/i);
  });
});

describe("review prompt", () => {
  // Match key terms anywhere in the review process, so rewording a check
  // doesn't break these tests but dropping it does.
  const reviewProcess = () => {
    const prompt = read("review-prompt.md");
    const start = prompt.indexOf("# REVIEW PROCESS");
    assert.notEqual(start, -1, "review-prompt.md has no REVIEW PROCESS section");
    const end = prompt.indexOf("\n# ", start + 1);
    return prompt.slice(start, end === -1 ? undefined : end);
  };

  it("checks that the acceptance tests cover every acceptance criterion", () => {
    assert.match(reviewProcess(), /acceptance tests[\s\S]*every acceptance criterion/i);
  });

  it("checks that the developers didn't weaken the acceptance tests", () => {
    assert.match(reviewProcess(), /weaken/i);
  });

  it("diffs the branch against {{BASE_BRANCH}}", () => {
    const prompt = read("review-prompt.md");

    assert.match(prompt, /git diff \{\{BASE_BRANCH\}\}\.\.\.\{\{BRANCH\}\}/);
    assert.match(prompt, /git log \{\{BASE_BRANCH\}\}\.\.\{\{BRANCH\}\}/);
  });

  // #335: every PR Sandcastle opened carried the same generic body; the
  // reviewer now drafts one with Why, What changed and Verification
  // sections, written to pr-body.md before the reviewer signals completion,
  // whichever of the two EXECUTION paths (changes made, or nothing to
  // change) it took.
  it("tells the reviewer to write pr-body.md with the Why, What changed and Verification headings", () => {
    const prompt = read("review-prompt.md");

    assert.match(prompt, /\.sandcastle\/work\/\{\{TASK_ID\}\}\/pr-body\.md/);
    assert.match(prompt, /## Why/);
    assert.match(prompt, /## What changed/);
    assert.match(prompt, /## Verification/);
  });

  it("writes pr-body.md before signalling completion, on every path", () => {
    const prompt = read("review-prompt.md");
    const writeIndex = prompt.search(/pr-body\.md/);
    const completeIndex = prompt.indexOf("<promise>COMPLETE</promise>");

    assert.notEqual(writeIndex, -1, "expected an instruction to write pr-body.md");
    assert.ok(writeIndex < completeIndex, "the instruction to write pr-body.md must come before the completion signal");
  });
});

describe("every prompt", () => {
  // Inside createSandbox(), Sandcastle sets {{TARGET_BRANCH}} to the sandbox's
  // own branch, so a diff against it is always empty. Use {{BASE_BRANCH}}.
  const prompts = [
    ...readdirSync(sandcastleFile("")).filter((name) => name.endsWith(".md")),
    ...readdirSync(sandcastleFile("roles/")).filter((name) => name.endsWith(".md")).map((name) => `roles/${name}`),
  ];

  for (const prompt of prompts) {
    it(`${prompt} doesn't use Sandcastle's TARGET_BRANCH`, () => {
      assert.doesNotMatch(read(prompt), /TARGET_BRANCH/);
    });
  }
});
