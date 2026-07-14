// The shape of one coding agent's host-side definition. Everything cww needs
// to know about an agent lives in its src/agents/<id>/ folder: this
// definition, its Dockerfile (FROM cww-base:latest), and any config files the
// Dockerfile bakes. Adding an agent = adding such a folder plus one line in
// registry.ts's AGENTS array — no shared file grows a new case.
//
// Import-cycle guard: agent modules must never import src/lib/docker.ts
// (docker.ts imports the registry, which loads every agent module at import
// time). Agents declare their personal assets declaratively (personalAssets
// below); the registry owns the docker-cp plumbing, so agent modules need no
// container access at all.

// The personal asset folders a project may carry under .cww/. Skills are the
// open Agent Skills format (agentskills.io) and thus portable across agents;
// commands and agents are Claude Code file formats.
export const PERSONAL_ASSET_KINDS = ["skills", "commands", "agents"] as const;
export type PersonalAssetKind = (typeof PERSONAL_ASSET_KINDS)[number];

export interface AgentDefinition<Id extends string = string> {
  id: Id; // e.g. "claude" — also the image tag suffix and Dockerfile folder
  label: string; // human-facing name, e.g. "Claude Code"

  // Auth preflight before a container is (re)created: fail fast (process.exit)
  // with instructions when the agent's credentials are missing, rather than
  // dropping the user into an in-container login screen.
  preflight(projectPath: string, env: Record<string, string | undefined>): void;

  // Which personal .cww/<kind> folders this agent consumes, and where each
  // lands in the container. The registry copies mapped kinds and prints a
  // skip notice for present-but-unmapped ones; declare {} to opt out of the
  // whole mechanism.
  personalAssets: Partial<Record<PersonalAssetKind, string>>;

  // Optional: extra env vars to set on the workspace container at create
  // time, rendered into the generated compose config (an 'environment:'
  // entry overrides the env_file). May die() on invalid user config — it
  // runs alongside preflight, before anything is created.
  containerEnv?(
    projectPath: string,
    env: Record<string, string | undefined>,
  ): Record<string, string>;
}
