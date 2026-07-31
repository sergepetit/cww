---
type: plan
title: Per-Project and Per-Workspace Services Env
description: Keep ~/.cww/services.env as the machine-wide pass-through and add two narrower host-side layers above it, so a value can be scoped to one project or one workspace without being committed
status: done
created: 2026-07-31
timestamp: 2026-07-31
tags: [configuration, env, services]
---

# Per-Project and Per-Workspace Services Env

**Implemented 2026-07-31.** Promoted from the open question left by
[agent-env-scoping-plan.md](agent-env-scoping-plan.md) — "the *anything else my
services need* use case needs an explicit home" — which that plan answered with
a single machine-wide file.

## Problem

`~/.cww/services.env` is the one channel whose contents reach a container
verbatim, and it is machine-wide: every value reaches every workspace of every
project. `examples/services.env.example` already admitted this and pointed
users at `environment:` entries in the repo's
`.cww/docker-compose.services.yml` for per-project values — but that file rides
the repo, so it cannot hold anything secret. There was no per-project or
per-workspace env channel that stayed on the host.

## Design

Three host-side layers, least- to most-specific:

```
~/.cww/services.env                        every workspace on this machine
~/.cww/services/<project>.env              every workspace of this project
~/.cww/services/<project>/<workspace>.env  just this workspace
```

Names go through `sanitizeName` (`src/lib/naming.ts`), the derivation container
and task names already use, so a project and workspace the user typed map to
one predictable path.

**Why the workspace layer nests** instead of being a flat
`<project>-<workspace>.env`: a project literally named `api-sandbox` would
otherwise collide with workspace `sandbox` of project `api` — the same clash
`~/.cww/tasks` carries. A `<project>.env` file and a `<project>/` directory
coexist without ambiguity.

**Host-side only**, so a value can be secret without being committed. Nothing
new is read from the repo; the in-repo
`.cww/docker-compose.services.yml` `environment:` route stays as the
shareable, non-secret option.

### Precedence comes free from compose

A later `env_file` wins, so ordering the entries low-to-high *is* the
precedence rule — no merge code, no host-side parsing, and the new layers keep
exactly the semantics the global file already had (including compose's `$VAR`
expansion, so item 2 of
[configuration-improvement-plan.md](configuration-improvement-plan.md) is
unchanged, not worsened):

```
~/.cww/services.env < <project>.env < <project>/<workspace>.env < <taskDir>/env
```

The task-dir env (git credential + the chosen auth method's key) stays last and
keeps winning, so a services file can never shadow a credential.

### Create-time only

`env_file` is read once, at container creation, so an edit lands on
`cww teardown` + `cww create`. This was already true of the global file.

The start-time refresh channel (`src/lib/env-refresh.ts`) was deliberately
**not** extended: it is secrets-only by design, and `tests/env-refresh.test.ts`
asserts non-auth keys never ride it. Widening it would also mean parsing these
files host-side, reintroducing the parser divergence the compose-only route
avoids.

Because the layers live outside the task dir, `cww teardown` leaves them
untouched — which is what makes "edit, teardown, create" a usable loop.

### Discoverability

Sanitized names mean a user could guess the path wrong, and a `cww config`
effective-config dump (item 4 of the configuration review) is a bigger change.
Instead `cww create` prints the three resolved paths, marking which it loaded,
in both the fresh and recreate paths — the first create tells you exactly where
to write a value, at zero new CLI surface.

## What landed

- `src/lib/services-env.ts` — the layer path resolvers and `servicesEnvFiles`,
  which defines the order once. Injectable `home` so tests never touch the real
  `~/.cww` (the `src/agents/opencode/agent.ts` precedent).
- `templates/docker-compose.yml.template` — four `env_file` entries, all
  `required: false`.
- `src/commands/create.ts` — `projectName` added to `TaskParams`, the two new
  placeholders rendered in `generateCompose`, and `reportServicesEnvLayers`
  called from both create paths.
- `tests/services-env.test.ts`, plus template guards in `tests/create.test.ts`
  covering env_file *ordering* (the precedence rule) and that every entry is
  optional.
- Docs: the user guide's "Passing env to workspaces" section and directory
  structure, `examples/services.env.example`, the configuration review's file
  inventory, and the in-workspace skill — which previously never mentioned
  `services.env` at all, so the in-container agent could not tell a user where
  a secret value belonged.
