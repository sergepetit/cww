---
type: plan
title: Export a Personal Skill (`cww export-skill`)
description: A cww export-skill command that shares one skill from the host's agent config with a project — a symlink into .cww/skills/ for future creates, plus live injection into running workspaces
status: done
created: 2026-07-16
timestamp: 2026-07-16
tags: [skills, cli, ux]
---

# Export a Personal Skill (`cww export-skill`)

**Done 2026-07-16**: unit-tested, with a host Docker pass.

## Problem

Getting a *single* personal skill from the host into a workspace sits in an
awkward gap between two existing mechanisms:

- **All or nothing.** The documented pattern for personal skills is
  `ln -s ~/.claude/skills .cww/skills` — every global skill, or none. Sharing
  just one means knowing the per-agent host path, hand-crafting
  `mkdir -p .cww/skills && ln -s ~/.claude/skills/<name> .cww/skills/`, and
  knowing that the create-time copy dereferences symlinks.
- **Create-time only.** `.cww/skills/` takes effect at the *next*
  `cww create`. There is no way to hand a skill to a workspace that is
  already running — the moment the need usually shows up ("the agent should
  use my `organize-docs` skill for this") — short of tearing the workspace
  down and recreating it.

The second gap is the real capability hole: nothing a user can type today
puts a file into a running workspace; the first is a discoverability and
convenience problem.

## Feature

One command that does both halves and says what it did:

```
cww export-skill [name] [workspace] [--from <agent>] [--copy]
```

`cww export-skill organize-docs`, run inside a project repo:

1. **Finds the skill on the host.** Searches the known per-agent skill dirs —
   `~/.claude/skills`, `~/.vibe/skills`, `~/.config/opencode/skills` — for
   `<name>/SKILL.md`. Skills are the portable Agent Skills format, so where
   it was found doesn't constrain which agent can consume it. Zero hits dies
   listing the dirs searched; more than one hit dies asking for
   `--from <agent>` (which also restricts the search up front).
2. **Records it for future creates**: symlinks
   `<repo>/.cww/skills/<name> -> <host skill dir>/<name>` (absolute target —
   it points outside the repo). The existing create-time copy dereferences
   symlinks host-side, so nothing else changes. `--copy` snapshots instead of
   linking, for the "tweak it per-project" case.
3. **Injects it into running workspaces**: resolves the current repo's
   workspaces (or just the named one when `[workspace]` is given), and for
   each running container copies the skill folder to
   `<personalAssets.skills>/<name>` for the workspace's recorded agent —
   the same `copyDirIntoContainer` staging (dereference, docker cp, chown)
   the create path uses. Workspaces whose agent maps no skills dir get the
   familiar one-line skip notice; stopped workspaces are reported as skipped
   (they'll pick the skill up from `.cww/skills/` if recreated — the running
   ones are the point).
4. **Reports the loop closure.** Prints what landed where, plus the caveats
   that aren't obvious: agents discover skills at session start, so a
   mid-session agent may need a restart (detach, `cww attach` after the agent
   exits, or just a new conversation) before the skill triggers.

With no `name` argument, the command lists the exportable skills found in
the host dirs (name, source dir, one-line frontmatter description) — the
discovery half of the UX, and what shell completion feeds on.

### Guard rails

- **`.cww/skills` is itself a symlink** (the documented whole-dir trick): the
  persistent half must *never* write through it — creating
  `.cww/skills/<name>` would silently modify `~/.claude/skills`, the user's
  global config. Detect the symlinked dir, check whether it already exposes
  the skill, and report ("already exported via the .cww/skills symlink")
  instead of writing. The injection half still runs.
- **`.cww/skills/<name>` already exists**: don't overwrite. Report it
  (distinguishing "already a link to this same skill" from "something else
  is there") and continue to injection — re-running export-skill against a
  fresh workspace is the expected way to re-inject, and it must not trip on
  its own previous run.
- **Name collisions**: exporting a skill named `cww` shadows the built-in
  workspace skill (by design — personal assets override it at create, and a
  live inject overwrites the same dest folder). Warn, don't block.
- **Gitignore**: `.cww/skills` is personal-tier and usually gitignored. If it
  isn't, warn — a committed absolute symlink into `~` is broken for
  teammates and leaks the host layout.

### Host-side source dirs

Agents today declare only container destinations (`personalAssets`, under
`/home/developer/...`). The host source dirs are new per-agent metadata: an
optional `hostSkillsDir` on `AgentDefinition` (`~/.claude/skills`,
`~/.vibe/skills`, `~/.config/opencode/skills`; `~` expanded by the
registry). The values deliberately mirror `personalAssets.skills` — same
paths relative to `$HOME` — but stay explicit rather than derived by
string-swapping `/home/developer`: the symmetry is a convention, not a
contract, and an agent whose host config lives elsewhere (XDG variants)
must be able to say so. Agents without the field are skipped in the search.

### What stays out of scope

- **`commands` and `agents` kinds.** They are Claude-only formats; skills
  are the portable kind and the one users share across projects. If demand
  shows up, the same plan generalizes (`export-command`?), but not now.
- **Auto-injection at `cww start`.** Start already refreshes secrets;
  refreshing skills there would blur create-time semantics for little gain —
  the symlink half already covers every future create, and export-skill can
  be re-run at will.
- **Removal/listing verbs** (`cww skill list/remove`). Removal is `rm` of a
  symlink the user can see; listing is the no-arg form. If a verb family
  accrues anyway, `export-skill` can become an alias of `cww skill add`
  later — the flat verb matches the existing command style (`create`,
  `reset`, `tunnel-command`) today.

### Alternatives considered

- *Document the one-liner instead of building anything.* Covers only the
  persistent half; the live injection into a running container is not
  something a user can do with `ln`/`cp`, and it's the actual gap.
- *`cww export-skill <agent> <name>` (agent as positional source).* Rejected:
  in cww's model the skill's source agent is incidental — `.cww/skills/`
  loads into whichever agent the workspace runs. Most users have one host
  agent config populated; searching all dirs and disambiguating only on
  collision (`--from`) types less and doesn't bake the source into muscle
  memory.
- *Copy as the default, symlink behind a flag.* Rejected: a copy silently
  drifts from the host version; the symlink keeps future creates current and
  matches the already-documented pattern. `--copy` remains for deliberate
  per-project forks.
- *Inject only, skip the `.cww/skills` write.* Rejected: then the export
  evaporates on recreate — precisely the disposable-workspace flow — and the
  user re-runs the command without understanding why. Doing both halves is
  what makes the command's mental model "this project now has this skill".

## Implementation steps

1. **Registry metadata**: `hostSkillsDir` on `AgentDefinition`
   (src/agents/types.ts) and the three agent definitions; a registry
   accessor that expands `~`.
2. **Pure plan function** (src/agents/registry.ts or a new
   src/commands/export-skill.ts helper): `exportSkillPlan(name, projectPath,
   workspaces, opts, env)` → source candidates, the link/copy action (or the
   guard-rail verdict: symlinked dir, existing entry), and per-workspace
   injection targets (container, dest, or skip reason). Pure data aside from
   existence checks — same testable-without-Docker philosophy as
   `personalAssetPlan`/`builtinSkillPlan`.
3. **Command** (src/commands/export-skill.ts): arg parsing (name, optional
   workspace, `--from`, `--copy`, `--help`), the no-arg listing, executing
   the plan (fs symlink/cp + `copyDirIntoContainer` per running workspace via
   `resolveWorkspace`/`findAllSessions` + `containerRunning`), and the
   closing report. Wire into src/cli.ts (case + USAGE line).
4. **Completions**: add the command to completions/ (bash + zsh) and to the
   hidden `__complete` provider — workspace names exist there already; skill
   names come from the same host-dir scan as the no-arg listing.
5. **Tests**: the plan function (source resolution and `--from`, collision
   and zero-hit cases, symlinked-`.cww/skills` guard, existing-entry cases,
   per-agent dest routing and unmapped-agent skips, `cww`-name warning);
   listing output shape.
6. **Docs**: user-guide — a paragraph under "Skills, commands, and agents
   (two tiers)" and a row in the command table; README command list;
   `docs/index.md`; this doc's status.
7. **Host Docker pass** per the verify skill: export to a repo with a
   running claude workspace (skill appears in `~/.claude/skills/<name>`
   in-container; `.cww/skills/<name>` symlink on the host; recreate picks it
   up), a vibe workspace (lands in `~/.vibe/skills`), the symlinked-
   `.cww/skills` guard, and the stopped-workspace skip.

## Risks and open questions

- **Mid-session skill discovery.** The injected files land correctly, but
  whether a *running* agent session sees a new skill without a restart
  differs per agent (Claude Code scans at session start; Vibe/OpenCode to be
  verified). The command's closing hint covers the worst case; the Docker
  pass should pin down the actual behavior per agent so the hint can be
  precise instead of defensive.
- **Ownership of the injected folder.** `copyDirIntoContainer` chowns to
  `developer` — same as create-time assets; no new surface. But injecting
  over an *existing* skill folder leaves deleted-on-host files behind in the
  container (docker cp merges, doesn't sync). Acceptable for skills (a stale
  reference file at worst); worth a line in the command's report if it
  detected a pre-existing dest.
- **Skill name = directory name assumption.** Resolution keys on the folder
  name containing SKILL.md, consistent with how agents discover skills. A
  frontmatter `name` differing from the folder is the skill author's
  problem, not this command's — but the no-arg listing could surface the
  mismatch cheaply.
- **Vibe/OpenCode host dirs.** `~/.vibe/skills` and
  `~/.config/opencode/skills` mirror the container-side convention; confirm
  against each tool's actual host layout before hardcoding (OpenCode in
  particular respects XDG).
