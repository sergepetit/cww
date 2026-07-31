---
type: plan
title: Configuration Handling — Review and Improvement Plan
description: Review of how cww manages configuration, env, settings and tokens — the file layout, host-to-container flow, what works — and proposed improvements ranked by impact
status: proposed
created: 2026-07-14
tags: [configuration, security, env, credentials]
---

# Configuration Handling — Review and Improvement Plan

A review of how cww manages configuration, environment, settings, and tokens
as of v0.2.x, followed by proposed improvements. Nothing here is committed
work yet; each item should become its own change (or plan) when picked up.

## How configuration is organized today

The design splits state into files by **kind of data**, each with one clear
owner and format:

| File | What it holds | Format |
|---|---|---|
| `~/.cww/env` | Secrets + global defaults (agent tokens, `CWW_AGENT`, `CWW_AUTH`, `CWW_BROWSER`) — host-side only since env scoping | KEY=VALUE, source-style |
| `~/.cww/services.env` + `~/.cww/services/<project>.env` + `~/.cww/services/<project>/<workspace>.env` | Pass-through env for the app's services, loaded verbatim; three layers, narrower overriding broader | KEY=VALUE, compose dotenv |
| `~/.cww/config.json` | Per-project settings keyed by git-root realpath (`repoUrl`, `remote`, `agent`, `auth`, `browser`) | JSON |
| `~/.cww/credentials` | Git tokens, one per repo/host | git's `~/.git-credentials` URL format |
| `~/.cww/hosts` + `<repo>/.cww/hosts` | Container DNS mappings | `hostname ip` lines |
| `~/.cww/opencode.json` + `<repo>/.cww/opencode.json` | Agent-specific provider config | strict JSON |
| `~/.cww/tasks/<task>/` | Per-workspace derived state: `session.json`, generated compose files, and an `env` file carrying that repo's single git credential plus the chosen auth method's single agent key | generated |

The flow into a container: `cww create` loads `~/.cww/env` into `process.env`
(for preflight checks, via `src/lib/env.ts`), applies the project's
config.json overrides through the same env channel, then compose injects two
`env_file`s — the optional `~/.cww/services.env` verbatim, plus the task-dir
`env` holding **only the one git credential matching this repo** (longest-path
match in `src/lib/credentials.ts`, so a container never sees other repos'
tokens) **and only the chosen auth method's agent key** (item 1 below, now
implemented). Static values go through `{{PLACEHOLDER}}` template rendering;
dynamic pieces (hosts, browser port, agent env) become separate generated
compose override files. In-container, the token lives only in env and an
ephemeral credential helper — never written to `.git/config`.

## What works well (keep as-is)

- **Secrets are well-separated**: tokens never in config.json, never in the
  repo, never on argv (the setup probes pass them via child env), never on
  disk inside the container; files are mode 600 in a 700 dir, and
  `writeTaskEnv` handles the "`writeFileSync` mode only applies on create"
  trap. Per-repo credential scoping is a real security feature.
- **Validation before persistence**: `setupRepo` proves a token against the
  real forge *and* from inside a container before storing anything; a corrupt
  `config.json` dies loudly instead of being silently clobbered by the next
  write; `opencode.json` is parsed host-side so failures carry a path and
  parse position.
- Comments consistently explain *why* (precedence rules, compose quirks, the
  macOS Local Network permission), and the pure parsers (`parseEnvFile`,
  `parseCredentials`, `parseUserConfig`) are separated from I/O and tested.

## Improvements

Ranked by impact; 1 and 4 matter most, the rest is hardening.

### 1. Scope env injection per agent (the biggest wart) — DONE 2026-07-15

The whole `~/.cww/env` reached every container via compose `env_file`. The
symptom was documented in `examples/cww.env.example`: an `ANTHROPIC_API_KEY`
set for opencode was also seen by claude workspaces, where Claude Code can
prefer it over the subscription token — metered billing.

