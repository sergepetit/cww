// cww build — build/rebuild a per-agent Docker image.

import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildAgentImage, CWW_AGENTS, validateAgent } from "../agents/registry";
import { loadEnvFile } from "../lib/env";
import { die } from "../lib/ui";

const USAGE = `Usage: cww build [agent|all] [options]

Build (or rebuild) the Docker image for an agent. With no argument, builds the
configured default agent (CWW_AGENT in ~/.cww/env), falling back to claude.
'all' builds every agent's image.

The agent CLI is installed unpinned, so a build re-resolves it and you land on
the current release. Existing workspaces keep the image they were created with
— 'cww teardown' + 'cww create' moves one onto the new image.

Options:
  --cached       Rebuild from the layer cache: keeps the CLI version already in
                 the image (fast, works offline; for iterating on a Dockerfile)
  -h, --help     Show this help message

Agents: ${CWW_AGENTS.join(", ")}
`;

export async function runBuild(argv: string[]): Promise<void> {
  let cached = false;
  let target = "";
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        cached: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(USAGE);
      return;
    }
    cached = values.cached;
    target = positionals[0] ?? "";
  } catch (e) {
    die(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }

  // No argument -> the configured default agent (CWW_AGENT in ~/.cww/env),
  // falling back to claude.
  if (!target) loadEnvFile(path.join(os.homedir(), ".cww", "env"));
  const agent = target || process.env.CWW_AGENT || "claude";

  if (agent === "all") {
    for (const id of CWW_AGENTS) {
      await buildAgentImage(id, { cached });
    }
  } else {
    validateAgent(agent);
    await buildAgentImage(agent, { cached });
  }
}
