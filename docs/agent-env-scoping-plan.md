---
type: plan
title: Per-Agent Env Scoping and Auth Selection
description: Stop injecting all of ~/.cww/env into every workspace — each agent declares the keys it needs, and an explicit --auth method (persisted like the git setup flow) determines the single credential a workspace gets
status: done
created: 2026-07-14
timestamp: 2026-07-15
tags: [configuration, security, env, credentials, agents]
---

# Per-Agent Env Scoping and Auth Selection

Promoted from item 1 of
[configuration-improvement-plan.md](configuration-improvement-plan.md), which
reviews the whole configuration surface; this doc carries the full design for
the highest-impact change.

**Implemented 2026-07-15.** The design below landed as specified, with these
concretions: the resolution lives in `src/lib/auth-flow.ts`
(`chooseAuthMethod`: `--auth` > project `"auth"` > `CWW_AUTH` > the agent's
only method > the default method when its key is already stored > ask once
and persist); the single credential rides the task-dir env file
(`writeTaskEnv`), the compose template lost the `~/.cww/env` `env_file`; the
"anything else my services need" pass-through moved to `~/.cww/services.env`
(`examples/services.env.example`); the start-time refresh narrows via the
`auth` method id recorded in `session.json` (`sessionAuthKeys`); `cww init`
resolves/asks the method during setup and preflights the chosen method's key.
The remaining known gap is the one named below: `cww auth` still validates
only the value prefix, not a live API probe.

## Problem

The whole `~/.cww/env` reaches every container via compose `env_file`. The
symptom is already documented in `examples/cww.env.example`: an
`ANTHROPIC_API_KEY` set for opencode is also seen by claude workspaces, where
Claude Code can prefer it over the subscription token — silent metered
billing. The example file mitigates with a CAUTION paragraph and workarounds
(prefer keyless options, use a key Claude Code ignores), which is
documentation patching over an architecture problem.

A second, subtler half: even for a single agent, *which credential wins* when
several are present is decided by the agent's internal env-precedence, not by
cww. cww currently has no way to express "this workspace authenticates with
X" — it forwards everything and hopes.

## Building blocks already landed (2026-07-15, token-renewal work)

The credential-renewal change ("Refresh secrets on workspace start and add
'cww auth' for token renewal") delivered several pieces this plan needs, so
the design below starts from them instead of inventing them:

- **`AgentDefinition.authMethods`** exists: each agent declares its methods
  using this plan's vocabulary — method id, env key, instructions, optional
  setup command and value prefix. Current declarations: claude
  `oauth-token` → `CLAUDE_CODE_OAUTH_TOKEN`; vibe `api-key` →
  `MISTRAL_API_KEY`; opencode one method per provider key
  (`anthropic-api-key`, `openai-api-key`, ...). This plan *extends* the
  lists (claude gains `api-key` and `none`, vibe/opencode gain
  `config-file`) rather than adding a field.
- **`cww auth [<agent>|git|KEY=VALUE] [--method <m>]`** exists and is the
  interactive prompt-validate-store flow for secrets: hidden paste, value
  sanity checks, and an upsert into `~/.cww/env` that preserves the file
  (`upsertEnvLine` in `src/lib/env.ts`). cww now *does* write `~/.cww/env`
  — the "small new behavior" this plan originally flagged is done. The
  create-time "chosen method's key is missing" path should reuse this flow.
- **Start-time secret refresh** (`src/lib/env-refresh.ts`): every start of a
  stopped workspace copies current secrets into the container
  (`/home/developer/.cww-env-refresh`, sourced by the entrypoint), so
  rotation no longer requires recreate. It currently forwards the **union of
  every agent's `authMethods` keys** found in `~/.cww/env` — deliberately
  matching today's blanket `env_file` semantics. Scoping must narrow it (see
  Interactions below).
- `writeTaskEnv` (the per-task env file carrying the git credential) moved to
  `src/lib/env-refresh.ts` — the natural seat if scoped agent keys also move
  to the task-dir env channel.

## Design

### 1. Scoped injection: agents declare their keys

Invert the model. Stop passing `~/.cww/env` as an `env_file` and have each
agent declare which keys it needs — `authMethods` already declares exactly
this (and the registry keeps the `containerEnv` hook for non-credential
extras) — so cww writes only those keys into the task-dir env (or the
generated `docker-compose.agent.yml` override). This removes the cross-agent
key-leak footgun, the "everything here is visible to the container" caveat,
and the CAUTION paragraph in the example file.

Open question: the "anything else my services need" use case the example file
currently invites needs an explicit home — e.g. a pass-through section in
`~/.cww/env` or a separate services env file.

### 2. Deterministic auth selection, owned by cww

