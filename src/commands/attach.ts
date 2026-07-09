// cww attach — re-attach to a workspace's agent session.

import { parseArgs } from "node:util";
import {
  attachAgentSession,
  containerExists,
  containerRunning,
  startTaskStack,
} from "../lib/docker";
import { die, info } from "../lib/ui";
import { resolveContainerLoosely } from "./common";

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
  let name: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h", default: false } },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(USAGE);
      return;
    }
    name = positionals[0];
  } catch (e) {
    die(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }

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
