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
// each with the name secretKindIn reports it by.
const tokenShapes = [
  { shape: "sk-ant-", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { shape: "gh*_", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { shape: "github_pat_", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
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

// containsSecret with the values .sandcastle/.env gives the sandbox.
export function containsSandboxSecret(text: string): boolean {
  return containsSecret(text, sandboxSecrets().values());
}

// What kind of thing a match is: one of the sandbox's secret values, naming
// the .sandcastle/.env key it came from, or a token shape. Never carries the
// matched text itself, so a caller can log or report a SecretKind without
// ever touching the secret (#324).
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
