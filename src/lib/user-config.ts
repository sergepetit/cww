// ~/.cww/config.json — the developer's per-project settings, keyed by the
// project's absolute git-root path (realpath, so symlinked cwds resolve to
// one entry). Written by the repo setup flow (first 'cww create' / 'cww
// init'), hand-editable:
//
//   {
//     "projects": {
//       "/home/dev/work/api": {
//         "repoUrl": "http://forgejo.example:3000/org/api.git",
//         "remote": "origin",
//         "agent": "opencode",
//         "auth": "openai-api-key",
//         "browser": "off"
//       }
//     }
//   }
//
// repoUrl is always present — its entry doubles as the "this repo is set up"
// marker that 'cww create' checks before offering the setup flow. remote
// records which git remote the URL was captured for, so 'cww create
// --remote <same>' keeps using the (possibly hand-corrected) repoUrl instead
// of re-deriving. agent, auth, browser, skill, model, and subagentModel are
// optional per-project overrides of the ~/.cww/env globals (auth is the
// method id new workspaces authenticate with — 'cww create' records the
// interactive answer here; model, subagentModel, and providerBaseUrl are
// per-agent model settings, hand-edited).
// Secrets never live here: tokens go in ~/.cww/credentials and ~/.cww/env.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { die } from "./ui";

export interface ProjectConfig {
  repoUrl?: string;
  remote?: string;
  agent?: string;
  auth?: string; // auth method id for the project's agent (see agent-env-scoping-plan)
  browser?: string;
  skill?: string;
  model?: string; // agent session model (claude: over ANTHROPIC_MODEL; copilot: over COPILOT_MODEL)
  subagentModel?: string; // Claude subagent/workflow model, over CLAUDE_CODE_SUBAGENT_MODEL
  providerBaseUrl?: string; // Copilot BYOK endpoint, over COPILOT_PROVIDER_BASE_URL
  [key: string]: unknown; // unknown fields survive a read-modify-write
}

export interface UserConfig {
  projects: Record<string, ProjectConfig>;
  [key: string]: unknown;
}

// Pure parse (exported for tests): tolerate a missing "projects" map, reject
// non-object JSON.
export function parseUserConfig(text: string): UserConfig {
  const raw: unknown = JSON.parse(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("top level must be a JSON object");
  }
  const cfg = raw as UserConfig;
  if (cfg.projects === undefined) cfg.projects = {};
  if (cfg.projects === null || typeof cfg.projects !== "object" || Array.isArray(cfg.projects)) {
    throw new Error('"projects" must be an object');
  }
  return cfg;
}

export function userConfigFile(): string {
  return path.join(os.homedir(), ".cww", "config.json");
}

// Missing file -> empty config. A corrupt file dies with the path instead of
// being treated as empty — a later write would silently clobber it.
export function readUserConfig(file = userConfigFile()): UserConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { projects: {} };
  }
  try {
    return parseUserConfig(text);
  } catch (e) {
    die(`Corrupt ${file}: ${e instanceof Error ? e.message : String(e)} — fix or remove it.`);
  }
}

// The stable key for a project: the git root's realpath.
export function projectKey(gitRoot: string): string {
  try {
    return fs.realpathSync(gitRoot);
  } catch {
    return path.resolve(gitRoot);
  }
}

export function getProjectConfig(gitRoot: string, file = userConfigFile()): ProjectConfig | null {
  return readUserConfig(file).projects[projectKey(gitRoot)] ?? null;
}

// Merge entry over the project's existing one and write the whole config
// back, preserving every other project and any unknown fields.
export function setProjectConfig(
  gitRoot: string,
  entry: ProjectConfig,
  file = userConfigFile(),
): void {
  const cfg = readUserConfig(file);
  const key = projectKey(gitRoot);
  cfg.projects[key] = { ...cfg.projects[key], ...entry };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}
