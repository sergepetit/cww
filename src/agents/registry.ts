// Agent backends for cww. Each workspace runs one coding agent inside its
// container; this registry is the single source of truth for which agents
// exist. Everything per-agent lives in src/agents/<id>/ (definition,
// Dockerfile, baked config); adding an agent means adding such a folder and
// one line in AGENTS below. The launch command itself is baked into each
// per-agent image as CWW_AGENT_CMD, so the host CLI never spells it out.

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillEnabled } from "../lib/config";
import { copyDirIntoContainer, copyIntoContainer } from "../lib/container-fs";
import { readSession, type Session } from "../lib/session";
import { confirm, die, info, success, warn } from "../lib/ui";
import { claudeAgent } from "./claude/agent";
import { copilotAgent } from "./copilot/agent";
import { opencodeAgent } from "./opencode/agent";
import { piAgent } from "./pi/agent";
import { vibeAgent } from "./vibe/agent";
import {
  PERSONAL_ASSET_KINDS,
  type AgentAuthMethod,
  type AgentDefinition,
  type PersonalAssetKind,
} from "./types";

// The single registration point.
const AGENTS = [claudeAgent, vibeAgent, opencodeAgent, copilotAgent, piAgent] as const;

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

// Resolve the agent for a new workspace. Precedence: explicit --agent
// argument (callers fold the project's ~/.cww/config.json agent into it)
// > CWW_AGENT (from ~/.cww/env, sourced by the caller before this runs)
// > claude. The default is an explicit literal, not AGENTS[0] — it's policy,
// not list order.
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

// Where every agent image stamps its CLI version at build time (see the
// per-agent Dockerfiles). Absent from images built before that was added, so
// readers must degrade rather than fail.
export const AGENT_VERSION_FILE = "/usr/local/share/cww/agent-version";

// The bare version out of a CLI's --version line, which every agent spells
// differently: "2.1.216 (Claude Code)", "vibe 2.22.0", "1.18.4", "GitHub
// Copilot CLI 1.0.73." all reduce to the number. Falls back to the trimmed
// line, so an unrecognized format still shows something rather than nothing.
export function parseAgentVersion(raw: string): string {
  const line = raw.trim().split("\n")[0]!.trim();
  return line.match(/\d+(?:\.\d+)+(?:[-+][\w.]+)?/)?.[0] ?? line;
}

// Per-agent auth preflight for the chosen method. The container
// authenticates ONLY via env cww passes in — nothing is copied from the host
// — so fail fast with instructions rather than dropping the user into a
// broken workspace. The method's envKey (when it has one) was already
// secured by the caller; this covers the agent-specific rest (config-file
// existence, keyless notes).
export function agentPreflight(
  agent: Agent,
  projectPath: string,
  method: AgentAuthMethod,
  env: Record<string, string | undefined> = process.env,
): void {
  byId.get(agent)?.preflight(projectPath, env, method);
}

// The auth methods an agent declares ('cww auth' offers them; the first is
// the default).
export function agentAuthMethods(agent: Agent): readonly AgentAuthMethod[] {
  return byId.get(agent)?.authMethods ?? [];
}

// One agent method by id, or null. Callers own the unknown-method error so
// each can phrase it for its flag ('--auth', '--method').
export function findAuthMethod(agent: Agent, id: string): AgentAuthMethod | null {
  return agentAuthMethods(agent).find((m) => m.id === id) ?? null;
}

// The env keys an agent's methods can carry (keyless methods contribute
// none). Used as the secret-refresh fallback for sessions from before the
// chosen method was recorded.
export function agentAuthEnvKeys(agent: Agent): string[] {
  return agentAuthMethods(agent)
    .map((m) => m.envKey)
    .filter((k): k is string => !!k);
}

// Every env key that carries an agent secret, across all registered agents.
// 'cww auth KEY=VALUE' uses it to classify a key, and the start-time secret
// refresh falls back to it for sessions recording no agent at all. Workspaces
// themselves receive only their chosen method's key (see env-refresh.ts).
export function allAuthEnvKeys(): string[] {
  return [...new Set(AGENTS.flatMap((a) => agentAuthEnvKeys(a.id)))];
}

