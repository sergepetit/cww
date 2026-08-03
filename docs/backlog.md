---
type: log
title: cww Backlog
description: Running list of known gaps and improvements deferred for later, with the evidence that motivated each
created: 2026-07-22
---

# cww Backlog

Append-mostly. Each entry records what's wrong, the evidence, and what a fix
would look like — enough that picking one up later doesn't mean re-deriving it.
Entries move out when done (or into a plan doc if they grow).

## No `bun` cache preset — bun projects re-download everything, every create

`cww cache` ships `npm`, `m2`, `ivy2`, `sbt`, `coursier` and `gradle` presets.
Bun installs into `~/.bun/install/cache`, which nothing mounts, so it starts
empty in every new workspace and the whole dependency tree is fetched again.

Measured 2026-07-22 in a freshly created cww-smoketest workspace (a bun-first
project since `07f793d`):

```
/home/developer/.bun/install/cache   141M   container-local, empty at create
/home/developer/.npm/_cacache        246M   bind-mounted from the host
```

That 141M was downloaded during a single `bun install` — including the esbuild
and rolldown binaries — and it is discarded at teardown. It also accounts for
most of the ~2.5 minutes the agent spent getting the dev server up. The mounted
npm cache did nothing, because the project no longer uses npm.

- **Workaround today:** the custom form already works —
  `cww cache bun /home/developer/.bun/install/cache`, plus the matching mount in
  the project's `.cww/docker-compose.services.yml`.
- **Fix:** add a `bun` preset next to npm/m2/gradle in `src/commands/cache.ts`
  (`bun/install-cache:/home/developer/.bun/install/cache`), and mention it in
  the user guide's dependency-cache section.
- **While there:** other single-cache-dir toolchains have the same shape and are
  cheap to add once the preset list is being touched (pip, cargo, go).

## The agent is warned about the LSP race only if the user asks

`references/troubleshooting.md` is staged per agent, lands correctly, and is read
and answered from when the user asks. Why its wording is the way it is —
validated over six live runs on 2026-07-22 — is recorded in
[workspace-skill-plan.md](workspace-skill-plan.md#why-the-troubleshooting-references-wording-is-deliberate);
read that before rewriting it.

**Residual gap, accepted:** when nobody asks, the agent installs, reports
success, and never mentions it has gone type-blind — 2 of 4 organic runs looked
exactly like that. A PATH shim wrapping `npm`/`bun` would close it
deterministically, and was **deliberately declined**: it would be dead weight
the moment OpenCode fixes the underlying lifecycle bug, the same reasoning as
[typescript-lsp-upstream.md](typescript-lsp-upstream.md). The user asking "why
is the LSP not activated?" is the realistic path, and that one works.

## `bun run dev` does not survive a foreground agent shell call

Twice on 2026-07-22 the agent ran the smoketest's dev server in the foreground,
reported "dev server is running", and left nothing listening — `curl` on 5173
returned nothing and no bun or vite process existed. It works when backgrounded
with output redirected (`bun run dev &>/tmp/dev.log &`).

This makes the smoketest flaky under an agent and invites confidently false
"it's running" claims. Either `dev.js` should detach on its own, or the repo's
README should tell the agent to background it.
