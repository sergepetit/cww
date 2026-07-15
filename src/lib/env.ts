// Minimal loader for the global ~/.cww/env (agent auth tokens, CWW_AGENT/
// CWW_BROWSER defaults — per-project settings live in ~/.cww/config.json),
// mirroring how the bash CLI `source`d it: KEY=VALUE lines with an optional
// `export ` prefix, full-line comments and blanks skipped, matching single or
// double quotes stripped. Values override the process env, like `source`
// does. This is NOT a shell — no interpolation, no command substitution —
// which the cww env file never needed.

import fs from "node:fs";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(LINE);
    if (!m) continue;
    let value = m[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

// Replace (or append) KEY's line in an env-file text, preserving every other
// line — comments, blanks, ordering — verbatim. The first matching line is
// rewritten in place (keeping an `export ` prefix); duplicate assignments of
// the same key are dropped. Used by 'cww auth' to upsert a token into
// ~/.cww/env without clobbering the user's hand-written file. The key must
// already be validated ([A-Za-z_][A-Za-z0-9_]*) — it is interpolated into a
// regex. The value is written raw (no quoting), like the file's own format.
export function upsertEnvLine(text: string, key: string, value: string): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const re = new RegExp(`^\\s*(export\\s+)?${key}=`);
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) {
      out.push(line);
      continue;
    }
    if (!replaced) {
      out.push(`${m[1] ?? ""}${key}=${value}`);
      replaced = true;
    }
  }
  if (!replaced) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

// Apply an env file to process.env (silently a no-op when the file is absent).
export function loadEnvFile(
  file: string,
  env: Record<string, string | undefined> = process.env,
): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  Object.assign(env, parseEnvFile(text));
}