A naive per-agent allowlist is not enough. Some users will want metered API
billing for claude on purpose (today's `preflight` hard-requires
`CLAUDE_CODE_OAUTH_TOKEN` and doesn't allow that at all), and the moment
`ANTHROPIC_API_KEY` joins claude's wanted keys, a dual-agent user is back to
the original collision.

So the fix is allowlist **plus a deterministic auth-selection rule**: inject
exactly one auth variable per workspace, with metered billing an explicit
opt-in rather than a side effect of a key being present. The failure mode
changes from "silent metered billing because another agent's key leaked in"
to "cww told you which credential this workspace uses" — which the
effective-config dump (item 4 of the review) would surface.

### 3. UX: a generic `--auth <method>` option on `cww create`

- **One generic flag, not per-agent flags.** `--claude-api-key`-style options
  would put agent-specific knowledge back into shared `create.ts` parsing,
  against the agent-modularization principle ("adding an agent touches no
  shared file"). The declaration mechanism exists (`authMethods`); this plan
  extends each agent's list — claude: `oauth-token | api-key | none`; vibe:
  `api-key | config-file`; opencode: per-provider keys `| config-file` — and
  an unknown method for the chosen agent dies with that agent's list (the
  behavior `cww auth --method` already implements). Same shape as `--agent`
  itself.
- **The flag selects the method, never carries the secret.** A key on argv
  lands in shell history and `ps` output (the setup probes already avoid
  argv deliberately). If the chosen method's key is missing, hand off to the
  `cww auth` flow (hidden `promptSecret`, value sanity checks, upsert into
  `~/.cww/env` preserving the file); the remaining gap vs the git setup flow
  is validating the secret with a cheap API call before storing (the
  `probeCredential` pattern) — `cww auth` today only checks the value
  prefix.
- **Ask once, not per create.** The interactive "which method?" question only
  fires when nothing is configured; the answer persists like the git setup
  flow does (`setupRepo`: first create asks, validates, persists; later
  creates reuse). The method lands in the project's `~/.cww/config.json`
  entry (an `"auth"` field) or a global default. Precedence mirrors
  `--agent`: `--auth` flag > project config > global default > interactive
  ask (TTY) / die with instructions (no TTY).
- **Composes with the scoped injection.** The chosen method determines which
  single variable is injected (`CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, or nothing for `none`), so "which key wins" is
  answered by explicit user choice.

### 4. The `none` method: log in inside the workspace

`none` formalizes a consenting fallback: cww injects no credential and the
user logs in via the agent's own CLI inside the container. Today claude's
preflight `process.exit(1)`s without `CLAUDE_CODE_OAUTH_TOKEN`; under this
plan, with no auth configured, the interactive ask explains the trade-off and
offers "continue and log in inside the workspace" (noting the login dies with
the container). That serves users who don't want a token in `~/.cww/env` at
all, without making everyone pay a per-create login tax.

## Considered and rejected: inject nothing by default

The inverse default — no credential unless opted in, CLI login as the normal
path — was considered and rejected. The cost lands on the golden path:
workspaces are disposable and in-container auth dies with them, so this means
the URL-and-paste-code OAuth dance on every `cww create` and recreate, where
a setup-token is pasted once per machine. It breaks the `--no-attach` /
walk-away flow (the workspace sits at a login prompt instead of an agent
ready to work), reverses the registry's stated philosophy ("fail fast with
instructions rather than dropping the user into an in-container login
screen"), gives lifecycle-dependent behavior (login survives stop/start but
not teardown), and doesn't remove the selection problem — users who opt back
into env keys still hit "which key wins." Token-first is also what any future
headless/remote-worker-host story needs: no one is at the tmux session to
complete an OAuth dance.

## Interactions with the rest of the review

- **Start-time secret refresh (landed 2026-07-15):** the refresh currently
  forwards the union of every agent's declared keys — correct only while the
  blanket `env_file` makes every key reach every container anyway. Under
  scoping it must narrow to the session's recorded agent and chosen auth
  method, injecting exactly the one credential the workspace was created
  with (a code comment on `allAuthEnvKeys()` in `src/agents/registry.ts`
  already marks this). The session then needs to record the chosen method,
  and `cww auth`'s closing workspace report gets sharper for free — only
  workspaces actually using the rotated method are listed. `none`
  workspaces refresh just the git credential.
- **`$`-escaping (review item 2):** scoped injection shrinks the
  global-env/compose parser-divergence problem, since `~/.cww/env` stops
  being an `env_file`; the injected values must use the already-solved `$$`
  doubling of `generateAgentEnvOverride` (or the task-dir env with the same
  escaping).
- **Effective-config resolution and dump (review items 3 and 4):** the auth
  method joins the `flag > project config > global default` precedence chain
  that `resolveEffectiveConfig` would own, and the `cww config` dump prints
  which credential (redacted) each workspace gets and why.
