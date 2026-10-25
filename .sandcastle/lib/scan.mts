// What a push of an issue branch would publish, for the secret scan: every
// commit's message, author and committer, the paths it touches, and every line
// it adds. Removed lines and context aren't scanned: each was added by an
// earlier commit, already on main or in this range, so scanning them would only
// stop branches for tokens main holds on purpose (a test's fake token).
//
// git runs with replace refs and grafts off (see hostGitInvocation), so the
// scan reads the same commits git push sends, whatever an agent planted.

import { secretKindIn, type SecretKind } from "./sandbox-env.mts";
import { git } from "./shell.mts";

type Addition = { readonly path: string; readonly line: number; readonly text: string };

// The added lines of `git log -p --cc -U0` output, each with the path of its
// file, read from the file's "+++" header, and its line number in the new
// file, counted from the hunk header's "+" range. A hunk starts at its "@@"
// header, which has one "@" more than the commit has parents being compared:
// "@@" for an ordinary commit, "@@@" for a merge of two. Each hunk line starts
// with one marker column per parent; a line in the result that some parent
// didn't have is marked "+" in that column, and a line marked "-" anywhere
// isn't in the result. A hunk ends at the first line that isn't a hunk line,
// such as the next file's "diff" header. Only hunk lines count, so a file
// header ("+++ b/path") is never taken for content, nor content for a header.
export function* additions(patch: string): Generator<Addition> {
  let columns = 0;
  let path = "";
  let line = 0;
  for (const row of patch.split("\n")) {
    const hunk = /^(@{2,}) /.exec(row);
    if (hunk) {
      columns = hunk[1]!.length - 1;
      line = Number(/ \+(\d+)(?:,\d+)? @/.exec(row)?.[1] ?? 0);
      continue;
    }
    if (columns === 0) {
      // git ends a "+++" name that holds a space with a tab.
      if (row.startsWith("+++ ")) path = headerPath(row.slice(4).replace(/\t$/, ""));
      continue;
    }
    const markers = row.slice(0, columns);
    if (markers.length < columns || /[^ +\-]/.test(markers)) {
      // "\ No newline at end of file" belongs to the hunk; anything else ends it.
      if (!row.startsWith("\\")) columns = 0;
      continue;
    }
    if (markers.includes("-")) continue;
    if (markers.includes("+")) yield { path, line, text: row.slice(columns) };
    line++;
  }
}

// The path a "+++" header names, without git's "b/" prefix (firstSecretMatch
// asks for it explicitly) and with git's C-style quoting undone: a name with
// a quote, backslash, control character or, by default, any non-ASCII byte
// comes quoted, the bytes as octal escapes.
function headerPath(name: string): string {
  const path = name.startsWith('"') && name.endsWith('"') ? unquoted(name.slice(1, -1)) : name;
  return path.startsWith("b/") ? path.slice(2) : path;
}

// The text between a quoted name's quotes, with its escapes undone.
function unquoted(quoted: string): string {
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes: number[] = [];
  const chars = [...quoted];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    const octal = chars.slice(i + 1, i + 4).join("");
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
    } else if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else {
      const escaped = chars[++i] ?? "";
      const code = escapes[escaped];
      bytes.push(...(code === undefined ? Buffer.from(escaped) : [code]));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Where in a commit a match sits: its author or committer identity, its
// message, a path it touches, or an added line (with the path and the line
// number in the new file). Never the matched text itself, so a match in
// a path doesn't name the path: the path holds the match. An added line's
// path is safe to name, since firstSecretMatch reads a commit's paths before
// its lines, and so stops at a path that holds a match first.
export type MatchLocation =
  | { readonly commit: string; readonly field: "author" | "committer" | "message" | "path" }
  | { readonly commit: string; readonly field: "line"; readonly path: string; readonly line: number };

// A match a push would publish: where it sits, and what kind of thing it is
// (lib/sandbox-env.mts#SecretKind). Carries nothing else, so logging or
// reporting it is safe even though the push it stopped isn't.
export type SecretMatch = { readonly location: MatchLocation; readonly kind: SecretKind };

// The first match the commits from `base` to `commit` publish hold against
// `secrets` (a sandbox value keyed by the .sandcastle/.env key it came from)
// or a token shape, checked commit by commit (oldest first, as a reviewer
// reading `git log -p base..commit` would see them), and within a commit in
// the order a reviewer would look: its author, its committer, its message,
// each path it touches, then each line it adds, top to bottom. Undefined
// when nothing matches. Never reads removed lines or context (see the top of
// this file). `mergedMain` is the main commit a build merged into the branch
// after `base`, when it did: its history is left out (`^<mergedMain>`), since
// it's main's work, already public, not the branch's. Without that, a token-
// shaped test fixture landing on main during a build stopped the publish and
// had the owner told to rotate a secret that never leaked. The merge
// commit itself is still read, and --cc shows only what it changed from both
// sides, so a secret written while resolving the merge is still caught.
export function firstSecretMatch(
  base: string,
  commit: string,
  secrets: ReadonlyMap<string, string>,
  run: (...args: string[]) => string = git,
  mergedMain?: string,
): SecretMatch | undefined {
  const exclude = mergedMain === undefined ? [] : [`^${mergedMain}`];
  for (const sha of run("rev-list", "--reverse", `${base}..${commit}`, ...exclude).split("\n").filter(Boolean)) {
    const [author = "", committer = "", message = ""] = run("log", "-1", "--format=%an <%ae>%x00%cn <%ce>%x00%B", sha).split("\0");
    for (const [field, text] of [["author", author], ["committer", committer], ["message", message]] as const) {
      const kind = secretKindIn(text, secrets);
      if (kind) return { location: { commit: sha, field }, kind };
    }
    // -z keeps each path as it is, where git would otherwise quote some.
    const paths = run("log", "-1", "--format=", "--name-only", "-z", "--cc", "--no-renames", sha);
    for (const path of paths.split("\0").filter(Boolean)) {
      const kind = secretKindIn(path, secrets);
      if (kind) return { location: { commit: sha, field: "path" }, kind };
    }
    // --cc reads a merge commit's diff too, so content written while resolving
    // a merge, or amended into one, is scanned; without it git log shows a
    // merge with no diff. The prefixes are explicit, so a diff.noprefix or
    // diff.mnemonicPrefix setting can't change the "+++ b/path" headers
    // additions() reads.
    const patch = run(
      "log", "-1", "--format=", "-p", "--cc", "-U0", "--no-ext-diff", "--no-textconv", "--text",
      "--src-prefix=a/", "--dst-prefix=b/", sha,
    );
    for (const { path, line, text } of additions(patch)) {
      const kind = secretKindIn(text, secrets);
      if (kind) return { location: { commit: sha, field: "line", path, line }, kind };
    }
  }
  return undefined;
}

// A SecretMatch in words for the run log and the run report, such as
// "something shaped like a gh*_ token in line 3 of src/x.ts, added by commit
// 1a2b…". It's built from the match's location and kind alone, so it never
// holds the matched text.
export function describeSecretMatch({ location, kind }: SecretMatch): string {
  const what = kind.type === "secret" ? `the sandbox's ${kind.envKey} value` : `something shaped like a ${kind.shape} token`;
  switch (location.field) {
    case "line":
      return `${what} in line ${location.line} of ${location.path}, added by commit ${location.commit}`;
    case "path":
      return `${what} in a path commit ${location.commit} touches`;
    default:
      return `${what} in the ${location.field} of commit ${location.commit}`;
  }
}
