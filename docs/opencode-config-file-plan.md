---
type: plan
title: OpenCode Config File Plan
description: Replace the one-line OPENCODE_CONFIG_CONTENT env-var UX with real JSON files (~/.cww/opencode.json, <repo>/.cww/opencode.json) that cww validates and injects at create
status: implemented (unit-tested; host Docker checklist passed 2026-07-12)
created: 2026-07-11
tags: [agents, opencode, config, ux]
---

# OpenCode Config File Plan

## Context

The opencode agent's keyless/local-model path (e.g. a llama.cpp server) is configured
today by a ~280-character single-line JSON blob in `~/.cww/env`:

```
OPENCODE_CONFIG_CONTENT={"provider":{"llama.cpp":{...}}},"model":"llama.cpp/local"}
```

A live smoke test (2026-07-11) showed why this is bad UX:

- **Unreadable and uneditable.** No editor syntax help, invisible line-wrap hazards,
  and a `sed` incantation every time a model swap changes `limit.context`.
- **Fails silently, far from the mistake.** A missing brace produced: valid-looking
  env file → compose delivers it → OpenCode hits a parse error *inside tmux* → tmux
  ends → container exits 0 with no visible message. Hours of debugging for a typo.
- **Three parsers with different quoting rules** (cww's env loader, compose's dotenv,
  `docker run --env-file`) mean even correct JSON can arrive mangled depending on path.

The goal: **configure OpenCode with a real, multi-line JSON file that cww validates
host-side and fails loudly on at `cww create`.** The env var becomes an
implementation detail users never see (and stays supported as an escape hatch).

## Design decisions

- **Two file locations, project wins.** Global `~/.cww/opencode.json` (machine-wide,
  e.g. "my llama.cpp server") and per-project `<repo>/.cww/opencode.json` (personal,
  host-side, usually gitignored — `.cww/` is already the personal-config folder). If
  both exist, the project file is used and the global one ignored (same layering
  spirit as `~/.cww/env` vs `<repo>/.cww/env`); no merging between the two — merge
  semantics stay OpenCode's business, not cww's.
- **Delivery = the same env var, injected.** cww minifies the parsed file with
  `JSON.stringify` and sets `OPENCODE_CONFIG_CONTENT` via the generated compose
  config. OpenCode's own merge chain then orders the three config layers sensibly:
  baked image config (MCP entry, autoupdate off) → repo-committed `opencode.json`
  (team config, rides the clone) → `OPENCODE_CONFIG_CONTENT` (this personal file,
  last, wins).
- **Files beat a hand-set env var — mechanically.** Compose's `environment:` section
  overrides `env_file`, so the injected value wins over a leftover
  `OPENCODE_CONFIG_CONTENT=` line in `~/.cww/env` regardless; cww warns when it
  detects both. With no file present, the env var keeps working as before.
- **Strict JSON, validated at create.** `JSON.parse` host-side; a parse error is a
  loud `cww create` failure with the file path and error position — never a silent
  in-container exit. No JSONC (comments) in these files: strictness is what makes
  the loud failure possible with zero dependencies.
- **The plumbing is generic, the feature is opencode's.** Agents get an optional
  `containerEnv` hook returning extra env vars; only the opencode agent implements
  it. No shared file grows opencode-specific logic (the modularization rule).

## Mechanism

New `AgentDefinition` member (`src/agents/types.ts`) — pure data, respecting the
existing import-cycle guard (agent modules never touch docker):

```ts
// Optional: extra env vars to set on the workspace container at create time,
// rendered into the generated compose config ('environment:' overrides the
// env_file). May die() on invalid user config — runs alongside preflight.
containerEnv?(projectPath: string, env: Record<string, string | undefined>): Record<string, string>;
```

Wiring, following the existing hosts/browser override pattern:

- `src/agents/registry.ts` — dispatch `agentContainerEnv(agent, projectPath, env)`
  returning `{}` for agents without the hook.
