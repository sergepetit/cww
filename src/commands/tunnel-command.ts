// cww tunnel-command — print the ssh command that forwards a task's published
// ports to another machine's localhost.

import { $ } from "bun";
import { getPortMap, type PortBinding } from "../lib/docker";
import { warn } from "../lib/ui";
import { parseCommandArgs, requireWorkspace } from "./common";

const USAGE = `Usage: cww tunnel-command [workspace-name] [options]

Print the ssh command to run FROM another machine to reach this workspace's
published ports on that machine's own localhost. Forwards every host port
the workspace's compose stack currently publishes (the PORTS column of cww list).

The workspace must be running for its ports to be published.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  --host <target>   SSH target to connect to (default: $USER@$(hostname))
  -t, --terse       Print only the ssh command, no explanation
  -h, --help        Show this help message

Examples:
  cww tunnel-command sandbox
  cww tunnel-command sandbox --host me@dev-box.internal
  cww tunnel-command sandbox --terse | pbcopy
`;

export interface TunnelSpec {
  forwards: string; // " -L 3000:localhost:49153 -L ..." (leading space included)
  locals: string; // "localhost:3000, localhost:8080"
  remapped: string; // "80 -> 8080, 443 -> 8443" ("" when nothing remapped)
}

// Build one -L forward per binding, aimed at the CONTAINER port on the local
// side: -L <container>:localhost:<host>. The host port may be ephemeral (Docker
// picks a free one per stack so parallel branches never collide), but the
// container port is stable — so you always reach the app at localhost:<container>
// on the other machine, giving one fixed browser origin across tasks.
//
// Container ports below 1024 are privileged on the OTHER machine — an
// unprivileged ssh can't bind them ("bind: Permission denied") — so those get a
// deterministic +8000 offset (80 -> 8080, 443 -> 8443): still one stable local
// port per service, just an unprivileged one.
export function buildTunnelSpec(map: PortBinding[]): TunnelSpec {
  let forwards = "";
  let locals = "";
  let remapped = "";
  for (const { container, host } of map) {
    let localPort = container;
    if (container < 1024) {
      localPort = container + 8000;
      remapped += `${remapped ? ", " : ""}${container} -> ${localPort}`;
    }
    forwards += ` -L ${localPort}:localhost:${host}`;
    locals += `${locals ? ", " : ""}localhost:${localPort}`;
  }
  return { forwards, locals, remapped };
}

export async function runTunnelCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE, {
    host: { type: "string" },
    terse: { type: "boolean", short: "t", default: false },
  });
  if (!args) return;
  let sshHost = args.values.host ?? "";
  const terse = args.values.terse;
  const name = args.positionals[0];

  const ws = await requireWorkspace(name, USAGE);

  // Default SSH target is this machine (the one running cww). `hostname -f`
  // for the FQDN, plain `hostname` where -f is unsupported.
  if (!sshHost) {
    const fqdn = await $`hostname -f`.quiet().nothrow();
    const host =
      fqdn.exitCode === 0 ? fqdn.text().trim() : (await $`hostname`.quiet()).text().trim();
    sshHost = `${process.env.USER}@${host}`;
  }

  // container->host port map across the task's compose stack (empty unless
  // running).
  const portMap = await getPortMap(ws.taskDir);

  if (portMap.length === 0) {
    warn(`No published ports for '${ws.workspace}'.`);
    console.error("The workspace must be running for its ports to be published.");
    console.error(`Start it with 'cww attach ${ws.workspace}', then try again.`);
    process.exit(1);
  }

  const { forwards, locals, remapped } = buildTunnelSpec(portMap);

  if (terse) {
    console.log(`ssh -N${forwards} ${sshHost}`);
    return;
  }

  console.log(`Run this from the OTHER machine to reach ${ws.workspace}'s ports on its localhost:`);
  console.log("");
  console.log(`  ssh -N${forwards} ${sshHost}`);
  console.log("");
  console.log(`Reachable there at: ${locals}`);
  if (remapped) {
    console.log(`(privileged container port(s) remapped locally: ${remapped})`);
  }
}
