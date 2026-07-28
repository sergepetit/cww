---
name: cww
description: How this cww workspace works and how to configure cww for this repo. Use when asked about the environment, its services, ports, or browser, about resetting or reseeding data, exposing the app, "this sandbox"/"this container", or anything involving the cww tool. Also load this immediately if the chrome-devtools MCP can't connect, Chrome "isn't running", or the browser/noVNC seems broken — do not launch your own browser before reading it. Load it too whenever code intelligence looks wrong — "why is the LSP not activated", no type diagnostics, go-to-definition doing nothing — and right after the first dependency install in this workspace, which is when that silently breaks.
---

# Working inside a cww workspace

You are running inside a workspace created by **cww** (Coder Workspace
Workflow): a disposable, full-stack development environment — one container
for you, plus sibling containers for the project's services — that the user
created from their own machine with `cww create`. This skill explains how the
environment is wired, which commands exist only on the user's machine, and
how to help configure cww for this repo from in here. It describes cww as of
the version that created this workspace.

Facts about *this* workspace live in the environment, not in this file:

- `CWW_WORKSPACE` — the workspace's name (what the user types in `cww` commands)
- `BRANCH_NAME` — the branch checked out at create time
- `REPO_URL` — the URL this clone came from (and pushes to)
- `CWW_BROWSER` — whether the built-in headful browser is on

`/workspace` is a fresh, self-contained clone made when the workspace was
created. The whole environment is disposable by design: **anything not
committed and pushed is lost when the user tears the workspace down.**
Commit and push work worth keeping.

## Environment topology

