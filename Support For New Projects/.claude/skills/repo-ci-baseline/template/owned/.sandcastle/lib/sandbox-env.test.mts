import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containsSecret, containsTokenShapeAnywhere, githubTokensIn, sandboxEnv, secretKindIn } from "./sandbox-env.mts";

describe("githubTokensIn", () => {
  it("finds GitHub tokens the env file would pass into the sandbox", () => {
    const env = "CLAUDE_CODE_OAUTH_TOKEN=abc\nGH_TOKEN=\n export GITHUB_TOKEN = x\n";

    assert.deepEqual(githubTokensIn(env), ["GH_TOKEN", "GITHUB_TOKEN"]);
  });

  it("ignores comments", () => {
    const env = "# GH_TOKEN is no longer used\n#GITHUB_TOKEN=\nANTHROPIC_API_KEY=k";

    assert.deepEqual(githubTokensIn(env), []);
  });
});

describe("sandboxEnv", () => {
  it("takes each key's value from the file, or from the host when the file leaves it blank", () => {
    const env = sandboxEnv("# comment\nCLAUDE_CODE_OAUTH_TOKEN=\nANTHROPIC_API_KEY=\"from-file-1\"\nUNSET=\n", {
      CLAUDE_CODE_OAUTH_TOKEN: "from-host-1",
    });

    assert.deepEqual([...env], [
      ["CLAUDE_CODE_OAUTH_TOKEN", "from-host-1"],
      ["ANTHROPIC_API_KEY", "from-file-1"],
    ]);
  });
});

describe("containsSecret", () => {
  // Built at run time, so no scanner mistakes this file for a leak.
  const claudeShaped = ["sk", "ant", "x".repeat(24)].join("-");
  const githubShaped = `${"gh"}p_${"A".repeat(36)}`;

  it("finds a secret value the sandbox was given", () => {
    assert.ok(containsSecret("token: abcdefgh12345", ["abcdefgh12345"]));
  });

  it("ignores values too short to tell from ordinary words", () => {
    assert.ok(!containsSecret("a key", ["key"]));
  });

  it("finds Claude- and GitHub-shaped tokens that didn't come from the env file", () => {
    assert.ok(containsSecret(`x = "${claudeShaped}"`, []));
    assert.ok(containsSecret(`x = "${githubShaped}"`, []));
  });

  it("finds nothing in ordinary code", () => {
    assert.ok(!containsSecret("const answer = 42;\n", ["abcdefgh12345"]));
  });
});

describe("secretKindIn", () => {
  // Built at run time, so no scanner mistakes this file for a leak.
  const claudeShaped = ["sk", "ant", "x".repeat(24)].join("-");
  const githubShaped = `${"gh"}p_${"A".repeat(36)}`;
  const githubPatShaped = `${"github"}_pat_${"A".repeat(22)}`;

  it("names the .sandcastle/.env key a secret value came from", () => {
    const result = secretKindIn("token: abcdefgh12345", new Map([["ANTHROPIC_API_KEY", "abcdefgh12345"]]));

    assert.deepEqual(result, { type: "secret", envKey: "ANTHROPIC_API_KEY" });
    assert.ok(!JSON.stringify(result).includes("abcdefgh12345"));
  });

  it("ignores a value too short to tell from an ordinary word", () => {
    assert.equal(secretKindIn("a key", new Map([["ANTHROPIC_API_KEY", "key"]])), undefined);
  });

  for (const [shape, token] of [
    ["sk-ant-", claudeShaped],
    ["gh*_", githubShaped],
    ["github_pat_", githubPatShaped],
  ] as const) {
    it(`names the ${shape} shape for a token that didn't come from the env file`, () => {
      assert.deepEqual(secretKindIn(`x = "${token}"`, new Map()), { type: "pattern", shape });
    });
  }

  it("finds nothing in ordinary code", () => {
    assert.equal(secretKindIn("const answer = 42;\n", new Map([["ANTHROPIC_API_KEY", "abcdefgh12345"]])), undefined);
  });
});

describe("containsTokenShapeAnywhere", () => {
  const samples = [`ghp_${"A".repeat(20)}`, `github_pat_${"B".repeat(20)}`, `sk-ant-oat01-${"C".repeat(16)}`];

  it("finds each token shape that containsSecret finds", () => {
    for (const sample of samples) {
      assert.ok(containsSecret(sample, []), sample);
      assert.ok(containsTokenShapeAnywhere(sample), sample);
    }
  });

  it("finds a token shape joined to the word before it or the word after it, which the word-boundary shapes miss", () => {
    for (const sample of samples) {
      assert.ok(containsTokenShapeAnywhere(`the${sample}`), sample);
      assert.ok(containsTokenShapeAnywhere(`${sample}session_id`), sample);
    }
    assert.ok(!containsSecret(`the${samples[0]!}`, []));
    assert.ok(!containsSecret(`${samples[0]!}_session`, []));
  });

  it("leaves ordinary text and too-short tokens alone", () => {
    assert.ok(!containsTokenShapeAnywhere("nothing secret here, just words and ghp_short"));
    assert.ok(!containsTokenShapeAnywhere(`ghp_${"A".repeat(19)}`));
    assert.ok(!containsTokenShapeAnywhere(`sk-ant-${"A".repeat(15)}`));
  });
});