- `src/commands/create.ts` — new `generateAgentEnvOverride(taskDir, ...)` beside
  `generateHostsOverride` (create.ts:136): writes `docker-compose.agent.yml` with a
  `services.coder.environment` list when the hook returns entries, removes the file
  otherwise. Each entry is emitted as a YAML double-quoted scalar via
  `JSON.stringify("KEY=" + value)` — JSON string escaping is valid YAML, which
  sidesteps hand-rolled quoting.
- `src/lib/docker.ts` — add `docker-compose.agent.yml` to the optional layers in
  `composeFileArgs` (docker.ts:109) so start/stop/teardown see it too.

The opencode agent (`src/agents/opencode/agent.ts`):

- A `resolveConfigFile(projectPath)` helper: `<repo>/.cww/opencode.json` else
  `~/.cww/opencode.json` else none.
- `containerEnv`: parse the resolved file (die with path + parse error on failure),
  return `{ OPENCODE_CONFIG_CONTENT: JSON.stringify(parsed) }`; warn if the
  environment also carries `OPENCODE_CONFIG_CONTENT`. No file → `{}`.
- `preflight`: the resolved config file joins the existing keyless-auth accepters
  (provider key / `OPENCODE_CONFIG_CONTENT` env / repo-committed `opencode.json`),
  with the same warn-and-continue.

Note `cww create` reads these files at create time only — like `~/.cww/hosts` and
the env files, changes apply to the *next* created workspace (the generated
`docker-compose.agent.yml` persists in the task dir for restarts).

## Steps

1. `types.ts`: add the optional `containerEnv` hook.
2. `registry.ts`: add `agentContainerEnv` dispatch.
3. `opencode/agent.ts`: config-file resolution + `containerEnv` + preflight update.
4. `create.ts`: `generateAgentEnvOverride` (called at both create paths, next to the
   hosts/browser override calls); `docker.ts`: extend `composeFileArgs`.
5. Tests (see below).
6. Docs: user-guide §1c rewritten around the file (env var demoted to a footnote);
   `examples/cww.env.example` points at the file; add an example
   `examples/opencode.json.example` with the llama.cpp provider block.

## Testing

Unit (`bun test`, no Docker):

- Resolution: project file beats global; none → `{}`; invalid JSON → dies (subprocess
  probe, like the `validateAgent` test in tests/agents.test.ts:30).
- Injection: `containerEnv` output is minified valid JSON; warning fires when the env
  var is also set.
- Override rendering: `generateAgentEnvOverride` writes/removes the file; the YAML
  value round-trips through a YAML-compatible parse (quoting/escaping).
- `composeFileArgs` picks up `docker-compose.agent.yml` when present.
- Preflight: config file accepted as keyless auth.

Host checklist (needs Docker — scheduled for 2026-07-12, together):

- [x] `cww create` with only `~/.cww/opencode.json` → workspace opencode uses it
  (`docker inspect <container> --format '{{.Config.Env}}' | tr ' ' '\n' | grep OPENCODE`
  shows the injected minified value; TUI shows the model).
- [x] With `<repo>/.cww/opencode.json` too → project file wins (inspect shows the
  project file's content; `[INFO] Injecting OpenCode config from <repo>/.cww/opencode.json`).
- [x] With deliberately broken JSON (e.g. delete a closing brace) → `cww create`
  fails loudly, names the file and position, creates nothing (no container, no
  task dir, no session metadata).
- [x] File + a leftover `OPENCODE_CONFIG_CONTENT=` line in `~/.cww/env` → cww
  warns "the file wins", and the injected value (not the env line) reaches the
  container.
- [x] Legacy: file absent, env-var line present → still works as today (preflight
  warns and continues; the env line reaches OpenCode).
- [x] Restart path: `cww stop` + `cww attach` on a workspace created with a config
  file → the generated `docker-compose.agent.yml` in the task dir is picked up
  (stack restarts cleanly, config still present).
