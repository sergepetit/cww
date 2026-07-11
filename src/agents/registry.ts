// Agent backends for cww. Each workspace runs one coding agent inside its
// container; this registry is the single source of truth for which agents
// exist. Everything per-agent lives in src/agents/<id>/ (definition,
// Dockerfile, baked config); adding an agent means adding such a folder and
// one line in AGENTS below. The launch command itself is baked into each
// per-agent image as CWW_AGENT_CMD, so the host CLI never spells it out.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { confirm, die, info, success, warn } from "../lib/ui";
import { claudeAgent } from "./claude/agent";
import { vibeAgent } from "./vibe/agent";
import type { AgentDefinition } from "./types";

// The single registration point.
const AGENTS = [claudeAgent, vibeAgent] as const;

export type Agent = (typeof AGENTS)[number]["id"];
export const CWW_AGENTS: readonly Agent[] = AGENTS.map((a) => a.id);

const byId = new Map<string, AgentDefinition>(AGENTS.map((a) => [a.id, a]));

// cww installation root (this file lives in <root>/src/agents).
export function getCwwDir(): string {
  return path.resolve(import.meta.dir, "..", "..");
}

export function validateAgent(agent: string): asserts agent is Agent {
  if (!byId.has(agent)) {
    die(`Unknown agent '${agent}' (available: ${CWW_AGENTS.join(", ")})`);
  }
}

// Resolve the agent for a new workspace. Precedence: explicit --agent argument
// > CWW_AGENT (from ~/.cww/env or <repo>/.cww/env, both sourced by the caller
// before this runs) > claude. The default is an explicit literal, not
// AGENTS[0] — it's policy, not list order.
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
  return byId.get(agent)?.label ?? agent;
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
  byId.get(agent)?.preflight(projectPath, env);
}

// Load personal host-side assets (e.g. .cww/skills) into a freshly created
// container, dispatching to the agent's own materializeAssets. Agents without
// the hook still get the notice below when the project has such folders.
export async function materializeCwwAssets(
  projectPath: string,
  container: string,
  agent = "claude",
): Promise<void> {
  const def = byId.get(agent);
  if (!def?.materializeAssets) {
    const subs = ["skills", "commands", "agents"];
    if (subs.some((sub) => fs.existsSync(path.join(projectPath, ".cww", sub)))) {
      info(`Personal .cww/{skills,commands,agents} are Claude Code-specific; skipped for ${agent}.`);
    }
    return;
  }
  await def.materializeAssets(projectPath, container);
}

export interface BuildStep {
  tag: string;
  context: string; // build context, relative to the cww root
}

// The ordered docker builds that produce an agent's image: the shared base
// first (cww-base:latest — a plain, unnamespaced local tag; see
// docker/base/Dockerfile for the collision caveat), then the agent's own
// folder as a self-contained build context FROM that tag. The base is always
// rebuilt — no freshness tracking: Docker's layer cache makes a no-op rebuild
// take seconds, which is cheaper and safer than any staleness check (same
// philosophy as the unconditional tmux.conf staging). Pure data so tests
// cover ordering/tags/contexts without Docker.
export function agentBuildPlan(agent: Agent): BuildStep[] {
  return [
    { tag: "cww-base:latest", context: path.join("docker", "base") },
    { tag: agentImage(agent), context: path.join("src", "agents", agent) },
  ];
}

// Build one agent's image (base, then agent — see agentBuildPlan). Shared by
// 'cww build' and ensureAgentImage.
export async function buildAgentImage(agent: string): Promise<void> {
  validateAgent(agent);
  const cwwDir = getCwwDir();
  // tmux.conf is staged into the base build context (same dance as install.sh).
  try {
    fs.copyFileSync(
      path.join(cwwDir, "templates", "tmux.conf"),
      path.join(cwwDir, "docker", "base", "tmux.conf"),
    );
  } catch {
    // Missing template is tolerated, like the bash lib's `|| true`.
  }
  for (const step of agentBuildPlan(agent)) {
    info(`Building ${step.tag} ...`);
    await $`docker build -t ${step.tag} ${path.join(cwwDir, step.context)}`;
  }
  success(`Image built: ${agentImage(agent)}`);
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
