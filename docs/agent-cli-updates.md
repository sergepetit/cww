---
type: reference
title: Agent CLI Updates
description: How an agent CLI gets into a workspace and how it is updated — images freeze the CLI, 'cww build' re-resolves it, and existing workspaces need a recreate, with the evidence for why each piece exists
created: 2026-07-26
---

# Agent CLI Updates

An agent CLI (`claude`, `vibe`, `opencode`, `copilot`) is **installed when its
image is built and never moves again inside a container**. That single fact
decides everything below: how you get a newer CLI, why a running workspace
never changes underneath you, and what cww has to tell you so the freeze is
visible rather than silent.

## The model

| Layer | What it does with the CLI |
|---|---|
| `docker/base/Dockerfile` | no CLI — the shared OS, Node, bun, Java, noVNC layer |
| `src/agents/<agent>/Dockerfile` | installs the CLI **unpinned**, so a build resolves whatever is current |
| The image `coder-workspace-workflow:<agent>` | freezes that version, and stamps it into `/usr/local/share/cww/agent-version` |
| A workspace container | inherits the image's CLI and keeps it for the container's whole life |

Self-update is suppressed in all four images, deliberately, and stays that way:
a disposable container that mutates its own tooling mid-session is worse than
one that doesn't. For vibe it is load-bearing rather than belt-and-braces — an
update attempt there fails and exits non-zero, which kills the tmux pane
instead of landing the user at a prompt (see `src/agents/vibe/Dockerfile`).

So the update path is deliberate and explicit, in three steps.

## 1. `cww build <agent>` — get the current CLI

Builds are **fresh by default**. The flag was designed as `--fresh` and
reversed before it shipped: `cww build` is typed deliberately and rarely, so
getting the same frozen CLI back is the surprising outcome, not the safe one.

The cache-busting is split per step, because the layers are lopsided
(`agentBuildPlan`, `src/agents/registry.ts`):

- **base → `--pull`**: a cheap registry check for a moved `ubuntu:26.04`. A
  `--no-cache` here would redo apt + Node + bun + Temurin + noVNC, for minutes,
  on every build.
- **agent → `--no-cache`**: the agent Dockerfiles are little more than the
  `RUN npm install -g <cli>`, so busting all of it *is* busting the CLI
  install. Measured 2026-07-26: a `--no-cache` claude agent build (base cached)
  moved 2.1.216 → 2.1.220 in about a minute.

`cww build <agent> --cached` passes no cache flags at all. It is the escape
hatch for iterating on a Dockerfile, and for building without network access —
a fresh build reaches npm/pipx and the registry where a cached one didn't, so
the build-failure message names it.

Create's implicit build (`ensureAgentImage`) is always `--cached`: it only ever
runs when an image is **missing**, where there is no stale CLI layer to bust,
base layers from another agent should be reused, and creating a workspace
should never be the thing that silently moves an agent CLI.

## 2. `cww create` — warns before freezing an old image in

A container keeps its create-time image for life, so creating from an old image
bakes an old CLI into that workspace for as long as it exists. The one moment
that is cheap to fix is *before* the container exists, so `resolveWorkspaceImage`
warns there — advisory, never blocking:

```
[WARN] coder-workspace-workflow:claude was built 45d ago — the Claude Code CLI in it is
that old. Ctrl-C and run 'cww build claude' to create this workspace from the current release.
```

It measures the **agent** image even when a project layer (`.cww/Dockerfile`)
is stacked on top: that layer is rebuilt on every create, so its own age says
nothing about the CLI underneath.

## 3. `cww list` — says which existing workspaces are behind

Two facts, different remedies, one `IMAGE` column:

| Fact | Where it comes from | Remedy |
|---|---|---|
| **age** — how old the CLI in this workspace is | `now −` the container image's `Created` | `cww build <agent>` |
| **drift** (`*`) — a rebuild this workspace never picked up | the container's `.Image` id ≠ the current id of its `.Config.Image` tag | `cww teardown` + `cww create` |

Both resolve against the container's own **`.Config.Image`**, never the agent's
canonical tag — a per-project image (`cww-project-<name>:<agent>`) would
otherwise be measured against an image it was never built from, and report
permanent drift. Neither needs a `docker exec`, so stopped workspaces report as
fully as running ones.

`cww list --versions` adds the CLI **version string**, which is the one fact
*not* in image metadata: it exists only because each agent Dockerfile stamps
`<cli> --version` into `/usr/local/share/cww/agent-version` at build time.
Reading it costs a docker call per workspace — an exec for running containers,
a throwaway container per distinct image otherwise — which is why it sits
behind a flag instead of in the default table. An image built before the stamp
existed reports `?` until its next `cww build`.

## Why this was needed

Traced end to end on 2026-07-26. The unpinned installs were supposed to mean
"upstream fixes arrive with the next `cww build`" — an argument
[typescript-lsp-upstream.md](typescript-lsp-upstream.md) explicitly relies on —
and that premise did not hold:

- `cww build` ran `docker build` with **no cache flags**, so the
  `RUN npm install -g …` layer was a cache hit and the version never moved.
  Observed: editing `src/agents/vibe/Dockerfile` *below* its `RUN pipx install`
  line and rebuilding reused every install layer and finished in about a
  second.
- Nothing surfaced the freeze. `docker image inspect` was the only way to learn
  how old a workspace's CLI was.

Both are closed by the three mechanisms above.

## The escape hatch, and why nothing is built on it

Inside a running workspace, passwordless `sudo` means
`sudo npm install -g <cli>@latest` does work, for that container's lifetime. It
is real, and occasionally useful, but it drifts the container from its image —
exactly what the Dockerfile comments set out to prevent — and it vanishes on
recreate. It is not a foundation for a feature.