// Extra env vars the agent wants set on the workspace container, rendered
// into the generated compose config by 'cww create'. Agents without the hook
// contribute nothing. Like preflight, this may die() on invalid user config,
// so it must run before anything is created.
export function agentContainerEnv(
  agent: Agent,
  projectPath: string,
  env: Record<string, string | undefined> = process.env,
  method?: AgentAuthMethod,
): Record<string, string> {
  return byId.get(agent)?.containerEnv?.(projectPath, env, method) ?? {};
}

// The config file (host source + container destination) the agent wants
// seeded into a freshly created container, or null when it declares none or
// none is present. The registry copies it in materializeCwwAssets; the agent's
// hook is pure resolution (validity is enforced in preflight, pre-create).
export function agentConfigFile(
  agent: Agent,
  projectPath: string,
  env: Record<string, string | undefined> = process.env,
): { src: string; dest: string } | null {
  return byId.get(agent)?.configFile?.(projectPath, env) ?? null;
}

// Where the given agent keeps personal skills on the HOST ("~" expanded
// against home), or null when it declares no host dir. 'cww export-skill'
// searches these.
export function agentHostSkillsDir(agent: Agent, home: string = os.homedir()): string | null {
  const dir = byId.get(agent)?.hostSkillsDir;
  // resolve(): the dir ends up as a symlink target, which must be absolute.
  return dir ? path.resolve(home, dir.replace(/^~\/?/, "")) : null;
}

