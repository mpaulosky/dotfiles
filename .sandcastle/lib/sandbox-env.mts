// Sandcastle passes every key in .sandcastle/.env into the sandbox, taking the
// value from the host's environment when the file leaves it blank. So a
// GH_TOKEN line there, even an empty one, hands the host's GitHub token to the
// agents. The host refuses to start while one is present.
//
// The keys that are there (the Claude token or API key) reach the sandbox, so
// an agent could commit one. The host scans what a push would publish for them
// first (see lib/scan.mts).

import { existsSync, readFileSync } from "node:fs";

export const ENV_FILE = ".sandcastle/.env";

const githubTokens = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

// GitHub token keys the env file content defines, in file order.
export function githubTokensIn(envFile: string): string[] {
  const found: string[] = [];
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    if (githubTokens.has(key)) found.push(key);
  }
  return found;
}

// The keys the env file content defines, with the value the sandbox gets: the
// file's, or the host environment's when the file's is blank.
export function sandboxEnv(envFile: string, hostEnv: Record<string, string | undefined>): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    const value = trimmed.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    const effective = value || hostEnv[key] || "";
    if (effective) values.set(key, effective);
  }
  return values;
}

// Token shapes worth catching even when they didn't come from the env file,
// each with the name secretKindIn reports it by. `loose` is the same shape without its word
// boundaries, for text taken apart and joined again (see containsTokenShapeAnywhere); a test
// holds it to `pattern` minus its boundaries, so a shape added here can't miss one.
export const tokenShapes = [
  { shape: "sk-ant-", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/, loose: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { shape: "gh*_", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, loose: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { shape: "github_pat_", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, loose: /github_pat_[A-Za-z0-9_]{20,}/ },
] as const;

// Shorter values are too likely to be ordinary words to look for.
const minimumSecretLength = 8;

// Whether the text holds one of the secret values, or anything shaped like a
// Claude or GitHub token.
export function containsSecret(text: string, secrets: Iterable<string>): boolean {
  for (const secret of secrets) {
    if (secret.length >= minimumSecretLength && text.includes(secret)) return true;
  }
  return tokenShapes.some(({ pattern }) => pattern.test(text));
}

// Whether the text holds anything shaped like a token, ignoring where a word starts or ends. The shapes
// begin and end at a word boundary, which text taken apart and joined again (a token wrapped across lines, then
// squeezed together with the words around it) no longer has: a `ghp_` token followed by `session_id` is one run
// of word characters.
export function containsTokenShapeAnywhere(text: string): boolean {
  return tokenShapes.some(({ loose }) => loose.test(text));
}

// The forms an agent could print `secret` in beyond the plain value: reversed, hex, URL-encoded, and base64 (standard and
// URL-safe, without padding) at each of the three byte alignments it can take inside a longer encoded text, keeping only
// the characters the secret alone decides. The sandbox's secrets are values the host knows, so they can be looked for in
// these forms, which a pattern can't do.
function secretForms(secret: string): string[] {
  const forms = new Set<string>([[...secret].reverse().join("")]);
  const bytes = Buffer.from(secret, "utf8");
  forms.add(bytes.toString("hex"));
  forms.add(bytes.toString("hex").toUpperCase());
  const urlEncoded = encodeURIComponent(secret);
  if (urlEncoded !== secret) forms.add(urlEncoded);
  for (const lead of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(lead, 0x78), bytes]);
    const encoded = padded.toString("base64");
    const form = encoded.slice([0, 2, 3][lead]!, encoded.length - [0, 3, 2][padded.length % 3]!);
    if (form !== "") {
      forms.add(form);
      forms.add(form.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return [...forms];
}

// Whether the text holds one of the secret values in a form secretForms lists (not the plain value, which containsSecret looks for).
export function containsEncodedSecret(text: string, secrets: Iterable<string>): boolean {
  for (const secret of secrets) {
    if (secret.length < minimumSecretLength) continue;
    if (secretForms(secret).some((form) => text.includes(form))) return true;
  }
  return false;
}

// containsSecret with the values .sandcastle/.env gives the sandbox.
export function containsSandboxSecret(text: string): boolean {
  return containsSecret(text, sandboxSecrets().values());
}

// containsSandboxSecret, and the sandbox's secret values in the other forms secretForms lists.
export function containsSandboxSecretInAnyForm(text: string): boolean {
  return containsSandboxSecret(text) || containsEncodedSecret(text, sandboxSecrets().values());
}

// What kind of thing a match is: one of the sandbox's secret values, naming
// the .sandcastle/.env key it came from, or a token shape. Never carries the
// matched text itself, so a caller can log or report a SecretKind without
// ever touching the secret.
export type SecretKind =
  | { readonly type: "secret"; readonly envKey: string }
  | { readonly type: "pattern"; readonly shape: (typeof tokenShapes)[number]["shape"] };

// secretKindIn mirrors containsSecret's rules (a value shorter than
// minimumSecretLength is too likely to be an ordinary word to look for), but
// names which `secrets` key or which token shape matched instead of a
// yes/no, so lib/scan.mts can report where a push was stopped without ever
// handling the matched text.
export function secretKindIn(text: string, secrets: ReadonlyMap<string, string>): SecretKind | undefined {
  for (const [envKey, secret] of secrets) {
    if (secret.length >= minimumSecretLength && text.includes(secret)) return { type: "secret", envKey };
  }
  const token = tokenShapes.find(({ pattern }) => pattern.test(text));
  return token === undefined ? undefined : { type: "pattern", shape: token.shape };
}

// The values .sandcastle/.env gives the sandbox, keyed by the key each came
// from, for containsSandboxSecret and lib/scan.mts#firstSecretMatch.
export function sandboxSecrets(): Map<string, string> {
  const envFile = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  return sandboxEnv(envFile, process.env);
}
