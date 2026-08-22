// cww attach — re-attach to a workspace's agent session.

import { attachAgentSession, containerExists, containerRunning } from "../lib/docker";
import { die, info } from "../lib/ui";
import { startTaskStack } from "../lib/workspace";
import { parseCommandArgs, resolveContainerLoosely } from "./common";

const USAGE = `Usage: cww attach [workspace-name]

Re-attach to a workspace's agent session (Claude Code, Mistral Vibe, ...). For
a plain shell instead of the agent, use 'cww shell'.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww attach sandbox    # Attach by workspace name
  cww attach            # Attach from within the project repo directory
`;

export async function runAttach(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE);
  if (!args) return;
  const name = args.positionals[0];

  const { workspace, container, taskDir } = await resolveContainerLoosely(name, USAGE);

  info(`Container: ${container}`);

  if (!(await containerExists(container))) {
    die(`Container does not exist: ${container}`);
  }

  if (!(await containerRunning(container))) {
    await startTaskStack(taskDir, container);
  }

  info(`Attaching to the agent session in '${workspace}'...`);
  info("Press Ctrl-a d to detach");
  console.log("");
  await attachAgentSession(container);
}
