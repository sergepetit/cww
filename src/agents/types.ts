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

// One way an agent can authenticate: the method id follows the vocabulary of
// docs/agent-env-scoping-plan.md (oauth-token, api-key, none, config-file,
// ...), envKey is the variable carrying the secret. A workspace is created
// with exactly ONE method — its envKey is the only agent credential the
// container ever sees (docs/agent-env-scoping-plan.md). Methods without an
// envKey (none, config-file) inject nothing; the agent authenticates some
// other way. 'cww auth' walks the user through storing an envKey method's
// secret (instructions/setupCommand/valuePrefix drive its prompts), and the
// secret-refresh on workspace start (src/lib/env-refresh.ts) derives its key
// from the method recorded in the workspace's session.
export interface AgentAuthMethod {
  id: string; // e.g. "oauth-token", "anthropic-api-key"
  envKey?: string; // e.g. "CLAUDE_CODE_OAUTH_TOKEN"; absent = injects no credential
  label?: string; // one-line description for the create-time method picker
  instructions?: string; // how to obtain the secret, printed before the paste prompt
  setupCommand?: readonly string[]; // host command that mints it, offered when on PATH
  valuePrefix?: string; // expected value prefix; mismatch warns before storing
}

export interface AgentDefinition<Id extends string = string> {
  id: Id; // e.g. "claude" — also the image tag suffix and Dockerfile folder
  label: string; // human-facing name, e.g. "Claude Code"

  // Auth methods this agent supports; the first entry is the default — both
  // for 'cww auth' and for 'cww create's method resolution (which auto-picks
  // the default only when its envKey is already set; anything else is an
  // explicit choice — see src/lib/auth-flow.ts).
  authMethods: readonly AgentAuthMethod[];

  // Auth preflight for the CHOSEN method before a container is (re)created:
  // fail fast (process.exit) with instructions when the method's
  // prerequisites are missing, rather than dropping the user into a broken
  // workspace. The generic "envKey missing" case is handled by the caller
  // before this runs (interactive store flow, or die without a TTY) — this
  // hook covers what only the agent knows: config-file existence, keyless
  // caveats, method-specific notes.
  preflight(
    projectPath: string,
    env: Record<string, string | undefined>,
    method: AgentAuthMethod,
  ): void;

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
