// GitHub Copilot CLI — GitHub's terminal coding agent (@github/copilot). The
// Dockerfile and the config files it bakes live alongside this definition;
// see types.ts for the folder contract.
//
// Besides GitHub's own models (github-token method), the CLI has a BYOK mode:
// setting COPILOT_PROVIDER_BASE_URL switches it to any OpenAI-compatible
// endpoint (llama.cpp, vLLM, Ollama, ...) — no GitHub credential or
// subscription needed. That switch-by-presence is why the BYOK variables are
// injected only for the BYOK methods below: leaking the base URL into a
// github-token workspace would silently hijack it.

import { error, info, warn } from "../../lib/ui";
import { getProjectConfig, userConfigFile } from "../../lib/user-config";
import type { AgentAuthMethod, AgentDefinition } from "../types";

// The methods that run Copilot against a third-party endpoint instead of
// GitHub: 'provider' (endpoint needs no key — e.g. a LAN llama.cpp server)
// and 'provider-key' (endpoint requires an API key, which rides the normal
// one-secret channel as COPILOT_PROVIDER_API_KEY).
const BYOK_METHOD_IDS = ["provider", "provider-key"];

// Non-secret BYOK knobs forwarded verbatim from ~/.cww/env into a BYOK
// workspace, on top of the base URL and model resolved below. cww doesn't
// interpret them — the Copilot CLI documents them (`copilot help providers`).
// The ones that matter for a local llama.cpp server are the token limits: the
// CLI only knows context sizes for models in its built-in catalog and warns +
// falls back to defaults for anything else, which every self-served model is.
//
// An allowlist rather than a COPILOT_PROVIDER_* prefix rule, so a typo in
// ~/.cww/env fails visibly (the setting is simply absent) instead of being
// forwarded as a variable the CLI ignores. Deliberately absent:
// COPILOT_PROVIDER_API_KEY and COPILOT_PROVIDER_BEARER_TOKEN — secrets ride
// the one-credential channel (the auth method's envKey), never this one.
const BYOK_PASSTHROUGH_KEYS = [
  "COPILOT_PROVIDER_TYPE",
  "COPILOT_PROVIDER_WIRE_API",
  "COPILOT_PROVIDER_TRANSPORT",
  "COPILOT_PROVIDER_MODEL_ID",
  "COPILOT_PROVIDER_WIRE_MODEL",
  "COPILOT_PROVIDER_MAX_PROMPT_TOKENS",
  "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS",
  "COPILOT_PROVIDER_HEADERS",
  "COPILOT_PROVIDER_AZURE_API_VERSION",
];

// The BYOK endpoint and model for the workspace's Copilot. Non-secret, so
// they ride the create-time agent-env override — not the secret-refresh
// channel — and change on recreate, not restart. Precedence per field:
// project config.json (providerBaseUrl/model) > ~/.cww/env (already loaded
// into env by the caller) > unset. Values pass through verbatim; cww doesn't
// probe the endpoint. `configFile` is injectable so tests never depend on
// the real ~/.cww.
export function copilotProviderSettings(
  projectPath: string,
  env: Record<string, string | undefined>,
  configFile: string = userConfigFile(),
): { baseUrl?: string; model?: string } {
  const cfg = getProjectConfig(projectPath, configFile);
  const out: { baseUrl?: string; model?: string } = {};
  const baseUrl = cfg?.providerBaseUrl || env.COPILOT_PROVIDER_BASE_URL;
  const model = cfg?.model || env.COPILOT_MODEL;
  if (baseUrl) out.baseUrl = baseUrl;
  if (model) out.model = model;
  return out;
}

// COPILOT_MODEL is delivered for every method (on GitHub-backed workspaces it
// just picks among GitHub's models); the BYOK switch itself
// (COPILOT_PROVIDER_BASE_URL), COPILOT_OFFLINE and the BYOK_PASSTHROUGH_KEYS
// knobs only for BYOK methods.
// Offline defaults to true there — a BYOK workspace has no GitHub credential,
// so contacting GitHub only produces login nags — but an explicit
// COPILOT_OFFLINE line in ~/.cww/env is forwarded verbatim for users who want
// BYOK models while staying GitHub-connected.
export function copilotContainerEnv(
  projectPath: string,
  env: Record<string, string | undefined>,
  method?: AgentAuthMethod,
  configFile: string = userConfigFile(),
): Record<string, string> {
  const { baseUrl, model } = copilotProviderSettings(projectPath, env, configFile);
  const out: Record<string, string> = {};
  if (model) out.COPILOT_MODEL = model;
  if (method && BYOK_METHOD_IDS.includes(method.id)) {
    if (baseUrl) out.COPILOT_PROVIDER_BASE_URL = baseUrl;
    out.COPILOT_OFFLINE = env.COPILOT_OFFLINE || "true";
    for (const key of BYOK_PASSTHROUGH_KEYS) {
      const value = env[key];
      if (value) out[key] = value;
    }
  }
  return out;
}

