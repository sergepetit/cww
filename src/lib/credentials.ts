// ~/.cww/credentials — the developer's git tokens, one entry per host or per
// repo, in git's own ~/.git-credentials line format:
//
//   https://<user>:<token>@<host>[:<port>][/<org>[/<repo>]]
//
// Written by 'cww init', read by 'cww create', which injects only the single
// best-matching entry (same origin, longest path prefix) into the workspace
// it creates — a container never sees another repo's token. The file lives
// outside every repo so a secret can't ride a commit, mode 600 like git's
// own store. Full-line # comments and unparseable lines are skipped.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Credential {
  user: string;
  token: string;
  // scheme://host[:port][/path], no userinfo — what lookups match against.
  url: string;
}

// Origin + path in canonical form for matching: URL lowercases scheme/host
// and drops default ports; trailing slashes and a trailing .git are stripped
// so "…/repo", "…/repo.git" and "…/repo/" all mean the same repo. Null for
// unparseable input.
function splitUrl(url: string): { origin: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return { origin: u.origin, path: u.pathname.replace(/\/+$/, "").replace(/\.git$/, "") };
}

export function parseCredentials(text: string): Credential[] {
  const out: Credential[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      continue;
    }
    if (!u.password) continue;
    out.push({
      user: decodeURIComponent(u.username),
      token: decodeURIComponent(u.password),
      url: u.origin + u.pathname.replace(/\/+$/, ""),
    });
  }
  return out;
}

export function formatCredentials(entries: Credential[]): string {
  const lines = entries.map((e) => {
    // URL's userinfo setters percent-encode; parseCredentials decodes back.
    const u = new URL(e.url);
    u.username = e.user;
    u.password = e.token;
    return u.toString();
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

// The entry applying to repoUrl: same origin, and the entry's path is empty
// (host-wide) or a path-boundary prefix of the repo's. The most specific
// (longest) path wins, so a per-repo entry beats a host-wide one.
export function matchCredential(entries: Credential[], repoUrl: string): Credential | null {
  const target = splitUrl(repoUrl);
  if (!target) return null;
  let best: Credential | null = null;
  let bestLen = -1;
  for (const entry of entries) {
    const s = splitUrl(entry.url);
    if (!s || s.origin !== target.origin) continue;
    if (s.path && target.path !== s.path && !target.path.startsWith(`${s.path}/`)) continue;
    if (s.path.length > bestLen) {
      best = entry;
      bestLen = s.path.length;
    }
  }
  return best;
}

// Replace the entry for the same normalized URL, or append a new one.
export function upsertCredential(entries: Credential[], entry: Credential): Credential[] {
  const key = (url: string) => {
    const s = splitUrl(url);
    return s ? s.origin + s.path : url;
  };
  const k = key(entry.url);
  return [...entries.filter((e) => key(e.url) !== k), entry];
}

export function credentialsFile(): string {
  return path.join(os.homedir(), ".cww", "credentials");
}

export function loadCredentials(file = credentialsFile()): Credential[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseCredentials(text);
}

export function saveCredentials(entries: Credential[], file = credentialsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, formatCredentials(entries), { mode: 0o600 });
  // writeFileSync's mode only applies when creating the file.
  fs.chmodSync(file, 0o600);
}
