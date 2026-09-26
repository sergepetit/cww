---
type: plan
title: cww on Windows (native, PowerShell)
description: Run the cww CLI natively on Windows from PowerShell or cmd against Rancher Desktop (dockerd) or Docker Desktop — the POSIX assumptions removed from the host CLI, install.ps1 and PowerShell completion, and what was verified where
status: active
created: 2026-09-25
timestamp: 2026-09-25
tags: [cli, install, windows]
---

# cww on Windows (native, PowerShell)

## Goal

`cww` runs natively on Windows 10/11 from PowerShell 5.1, PowerShell 7 or cmd, with the same commands and behaviour as on macOS/Linux. The container engine is whatever `docker` and `docker compose` resolve to. That must work with **Rancher Desktop (dockerd/moby engine)** as well as **Docker Desktop**, so nothing may assume Docker Desktop's pipe names, context names or features.

Out of scope:
- Running cww inside WSL: the Linux build works there already.
- Git Bash/mintty as the attach terminal, because it needs winpty.
- Rancher's containerd/nerdctl engine, because cww needs the docker CLI.

Missing prerequisites (git, bun, a container engine) are never installed by cww. The installer prints where to get them, including `npm install -g bun`.

## What changed

| POSIX assumption | Fix |
|---|---|
| `stty -echo` hides secret input | On Windows `promptSecret` runs `powershell.exe Read-Host -AsSecureString` (`src/lib/ui.ts`) |
| `C:\x` parsed as workspace `C` by `cww cp` | Drive paths are always host paths (`isDrivePath`, `src/lib/paths.ts`) |
| Git root spelled `C:/…`, cwd `C:\…`, case varies | `getGitRoot` resolves its output; comparisons use `sameHostPath` / `isUnderHostPath` (`src/lib/paths.ts`) |
| Directory symlinks need admin or Developer Mode | Skill links are junctions on Windows (`src/lib/skill-link.ts`) |
| `${HOME}` in compose cache mounts, unset in PowerShell | `src/cli.ts` sets `HOME` from `os.homedir()` when missing |
| In-container skill path built with `path.join` (`\home\developer\…`) | `path.posix.join` (`src/agents/registry.ts`) |
| `cp -a`, `hostname -f`, `$USER` | `fs.cpSync`, `os.hostname()`, `USERNAME` fallback |
| `chown` of a cache dir on a Windows folder mount | Not an error on Windows: those mounts have no Linux owner |
| CRLF checkouts break scripts copied into Linux images | `.gitattributes`: `* text=auto eol=lf`; SKILL.md frontmatter parsing accepts CRLF |
| bash installer, sh launcher, bash/zsh completion | `install.ps1`, `bin\cww.cmd`, `completions/cww.ps1` |
| Tests isolated via `HOME`, spawn `bun` by name, assert file modes | Also set `USERPROFILE`; spawn `process.execPath`; skip the mode assertion on Windows |

Checked and left unchanged:
- `GIT_ASKPASS=/bin/true` and the inline `!f(){…}` credential helper: both work under Git for Windows, which runs helpers through its bundled sh. Without a credential git fails fast.
- `docker cp` with Windows paths.
- `env_file:` paths with backslashes.
- `docker exec -it` for attach: see below.

## Verified (2026-09-25, Win10 22H2, Docker Desktop 29.7.2, bun 1.4.2 via npm, Git for Windows 2.55)

- `bun test` (280) and `bun run typecheck` pass on Windows and macOS.
- `install.ps1` passed end to end: prerequisite checks, files, `cww.cmd`, image build, user PATH, profile completion hook.
- `cww create` on a public repo (non-TTY with a seeded `config.json`):
  - The repo was cloned in the container.
  - The built-in skill landed at `/home/developer/.claude/skills/cww` with LF endings.
  - Claude Code started in tmux.
- `cww list`, `stop`, `teardown`.
- Workspace auto-detection from a lower-cased subdirectory cwd.
- `cww create C:\…\repo\sub w3` run from `C:\`.
- `cww cp`:
  - a drive path pushed to `ws:/tmp/`
  - `:docs/` auto-detect
  - a pull into `out\` (trailing backslash).
- `cww export-skill`: a junction, live injection, idempotent re-run, CRLF SKILL.md description.
- `cww install-skill`: a junction, re-run, `--remove`.
- `cww cache npm` plus a `${HOME}/.cww/cache/npm/_cacache` mount in `.cww/docker-compose.services.yml`: the container wrote, and the host saw the file.

## Still to verify (needs a person at the Windows console)

- [ ] `cww attach` and `cww shell` in Windows Terminal and in the PowerShell 5.1 console: resize, Ctrl-C inside the agent, `Ctrl-a d` detach.
- [ ] The secret prompt during `cww init` / `cww auth` (masked input, value stored).
- [ ] Tab completion typed live in PowerShell 5.1 and 7, including `cww cp w<TAB>` giving `w1:`. Already checked through `TabExpansion2` over ssh: commands, flag values, agents, auth methods, build targets, host skills, cache presets. A bare `--<TAB>` gets nothing, because PowerShell 5.1 doesn't consult native completers there; `--a<TAB>` works.
- [ ] `install.ps1` on a machine missing bun/git: it prints the pointers and stops.

## Rancher Desktop smoke test (not yet run: no Rancher box)

With Rancher Desktop installed and **Container Engine → dockerd (moby)** selected:

1. `docker context ls` and `docker compose version` work from a new PowerShell.
2. `install.ps1` reports the engine as running and builds the image.
3. `cww create` on a public repo; `cww attach`; detach.
4. `cww cache npm`, then a workspace with the `${HOME}` cache mount. Check that `npm install` inside can write the cache. This is the most likely Rancher difference: its WSL mounts could handle ownership differently.
5. `cww cp` both ways; `cww teardown`.
6. With the **containerd** engine selected instead: `install.ps1` should stop at the docker/compose check with the Rancher pointer.
