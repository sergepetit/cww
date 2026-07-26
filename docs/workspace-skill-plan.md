---
type: plan
title: Built-in Workspace Skill
description: Inject a built-in cww skill into every workspace at create, so the agent knows it is running inside a cww workspace — which commands are host-side, how the environment is wired, and guided flows for authoring the repo's .cww/ config from within
status: done
created: 2026-07-14
timestamp: 2026-07-14
tags: [skills, agents, ux, onboarding]
---

# Built-in Workspace Skill

**Done 2026-07-14**: unit-tested, with a host Docker pass.

## Problem

The agent running inside a workspace knows nothing about cww. Today the only
cww-specific things it can observe are a few env vars (`CWW_WORKSPACE`,
`BRANCH_NAME`, `REPO_URL`, `CWW_BROWSER`) and, for Claude Code, an MCP entry
for the built-in browser. Nothing explains what they mean. Concretely:

- **It gives un-runnable advice.** Asked "how do I reset the database seed?"
  or "how do I expose this port?", the agent has no way to know the answer is
  a `cww` command (`cww reset`, `cww tunnel-command`) that only exists on the
  host — or that *it* can't run it, but the user can. At worst it invents
  docker commands that fail (there is no docker socket inside).
- **It can't explain its own environment.** The compose network, service
  hostnames, loopback-published ports, the noVNC browser tab, the scoped git
  credential, tmux detach — all documented in the user guide, none of it
  visible to the agent that users will naturally ask first.
- **It can't help configure cww for the repo**, even though it is well placed
  to: the repo usually already contains a `docker-compose.yml`, CI config, or
  seed scripts from which `.cww/docker-compose.services.yml` and
  `.cww/reset.sh` could be inferred. Today that authoring is entirely manual
  and host-side.

## Feature

