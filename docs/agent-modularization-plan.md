---
type: plan
title: Agent Modularization Plan
description: Restructure per-agent code and config into one self-contained folder per agent (src/agents/<name>/), so adding a new coding agent touches no shared file
status: done
created: 2026-07-10
timestamp: 2026-07-11
tags: [agents, docker, refactor]
---

# Agent Modularization Plan

**Done 2026-07-11**, with a host Docker pass; the zsh completion was smoke-tested
separately.

## Context

cww supports two coding agents today (`claude`, `vibe`), and their logic and config
are organized by *layer* rather than by *agent*: `src/lib/agents.ts` switches on the
agent name, `docker/Dockerfile` is one multi-stage file with a stage per agent,
`docker/entrypoint.sh` has inline per-agent browser/MCP wiring, and both completion
scripts hardcode the agent list twice each. Adding a third agent means editing ~6
shared files.

The goal: **adding an agent = adding one folder** (plus a one-line registration),
touching no shared file. Each agent folder holds everything that defines it — its
TypeScript definition (label, auth preflight, asset materialization), its Dockerfile,
and its baked config files.

Decision made up front: the Docker build is fully split too, not just the TypeScript
side. A shared base image is built once and tagged locally (`cww-base:latest`); each
agent gets its own self-contained Dockerfile that starts `FROM cww-base:latest` —
rather than keeping one multi-stage Dockerfile that every new agent must append to.

## Target layout

```
src/agents/
  types.ts             # AgentDefinition interface
  registry.ts          # single source of truth: CWW_AGENTS / Agent union, dispatch fns
  claude/
    agent.ts               # AgentDefinition (label, preflight, materializeAssets)
    Dockerfile             # FROM cww-base:latest ...
    claude-onboarding.json # extracted from today's inline printf (~/.claude.json)
    settings.json          # extracted from today's inline printf (~/.claude/settings.json)
    statusline.sh          # moved from docker/statusline.sh
    browser-hook.sh        # new — claude's half of entrypoint's browser wiring
  vibe/
    agent.ts
    Dockerfile
    vibe-mcp.toml          # moved from docker/vibe-mcp.toml
    browser-hook.sh        # new — vibe's half of entrypoint's browser wiring
docker/
  base/
    Dockerfile             # today's `base` stage, extracted; tagged cww-base:latest
    entrypoint.sh          # moved; browser wiring becomes agent-agnostic (see below)
    cww-browser.sh         # moved, unchanged
    cww-prompt.sh          # moved, unchanged
    .dockerignore          # replaces docker/.dockerignore (base files only)
```

`templates/tmux.conf` stays put; the pre-build staging copy targets
`docker/base/tmux.conf` instead of `docker/tmux.conf`.

## Design

### Base image build + tagging

The base is tagged `cww-base:latest` — a plain local tag, never referenced by
compose templates or shown to users in `cww list`. `buildAgentImage(agent)` always
rebuilds the base first, then builds the agent image from `src/agents/<agent>/` as
build context. No freshness tracking: Docker's layer cache makes a no-op base
rebuild take a second or two, which is cheaper and safer than any staleness check
(same philosophy as the existing unconditional `tmux.conf` staging).

The build logic is split functional-core/imperative-shell so it is testable
without Docker (the dev workspace itself has no docker CLI): a pure
`agentBuildPlan(agent)` returns the ordered build steps as data —
`[{tag: "cww-base:latest", context: "docker/base"}, {tag: "coder-workspace-workflow:<id>", context: "src/agents/<id>"}]`
— and `buildAgentImage` is a thin executor that runs `docker build` over the
plan (plus the tmux.conf staging). Tests assert the plan (ordering, tags,
contexts) the same way existing tests cover other exported pure helpers.