// The container-side skills dir the agent consumes (personalAssets.skills),
// or null when it maps none — e.g. an agent id from a stale session.
export function agentContainerSkillsDir(agent: string): string | null {
  return byId.get(agent)?.personalAssets.skills ?? null;
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

// The docs bundled into the built-in skill as references/ — pulled straight
// from the install's docs/ at create time, so there is no second copy of the
// facts to drift (install.sh ships docs/ for this). The same set backs the
// host-side skill, which install.sh stages into
// templates/skills/cww-host/references/ (tests/install-skill.test.ts pins the
// two lists together).
export const BUILTIN_SKILL_REFERENCES = [
  "user-guide.md",
  "accessing-services.md",
  "git-strategy.md",
  "cww-project-config.md",
] as const;

// Agent-specific troubleshooting notes, staged as the skill's
// references/troubleshooting.md. Unlike BUILTIN_SKILL_REFERENCES — host-facing
// user docs the agent relays — these are written FOR the running agent, about
// its own quirks in here, so only its own file ships. Resolved on the host,
// where the agent is already known, rather than making the agent pick by
// CWW_IMAGE_AGENT: no wrong-file risk, and a workspace carries no other
// agent's notes. Null for agents with nothing known to warn about.
export function troubleshootingDoc(agent: Agent): string | null {
  const doc = path.join(getCwwDir(), "templates", "agent-troubleshooting", `${agent}.md`);
  return fs.existsSync(doc) ? doc : null;
}

export interface BuiltinSkillPlan {
  src: string; // the skill folder in the install (templates/skills/cww)
  references: string[]; // absolute paths of the reference docs that exist
  missingReferences: string[]; // basenames absent from the install's docs/
  troubleshooting: string | null; // this agent's troubleshooting doc, if any
  dest: string; // where the skill lands in the container
}

// Where the built-in cww workspace skill comes from and lands for the given
// agent — null when the skill is disabled (CWW_SKILL=off / project "skill":
// "off") or the agent maps no skills dir. Pure data aside from the existence
// checks, mirroring personalAssetPlan.
export function builtinSkillPlan(
  agent: Agent,
  env: Record<string, string | undefined> = process.env,
): BuiltinSkillPlan | null {
  if (!skillEnabled(env)) return null;
  const skillsDir = byId.get(agent)?.personalAssets.skills;
  if (!skillsDir) return null;
  const references: string[] = [];
  const missingReferences: string[] = [];
  for (const name of BUILTIN_SKILL_REFERENCES) {
    const doc = path.join(getCwwDir(), "docs", name);
    if (fs.existsSync(doc)) references.push(doc);
    else missingReferences.push(name);
  }
  return {
    src: path.join(getCwwDir(), "templates", "skills", "cww"),
    references,
    missingReferences,
    troubleshooting: troubleshootingDoc(agent),
    dest: path.join(skillsDir, "cww"),
  };
}

// Stage the built-in skill (SKILL.md + references/ assembled from the
// install's docs/) and copy it into the container. Missing pieces degrade to
// a warning — never a failed create. Takes the plan rather than recomputing
// it, so the refresh path below can supply one of its own.
async function applyBuiltinSkill(
  container: string,
  plan: BuiltinSkillPlan,
  refresh = false,
): Promise<void> {
  if (!fs.existsSync(path.join(plan.src, "SKILL.md"))) {
    warn(`Built-in cww skill missing at ${plan.src} (incomplete install?); skipped.`);
    return;
  }
  if (plan.missingReferences.length > 0) {
    warn(`Built-in cww skill: reference doc(s) missing from the install: ${plan.missingReferences.join(", ")}`);
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cww-skill-"));
  try {
    fs.cpSync(plan.src, stage, { recursive: true });
    const refDir = path.join(stage, "references");
    fs.mkdirSync(refDir, { recursive: true });
    for (const doc of plan.references) {
      fs.copyFileSync(doc, path.join(refDir, path.basename(doc)));
    }
    if (plan.troubleshooting) {
      fs.copyFileSync(plan.troubleshooting, path.join(refDir, "troubleshooting.md"));
    }
    if (await copyDirIntoContainer(stage, container, plan.dest)) {
      const verb = refresh ? "Refreshed" : "Loaded";
      info(`${verb} the built-in cww skill (${plan.dest.replace("/home/developer", "~")})`);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Whether an EXISTING workspace's built-in skill should be re-copied, and from
// where — null when it shouldn't be. Deliberately does not consult CWW_SKILL:
// whether a workspace carries the skill at all was settled at create (the
// caller checks the container for the create-time answer), and 'cww start'
// never loads ~/.cww/env, so reading the ambient toggle here would only
// misjudge it. Pure, so tests cover the routing without Docker.
export function skillRefreshPlan(session: Session): BuiltinSkillPlan | null {
  const agent = session.agent ?? "claude";
  // An agent id from a stale session (one whose backend cww no longer has).
  if (!byId.has(agent)) return null;
  // A personal skill named 'cww' owns that folder in the container — create
  // copies personal assets last for exactly that reason. Don't undo it.
  const repo = session.mainRepo;
  if (repo && fs.existsSync(path.join(repo, ".cww", "skills", "cww", "SKILL.md"))) return null;
  return builtinSkillPlan(agent as Agent, { CWW_SKILL: "on" });
}

// Re-load the built-in cww skill into a workspace that already exists, on
// every start (see startTaskStack). The skill and its references/ come from
// the cww install, so without this a workspace keeps the copy that was
// current the day it was created and upgrading cww would only ever fix new
// workspaces. Unlike the agent CLI — frozen in the image for a container's
// whole life (docs/agent-cli-updates.md) — this is a few files a docker cp
// away, so a start is the cheap moment to re-sync them.
//
// Only the skill's CONTENT is refreshed, never the decision to have one: a
// workspace created with CWW_SKILL=off has no skill folder, and this leaves it
// that way, like every other create-time choice (see env-refresh.ts). Quietly
// a no-op without a task dir (attach/shell's pattern-matched fallback).
export async function refreshWorkspaceSkill(
  taskDir: string | null,
  container: string,
): Promise<void> {
  if (!taskDir) return;
  // A corrupt session.json degrades to no refresh; other commands complain
  // about the file itself.
  let session: Session = {};
  try {
    session = readSession(taskDir);
  } catch {
    return;
  }
  const plan = skillRefreshPlan(session);
  if (!plan) return;
  // The create-time answer, read off the container itself: no folder means
  // this workspace was created without the skill (or by a cww too old to have
  // had one), and a start is not the place to change that.
  if ((await $`docker exec ${container} test -d ${plan.dest}`.quiet().nothrow()).exitCode !== 0) {
    return;
  }
  await applyBuiltinSkill(container, plan, true);
}

// Load the built-in cww skill and personal host-side assets (e.g.
// .cww/skills) into a freshly created container, following the agent's
// personalAssets map. The built-in skill goes first, so a personal skill of
// the same name overrides it. Present-but-unmapped folders get a one-line
// skip notice.
export async function materializeCwwAssets(
  projectPath: string,
  container: string,
  agent: Agent = "claude",
): Promise<void> {
  const skill = builtinSkillPlan(agent);
  if (skill) await applyBuiltinSkill(container, skill);
  // An agent config file (e.g. Pi's models.json) — validated in preflight
  // pre-create, so here it is a straight copy into the container. This lands
  // AFTER the agent has already launched (the entrypoint starts it at boot,
  // and the caller waited for its tmux session); Pi re-reads models.json when
  // you open /model, so the first session picks it up there, and every later
  // start finds it already in place. See docs/pi-agent-plan.md, Phase 3.
  const cfg = agentConfigFile(agent, projectPath);
  if (cfg) {
    await copyIntoContainer([cfg.src], container, cfg.dest);
    info(
      `Loaded ${agentLabel(agent)} config into the workspace (${cfg.dest.replace("/home/developer", "~")})`,
    );
  }
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
  flags: string[]; // cache flags for this step
}

export interface BuildOptions {
  cached?: boolean; // reuse the layer cache instead of re-resolving the CLI
}

// The ordered docker builds that produce an agent's image: the shared base
// first (cww-base:latest — a plain, unnamespaced local tag; see
// docker/base/Dockerfile for the collision caveat), then the agent's own
// folder as a self-contained build context FROM that tag.
//
// Both steps always run — no freshness tracking: Docker's layer cache makes a
// no-op rebuild take seconds, which is cheaper and safer than any staleness
// check (same philosophy as the unconditional tmux.conf staging). What the
// cache must NOT silently reuse is the agent CLI: it is installed unpinned so
// that upstream fixes arrive, and a cache hit on that RUN layer freezes the
// version forever (docs/agent-cli-updates.md). Hence the split:
//
//   base  --pull      cheap registry check for a moved ubuntu:26.04; a full
//                     --no-cache here would redo apt + node + bun + Temurin +
//                     noVNC on every build, for minutes
//   agent --no-cache  the agent Dockerfiles are thin — one 'npm install -g
//                     <cli>' plus a few COPYs — so busting all of it IS
//                     busting the CLI install
//
// Pure data so tests cover ordering/tags/contexts/flags without Docker.
export function agentBuildPlan(agent: Agent, opts: BuildOptions = {}): BuildStep[] {
  const fresh = !opts.cached;
  return [
    {
      tag: "cww-base:latest",
      context: path.join("docker", "base"),
      flags: fresh ? ["--pull"] : [],
    },
    {
      tag: agentImage(agent),
      context: path.join("src", "agents", agent),
      flags: fresh ? ["--no-cache"] : [],
    },
  ];
}

// Build one agent's image (base, then agent — see agentBuildPlan). Shared by
// 'cww build', which is explicit and therefore fresh, and ensureAgentImage,
// which only ever builds a MISSING image and passes cached: there is no stale
// CLI layer to bust on a first build, and base layers left from another
// agent's image should be reused rather than re-downloaded.
export async function buildAgentImage(agent: string, opts: BuildOptions = {}): Promise<void> {
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
  for (const step of agentBuildPlan(agent, opts)) {
    info(`Building ${step.tag} ...`);
    const r =
      await $`docker build ${step.flags} -t ${step.tag} ${path.join(cwwDir, step.context)}`.nothrow();
    if (r.exitCode !== 0) {
      // A fresh build re-resolves the CLI from npm/pipx and pulls the base, so
      // it needs the network where a cached one didn't. Name the way out.
      die(
        opts.cached
          ? `Build failed: ${step.tag}`
          : `Build failed: ${step.tag}. A fresh build re-installs the agent CLI and pulls the base image, so it needs network access — 'cww build ${agent} --cached' rebuilds from the layer cache instead (keeping the CLI version you already have).`,
      );
    }
  }
  success(`Image built: ${agentImage(agent)}`);
}

// Make sure the agent's image exists locally, offering to build it on the
// spot. Cached: see buildAgentImage — creating a workspace should never be
// the thing that silently moves an agent CLI, in either direction.
export async function ensureAgentImage(agent: Agent): Promise<void> {
  const image = agentImage(agent);
  const r = await $`docker image inspect ${image}`.quiet().nothrow();
  if (r.exitCode === 0) return;
  warn(`Image '${image}' is not built yet.`);
  if (confirm("Build it now (may take a few minutes)?")) {
    await buildAgentImage(agent, { cached: true });
  } else {
    die(`Run 'cww build ${agent}' first.`);
  }
}
