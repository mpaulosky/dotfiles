import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containsEncodedSecret, containsSecret, containsTokenShapeAnywhere, githubTokensIn, sandboxEnv, secretKindIn, tokenShapes } from "./sandbox-env.mts";

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
    assert.ok(!containsTokenShapeAnywhere(`github_pat_${"A".repeat(19)}`));
    assert.ok(containsTokenShapeAnywhere(`github_pat_${"A".repeat(20)}`));
  });

  it("covers every prefix of the [pousr] class", () => {
    for (const kind of "pousr") assert.ok(containsTokenShapeAnywhere(`x${"gh"}${kind}_${"A".repeat(20)}`), kind);
    assert.ok(!containsTokenShapeAnywhere(`ghx_${"A".repeat(20)}`));
  });

  it("holds every shape's loose pattern to its own pattern minus the word boundaries, with the same flags", () => {
    for (const { shape, pattern, loose } of tokenShapes) {
      assert.equal(loose.source, pattern.source.replaceAll("\\b", ""), shape);
      assert.equal(loose.flags, pattern.flags, shape);
    }
  });
});

describe("containsEncodedSecret", () => {
  const secret = "s3cr3t-Value/with+chars=1234";
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const forms: Record<string, string> = {
    reversed: [...secret].reverse().join(""),
    hex: Buffer.from(secret).toString("hex"),
    "upper hex": Buffer.from(secret).toString("hex").toUpperCase(),
    "URL-encoded": encodeURIComponent(secret),
  };

  it("finds the secret reversed, in hex and URL-encoded", () => {
    for (const [name, form] of Object.entries(forms)) {
      assert.ok(containsEncodedSecret(`before ${form} after`, [secret]), name);
    }
  });

  it("finds the secret in base64 whatever bytes come before and after it, standard or URL-safe", () => {
    for (const before of ["", "a", "ab", "abc", "abcd", "token="]) {
      for (const after of ["", "x", "xy", "xyz", " and more"]) {
        const encoded = b64(`${before}${secret}${after}`);
        assert.ok(containsEncodedSecret(encoded, [secret]), `${before}|${after}`);
        assert.ok(containsEncodedSecret(encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""), [secret]), `url-safe ${before}|${after}`);
      }
    }
  });

  it("finds the URL-safe base64 form of a secret whose standard form holds + and /", () => {
    const odd = ">>>>>>>>???????????????>>>>>>>>";
    for (const before of ["", "a", "ab"]) {
      const standard = b64(`${before}${odd}`);
      assert.ok(/[+/]/.test(standard), standard);
      const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      assert.ok(containsEncodedSecret(urlSafe, [odd]), `url-safe ${before}`);
      assert.ok(containsEncodedSecret(standard, [odd]), `standard ${before}`);
    }
  });

  it("doesn't find the plain secret (containsSecret does), another secret, or a secret shorter than 8 characters", () => {
    assert.ok(!containsEncodedSecret(secret, [secret]));
    assert.ok(!containsEncodedSecret(b64("some other value entirely"), [secret]));
    assert.ok(!containsEncodedSecret(b64("short"), ["short"]));
    assert.ok(!containsEncodedSecret(b64("abcdefg"), ["abcdefg"]));
    assert.ok(containsEncodedSecret(b64("abcdefgh"), ["abcdefgh"]));
  });

  it("finds a base64 secret that is one character short of whole only when it is whole", () => {
    const whole = b64(secret);
    assert.ok(containsEncodedSecret(whole, [secret]));
    assert.ok(!containsEncodedSecret(whole.slice(2, -4), [secret]));
  });
});
