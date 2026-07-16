#!/usr/bin/env bun
// cww - Coder Workspace Workflow CLI. Sole entry point: the installed `cww`
// launcher execs `bun src/cli.ts "$@"` (see install.sh).

import { die } from "./lib/ui";
import { runAttach } from "./commands/attach";
import { runAuth } from "./commands/auth";
import { runComplete } from "./commands/complete";
import { runBuild } from "./commands/build";
import { runCache } from "./commands/cache";
import { runCreate } from "./commands/create";
import { runExportSkill } from "./commands/export-skill";
import { runInit } from "./commands/init";
import { runList } from "./commands/list";
import { runReset } from "./commands/reset";
import { runStart } from "./commands/start";
import { runShell } from "./commands/shell";
import { runStop } from "./commands/stop";
import { runTeardown } from "./commands/teardown";
import { runTunnelCommand } from "./commands/tunnel-command";
// Single source of truth for the version. 0.1.0 was the bash-based cww this
// CLI replaced (docs/bun-migration-plan.md).
import { version as VERSION } from "../package.json";

const USAGE = `cww - Coder Workspace Workflow (pronounced céwéwé, /se.ve.ve/)

Create isolated, disposable workspaces — each its own container that clones your
repo and runs the app's services via Docker, with a coding agent inside (Claude
Code, Mistral Vibe, or OpenCode). The workspace is the unit; cww is git-flow
agnostic — the git workflow inside is yours.

Usage: cww <command> [arguments]

Commands:
  init [path]             Set a repo up for cww: store + validate its git credential,
                          preflight docker/agent auth/image
  auth [<agent>|git]      Store or renew an agent token / this repo's git credential
  create [path] <name>    Create a workspace (clones the repo, brings up services)
  teardown [name]         Remove a workspace's containers, volumes, network, and metadata
  attach [name]           Re-attach to a workspace's agent session
  shell [name]            Open a plain login shell in a workspace (not the agent)
  start [name]            Resume a stopped workspace (inverse of stop)
  stop [name]             Stop a workspace (its filesystem is preserved)
  reset [name]            Re-run the project's .cww/reset.sh (reset/reseed data)
  export-skill [name]     Export a personal skill from your host agent config
                          into this repo's workspaces (no name: list skills)
  list                    List all workspaces
  tunnel-command [name]   Print the ssh command to reach a workspace's ports
  cache <preset|name>     Provision a shared dependency-cache dir (npm, m2, …)
  build [agent|all]       Build/rebuild a per-agent Docker image (claude | vibe | opencode)
  help                    Show this help message

Run 'cww <command> --help' for more information on a command.

Examples:
  cww init                                    # One-time repo setup (credential + checks)
  cww create <workspace-name>                 # New workspace from the current repo
  cww create <workspace-name> --branch <ref>  # ... starting on a specific branch
  cww create /path/to/repo <workspace-name>   # ... for a specific repo
  cww attach <workspace-name>                 # Re-attach to the agent
  cww shell <workspace-name>                  # Get a shell running in the workspace
  cww list                                    # Show all workspaces
  cww teardown <workspace-name>               # Remove it when done

Version: ${VERSION}`;

// Bun Shell and util.parseArgs are stable from 1.2; refuse to limp along on
// anything older.
const MIN_BUN_VERSION = "1.2.0";

function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

if (!versionAtLeast(Bun.version, MIN_BUN_VERSION)) {
  die(`cww needs Bun >= ${MIN_BUN_VERSION} (found ${Bun.version}). Upgrade with: bun upgrade`);
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "attach":
      await runAttach(rest);
      break;
    case "auth":
      await runAuth(rest);
      break;
    case "build":
      await runBuild(rest);
      break;
    case "shell":
    case "sh":
      await runShell(rest);
      break;
    case "cache":
      await runCache(rest);
      break;
    case "create":
      await runCreate(rest);
      break;
    case "export-skill":
      await runExportSkill(rest);
      break;
    case "init":
      await runInit(rest);
      break;
    case "list":
    case "ls":
      await runList(rest);
      break;
    case "reset":
      await runReset(rest);
      break;
    case "start":
      await runStart(rest);
      break;
    case "stop":
      await runStop(rest);
      break;
    case "teardown":
    case "down":
      await runTeardown(rest);
      break;
    case "tunnel-command":
    case "tunnel":
      await runTunnelCommand(rest);
      break;
    // Hidden: feeds the shell completion scripts (completions/); not in USAGE.
    case "__complete":
      runComplete(rest);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(`cww version ${VERSION}`);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'cww help' for usage.");
      process.exit(1);
  }
} catch (e) {
  // A non-zero exit from a streamed Bun Shell command already printed the
  // command's own stderr; exit with its code, like the bash scripts' set -e.
  if (e && typeof e === "object" && "exitCode" in e && typeof e.exitCode === "number") {
    process.exit(e.exitCode || 1);
  }
  throw e;
}
