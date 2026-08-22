---
type: plan
title: A Host-Side cww Skill (`cww install-skill`)
description: Ship a second built-in skill for the agent running on the user's own machine — opt-in, symlinked into one host agent config — so setting a repo up for cww and authoring its .cww/ files stops being guidance that only exists inside a workspace
status: active
created: 2026-08-16
timestamp: 2026-08-16
tags: [skills, cli, ux]
---

# A Host-Side cww Skill (`cww install-skill`)

**Implemented 2026-08-16**: unit-tested, with a host pass over a scratch
install (isolated `HOME`, `install.sh` into a throwaway install dir) covering
install, `--all`, `--copy`, `--remove`, the idempotent re-run, and every
refusal path. All three decisions below were taken as recommended.

One question is deliberately still open — see
[Remaining verification](#remaining-verification).

## Problem

The built-in workspace skill ([workspace-skill-plan.md](workspace-skill-plan.md),
done 2026-07-14) only exists *inside* a workspace, so it can only help once
the hard part is over. Everything up to and including the first
`cww create` happens on the host, where no agent has any idea cww exists.

Three concrete gaps:

- **Bootstrapping a repo.** `cww init` (clone URL + a scoped PAT), agent
  auth, the docker/image preflight, then the first create. The agent's job
  here is small but real: explain the order, hand the user the exact
  commands, and read the failure when one of them doesn't pass. It cannot
  drive these itself — they prompt, and they carry secrets.
- **Authoring `.cww/`.** `docker-compose.services.yml`, `reset.sh`,
  `Dockerfile`, `hosts`, the cache mounts, and the host-side services env
  layers. This is the genuinely agent-shaped work — read the repo's existing
  compose file, CI config and README, and write the cww versions — and today
  it is documented *only* for the in-container agent
  (`templates/skills/cww/SKILL.md`, "Helping configure cww for this repo").
  That forces the loop the container skill has to spell out every time:
  author in the workspace → commit → push → the user pulls on the host →
  the user runs `cww teardown NAME && cww create NAME`. On the host that
  loop collapses to edit-then-recreate, in the checkout cww actually reads.
  It is also the *only* path available before a workspace exists at all.
- **Discovery.** A user with cww installed, sitting in a repo asking their
  agent to "run this in a sandbox", gets no mention of the tool they already
  have.

## Non-goal: installing it automatically

`install.sh` writes to exactly two places — the install dir and
`$BIN_DIR/cww` — and that should not change:

- **cww is agent-agnostic.** Writing into `~/.claude/skills` at install time
  privileges one of five agents, and to be fair would owe the same to
  `~/.config/opencode/skills`, `~/.copilot/skills`, `~/.vibe/skills`. It also
  inverts the current relationship: those dirs are strictly *read* sources
  today (`agentHostSkillsDir`, consumed by `cww export-skill`).
- **A user-wide skill is always present.** Its description loads in every
  project the user touches, cww or not.
- **A copy drifts.** The container skill stays fresh because
  `applyBuiltinSkill` re-copies it on every start. Nothing would refresh a
  copy sitting in a host config.

Also rejected: writing `.claude/skills/cww` into each repo at `cww init`.
It puts cww's own files in the user's project (needing a gitignore entry),
and it is per-agent anyway.

## Feature

```
cww install-skill [agent] [--all] [--copy] [--remove]
```

Symlinks the host skill from the install dir into one agent's host skills
dir:

```
~/.claude/skills/cww -> ~/.local/share/coder-workspace-workflow/templates/skills/cww-host
```

- **Which agent** defaults to the same resolution `cww init` uses (`CWW_AGENT`
  from `~/.cww/env`, falling back to `claude`); a positional argument or
  `--all` overrides. An agent that declares no `hostSkillsDir` (pi today)
  gets the familiar one-line skip notice rather than an error.
- **Symlink, not copy**, so `install.sh` refreshes the skill and its
  references for free on every update — the host-side equivalent of the
  every-start re-copy. `--copy` snapshots instead, mirroring
  `export-skill`'s flag vocabulary, for users who'd rather pin or edit it.
- **Never overwrites.** An existing `~/.claude/skills/cww` — a user's own
  skill of that name, or a previous `--copy` — is reported and left alone,
  the same rule `export-skill` applies to `.cww/skills/<name>`. A dangling
  symlink counts as occupied.
- **`--remove`** unlinks it. Worth having on day one: uninstalling cww today
  means deleting the install dir, which would leave a broken symlink in the
  user's agent config with nothing to explain it.
- **No arguments** installs for the default agent and prints where it landed.

**Discovery** comes from a hint line in `install.sh`'s closing output, not a
prompt — the installer is deliberately non-interactive. Something like:
`Optional: cww install-skill  # teach your host agent about cww`.

## What the skill says

The framing is the mirror image of the container skill's. There, the rule is
"the `cww` CLI exists only on the user's host, you cannot run it". Here, the
agent *can* run it — which makes the boundaries the most important content in
the file:

- **Never run `cww teardown`.** It is destructive and pushes nothing. Hand it
  to the user with the push-first reminder.
- **Never drive `cww init` or `cww auth`.** They prompt on a TTY and take a
  PAT or an agent token, validated with `git ls-remote` before anything is
  stored. Print the command for the user to run; read the result afterwards.
- **Free to run**: `cww list`, `cww tunnel-command`, `cww cp`,
  `cww export-skill`, `cww build`, `cww start` / `cww stop`, and
  `cww create <ws> --no-attach` where the user has asked for a workspace.

Then the material that has no host-side home today:

- The setup order for a repo that has never seen cww: docker reachable →
  `cww auth <agent>` → `cww init` → author `.cww/` → `cww create <ws>`.
- The `.cww/` authoring rules (see [D1](#d1-where-the-cww-authoring-rules-live--extracted)),
  including the two cww-specific compose rules — container-port-only
  publishing, and `${HOME}/.cww/cache/...` mounts provisioned with
  `cww cache`.
- The host-side services env layers (`~/.cww/services.env`,
  `~/.cww/services/<project>.env`,
  `~/.cww/services/<project>/<workspace>.env`) — which the host agent, unlike
  the container one, can actually write. With the obvious caution: ask for
  secret values, never invent them, and never move a secret into the repo.
- Per-project settings in `~/.cww/config.json` (clone URL, agent, model,
  subagentModel) versus machine-wide `~/.cww/env`.
- The apply loop, host-side: services / hosts / env / `Dockerfile` changes →
  `cww teardown NAME && cww create NAME`; `reset.sh` → `cww reset NAME`;
  credential or clone-URL changes → `cww init`.

References are the same three docs the container skill bundles:
`user-guide.md`, `git-strategy.md`, `accessing-services.md`.

## Decisions

### D1: where the `.cww/` authoring rules live — *extracted*

The `.cww/` authoring section is ~60 lines of rules that both skills need
verbatim, and two hand-maintained copies of it will drift — exactly what the
container skill's bundled-references design was meant to avoid ("single
source of truth, no duplicated copy").

**Recommended:** extract it — plus the services env layer table — into a new
`docs/cww-project-config.md` (`type: guide`), add it to
`BUILTIN_SKILL_REFERENCES` and to the host skill's references, and leave both
SKILL.md files with a short pointer. Side benefit: it's progressive
disclosure, read only when the agent is actually configuring a repo.

Cost: it edits a shipped, done feature, and moves content out of the
container SKILL.md's always-loaded body into an on-demand file. That is a
behaviour change for existing workspaces (which re-sync the skill on every
start, so they'd pick it up), and the pointer has to be emphatic enough that
the agent opens the file.

**Alternative:** duplicate now, accept the drift. Cheaper, and keeps this
plan to purely additive changes.

**Taken:** extracted, as [cww-project-config.md](cww-project-config.md). It
joined `BUILTIN_SKILL_REFERENCES`, so existing workspaces pick it up at their
next start; the container SKILL.md keeps a pointer with the two facts that
must not wait for a file to be opened (the clone is not the host checkout;
secrets go in the host env layers).

### D2: command name — *`install-skill`*

`install-skill` reads as "install the cww skill into my agent config" and
pairs with `export-skill` (host config → project) as its inverse (cww →
host config). It does collide conceptually with `install.sh`, which installs
something else. Alternatives considered: `setup-skill`, `host-skill`,
`teach`. No strong second choice.

### D3: creating a missing host config dir — *created*

`~/.claude/skills` may not exist on a machine where the user has never
written a personal skill. `mkdir -p` it — the alternative (refusing, telling
them to create it) is friction with no safety value, since the parent config
dir is the agent's, not ours.

## Implementation

- **`templates/skills/cww-host/SKILL.md`** — new. Rides the existing
  recursive `templates/` copy in `install.sh`.
- **`install.sh`** — after the `docs/` copy, assemble
  `templates/skills/cww-host/references/` from the four reference docs (the
  container skill assembles its own at copy time; the host skill is consumed
  in place, so its references have to exist in the install dir). Add the hint
  line to the closing output.
- **`src/commands/install-skill.ts`** — new. Reuses `agentHostSkillsDir`,
  `CWW_AGENTS`, `validateAgent`, `agentLabel` from the registry. The
  "resolve target, refuse to overwrite, symlink or copy" logic already exists
  inside `export-skill.ts`; lift the shared part into `src/lib/` rather than
  writing a second copy of the occupancy rules. *(Landed as
  `src/lib/skill-link.ts` — `skillEntryPlan` / `writeSkillEntry` / `tilde`,
  with `export-skill`'s `linkPlan` reduced to its two `.cww/skills`-symlink
  special cases on top of it.)*
- **`src/cli.ts`** — dispatch case and help line.
- **`completions/_cww`, `completions/cww.bash`, `src/commands/complete.ts`** —
  the command, its flags, and agent-name completion for the positional.
- **`docs/user-guide.md`** — a `### cww install-skill` section under Commands,
  and a subsection next to "The built-in workspace skill" explaining that
  there are now two: one injected into every workspace, one opt-in on the
  host.
- **`docs/index.md`** — this plan; plus `cww-project-config.md` if D1 is
  taken.

## Testing

Unit (`tests/install-skill.test.ts`), following `tests/export-skill.test.ts`:

- target resolution per agent, including the no-`hostSkillsDir` skip (pi)
- occupancy: existing real dir, existing symlink to our target (idempotent
  re-run should report, not fail), symlink elsewhere, broken symlink
- `--copy` snapshot, `--all`, `--remove` (and `--remove` on something we
  didn't install — refuse)
- missing host config dir gets created

Host pass, under the isolated `HOME` from the `verify` skill: install into
`$S/home/.claude/skills`, confirm the symlink resolves into the install dir
and that `SKILL.md` and all three `references/` files are readable through
it.

One more test guards a list that necessarily lives twice: install.sh's
staging loop is asserted to name exactly `BUILTIN_SKILL_REFERENCES`, so
adding a reference doc to one and not the other fails the suite instead of
leaving the host skill pointing at a file that isn't there.

## Remaining verification

Whether each agent's skill loader follows a *symlinked skill directory* in
its host config. cww's own scan in `export-skill.ts` had to work around
exactly this (`Dirent.isDirectory()` is false for a symlinked folder, so it
stats the `SKILL.md` instead), which is reason enough not to assume.

The link itself is verified — `SKILL.md` and all four `references/` files
read correctly through it, and `--copy` dereferences into real files. What is
unverified is the loader on the other side. Confirm per agent by running
`cww install-skill <agent>` and restarting it; if one skips symlinks,
`--copy` becomes that agent's default rather than an option.

**claude: confirmed 2026-08-22.** `~/.claude/skills/cww` is the symlink
`cww install-skill claude` wrote, pointing into the install dir, and Claude
Code loads the skill through it — its `description` appears in the session's
skill list, which is the loader having read `SKILL.md` on the far side of the
link. Symlinks are the right default for claude. **vibe, opencode, copilot and
pi remain unverified**, so the question stays open and this plan stays
`active`.

## Risks

- **Dangling symlink after uninstall.** Removing the install dir leaves a
  broken `~/.claude/skills/cww`. `--remove` is the answer; the user guide
  section should mention it under uninstalling.
- **Name collision** with a user's own `cww` skill. Handled by the
  never-overwrite rule, but it needs a clear message — the user will wonder
  why nothing happened.
- **Two skills, one topic.** A user who installs the host skill and then
  attaches to a workspace has two `cww` skills in play, in different places,
  with overlapping descriptions. The container one's description already
  scopes itself to "this workspace"; the host one's must scope itself just as
  hard to "on your machine, setting a repo up" so an agent never loads the
  wrong one. Worth a deliberate pass over both descriptions in the same
  change.