The fix grew into its own plan — now implemented; see
[agent-env-scoping-plan.md](agent-env-scoping-plan.md) for the design and the
implementation notes. In short: each agent declares its auth methods (no more
blanket `env_file`), a deterministic auth-selection rule owned by cww injects
exactly one credential per workspace, chosen via a generic `--auth <method>`
option persisted like the git setup flow, with `none` as a consenting
log-in-inside-the-workspace fallback and `~/.cww/services.env` as the
explicit pass-through for service env.

### 2. One env file, three parsers — `$` handling diverges

`~/.cww/env` is parsed by `parseEnvFile` (host-side, no interpolation) *and*
by docker compose's dotenv parser (container-side, which **does** expand
`$VAR` in unquoted and double-quoted values). A value containing `$` passes
host-side preflight but arrives mangled in the container.

Same risk in `writeTaskEnv` (`src/commands/create.ts`), which writes the git
token unquoted into the task-dir env file — fine for alphanumeric PATs,
wrong for a password containing `$`. The `$$` doubling that
`generateAgentEnvOverride` already applies solves exactly this; the task-dir
env file doesn't get the same treatment. Either move the git credential to
the `environment:` override channel or apply the same escaping. (Item 1
shrinks the global-env half of this problem too.)

### 3. `process.env` as a mutation channel

`cfg?.browser` is applied by mutating `process.env.CWW_BROWSER`, which
`generateCompose` and `browserEnabled()` then read implicitly. It works, but
the effective config is assembled by side effects scattered across
`runCreate`, making precedence hard to trace. A small
`resolveEffectiveConfig(cfg, env, flags)` returning one plain object — passed
explicitly to the generators — would make the precedence chain
(`flag > project config > global env > default`) one testable function
instead of a comment convention. This gets more pressing as settings accrete
(agent, browser, resolution, future ones).

### 4. No way to see the effective configuration

With six input files plus precedence rules, "which agent/browser/token/URL
will workspace X actually get?" is answerable only by reading code. A
read-only `cww config` (or an extension of `cww list`) that prints the
resolved values for the current repo — repoUrl, matched credential entry
(redacted), agent and where it came from, hosts entries — would pay for
itself in support situations. `cww init` half-does this interactively; a
non-interactive dump is missing. Falls out almost for free after item 3.

### 5. Smaller hardening items

- **config.json read-modify-write has no locking**: two concurrent
  `cww create`s in different repos can drop one project's entry. Unlikely for
  a single-user tool, but writing to a temp file + rename is cheap and also
  makes the write atomic against crashes.
- **`~/.cww` permissions depend on which command runs first**: it gets mode
  700 only when credentials/config are written first; `writeSession`'s plain
  `mkdirSync` can create it (and `~/.cww/tasks`) with default 755 first.
- **The recreate path never rewrites `session.json`**, so a changed `repoUrl`
  leaves stale metadata in the task dir.
- **The inline git credential helper** (`!f(){ echo "username=..."; ...};f`)
  exists in `src/lib/setup.ts` (INLINE_HELPER) and `docker/base/entrypoint.sh`
  — one of the few duplicated secrets-handling snippets; drift there would be
  subtle.
- **`CWW_BROWSER` values match case-sensitively** ("Off" enables the
  browser) — faithful to the bash lib, but now that the value also flows from
  JSON config, a `.toLowerCase()` is worth more than the compatibility.
- **Env-var secrets are visible via `docker inspect` and `/proc/1/environ`**
  to anything with Docker-socket access. Inherent to the design and
  acceptable on a single-developer machine, but worth a line in the docs'
  threat-model section — especially with the remote worker-host idea parked.

## Overall assessment

The structure is sound: the separation of secrets (`credentials`), settings
(`env` + `config.json`), and derived state (`tasks/`) is right, and the
validate-before-persist setup flow is unusually careful. The improvements
that change the architecture are item 1 (per-agent env scoping) and item 4
(effective-config visibility); everything else is local hardening.
