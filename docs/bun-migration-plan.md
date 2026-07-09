---
type: plan
title: Bun Migration Plan
description: Migrate the host-side CLI from Bash to Bun/TypeScript — scope, target layout, phased steps, and what stays in Bash
status: done
created: 2026-07-09
timestamp: 2026-07-09
---

# Bun Migration Plan

Migrate cww's host-side CLI from Bash to TypeScript running on [Bun](https://bun.sh), for readability, type checking, and a real test suite (`bun test`). A side benefit drives part of the motivation: it drops two host prerequisites — **Bash 4+** (not the default on macOS, which ships 3.2) and **jq** — replacing them with a single one, Bun.

## Why

- `create-task.sh` (448 lines) and `lib/common.sh` (435 lines) are past the size where Bash stays maintainable: fragile quoting, no data structures, hand-rolled error handling, `session.json` manipulated through `jq` string pipelines, and no tests.
- The roadmap (worker-host pools, tunnels, richer session metadata) grows the *logic*, not the glue. TypeScript scales with that; Bash doesn't.
- [Bun Shell](https://bun.sh/docs/runtime/shell) (`` await $`docker exec ${container} …` ``) keeps the docker/git/tmux orchestration nearly as terse as Bash while adding safe interpolation (no quoting bugs), typed results, and real error control.
- Bun runs TypeScript natively (no build step), starts in ~10 ms (fine for a CLI), bundles a test runner, and parses JSON natively (goodbye jq).

## Scope

**Migrate** (~2,050 lines of Bash → TypeScript):

| Current | Role |
|---|---|
| `scripts/cww` | Dispatcher (137 lines) |
| `scripts/*.sh` (10 sub-commands) | `create`, `attach`, `shell`, `start`, `stop`, `reset`, `teardown`, `list`, `tunnel-command`, `cache` (~1,370 lines) |
| `scripts/lib/common.sh`, `scripts/lib/agents.sh` | Shared helpers (~540 lines) |

**Keep in Bash** (unchanged):

- `install.sh` — the bootstrap can't assume Bun exists; it gains a Bun check instead (see Phase 5).
- `docker/*.sh` (`entrypoint.sh`, `statusline.sh`, `cww-prompt.sh`, `cww-browser.sh`) — they run *inside* the container; a Bash entrypoint is idiomatic and keeps the image decoupled from Bun. They run under the image's own Bash, so the macOS/bash-3.2 concern doesn't apply to them.
- `templates/` — not code.

## Target layout

```
src/
  cli.ts              # entry point + sub-command routing + usage (replaces scripts/cww)
  commands/
    create.ts         # one module per sub-command
    attach.ts
    …
  lib/
    session.ts        # typed session.json read/write (replaces the jq pipelines)
    docker.ts         # container helpers (Bun Shell)
    naming.ts         # sanitize_name, get_task_name, get_container_name, remote-URL normalization
    ui.ts             # colors, info/warn/error/die, confirm and choice prompts
    agents.ts         # agent registry + image builds (replaces lib/agents.sh)
tests/                # bun test
```

- The installed `cww` binary becomes a thin launcher for `bun src/cli.ts` (or a `#!/usr/bin/env bun` shebang on `cli.ts` itself).
- **Zero runtime npm dependencies** is a hard goal: Bun's built-ins (Bun Shell, `Bun.spawn`, `util.parseArgs`, native JSON) cover everything the scripts do. Dev dependency: `@types/bun` only. This keeps the supply-chain surface at ~nothing, which matters for a tool that runs on the developer's host.
- Argument parsing via `util.parseArgs` — the flags are simple enough that no CLI framework is warranted.

## Prerequisite changes

| | Before | After |
|---|---|---|
| Required | Docker, Git, Bash 4+, jq | Docker, Git, **Bun** |

`install.sh` checks for Bun and, if missing, offers to run the official installer (`curl -fsSL https://bun.sh/install | bash`) — with explicit user confirmation, exiting otherwise (never runs it unprompted). A compiled standalone binary (`bun build --compile`, ~60–90 MB per platform) would remove even the Bun prerequisite, but it adds release infrastructure — deferred; noted under Open items.

## Phases

Each phase leaves `cww` fully working. During the transition the existing Bash dispatcher (`scripts/cww`) stays the entry point and routes *ported* sub-commands to `bun src/cli.ts <cmd> "$@"`; unported ones keep hitting their `.sh`. The dispatcher itself is Bash-3.2-safe, so the macOS win lands as soon as the last bash-4-dependent script is ported, not only at the end.

### Phase 0 — Scaffolding ✅ (2026-07-09)

- `package.json` (no runtime deps), `tsconfig.json`, `@types/bun`, `bun test` wiring.
- Pin a minimum Bun version and check it at startup in `cli.ts`.

### Phase 1 — Port the library ✅ (2026-07-09)

- `lib/common.sh` + `lib/agents.sh` → `src/lib/*` as above.
- Unit tests for the pure functions first: name sanitization, task/container naming, remote-URL normalization (`get_https_remote`), session.json round-trip. These are the highest-value tests and need no Docker.

### Phase 2 — Pilot command: `list` ✅ (2026-07-09)

- Read-only, and the heaviest jq user (`list-tasks.sh:51-131`) — the biggest immediate readability win with zero risk of breaking workspaces.
- Validates the ergonomics: Bun Shell calls to `docker ps`/`docker inspect`, typed sessions, table output.
- Checkpoint: if the ergonomics disappoint here, the sunk cost is one command.

### Phase 3 — Remaining simple commands ✅ (2026-07-09)

Rough order: `stop`, `start`, `teardown`, `reset`, `tunnel-command`, `cache`, `build`, then the two interactive ones:

- `shell` and `attach` use `exec docker exec -it …` (`common.sh:287`) — Bash replaces its own process; Bun can't. Ported with `Bun.spawn` + `stdio: "inherit"` (the TTY passes through; a Bun parent process remains around the tmux session). If a signal/TTY edge case shows up in practice, the fallback is to keep just these two as ~10-line Bash-3.2-safe wrappers — they contain almost no logic.
- The ported `.sh` files stay on disk until Phase 6 for side-by-side diffing; the dispatcher routes everything except `create` to `bun src/cli.ts`.

### Phase 4 — `create` ✅ (2026-07-09)

- The largest and riskiest (448 lines: arg parsing, hosts handling, compose generation, clone polling via `docker exec … tmux has-session`). Ported last, once the library and the patterns were proven.
- The 60-second polling loop and per-agent image checks became straightforward typed code; tests cover the pure parts (compose template rendering — verified byte-identical to the sed pipeline — extra-hosts parsing, declared-cache extraction, hostname truncation).

### Phase 5 — `install.sh` + entry point ✅ (2026-07-09)

- Replace the copy of `scripts/*.sh` with `src/` + `package.json`; drop the jq check. (Upgrades also delete a previously-installed `scripts/`.)
- Add the Bun prerequisite check: if Bun is missing, prompt to run the official installer (`curl -fsSL https://bun.sh/install | bash`); on decline, print the command and exit non-zero. `install.sh` never pipes remote code without the user saying yes.
- Replace the Bash dispatcher with the TS `cli.ts` as the sole entry: `~/.local/bin/cww` is now a generated 8-line `sh` launcher that execs `bun <install-dir>/src/cli.ts` (a shim rather than a symlink, so a missing Bun still gets a friendly error).

### Phase 6 — Docs and cleanup ✅ (2026-07-09)

- Delete the ported `.sh` files (`scripts/` removed entirely).
- Update README prerequisites line (`README.md:26`) and the user guide (`docs/user-guide.md:39`); sweep both for command/troubleshooting references to jq/Bash.

## Testing strategy

- `bun test` for all pure logic (naming, URL normalization, session serialization, compose rendering) — this is most of what Bash could never test.
- Docker-dependent behavior stays verified by manual smoke tests on both platforms (macOS laptop + the Linux box) at each phase boundary: `create → list → stop → start → attach → teardown` against a sample repo. No Docker mocking — the mock would cost more than it verifies.

## Risks and mitigations

- **TTY/signals on `attach`/`shell`** — the `exec` semantics change described in Phase 3; fallback identified.
- **Bun availability on hosts** — checked by `install.sh`; version pinned and verified at startup.
- **Behavior drift during the port** — one command per commit, smoke-tested before moving on; the dispatcher-level routing means old and new can be diffed side by side (`bash scripts/list-tasks.sh` vs `bun src/cli.ts list`) until the Bash version is deleted.

## Open items

- Standalone compiled binaries (`bun build --compile`) as a later distribution improvement — removes the Bun prerequisite for end users, at the cost of per-platform release artifacts.
- Whether `docker/statusline.sh` (which also shells out to jq-style parsing) ever migrates — the container ships Node/Bun anyway for the agents, but it's out of scope here.
