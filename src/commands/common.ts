// Shared bits between sub-commands.

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { findWorkspaceContainer } from "../lib/docker";
import { sanitizeName } from "../lib/naming";
import { resolveWorkspace, type WorkspaceRef } from "../lib/session";
import { die, error } from "../lib/ui";

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

// --- Argument parsing --------------------------------------------------------

// Every command gets -h/--help; the helper below injects it, so a command
// only ever declares its OWN options and they can't drift apart.
const HELP_OPTION = { help: { type: "boolean", short: "h", default: false } } as const;

type CommandArgs<O extends ParseArgsOptionsConfig, P extends boolean> = ReturnType<
  typeof parseArgs<{ args: string[]; options: O; allowPositionals: P; strict: true }>
>;

// The shared front half of a command: parse argv (strict, positionals on
// unless opted out), print USAGE and stop on --help, and reduce a parse error
// to its first line — node appends a usage dump the commands print
// themselves. Returns null when the caller should simply return: help was
// printed and there is nothing to run.
//
// Typing follows node's own inference, so `values` stays precisely typed from
// the options literal (a `default` makes a field non-optional, a bare
// `{ type: "string" }` leaves it `string | undefined`).
export function parseCommandArgs<
  const O extends ParseArgsOptionsConfig = {},
  const P extends boolean = true,
>(
  argv: string[],
  usage: string,
  options?: O,
  opts: { allowPositionals?: P } = {},
): CommandArgs<O, P> | null {
  let parsed: CommandArgs<O, P>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...HELP_OPTION, ...options },
      allowPositionals: opts.allowPositionals ?? true,
      strict: true,
      // The cast re-attaches the caller's option types: the runtime config
      // carries the injected help entry, which the caller never reads.
    }) as unknown as CommandArgs<O, P>;
  } catch (e) {
    die(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }
  if ((parsed.values as Record<string, unknown>).help) {
    console.log(usage);
    return null;
  }
  return parsed;
}
