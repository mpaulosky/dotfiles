import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// The Template's gate.sh, whose linter versions dotfiles' own gate (test.sh)
// lints the Template with.
const TEMPLATE_GATE = "Support For New Projects/.claude/skills/repo-ci-baseline/template/owned/scripts/gate.sh";
// dotfiles' CI, which pins the Python and Node tools test.sh runs.
const CI = ".github/workflows/repo-ci-baseline.yml";

// The value of `NAME=value` at the start of a line, as gate.sh sets a variable
// and the Dockerfile sets an ARG, or of `NAME: value` in a workflow's env, with
// any quotes removed.
function setting(text: string, name: string): string | undefined {
  return new RegExp(`^\\s*(?:ARG )?${name}(?:=|: )"?([^"\\s]+)"?`, "m").exec(text)?.[1];
}

describe("the sandbox image's linters", () => {
  // test.sh runs each linter from PATH, so the image's copy must be the
  // version the Template's gate and dotfiles' CI pin.
  for (const [name, source] of [
    ["ACTIONLINT_VERSION", TEMPLATE_GATE],
    ["SHELLCHECK_VERSION", TEMPLATE_GATE],
    ["ZIZMOR_VERSION", TEMPLATE_GATE],
    ["YAMLLINT_VERSION", CI],
    ["CMARKGFM_VERSION", CI],
    ["MARKDOWNLINT_CLI2_VERSION", CI],
  ] as const) {
    it(`installs the ${name} ${source} pins`, () => {
      const pinned = setting(read(source), name);

      assert.ok(pinned, `${source} doesn't set ${name}`);
      assert.equal(
        setting(read(".sandcastle/Dockerfile"), name),
        pinned,
        `Set ${name} in .sandcastle/Dockerfile to ${pinned}, and its SHA-256s to that release's`,
      );
    });
  }
});
