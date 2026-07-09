// cww reset — re-run the project's optional .cww/reset.sh inside a workspace
// to reset and reseed its service data. Same script cww runs when a workspace
// is created; run it again any time to get back to a clean, seeded state.

import { parseArgs } from "node:util";
import { containerRunning, runResetScript } from "../lib/docker";
import { die, info, success, warn } from "../lib/ui";
import { requireWorkspace } from "./common";

const USAGE = `Usage: cww reset [workspace-name]

Run the project's .cww/reset.sh inside the workspace (resets/reseeds service
data). No-op if the project has no .cww/reset.sh.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww reset sandbox    # Reset the 'sandbox' workspace
  cww reset            # Auto-detected from the current repo
`;

export async function runReset(argv: string[]): Promise<void> {
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

  const ws = await requireWorkspace(name, USAGE, {
    specifyMsg: "Could not determine the workspace from the current directory. Specify a name.",
  });
  const projectPath = (ws.session.mainRepo as string | undefined) ?? "";

  if (!(await containerRunning(ws.container))) {
    die(`Workspace '${ws.workspace}' is not running. Start it with 'cww attach ${ws.workspace}' first.`);
  }

  info(`Workspace: ${ws.workspace}`);
  let result: "ok" | "no-script";
  try {
    result = await runResetScript(projectPath, ws.container);
  } catch (e) {
    const rc = e && typeof e === "object" && "exitCode" in e ? (e.exitCode as number) : 1;
    die(`reset.sh exited with status ${rc}`);
  }
  if (result === "ok") {
    success("Reset complete.");
  } else {
    warn("No .cww/reset.sh in this project — nothing to run.");
    console.error(`  Add ${projectPath}/.cww/reset.sh to define how to reset/reseed service data.`);
  }
}
