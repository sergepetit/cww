---
type: plan
title: GitHub Copilot CLI Agent Plan
description: Add GitHub Copilot CLI as a fourth agent, including its BYOK mode so a workspace can run against a third-party OpenAI-compatible endpoint (e.g. a LAN llama.cpp server)
status: done — all four phases host-verified 2026-07-21, including BYOK against the real llama.cpp/Qwen host
created: 2026-07-21
tags: [agents, copilot, byok, config]
---

# GitHub Copilot CLI Agent Plan

## Context

cww supports three agents (claude, vibe, opencode). This plan adds **GitHub
Copilot CLI** (`@github/copilot`, GA since February 2026) as a fourth,
including its **BYOK (bring-your-own-key) mode** so a workspace can run
Copilot against a third-party OpenAI-compatible endpoint instead of GitHub's
models — the driving use case being a llama.cpp server on the developer's LAN
serving Qwen 3.6 35B-A3B.

Copilot's BYOK is purely env-var driven, which maps 1:1 onto cww's existing
auth-method + `containerEnv` machinery — simpler than OpenCode's config-file
flow, since no file needs to be parsed or injected.

The work is phased so it can land over several sessions: the development
workspace has no docker socket, and end-to-end testing needs the llamacpp
host up. Update each phase's status line as it lands.

## Copilot CLI facts the design rests on

Gathered from GitHub's docs (mid-2026) and **re-verified in Phase 4** against
the CLI's own `copilot help environment` / `help providers` / `help config`
on the built image (version 1.0.73). The CLI ships changes frequently; those
three help topics are the authoritative source, and they are readable from
any built copilot image without a credential.

