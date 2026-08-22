// cww teardown — tear down a workspace: stop and remove its whole compose
// stack (agent + services + network + volumes) and its host metadata.
//
// Git is your business inside the workspace — push whatever you want to keep
// BEFORE tearing down. Teardown does not push anything.

import { teardownTask } from "../lib/docker";
import { confirm, info, success, warn } from "../lib/ui";
import { parseCommandArgs, requireWorkspace } from "./common";

const USAGE = `Usage: cww teardown [workspace-name] [options]

Remove a workspace and everything it created: the agent container, its service
containers (DB, cache, ...), the network, and this workspace's volumes and host
metadata. This is destructive and does NOT push git — push anything you want to
keep first (e.g. 'cww shell <workspace-name>' then 'git push').

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -y, --yes        Don't prompt for confirmation
  -h, --help       Show this help message

Examples:
  cww teardown sandbox     # By workspace name
  cww teardown             # Auto-detected from the current repo
`;

export async function runTeardown(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE, { yes: { type: "boolean", short: "y", default: false } });
  if (!args) return;
  const assumeYes = args.values.yes;
  const name = args.positionals[0];

  const ws = await requireWorkspace(name, USAGE, {
    specifyMsg: "Could not determine the workspace from the current directory. Specify a name.",
  });

  info(`Workspace: ${ws.workspace}`);
  info(`Container: ${ws.container}`);

  if (!assumeYes) {
    warn("This removes the container, its services, volumes, and metadata. Unpushed git work is lost.");
    if (!confirm(`Tear down '${ws.workspace}'?`, "n")) {
      info("Aborted.");
      return;
    }
  }

  info("Removing container and service stack...");
  await teardownTask(ws.taskDir, ws.container);

  success(`Workspace '${ws.workspace}' torn down.`);
}
