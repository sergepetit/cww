---
type: readme
title: cww Documentation Index
description: Master index of the project's authored documentation
---

# cww Documentation Index

## User documentation

- [user-guide.md](user-guide.md) — Full user documentation — installation, authentication, every command, the Docker image, project services, the built-in browser, configuration, and troubleshooting
- [accessing-services.md](accessing-services.md) — How to reach a workspace's services from a browser — port publishing, why plain-http LAN origins break secure contexts, and SSH-forwarding to one fixed localhost origin
- [git-strategy.md](git-strategy.md) — The two git mechanics cww owns — clone-in-container and the developer's own scoped credential — plus attribution and example workflows

## Plans

- [bun-migration-plan.md](bun-migration-plan.md) — Migrate the host-side CLI from Bash to Bun/TypeScript — scope, target layout, phased steps, and what stays in Bash *(done)*
- [agent-modularization-plan.md](agent-modularization-plan.md) — Restructure per-agent code and config into one self-contained folder per agent (src/agents/&lt;name&gt;/), so adding a new coding agent touches no shared file *(done — host Docker pass 2026-07-11 (zsh completion smoke-tested separately))*
- [opencode-config-file-plan.md](opencode-config-file-plan.md) — Replace the one-line OPENCODE_CONFIG_CONTENT env-var UX with real JSON files (~/.cww/opencode.json, &lt;repo&gt;/.cww/opencode.json) that cww validates and injects at create *(implemented (unit-tested; host Docker checklist passed 2026-07-12))*

## Meta

- [DOC_CONVENTIONS.md](DOC_CONVENTIONS.md) — Frontmatter schema and the controlled type vocabulary for this repo's Markdown docs, and our take on OKF for project documentation

## Elsewhere in the repo

- [../README.md](../README.md) — Disposable, full-stack development environments for coding agents — install, quick start, commands, and choosing an agent
