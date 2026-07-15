// Mistral Vibe. The Dockerfile and the config files it bakes live alongside
// this definition; see types.ts for the folder contract.

import fs from "node:fs";
import path from "node:path";
import { error, warn } from "../../lib/ui";
import type { AgentDefinition } from "../types";

export const vibeAgent: AgentDefinition<"vibe"> = {
  id: "vibe",
  label: "Mistral Vibe",

  authMethods: [
    {
      id: "api-key",
      envKey: "MISTRAL_API_KEY",
      label: "Mistral API key (console.mistral.ai)",
      instructions: "Get an API key at https://console.mistral.ai and copy it.",
    },
    {
      id: "config-file",
      label: "No key — a .vibe/config.toml committed to the repo configures the provider",
    },
  ],

  // Skills follow the shared Agent Skills format; Vibe reads ~/.vibe/skills,
  // and a skill with `user-invocable: true` doubles as a slash command.
  // commands/agents stay unmapped — those are Claude Code file formats
  // (Markdown commands/subagents); Vibe's equivalents are user-invocable
  // skills and TOML agent configs.
  personalAssets: {
    skills: "/home/developer/.vibe/skills",
  },

  preflight(projectPath, _env, method) {
    // api-key's presence is guaranteed by the caller. config-file means: a
    // repo-committed .vibe/config.toml rides the clone into the container and
    // points Vibe at a custom (local or alternate) OpenAI-compatible provider
    // that needs no Mistral key.
    if (method.id === "config-file") {
      const file = path.join(projectPath, ".vibe", "config.toml");
      if (!fs.existsSync(file)) {
        error(`Auth method 'config-file' selected, but ${file} does not exist.`);
        console.error("  Commit a .vibe/config.toml to the repo with a [[providers]] entry for");
        console.error("  a local/alternate OpenAI-compatible endpoint, or pick another method:");
        console.error("    cww create <name> --auth api-key");
        process.exit(1);
      }
      warn(`No key injected; ${file} configures Vibe's provider.`);
    }
  },
};
