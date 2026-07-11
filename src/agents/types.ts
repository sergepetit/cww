// The shape of one coding agent's host-side definition. Everything cww needs
// to know about an agent lives in its src/agents/<id>/ folder: this
// definition, its Dockerfile (FROM cww-base:latest), and any config files the
// Dockerfile bakes. Adding an agent = adding such a folder plus one line in
// registry.ts's AGENTS array — no shared file grows a new case.
//
// Import-cycle guard: agent modules must never import src/lib/docker.ts
// (docker.ts imports the registry, which loads every agent module at import
// time). Shared docker-cp plumbing for materializeAssets lives in
// src/lib/container-fs.ts instead.

export interface AgentDefinition<Id extends string = string> {
  id: Id; // e.g. "claude" — also the image tag suffix and Dockerfile folder
  label: string; // human-facing name, e.g. "Claude Code"

  // Auth preflight before a container is (re)created: fail fast (process.exit)
  // with instructions when the agent's credentials are missing, rather than
  // dropping the user into an in-container login screen.
  preflight(projectPath: string, env: Record<string, string | undefined>): void;

  // Optional: load personal host-side assets (e.g. .cww/skills) into the
  // freshly created container. Agents without this hook get the generic
  // "skipped" notice from the registry dispatcher.
  materializeAssets?(projectPath: string, container: string): Promise<void>;
}
