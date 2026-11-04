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

// The sandbox's PID 1. `sleep infinity` never waits for a child, so every process the gate orphans stays a zombie holding its PID
// (the build of issue #433 in mpaulosky/dotfiles counted 4,937 processes before its first checkpoint and 17,386 after the second,
// then could no longer fork). An init as PID 1 reaps them. Sandcastle's docker() takes no `--init`, so it is the image's entrypoint.
describe("the sandbox image's PID 1", () => {
  for (const path of [".sandcastle/Dockerfile", "Support For New Projects/.claude/skills/repo-ci-baseline/template/seed/.sandcastle/Dockerfile"]) {
    it(`reaps orphaned processes in ${path}: tini is installed and runs sleep`, () => {
      const dockerfile = read(path);
      const entrypoints = [...dockerfile.matchAll(/^ENTRYPOINT (.*)$/gm)].map((match) => match[1]);

      assert.deepEqual(entrypoints, ['["tini", "--", "sleep", "infinity"]']);
      // The first install list, which runs to the `&& rm -rf` that ends its layer: a later list holding tini would not do.
      const fromFirst = dockerfile.slice(dockerfile.indexOf("apt-get install -y"));
      const list = fromFirst.slice(0, fromFirst.indexOf("&& rm -rf"));
      assert.match(list, /^ {2}tini( \\)?$/m, "tini is not in the first apt-get install list");
    });
  }
});
