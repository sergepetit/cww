// cww shell — open a plain login shell in a workspace (not the agent). For
// running git, inspecting services, or poking at the box without touching the
// agent session running in tmux.

import { parseArgs } from "node:util";
import { containerExists, containerRunning, startTaskStack } from "../lib/docker";
import { die, info } from "../lib/ui";
import { resolveContainerLoosely } from "./common";

const USAGE = `Usage: cww shell [workspace-name]

Drop into a login shell (as 'developer', cwd /workspace) inside the workspace's
container. The agent's tmux session keeps running untouched — use 'cww attach'
to reach the agent instead.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww shell sandbox    # Shell into the 'sandbox' workspace
  cww shell            # From within the project repo directory
`;

export async function runShell(argv: string[]): Promise<void> {
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

  if (!(await containerExists(container))) {
    die(`Container does not exist: ${container}`);
  }

  // Bring the stack up if stopped, same as attach — a shell is far more useful
  // with the services reachable.
  if (!(await containerRunning(container))) {
    await startTaskStack(taskDir, container);
  }

  info(`Opening a shell in '${workspace}' (exit to leave; the agent keeps running)`);
  console.log("");
  // The bash script exec-replaced itself here; Bun can't, so the CLI stays as
  // parent (stdio passes through) and exits with the shell's status.
  const proc = Bun.spawn(["docker", "exec", "-it", "-w", "/workspace", container, "bash", "-l"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