The base Dockerfile keeps its existing ARGs (`NODE_VERSION`, `JAVA_VERSION`, `TZ`,
`TARGETARCH`, `USER_UID`, `USER_GID`). Agent Dockerfiles need none of them — they
consume the already-built base's environment and `developer` user. `TARGETARCH` is
only read by the base stage today, so splitting into two builds changes nothing.
`FROM cww-base:latest` resolves against the local image store under both BuildKit
and the classic builder — no new minimum Docker version.

### Per-agent Dockerfiles are self-contained

Neither agent stage today COPYs anything outside its own files (claude:
`statusline.sh`; vibe: `vibe-mcp.toml`), so each agent folder works as its own build
context with no cross-folder access. Claude's inline `printf`-baked JSON configs
become real files (`claude-onboarding.json`, `settings.json`) COPY'd in —
functionally identical, easier to review. Agent folders need no `.dockerignore`
(tiny, purpose-built folders).

### Agent-agnostic entrypoint via browser-hook.sh

Each agent Dockerfile sets `ENV CWW_IMAGE_AGENT=<name>` — an inspection marker
only, nothing reads it at runtime. It is deliberately NOT named `CWW_AGENT`:
that is already a host-side config variable (`~/.cww/env`), and the compose
template injects that whole file into every container via `env_file`, whose
values override image `ENV` — so a baked `CWW_AGENT=claude` would read `vibe`
at runtime for a user with `CWW_AGENT=vibe` in `~/.cww/env`.

Each agent Dockerfile also ships a `browser-hook.sh` to
`/usr/local/share/cww/browser-hook.sh` (COPY + chmod in the agent's own Dockerfile).
The base `entrypoint.sh` browser section becomes:

1. Resolve `mode` = `off` if `CWW_BROWSER` matches `off|0|false|no`, else `on`
   (same predicate as today).
2. If `on`: launch the shared `cww-browser` stack in the background (unchanged).
3. Regardless of mode, if `/usr/local/share/cww/browser-hook.sh` exists, call it
   once with the resolved mode as `$1`. Hook failures warn but never kill the boot.

Claude's hook acts only on `off` (jq-strips the baked `chrome-devtools` entry from
`~/.claude.json`); vibe's hook acts only on `on` (grep-guarded append of
`vibe-mcp.toml` to `~/.vibe/config.toml`, plus the shadow-warning when the repo
commits its own `.vibe/config.toml`). This reproduces current behavior exactly —
each hook must stay idempotent across container restarts.

### AgentDefinition and the registry

```typescript
// src/agents/types.ts
export interface AgentDefinition<Id extends string = string> {
  id: Id;                                   // "claude" as const
  label: string;                            // "Claude Code"
  preflight(projectPath: string, env: Record<string, string | undefined>): void;
  materializeAssets?(projectPath: string, container: string): Promise<void>;
}
```

`registry.ts` holds one array — the single registration point:

```typescript
const AGENTS = [claudeAgent, vibeAgent] as const;
export type Agent = (typeof AGENTS)[number]["id"];   // "claude" | "vibe" (literal union)
export const CWW_AGENTS: readonly Agent[] = AGENTS.map((a) => a.id);
```

A `Map` over `AGENTS` replaces every switch statement. The registry exports the same
function names `src/lib/agents.ts` exports today (`validateAgent`, `resolveAgent`,
`agentImage`, `agentLabel`, `agentPreflight`, `buildAgentImage`, `ensureAgentImage`,
plus `getCwwDir` re-exported and `materializeCwwAssets` moved in from
`src/lib/docker.ts`), so consumers only change an import path.

Import-cycle guard: `docker.ts` will import `CWW_AGENTS` from the registry,
and the registry evaluates the agent modules at load time — so `claude/agent.ts`
must not import `docker.ts` back. The generic docker-cp/chown plumbing that
`materializeAssets` needs therefore moves to its own leaf module
(`src/lib/container-fs.ts`) instead of staying in `docker.ts`.

The registry-level `materializeCwwAssets` dispatcher keeps the current
behavior for agents without a `materializeAssets` hook: when the project has
`.cww/{skills,commands,agents}` dirs, it still prints the "Claude
Code-specific; skipped for <agent>" info message (today it lives inside the
`docker.ts` function).