export const copilotAgent: AgentDefinition<"copilot"> = {
  id: "copilot",
  label: "GitHub Copilot",

  // github-token (default) authenticates against GitHub's models with the
  // user's Copilot subscription. The CLI's interactive device-flow login
  // stores into the OS keychain, which doesn't exist in the container — the
  // env var is the supported headless path, and we never copy a host login
  // in. The two BYOK methods need no GitHub credential at all; their
  // endpoint/model configuration is validated by preflight below.
  authMethods: [
    {
      id: "github-token",
      envKey: "COPILOT_GITHUB_TOKEN",
      label: "GitHub token with Copilot access (fine-grained PAT or gho_ OAuth token)",
      instructions:
        "Create a fine-grained personal access token with Copilot access at\n" +
        "https://github.com/settings/personal-access-tokens and copy it. Classic\n" +
        "PATs (ghp_...) don't work; an OAuth token (gho_...) does. Requires a\n" +
        "Copilot subscription.",
    },
    {
      id: "provider",
      label: "No key — a third-party OpenAI-compatible endpoint (BYOK), e.g. a local llama.cpp server",
    },
    {
      id: "provider-key",
      envKey: "COPILOT_PROVIDER_API_KEY",
      label: "Third-party OpenAI-compatible endpoint (BYOK) that requires an API key",
      instructions:
        "Copy the API key your OpenAI-compatible endpoint expects. The endpoint\n" +
        "itself comes from COPILOT_PROVIDER_BASE_URL/COPILOT_MODEL (~/.cww/env)\n" +
        "or providerBaseUrl/model in the project's ~/.cww/config.json entry.",
    },
  ],

  preflight(projectPath, env, method) {
    // The github-token key is guaranteed present by the caller; only the
    // BYOK methods have prerequisites of their own: the endpoint and model
    // must be configured, or Copilot boots into a login nag / model-not-found
    // inside tmux, far from the mistake.
    if (!BYOK_METHOD_IDS.includes(method.id)) return;
    if (method.id === "provider" && env.COPILOT_PROVIDER_API_KEY) {
      warn(
        "COPILOT_PROVIDER_API_KEY is stored but method 'provider' injects no key — did you mean --auth provider-key?",
      );
    }
    const { baseUrl, model } = copilotProviderSettings(projectPath, env);
    if (baseUrl && model) {
      const summary = `Copilot uses the BYOK endpoint ${baseUrl} (model '${model}').`;
      if (method.id === "provider") warn(`No key injected; ${summary}`);
      else info(summary);
      return;
    }
    const missing = [
      ...(baseUrl ? [] : ["COPILOT_PROVIDER_BASE_URL"]),
      ...(model ? [] : ["COPILOT_MODEL"]),
    ];
    error(`Auth method '${method.id}' selected, but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not configured.`);
    console.error("  Copilot's BYOK mode needs an OpenAI-compatible endpoint and a model id:");
    console.error("  set COPILOT_PROVIDER_BASE_URL and COPILOT_MODEL in ~/.cww/env (machine-wide),");
    console.error('  or "providerBaseUrl" and "model" in this project\'s ~/.cww/config.json entry.');
    console.error("  A LAN endpoint needs a hostname the container can resolve — map it in");
    console.error("  ~/.cww/hosts (e.g. 'llamahost 192.168.1.10'); host.docker.internal does NOT");
    console.error("  work under rootless Docker. Example:");
    console.error("    COPILOT_PROVIDER_BASE_URL=http://llamahost:8080/v1");
    console.error("    COPILOT_MODEL=qwen3.6-35b-a3b");
    process.exit(1);
  },

  // Skills follow the shared Agent Skills format; the Copilot CLI reads
  // ~/.copilot/skills/<name>/SKILL.md. commands/agents stay unmapped — those
  // are Claude Code file formats.
  personalAssets: {
    skills: "/home/developer/.copilot/skills",
  },

  hostSkillsDir: "~/.copilot/skills",

  containerEnv(projectPath, env, method) {
    return copilotContainerEnv(projectPath, env, method);
  },
};