Ship a built-in skill — `cww/SKILL.md` in the portable
[Agent Skills](https://agentskills.io) format — and load it into every
workspace at create time, landing in the same per-agent skills directory the
personal `.cww/skills` mechanism already targets (`~/.claude/skills`,
`~/.vibe/skills`, `~/.config/opencode/skills`). Skills are the one asset kind
every agent consumes, and their progressive-disclosure model fits: only the
one-line description sits in context until the agent actually needs it.

### Skill content (outline)

The skill folder is SKILL.md plus bundled references — the Agent Skills
progressive-disclosure model: only the description sits in context; SKILL.md
is read when triggered; reference files only when actually needed.

```
cww/
  SKILL.md          # lean, behavioral — the sections below
  references/
    user-guide.md          # copied from the installed cww's docs/
    accessing-services.md
    git-strategy.md
```

Embedding the user guide (rather than restating it) is what keeps SKILL.md
honest: for command reference, options, cache presets, and troubleshooting,
it defers to `references/user-guide.md` — always the version shipped with the
cww that created the workspace, with no second copy of the facts to drift.
SKILL.md itself must frame the references: *these docs are written for the
user on their host machine; nothing in them runs inside this workspace unless
this skill says so* — and it must never lead the agent to ask the user to
bring host secrets (`~/.cww/env` tokens) into the workspace.

SKILL.md is agent-agnostic wording (it serves claude, vibe, and opencode) and
self-contained together with its references (no fetching repo docs — the repo
may be private and the skill must work offline). Sections:

1. **You are inside a cww workspace.** What cww is in two sentences.
   `CWW_WORKSPACE` names the workspace; `BRANCH_NAME`, `REPO_URL`,
   `CWW_BROWSER` carry the rest. `/workspace` is a fresh, self-contained
   clone — disposable by design; anything not committed and pushed dies with
   the workspace.
2. **Environment topology.** App services (db, cache, …) run as sibling
   containers on this workspace's own compose network, reachable by service
   hostname. Ports are published loopback-only on the *host*; the user reaches
   them via `cww list` / `cww tunnel-command`, not via addresses the agent can
   print from inside. The built-in headful browser (when `CWW_BROWSER=on`) is
   the way to see the app; the user can watch or take over via noVNC.
3. **Git rules.** The clone carries one scoped credential for this repo only;
   branching, committing, and pushing are normal and expected. Authorship is
   preconfigured. No other host credentials exist here.
4. **The inside/outside boundary** — the core UX payoff. The `cww` CLI exists
   only on the user's machine; there is no docker socket in the container.
   Every `cww …` command the agent recommends (`attach`, `teardown`, `init`,
   `cache`, `build`, `reset`, `tunnel-command`) must be prefixed with "on your
   host machine, run …". A short table of common user questions → the
   host-side command that answers them; details and troubleshooting live in
   `references/user-guide.md`.
5. **Authoring the repo's `.cww/` config from inside** — the assistive flows:
   - `docker-compose.services.yml`: infer service definitions from the repo's
     existing `docker-compose.yml`, CI config, or README (strip host port
     bindings in favor of cww's publishing model, point named caches at
     `${HOME}/.cww/cache/...` mounts).
   - `reset.sh`: derive a reset/seed script from the project's migration and
     seed tooling.
   - `hosts`: internal VCS/registry hostnames the container's DNS can't
     resolve.
   - `opencode.json`, `skills/`, `commands/`, `agents/`: what each is for and
     which agent consumes it.
6. **How config changes take effect** — the non-obvious loop the skill must
   spell out every time. cww reads `.cww/` from the **host checkout**, not
   from the container's clone. So: the agent edits `.cww/…` inside its clone →
   commits and pushes → the user pulls on the host → runs the applying command
   there (`cww teardown NAME && cww create NAME` for services/env changes,
   `cww reset NAME` for `reset.sh`, `cww init` for credential/URL changes).
   Without this section the flows in (5) produce files that silently do
   nothing.

The frontmatter `description` is the trigger surface — written so the skill
fires when the user asks about the environment, services, ports, "this
sandbox", resetting data, or configuring cww, e.g.: *"How this cww workspace
works and how to configure cww for this repo. Use when asked about the
environment, its services/ports/browser, resetting data, or anything
involving the cww tool."*

### Delivery mechanism

**Copy at create time from the cww install** (new `templates/skills/cww/`
directory holding SKILL.md), reusing `copyDirIntoContainer` and the agent's
existing `personalAssets.skills` destination. Runs in the same best-effort
block of `finalizeAndAttach` as `materializeCwwAssets`, **before** personal
assets, so a user's own skill with the same name overrides the built-in.

The `references/` docs are **not duplicated** into `templates/`: the copy
step stages the skill folder and pulls the reference docs straight from the
install's `docs/` (`getCwwDir()/docs/user-guide.md`, …) — single source of
truth. Prerequisite: `install.sh` doesn't ship `docs/` today (it copies
`src`, `docker/base`, `templates`, `examples`, `completions`), so it gains a
`docs/` copy — a few Markdown files. A dev checkout running `src/cli.ts`
directly already has `docs/` in place. Missing reference docs at create time
degrade to a warning, not a failed create (consistent with the best-effort
asset block).

Alternatives considered:

- *Bake into the per-agent images.* Rejected: updating the skill would
  require `cww build`, and images go stale silently. Create-time copy means
  every new workspace carries the skill matching the installed cww version.
- *Render a template with workspace facts.* Unnecessary: the facts that vary
  per workspace (name, branch, repo URL, browser on/off) are already in the
  container's env; the skill points at them instead. A static file is
  versionable and testable as-is.
- *Inline the user guide's content into SKILL.md.* Rejected: SKILL.md is
  read whole whenever the skill triggers; a ~530-line guide in it taxes every
  trigger. As a bundled reference it costs nothing until consulted.
- *Point at the docs on GitHub instead of bundling.* Rejected: the repo may
  be private (no unauthenticated fetch from the container) and the linked
  docs would describe cww's HEAD, not the installed version.
- *Have the user commit it to the repo.* That's what team `.claude/skills`
  are for; the point here is zero setup and staying current with cww itself.

### Opt-out

On by default. `CWW_SKILL=off` in `~/.cww/env`, or `"skill": "off"` in the
project's `~/.cww/config.json` entry — the same two-level pattern as the
browser flag. (Could be deferred; the per-name personal-skill override above
already lets a user neutralize it with an empty skill.)