Deliberately not modeled: a per-agent `imageTag` field (every agent's image is
`coder-workspace-workflow:<id>`; add the field when an agent actually needs
otherwise), and the `"claude"` default in `resolveAgent` stays an explicit literal —
it's policy, not list order. A *project* image layer does exist now — a repo's
optional `.cww/Dockerfile` builds a separate `cww-project-<name>:<agent>` image
stacked on top of the agent image (`src/lib/project-image.ts`); the agent tags
themselves remain fixed.

Also deliberately deferred: a `ContainerRuntime` abstraction (docker as one
implementation; macOS's `container` as a possible future one; a mock for
tests). Worth doing, but as its own follow-up refactor: cww depends on docker
*compose* semantics (generated compose files, `env_file` overrides,
`com.docker.compose.project` labels, `{{.Ports}}` parsing), so the boundary is
the orchestration layer, not the binary name — an interface designed now with
only docker behind it would just mirror docker. This refactor helps it along
anyway by concentrating per-agent knowledge in the registry; unit-testability
of the build logic is covered more cheaply by `agentBuildPlan` above.

### Dynamic completions

`src/commands/complete.ts` gains a `case "agents"` printing `CWW_AGENTS` (no I/O,
stays fast — same contract as the existing `workspaces` topic). Both completion
scripts drop their hardcoded `claude vibe` lists and shell out to
`cww __complete agents`, mirroring the existing `_cww_workspaces()` pattern; the
`build` completion unions in the literal `all`.

## File inventory

**Create:** `src/agents/types.ts`, `src/agents/registry.ts`,
`src/agents/claude/{agent.ts, Dockerfile, claude-onboarding.json, settings.json, browser-hook.sh}`,
`src/agents/vibe/{agent.ts, Dockerfile, browser-hook.sh}`,
`docker/base/{Dockerfile, .dockerignore}`,
`src/lib/container-fs.ts` (docker-cp/chown plumbing extracted from
`docker.ts` — see the import-cycle guard above).

**Move:** `docker/{entrypoint.sh, cww-browser.sh, cww-prompt.sh}` → `docker/base/`;
`docker/statusline.sh` → `src/agents/claude/`; `docker/vibe-mcp.toml` →
`src/agents/vibe/`.

**Delete:** `docker/Dockerfile`, `docker/.dockerignore`, `src/lib/agents.ts`.

**Edit:**
- `src/lib/docker.ts` — remove `materializeCwwAssets` (claude body moves to
  `claude/agent.ts`; the generic docker-cp/chown plumbing moves to
  `src/lib/container-fs.ts` so agent modules never import `docker.ts` back);
  switch `findAnyCwwImage`'s hardcoded `["claude", "vibe", "latest"]` to
  `[...CWW_AGENTS, "latest"]`.
- `src/commands/build.ts` — import path only
  (`../lib/agents` → `../agents/registry`).
- `src/commands/create.ts` — same path swap, plus `materializeCwwAssets`
  moves from the `../lib/docker` import block to the registry import (not
  import-path-only).
- `src/commands/complete.ts` — add the `agents` topic.
- `completions/_cww`, `completions/cww.bash` — dynamic agent completion; also
  reword `_cww`'s `build` command description, which hardcodes
  "(claude | vibe)" in its help string (a third stale spot beyond the two
  completion lists).
- `docker/base/entrypoint.sh` — besides the browser-hook rewrite, update the
  `CWW_AGENT_CMD`-missing error message, which tells the user to run
  `docker build --target <agent>` — a flag that no longer exists after the
  split.
- `install.sh` — copy `docker/base/*` (agent folders ride the existing
  `cp -R src/.`); stage `tmux.conf` into `docker/base/`; replace the single
  `docker build --target` with base-then-agent builds. The
  `coder-workspace-workflow:latest` alias keeps its exact current semantics:
  it is applied only when the agent being built is `claude` (latest *means*
  the claude image, for compose files that predate per-agent tags) — NOT
  "whatever the default agent is".
