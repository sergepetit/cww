// Claude Code — Anthropic's coding agent. The Dockerfile and the config files
// it bakes live alongside this definition; see types.ts for the folder
// contract.

import { info } from "../../lib/ui";
import type { AgentDefinition } from "../types";

export const claudeAgent: AgentDefinition<"claude"> = {
  id: "claude",
  label: "Claude Code",

  // The setup-token (default) is a one-year OAuth token bound to the user's
  // Pro/Max subscription (not API usage billing); 'claude setup-token' prints
  // it once and never stores it. api-key is the explicit opt-in to metered
  // API billing — never chosen just because an ANTHROPIC_API_KEY happens to
  // exist (it may be another agent's). none injects no credential at all:
  // the user runs /login inside the workspace, accepting that the login dies
  // with the container. We deliberately never copy the host's Claude login:
  // as of this writing a copied credential is unsupported across machines
  // and can silently fall back to metered API billing.
  authMethods: [
    {
      id: "oauth-token",
      envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      label: "Subscription OAuth token, from 'claude setup-token' (Pro/Max plan, no metered billing)",
      instructions:
        "Generate a one-year OAuth token with 'claude setup-token' (uses your\n" +
        "Pro/Max plan, not API usage billing). It prints the token once — copy it.",
      setupCommand: ["claude", "setup-token"],
      valuePrefix: "sk-ant-oat01-",
    },
    {
      id: "api-key",
      envKey: "ANTHROPIC_API_KEY",
      label: "Anthropic API key (metered API billing, not a subscription)",
      instructions:
        "Create an API key at https://console.anthropic.com and copy it.\n" +
        "Usage is metered API billing, independent of any Claude subscription.",
      valuePrefix: "sk-ant-",
    },
    {
      id: "none",
      label: "No credential — run /login inside the workspace (the login dies with the container)",
    },
  ],

  preflight(_projectPath, _env, method) {
    // envKey methods are guaranteed present by the caller; nothing agent-
    // specific to check for them.
    if (method.id === "none") {
      info("No Claude credential is injected — authenticate with /login inside the");
      info("workspace. The login lives in the container only: gone at teardown,");
      info("kept across stop/start.");
    }
  },

  // Optional personal skills/commands/agents from the host project's .cww/
  // land in the container's ~/.claude. The folder's presence is the opt-in —
  // no flag. (Team skills committed to the repo's .claude/skills ride the
  // clone already and need none of this.)
  personalAssets: {
    skills: "/home/developer/.claude/skills",
    commands: "/home/developer/.claude/commands",
    agents: "/home/developer/.claude/agents",
  },

  hostSkillsDir: "~/.claude/skills",
};
