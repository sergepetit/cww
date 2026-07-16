---
type: plan
title: Copy Files Host ↔ Workspace (`cww cp`)
description: A cww cp command that copies files between the host and a running workspace, scp-style (ws:path), resolving the container name and handing pushed files to the in-container developer user
status: implemented (unit-tested; host Docker pass 2026-07-16)
created: 2026-07-16
tags: [cli, ux, docker]
---

# Copy Files Host ↔ Workspace (`cww cp`)

## Problem

Getting a file into (or out of) a running workspace meant a raw `docker cp`: you have to know (or look up) the `cww-<project>-<workspace>` container name, and a file copied in lands **root-owned**, so the agent can't edit it. Both problems are pure bookkeeping cww already knows how to do — `resolveContainerLoosely()` maps a workspace name to its container, and the export-skill machinery already does `docker cp` + `chown developer:developer`.

## Design

`cww cp <source>... <dest>` with scp-style remote specs:

- Exactly one side names the workspace via `<workspace>:<path>`; that side is the in-container one, so the direction (push or pull) follows from where the spec is. Workspace-to-workspace copies, mixed remote/local sources, and invocations with no remote spec at all are rejected with a pointed error.
- An **empty workspace name** (`:<path>`) auto-detects the workspace from the current repo, exactly like the argless form of `shell`/`attach` (`resolveContainerLoosely`).
- Relative in-container paths resolve against `/workspace`; a bare `ws:` means `/workspace` itself.
- Sources may be files or directories, several at once (then the destination must be a directory, mirroring `cp` semantics; on push it is `mkdir -p`-created).
- **Push** uses `docker cp -L` (symlinked sources dereferenced, consistent with `copyDirIntoContainer`'s staging) and then chowns *only the copied targets* to `developer:developer`. **Pull** is a plain `docker cp` — host files land as the invoking user.
- The workspace must be **running**; a stopped one gets an error with a `cww start` hint rather than an auto-start (a copy doesn't imply wanting the stack up, unlike `shell`).
- A host path containing a literal `:` is escaped with a `./` prefix (scp's convention); anything with a `/` before the colon is treated as a host path.
- Overwrites are silent, like `cp`/`docker cp`.

## Implementation

- `src/lib/container-fs.ts` — `copyIntoContainer(sources, container, dest)` and `copyFromContainer(container, sources, dest)`, siblings of `copyDirIntoContainer` (the module stays a leaf; no `docker.ts` import).
- `src/commands/cp.ts` — the command; its pure planner `parseCpArgs()` / `resolveContainerPath()` carry all the syntax rules and are unit-tested in `tests/cp.test.ts` (no Docker, house style).
- Wiring: `src/cli.ts` (usage + dispatch), `completions/cww.bash` and `completions/_cww` (workspace names offered with a `:` suffix alongside filename completion).
- Docs: README command table row, [user-guide.md](user-guide.md#cww-cp-source-dest) section.