- `README.md`, `docs/user-guide.md` — update the passages describing the
  multi-stage `docker/Dockerfile` to point at `docker/base/Dockerfile` (shared
  changes) vs `src/agents/<name>/Dockerfile` (agent-specific).

**Tests:** new `tests/agents.test.ts` (`validateAgent`, `resolveAgent` precedence,
`agentLabel`, `agentImage`, `CWW_AGENTS` contents, and `agentBuildPlan`
ordering/tags/contexts); extend `tests/complete.test.ts` for the `agents`
topic. `tests/{list,session,env}.test.ts` need no changes.

## Rollout order

Each step keeps `bun test` / `bun run typecheck` green:

1. Add `src/agents/{types,registry}.ts` + both `agent.ts` files alongside the
   existing `src/lib/agents.ts` (nothing consumes the registry yet).
2. Split the Dockerfiles: create `docker/base/Dockerfile` and both agent
   Dockerfiles; **copy** (not move) the shared scripts and per-agent files
   into their new homes; extract claude's inline JSON into real files. The
   originals stay put so the old `docker/Dockerfile` build — which `cww build`
   uses until step 4 — keeps working; they are deleted in step 5.
3. Rewrite the entrypoint's browser section to the hook dispatch; add both
   `browser-hook.sh` scripts; wire `ENV CWW_IMAGE_AGENT` + COPY/chmod into the
   agent Dockerfiles.
4. Switch `registry.ts`'s `buildAgentImage` to the two-step base+agent build.
5. Flip `create.ts`/`build.ts` imports; move `materializeCwwAssets` (plumbing
   to `container-fs.ts`); delete `src/lib/agents.ts`, `docker/Dockerfile`,
   `docker/.dockerignore`, and the step-2 originals under `docker/` — nothing
   references the old build context anymore.
6. Add `cww __complete agents`; update both completion scripts; add/extend tests.
7. Update `install.sh`, `README.md`, `docs/user-guide.md`.

## Verification

Development happens inside a cww workspace with no docker CLI, so verification
splits by where it can run.

In-workspace (agent-verifiable, every step):

- `bun test` and `bun run typecheck` pass, including the new tests
  (`agentBuildPlan` covers build ordering/tags/contexts without Docker).
- `cww __complete agents` prints the agent list.
- Shell-level review of the Dockerfiles, entrypoint, and hooks (e.g.
  `bash -n` the scripts).

Host-side (needs Docker; run by the developer at steps 4 and 7):

- `cww build claude`, `cww build vibe`, `cww build all` succeed;
  `docker image inspect` shows `CWW_IMAGE_AGENT` / `CWW_AGENT_CMD` on each
  agent image.
- `cww create` a real workspace per agent: preflight, boot, tmux session, and (for
  claude) `.cww/{skills,commands,agents}` materialization all work.
- Browser on/off per agent via `docker exec`: MCP entry present in `~/.claude.json`
  when on, stripped when `CWW_BROWSER=off`; vibe's `~/.vibe/config.toml` gets the
  block exactly once across restarts; the committed-`.vibe/config.toml`
  shadow-warning still fires.
- `--agent` and `build` tab-completion works in a live shell.

### Host test checklist

Concrete pass for the host-side items above. Containers are named
`cww-<project>-<workspace>`; substitute accordingly.

**Setup** — the full installer must run once: it wipes `$INSTALL_DIR/docker`
into the new base-only layout (a plain `cww build` against a stale install
would miss the new build context).

```bash
git pull && ./install.sh
```

- [ ] `install.sh` builds `cww-base:latest` then the default agent's image;
      with default claude, `coder-workspace-workflow:latest` exists as its alias.

**Builds**

```bash
cww build claude && cww build vibe && cww build all
docker image inspect coder-workspace-workflow:claude | grep -E 'CWW_IMAGE_AGENT|CWW_AGENT_CMD'
docker image inspect coder-workspace-workflow:vibe   | grep -E 'CWW_IMAGE_AGENT|CWW_AGENT_CMD'
```