- **Services are sibling containers.** The project's databases, caches, etc.
  (declared in the repo's `.cww/docker-compose.services.yml`) run on this
  workspace's own private compose network. Reach them **by service hostname**
  (e.g. `postgres:5432`, `redis:6379`) — not `localhost`, and not any LAN
  address.
- **Ports are published on the user's host, loopback-only, with
  Docker-assigned numbers you cannot see from in here.** Never print or guess
  a `http://<ip>:<port>` address for the user: the actual mapping is on their
  machine, in `cww list`, and they reach it via `cww tunnel-command` (details
  in `references/accessing-services.md`).
- **The built-in browser** (when `CWW_BROWSER=on`) is a real headful
  Chrome/Chromium running inside this container, preconfigured for you via
  the chrome-devtools MCP server. It is the way to *see* the app: it reaches
  your dev server at `localhost:<port>` and services by hostname. The user
  can watch it — or take over, e.g. to type a login or 2FA code — through a
  noVNC tab on their side, so it's fine to ask them to intervene there. If it
  seems down, see "If the built-in browser is down" below.
- **There is no docker socket in this container.** You cannot run `docker`,
  `docker compose`, or inspect sibling containers. To poke at a service, use
  its client protocol over the network (e.g. `psql -h postgres`).

## If the built-in browser is down

The browser stack — Xvfb, x11vnc, noVNC on container port 7900, and the
headful browser with CDP on `127.0.0.1:9222` — is started at boot by
`/usr/local/bin/cww-browser`, which logs to `/tmp/cww-browser.log` and writes
its pid to `/tmp/cww-browser.pid`. If the chrome-devtools MCP can't connect:

- **Never launch your own headless browser on port 9222.** It answers CDP but
  renders nowhere — the user sees nothing in noVNC — and it squats the port
  the real stack needs.
- Read `/tmp/cww-browser.log`, then rerun `/usr/local/bin/cww-browser` in the
  background. Its pidfile guard makes this safe: it refuses to start while
  another copy is alive.
- If it refuses but the stack is still broken, kill the surviving copy —
  `kill $(cat /tmp/cww-browser.pid)`, plus any leftovers found with
  `pgrep -af 'Xvfb|x11vnc|websockify|chrom'` — then rerun it.
- Repeated `[cww-browser] Browser exited; restarting in 1s ...` log lines mean
  the browser is crashing, not merely closed. One known cause is a full disk
  (check `df -h /`), e.g. after a Docker disk-quota incident on the host:
  freeing space lets the loop revive the browser, but the helpers
  (Xvfb/x11vnc/websockify) are not supervised and never restart on their own —
  hence the kill-and-rerun recovery above.

## Git rules

- The clone carries **one scoped credential, valid for this repository
  only**, and authorship is preconfigured. Branching, committing, and pushing
  are normal and expected — `origin` is the real repository, and pushes land
  there as the user.
- **No other host credentials exist in here**, and none should: never ask
  the user to paste tokens, keys, or the contents of host files like
  `~/.cww/env` into the workspace.
- **If git auth suddenly breaks mid-workspace**, ask whether they attached
  VS Code to this container: its Dev Containers extension copies the host
  `~/.gitconfig` in and injects its own credential helper, overwriting the
  workspace's. Host-side fix — `"dev.containers.copyGitConfig": false` in VS
  Code settings, then `cww stop` + `cww start` to restore this container's
  git setup (`references/git-strategy.md`).

## The cww command runs on the user's machine, not here

The `cww` CLI exists **only on the user's host**. Whenever the answer to a
question is a cww command, say so explicitly as: *"on your host machine, run
`cww …`"* — you cannot run it yourself. Common cases:

| The user asks | Host-side answer |
|---|---|
| reset / reseed the database or service data | `cww reset $CWW_WORKSPACE` (runs the repo's `.cww/reset.sh`) |
| open the app in their browser / expose a port | publish the port in `.cww/docker-compose.services.yml`, then `cww list` + `cww tunnel-command $CWW_WORKSPACE` |
| which ports are published | `cww list` |
| step away and come back | detach with `Ctrl-a d`; later `cww attach $CWW_WORKSPACE` |
| a plain shell in this container | `cww shell $CWW_WORKSPACE` |
| pause / resume the workspace | `cww stop` / `cww start` |
| delete the workspace | `cww teardown $CWW_WORKSPACE` — destructive; remind them to push first |
| rotate the git token | `cww auth git` in the repo, then `cww stop` + `cww start` this workspace |
| the agent's own token expired / was renewed | `cww auth`, then `cww stop` + `cww start` this workspace |
| change the clone URL | `cww init` in the repo |
| speed up dependency installs across workspaces | `cww cache <preset>` (e.g. `npm`, `m2`, `gradle`) |
| load one of their personal skills into this workspace | `cww export-skill <name> $CWW_WORKSPACE` — it lands here live; a new agent session may be needed before it triggers |

Command details, options, and troubleshooting: `references/user-guide.md`.

## Helping configure cww for this repo (`.cww/`)

You are well placed to author the repo's `.cww/` files — the repo usually
already contains the raw material. What each file is for:

- **`.cww/docker-compose.services.yml`** — the services every workspace of
  this repo gets. Infer it from an existing `docker-compose.yml`, CI config,
  or README. Two cww-specific rules: use the **container-port-only** form for
  published ports (`ports: ["5174"]`, never `"5174:5174"` — parallel
  workspaces would collide), and point named dependency caches at
  `${HOME}/.cww/cache/...` mounts (the user provisions them with `cww cache`).
- **`.cww/reset.sh`** — one script that resets *and* reseeds service data
  (drop/recreate schema, load fixtures, …). Derive it from the project's
  migration and seed tooling. It runs inside the workspace at create and on
  `cww reset`.
- **`.cww/Dockerfile`** — extra image layers (system packages, compilers,
  SDKs) built on top of the agent image at create. Must start with
  `ARG BASE_IMAGE=coder-workspace-workflow:claude` + `FROM ${BASE_IMAGE}`
  (cww overrides `BASE_IMAGE` with the workspace's agent image; the default
  only silences BuildKit's InvalidDefaultArgInFrom warning and keeps a bare
  `docker build .cww` working). The build context is `.cww/`, so `COPY` sees
  sibling files. A new image applies only to a *recreated* workspace — the
  full loop below.
- **`.cww/hosts`** — `name ip` lines for internal VCS/registry hostnames the
  container's DNS can't resolve.
- **`.cww/opencode.json`** — personal OpenCode config (custom/local model
  providers). **`.cww/skills/`** — personal skills, loaded for whichever
  agent runs (portable Agent Skills format). **`.cww/commands/`,
  `.cww/agents/`** — Claude Code formats, loaded for claude workspaces only.
  These are personal, usually-gitignored files; the two compose/reset files
  above are typically committed.

Generated config is something the host will *run*: present it to the user
for review rather than committing and pushing it silently.

## How `.cww/` changes take effect

cww reads `.cww/` from the **user's host checkout**, not from this clone —
a file you edit here does nothing until it completes this loop:

1. You edit `.cww/…` in `/workspace`, commit, and push.
2. The user pulls on their host.
3. The user runs the applying command there:
   - services / hosts / env / Dockerfile changes → `cww teardown NAME &&
     cww create NAME` (a fresh workspace)
   - `reset.sh` changes → `cww reset NAME`
   - credential or clone-URL changes → `cww init`

Spell this loop out every time you change `.cww/` files, or they will
silently do nothing.

## Your own quirks: `references/troubleshooting.md`

If that file is present, it holds known rough edges of **the agent you are**
running as, inside a cww workspace — staged for your agent specifically, so it
never describes a different CLI. It is the one bundled file written *for you*
rather than for the user: its steps happen here, not on their machine.

Read it at two moments:

- **Right after the first dependency install in this workspace** — before you
  carry on. `/workspace` is a cold clone, so that first `npm`/`bun`/`pip`
  install is the one that changes what your own tooling can see, and some of
  what changes does not take effect until you are restarted.
- **When your own tooling misbehaves** — code intelligence gone quiet,
  diagnostics that stopped arriving, a capability that seems switched off.

The first trigger matters most, because it fires while everything still *looks*
fine: several of the quirks in there fail **silently**, so "nothing looks
wrong" is not evidence that nothing is. The file is absent when there is
nothing known to warn you about.

## References

The bundled references are cww's real user docs, **written for the user
sitting at their host machine**: install steps, `~/.cww/env` editing, token
setup, and every command in them are host-side. Nothing in them runs inside
this workspace unless this skill says so — relay such steps to the user, and
never ask them to bring host secrets in here.

- `references/user-guide.md` — every command and option, authentication,
  the Docker image, project services, the built-in browser, dependency
  caches, configuration, troubleshooting.
- `references/accessing-services.md` — reaching a workspace's services from
  a real browser: port publishing, why plain-http LAN origins break secure
  contexts, SSH-forwarding to one fixed localhost origin.
- `references/git-strategy.md` — how the in-container clone and the scoped
  credential work, attribution, and example git workflows.
