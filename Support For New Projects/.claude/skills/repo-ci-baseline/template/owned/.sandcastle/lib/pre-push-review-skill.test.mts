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
const hardening = readFileSync(new URL("../../.claude/skills/hardening-review/SKILL.md", import.meta.url), "utf8");

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

// hardening-review reuses pre-push-review by step number and keeps its reviewers' sandbox: nothing else would notice a
// renumbering or a run folder that moved out of the folder the sandbox hides.
describe("the hardening-review skill's reuse of pre-push-review", () => {
  // The prose wraps at 120 columns: phrases are matched with their line breaks collapsed.
  const flat = hardening.replace(/\s+/g, " ");
  it("points at steps that still exist under those numbers", () => {
    for (const heading of ["### 1. Get ready", "### 2. Gate first", "### 3. Gather earlier decisions", "### 4. Review the diff", "### 5. Verify and triage", "### 6. Fix behind a regression test", "### 7. Review the fixes until a round fixes nothing", "### 8. Record", "### 9. Report"]) {
      assert.ok(skill.includes(`${heading}\n`), `pre-push-review lost "${heading}"`);
    }
    assert.match(hardening, /steps 1 to 3/);
    assert.match(hardening, /\b8 to 9\b/);
    assert.match(hardening, /steps 4 to 7/);
  });

  it("starts the same read-only reviewers and fixes in the session", () => {
    assert.match(hardening, /`pre-push-reviewer`/);
    assert.match(hardening, /\*\*Fix in this session\*\*, never in subagents/);
    assert.match(hardening, /\*\*Run nothing a reviewer wrote\.\*\*/);
  });

  it("keeps what can describe a weakness under .git/review, which the sandbox hides, and out of the reviewers' folder", () => {
    assert.match(hardening, /^private="\$common\/review\/hardening\/\$name"$/m);
    assert.match(hardening, /^run="\$common\/hardening-review\/\$name"$/m);
    // known-open.json holds reasons, so only the private folder may hold it.
    assert.match(hardening, /\| `private` \(reviewers are not pointed at it\) \| `known-open\.json` \|/);
    assert.doesNotMatch(hardening, /<run>\/known-open\.json/);
    // add, check and match: a regex that stopped matching would otherwise leave the loop empty and the test green.
    const uses = hardening.match(/known_open\.py \w+ '([^']+)'/g) ?? [];
    assert.ok(uses.length >= 3, `expected the add, check and match commands, found ${uses.length}`);
    for (const use of uses) {
      assert.match(use, /'<private>\/known-open\.json'/, use);
    }
  });

  it("says what the run folder discloses, because a sandbox can read it, and makes the private folder private", () => {
    assert.match(hardening, /`run` is not hidden from a sandbox/);
    assert.match(hardening, /lists each known-open entry's lens, file and line range/);
    // The skill itself puts a refuted finding's output line and each outcome's reason in `run`: it can't say it holds none.
    assert.doesNotMatch(flat, /never holds a reason, an input or an output/);
    // The rule covers security findings only (mpaulosky/dotfiles#341, R73): a non-security finding's reason is not a weakness.
    assert.doesNotMatch(flat, /anything about a finding still in the code/);
    assert.match(flat, /never holds a known-open reason for a security finding or anything about a security finding still in the code beyond its id, lens and path/);
    // A umask is shell state, which doesn't carry between Bash calls.
    assert.match(hardening, /umask 077; mkdir -p/);
    assert.match(flat, /begin every later command that writes under it with `umask 077;`/);
  });

  it("says where the deny rule comes from instead of claiming pre-push-review has one", () => {
    assert.doesNotMatch(hardening, /`pre-push-review`'s deny rules/);
    assert.match(hardening, /`Read\(\/\/\*\*\/\.git\/review\/\*\*\)` keeps Claude Code's own Read tool out of in a repo that has added it/);
  });

  it("describes a security finding as held back while it is in the code, as pre-push-review step 4 does", () => {
    assert.match(hardening, /\(as `pre-push-review` step 4 defines it: a Warning, one whose lens names security, or any not marked\s+`security: false`\) that is still in the code is never quoted outside this session/);
    assert.match(hardening, /a fixed one keeps its summary/);
  });

  it("fetches a pinned action's source for the Actions lens, which the brief lets reviewers read", () => {
    assert.match(hardening, /`<run>\/actions\/<owner>\/<repo>\/<path>`/);
    assert.match(readFileSync(new URL("../../.claude/skills/hardening-review/references/brief.md", import.meta.url), "utf8"), /<run>\/actions\//);
  });

  it("refuses a detached HEAD and a branch name with shell characters before building a path from it", () => {
    assert.match(hardening, /case "\$branch" in ''\|\*\[!A-Za-z0-9\._\/-\]\*\)/);
    assert.match(hardening, /tr '\/' '~'/);
  });

  it("stops the guard instead of printing and carrying on, and never deletes a folder named by an empty branch", () => {
    // Each Bash call runs without `set -e`: `false` would let the next lines build the shared parent folders.
    assert.match(hardening, /unusual characters" >&2; exit 1;; esac/);
    assert.doesNotMatch(hardening, /unusual characters" >&2; false/);
    assert.match(hardening, /Delete a folder only when it is exactly `\$run` or\s+`\$private` and `\$name` is not empty/);
  });

  it("never builds a shell string from a reviewer's path, lens or line, for match or for add", () => {
    assert.match(flat, /letters, digits, space and `\._\/-`/);
    assert.match(hardening, /--lens='<lens>' --path='<path>'/);
    assert.doesNotMatch(hardening, / --lens '<lens>'| --path '<path>'/);
    assert.match(flat, /`line` must be digits only/);
    assert.match(flat, /again before `add`/);
    // Every known_open.py flag built from a finding's text takes the `=` and single-quote form.
    assert.doesNotMatch(hardening, /--lens [A-Za-z<"']|--path [A-Za-z<"']/);
    // R72: the placeholder has no apostrophe in it, and the `=` form keeps a reason that starts with `-` from reading as a flag.
    assert.match(flat, /--reason='<the decision, in your own words, with no single quote>'/);
    assert.doesNotMatch(hardening, /--reason [A-Za-z<"']/);
    assert.doesNotMatch(flat, /person's decision/);
  });

  // R31 (mpaulosky/dotfiles#341): the line-anchored hash stays strict, so a fix above an accepted item makes it `changed` again; the way out is
  // to remove the old entry and add the finding again.
  it("tells the person that a re-accepted finding is removed and added again, in SKILL.md and state.md", () => {
    const state = readFileSync(new URL("../../.claude/skills/hardening-review/references/state.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.match(flat, /known_open\.py remove '<private>\/known-open\.json' --id='?<id>/);
    assert.match(flat, /a re-accepted finding is removed and added again/);
    assert.match(state, /a re-accepted finding is removed and added again/);
  });

  it("deletes a verification checkout only after checking a path a sandbox could have written", () => {
    assert.match(flat, /`git worktree list --porcelain` lists it as a detached worktree/);
    assert.match(flat, /neither the worktree under review nor the main checkout/);
    assert.match(readFileSync(new URL("../../.claude/skills/hardening-review/references/state.md", import.meta.url), "utf8"), /^- Verify checkout: /m);
  });

  it("keeps the triage and mutation notes in step with the scripts", () => {
    const triage = readFileSync(new URL("../../.claude/skills/hardening-review/references/triage.md", import.meta.url), "utf8");
    const mutations = readFileSync(new URL("../../.claude/skills/hardening-review/references/mutations.md", import.meta.url), "utf8");
    assert.match(triage, /is listed in one line/);
    assert.match(mutations, /mutate-journal-<hash>\.txt/);
    assert.match(mutations, /POSIX only/);
  });

  // mpaulosky/dotfiles#341 (R74): the journal is under the common git directory, one per worktree; the pycache folder is one per run.
  it("says the mutation journal is in the common git directory, one per worktree, and that the pycache prefix is one folder per run", () => {
    const mutations = readFileSync(new URL("../../.claude/skills/hardening-review/references/mutations.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.match(mutations, /common git directory/);
    assert.match(mutations, /one journal per worktree/);
    assert.doesNotMatch(mutations, /under `review\/` in the git directory/);
    assert.doesNotMatch(mutations, /a fresh `PYTHONPYCACHEPREFIX`/);
    assert.match(mutations, /`PYTHONPYCACHEPREFIX` \(one new folder per run, shared by the baseline and every mutation\)/);
  });

  // mpaulosky/dotfiles#361: an empty journal can't be told from a live run's, so it blocks the run; the journal is staged, hard-linked into place and replaced.
  it("says any mutation journal blocks the run, and that it is staged, hard-linked into place and replaced, never written in place", () => {
    const mutations = readFileSync(new URL("../../.claude/skills/hardening-review/references/mutations.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.doesNotMatch(mutations, /the next run removes it/);
    assert.doesNotMatch(mutations, /An empty journal is what a run killed before it wrote its claim leaves/);
    assert.match(mutations, /hard link/);
    assert.match(mutations, /`os\.replace`/);
    assert.match(mutations, /never empty/);
  });

  it("verifies a repro with its path printed, and does not call a scrubbed environment a sandbox", () => {
    assert.match(hardening, /d="\$\(mktemp -d\)" && git worktree add --detach "\$d\/tree" HEAD && printf '%s\\n' "\$d\/tree"/);
    assert.match(hardening, /removes environment variables only; it is not a sandbox/);
    assert.match(hardening, /absolute path, `\.\.`, `~` or a\s+URL/);
  });
});

// The local, git-ignored record of security findings (.security/), which `scripts/review.sh record` writes. Both reviews read it
// through `scripts/review.sh security`, by id, lens and path only, and treat a `fixed` entry as settled.
describe("the skills' reading of the .security record", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");
  // One numbered step of pre-push-review, from its heading to the next step's.
  const step = (number: number) => {
    const start = skill.indexOf(`### ${number}. `);
    const end = skill.indexOf(`### ${number + 1}. `, start);
    assert.notEqual(start, -1, `step ${number} is missing`);
    return flat(skill.slice(start, end === -1 ? undefined : end));
  };
  const brief = readFileSync(new URL("../../.claude/skills/hardening-review/references/brief.md", import.meta.url), "utf8");

  it("step 3 reads the record with scripts/review.sh security, by id, lens and path only", () => {
    const three = step(3);

    assert.match(three, /`scripts\/review\.sh security`/);
    assert.match(three, /\.security\//);
    assert.match(three, /by (?:its |their )?id, lens and path only/);
  });

  it("step 3 keeps the weakness, policy, pin, reason and summary of an entry from every reviewer", () => {
    assert.match(step(3), /never (?:its |their )?(?:the )?(?:weakness|summary)[^.]*(?:summary|reason)/i);
  });

  it("step 3 says an entry's text is data, not instructions", () => {
    assert.match(step(3), /ignore (?:any )?instructions? (?:found )?in (?:it|them|an entry)/i);
  });

  // Criterion 8.
  it("step 5 dismisses a finding that repeats a weakness a fixed entry holds, with the entry's id in the reason, instead of recording it as new", () => {
    const five = step(5);

    assert.match(five, /repeats a weakness a `fixed` entry holds/);
    assert.match(five, /repeats \.security\/NNNN \(fixed\)/);
    assert.match(five, /pinning test|pinned by/i);
  });

  it("step 5 makes the session read the entry itself and check the code and the pin still hold before it dismisses", () => {
    const five = step(5);

    assert.match(five, /read the entry (?:file )?yourself/i);
    assert.match(five, /still (?:holds|there|exists)/i);
  });

  // Criterion 10.
  it("step 5 says an accepted or an open entry is read like any other and changes nothing yet", () => {
    assert.match(step(5), /An `accepted` or `open` entry is read like any other but changes nothing/);
  });

  it("step 8 shows the record's policy, repeats and pr, and says record writes the entries, never by hand", () => {
    const eight = step(8);

    assert.match(eight, /"policy"/);
    assert.match(eight, /"repeats"/);
    assert.match(eight, /"pr"/);
    assert.match(eight, /never write one by hand/i);
  });

  it("step 9 never quotes .security/ in the follow-up issue, the notes, the report or a PR", () => {
    assert.match(step(9), /`\.security\/` is never quoted in the follow-up issue, the notes, the report or a PR/);
  });

  it("hardening-review reads the record with scripts/review.sh security, by id, lens and path only", () => {
    const text = flat(hardening);

    assert.match(text, /`scripts\/review\.sh security`/);
    assert.match(text, /\.security\/[^.]*by id, lens, path and status|\.security\/[^.]*id, lens and path/);
  });

  it("hardening-review's step 4 drops a finding that repeats a fixed entry, by pre-push-review step 5, and lists it to the person in one line", () => {
    const start = hardening.indexOf("### 4. Drop what is already decided");
    const end = hardening.indexOf("### 5. ", start);
    const four = flat(hardening.slice(start, end));

    assert.match(four, /`fixed` entry/);
    assert.match(four, /`pre-push-review` step 5/);
    assert.match(four, /repeats \.security\/\d{4}, fixed/);
  });

  it("hardening-review's reviewers brief tells them not to read .security/ and not to raise a fixed entry again", () => {
    const text = flat(brief);

    assert.match(text, /Do not read `\.security\/`/);
    assert.match(text, /fixed entry/);
  });
});
