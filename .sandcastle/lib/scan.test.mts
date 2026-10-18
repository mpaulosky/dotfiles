import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { additions, describeSecretMatch, firstSecretMatch } from "./scan.mts";
import { hostGitInvocation, runHostGit } from "./shell.mts";

describe("additions", () => {
  const addedLines = (patch: string) => [...additions(patch)].map(({ text }) => text);

  it("keeps the lines a commit adds, without file headers or removed lines", () => {
    const patch = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new"].join("\n");

    assert.deepEqual(addedLines(patch), ["new"]);
  });

  it("keeps the lines a merge's combined diff adds in either column", () => {
    const patch = ["diff --cc x", "--- a/x", "+++ b/x", "@@@ -1,1 -1,1 +1,1 @@@", "++both", "+ first", " +second", "- gone"].join("\n");

    assert.deepEqual(addedLines(patch), ["both", "first", "second"]);
  });

  it("keeps an added line whose content looks like a file header", () => {
    const patch = ["diff --git a/x.patch b/x.patch", "--- /dev/null", "+++ b/x.patch", "@@ -0,0 +1,2 @@", "+++ token", "+--- a/y"].join("\n");

    assert.deepEqual(addedLines(patch), ["++ token", "--- a/y"]);
  });

  it("keeps a merge's added line whose content starts with \"+ \"", () => {
    const patch = ["diff --cc x", "+++ b/x", "@@@ -1,1 -1,1 +1,1 @@@", "+++ token"].join("\n");

    assert.deepEqual(addedLines(patch), ["+ token"]);
  });

  it("reads each file's hunks, and ignores what's between them", () => {
    const patch = [
      "diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b",
      "\\ No newline at end of file",
      "diff --git a/y b/y", "new file mode 100644", "--- /dev/null", "+++ b/y", "@@ -0,0 +1 @@", "+c",
    ].join("\n");

    assert.deepEqual(addedLines(patch), ["b", "c"]);
  });
});

// A repository with a `base` commit and one commit on top (`leak`), whose
// author, committer, message and added file a test can set, so a match
// sits in exactly one field.
function buildRepo({
  authorName = "author",
  authorEmail = "author@x",
  committerName = "committer",
  committerEmail = "committer@x",
  message = "plain commit",
  fileName = "notes.txt",
  fileContent = "plain line\n",
}: {
  authorName?: string;
  authorEmail?: string;
  committerName?: string;
  committerEmail?: string;
  message?: string;
  fileName?: string;
  fileContent?: string;
} = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-scan-")));
  const raw = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: committerName,
        GIT_COMMITTER_EMAIL: committerEmail,
      },
    }).trim();
  raw("init", "--quiet");
  raw("commit", "--quiet", "--allow-empty", "-m", "base");
  const base = raw("rev-parse", "HEAD");
  writeFileSync(join(repo, fileName), fileContent);
  raw("add", ".");
  raw("commit", "--quiet", "-m", message);
  const leak = raw("rev-parse", "HEAD");
  const hostGit = (...args: string[]) => runHostGit(repo, hostGitInvocation(repo, join(repo, ".git"), args));
  return { repo, raw, base, leak, hostGit };
}

