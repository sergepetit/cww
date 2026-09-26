// Auth-method selection and secret storage, shared by 'cww auth' and 'cww
// create' (docs/agent-env-scoping-plan.md). A workspace is created with
// exactly ONE auth method; its envKey is the only agent credential the
// container receives. chooseAuthMethod is the deterministic, prompt-free part
// of the resolution; the interactive pieces (method picker, hidden-paste
// store flow) live alongside so both commands drive the same UX.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentLabel, type Agent } from "../agents/registry";
import type { AgentAuthMethod } from "../agents/types";
import { upsertEnvLine } from "./env";
import { confirm, die, info, promptChoice, promptSecret, success, warn } from "./ui";

export function globalEnvFile(): string {
  return path.join(os.homedir(), ".cww", "env");
}

// Upsert KEY=value into ~/.cww/env, preserving the file's other lines. Same
// belt-and-suspenders mode handling as saveCredentials.
export function storeEnvValue(key: string, value: string): void {
  const file = globalEnvFile();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // First write — the file is created below.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, upsertEnvLine(text, key, value), { mode: 0o600 });
  fs.chmodSync(file, 0o600); // writeFileSync's mode only applies on create
  success(`Stored ${key} in ${file}`);
}

// Where a resolved method came from — the precedence chain mirrors --agent's.
export type AuthSource = "flag" | "project" | "global" | "only" | "default";

export interface AuthChoice {
  method: AgentAuthMethod | null; // null = nothing decides; the caller asks (TTY) or dies
  source: AuthSource | null;
  warnings: string[]; // stale config/global values that fell through
}

// The deterministic part of "which auth method does this workspace use":
//   --auth flag > project config "auth" > CWW_AUTH (global default) >
//   the agent's only method > the default (first) method when its envKey is
//   already set.
// The flag must be pre-validated (an unknown --auth value dies at the
// caller); an unknown id from config or CWW_AUTH warns and falls through —
// it may have been written for a different agent. The default method is
// auto-picked ONLY when its key is present: any other method (metered
// billing, keyless fallbacks) is an explicit choice, never a side effect of
// a key existing in ~/.cww/env.
export function chooseAuthMethod(opts: {
  methods: readonly AgentAuthMethod[];
  flag?: string;
  project?: string;
  globalDefault?: string;
  env: Record<string, string | undefined>;
}): AuthChoice {
  const { methods, env } = opts;
  const warnings: string[] = [];
  const find = (id: string) => methods.find((m) => m.id === id) ?? null;

  if (opts.flag) {
    const method = find(opts.flag);
    if (!method) throw new Error(`--auth '${opts.flag}' was not validated against the agent's methods`);
    return { method, source: "flag", warnings };
  }
  for (const [value, source, origin] of [
    [opts.project, "project", "~/.cww/config.json"],
    [opts.globalDefault, "global", "CWW_AUTH"],
  ] as const) {
    if (!value) continue;
    const method = find(value);
    if (method) return { method, source, warnings };
    warnings.push(
      `Ignoring auth method '${value}' from ${origin} — not one of this agent's methods (${methods.map((m) => m.id).join(", ")}).`,
    );
  }
  if (methods.length === 1) return { method: methods[0]!, source: "only", warnings };
  const def = methods[0];
  if (def?.envKey && env[def.envKey]) return { method: def, source: "default", warnings };
  return { method: null, source: null, warnings };
}

// Interactive method picker for 'cww create' when nothing is configured.
// Lists every method with its label so trade-offs (metered billing, keyless
// log-in-inside) are visible at the moment of choice. Dies on a non-answer —
// the caller guarantees a TTY.
export function promptAuthMethod(agent: Agent, methods: readonly AgentAuthMethod[]): AgentAuthMethod {
  const choice = promptChoice(
    `How should ${agentLabel(agent)} workspaces of this project authenticate?`,
    methods.map((m) => `${m.id} — ${m.label ?? m.envKey ?? ""}`),
  );
  if (choice === 0) {
    die(`No auth method selected. Pick one explicitly with: cww create <name> --auth <${methods.map((m) => m.id).join("|")}>`);
  }
  return methods[choice - 1]!;
}

// The prompt-validate-store flow for one envKey method: print how to obtain
// the secret, offer the agent's setup command when it's on the PATH, hidden
// paste, value sanity check, upsert into ~/.cww/env. Returns the stored
// value.
export async function promptStoreMethodSecret(agent: Agent, method: AgentAuthMethod): Promise<string> {
  if (!method.envKey) {
    die(`Method '${method.id}' of ${agentLabel(agent)} stores no credential.`);
  }
  info(`${agentLabel(agent)} — ${method.id} (${method.envKey})`);
  if (method.instructions) {
    for (const line of method.instructions.split("\n")) console.log(`  ${line}`);
  }
  const setupExe = method.setupCommand?.length ? Bun.which(method.setupCommand[0]!) : null;
  if (method.setupCommand?.length && process.stdin.isTTY && setupExe) {
    if (confirm(`Run '${method.setupCommand.join(" ")}' now?`)) {
      // The resolved path, so a Windows '.cmd' shim (npm-installed CLIs) is found.
      const proc = Bun.spawn([setupExe, ...method.setupCommand.slice(1)], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      const code = await proc.exited;
      if (code !== 0) warn(`'${method.setupCommand.join(" ")}' exited with status ${code}.`);
    }
  }

  const value = promptSecret(`Paste the ${method.envKey} value (input hidden)`);
  if (!value) die("Nothing entered — nothing stored.");
  if (method.valuePrefix && !value.startsWith(method.valuePrefix)) {
    warn(`Expected a value starting with '${method.valuePrefix}'.`);
    if (!confirm("Store it anyway?", "n")) die("Not stored.");
  }

  storeEnvValue(method.envKey, value);
  return value;
}
