// Claude Code — Anthropic's coding agent. The Dockerfile and the config files
// it bakes live alongside this definition; see types.ts for the folder
// contract.

import { info } from "../../lib/ui";
import { getProjectConfig, userConfigFile } from "../../lib/user-config";
import type { AgentDefinition } from "../types";

// Model selection for the workspace's Claude Code: ANTHROPIC_MODEL sets the
// session default (the in-session /model and --model still win inside the
// container), CLAUDE_CODE_SUBAGENT_MODEL the model subagents/workflows run
// on. Non-secret, so they ride the create-time agent-env override — not the
// secret-refresh channel — and change on recreate, not restart. Precedence
// per field: project config.json (model/subagentModel) > ~/.cww/env (already
// loaded into env by the caller) > unset, leaving Claude Code's own default.
// Values pass through verbatim (aliases like "opus" and full ids both work);
// cww doesn't validate model names. `configFile` is injectable so tests never
// depend on the real ~/.cww.
export function claudeContainerEnv(
  projectPath: string,
  env: Record<string, string | undefined>,
  configFile: string = userConfigFile(),
): Record<string, string> {
  const cfg = getProjectConfig(projectPath, configFile);
  const out: Record<string, string> = {};
  const model = cfg?.model || env.ANTHROPIC_MODEL;
  const subagentModel = cfg?.subagentModel || env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (model) out.ANTHROPIC_MODEL = model;
  if (subagentModel) out.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;
  return out;
}

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

  containerEnv(projectPath, env) {
    return claudeContainerEnv(projectPath, env);
  },
};
