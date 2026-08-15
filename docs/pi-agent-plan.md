---
type: plan
title: Pi Coding Agent Plan
description: Add Pi (pi.dev) as a fifth agent — a provider-agnostic Node CLI that maps almost 1:1 onto the OpenCode agent, minus the in-workspace browser (Pi has no MCP)
status: active
created: 2026-08-15
timestamp: 2026-08-15
tags: [agents, pi]
---

# Pi Coding Agent Plan

**Status 2026-08-15:** Phases 1, 2 and 4 written and unit-tested on branch
`pi-agent` (agent module, docs, and the `config-file` models.json injection for
a local/alternate provider). Phase 3 — host-side build-and-run verification —
is still open: this dev workspace has no docker socket, so nothing here has run
against a real Pi image yet. The items marked **(confirm host-side)** below are
what Phase 3 must settle.

## Context

cww supports four agents (claude, vibe, opencode, copilot). This plan adds
**Pi** (`@earendil-works/pi-coding-agent`, [pi.dev](https://pi.dev)) — a
minimal, provider-agnostic Node coding-agent harness — as a fifth.

Pi is the closest fit to cww's contract of any agent so far: a Node CLI
installed from npm, provider-agnostic auth that reads plain env-var API keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), and credentials in a plain
`0o600` file rather than an OS keychain — exactly the shape cww's
one-secret-per-workspace machinery already serves for OpenCode. **No framework
change is needed**: the method-aware `containerEnv` hook that the copilot work
added (see [copilot-agent-plan.md](copilot-agent-plan.md), Phase 1) is more
than Pi requires, since Pi needs no injected config at all for the provider-key
path.

Two things make Pi *not* a pure copy of the OpenCode agent, and both are
called out below as deliberate scope cuts for v1:

- **Pi has no MCP** (its homepage says so explicitly: *"No MCP. Build CLI tools
  with READMEs (see Skills), or build an extension that adds MCP support."*).
  cww's in-workspace browser is a `chrome-devtools` MCP server every other agent
  bakes in — so a Pi workspace ships **without** the built-in browser in v1.
- **Pi's "Skills" are CLI-tools-with-READMEs**, not the Agent Skills
  `SKILL.md` format the built-in cww skill and `personalAssets.skills` rely on.
  Until confirmed otherwise (Phase 3), Pi maps **no** skills dir, so the
  built-in cww skill is not injected — the registry already degrades to
  skipping it when an agent maps no skills dir.

## Pi facts the design rests on

Gathered from pi.dev and the project's docs
(`github.com/earendil-works/pi/tree/main/packages/coding-agent/docs`)
mid-2026. Like the copilot plan, the items marked **(confirm host-side)** are
the ones Phase 3 must verify against the built image before this is `done` —
Pi ships changes frequently and its own `--help` / docs are the authoritative
source.

- **Install:** `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
  (also `pnpm`/`bun`, or `curl -fsSL https://pi.dev/install.sh | sh`). Node.js
  — installs onto the shared base image like every other agent. The
  `--ignore-scripts` flag is Pi's own recommended install form and is carried
  verbatim into the Dockerfile.
- **Provider-agnostic auth via env vars.** Pi reads provider keys straight from
  the environment — `export ANTHROPIC_API_KEY=sk-ant-…`, `OPENAI_API_KEY`,
  Google, Azure, Bedrock, etc. (15+ providers). This is the OpenCode model
  exactly: whichever key is present makes the workspace usable, and cww injects
  precisely one. The canonical list of recognized variables is `const envMap`
  in `packages/ai/src/env-api-keys.ts` — **(confirm host-side)** which subset
  cww exposes as auth methods.
- **Credentials live in a plain file, not a keychain.** `~/.pi/agent/auth.json`,
  mode `0o600`; Pi explicitly does **not** use macOS Keychain / keytar /
  keyring. Credential resolution order is
  *runtime override > `auth.json` > env var > fallback resolver* — so an
  injected env-var key authenticates a fresh container with nothing copied from
  the host. This is strictly friendlier to cww than copilot's keychain-only
  login path.
- **Config dir `~/.pi/agent/`** (overridable via `PI_CODING_AGENT_DIR`):
  `settings.json` (global prefs), `models.json` (custom/local provider
  definitions — Pi's equivalent of OpenCode's config-file method),
  `sessions/` (JSONL history), and `auth.json`. Reads `AGENTS.md` in the repo
  and a per-project `SYSTEM.md` system-prompt override.
- **Headless modes exist but aren't how cww runs it.** `pi -p "query"` (print),
  `--mode json` (event stream), `--rpc` (JSON over stdin/stdout). cww runs
  every agent *interactively* inside tmux, so what matters is the
  **interactive auto-approve flag** — the equivalent of opencode's `--auto`,
  claude's `--dangerously-skip-permissions`, vibe's `--yolo`, copilot's
  `--allow-all-*`. **(confirm host-side)** the exact flag (and whether a
  first-run trust/onboarding dialog exists that the flag doesn't cover — the
  trap that cost the copilot work an extra Phase-4 fix).
- **No MCP.** No `chrome-devtools` browser integration out of the box; skills
  are README-described CLI tools. **(confirm host-side)** whether Pi reads
  Agent Skills `SKILL.md` at all.
- **Self-update:** **(confirm host-side)** whether Pi self-updates and the flag
  / env var to disable it, matching the other images
  (`OPENCODE_DISABLE_AUTOUPDATE`, `COPILOT_AUTO_UPDATE=false`, …). A disposable
  container never self-updates.
- **Proxy:** honors `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (undici
  `EnvHttpProxyAgent`) — no cww work, noted for completeness.

## Design decisions

- **Provider-agnostic auth methods mirroring OpenCode.** One `AgentAuthMethod`
  per supported provider key (method id = the key, kebab-cased; envKey = the
  key), plus one keyless `config-file` method for a custom/local provider via
  `models.json`. Reuse OpenCode's `PROVIDER_KEYS` shape verbatim; the final set
  is pinned in Phase 3 against `env-api-keys.ts`.
- **No `containerEnv` for the provider-key path.** Unlike OpenCode (which
  forwards `OPENCODE_CONFIG_CONTENT`), Pi reads the provider key directly from
  the env cww already injects for the chosen method — so the provider-key
  methods need **zero** injection code. This is the simplest possible agent.
- **`config-file` injects a validated `models.json` (Phase 4, implemented).**
  Pi reads a static `~/.pi/agent/models.json` to register a custom/local
  provider (llama.cpp, LM Studio, …) — confirmed against Pi's own models docs
  and the HuggingFace local-agents guide. Because Pi reads a *file*, not an env
  var, this can't ride `containerEnv` the way opencode's `OPENCODE_CONFIG_CONTENT`
  does; it needs a new declarative hook. So `AgentDefinition` gains an optional
  `configFile(projectPath, env)` returning `{ src, dest } | null`, resolved from
  `<repo>/.cww/pi-models.json` (project) over `~/.cww/pi-models.json` (global) —
  the same precedence as opencode's config file. `preflight` validates it
  pre-create (strict JSON, die on error, like opencode) and requires one for the
  keyless `config-file` method; the registry copies the validated file into the
  container in `materializeCwwAssets` via `copyIntoContainer`, keeping all
  docker-cp out of the agent module. (A `registerProvider()` extension remains
  Pi's escape hatch for providers a static file can't express — bake it with a
  `.cww/Dockerfile`; nothing cww-side needed.)
- **No browser in v1 (Pi has no MCP).** No `mcp-config`, no `browser-hook.sh`,
  no `chrome-devtools-mcp` in the Dockerfile. `CWW_BROWSER` still governs the
  base-image browser stack; Pi simply doesn't attach to it. Documented as the
  one feature a Pi workspace lacks versus the other four agents. A later Pi
  *extension* that adds MCP could restore it — tracked as a follow-up, out of
  scope here.
- **No skills mapping in v1 (`personalAssets: {}`), pending Phase 3.** If Phase 3
  finds Pi reads Agent Skills `SKILL.md`, add
  `personalAssets: { skills: "/home/developer/.pi/agent/skills" }` and
  `hostSkillsDir` in the same pass and the built-in cww skill starts flowing;
  the registry needs no change either way (`builtinSkillPlan` returns null for
  an agent that maps no skills dir).
- **Version stamping like every image.** `pi --version | head -1 >`
  `/usr/local/share/cww/agent-version`, so `cww list --versions` reports a Pi
  workspace's CLI without launching it.

## Phase 1 — Pi agent module + Dockerfile + tests

**Status: not started**

New folder `src/agents/pi/` (mirror `src/agents/opencode/`, minus the browser
and config-injection pieces):

- `agent.ts` —
  - `piAgent: AgentDefinition<"pi">` with `id: "pi"`, `label: "Pi"`;
  - `authMethods`: one per provider key (the OpenCode `PROVIDER_KEYS` set,
    pinned in Phase 3) + a keyless `config-file` method;
  - `personalAssets: {}` for v1 (revisit in Phase 3);
  - **no** `containerEnv` (provider keys ride the method's own env channel);
  - `configFile(projectPath)` — resolves `.cww/pi-models.json` (project over
    global) and returns `{ src, dest: ~/.pi/agent/models.json }` for the
    registry to copy (Phase 4);
  - `preflight`: validate a present `models.json` pre-create (strict JSON, die
    on error) for any method, and for the keyless `config-file` method require
    one, dying with the two config paths and the provider-key alternative when
    absent (opencode's config-file preflight, adapted).
- `src/agents/types.ts` + `registry.ts` — add the optional `configFile` hook to
  `AgentDefinition` and an `agentConfigFile` dispatch; `materializeCwwAssets`
  copies the resolved file via `copyIntoContainer` (docker-cp stays in the
  registry, not the agent module).
- `Dockerfile` — `FROM cww-base:latest`;
  `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`; version
  stamp; disable self-update (flag TBD Phase 3); `ENV CWW_IMAGE_AGENT=pi`;
  `ENV CWW_AGENT_CMD="pi <auto-approve-flag>"` (flag TBD Phase 3). **No**
  `mcp-config.json`, **no** `browser-hook.sh`.
- `src/agents/registry.ts` — import + append `piAgent` to `AGENTS`.
- `src/commands/auth.ts` — USAGE text: `cww auth pi --method <provider-key>`.
- `examples/cww.env.example` — extend the `CWW_AGENT`/`CWW_AUTH` vocabulary; a
  Pi section noting it shares the provider-key vars with opencode.

Tests (`tests/agents.test.ts`): agent order/labels/images, the known-methods
table, `allAuthEnvKeys` union, a `personalAssets` case asserting Pi maps no
skills dir (built-in skill skipped), and a `pi config file` block covering
resolution precedence, the `agentConfigFile` dispatch, and the preflight
die/validate paths — all pure-data, no Docker, as today.

## Phase 2 — User docs

**Status: not started**

- `docs/user-guide.md` — a Pi auth-setup section (provider keys, mirroring the
  opencode section) and Pi in the build / choosing-an-agent / config sections.
  **Explicitly document the two gaps:** no in-workspace browser (no MCP), and
  no built-in cww skill unless Phase 3 confirms the skills format.
- `README.md` — agent enumerations, build table, personal-assets paragraph.
- `docs/index.md` — keep this plan's entry in sync (status transitions).

## Phase 3 — Host-side end-to-end verification

**Status: not started**

Run per the repo's verify procedure (isolated HOME, real docker daemon,
scratch repo, teardown after — see the `verify` skill). Resolves every
**(confirm host-side)** unknown above:

1. **Images:** `cww build pi` builds base + agent; the image carries
   `CWW_IMAGE_AGENT=pi` and a real `agent-version`; `cww build all` + a version
   smoke test of the other four agents shows no regression.
2. **Interactive auto-approve:** confirm the flag that makes `pi` run in tmux
   with no per-tool permission prompt, and whether a first-run trust/onboarding
   dialog fires that the flag doesn't cover (bake the fix into the image config
   if so — the copilot `trustedFolders` lesson). Update `CWW_AGENT_CMD`.
3. **Provider-key path:** with `--auth anthropic-api-key` (or another provider),
   the container sees exactly that one key, Pi reaches the prompt, and a real
   tool-using turn runs. Confirm the pinned provider-key set against
   `packages/ai/src/env-api-keys.ts`.
4. **Self-update:** confirm it's disabled in the image.
5. **Skills:** determine whether Pi reads Agent Skills `SKILL.md`. If yes, add
   the `personalAssets.skills` mapping + `hostSkillsDir` and re-verify the
   built-in cww skill loads; if no, confirm the v1 "no skills" behavior and
   leave `personalAssets: {}`, and note it in the docs.
6. **config-file path:** with a `~/.cww/pi-models.json` pointing at a stub
   OpenAI-compatible server (then the LAN llama.cpp host), `--auth config-file`
   lands the file at `~/.pi/agent/models.json` and Pi drives a real tool-using
   turn against it; a broken JSON file fails the create pre-container. Confirm
   Pi's actual `models.json` schema against pi.dev/docs/latest/models (cww only
   checks it is valid JSON), and whether the model needs selecting via `/model`
   each session or can be defaulted.
7. **Teardown:** no stray `cww-repo-*` containers or `repo-*` networks; the
   developer's own workspaces untouched.

## Phase 4 — `config-file` models.json injection for a custom provider

**Status: written, unit-tested; host-run pending (folded into Phase 3, step 6)**

First-class local/alternate-provider support, so a llama.cpp endpoint needs one
`cww create` rather than a hand-rolled `.cww/Dockerfile`:

- **`configFile` hook** on `AgentDefinition` (`src/agents/types.ts`), dispatched
  by `agentConfigFile` and applied in `materializeCwwAssets` via
  `copyIntoContainer` — Pi reads a *file* (`~/.pi/agent/models.json`), not an
  env var, so this is the file-analogue of opencode's `containerEnv`
  `OPENCODE_CONFIG_CONTENT`. The hook is pure resolution; the registry owns the
  docker-cp, so the agent module still imports no docker.
- **Resolution + validation** in `pi/agent.ts`: `resolvePiConfigFile` picks
  `<repo>/.cww/pi-models.json` over `~/.cww/pi-models.json`; `readPiConfig`
  parses it (strict JSON, die with file + position); `preflight` validates any
  present file pre-create and requires one for the keyless `config-file` method.
- **Docs + example:** `examples/pi-models.json.example` (a llama.cpp provider
  block), the user-guide 1e config-file paragraph, the env-example Pi section,
  and the README local-endpoint list.
- **Escape hatch retained:** a `pi.registerProvider()` extension baked via a
  `.cww/Dockerfile` still covers providers a static `models.json` can't express;
  nothing cww-side needed for it.

Still to do host-side (Phase 3, step 6): confirm Pi's real `models.json` schema
and that it drives a turn against the stub then the LAN llama.cpp host.
