import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { uiEnabled } from "./agents.mts";
import { backendPromptArgs } from "./prompts.mts";

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

  // lib/skills.test.mts (Owned) checks the prompts against SANDBOX_SKILLS.
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

  // mpaulosky/dotfiles#392: the role prompts are the Template's Owned files and name no repo, so what they held about dotfiles is in its
  // shared rules, which every role reads.
  it("tells the developers to keep dotfiles' copies of Owned files in step with the Template", () => {
    const rules = read("roles/shared-rules.md");

    assert.match(rules, /copy it over the root copy/);
    assert.match(rules, /copy the Template's file over the copy before you finish/);
  });

  it("tells the roles where tests go in each stack", () => {
    const rules = read("roles/shared-rules.md");

    assert.match(rules, /pr-automerge\.test\.mjs/);
    assert.match(rules, /<name>\.test\.sh/);
  });

  it("tells the tester how to stub in each stack, in its own prompt", () => {
    const prompt = read("roles/tester.md");

    assert.match(prompt, /throw new Error\("Not implemented"\)/);
    assert.match(prompt, /<module>\.test\.mts/);
  });

  it("points the roles at the Sandcastle rule for TypeScript work through the shared rules", () => {
    assert.match(read("roles/shared-rules.md"), /\.claude\/rules\/sandcastle\.md/);
  });

  it("gives the roles dotfiles' reading list, the PR description pointer and the follow-up and scribe rules in the shared rules", () => {
    const rules = read("roles/shared-rules.md");

    for (const pointer of ["CONTEXT.md", "SKILL.md", "references/", "docs/adr/", "references/pr-process.md"]) {
      assert.ok(rules.includes(pointer), `the shared rules don't name ${pointer}`);
    }
    // The follow-up rule: a Template workflow fix goes in the Template's copy, and the four workflows with a root copy get the same change.
    assert.match(rules, /follow-up/i);
    assert.match(rules, /root copy/);
    // The scribe's targets, and that Markdown inside the Template's folders is the developer's.
    assert.match(rules, /scribe/i);
    assert.ok(rules.includes("template/owned/") && rules.includes("template/seed/"), "the shared rules don't name the Template's folders");
    assert.match(rules, /release-generated|no release/i);
    // The planner lists both a Template file and its root copy.
    assert.match(rules, /planner/i);
    assert.match(rules, /`files`/);
    // test.sh counts FAIL: lines, and the Sandcastle check runs only after it passes.
    assert.match(rules, /FAIL:/);
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

// The host's secret scan (lib/scan.mts) refuses a commit whose added lines match a secret's shape and cannot tell a fixture from a secret, so
// the roles that write tests build such strings at run time (a tester's fake token stopped an issue from being published). The rule lives in
// the shared rules, which every role reads, not in each role's prompt.
describe("secret-shaped test fixtures", () => {
  const seedRules = new URL(
    "../../Support For New Projects/.claude/skills/repo-ci-baseline/template/seed/.sandcastle/roles/shared-rules.md",
    import.meta.url,
  );
  const ruleCopies = [
    ["dotfiles' shared rules", () => read("roles/shared-rules.md")],
    ["the Template's Seed shared rules", () => readFileSync(seedRules, "utf8")],
  ] as const;

  for (const [name, rules] of ruleCopies) {
    it(`tells the roles in ${name} to build a secret-shaped test string at run time, with the example`, () => {
      const text = rules();

      assert.match(text, /secret/i);
      assert.match(text, /at run time/);
      assert.ok(text.includes('`${"gh"}p_${"A".repeat(36)}`'), "the run-time token example is missing");
      assert.match(text, /GitHub token/);
      assert.match(text, /API key/);
    });

    it(`tells the roles in ${name} never to write the whole shape in a source line, a fixture or a comment`, () => {
      const text = rules();

      assert.match(text, /never/i);
      assert.match(text, /source line/);
      assert.match(text, /fixture/);
      assert.match(text, /comment/);
    });

    it(`says in ${name} that the host scans every commit's added lines, a match stops the issue and a later commit doesn't clear it`, () => {
      const text = rules();

      assert.match(text, /scans every commit/);
      assert.match(text, /added lines/);
      assert.match(text, /not (?:be )?published|from being published/);
      assert.match(text, /later commit does not clear it|later commit doesn't clear it/);
    });
  }

  it("reaches the tester and the backend through the shared rules, not a copy in each role's prompt", () => {
    for (const role of ["tester", "backend"]) {
      const prompt = read(`roles/${role}.md`);

      assert.match(prompt, /\{\{SHARED_RULES\}\}/, role);
      assert.ok(!prompt.includes('"A".repeat(36)'), `${role} carries its own copy of the rule`);
      assert.doesNotMatch(prompt, /secret-shaped/, role);
    }
  });
});

// Issue #72: the optional roles the planner picks, and the design note the
// architect passes to the roles after it.
describe("optional role prompts", () => {
  it("asks the planner for a roles field naming architect and scribe, with the ui bullet left to {{UI_ROLE}} (dotfiles has no UI role)", () => {
    const prompt = read("plan-prompt.md");

    assert.match(prompt, /"roles": \[/);
    for (const role of ["architect", "scribe"]) {
      assert.match(prompt, new RegExp(`^- \`${role}\`:`, "m"), role);
    }
    assert.match(prompt, /^\{\{UI_ROLE\}\}$/m);
    assert.doesNotMatch(prompt, /^- `ui`:/m);
  });

  // mpaulosky/dotfiles#392: roles/ui.md is Owned and opt-in, so every repo has the file and the role stays inert until ROLE_AGENTS has a `ui` entry.
  it("carries roles/ui.md, which is inert here because dotfiles' ROLE_AGENTS has no ui entry", async () => {
    assert.ok(existsSync(sandcastleFile("roles/ui.md")), "roles/ui.md is missing: it is an Owned copy in every repo");
    assert.equal(uiEnabled(), false);
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

  it("tells the developer its run is the last developer run, through the UI_DEVELOPER argument", () => {
    assert.match(read("roles/backend.md"), /\{\{UI_DEVELOPER\}\}/);
    assert.match(String(backendPromptArgs({ number: 1, title: "t", body: "", labels: [], comments: [] }, "b", false).UI_DEVELOPER), /last developer run/);
  });

  it("keeps the scribe off release-generated files and ADRs, and sends it to the shared rules for anything the repo says belongs elsewhere", () => {
    const prompt = read("roles/scribe.md");

    for (const path of ["docs/blogs/", "docs/README.md", "docs/index.html", "docs/adr/"]) {
      assert.ok(prompt.includes(`\`${path}\``), path);
    }
    assert.match(prompt, /commit nothing/i);
    assert.match(prompt, /markdownlint-cli2/);
    assert.match(prompt, /anything the shared rules say belongs elsewhere/);
    assert.ok(!prompt.includes("template/owned/"), "the Template's folders are dotfiles' own, so they belong in the shared rules");
  });
});

// #248: the planner names each pick's files, and the host holds back picks
// that share one before the critique looks at the rest.
describe("file overlap prompts", () => {
  it("asks the planner for a files field in the plan's example and in a rule of its own", () => {
    const prompt = read("plan-prompt.md");

    assert.match(prompt, /"files": \[/);
    assert.match(prompt, /`files`/);
    assert.match(prompt, /open pull request/);
  });

  it("gives both of the planner's example picks a files list", () => {
    const example = /<plan>\n([\s\S]*?)\n<\/plan>/.exec(read("plan-prompt.md"))?.[1];

    assert.ok(example, "plan-prompt.md has no example plan");
    assert.equal(example.match(/"files": \[/g)?.length, 2);
  });

  it("tells the critique that the host already held back picks that share a path", () => {
    const prompt = read("critique-prompt.md");

    assert.match(prompt, /`files`/);
    assert.match(prompt, /already held back/);
  });

  // #254: the held issues reach the critique again, and the prompt says how to read their note.
  it("tells the critique that an unpicked issue with a heldNote is held back and still counts for the dependency check", () => {
    const prompt = read("critique-prompt.md");

    assert.match(prompt, /`heldNote`/);
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

// #280: the Template's Seed prompts are dotfiles' prompts rewritten for any repo. Sandcastle (lib/prompts.mts) fills the {{NAME}}s at
// run time, so a rewrite that drops one leaves a value unused, or an agent without what it needs. Apply fills {{OWNER}}, {{REPO}}
// and {{SOLUTION}} itself, so those three aren't compared. mpaulosky/dotfiles#392 made the role prompts Owned, which test.sh compares byte for
// byte with dotfiles' copies, so only the repo's own two files are left here.
describe("the Template's Seed prompts", () => {
  const seedSandcastle = new URL(
    "../../Support For New Projects/.claude/skills/repo-ci-baseline/template/seed/.sandcastle/",
    import.meta.url,
  );
  const applyPlaceholders = new Set(["OWNER", "REPO", "SOLUTION"]);
  const placeholders = (text: string) => {
    const names = new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]!));
    return [...names].filter((name) => !applyPlaceholders.has(name)).sort();
  };

  for (const prompt of ["roles/shared-rules.md", "roles/skills.md"]) {
    it(`${prompt} has the Sandcastle placeholders dotfiles' copy has`, () => {
      const seed = new URL(prompt, seedSandcastle);

      assert.ok(existsSync(seed), `the Template's Seed has no .sandcastle/${prompt}`);
      assert.deepEqual(placeholders(readFileSync(seed, "utf8")), placeholders(read(prompt)));
    });
  }

  it("keeps none of the nine Owned prompts", () => {
    for (const prompt of ["plan-prompt.md", "review-prompt.md", ...["architect", "backend", "tester", "scribe", "gate-fixer", "follow-up", "ui"].map((role) => `roles/${role}.md`)]) {
      assert.equal(existsSync(new URL(prompt, seedSandcastle)), false, `the Template's Seed still has .sandcastle/${prompt}`);
    }
  });

  it("has an empty roles/skills.md, which a .NET repo fills with its # SKILLS block", () => {
    const seed = new URL("roles/skills.md", seedSandcastle);

    assert.ok(existsSync(seed), "the Template's Seed has no .sandcastle/roles/skills.md");
    assert.equal(readFileSync(seed).length, 0);
  });

  it("points every role at what a repo adds, in roles/shared-rules.md: CONTEXT.md and .claude/rules/ where present, and the UI developer's files", () => {
    const rules = readFileSync(new URL("roles/shared-rules.md", seedSandcastle), "utf8");

    assert.match(rules, /CONTEXT\.md/);
    assert.match(rules, /\.claude\/rules\//);
    assert.match(rules, /UI developer/);
  });
});

// mpaulosky/dotfiles#392: the nine prompts that instruct the pipeline's roles are the Template's Owned files, read in every repo, so they hold
// no repo's text: a repo's content goes in roles/shared-rules.md and roles/skills.md.
describe("the Template's Owned prompts", () => {
  const ownedSandcastle = new URL(
    "../../Support For New Projects/.claude/skills/repo-ci-baseline/template/owned/.sandcastle/",
    import.meta.url,
  );
  const owned = (path: string) => {
    const file = new URL(path, ownedSandcastle);
    assert.ok(existsSync(file), `the Template's Owned folder has no .sandcastle/${path}`);
    return readFileSync(file, "utf8");
  };
  const rolePrompts = ["architect", "backend", "tester", "follow-up", "gate-fixer", "scribe", "ui"].map((role) => `roles/${role}.md`);
  const prompts = ["plan-prompt.md", "review-prompt.md", ...rolePrompts];

  for (const prompt of prompts) {
    it(`${prompt} holds no repo's name, stack or issue number`, () => {
      const text = owned(prompt);

      assert.doesNotMatch(text, /\{\{(OWNER|REPO|SOLUTION)\}\}/, "Apply would fill it, and an Owned file is overwritten");
      assert.doesNotMatch(text, /Blazor|\.razor|bUnit|dotnet|\.slnx/);
      assert.doesNotMatch(text, /(?<![\w/])#\d+\b/, "a bare #N reads as the repo's own issue");
    });
  }

  for (const prompt of ["plan-prompt.md", "review-prompt.md", "roles/architect.md", "roles/tester.md", "roles/backend.md", "roles/ui.md"]) {
    it(`${prompt} points at CLAUDE.md, docs/adr/, the coding standards and whatever else the rules below point to`, () => {
      const text = owned(prompt);

      assert.match(text, /`CLAUDE\.md`/);
      assert.match(text, /\.sandcastle\/CODING_STANDARDS\.md/);
      if (prompt !== "plan-prompt.md" && prompt !== "review-prompt.md") {
        assert.match(text, /`docs\/adr\/`/);
        assert.match(text, /whatever else the rules below point to/);
      }
    });
  }

  for (const role of ["architect", "backend", "tester", "follow-up", "gate-fixer", "scribe", "ui"]) {
    it(`roles/${role}.md gets the shared rules`, () => {
      assert.match(owned(`roles/${role}.md`), /\{\{SHARED_RULES\}\}/);
    });
  }

  it("gives the planner and the reviewer the shared rules too", () => {
    for (const prompt of ["plan-prompt.md", "review-prompt.md"]) assert.match(owned(prompt), /\{\{SHARED_RULES\}\}/, prompt);
  });

  for (const role of ["tester", "backend", "ui"]) {
    it(`roles/${role}.md has {{REPO_SKILLS}} on a line of its own before its # EXECUTION section`, () => {
      const text = owned(`roles/${role}.md`);
      const at = text.search(/^\{\{REPO_SKILLS\}\}$/m);

      assert.notEqual(at, -1);
      assert.ok(at < text.indexOf("\n# EXECUTION"), "it goes before # EXECUTION, where the # SKILLS block sat");
      assert.doesNotMatch(text, /^# SKILLS\s*$/m);
    });
  }

  it("names the developer, not the backend developer, in roles/ui.md, which also calls itself the UI developer", () => {
    const text = owned("roles/ui.md");

    assert.match(text, /the developer/);
    assert.match(text, /UI developer/);
    assert.doesNotMatch(text, /backend developer/);
  });

  it("asks the planner for {{UI_ROLE}} on a line of its own between the architect and scribe bullets, with no static ui bullet", () => {
    const text = owned("plan-prompt.md");
    const architect = text.search(/^- `architect`:/m);
    const slot = text.search(/^\{\{UI_ROLE\}\}$/m);
    const scribe = text.search(/^- `scribe`:/m);

    assert.ok(architect !== -1 && slot !== -1 && scribe !== -1);
    assert.ok(architect < slot && slot < scribe, "{{UI_ROLE}} goes between the architect and scribe bullets");
    assert.doesNotMatch(text, /^- `ui`:/m);
    assert.match(text, /"roles": \[/);
    assert.equal(text.match(/"files": \[/g)?.length, 2, "the example plan keeps two picks, each with files");
  });

  it("tells the tester to build with the build commands in the shared rules, and still shows the stubs for C#, TypeScript and shell or Python", () => {
    const text = owned("roles/tester.md");

    assert.match(text, /build commands in the rules below/);
    assert.match(text, /throw new Error\("Not implemented"\)/);
    assert.match(text, /<module>\.test\.mts/);
    assert.match(text, /C#/);
  });

  it("keeps the full skip and todo list in the backend and gate-fixer prompts", () => {
    for (const role of ["backend", "gate-fixer"]) {
      const text = owned(`roles/${role}.md`);

      for (const form of ["`.skip`", "`.todo`", "`xfail`", "`pytest.skip()`", "`exit 0`"]) assert.ok(text.includes(form), `${role} doesn't name ${form}`);
    }
  });

  it("leaves the Template's own files to the shared rules in the backend, follow-up, scribe and architect prompts", () => {
    assert.doesNotMatch(owned("roles/backend.md"), /copy the Template's file over the copy/);
    const followUp = owned("roles/follow-up.md");
    assert.match(followUp, /only as the shared rules say/);
    assert.match(followUp, /out of scope/);
    assert.match(followUp, /can't push a workflow change/);
    const scribe = owned("roles/scribe.md");
    assert.match(scribe, /anything the shared rules say belongs elsewhere/);
    assert.doesNotMatch(scribe, /template\/owned\//);
    assert.match(owned("roles/architect.md"), /anything the shared rules say about copies of a file/);
    assert.match(owned("roles/gate-fixer.md"), /one at a time/);
  });

  it("follows docs/PROCESS.md in the review prompt only where the repo has one", () => {
    const text = owned("review-prompt.md");

    assert.match(text, /docs\/PROCESS\.md/);
    assert.match(text, /where the repo has one/);
  });
});

// The Seed prompt is never overwritten, so the reviewer's rules for its PR description are a placeholder the Template fills in
// (lib/prompts.mts#reviewerPromptArgs), here and in the Seed.
describe("review-prompt.md", () => {
  it("has {{PR_BODY_RULES}}, and still names pr-body.md and the three headings", () => {
    const prompt = read("review-prompt.md");

    assert.match(prompt, /\{\{PR_BODY_RULES\}\}/);
    assert.match(prompt, /pr-body\.md/);
    for (const heading of ["## Why", "## What changed", "## Verification"]) assert.ok(prompt.includes(heading), heading);
  });
});
