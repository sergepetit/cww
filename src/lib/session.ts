// Typed session.json read/write and workspace resolution — replaces the jq
// pipelines of the old scripts/lib/common.sh.

import fs from "node:fs";
import path from "node:path";
import { getTasksRoot } from "./naming";
import { getGitRoot } from "./git";

export interface Session {
  project?: string;
  workspace?: string;
  branch?: string;
  agent?: string;
  auth?: string; // the auth method id the workspace was created with
  container?: string;
  created?: string;
  mainRepo?: string;
  [key: string]: unknown;
}

// Read a task dir's session.json; {} when the file doesn't exist. A corrupt
// file throws — same hard failure the bash lib had under set -e.
export function readSession(taskDir: string): Session {
  return readSessionFile(path.join(taskDir, "session.json"));
}

export function readSessionFile(sessionFile: string): Session {
  if (!fs.existsSync(sessionFile)) return {};
  return JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Session;
}

export function writeSession(taskDir: string, session: Session): void {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
}

// All session.json paths under the tasks root, sorted for stable output.
export function findAllSessions(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(getTasksRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(getTasksRoot(), entry.name, "session.json");
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }
  return files.sort();
}

function readSessionFileSafe(sessionFile: string): Session {
  try {
    return readSessionFile(sessionFile);
  } catch {
    return {};
  }
}

export interface WorkspaceRef {
  taskDir: string;
  session: Session;
  workspace: string;
  container: string;
}

// Resolve a workspace to its task dir and key session fields, with the same
// fallbacks the bash scripts applied: workspace falls back to the branch (for
// pre-rename sessions), container to "".
export async function resolveWorkspace(name?: string): Promise<WorkspaceRef | null> {
  const file = await resolveSessionFile(name);
  if (!file) return null;
  const session = readSessionFileSafe(file);
  return {
    taskDir: path.dirname(file),
    session,
    workspace: session.workspace ?? session.branch ?? "",
    container: session.container ?? "",
  };
}

// Resolve a session.json path either by workspace name or, with no name,
// by auto-detecting the single workspace belonging to the current git repo.
// Returns null on no-match or an ambiguous cwd (multiple workspaces for the
// same repo).
export async function resolveSessionFile(workspace?: string): Promise<string | null> {
  const files = findAllSessions();

  if (workspace) {
    return files.find((f) => readSessionFileSafe(f).workspace === workspace) ?? null;
  }

  // No workspace given: match tasks whose mainRepo is the current git root.
  const root = await getGitRoot(process.cwd());
  if (!root) return null;
  const matches = files.filter((f) => readSessionFileSafe(f).mainRepo === root);
  return matches.length === 1 ? matches[0]! : null;
}
