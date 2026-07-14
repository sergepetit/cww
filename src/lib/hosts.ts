// User-maintained hostname mappings for workspace containers. The container
// resolves names via Docker's DNS, which skips the host's /etc/hosts, mDNS
// and ssh aliases — so a git host or service that only resolves on the host
// must be mapped explicitly. Two files, one "hostname ip" per line:
//   ~/.cww/hosts              personal, machine-specific (all workspaces)
//   <repo>/.cww/hosts         per-project, rides the repo
// 'cww create' renders them into the container's /etc/hosts (extra_hosts),
// and the setup flow's container-side probe replays them the same way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HostEntry {
  host: string;
  ip: string;
}

// Each non-comment line is "hostname ip"; anything else is skipped.
export function parseHostsEntries(text: string): HostEntry[] {
  const out: HostEntry[] = [];
  for (const line of text.split("\n")) {
    const [host, ip] = line.trim().split(/\s+/);
    if (!host || host.startsWith("#") || !ip) continue;
    out.push({ host, ip });
  }
  return out;
}

export function globalHostsFile(): string {
  return path.join(os.homedir(), ".cww", "hosts");
}

// All entries a workspace of this project gets: global file first, then the
// project's (matching the order generateHostsOverride always used).
export function hostsEntries(projectPath: string, globalFile = globalHostsFile()): HostEntry[] {
  const out: HostEntry[] = [];
  for (const f of [globalFile, path.join(projectPath, ".cww", "hosts")]) {
    if (!fs.existsSync(f)) continue;
    out.push(...parseHostsEntries(fs.readFileSync(f, "utf8")));
  }
  return out;
}

// Append a mapping to the personal hosts file (created with a header on
// first use). The committed <repo>/.cww/hosts is never written by cww.
export function appendGlobalHost(host: string, ip: string, file = globalHostsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = '# Hostname mappings for workspace containers ("hostname ip" per line),\n# rendered into each container\'s /etc/hosts at create time.\n';
  }
  const body = text.endsWith("\n") ? text : `${text}\n`;
  fs.writeFileSync(file, `${body}${host} ${ip}\n`);
}