- Install: `npm install -g @github/copilot`; requires **Node 22+**.
- Container auth: env var `COPILOT_GITHUB_TOKEN` (the CLI also honors
  `GH_TOKEN`/`GITHUB_TOKEN`, which would shadow it — cww injects only the
  chosen method's single key, so no conflict). Fine-grained PATs
  (`github_pat_...`) or OAuth tokens (`gho_...`) work; **classic PATs are
  rejected**. The OS-keychain login flow is unusable headless; the env var is
  the supported container path.
- BYOK (GA 2026-04): `COPILOT_PROVIDER_BASE_URL` (OpenAI-compatible
  endpoint), `COPILOT_MODEL` (model id), optional `COPILOT_PROVIDER_API_KEY`,
  and `COPILOT_OFFLINE=true` (no GitHub contact, no subscription needed).
  Setting the base URL is what switches the CLI into BYOK mode. The model
  must support tool calling and streaming; small context windows (&lt;32k)
  fail outright since the system prompt + tool definitions are ~21k tokens.
  Beyond those four the CLI reads a family of BYOK tuning variables, all
  non-secret and all forwarded by cww since Phase 4 (`BYOK_PASSTHROUGH_KEYS`):
  `COPILOT_PROVIDER_TYPE` (`openai`|`azure`|`anthropic`),
  `COPILOT_PROVIDER_WIRE_API`, `COPILOT_PROVIDER_TRANSPORT`,
  `COPILOT_PROVIDER_MODEL_ID` / `COPILOT_PROVIDER_WIRE_MODEL`,
  `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` / `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS`,
  `COPILOT_PROVIDER_HEADERS`, `COPILOT_PROVIDER_AZURE_API_VERSION`. The one
  exception is `COPILOT_PROVIDER_BEARER_TOKEN`, an alternative to the API key
  and therefore a secret — it is not forwarded.
- `COPILOT_AUTO_UPDATE=false` disables the CLI's self-update, which is on by
  default outside CI. cww sets it in the image, matching claude's
  `DISABLE_AUTOUPDATER`, opencode's `OPENCODE_DISABLE_AUTOUPDATE` and vibe's
  `VIBE_ENABLE_UPDATE_CHECKS`.
- Config dir `~/.copilot/`: `mcp-config.json`
  (`{"mcpServers": {"<name>": {"type": "local", "command": ..., "args": [...], "tools": ["*"]}}}`),
  `config.json`, `settings.json`, `skills/` (open Agent Skills format),
  `copilot-instructions.md`; reads `AGENTS.md` in the repo. `config.json`'s
  own header says it is CLI-managed and points at `settings.json` for user
  settings, but **`config.json` is where settings are actually read from**:
  keys written to `settings.json` are migrated across only *after* the
  session has already used them (Phase 4 finding — see there). Both are
  JSONC; the CLI merges into `config.json` rather than replacing it, so a
  baked key survives.
- Autonomous flags: `--allow-all-tools --allow-all-paths --allow-all-urls`,
  aliased since 1.0.x as `--yolo` / `--allow-all`. They cover **tools, paths
  and URLs only** — not the first-run folder-trust dialog, which is
  `trustedFolders` in `config.json`.

## Design decisions

- **Three auth methods, `github-token` first (default).** cww injects exactly
  one secret per workspace and a method either has an `envKey` or doesn't, so
  BYOK splits cleanly into a keyless and a keyed method:
  1. `github-token` — envKey `COPILOT_GITHUB_TOKEN`. No `valuePrefix` (two
     valid prefixes exist); instructions warn that classic PATs don't work.
  2. `provider` — keyless BYOK (the llama.cpp case): base URL + model come
     from config, no credential injected at all.
  3. `provider-key` — envKey `COPILOT_PROVIDER_API_KEY`, for BYOK endpoints
     that require a key; the key rides the normal secret channel (task env +
     start-time refresh).
- **Provider settings resolution** (shared by preflight and containerEnv):
  project `~/.cww/config.json` entry `providerBaseUrl` / `model` beats
  `~/.cww/env` `COPILOT_PROVIDER_BASE_URL` / `COPILOT_MODEL`. Same channel
  and precedence as claude's model config; non-secrets ride the generated
  compose override (apply on create/recreate, not restart).
- **BYOK-only injection.** `COPILOT_PROVIDER_BASE_URL` and `COPILOT_OFFLINE`
  are injected **only** for the `provider`/`provider-key` methods — the base
  URL alone flips the CLI into BYOK, which would silently hijack a
  `github-token` workspace. `COPILOT_MODEL` is injected for all methods (it
  just picks the model on GitHub-backed workspaces). This needs the chosen
  auth method visible to the `containerEnv` hook — a small framework
  extension (Phase 1).
- **Offline by default for BYOK, overridable.** BYOK methods set
  `COPILOT_OFFLINE=true` (no login nag, no telemetry, works with zero GitHub
  subscription). An explicit `COPILOT_OFFLINE=` line in `~/.cww/env` is
  forwarded verbatim instead, for users who want BYOK models while staying
  GitHub-connected.
- **Node 22 in the shared base image** (currently Node 20, EOL 2026-04-30).
  One-line bump; all agent images move together rather than the copilot image
  carrying a second Node install. Other agents get a one-time smoke test
  after rebuild (Phase 4).
- **`COPILOT_GITHUB_TOKEN` does not double as the git credential.** cww's git
  credential stays per-repo in `~/.cww/credentials` by design; the docs may
  note that the same fine-grained PAT can be pasted into both flows.

## Phase 1 — Framework groundwork

**Status: done (unit-tested 2026-07-21; the Node 22 image rebuild is verified host-side in Phase 4)**

Safe standalone changes; no behavior change for existing agents.

- `docker/base/Dockerfile`: `ARG NODE_VERSION=20` → `22`.
- Thread the chosen auth method into the containerEnv hook:
  - `src/agents/types.ts` — `containerEnv?(projectPath, env, method?)`.
  - `src/agents/registry.ts` — `agentContainerEnv(agent, projectPath, env?, method?)`
    passes it through.
  - `src/commands/create.ts` — pass the resolved `method` at the call site
    (already in scope next to `agentPreflight`).
- `tests/agents.test.ts`: dispatch test that `agentContainerEnv` threads the
  method; full suite stays green.

## Phase 2 — Copilot agent module + tests

**Status: done (unit-tested 2026-07-21; CLI completion/auth probes pass with an isolated HOME — image build and runtime behavior are Phase 4)**

New folder `src/agents/copilot/` (mirror `src/agents/opencode/`):

- `agent.ts` —
  - exported `copilotProviderSettings(projectPath, env, configFile?)` →
    `{baseUrl?, model?}` per the resolution rules above (injectable
    `configFile` for tests, like `claudeContainerEnv`);
  - exported `copilotContainerEnv(projectPath, env, method?, configFile?)`
    implementing the BYOK-only injection and verbatim `COPILOT_OFFLINE`
    forwarding;
  - `copilotAgent: AgentDefinition<"copilot">` with the three auth methods;
    `preflight` dies loudly (style of opencode's config-file preflight) when
    a BYOK method lacks base URL or model, naming both config channels and
    the `~/.cww/hosts` LAN mapping (never `host.docker.internal` — rootless
    docker); warns when `provider` is chosen but `COPILOT_PROVIDER_API_KEY`
    is set (probably meant `provider-key`);
  - `personalAssets: { skills: "/home/developer/.copilot/skills" }`
    (commands/agents stay unmapped — Claude Code formats);
    `hostSkillsDir: "~/.copilot/skills"`.
- `Dockerfile` — FROM cww-base:latest;
  `npm install -g @github/copilot chrome-devtools-mcp@1.5.0`; bake
  `mcp-config.json` into `/home/developer/.copilot/`;
  `ENV CWW_AGENT_CMD="copilot --allow-all-tools --allow-all-paths --allow-all-urls"`.
- `mcp-config.json` — chrome-devtools entry (`type: local`,
  `--browser-url=http://127.0.0.1:9222`, `tools: ["*"]`).
- `browser-hook.sh` — opencode's, adapted: on `off`,
  `jq 'del(.mcpServers["chrome-devtools"])'` on `~/.copilot/mcp-config.json`.

Registration and supporting edits:

- `src/agents/registry.ts` — import + append `copilotAgent` to `AGENTS`.
- `src/lib/user-config.ts` — optional `providerBaseUrl?` project-config
  field; extend the `model` field comment to claude/copilot.
- `src/commands/auth.ts` — USAGE text: `cww auth copilot`,
  `--method provider-key` example.
- `examples/cww.env.example` — extend the `CWW_AGENT`/`CWW_AUTH` vocabulary;
  new sections for `COPILOT_GITHUB_TOKEN` and BYOK
  (`COPILOT_PROVIDER_BASE_URL=http://llamahost:8080/v1`, `COPILOT_MODEL=`,
  optional `COPILOT_PROVIDER_API_KEY`, the `COPILOT_OFFLINE` note, pointer to
  `~/.cww/hosts`).

Tests:

- `tests/agents.test.ts` — update agent order/labels/images, known-methods
  table, `allAuthEnvKeys` union, builtin-skill dest
  (`/home/developer/.copilot/skills/cww`), personal-asset plan case (skills
  copied, commands/agents skipped); new `describe("copilot provider config")`
  covering resolution precedence, BYOK-only injection, verbatim
  `COPILOT_OFFLINE`, the preflight warn path, and preflight die paths via
  subprocess probes (exit 1, var names in stderr).
- `tests/env-refresh.test.ts` — `sessionAuthKeys` cases: `provider` → `[]`,
  `provider-key` → `["COPILOT_PROVIDER_API_KEY"]`.

## Phase 3 — User docs

**Status: done (2026-07-21)**

- `docs/user-guide.md` — copilot auth-setup section (GitHub token + BYOK
  llamahost example mirroring the opencode section, with the LAN-IP /
  `~/.cww/hosts` / rootless-docker pitfalls); mention copilot in the build,
  choosing-an-agent, config-overrides (`providerBaseUrl`), and skills
  sections.
- `README.md` — agent enumerations, build table, personal-assets paragraph.
- Keep `docs/index.md` statuses in sync.

## Phase 4 — Host-side end-to-end verification

**Status: done (2026-07-21), except the real-model run in step 4**

Run per the repo's verify procedure (isolated HOME, real docker daemon,
scratch repo, teardown after). The llama.cpp host was down, so BYOK was
verified against a **stub OpenAI-compatible server** run inside the workspace
container (`/v1/models` + streaming `/v1/chat/completions` that answers the
first turn with a tool call). That exercises every piece cww owns; what it
cannot prove is that Qwen itself drives Copilot's tool calls well.

1. **Images — done.** `cww build copilot` rebuilt the base on Node 22
   (`cww-base:latest` and all four agent images report `v22.23.1`); the image
   carries `CWW_IMAGE_AGENT=copilot` and the `CWW_AGENT_CMD` flags, with
   `@github/copilot@1.0.73`. `cww build all` + a version smoke test of the
   other three agents (Claude Code 2.1.216, Vibe 2.21.0, OpenCode 1.18.4)
   found no Node-bump regression.
2. **First run — one blocker found and fixed.** The session opened on a
   blocking *"Do you trust the files in this folder?"* dialog, which the
   `--allow-all-*` flags do not cover. Baking `trustedFolders: ["/workspace"]`
   fixes it — but into **`config.json`**, not `settings.json`: with the key in
   `settings.json` the dialog still fires on a genuine first run (the CLI
   migrates it into `config.json` only afterwards). `src/agents/copilot/
   config.json` is now COPYed by the Dockerfile, and the image also sets
   `COPILOT_AUTO_UPDATE=false`. After the fix a fresh workspace lands straight
   on the agent prompt. Remaining first-run chatter is informational only:
   "No copilot-instructions.md found", "GitHub CLI (gh) is not installed" (the
   base image has no `gh` — see the open items).
3. **`github-token` path — wiring verified, model answer not.** No PAT with
   Copilot access was available, so a dummy value was used: `~/.cww/tasks/
   <ws>/env` carried `COPILOT_GITHUB_TOKEN` and nothing else, the container
   saw that key plus `COPILOT_MODEL` and **no** `COPILOT_PROVIDER_BASE_URL` /
   `COPILOT_OFFLINE` even though both were set in `~/.cww/env` (the BYOK-only
   injection rule, which is the thing worth proving), and the CLI reached the
   prompt and rejected the token with GitHub's own "Bad credentials". Re-run
   with a real PAT when one exists.
4. **BYOK path — done, against the stub and then the real model.** With
   `--auth provider`: no task `env` file was generated at all (keyless
   method), `docker-compose.agent.yml` carried exactly
   `COPILOT_MODEL` / `COPILOT_PROVIDER_BASE_URL` / `COPILOT_OFFLINE=true` (and
   later the forwarded knobs), and the workspace's own tmux session completed
   an interactive **tool-using** turn — no permission prompt, model id in the
   status bar, no GitHub login nag.

   Repeated against the llama.cpp host once it was up: `~/.cww/hosts` →
   `llamahost 192.168.1.10` rendered into the container's `/etc/hosts`,
   `curl http://llamahost:8080/v1/models` answered from inside the container
   (llama-server reports model id `local`, `n_ctx` 262144, 34.7B params), and
   the agent drove the shell tool for real — first listing the repo and
   summarizing its README, then a two-tool turn that wrote a file and ran
   `git status`, reasoning steps included. Tool calling against Qwen works;
   nothing cww-side needed changing for it.
5. **`provider-key` — done.** The key landed in the task `env` file; after
   `cww auth copilot --method provider-key` with a new value plus `cww stop` +
   `cww start`, the create-time container env still showed the old value while
   the tmux process environment showed the rotated one — i.e. the start-time
   refresh reached the agent.
6. **Browser wiring — done.** Default create: `copilot mcp list` showed
   `chrome-devtools (local)` and the container's CDP endpoint answered on
   `127.0.0.1:9222`. `CWW_BROWSER=off` create: `~/.copilot/mcp-config.json`
   reduced to `{"mcpServers": {}}`.
7. **Skills — done.** `~/.copilot/skills/{cww,demo}` were both present and
   `copilot skill list` reported them as Personal skills; a `.cww/commands`
   folder produced the expected one-line skip notice.
8. **Teardown — done.** No `cww-repo-*` containers or `repo-*` networks left;
   the developer's own workspaces were untouched.

### Decisions and fix-ups from Phase 4

- ~~BYOK tuning variables are unreachable~~ — **fixed 2026-07-21.** cww
  injected only `COPILOT_MODEL` / `COPILOT_PROVIDER_BASE_URL` /
  `COPILOT_OFFLINE` (+ the method's key), which bites the driving use case:
  the CLI warns *"Model X is not in the built-in catalog. Using defaults for
  prompt tokens …, output tokens …"* for any model id it doesn't know —
  every self-served model — and the only fix is
  `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` / `..._MAX_OUTPUT_TOKENS`.
  `BYOK_PASSTHROUGH_KEYS` in `agent.ts` now forwards those plus `_TYPE`,
  `_WIRE_API`, `_TRANSPORT`, `_MODEL_ID`, `_WIRE_MODEL`, `_HEADERS` and
  `_AZURE_API_VERSION` verbatim from `~/.cww/env`, for BYOK methods only —
  the same channel `COPILOT_OFFLINE` already used. An allowlist rather than a
  `COPILOT_PROVIDER_*` prefix rule, so a typo is visibly absent instead of
  forwarded as a variable the CLI ignores; the key and bearer-token stay off
  it, on the one-secret channel. Whether the defaults would have been
  workable for Qwen is now moot, but worth noting during the llamacpp run.
- ~~`gh` is not in the base image~~ — **decided 2026-07-21: leave it out.**
  Copilot's startup tip about it is cosmetic, not everyone's forge is
  github.com, and a repo that wants `gh` can install it in its own
  `.cww/Dockerfile`.
- ~~Session export/remote control~~ — **decided 2026-07-21: opt out.** The
  CLI exports a GitHub-backed session to GitHub web and mobile (readable
  there, and steerable from there via remote control) unless told not to;
  reading the shipped bundle, it resolves to enabled whenever the account's
  `remoteSessions` capability allows, so a cww session's prompts, replies and
  tool activity could leave the machine with nothing in cww saying so.
  `CWW_AGENT_CMD` now ends in `--no-remote`, which disables export and
  control together. Users who want phone access override `CWW_AGENT_CMD` in a
  `.cww/Dockerfile`. BYOK workspaces were never affected
  (`COPILOT_OFFLINE=true`).
