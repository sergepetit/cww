---
type: guide
title: cww User Guide
description: Full user documentation — installation, authentication, every command, the Docker image, project services, the built-in browser, configuration, and troubleshooting
timestamp: 2026-07-14
---

# cww User Guide

Full documentation for Coder Workspace Workflow. For the quick pitch and a 5-minute setup, see the [README](../README.md).

- [Installation](#installation)
- [Authentication setup](#authentication-setup)
- [Updating](#updating)
- [Commands](#commands)
- [Directory structure](#directory-structure)
- [Docker image](#docker-image)
- [tmux keys](#tmux-keys)
- [Project-specific services](#project-specific-services)
- [Accessing the app in a browser](#accessing-the-app-in-a-browser)
- [Configuration](#configuration)
- [Workflow example](#workflow-example)
- [Troubleshooting](#troubleshooting)

## Installation

```bash
git clone https://github.com/sergepetit/cww.git
cd cww
./install.sh
```

The installer will:
1. Copy files to `~/.local/share/coder-workspace-workflow/`
2. Create a launcher at `~/.local/bin/cww`
3. Build the Docker image
4. Set up tab completion for bash and zsh (commands, flags, and workspace names), registering it in your login shell's rc file

Make sure `~/.local/bin` is in your PATH.

**Prerequisites:** Docker, Git, [Bun](https://bun.sh) (the installer offers to install it if missing).

### Rootless Docker (recommended)

On Linux, run cww on [rootless Docker](https://docs.docker.com/engine/security/rootless/). Because the in-container agent runs with `--dangerously-skip-permissions` — free to keep working while you're away — cww's safety rests on the container boundary. Rootless strengthens that boundary: the daemon and every workspace container run under your unprivileged host user via a user namespace, so even a container escape lands as an ordinary user — never host root.

The default flow needs no special configuration: cww drives Docker through the `docker` CLI (inheriting your rootless context / `DOCKER_HOST`), the agent container publishes no host ports, and services use the container-port-only form so Docker assigns high, unprivileged host ports.

The one wrinkle is the opt-in [dependency-cache mounts](#dependency-caches-opt-in): under rootless a host cache dir appears **root-owned inside the container**, so the non-root `developer` user can't write it and `npm install` fails with `EACCES`. Use [`cww cache`](#cww-cache-preset--name-container-path) to provision the cache dir — it sets the ownership `developer` needs. (This isn't unique to rootless; the in-container `developer` UID never matches your host user, so `cww cache` handles both modes.)

## Authentication setup

You need two things: auth for the agent you use, and a git token. Agent auth lives in `~/.cww/env` (mode 600), which is passed into every container — `install.sh` seeds this file from `examples/cww.env.example` on first install. The git side is handled by the setup flow the first `cww create` runs (see [point 2](#authentication-setup) below).

**1a. For the claude agent (the default) — a Claude OAuth token** so Claude Code can run:

```bash
# Generate token (opens browser for login)
claude setup-token

mkdir -p ~/.cww
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> ~/.cww/env
chmod 600 ~/.cww/env
```

The token uses your existing Claude subscription (Pro, Max, etc.) and is the **only** auth the container uses — cww does not copy your host Claude login into the container (as of this writing, a copied credential is unsupported across machines and can silently fall back to metered API billing). `cww create` refuses to launch a claude workspace without the token. Onboarding state and settings are baked into the image, so the container comes up straight at the prompt.

**1b. For the vibe agent — a Mistral API key** so Mistral Vibe can run:

```bash
echo 'MISTRAL_API_KEY=...' >> ~/.cww/env    # get one at https://console.mistral.ai
```

Alternatively, commit a `.vibe/config.toml` to the repo with a `[[providers]]` entry for a local or other OpenAI-compatible endpoint — it rides the clone into the container, and `cww create --agent vibe` then proceeds without the key (with a warning).

**1c. For the opencode agent — a provider API key.** OpenCode is provider-agnostic and auto-detects whichever key is set; any ONE of these works:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.cww/env
# or OPENAI_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY (OpenCode Zen)
```

A Claude Pro/Max subscription can **not** be used — OpenCode removed Claude OAuth login (v1.3.0, per Anthropic's terms), so Anthropic access is metered API billing via `ANTHROPIC_API_KEY`.

Alternatively, run on a **local model** with no key at all, via a custom provider config in a real JSON file — machine-wide in `~/.cww/opencode.json`, or per-project in `<repo>/.cww/opencode.json` (personal and host-side like the rest of `.cww/`, usually gitignored; if both exist the project file wins, with no merging between them). `cww create --agent opencode` validates the file host-side — strict JSON, so a typo fails the create loudly with the file and position instead of a silent in-container exit — injects it into the workspace, and proceeds without a key (with a warning). OpenCode merges it *last*, over the workspace's baked config and over a repo-committed `opencode.json` (committing one is the third, team-level option: it rides the clone into the container). See `examples/opencode.json.example` for a starting point. For a llama.cpp `llama-server` running on the Docker host, the config is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama-server (local)",
      "options": { "baseURL": "http://llamahost:8080/v1" },
      "models": { "your-model-id": { "name": "Your model" } }
    }
  },
  "model": "llama.cpp/your-model-id"
}
```

In `baseURL`, point at the Docker host's **LAN IP** — or better, map a name to it in `~/.cww/hosts` (`llamahost 192.168.1.10`, name first) and use that name, so the JSON never changes when the IP does. Two name pitfalls to avoid: the host's own hostname typically resolves to `127.0.1.1` inside containers (the host's `/etc/hosts` self-entry leaks through Docker's DNS forwarding, and loopback there is the *container*), and the oft-cited `host.docker.internal` + `host-gateway` mapping does **not** work under [rootless Docker](#rootless-docker-recommended) — rootlesskit forwards published ports on the host's real interfaces only, so nothing listens on the gateway IP. Tips: keep the llama-server model id stable across model swaps with `llama-server --alias <id>`, and set the model's `limit.context` to the served `n_ctx` (see `/v1/models`) so OpenCode compacts before overrunning the window.

The file is read at `cww create` time (like `~/.cww/hosts` and `~/.cww/env`): edits apply to the *next* created workspace, not running ones. Legacy escape hatch: a one-line `OPENCODE_CONFIG_CONTENT={...}` in `~/.cww/env` still works when no config file exists — the file wins over it when both are present (cww warns).

**2. A git token** so the container can clone the repo — and so you (or the agent) can commit and push over HTTPS from inside it. Nothing to prepare: **the first `cww create` in a repo runs the setup flow** — it shows the clone URL workspaces will use (derived from a remote — accept it, or type the exact URL for a self-hosted forge on plain http or a non-443 port), prompts for your platform login and a token (hidden input), and **validates the pair with a real `git ls-remote` before saving anything**. `cww init` re-runs the same flow whenever you need it (token rotation, URL change) and adds a preflight of everything else a `cww create` needs (docker, agent auth, agent image).

Setup writes two files:

- `~/.cww/credentials` (mode 600) — the tokens, one entry per repo or per host in git's own `~/.git-credentials` format:

  ```
  https://<user>:<token>@<host>[/<org>/<repo>]
  ```

  `user:token` is used as HTTP basic auth and works with GitHub (classic/fine-grained PATs), Forgejo, and Gitea — use your **login username** for Forgejo/Gitea, `x-access-token` for GitHub fine-grained/App tokens. Make it a **fine-grained PAT scoped to the one repo** (contents read/write) where the platform supports it; `cww create` injects only the entry matching the workspace's clone URL, so a workspace never sees another repo's token. To share one token across a whole forge, hand-edit the entry down to `https://user:token@host`. Rotating a token = re-run `cww init` (existing workspaces pick it up when recreated).

- `~/.cww/config.json` — per-project settings keyed by the repo's absolute path: the clone URL, plus optional `"agent"`, `"browser"`, and `"skill"` overrides of the `~/.cww/env` globals:

  ```json
  {
    "projects": {
      "/home/dev/work/api": {
        "repoUrl": "http://forgejo.example:3000/org/api.git",
        "remote": "origin",
        "agent": "opencode"
      }
    }
  }
  ```

Clone URL details: the suggestion is inferred from your `origin` remote (SSH remotes are rewritten to https — SSH keys are not mounted into containers); the URL you confirm at setup is what later creates use. `cww create --remote <name>` naming the *same* remote the entry was set up for keeps using the configured URL (with your corrections); a *different* remote is derived fresh for that invocation. A **public repo** needs no token: leave the token prompt empty and setup verifies anonymous access instead (pushes from inside a workspace will still need a credential — add one later with `cww init`).

Setup also **verifies the URL from inside a container** (a throwaway `git ls-remote` with the same `/etc/hosts` extras a workspace gets — skipped until a cww image is built). This catches the classic self-hosted trap: a name like `forgejo.local` that resolves on your machine (via `/etc/hosts`, mDNS, or an ssh alias) but not through container DNS. When that's the diagnosis, setup offers to append the mapping to `~/.cww/hosts` for you, using the address your host resolves.

## Updating

```bash
cd cww
git pull
./install.sh
```

## Commands

A **workspace** is the unit cww manages, identified by a **name you choose** (not a branch). Git inside the workspace is entirely yours — cww imposes no branching, push, or PR workflow.

### `cww init [project-path] [options]`

Explicitly (re)run a repo's setup flow and preflight the machine. The first `cww create` in a repo runs the same setup by itself, so init is for the deliberate cases: **rotating a token** (fine-grained PATs expire), changing the clone URL, pinning a per-project agent, or checking a box is ready without creating anything. It confirms the clone URL (stored in `~/.cww/config.json`), prompts for your git login and token with hidden input, **validates the pair with `git ls-remote` before saving** it to `~/.cww/credentials`, then checks docker, the agent's auth, and the agent image, ending in a ✓/✗ summary. `--remote <name>` derives the URL from a non-origin remote; `--agent <name>` picks which agent to preflight and records it as the project's default. Details in [Authentication setup](#authentication-setup).

```bash
cww init                       # From within the repo
cww init --remote upstream     # Clone URL from a different remote
```

### `cww create [project-path] <workspace-name> [options]`

Create a workspace: a fresh container that clones your repo and brings up the app's services, with a coding agent running in tmux. **The first create in a repo runs the setup flow inline** (clone URL + validated git token — see [Authentication setup](#authentication-setup)); later creates reuse the stored config. By default it checks out the host's current branch; `--branch <ref>` (alias `--ref`) overrides it, and a name that doesn't exist upstream is created as a fresh branch. On create it also runs the project's optional `.cww/reset.sh` (if present), loads the [built-in workspace skill](#the-built-in-workspace-skill), copies your personal `.cww/skills/` into the container for whichever agent — plus `.cww/{commands,agents}/` for claude (see [Skills, commands, and agents](#skills-commands-and-agents-two-tiers)) — and auto-provisions any [dependency-cache](#dependency-caches-opt-in) dir the services file declares.

`--agent <claude|vibe|opencode>` picks the coding agent (default: the project's `"agent"` in `~/.cww/config.json`, then `CWW_AGENT` from `~/.cww/env`, falling back to `claude`). The choice is recorded in the workspace's metadata: re-creating the workspace after its container was removed brings back the *same* agent, and switching agents means teardown + create.

```bash
cww create feature-auth               # From within a git repo (workspace named "feature-auth")
cww create . feature-auth             # Explicit current directory
cww create /path/to/project bugfix    # With full project path
cww create review --branch main       # Check out main instead of the host's current branch
cww create sandbox --agent vibe       # Run Mistral Vibe instead of the default agent
cww create sandbox --agent opencode   # ... or OpenCode
cww create feature-auth --no-attach   # Create without attaching to tmux
```

### `cww shell [workspace-name]`

Open a plain login shell (as user `developer`, in `/workspace`) inside the workspace container. This is how a human runs git, inspects services, or pokes around — it does **not** touch the agent (that runs in a separate tmux session; use `cww attach` for it). Restarts the container if it was stopped.

```bash
cww shell feature-auth    # By workspace name
cww shell                 # From the repo directory (single workspace)
```

Every workspace command below accepts the same argless form: run from inside the project repo, it resolves the repo's workspace automatically — but only when the repo has **exactly one**. With several workspaces for the same repo the argless form refuses as ambiguous; pass the workspace name.

### `cww attach [workspace-name]`

Attach to the workspace's agent tmux session (Claude Code, Mistral Vibe, or OpenCode — whichever the workspace was created with).

```bash
cww attach feature-auth    # By workspace name
cww attach                 # From the repo directory (single workspace)
```

### `cww start [workspace-name]`

Resume a stopped workspace — bring its container and services back up (the inverse of `cww stop`), without attaching. Use `cww create` to make a *new* workspace; `cww attach`/`cww shell` also resume a stopped one on their way in.

```bash
cww start feature-auth    # By workspace name
cww start                 # From the repo directory (single workspace)
```

### `cww stop [workspace-name]`

Stop the container without removing the workspace (pause work). The container's filesystem — including the cloned repo and any commits — survives. Resume it with `cww start` (or `cww attach`/`cww shell`, which start it on their way in).

```bash
cww stop feature-auth    # By workspace name
cww stop                 # From the repo directory (single workspace)
```

### `cww reset [workspace-name]`

Re-run the project's `.cww/reset.sh` inside the workspace to reset and reseed service data. No-op if the project has no `.cww/reset.sh` (see [Project-specific services](#project-specific-services)).

```bash
cww reset feature-auth    # By workspace name
cww reset                 # From the repo directory (single workspace)
```

### `cww teardown [workspace-name] [-y|--yes]`

Remove the workspace and everything it created: the agent container, service containers, the network, this workspace's volumes, and its host metadata. It is **destructive** and **pushes nothing** — push anything worth keeping first (via `cww shell` then `git push`, or from the agent). Prompts for confirmation unless `-y`. `down` is an alias.

```bash
cww teardown feature-auth       # By workspace name (prompts)
cww teardown                    # From the repo directory (single workspace)
cww teardown feature-auth -y    # Skip the confirmation prompt
```

### `cww list`

List all workspaces. The **PORTS** column shows each workspace's published bindings as `container->host` (e.g. `5174->49153`), covering the agent container and every service in the stack (empty unless the workspace is running). The host port may be one Docker auto-assigned — see [Project-specific services](#project-specific-services).

```bash
cww list           # Table format
cww list --json    # JSON format
```

### `cww tunnel-command [workspace-name] [options]`

Print the `ssh -N -L …` command that forwards a running workspace's published ports to the `localhost` of the machine you run it on — another machine, or the Docker host itself (an SSH tunnel to self works fine). Emits one `-L` per binding in `cww list`'s PORTS column, aimed at the **container** port on your side (`-L <container>:localhost:<host>`).

```bash
cww tunnel-command feature-auth                     # By workspace name
cww tunnel-command                                  # From the repo directory (single workspace)
cww tunnel-command feature-auth --host me@dev-box   # Override the SSH target
```

The SSH target defaults to `$USER@$(hostname -f)` (this machine); use `--host` to override it. Because the local side is the stable container port (not the possibly-ephemeral host port), you get **one fixed `localhost:<container-port>` origin** across every workspace — a browser [secure context](#accessing-the-app-in-a-browser) that stays constant even as Docker assigns different host ports per workspace.

### `cww cache <preset> | <name> <container-path>`

Provision a persistent, shared dependency-cache directory under `~/.cww/cache/` and set its ownership so a workspace's in-container `developer` user can write it (see [Dependency caches](#dependency-caches-opt-in) for the why). It creates the dir, `chown`s it via a throwaway root container (no host `sudo`; correct under rootless and rootful), and prints the volume line to add to your project's `.cww/docker-compose.services.yml`. The ownership persists across teardown, so every workspace — even a fresh one — shares the same cache.

Built-in presets (host dir under `~/.cww/cache/` → container path): `npm`, `m2`, `ivy2`, `sbt`, `coursier`, `gradle`. For anything else, give a `<name>` and the absolute `<container-path>` to mount it at.

```bash
cww cache npm                             # provision the npm cache
cww cache npm --from ~/.npm/_cacache      # ... primed from your existing host cache
cww cache m2                              # Maven repository cache
cww cache pip .cache/pip /home/developer/.cache/pip   # a custom cache
```

`--from <dir>` optionally warm-starts the cache by copying an existing dir's contents (one-shot).

### `cww build [agent|all]`

Build or rebuild a per-agent Docker image. With no argument it builds the configured default agent's image (`CWW_AGENT` in `~/.cww/env`, falling back to `claude`); `all` builds every agent.

```bash
cww build            # the default agent's image
cww build vibe       # coder-workspace-workflow:vibe
cww build opencode   # coder-workspace-workflow:opencode
cww build all        # every agent
```

## Directory structure

Your project repo is never modified or used as a worktree. Per-workspace state lives in a global metadata directory on the host, and the actual checkout lives inside the container:

```
/path/to/project/              # Your original repo (untouched)

~/.cww/
  env                          # Global env forwarded to containers (agent auth, defaults)
  credentials                  # Git tokens, one per repo/host (git-credentials format, mode 600)
  config.json                  # Per-project settings (clone URL, agent/browser overrides)
  tasks/                       # Global per-workspace metadata (host side)
    myproject-feature-auth/       # One dir per project+workspace
      session.json             # Workspace metadata (workspace name + checked-out branch)
      env                      # This repo's git credential, injected into the container (mode 600)
      docker-compose.yml       # Generated compose file
      docker-compose.hosts.yml # (optional) extra_hosts override
      docker-compose.browser.yml # (unless the browser is off) publishes the built-in browser's noVNC port

# Inside the container:
/workspace                     # Fresh clone of your repo, on the checked-out branch
```

## Docker image

There is one image per coding agent, layered on a shared base image: `docker/base/Dockerfile` builds the common environment (tagged `cww-base:latest`, a local-only tag), and each agent's self-contained `src/agents/<name>/Dockerfile` builds `FROM` it, installing the agent's CLI and baking its config. `cww build [claude|vibe|opencode|all]` builds them — always base first, then the agent (a no-op base rebuild takes seconds thanks to the layer cache); a missing image is also offered for building on first `cww create --agent <name>`.

The shared base includes:
- Ubuntu 24.04 (shell is bash)
- Node.js 20
- Bun (so cww itself can be developed in a workspace)
- Java 25 (Eclipse Temurin)
- Google Chrome (amd64) / Chromium (arm64, via the xtradeb PPA) + Xvfb + noVNC — the [built-in headful browser](#built-in-headful-browser) the agent drives and you can watch/take over
- tmux, git, fzf, ripgrep, fd, jq, and common dev tools

Deliberately *not* included: compilers (`build-essential`) and build tools like sbt — and no baked Playwright: a project that uses it installs its own version-matched copy, like any dependency. The agent has passwordless sudo and installs tools on demand (`sudo apt-get install build-essential`, or fetches sbt/coursier); the [`cww cache`](#cww-cache-preset--name-container-path) sbt/coursier/gradle presets still apply once it does. If your projects always need such tools, bake them into the image — the Dockerfile, like the rest of cww, is meant to be adapted (see [Make it yours](../README.md#make-it-yours) in the README).

> **Note:** Google ships the Chrome `.deb` for amd64 only; arm64 hosts (e.g. Apple Silicon Macs building natively) get Chromium from the xtradeb PPA instead — same headful stack, same CDP port. The PPA is apt-pinned so only `chromium*` packages can come from it.

The agent images add Claude Code (npm), Mistral Vibe (pipx), or OpenCode (npm) respectively. There's no per-project image hook — every workspace of a given agent shares that agent's image. To add languages or tools for all agents, edit `docker/base/Dockerfile` and rebuild with [`cww build`](#cww-build-agentall); for one agent only, edit that agent's `src/agents/<name>/Dockerfile`.

## tmux keys

The container uses tmux with these key bindings:

| Key | Action |
|-----|--------|
| `Ctrl-a d` | Detach from session |
| `Ctrl-a \|` | Split pane horizontally |
| `Ctrl-a -` | Split pane vertically |
| `Ctrl-a h/j/k/l` | Navigate panes (vim-style) |
| `Ctrl-a r` | Reload tmux config |

### Copying text with the mouse

tmux has `mouse on`, so a normal click-drag is captured by tmux (it selects into
tmux's own buffer and clears the highlight on release) — the text never reaches
your system clipboard. To copy to the clipboard, bypass tmux's mouse handling
with your terminal's modifier key.

If you're on a **Mac using the default Terminal.app**, that modifier is **Fn**:

- **Fn + click-drag** — selects text natively; then **⌘C** copies it.
- **Fn + right-click** — brings up the terminal's own copy menu.

Other setups use a different modifier — e.g. **iTerm2** uses **⌥ Option**, and
many Linux terminals use **Shift**. If plain drag doesn't let you copy, check
which modifier your terminal uses to bypass application mouse reporting.

## Project-specific services

You can add databases and other services per-project by creating `.cww/docker-compose.services.yml` in your project:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: myapp_dev
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev

  redis:
    image: redis:7
```

These services will be started alongside the agent's container (the base service is named `coder`). Access them by hostname from your code (e.g., `postgres:5432`).

> **Note:** Services use ephemeral storage and no host port bindings by default. This avoids conflicts when running multiple workspaces in parallel. To inspect data, connect to the running container:
> ```bash
> docker exec -it <container-name> psql -U dev -d myapp_dev
> ```

> **Publishing ports for parallel workspaces:** Use the **container-port-only** form — `ports: ["5174"]`, not `["5174:5174"]`. Docker then assigns a free host port per stack, so two workspaces of the same project never collide. `cww list` shows the assigned mapping and `cww tunnel-command` maps it back to a stable local origin. A pinned `["5174:5174"]` forces a fixed host port, so a second parallel workspace fails with *"port is already allocated"*. (Persistent volumes still conflict across parallel workspaces — keep services ephemeral.)

### Resetting service data (`.cww/reset.sh`)

A project can ship an optional `.cww/reset.sh` — one script that resets **and** reseeds its service data (drop/recreate schema, load fixtures, flush a cache, reindex, etc.). cww runs it automatically at the end of `cww create`, and you can re-run it any time with [`cww reset`](#cww-reset-workspace-name) to get back to a clean, seeded state without recreating the whole workspace. If the project has no `.cww/reset.sh`, both are simply no-ops.

### Skills, commands, and agents (two tiers)

Skills are the open [Agent Skills](https://agentskills.io) format (a folder with a `SKILL.md`), so the same skill works with every agent. Commands and agents are Claude Code file formats: Vibe's equivalents are skills with `user-invocable: true` (which become slash commands) and TOML agent configs; OpenCode's are its own markdown commands/agents with different frontmatter. cww makes these available in a workspace in two tiers:

- **Team (committed in the repo):** each agent reads its own committed locations, and they ride the in-container clone automatically — nothing special to configure. Claude Code reads `.claude/skills/` (plus `.claude/commands/`, `.claude/agents/`); Vibe reads `.vibe/skills/` or `.agents/skills/`; OpenCode reads `.opencode/skills/`, `.claude/skills/`, or `.agents/skills/`. Claude Code does *not* read the generic `.agents/skills/`, so a repo serving all agents commits `.claude/skills/` plus a location Vibe reads (an in-repo relative symlink like `.vibe/skills -> ../.claude/skills` rides the clone too). Other repo-committed config — like a `.vibe/config.toml` or an `opencode.json` — rides the clone like any other file.
- **Personal (per-project, not committed):** anything under the project's `.cww/{skills,commands,agents}/` is copied into the container at `cww create`. `.cww/skills/` loads for whichever agent the workspace runs — into `~/.claude/skills` for Claude Code, `~/.vibe/skills` for Vibe, `~/.config/opencode/skills` for OpenCode. `.cww/commands/` and `.cww/agents/` are copied only for claude workspaces; vibe and opencode workspaces print a one-line skip notice for them. The folder's mere presence is the opt-in — there's no flag. Populate it by dropping files in, or symlink your global set (e.g. `ln -s ~/.claude/skills .cww/skills`); the copy dereferences symlinks host-side, so the real files land in the container. These are usually gitignored.

### The built-in workspace skill

Every workspace also gets a built-in `cww` skill (same Agent Skills format), loaded at create into the agent's skills dir as `cww/` — `~/.claude/skills/cww`, `~/.vibe/skills/cww`, or `~/.config/opencode/skills/cww`. It tells the agent it is running inside a cww workspace: how the environment is wired (sibling service containers, loopback-published ports it can't see from inside, the built-in browser), that every `cww` command is host-side (so it answers "how do I reset the data?" with *"on your host machine, run `cww reset …`"* instead of inventing docker commands), the git ground rules, and guided flows for authoring the repo's `.cww/` config from inside — including the loop that makes such changes take effect (commit + push, you pull on the host, then run the applying command there).

For factual reference the skill bundles this user guide plus [accessing-services.md](accessing-services.md) and [git-strategy.md](git-strategy.md) as skill references, copied from the installed cww's `docs/` at create time — a workspace always carries the docs matching the cww version that created it (one created before an upgrade keeps its old copy until recreated).

Disable it with `CWW_SKILL=off` in `~/.cww/env` (global) or `"skill": "off"` in the project's `~/.cww/config.json` entry (per-project) — the same two-level pattern as the browser flag. A personal `.cww/skills/cww/` folder overrides the built-in skill (personal assets are copied after it).

## Built-in headful browser

Every workspace container runs a real, visible browser (Google Chrome on amd64, Chromium on arm64) on a virtual display (Xvfb), shared by the agent and you:

- **The agent drives it.** All agents come with the [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp) preconfigured, attached to that browser over CDP (`127.0.0.1:9222`, container-internal only) — baked into `~/.claude.json` on claude images, appended to `~/.vibe/config.toml` at boot on vibe images, baked into `~/.config/opencode/opencode.json` on opencode images. The agent can navigate, click, fill forms, read the console, take screenshots — no setup.
- **You watch and take over the same browser** via noVNC on container port 7900, published like any service port (loopback-only, Docker-assigned host port — check `cww list`). Open `http://localhost:<host-port>/vnc.html?autoconnect=1&resize=scale` on the docker host, or from another machine through [`cww tunnel-command`](#cww-tunnel-command-workspace-name) and then `http://localhost:7900/vnc.html?autoconnect=1&resize=scale`. Type a login or 2FA code into the page the agent is stuck on, watch what it's doing in real time, then disconnect — the browser (and the agent) keep going. Because each workspace has its own browser, you can hop between workspaces by just switching tabs.

Notes:

- Disable it by setting `CWW_BROWSER=off` in `~/.cww/env` (global) or `"browser": "off"` in the project's `~/.cww/config.json` entry (per-project). New workspaces then skip the browser processes, publish no noVNC port, and remove the MCP entry so the agent doesn't see a dead server.
- The browser session (cookies, logins) lives in the container and dies with the workspace — nothing touches your personal browser profile.
- Closing the browser's last window from noVNC is fine: it restarts automatically (log: `/tmp/cww-browser.log` in the container).
- Display resolution defaults to 1920x1080; override with `CWW_BROWSER_RESOLUTION=<WxH>` in `~/.cww/env`.
- Vibe's chrome-devtools entry is appended to the user config (`~/.vibe/config.toml`) at boot. **Caveat:** Vibe reads exactly one `config.toml` — if the repo commits a `.vibe/config.toml`, that (trusted) project config *replaces* the user config and the entry won't load. Such repos keep browser access by adding the same `[[mcp_servers]]` block to their own `.vibe/config.toml` (the entrypoint prints a reminder; the block is at `/usr/local/share/cww/vibe-mcp.toml` in the container). OpenCode has no such caveat: a repo-committed `opencode.json` *merges over* the baked global config, so the MCP entry survives.

## Accessing the app in a browser

Services bind no host ports by default. To open your app in a browser, publish its port in `.cww/docker-compose.services.yml` using the container-port-only form (e.g. `ports: ["5174"]`) so parallel workspaces stay conflict-free — Docker picks a free host port, visible in `cww list` as `5174->49153`.

To reach the app, SSH-forward the published port to your `localhost` — `cww tunnel-command <workspace>` prints the ready-to-run command. This works from another machine *or* on the Docker host itself (a tunnel to self), and the payoff is the same either way: a **stable `localhost:<container-port>` origin** no matter which host port Docker assigned. From another machine it also fixes what a raw LAN IP breaks: a plain-`http` non-loopback origin isn't a browser **secure context**, so APIs like Web Crypto fail (e.g. `auth0-spa-js must run on a secure origin`) and OAuth providers reject the unregistered origin — while `localhost` *is* a secure context.

```bash
$ cww tunnel-command feature-auth
  ssh -N -L 5174:localhost:49153 you@docker-host   # then open http://localhost:5174
```

Because the tunnel's local side is the stable container port, you keep **one** browser origin (`http://localhost:5174`) across every workspace — even though Docker gives each workspace a different host port — so you register Auth0 allowed callbacks/origins just once. See [docs/accessing-services.md](accessing-services.md).

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CWW_INSTALL_DIR` | `~/.local/share/coder-workspace-workflow` | Installation directory |
| `CWW_BIN_DIR` | `~/.local/bin` | Launcher directory |
| `CWW_BROWSER` | `on` | [Built-in headful browser](#built-in-headful-browser) for new workspaces; `off`/`0`/`false`/`no` disables (set in `~/.cww/env`; per project use `"browser"` in `~/.cww/config.json`) |
| `CWW_SKILL` | `on` | [Built-in workspace skill](#the-built-in-workspace-skill) for new workspaces; `off`/`0`/`false`/`no` disables (set in `~/.cww/env`; per project use `"skill"` in `~/.cww/config.json`) |
| `CWW_BROWSER_RESOLUTION` | `1920x1080` | Virtual display size of the built-in browser (`<width>x<height>`) |

### Dependency caches (opt-in)

By default **nothing is mounted from the host** — the repo is cloned inside the container and the agent's config is baked into the image. To speed up builds, you can share a dependency cache across workspaces.

You can't just bind-mount your own `~/.npm` or `~/.m2`: the agent runs as the in-container `developer` user, whose UID never matches your host user, so a host-owned cache dir isn't writable from inside (under rootless it even looks root-owned). Instead, let cww provision a dedicated cache dir with the right ownership:

```bash
cww cache npm                        # creates ~/.cww/cache/npm/_cacache
cww cache npm --from ~/.npm/_cacache  # ... optionally primed from your host cache
```

`cww cache` `mkdir`s the dir under `~/.cww/cache/`, `chown`s it to the UID `developer` has in the container (via a throwaway root container, so no host `sudo` and no manual subuid math), and prints the volume line to add to your project's `.cww/docker-compose.services.yml`:

```yaml
services:
  coder:
    volumes:
      - ${HOME}/.cww/cache/npm/_cacache:/home/developer/.npm/_cacache
```

Because the ownership lives on the host dir, it survives teardown and is shared by every workspace — a freshly created one does `npm ci --offline` with no network. Built-in presets: `npm`, `m2`, `ivy2`, `sbt`, `coursier`, `gradle`; or pass any `<name> <container-path>` for a custom cache. See [`cww cache`](#cww-cache-preset--name-container-path) for details and `examples/docker-compose.services.example.yml` for more mount options.

`cww cache` provisions a dir once per machine — it needs only the built image, not a running workspace, so you can do it right after `cww build`. Once the mount is committed to a project's `.cww/docker-compose.services.yml`, `cww create` **auto-provisions** it (creates + chowns the host dir if it's missing), so teammates need no manual step. And when a repo has a recognizable manifest (`package.json`, `pom.xml`, …) but no matching cache mounted, `cww create` prints a one-line tip suggesting the preset.

## Workflow example

```bash
# 1. Create a workspace for the work
cd ~/projects/myapp
cww create user-auth

# 2. The agent starts in tmux - work on your feature
# ... make changes with the agent's help ...

# 3. Detach to do something else
# Press Ctrl-a d

# 4. Check your workspaces
cww list

# 5. Resume work later
cww attach user-auth

# 6. Push your work — git is your job, done inside the workspace.
#    From the agent, or from a plain shell:
cww shell user-auth
#   $ git push -u origin my-branch     # commit/branch/push however you like
#   $ exit
# Then open a PR through your normal process.

# 7. When you're done and everything worth keeping is pushed, remove it.
#    teardown is destructive and pushes NOTHING.
cww teardown user-auth
```

## Troubleshooting

### Container won't start

Check if the Docker image exists:
```bash
docker images | grep coder-workspace-workflow
```

Rebuild if needed:
```bash
cww build
```

### Can't attach to session

Check if the container is running:
```bash
cww list
```

If stopped, `cww attach` will start it automatically.

### Orphaned workspace metadata

Each workspace keeps host-side metadata under `~/.cww/tasks/<project>-<workspace>/`. `cww teardown` removes it, but if a container was deleted out-of-band the directory can be left behind. List and clean up with:
```bash
# List workspaces cww knows about
cww list

# Inspect the metadata directories
ls ~/.cww/tasks/

# Remove a stale one (its container is already gone)
rm -rf ~/.cww/tasks/<project>-<workspace>/
```

### Clone or push fails inside the container

The container clones over HTTPS with the repo's entry from `~/.cww/credentials`, and the same credential is what you (or the agent) use to push from inside the workspace. When the clone fails, the workspace opens `less /workspace/cww.log` instead of the agent — the full git error plus the repo/branch/auth context (press `q` for a shell). The fix is usually `cww init` on the host: it re-prompts for the token and **validates it with `git ls-remote` before saving**, then `cww teardown` + `cww create` the workspace again.

### Containers can't reach a LAN git host (macOS)

Signature: the host reaches the forge fine, but from any container **every port** on that LAN machine is refused **instantly** (a few ms — no timeout), while the gateway and the internet work. That refusal is generated locally: on macOS, the **Local Network** privacy permission gates app traffic to LAN addresses (the default gateway is exempt), and Docker doesn't have it. Fix: System Settings → **Privacy & Security → Local Network** → allow **Docker**, then restart Docker Desktop. If Docker isn't listed, `tccutil reset LocalNetwork com.docker.docker` and relaunch Docker to re-trigger the prompt. The setup flow's container-side probe points at this when it sees the signature.

### Browser app fails with "must run on a secure origin" or Auth0 callback errors

You're loading the app over `http://<host-ip>:port`. A plain-`http` non-loopback origin isn't a browser secure context (so `crypto.subtle` / `auth0-spa-js` fail) and isn't a registered OAuth origin. SSH-forward the port to your `localhost` instead and browse there — `cww tunnel-command <workspace>` prints the ready-to-run command:
```bash
ssh -N -L 5174:localhost:5174 you@docker-host
# open http://localhost:5174
```
See [docs/accessing-services.md](accessing-services.md).
