// Pi — the minimal, provider-agnostic coding agent (pi.dev, package
// @earendil-works/pi-coding-agent). The Dockerfile and the config it bakes
// live alongside this definition; see types.ts for the folder contract.
//
// Pi is the simplest agent to wire cww-side: it reads a provider API key
// straight from the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) and
// stores credentials in a plain ~/.pi/agent/auth.json (0o600), never an OS
// keychain — so the one key cww injects for the chosen method authenticates a
// fresh container with nothing copied from the host. There is therefore no
// containerEnv hook at all: unlike OpenCode (OPENCODE_CONFIG_CONTENT) or
// Copilot (the BYOK COPILOT_* family), Pi needs no extra vars synthesized.

import { warn } from "../../lib/ui";
import type { AgentDefinition } from "../types";

// Pi auto-detects whichever provider key is present at startup; any one of
// these makes a workspace usable. This is a conservative subset of the 15+
// providers Pi supports (the authoritative list is `const envMap` in
// packages/ai/src/env-api-keys.ts) — the three whose variable names are
// unambiguous and shared with the opencode agent, so cww's cross-agent secret
// union (allAuthEnvKeys) gains nothing new. Extend once pinned host-side
// (docs/pi-agent-plan.md, Phase 3).
const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;

export const piAgent: AgentDefinition<"pi"> = {
  id: "pi",
  label: "Pi",

  // One method per supported provider key (method id = the key, kebab-cased;
  // the chosen one is the single key the workspace receives), plus a keyless
  // config-file method for a custom/local provider. anthropic-api-key is the
  // default, matching cww's Claude-first policy and the opencode agent.
  authMethods: [
    ...PROVIDER_KEYS.map((key) => ({
      id: key.toLowerCase().replaceAll("_", "-"),
      envKey: key,
      label: `${key} (metered API billing with that provider)`,
      instructions: `Get an API key from the provider and copy it (${key}).`,
    })),
    {
      id: "config-file",
      label: "No key — a custom/local provider configured yourself via a .cww/Dockerfile",
    },
  ],

  // No skills mapping yet: Pi's "Skills" are CLI-tools-with-READMEs, not the
  // Agent Skills SKILL.md format that personalAssets.skills and the built-in
  // cww skill assume. Left empty (so the registry skips the built-in skill and
  // routes no personal .cww/skills here) until confirmed host-side — add
  // { skills: "/home/developer/.pi/agent/skills" } + hostSkillsDir in one pass
  // if Pi turns out to read SKILL.md (docs/pi-agent-plan.md, Phase 3).
  personalAssets: {},

  // No containerEnv: provider keys ride the chosen method's own env channel,
  // and the config-file path bakes models.json into the image via a
  // .cww/Dockerfile COPY — neither needs a var synthesized here.

  preflight(_projectPath, _env, method) {
    // Provider-key methods are guaranteed present by the caller; only the
    // keyless config-file method has anything to say. Pi registers a
    // custom/local provider programmatically (pi.registerProvider() in an
    // extension — see Pi's custom-provider docs), not via a static file cww
    // could parse, so this is an unconditional heads-up rather than a
    // validating check: you own the provider config, baked into the image.
    // Phase 4 revisits a host-side convenience once the mechanism is pinned.
    if (method.id !== "config-file") return;
    warn(
      "No key injected; Pi will use whatever provider you configure in the image. " +
        "Bake a Pi extension that registers your endpoint (pi.registerProvider — " +
        "see pi.dev's custom-provider docs) via a .cww/Dockerfile, or pick a " +
        "provider-key method instead (--auth anthropic-api-key, …).",
    );
  },
};
