// Shared bits between sub-commands.

import { findWorkspaceContainer } from "../lib/docker";
import { sanitizeName } from "../lib/naming";
import { resolveWorkspace, type WorkspaceRef } from "../lib/session";
import { error } from "../lib/ui";

// Resolve a workspace (by name, or auto-detected from the current repo) with
// the sub-commands' standard error reporting: print why, print the command's
// usage, exit 1. The wording varies slightly per command — override via opts.
export async function requireWorkspace(
  nameArg: string | undefined,
  usage: string,
  opts: { specifyMsg?: string; notFoundHint?: string } = {},
): Promise<WorkspaceRef> {
  const ws = await resolveWorkspace(nameArg);
  if (ws) return ws;
  if (!nameArg) {
    error(
      opts.specifyMsg ??
        "Could not determine the workspace from the current directory. Please specify a name.",
    );
  } else {
    error(`No workspace found: ${nameArg}`);
    if (opts.notFoundHint) console.error(opts.notFoundHint);
  }
  console.log(usage);
  process.exit(1);
}

// Looser resolution for attach/shell: the recorded session first; with a name
// but no session, fall back to matching a container by name pattern (the
// container may outlive its metadata). taskDir is null on that fallback path.
export async function resolveContainerLoosely(
  name: string | undefined,
  usage: string,
): Promise<{ workspace: string; container: string; taskDir: string | null }> {
  const ws = await resolveWorkspace(name);
  if (ws) return { workspace: ws.workspace, container: ws.container, taskDir: ws.taskDir };

  const container = name ? await findWorkspaceContainer(sanitizeName(name)) : null;
  if (container) return { workspace: name!, container, taskDir: null };

  if (!name) {
    error("Could not determine the workspace from the current directory. Please specify a name.");
  } else {
    error(`No workspace found: ${name}`);
  }
  console.log(usage);
  process.exit(1);
}
