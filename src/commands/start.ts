// cww start — resume a stopped workspace: bring its whole compose stack back
// up without attaching. The inverse of 'cww stop'. (To make a NEW workspace,
// use 'cww create'; to resume AND attach, 'cww attach' / 'cww shell' start it
// too.)

import { containerExists, containerRunning } from "../lib/docker";
import { die, info, success } from "../lib/ui";
import { startTaskStack } from "../lib/workspace";
import { parseCommandArgs, requireWorkspace } from "./common";

const USAGE = `Usage: cww start [workspace-name]

Resume a stopped workspace — start its container and services back up (the
inverse of 'cww stop'), without attaching. Use 'cww create' to make a new
workspace; 'cww attach'/'cww shell' also start a stopped workspace on their way in.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww start sandbox    # Resume by workspace name
  cww start            # Resume from within the project repo directory
`;

export async function runStart(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE);
  if (!args) return;
  const name = args.positionals[0];

  const ws = await requireWorkspace(name, USAGE, {
    notFoundHint: `  To create a new workspace, use 'cww create ${name}'.`,
  });

  info(`Workspace: ${ws.workspace}`);
  info(`Container: ${ws.container}`);

  if (!(await containerExists(ws.container))) {
    die(
      `Container does not exist: ${ws.container}. Use 'cww create ${ws.workspace}' to provision it.`,
    );
  }

  if (await containerRunning(ws.container)) {
    success(`Workspace '${ws.workspace}' is already running.`);
    console.log("");
    console.log(
      `Use 'cww attach ${ws.workspace}' for the agent, or 'cww shell ${ws.workspace}' for a shell.`,
    );
    return;
  }

  // Bring the whole stack back up (agent container + services), mirroring how
  // 'cww stop' takes it down — the same path attach/shell use, including the
  // secret refresh from ~/.cww/env.
  await startTaskStack(ws.taskDir, ws.container);

  success(`Workspace '${ws.workspace}' started.`);
  console.log("");
  console.log(
    `Use 'cww attach ${ws.workspace}' for the agent, or 'cww shell ${ws.workspace}' for a shell.`,
  );
}
