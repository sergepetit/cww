// cww stop — stop a workspace's container stack without cleanup (pause work).

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { containerExists, containerRunning, taskCompose } from "../lib/docker";
import { info, success, warn } from "../lib/ui";
import { parseCommandArgs, requireWorkspace } from "./common";

const USAGE = `Usage: cww stop [workspace-name]

Stop a workspace's container without tearing it down. The filesystem survives;
'cww attach' (or 'cww shell') restarts it. Use this to pause work and free up
resources. To remove a workspace entirely, use 'cww teardown'.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww stop sandbox    # Stop by workspace name
  cww stop            # Stop from within the project repo directory
`;

export async function runStop(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE);
  if (!args) return;
  const name = args.positionals[0];

  const ws = await requireWorkspace(name, USAGE);

  info(`Workspace: ${ws.workspace}`);
  info(`Container: ${ws.container}`);

  // Stop the whole stack (agent container + services like the DB), preserving
  // every container's filesystem so 'cww attach' can restart it. Fall back to
  // stopping just the agent container if the compose files are missing.
  if (fs.existsSync(path.join(ws.taskDir, "docker-compose.yml"))) {
    info("Stopping container and service stack...");
    const code = await taskCompose(ws.taskDir, ["stop"]);
    if (code !== 0) process.exit(code);
  } else if (await containerRunning(ws.container)) {
    info("Stopping container...");
    await $`docker stop ${ws.container}`;
  } else if (!(await containerExists(ws.container))) {
    warn(`Container does not exist: ${ws.container}`);
    return;
  } else {
    warn(`Container is already stopped: ${ws.container}`);
    return;
  }

  success("Stack stopped. Work is preserved in the containers.");
  console.log("");
  console.log(`Use 'cww attach ${ws.workspace}' to resume.`);
}