## Implementation steps

1. **Author `templates/skills/cww/SKILL.md`** per the outline above. Most of
   the effort; behavioral content only — factual reference defers to the
   bundled docs.
2. **Registry plumbing** (`src/agents/registry.ts`): a pure
   `builtinSkillPlan(agent)` mirroring `personalAssetPlan` (SKILL.md from
   `getCwwDir()/templates/skills`, `references/` assembled from
   `getCwwDir()/docs`, dest from `personalAssets.skills`; agents that map no
   skills dir get nothing), and a staged copy in `materializeCwwAssets` ahead
   of personal assets.
3. **`install.sh`**: ship `docs/` into the install dir alongside `templates/`.
4. **Opt-out plumbing** in `src/lib/config.ts` alongside `browserEnabled()`.
5. **Tests**: the plan function (routing per agent, reference list, opt-out);
   a content check that `templates/skills/cww/SKILL.md` has valid frontmatter
   and a `name` matching its directory, and that every referenced doc exists.
6. **Docs**: README "optional per-project hooks" paragraph gains a line;
   user-guide section on the built-in skill and its opt-out; this doc's
   status; `docs/index.md`.

## Risks and open questions

- **Doc drift.** Mostly designed out: SKILL.md carries behavioral rules and
  pointers (env vars, the apply-loop), while factual reference lives in the
  bundled copy of the real docs, shipped and versioned with cww itself. What
  remains is keeping SKILL.md's *behavioral* claims (e.g. "no docker socket
  inside") true as cww evolves.
- **Host-POV references.** The bundled guide addresses the user at their
  host machine (install steps, `~/.cww/env` editing, token setup). SKILL.md
  must frame that perspective explicitly so the agent relays those steps to
  the user instead of attempting them in the container — and never asks the
  user to paste host secrets into the workspace.
- **Stale skill in long-lived workspaces.** The copy happens at create; a
  workspace created before a cww upgrade keeps the old skill until recreated.
  Acceptable for disposable workspaces; worth a line in the skill itself
  ("this describes cww as of the version that created this workspace").
- **Agent trust in inference flows.** The services-inference flow writes
  compose config the host will run. That is no more privileged than any other
  file the agent commits — the user reviews and pulls it — but the skill
  should tell the agent to present the generated file for review rather than
  push it silently, consistent with cww's interactive-first stance.
- **Naming.** `cww` as the skill name is short and collision-safe enough
  under the override rule; `cww-workspace` is the fallback if a flat `cww`
  proves confusing next to user skills.

## Why the troubleshooting reference's wording is deliberate

Getting `references/troubleshooting.md` *read*, and read correctly, took three
separate fixes — validated over six live runs on 2026-07-22 (OpenCode 1.18.4,
local Qwen3.6-35B). Recorded here because it is not recoverable from the file
itself, and a later tidy-up would reintroduce both defects.

| Lever | Governs | Result |
|---|---|---|
| skill `description` | does the skill load at all | works on an LSP question; does **not** fire on a bare install |
| SKILL.md triggers | does the reference get read | works — an *action* trigger is followed where a *symptom* trigger was not |
| reference content | is the conclusion right | works, after a rewrite |

Two wording defects were found by testing, not by review:

- A symptom trigger ("read this when your tooling misbehaves") is never followed
  at the moment that matters, because nothing looks broken — the install
  succeeds and the app runs. Keep the trigger tied to an **action** the agent
  takes ("after any dependency install"), not to a symptom it would have to
  notice.
- An exemption clause ("does not apply if `typescript` was already resolvable
  when you started") got evaluated in the present tense, so the agent concluded
  code intelligence was fine when it was dead. Keep the file's remedy gated on a
  **runnable check** whose output is unambiguous, never on a condition about
  past state. (The check itself was corrected again on 2026-07-26, once the
  failure turned out to be root-resolvability rather than install timing — so
  the exemption is now "if this command prints a path, say nothing".)

Worth re-testing whenever the skill's `description` changes, since that is the
lever the whole chain hangs off.
