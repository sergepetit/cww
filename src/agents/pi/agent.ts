// Pi — the minimal, provider-agnostic coding agent (pi.dev, package
// @earendil-works/pi-coding-agent). The Dockerfile and the config it bakes
// live alongside this definition; see types.ts for the folder contract.
//
// Pi reads a provider API key straight from the environment (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, …) and stores credentials in a plain ~/.pi/agent/auth.json
// (0o600), never an OS keychain — so the one key cww injects for the chosen
// method authenticates a fresh container with nothing copied from the host.
// There is therefore no containerEnv hook for the provider-key path.
//
// For a custom/local provider (a llama.cpp endpoint, LM Studio, …) Pi reads a
// static ~/.pi/agent/models.json rather than an env var, so — unlike opencode's
// OPENCODE_CONFIG_CONTENT — it can't ride containerEnv. The config-file method
// injects that file instead: resolved and validated here, copied in by the
// registry (see the configFile hook below).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { die, error, warn } from "../../lib/ui";
import type { AgentDefinition } from "../types";

// Pi auto-detects whichever provider key is present at startup; any one of
// these makes a workspace usable. A conservative subset of the 15+ providers
// Pi supports (the authoritative list is `const envMap` in
// packages/ai/src/env-api-keys.ts) — the three whose variable names are
// unambiguous and shared with the opencode agent, so cww's cross-agent secret
// union (allAuthEnvKeys) gains nothing new. Extend once pinned host-side
// (docs/pi-agent-plan.md, Phase 3).
const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;

// Where Pi reads its custom-provider definitions inside the container.
const PI_MODELS_DEST = "/home/developer/.pi/agent/models.json";

// The personal Pi models.json (strict JSON): the per-project
// <repo>/.cww/pi-models.json beats the machine-wide ~/.cww/pi-models.json, and
// no merging happens between the two. `home` is injectable so tests never
// depend on the real ~/.cww. Mirrors resolveOpencodeConfigFile.
export function resolvePiConfigFile(
  projectPath: string,
  home: string = os.homedir(),
): string | null {
  for (const file of [
    path.join(projectPath, ".cww", "pi-models.json"),
    path.join(home, ".cww", "pi-models.json"),
  ]) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Parse the resolved file to validate it, host-side. Strict JSON only (no
// JSONC): strictness is what lets the failure be loud and located, the same
// bargain opencode's config makes. Dies with the file path and parse message.
// Called from preflight (pre-create), so a typo fails before any container
// exists rather than as a silent in-container startup error.
export function readPiConfig(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    die(
      `Invalid JSON in ${file}: ${e instanceof Error ? e.message : e} (strict JSON — no comments or trailing commas)`,
    );
  }
}

export const piAgent: AgentDefinition<"pi"> = {
  id: "pi",
  label: "Pi",

  // One method per supported provider key (method id = the key, kebab-cased;
  // the chosen one is the single key the workspace receives), plus a keyless
  // config-file method for a custom/local provider via a models.json. Default
  // is anthropic-api-key, matching cww's Claude-first policy and the opencode
  // agent.
  authMethods: [
    ...PROVIDER_KEYS.map((key) => ({
      id: key.toLowerCase().replaceAll("_", "-"),
      envKey: key,
      label: `${key} (metered API billing with that provider)`,
      instructions: `Get an API key from the provider and copy it (${key}).`,
    })),
    {
      id: "config-file",
      label: "No key — a pi-models.json points at a custom/local provider (e.g. llama.cpp)",
    },
  ],

  // No skills mapping yet: Pi's "Skills" are CLI-tools-with-READMEs, not the
  // Agent Skills SKILL.md format that personalAssets.skills and the built-in
  // cww skill assume. Left empty (so the registry skips the built-in skill and
  // routes no personal .cww/skills here) until confirmed host-side — add
  // { skills: "/home/developer/.pi/agent/skills" } + hostSkillsDir in one pass
  // if Pi turns out to read SKILL.md (docs/pi-agent-plan.md, Phase 3).
  personalAssets: {},

  // The custom-provider models.json, when present, seeded into the container
  // by the registry. Whichever method is chosen: a provider-key workspace with
  // a stray file gets it too, harmlessly (the key still selects the provider) —
  // and gating here would need the method threaded through the post-create
  // copy. Resolution only; preflight already validated it pre-create.
  configFile(projectPath) {
    const src = resolvePiConfigFile(projectPath);
    return src ? { src, dest: PI_MODELS_DEST } : null;
  },

  preflight(projectPath, _env, method) {
    // Validate a present models.json for ANY method, so a broken file fails
    // pre-create rather than at the post-create copy (which runs too late to
    // undo the container). Then the config-file method additionally requires
    // one — it is the keyless path, useless without a provider definition.
    const file = resolvePiConfigFile(projectPath);
    if (file) {
      readPiConfig(file); // dies on bad JSON
      if (method.id === "config-file") {
        warn(`No key injected; ${file} configures Pi's provider.`);
      }
      return;
    }
    if (method.id !== "config-file") return;
    error("Auth method 'config-file' selected, but no Pi models.json was found.");
    console.error("  Configure a custom/local provider (e.g. a llama.cpp endpoint) with a");
    console.error("  models.json in ~/.cww/pi-models.json (machine-wide) or");
    console.error("  <repo>/.cww/pi-models.json (per-project) — see examples/pi-models.json.example.");
    console.error("  To use a hosted provider API key instead, pick that method:");
    console.error("    cww create <name> --agent pi --auth anthropic-api-key   # or openai-api-key, ...");
    process.exit(1);
  },
};
