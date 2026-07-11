// Claude Code — Anthropic's coding agent. The Dockerfile and the config files
// it bakes live alongside this definition; see types.ts for the folder
// contract.

import fs from "node:fs";
import path from "node:path";
import { copyDirIntoContainer } from "../../lib/container-fs";
import { error, info } from "../../lib/ui";
import type { AgentDefinition } from "../types";

export const claudeAgent: AgentDefinition<"claude"> = {
  id: "claude",
  label: "Claude Code",

  // We deliberately don't copy the host's Claude login: as of this writing a
  // copied credential is unsupported across machines and can silently fall
  // back to metered API billing.
  preflight(_projectPath, env) {
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      error("No CLAUDE_CODE_OAUTH_TOKEN found (checked ~/.cww/env and the environment).");
      console.error("  Claude Code in the container needs it to authenticate on your subscription.");
      console.error("  Generate one (uses your Pro/Max plan, not API usage billing) and add it:");
      console.error("    claude setup-token");
      console.error("    echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> ~/.cww/env");
      process.exit(1);
    }
  },

  // Copy optional personal skills/commands/agents from the host project's
  // .cww/ into the container's ~/.claude. The folder's presence is the opt-in
  // — no flag. (Team skills committed to the repo's .claude/skills ride the
  // clone already and need none of this.)
  async materializeAssets(projectPath, container) {
    for (const sub of ["skills", "commands", "agents"]) {
      const src = path.join(projectPath, ".cww", sub);
      if (!fs.existsSync(src)) continue;
      if (await copyDirIntoContainer(src, container, `/home/developer/.claude/${sub}`)) {
        info(`Loaded personal .cww/${sub} into the workspace (~/.claude/${sub})`);
      }
    }
  },
};
