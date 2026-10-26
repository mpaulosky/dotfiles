import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REVIEW_NOTES_END, REVIEW_NOTES_START } from "./review-ledger.mts";

// The pre-push-review skill's reviewers read text people without write access
// wrote, so they run as an agent with only read tools. Nothing else pins that:
// Claude Code reads both files, not this repository's code.
const agent = readFileSync(new URL("../../.claude/agents/pre-push-reviewer.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../../.claude/skills/pre-push-review/SKILL.md", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../.github/workflows/claude-review.yml", import.meta.url), "utf8");
const bar = readFileSync(new URL("../../.claude/skills/pre-push-review/review-bar.md", import.meta.url), "utf8");

describe("the pre-push-review skill's reviewers", () => {
  it("get only Read, Grep and Glob", () => {
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(agent)?.[1] ?? "";

    assert.match(frontMatter, /^name: pre-push-reviewer$/m);
    assert.match(frontMatter, /^tools: Read, Grep, Glob$/m);
  });

  // A key Claude Code reads that this test doesn't know, a second `tools`
  // line it might read instead, or a line that continues `tools` (YAML folds
  // an indented line into the value before it) could give them more than
  // these. So every line is checked, not only the ones shaped like a key: a
  // YAML explicit key (`? hooks`) matches none of the allowed shapes.
  // YAML breaks a line at a lone carriage return too, so a key after one is
  // a key to Claude Code and part of the line before it to the test below.
  it("are defined in a file with no line break but \\n", () => {
    assert.doesNotMatch(agent, /[\r\u0085\u2028\u2029]/);
  });

  it("are defined by exactly a name, a description, their tools and a model, each once", () => {
    const lines = (/^---\n([\s\S]*?)\n---\n/.exec(agent)?.[1] ?? "").split("\n");
    const keys: string[] = [];

    for (const line of lines) {
      const key = /^(name|description|tools|model): \S/.exec(line)?.[1];
      if (key !== undefined) {
        keys.push(key);
      } else {
        assert.match(line, /^ {2}\S/, `not a known key or a continuation: ${JSON.stringify(line)}`);
        // A parser that trims indentation could read this as a key.
        assert.doesNotMatch(line, /^\s+[\w-]+\s*:(?:\s|$)/, `a continuation shaped like a key: ${JSON.stringify(line)}`);
        assert.equal(keys.at(-1), "description", `only the description continues onto another line: ${JSON.stringify(line)}`);
      }
    }

    assert.deepEqual(keys, ["name", "description", "tools", "model"]);
  });
});

describe("the pre-push-review skill's Review notes", () => {
  it("are spliced into the description by scripts/review.sh body, never by hand", () => {
    // One && chain, so a failed fetch or a refused splice never reaches gh.
    assert.match(
      skill,
      /gh pr view <n> --json body -q \.body > <run>\/old-body\.md && scripts\/review\.sh body <run>\/old-body\.md <run>\/body\.md && GH_REPO="\$repo" gh pr edit <n> --body-file <run>\/body\.md/,
    );
    assert.match(skill, /scripts\/review\.sh body <run>\/old-body\.md <run>\/body\.md && repo="\$\(scripts\/review\.sh repo\)" && GH_REPO="\$repo" gh pr create [^`\n]*--body-file <run>\/body\.md$/m);
  });

  it("name the markers renderReviewNotes writes", () => {
    assert.ok(skill.includes(`\`${REVIEW_NOTES_START}\``));
    assert.ok(skill.includes(`\`${REVIEW_NOTES_END}\``));
  });
});

describe("the push-before-reply rule", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("is in the skill's step 9", () => {
    assert.ok(flat(skill).includes("and the branch is pushed, run:"));
    assert.ok(flat(skill).includes("Editing the description starts PR Auto-Merge, which is why it waits for the push"));
    assert.ok(flat(skill).includes("Push a thread's fix before replying to or resolving its thread"));
  });
});

describe("the pre-push-review skill's reviewers, as started", () => {
  it("are started as that agent, and never as another type", () => {
    assert.match(skill, /`subagent_type: "pre-push-reviewer"`/);
    assert.match(skill, /never start them as another type/);
    assert.match(skill, /unless you asked and the person chose a stand-in/);
  });

  it("run on Sonnet, in the skill's instructions and in the agent file", () => {
    assert.match(agent, /^model: sonnet$/m);
  });
});

describe("the pre-push-review skill's severities", () => {
  it("asks every reviewer for a severity and a suggested fix", () => {
    assert.match(skill, /`\{ "lens", "path", "line", "severity", "summary", "fix", "needsPerson", "why" \}`/);
    assert.match(agent, /`severity` \(`critical`, `warning` or `advisory`\) and a suggested `fix`/);
  });

  it("refuses a finding without a severity", () => {
    assert.match(skill, /Refuse a finding whose `severity` is missing or isn't `critical`, `warning` or `advisory`/);
  });

  it("reviews again after a round that fixed anything, and then only the fixes", () => {
    assert.match(skill, /Only a round that fixed something is followed by another/);
    assert.match(skill, /A round that fixed nothing ends the review/);
    assert.doesNotMatch(skill, /fixed only Advisory/);
    assert.doesNotMatch(skill, /fixed a Critical or Warning finding is followed/);
    assert.match(skill, /A later round reviews the fixes, not the whole branch again/);
    assert.doesNotMatch(skill, /Every round\s+reviews the whole branch/);
  });

  // The gate's own checks decide what merges, so a bug in them blocks.
  it("grades a bug in the gate's and CI's own scripts Critical, in the table and the bar", () => {
    const table = /\| \*\*Critical\*\* \|[^\n]*/.exec(skill)?.[0] ?? "";
    const grading = /`critical` for a\s+bug in code that runs \([^)]*\)/.exec(bar)?.[0] ?? "";

    for (const text of [table, grading]) {
      assert.match(text, /`\.github\/ci\/`/);
      assert.match(text, /`\.github\/scripts\/`/);
    }
  });

  it("files the Advisory findings left open in one follow-up issue per branch", () => {
    assert.match(skill, /File the open Advisory findings in one follow-up issue per branch/);
  });
});

describe("the pre-push-review skill's follow-up issue", () => {
  it("is written by scripts/review.sh advisory, never by hand", () => {
    assert.match(skill, /The body is the output of\s+`scripts\/review\.sh advisory`/);
    assert.match(skill, /Never write the body by hand/);
  });

  // record refuses an earlier id, so a re-raised finding has a new one, and
  // an amend or rebase can start the numbering again.
  const flat = skill.replace(/\s+/g, " ");

  it("names the old id in a re-raised Advisory finding, for the person reading it", () => {
    assert.ok(flat.includes("its summary opening with the old id (`R3 again: ...`)"));
    assert.doesNotMatch(flat, /kept from the old summary/);
  });

  // A re-raised finding's id, path and line can all change, and an id can be
  // reused after an amend or rebase, so none of them decides.
  it("counts a finding as listed by the problem it names, never by its id or path", () => {
    assert.ok(flat.includes("a finding counts as listed when the issue already lists the same problem, whatever its id, path or line"));
    assert.doesNotMatch(flat, /with the same path/);
  });

  it("posts nothing when the issue already lists every finding", () => {
    assert.ok(flat.includes("When the issue already lists every finding, post nothing."));
  });

  it("says the agent numbers findings, and record only refuses a reused id", () => {
    assert.ok(flat.includes("the agent numbers findings from `scripts/review.sh next`, and `record` refuses a reused one"));
    assert.doesNotMatch(flat, /`record` gives a re-raised finding a new id/);
  });

  it("is looked for only among the person's own issues, by its exact title", () => {
    assert.match(skill, /--author @me/);
    assert.match(skill, /select\(\.title == "chore\(review\): Advisory review findings: <branch>"\)/);
  });
});

describe("the pre-push-review skill's lenses", () => {
  it("keeps every lens that raised a merged finding, and never renames a lens to get past record", () => {
    assert.match(skill, /give the merged finding every lens that\s+raised it/);
    assert.match(skill, /never rename or trim its lens to get past the refusal/);
  });
});

describe("the pre-push-review skill's Warnings", () => {
  it("never regrades a reviewer's Warning, which wins any merge and is only dismissed with evidence", () => {
    assert.match(skill, /it's a Warning whenever any reviewer graded it one/);
    assert.match(skill, /A finding any\s+reviewer graded Warning stays a Warning: never regrade it/);
    assert.doesNotMatch(skill, /keeping the higher severity/);
  });

  it("names which findings reviewers see by id, lens and path only, from this run's rounds as well as latest", () => {
    assert.match(skill, /every finding the report marks\s+`\(security\)`/);
    assert.match(skill, /from `latest` or from this run's earlier\s+rounds, by its id, lens and path only/);
  });
});

describe("the pre-push-review skill's misgraded Warnings", () => {
  it("records a real non-security problem again at its own grade when its Warning is dismissed", () => {
    assert.match(skill, /also record the problem as a new finding with\s+its own id, graded from the table/);
  });
});

describe("the rules the severities change, where they're restated", () => {
  it("lets the person accept a Critical finding left open for them, in the Severities table", () => {
    const table = /\| \*\*Critical\*\* \|[^\n]*/.exec(skill)?.[0] ?? "";

    assert.match(table, /Yes, until fixed, or until the person accepts one left open for them/);
  });
});

describe("the pre-push-review skill's security mark", () => {
  const flat = skill.replace(/\s+/g, " ");

  it("has triage mark every finding, true when in doubt, and record it", () => {
    assert.ok(flat.includes("Then mark every finding's `security`"));
    assert.ok(flat.includes("`true` when in doubt"));
    assert.match(skill, /"severity": "critical", "security": false,/);
  });

  it("holds back from the notes every finding not marked as no security weakness", () => {
    assert.ok(flat.includes("any finding not marked `security: false`"));
  });

  it("records a real problem found under a dismissed Security-lens Warning under the lens that fits it", () => {
    assert.ok(flat.includes("under the lens that fits its problem"));
  });
});

describe("the pre-push-review skill's follow-up comment", () => {
  it("adds the unlisted findings only when some aren't listed", () => {
    const flat = skill.replace(/\s+/g, " ");

    assert.ok(flat.includes("post nothing. Otherwise add the rest as a comment"));
    assert.doesNotMatch(flat, /post nothing\. Then add the rest/);
  });
});

describe("the pre-push-review skill's Critical grade", () => {
  it("covers untested behaviour and build configuration, and is the grade when in doubt, in the table and the bar", () => {
    const table = /\| \*\*Critical\*\* \|[^\n]*/.exec(skill)?.[0] ?? "";
    const flatBar = bar.replace(/\s+/g, " ");

    for (const text of [table, flatBar]) {
      assert.match(text, /new or changed behaviour with no test/);
      assert.match(text, /`Directory\.\*\.props`/);
    }
    assert.ok(flatBar.includes("`critical` when in doubt between `critical` and `advisory`"));
  });
});

describe("the pre-push-review skill's later rules", () => {
  const flat = skill.replace(/\s+/g, " ");

  it("keeps every line of its front matter at or under 200 characters", () => {
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";

    for (const line of frontMatter.split("\n")) {
      assert.ok(line.length <= 200, `${line.length} characters: ${line.slice(0, 60)}...`);
    }
  });

  it("leaves open for a person a Critical finding the last, review-only round raised", () => {
    assert.ok(flat.includes("and the round isn't the last, review-only one (step 7)"));
    assert.ok(flat.includes("or the last, review-only round raised it (step 7)"));
  });

  it("finds the branch's follow-up issue by its full title, past gh's default of 30", () => {
    assert.match(skill, /--limit 100/);
    assert.ok(flat.includes(`--search 'in:title "Advisory review findings: <branch>"'`));
  });

  it("asks the person again about a re-raised Advisory finding rather than filing it", () => {
    assert.ok(flat.includes("ask the person to accept it again with `scripts/review.sh accept`"));
  });
});

describe("the pre-push-review skill's follow-up issue text", () => {
  it("shows the person the exact body or comment and posts only once they say to", () => {
    const flat = skill.replace(/\s+/g, " ");

    assert.ok(flat.includes("show the person the exact text that will be posted"));
    assert.ok(flat.includes("post it only once they say to"));
    assert.doesNotMatch(flat, /have the person look over the report's Advisory section/);
  });
});

describe("the pre-push-review skill's fixing", () => {
  it("fixes Critical, Warning and Advisory findings alike, and leaves one open only for a person", () => {
    assert.match(skill, /Fix the Critical, Warning and Advisory findings\. For each one:/);
    assert.match(skill, /\*\*Fix it\*\* when it's a real Critical, Warning or Advisory finding, `needsPerson` is false/);
    assert.match(skill, /\| \*\*Warning\*\* \|[^|]*\| Fixed in the review, behind a regression test \|/);
    assert.doesNotMatch(skill, /Never fix a Warning they haven't asked you to fix/);
    assert.doesNotMatch(skill, /the Warnings the person asks you to fix/);
  });
});

describe("the pre-push-review skill's fixing, in the rest of its text", () => {
  it("still names Warnings with the Critical ones to fix in a round, and the Warning bullet for a person", () => {
    assert.match(skill, /in\s+that\s+round,\s+with\s+its\s+Critical\s+and\s+Warning\s+ones/);
    assert.match(skill, /\*\*Leave it open\*\* for a person, with its suggested fix, when a Critical or Warning finding's `needsPerson` is true/);
  });

  it("records a Warning fixed only with a test, and keeps an agent from loosening a guard or accepting for a person", () => {
    assert.match(skill, /A\s+security\s+finding\s+\(every\s+Warning\)\s+is\s+recorded\s+`fixed`\s+only\s+with\s+a\s+`test`/);
    assert.match(skill, /except\s+that\s+a\s+security\s+finding,\s+any\s+Warning,\s+needs\s+a\s+`test`/);
    assert.match(skill, /never\s+weaken,\s+skip\s+or\s+delete\s+a\s+test,\s+a\s+gate\s+check,\s+a\s+validation\s+or\s+a\s+permission/);
    assert.match(skill, /A fix that changes the gate, the ledger, the reviewer agent, `\.claude\/settings\.json` or a workflow's permissions is\s+`needsPerson`/);
    assert.match(skill, /Never accept a finding on a person's behalf/);
  });
});

describe("Claude Review's accepted-findings step and the ledger", () => {
  // The workflow is Owned by every Baseline repo and the ledger by every Sandcastle repo, so this is the one
  // place that sees both: the step reads the markers the ledger writes.
  it("look for the markers the ledger writes", () => {
    assert.ok(workflow.includes(`START = "${REVIEW_NOTES_START}"`), "the step's START is not the ledger's");
    assert.ok(workflow.includes(`END = "${REVIEW_NOTES_END}"`), "the step's END is not the ledger's");
  });
});

describe("the pre-push-review skill's reviewer effort", () => {
  it("is high, asked for explicitly", () => {
    assert.match(skill, /`model: "sonnet"` and `effort: "high"`/);
    assert.doesNotMatch(skill, /xhigh/);
  });
});

describe("the pre-push-review skill's lenses", () => {
  const lenses = readFileSync(new URL("../../.claude/skills/pre-push-review/lenses.md", import.meta.url), "utf8");

  it("are in lenses.md, a table of a lens, where it applies and what to ask, which the skill links", () => {
    const rows = lenses.split("\n").filter((line) => /^\| /.test(line) && !/^\| (Lens|---)/.test(line));

    assert.ok(rows.length >= 8, "lenses.md holds too few lenses");
    for (const row of rows) assert.equal(row.split(" | ").length, 3, row);
    assert.match(skill, /\(lenses\.md\)/);
  });

  it("includes the lenses the skill's Markdown-only rule names", () => {
    assert.match(lenses, /^\| Docs match the code \|/m);
    assert.match(lenses, /^\| Repo conventions \|/m);
  });
});

describe("the pre-push-review skill's repository", () => {
  const prefix = 'repo="$(scripts/review.sh repo)" && GH_REPO="$repo" gh ';

  // What is wrong with the gh commands on one line: the first must directly follow the slug read, a later one a GH_REPO="$repo".
  const ghChainProblems = (line: string): string[] => {
    const problems: string[] = [];
    const first = line.search(/(^|[^A-Za-z0-9_.-])gh [a-z]/) + (/^gh [a-z]/.test(line) ? 0 : 1);
    const at = line.indexOf(prefix);
    if (at < 0 || at + prefix.length - 3 !== first) problems.push("the first gh doesn't follow the slug read");
    const rest = line.slice(first + 3).replaceAll('GH_REPO="$repo" gh ', "@");
    if (/(^|[^A-Za-z0-9_.-])gh [a-z]/.test(rest)) problems.push("a later gh has no GH_REPO");
    return problems;
  };

  it("is told to gh by scripts/review.sh repo, read first in a chain that stops when it fails, never by a name written into the skill", () => {
    const assignments = skill.match(/GH_REPO=("[^"]*"|\S+)/g) ?? [];

    assert.ok(assignments.length > 0, "the skill runs no gh command");
    for (const assignment of assignments) assert.equal(assignment, 'GH_REPO="$repo"', assignment);
    assert.doesNotMatch(skill, /GH_REPO=[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  });

  it("starts every gh command with that chain, or continues one that already read the slug", () => {
    // Each line that runs gh: the slug is read first, and the first gh on it follows that read directly.
    const lines = skill.split("\n").filter((line) => /(^|[^A-Za-z0-9_.-])gh [a-z]/.test(line));

    assert.ok(lines.length >= 8, "too few gh commands found");
    for (const line of lines) {
      assert.deepEqual(ghChainProblems(line), [], line);
    }
  });

  it("refuses a gh command whose slug was never read", () => {
    assert.notDeepEqual(ghChainProblems('1. `GH_REPO="$repo" gh issue create --title x`'), []);
    assert.notDeepEqual(ghChainProblems("1. `gh issue create --title x`"), []);
    assert.notDeepEqual(ghChainProblems("1. `gh repo view`"), []);
    assert.notDeepEqual(ghChainProblems(`1. \`gh repo view && ${prefix}pr edit 1\``), []);
    assert.notDeepEqual(ghChainProblems(`1. \`${prefix}pr view 1 && gh repo view\``), []);
    assert.notDeepEqual(ghChainProblems(`1. \`${prefix}pr view 1 && sh -c "gh pr edit 1"\``), []);
    assert.notDeepEqual(ghChainProblems(`1. \`${prefix}pr view 1 && sh -c 'gh pr edit 1'\``), []);
    assert.notDeepEqual(ghChainProblems(`1. \`${prefix}pr view 1 && $(gh pr edit 1)\``), []);
    assert.notDeepEqual(ghChainProblems(`1. \`sh -c 'gh pr view 1' && ${prefix}pr edit 1\``), []);
    assert.notDeepEqual(ghChainProblems(`1. \`${prefix}pr view 1 && x=gh pr edit 1\``), []);
    assert.deepEqual(ghChainProblems(`1. \`${prefix}pr view 1\`, then read it through a pipe`), []);
    assert.notDeepEqual(ghChainProblems(`1. \`gh pr view 1 && ${prefix}pr edit 1\``), []);
    assert.notDeepEqual(ghChainProblems(`1. \`${prefix}pr view 1 && gh pr edit 1\``), []);
    assert.deepEqual(ghChainProblems(`1. \`${prefix}issue create --title x\``), []);
    assert.deepEqual(ghChainProblems(`1. \`${prefix}pr view 1 && GH_REPO="$repo" gh pr edit 1\``), []);
  });
});