- [ ] All three build commands succeed; `docker images` shows `cww-base`
      alongside the per-agent images.
- [ ] Each agent image carries its own `CWW_IMAGE_AGENT` and `CWW_AGENT_CMD`.

**Workspaces** (from a test repo)

```bash
cww create smoke-claude --agent claude --no-attach
cww create smoke-vibe   --agent vibe   --no-attach
```

- [ ] Preflight, boot, and the tmux session work for both agents.
- [ ] With a `.cww/skills` dir in the project: claude create prints
      "Loaded personal .cww/skills ..."; vibe create prints the
      "Claude Code-specific; skipped for vibe" notice.

**Browser wiring** (hook behavior + idempotence across restarts)

```bash
# claude, browser on (default): entry present
docker exec cww-<project>-smoke-claude jq '.mcpServers | keys' /home/developer/.claude.json
# claude, browser off: entry stripped, and still stripped after a restart
CWW_BROWSER=off cww create smoke-claude-nobrowser --agent claude --no-attach
docker exec cww-<project>-smoke-claude-nobrowser jq '.mcpServers | keys' /home/developer/.claude.json
docker restart cww-<project>-smoke-claude-nobrowser && sleep 3
docker exec cww-<project>-smoke-claude-nobrowser jq '.mcpServers | keys' /home/developer/.claude.json
# vibe, browser on: block appended exactly once, also after a restart
docker exec cww-<project>-smoke-vibe grep -c 'name = "chrome-devtools"' /home/developer/.vibe/config.toml
docker restart cww-<project>-smoke-vibe && sleep 3
docker exec cww-<project>-smoke-vibe grep -c 'name = "chrome-devtools"' /home/developer/.vibe/config.toml
```

- [ ] claude on: `chrome-devtools` present; off: absent, container boots fine,
      restart keeps it absent.
- [ ] vibe on: grep count is `1` before AND after the restart.
- [ ] Bonus (repo committing its own `.vibe/config.toml` without
      chrome-devtools): `docker logs` of a vibe workspace shows the two
      `[cww] NOTE:` shadow-warning lines.

**Completions** (in a NEW shell, bash and zsh — the workspace could not
syntax-check `_cww`, zsh isn't installed there)

- [ ] `cww __complete agents` prints `claude` and `vibe`.
- [ ] `cww create --agent <TAB>` offers claude/vibe; `cww build <TAB>` offers
      claude/vibe/all.

**Cleanup**

```bash
cww teardown smoke-claude -y && cww teardown smoke-vibe -y && cww teardown smoke-claude-nobrowser -y
```

When everything passes: flip this doc's `status` to `done` (and the index
line to match).

## Risks

- `cww-base:latest` is an unnamespaced local tag; an unrelated same-named image
  would be silently overwritten (and, conversely, silently used as our base if
  it exists when ours was never built). Acceptable for a local dev tool; noted
  in a comment where the tag is defined.
- If the base image is absent, `FROM cww-base:latest` does not fail cleanly:
  BuildKit falls back to pulling `docker.io/library/cww-base` and dies with a
  confusing registry error. cww's own path is safe (`buildAgentImage` always
  builds the base first), but each agent Dockerfile gets a header comment
  telling anyone building the folder by hand to build `docker/base/` first.
- `docker.ts` importing the registry while the registry loads the agent
  modules is one import away from a cycle; the `container-fs.ts` extraction
  (see Design) is what keeps agent modules from importing `docker.ts` back.
  Any future agent module must respect that rule.
- The entrypoint hook dispatch is the main correctness risk: the hook must run
  exactly once per boot (easy to double-invoke when converting the `case` block).
  Covered explicitly in verification.
- `docker images` now shows an internal `cww-base` image alongside the per-agent
  ones — harmless; never auto-remove it (it's the shared cache root).
