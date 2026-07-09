// Agent backends for cww. Each workspace runs one coding agent inside its
// container; this module is the single place that knows which agents exist,
// which image serves each one, and what each needs before launch. The launch
// command itself is baked into each per-agent image as CWW_AGENT_CMD (see
// docker/Dockerfile), so the host CLI never spells it out.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { confirm, die, error, info, success, warn } from "./ui";

export const CWW_AGENTS = ["claude", "vibe"] as const;
export type Agent = (typeof CWW_AGENTS)[number];

// cww installation root (this file lives in <root>/src/lib) — the equivalent
// of the bash get_cww_dir.
export function getCwwDir(): string {
  return path.resolve(import.meta.dir, "..", "..");
}

export function validateAgent(agent: string): asserts agent is Agent {
  if (!(CWW_AGENTS as readonly string[]).includes(agent)) {
    die(`Unknown agent '${agent}' (available: ${CWW_AGENTS.join(", ")})`);
  }
}

// Resolve the agent for a new workspace. Precedence: explicit --agent argument
// > CWW_AGENT (from ~/.cww/env or <repo>/.cww/env, both sourced by the caller
// before this runs) > claude.
export function resolveAgent(
  requested?: string,
  env: Record<string, string | undefined> = process.env,
): Agent {
  const agent = requested || env.CWW_AGENT || "claude";
  validateAgent(agent);
  return agent;
}

export function agentImage(agent: string): string {
  return `coder-workspace-workflow:${agent}`;
}

export function agentLabel(agent: string): string {
  switch (agent) {
    case "claude":
      return "Claude Code";
    case "vibe":
      return "Mistral Vibe";
    default:
      return agent;
  }
}

// Per-agent auth preflight. The container authenticates ONLY via env cww
// passes in (~/.cww/env, <repo>/.cww/env, or the caller's environment) —
// nothing is copied from the host — so fail fast with instructions rather
// than dropping the user into an in-container login screen.
export function agentPreflight(
  agent: Agent,
  projectPath: string,
  env: Record<string, string | undefined> = process.env,
): void {
  switch (agent) {
    case "claude":
      // We deliberately don't copy the host's Claude login: as of this
      // writing a copied credential is unsupported across machines and can
      // silently fall back to metered API billing.
      if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
        error("No CLAUDE_CODE_OAUTH_TOKEN found (checked ~/.cww/env and the environment).");
        console.error("  Claude Code in the container needs it to authenticate on your subscription.");
        console.error("  Generate one (uses your Pro/Max plan, not API usage billing) and add it:");
        console.error("    claude setup-token");
        console.error("    echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> ~/.cww/env");
        process.exit(1);
      }
      break;
    case "vibe":
      if (!env.MISTRAL_API_KEY) {
        // A repo-committed .vibe/config.toml rides the clone into the
        // container and can point Vibe at a custom (local or alternate)
        // OpenAI-compatible provider that needs no Mistral key.
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
      break;
  }
}

// Build one agent's image from the multi-stage Dockerfile. Shared by
// 'cww build' and ensureAgentImage.
export async function buildAgentImage(agent: string): Promise<void> {
  validateAgent(agent);
  const cwwDir = getCwwDir();
  const image = agentImage(agent);
  // tmux.conf is staged into the build context (same dance as install.sh).
  try {
    fs.copyFileSync(path.join(cwwDir, "templates", "tmux.conf"), path.join(cwwDir, "docker", "tmux.conf"));
  } catch {
    // Missing template is tolerated, like the bash lib's `|| true`.
  }
  info(`Building ${image} ...`);
  await $`docker build --target ${agent} -t ${image} ${path.join(cwwDir, "docker")}`;
  success(`Image built: ${image}`);
}

// Make sure the agent's image exists locally, offering to build it on the
// spot.
export async function ensureAgentImage(agent: Agent): Promise<void> {
  const image = agentImage(agent);
  const r = await $`docker image inspect ${image}`.quiet().nothrow();
  if (r.exitCode === 0) return;
  warn(`Image '${image}' is not built yet.`);
  if (confirm("Build it now (may take a few minutes)?")) {
    await buildAgentImage(agent);
  } else {
    die(`Run 'cww build ${agent}' first.`);
  }
}
