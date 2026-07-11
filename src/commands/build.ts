// cww build — build/rebuild a per-agent Docker image.

import os from "node:os";
import path from "node:path";
import { buildAgentImage, CWW_AGENTS, validateAgent } from "../agents/registry";
import { loadEnvFile } from "../lib/env";

const USAGE = `Usage: cww build [agent|all]

Build (or rebuild) the Docker image for an agent. With no argument, builds the
configured default agent (CWW_AGENT in ~/.cww/env), falling back to claude.
'all' builds every agent's image.

Agents: ${CWW_AGENTS.join(", ")}
`;

export async function runBuild(argv: string[]): Promise<void> {
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    return;
  }

  // No argument -> the configured default agent (CWW_AGENT in ~/.cww/env),
  // falling back to claude.
  if (!argv[0]) loadEnvFile(path.join(os.homedir(), ".cww", "env"));
  const target = argv[0] || process.env.CWW_AGENT || "claude";

  if (target === "all") {
    for (const agent of CWW_AGENTS) {
      await buildAgentImage(agent);
    }
  } else {
    validateAgent(target);
    await buildAgentImage(target);
  }
}
