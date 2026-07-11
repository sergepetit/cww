// Mistral Vibe. The Dockerfile and the config files it bakes live alongside
// this definition; see types.ts for the folder contract.

import fs from "node:fs";
import path from "node:path";
import { error, warn } from "../../lib/ui";
import type { AgentDefinition } from "../types";

export const vibeAgent: AgentDefinition<"vibe"> = {
  id: "vibe",
  label: "Mistral Vibe",

  // Skills follow the shared Agent Skills format; Vibe reads ~/.vibe/skills,
  // and a skill with `user-invocable: true` doubles as a slash command.
  // commands/agents stay unmapped — those are Claude Code file formats
  // (Markdown commands/subagents); Vibe's equivalents are user-invocable
  // skills and TOML agent configs.
  personalAssets: {
    skills: "/home/developer/.vibe/skills",
  },

  preflight(projectPath, env) {
    if (!env.MISTRAL_API_KEY) {
      // A repo-committed .vibe/config.toml rides the clone into the container
      // and can point Vibe at a custom (local or alternate) OpenAI-compatible
      // provider that needs no Mistral key.
      if (fs.existsSync(path.join(projectPath, ".vibe", "config.toml"))) {
        warn(`No MISTRAL_API_KEY set; assuming ${projectPath}/.vibe/config.toml configures a custom provider.`);
      } else {
        error("No MISTRAL_API_KEY found (checked ~/.cww/env and the environment).");
        console.error("  Mistral Vibe in the container needs it to authenticate. Either:");
        console.error("    - get a key at https://console.mistral.ai and add it:");
        console.error("        echo 'MISTRAL_API_KEY=...' >> ~/.cww/env");
        console.error("    - or commit a .vibe/config.toml to the repo with a [[providers]]");
        console.error("      entry for a local/alternate OpenAI-compatible endpoint.");
        process.exit(1);
      }
    }
  },
};