describe("firstSecretMatch", () => {
  it("reports no match for a clean range", () => {
    const { repo, base, leak, hostGit } = buildRepo();
    try {
      assert.equal(firstSecretMatch(base, leak, new Map([["ANTHROPIC_API_KEY", "unrelated-secret-value"]]), hostGit), undefined);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the commit, file path, line number and pattern kind for an added line shaped like a token", () => {
    // Built at run time, so this test file isn't itself flagged as a leak.
    const githubShaped = `${"gh"}p_${"A".repeat(36)}`;
    const { repo, base, leak, hostGit } = buildRepo({ fileContent: `harmless line\n${githubShaped}\n` });
    try {
      const match = firstSecretMatch(base, leak, new Map(), hostGit);

      assert.deepEqual(match, {
        location: { commit: leak, field: "line", path: "notes.txt", line: 2 },
        kind: { type: "pattern", shape: "gh*_" },
      });
      // Never the matched text itself (#324).
      assert.ok(!JSON.stringify(match).includes(githubShaped));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the commit, the message field and the env key for a sandbox secret in the commit message", () => {
    const secretValue = "fake-secret-message-value";
    const { repo, base, leak, hostGit } = buildRepo({ message: `uses ${secretValue} to connect` });
    try {
      const match = firstSecretMatch(base, leak, new Map([["ANTHROPIC_API_KEY", secretValue]]), hostGit);

      assert.deepEqual(match, { location: { commit: leak, field: "message" }, kind: { type: "secret", envKey: "ANTHROPIC_API_KEY" } });
      // Never the matched text itself (#324).
      assert.ok(!JSON.stringify(match).includes(secretValue));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  for (const field of ["author", "committer"] as const) {
    it(`reports the commit, the ${field} field and the env key for a sandbox secret in the commit's ${field}`, () => {
      const secretValue = `fake-secret-${field}-value`;
      const { repo, base, leak, hostGit } = buildRepo(field === "author" ? { authorName: secretValue } : { committerName: secretValue });
      try {
        const match = firstSecretMatch(base, leak, new Map([["GH_TOKEN", secretValue]]), hostGit);

        assert.deepEqual(match, { location: { commit: leak, field }, kind: { type: "secret", envKey: "GH_TOKEN" } });
        // Never the matched text itself (#324).
        assert.ok(!JSON.stringify(match).includes(secretValue));
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  it("reports the commit and the path field, without naming the path, for a sandbox secret in a path", () => {
    const secretValue = "fake-secret-path-value";
    const { repo, base, leak, hostGit } = buildRepo({ fileName: `${secretValue}.txt` });
    try {
      const match = firstSecretMatch(base, leak, new Map([["ANTHROPIC_API_KEY", secretValue]]), hostGit);

      assert.deepEqual(match, { location: { commit: leak, field: "path" }, kind: { type: "secret", envKey: "ANTHROPIC_API_KEY" } });
      // Never the matched text itself (#324).
      assert.ok(!JSON.stringify(match).includes(secretValue));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  for (const fileName of ["my notes.txt", "café.txt", 'say "hi".txt']) {
    it(`reports the path of an added line as git stores it, for ${fileName}`, () => {
      const githubShaped = `${"gh"}p_${"A".repeat(36)}`;
      const { repo, base, leak, hostGit } = buildRepo({ fileName, fileContent: `${githubShaped}\n` });
      try {
        assert.deepEqual(firstSecretMatch(base, leak, new Map(), hostGit)?.location, { commit: leak, field: "line", path: fileName, line: 1 });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  it("reports the line number in the new file, counting the lines around the hunk", () => {
    const githubShaped = `${"gh"}p_${"A".repeat(36)}`;
    const { repo, raw, base, hostGit } = buildRepo({ fileContent: "one\ntwo\nthree\nfour\n" });
    try {
      writeFileSync(join(repo, "notes.txt"), `one\ntwo\nthree changed\n${githubShaped}\nfour\n`);
      raw("commit", "--quiet", "-am", "second");
      const second = raw("rev-parse", "HEAD");

      assert.deepEqual(firstSecretMatch(base, second, new Map(), hostGit)?.location, { commit: second, field: "line", path: "notes.txt", line: 4 });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("finds the match in the commit git push sends, whatever a planted replace ref says", () => {
    const secretValue = "fake-secret-message-value";
    const { repo, raw, base, leak, hostGit } = buildRepo({ message: `uses ${secretValue}` });
    try {
      // What an agent could plant: show a clean commit in place of the leak.
      raw("replace", leak, raw("commit-tree", `${base}^{tree}`, "-p", base, "-m", "clean"));
      // The control: git log follows the replacement by default.
      assert.ok(!raw("log", "--format=%B", "-1", leak).includes(secretValue));

      assert.equal(firstSecretMatch(base, leak, new Map([["ANTHROPIC_API_KEY", secretValue]]), hostGit)?.location.field, "message");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("finds the match in the commit's real parents, whatever a planted grafts file says", () => {
    const secretValue = "fake-secret-message-value";
    const { repo, raw, base, leak, hostGit } = buildRepo({ message: `uses ${secretValue}` });
    try {
      // What an agent could plant: make the leak look like an ancestor of base,
      // which empties base..leak.
      writeFileSync(join(repo, ".git", "info", "grafts"), `${base} ${leak}\n`);
      // The control: git log honours the grafts file by default.
      assert.equal(raw("log", "--format=%H", `${base}..${leak}`), "");

      assert.equal(firstSecretMatch(base, leak, new Map([["ANTHROPIC_API_KEY", secretValue]]), hostGit)?.location.field, "message");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("describeSecretMatch", () => {
  const commit = "1".repeat(40);

  it("names an added line's path, line number and commit, and the token shape", () => {
    const text = describeSecretMatch({ location: { commit, field: "line", path: "src/x.ts", line: 3 }, kind: { type: "pattern", shape: "gh*_" } });

    assert.equal(text, `something shaped like a gh*_ token in line 3 of src/x.ts, added by commit ${commit}`);
  });

  it("names the env key a sandbox secret came from, and the field of the commit it sits in", () => {
    const text = describeSecretMatch({ location: { commit, field: "committer" }, kind: { type: "secret", envKey: "GH_TOKEN" } });

    assert.equal(text, `the sandbox's GH_TOKEN value in the committer of commit ${commit}`);
  });

  it("doesn't name a path that holds the match", () => {
    const text = describeSecretMatch({ location: { commit, field: "path" }, kind: { type: "secret", envKey: "GH_TOKEN" } });

    assert.equal(text, `the sandbox's GH_TOKEN value in a path commit ${commit} touches`);
  });

  // Criterion 3 of #324, end to end: what reaches the log and the run report,
  // for a fake token and a fake secret a commit really holds.
  it("holds no part of the matched text, for a fake token in a line or a fake secret in a message", () => {
    const githubShaped = `${"gh"}p_${"A".repeat(36)}`;
    const secretValue = "fake-secret-message-value";
    const { repo, base, leak, hostGit } = buildRepo({ message: `uses ${secretValue}`, fileContent: `${githubShaped}\n` });
    try {
      for (const [secrets, matched] of [
        [new Map<string, string>(), githubShaped],
        [new Map([["ANTHROPIC_API_KEY", secretValue]]), secretValue],
      ] as const) {
        const match = firstSecretMatch(base, leak, secrets, hostGit);
        assert.ok(match !== undefined);
        const text = describeSecretMatch(match);
        assert.ok(!text.includes(matched), text);
        // Nor its tail, the part a token shape's name doesn't already give away.
        assert.ok(!text.includes(matched.slice(-8)), text);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
