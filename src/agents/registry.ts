// Agent backends for cww. Each workspace runs one coding agent inside its
// container; this registry is the single source of truth for which agents
// exist. Everything per-agent lives in src/agents/<id>/ (definition,
// Dockerfile, baked config); adding an agent means adding such a folder and
// one line in AGENTS below. The launch command itself is baked into each
// per-agent image as CWW_AGENT_CMD, so the host CLI never spells it out.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { copyDirIntoContainer } from "../lib/container-fs";
import { confirm, die, info, success, warn } from "../lib/ui";
import { claudeAgent } from "./claude/agent";
import { opencodeAgent } from "./opencode/agent";
import { vibeAgent } from "./vibe/agent";
import { PERSONAL_ASSET_KINDS, type AgentDefinition, type PersonalAssetKind } from "./types";

// The single registration point.
const AGENTS = [claudeAgent, vibeAgent, opencodeAgent] as const;

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

// Extra env vars the agent wants set on the workspace container, rendered
// into the generated compose config by 'cww create'. Agents without the hook
// contribute nothing. Like preflight, this may die() on invalid user config,
// so it must run before anything is created.
export function agentContainerEnv(
  agent: Agent,
  projectPath: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return byId.get(agent)?.containerEnv?.(projectPath, env) ?? {};
}

export interface PersonalAssetPlan {
  copies: { kind: PersonalAssetKind; src: string; dest: string }[];
  skipped: PersonalAssetKind[]; // present in .cww/ but unmapped for this agent
}

// Which of the project's personal .cww/<kind> folders land where for the
// given agent, per its personalAssets map. Pure data (aside from the
// existence checks) so tests cover the routing without Docker — same
// philosophy as agentBuildPlan below.
export function personalAssetPlan(projectPath: string, agent: Agent): PersonalAssetPlan {
  const map = byId.get(agent)?.personalAssets ?? {};
  const copies: PersonalAssetPlan["copies"] = [];
  const skipped: PersonalAssetKind[] = [];
  for (const kind of PERSONAL_ASSET_KINDS) {
    const src = path.join(projectPath, ".cww", kind);
    if (!fs.existsSync(src)) continue;
    const dest = map[kind];
    if (dest) copies.push({ kind, src, dest });
    else skipped.push(kind);
  }
  return { copies, skipped };
}

// Load personal host-side assets (e.g. .cww/skills) into a freshly created
// container, following the agent's personalAssets map. Present-but-unmapped
// folders get a one-line skip notice.
export async function materializeCwwAssets(
  projectPath: string,
  container: string,
  agent: Agent = "claude",
): Promise<void> {
  const { copies, skipped } = personalAssetPlan(projectPath, agent);
  for (const { kind, src, dest } of copies) {
    if (await copyDirIntoContainer(src, container, dest)) {
      info(`Loaded personal .cww/${kind} into the workspace (${dest.replace("/home/developer", "~")})`);
    }
  }
  if (skipped.length > 0) {
    const what = skipped.length === 1 ? `.cww/${skipped[0]} isn't` : `.cww/{${skipped.join(",")}} aren't`;
    info(`Personal ${what} supported by ${agentLabel(agent)}; skipped.`);
  }
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
