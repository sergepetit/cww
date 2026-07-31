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
- [agent-cli-updates.md](agent-cli-updates.md) — How an agent CLI gets into a workspace and how it is updated — images freeze the CLI, 'cww build' re-resolves it, and existing workspaces need a recreate, with the evidence for why each piece exists

## Plans

- [bun-migration-plan.md](bun-migration-plan.md) — Migrate the host-side CLI from Bash to Bun/TypeScript — scope, target layout, phased steps, and what stays in Bash *(done)*
- [agent-modularization-plan.md](agent-modularization-plan.md) — Restructure per-agent code and config into one self-contained folder per agent (src/agents/&lt;name&gt;/), so adding a new coding agent touches no shared file *(done)*
- [opencode-config-file-plan.md](opencode-config-file-plan.md) — Replace the one-line OPENCODE_CONFIG_CONTENT env-var UX with real JSON files (~/.cww/opencode.json, &lt;repo&gt;/.cww/opencode.json) that cww validates and injects at create *(done)*
- [configuration-improvement-plan.md](configuration-improvement-plan.md) — Review of how cww manages configuration, env, settings and tokens — the file layout, host-to-container flow, what works — and proposed improvements ranked by impact *(proposed)*
- [agent-env-scoping-plan.md](agent-env-scoping-plan.md) — Stop injecting all of ~/.cww/env into every workspace — each agent declares the keys it needs, and an explicit --auth method (persisted like the git setup flow) determines the single credential a workspace gets *(done)*
- [workspace-skill-plan.md](workspace-skill-plan.md) — Inject a built-in cww skill into every workspace at create (and re-sync it on every start), so the agent knows it is running inside a cww workspace — which commands are host-side, how the environment is wired, and guided flows for authoring the repo's .cww/ config from within *(done)*
- [export-skill-plan.md](export-skill-plan.md) — A cww export-skill command that shares one skill from the host's agent config with a project — a symlink into .cww/skills/ for future creates, plus live injection into running workspaces *(done)*
- [cp-plan.md](cp-plan.md) — A cww cp command that copies files between the host and a running workspace, scp-style (ws:path), resolving the container name and handing pushed files to the in-container developer user *(done)*
- [copilot-agent-plan.md](copilot-agent-plan.md) — Add GitHub Copilot CLI as a fourth agent, including its BYOK mode so a workspace can run against a third-party OpenAI-compatible endpoint (e.g. a LAN llama.cpp server) *(done)*
- [services-env-layers-plan.md](services-env-layers-plan.md) — Keep ~/.cww/services.env as the machine-wide pass-through and add two narrower host-side layers above it, so a value can be scoped to one project or one workspace without being committed *(done)*

## Backlog

- [backlog.md](backlog.md) — Running list of known gaps and improvements deferred for later, with the evidence that motivated each

## Research

- [typescript-lsp-upstream.md](typescript-lsp-upstream.md) — The three ways an OpenCode workspace ends up with no TypeScript intelligence — root resolution, the fresh-workspace race, TypeScript 7 — with the measured evidence for each, and why cww deliberately ships no workaround

## Meta

- [DOC_CONVENTIONS.md](DOC_CONVENTIONS.md) — Frontmatter schema and the controlled type and status vocabularies for this repo's Markdown docs, and our take on OKF for project documentation

## Elsewhere in the repo

- [../README.md](../README.md) — Disposable, full-stack development environments for coding agents — install, quick start, commands, and choosing an agent
