---
type: guide
title: Configuring a Repo for cww (`.cww/`)
description: What each file in a repo's .cww/ folder does, the host-side env layers that sit outside it, and how a change to either takes effect — the shared reference for configuring a project, from the host or from inside a workspace
created: 2026-08-16
---

# Configuring a Repo for cww (`.cww/`)

A repo needs no configuration to get a workspace: `cww create` clones it,
starts the agent container, and that is a working environment. `.cww/` is
what you add when the project needs more than that — its own services, extra
system packages, seed data, internal hostnames.

This is the shared reference for that work. It is written for whoever is
doing the configuring: the user, the agent running on their machine, or the
agent inside a workspace. Where those differ, the difference is called out —
mostly in [How a change takes effect](#how-a-change-takes-effect), which is
the part that bites.

## The files

All of them live in `<repo>/.cww/`, and all are optional.

### `.cww/docker-compose.services.yml`

The services every workspace of this repo gets — databases, caches, queues —
as sibling containers on the workspace's own private compose network. Infer
it from an existing `docker-compose.yml`, CI config, or README.

Two cww-specific rules:

- **Publish with the container-port-only form**: `ports: ["5174"]`, never
  `"5174:5174"`. Workspaces of the same repo run in parallel, and a fixed
  host port makes the second one fail to start. Docker assigns a free host
  port; `cww list` shows the mapping.
- **Point named dependency caches at `${HOME}/.cww/cache/...` mounts**, which
  the user provisions with `cww cache <preset>`. Without that, every
  workspace re-downloads the project's dependencies from scratch.

Workspace code reaches these by **service hostname** (`postgres:5432`,
`redis:6379`) — never `localhost`, never a LAN address.

### `.cww/reset.sh`

One script that resets *and* reseeds service data — drop and recreate the
schema, run migrations, load fixtures. Derive it from the project's own
migration and seed tooling. It runs inside the workspace at create time and
on every `cww reset`.

### `.cww/Dockerfile`

Extra image layers on top of the agent image — system packages, compilers,
SDKs — built at create time. It must start with:

```dockerfile
ARG BASE_IMAGE=coder-workspace-workflow:claude
FROM ${BASE_IMAGE}
```

cww overrides `BASE_IMAGE` with the workspace's actual agent image; the
default value only silences BuildKit's `InvalidDefaultArgInFrom` warning and
keeps a bare `docker build .cww` working. The build context is `.cww/`, so
`COPY` sees its sibling files.

### `.cww/hosts`

`name ip` lines for internal VCS or registry hostnames the container's DNS
can't resolve.

### Personal, usually-gitignored files

- **`.cww/skills/`** — personal skills, loaded for whichever agent runs
  (the portable Agent Skills format). `cww export-skill` writes here.
- **`.cww/commands/`, `.cww/agents/`** — Claude Code formats, loaded for
  claude workspaces only.
- **`.cww/opencode.json`, `.cww/pi-models.json`** — per-project agent config
  (custom or local model providers).

The two compose/reset files above are typically committed; these are not.

## Env vars: what does *not* belong in `.cww/`

Values that are shareable and not secret can be `environment:` entries in
`.cww/docker-compose.services.yml`. Anything secret or machine-specific
belongs in the user's host-side services env instead — three layers, narrower
overriding broader, none of them visible from inside a workspace:

| File (on the host) | Applies to |
|---|---|
| `~/.cww/services.env` | every workspace on this machine |
| `~/.cww/services/<project>.env` | every workspace of this repo |
| `~/.cww/services/<project>/<workspace>.env` | one workspace |

So when a value is a credential, an internal endpoint, or otherwise the
user's and not the team's, it does not go in the repo. `cww create` prints
the exact paths for the project it just created.

Per-project cww settings themselves — clone URL, default agent, model,
subagent model — are not env at all: they live in `~/.cww/config.json`, keyed
by the repo, written by `cww init` and `cww create`.

## How a change takes effect

Nothing in `.cww/` is live. cww reads it from the **host checkout** at create
time, so a change applies only when the right command runs on the host:

| Changed | Applying command (on the host) |
|---|---|
| services / hosts / env / `Dockerfile` | `cww teardown NAME && cww create NAME` |
| `reset.sh` | `cww reset NAME` |
| credentials or clone URL | `cww init` |

**From inside a workspace** there is one more step at the front, and it is
easy to forget: the workspace clone is not the host checkout. An edit made in
`/workspace` does nothing until it is committed, pushed, and pulled on the
host — only then does the applying command above see it. Spell that loop out
every time, or the change silently does nothing.

**From the host** the loop collapses: edit the checkout, run the applying
command. This is also the only way to configure a repo that has no workspace
yet.

Either way, generated config is something the user's machine will *run*:
present it for review rather than committing and pushing it silently.
