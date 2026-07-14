// OpenCode — the open-source, provider-agnostic coding agent (opencode.ai).
// The Dockerfile and the config files it bakes live alongside this
// definition; see types.ts for the folder contract.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { die, error, info, warn } from "../../lib/ui";
import type { AgentDefinition } from "../types";

// OpenCode auto-detects whichever provider key is present at startup; any one
// of these makes a workspace usable. (A Claude Pro/Max subscription can NOT
// be used — OpenCode dropped Claude OAuth login in v1.3.0 per Anthropic's
// ToS, so a CLAUDE_CODE_OAUTH_TOKEN doesn't authenticate it.)
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
] as const;

// The personal OpenCode config file (strict JSON): the per-project
// <repo>/.cww/opencode.json beats the machine-wide ~/.cww/opencode.json, and
// no merging happens between the two — merge semantics stay OpenCode's
// business. `home` is injectable so tests never depend on the real ~/.cww.
export function resolveOpencodeConfigFile(
  projectPath: string,
  home: string = os.homedir(),
): string | null {
  for (const file of [
    path.join(projectPath, ".cww", "opencode.json"),
    path.join(home, ".cww", "opencode.json"),
  ]) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Parse the resolved config file and deliver it as OPENCODE_CONFIG_CONTENT —
// OpenCode merges that env var last, over the baked image config and any
// repo-committed opencode.json. Invalid JSON dies here, host-side, with the
// file path and parse position — never a silent in-container exit. Strict
// JSON only (no JSONC): strictness is what makes the loud failure possible.
export function opencodeContainerEnv(
  projectPath: string,
  env: Record<string, string | undefined>,
  home: string = os.homedir(),
): Record<string, string> {
  const file = resolveOpencodeConfigFile(projectPath, home);
  if (!file) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    die(
      `Invalid JSON in ${file}: ${e instanceof Error ? e.message : e} (strict JSON — no comments or trailing commas)`,
    );
  }
  if (env.OPENCODE_CONFIG_CONTENT) {
    warn(`Both ${file} and an OPENCODE_CONFIG_CONTENT env line are set; the file wins.`);
  }
  info(`Injecting OpenCode config from ${file}`);
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(parsed) };
}

export const opencodeAgent: AgentDefinition<"opencode"> = {
  id: "opencode",
  label: "OpenCode",

  // Skills follow the shared Agent Skills format; OpenCode reads
  // ~/.config/opencode/skills/<name>/SKILL.md. commands/agents stay unmapped —
  // those are Claude Code file formats; OpenCode's markdown agents/commands
  // use different frontmatter (name-from-filename, permission maps instead of
  // tools strings) and choke on Claude-style keys.
  personalAssets: {
    skills: "/home/developer/.config/opencode/skills",
  },

  containerEnv(projectPath, env) {
    return opencodeContainerEnv(projectPath, env);
  },

  preflight(projectPath, env) {
    if (PROVIDER_KEYS.some((k) => env[k])) return;
    // Keyless custom providers (e.g. a local llama.cpp server), in the order
    // the pieces win at runtime: a personal opencode.json config file
    // (project beats global; parsed host-side and injected by containerEnv
    // above), inline config in the env (OPENCODE_CONFIG_CONTENT merges into
    // OpenCode's config chain), or a repo-committed opencode.json that rides
    // the clone into the container and merges OVER the baked global config.
    const configFile = resolveOpencodeConfigFile(projectPath);
    if (configFile) {
      warn(`No LLM provider key set; assuming ${configFile} configures a custom provider.`);
      return;
    }
    if (env.OPENCODE_CONFIG_CONTENT) {
      warn("No LLM provider key set; assuming OPENCODE_CONFIG_CONTENT configures a custom provider.");
      return;
    }
    const committed = ["opencode.json", "opencode.jsonc"].find((f) =>
      fs.existsSync(path.join(projectPath, f)),
    );
    if (committed) {
      warn(`No LLM provider key set; assuming ${projectPath}/${committed} configures a custom provider.`);
      return;
    }
    error("No LLM provider key found (checked ~/.cww/env and the environment).");
    console.error("  OpenCode in the container needs one of:");
    console.error("    ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, OPENCODE_API_KEY");
    console.error("  Note: a Claude Pro/Max subscription can NOT be used — OpenCode removed");
    console.error("  Claude OAuth login; metered API billing applies. Either add a key:");
    console.error("    echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.cww/env");
    console.error("  or configure a local/alternate OpenAI-compatible endpoint (e.g. llama.cpp)");
    console.error("  with a \"provider\" entry in ~/.cww/opencode.json (machine-wide) or");
    console.error("  <repo>/.cww/opencode.json (per-project) — see examples/opencode.json.example —");
    console.error("  or in an opencode.json committed to the repo.");
    process.exit(1);
  },
};
