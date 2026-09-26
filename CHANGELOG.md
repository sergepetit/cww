# Changelog

Notable changes to cww, newest first. Versions follow [semantic versioning](https://semver.org); before 1.0, a minor version may change configuration or require rebuilding images, and its **Upgrading** section says what to do.

## 0.3.0 — 2026-09-26

### Upgrading from 0.2.0

- **Reinstall, then rebuild the images.** `git pull && ./install.sh` (or `install.ps1`), then `cww build all`. The base image moved to Ubuntu 26.04 and Node 22, and the entrypoint changed; workspaces created on 0.2.0 images are not supported — tear them down and create them again.
- **Git credentials moved.** `CWW_GIT_USER`/`CWW_GIT_TOKEN` and `CWW_REPO_URL` in `~/.cww/env`, and `<repo>/.cww/env`, are no longer read. Run `cww init` in each repo (the first `cww create` in a repo also does it): the clone URL goes to `~/.cww/config.json` and the token to `~/.cww/credentials`, validated before it is saved.
- **`~/.cww/env` no longer reaches containers wholesale.** A workspace gets exactly one agent credential, chosen by its auth method (`cww create --auth <method>`, asked once per project). Anything your project's services need from the environment goes in `~/.cww/services.env` instead.
- **`cww build` is fresh by default**, so it picks up the latest agent CLI; add `--cached` for the old behavior.
- **A `.cww/docker-compose.services.yml` with `build:`** now fails at create with an explanation, instead of partway through bring-up. Services must use images.
- **`cww list`** drops the TASK DIR column (it is still in `--json`) and gains an IMAGE column.

### Added

- **Three more agents:** [OpenCode](https://opencode.ai), GitHub Copilot CLI (including BYOK against any OpenAI-compatible endpoint, such as a local llama.cpp server), and [Pi](https://pi.dev). Each agent is one self-contained folder under `src/agents/`.
- **Native Windows support:** the CLI runs from PowerShell or cmd against Rancher Desktop or Docker Desktop, with `install.ps1` and PowerShell completion.
- **Per-repo git credentials** with a first-run setup flow: the token is checked with `git ls-remote` before it is stored, and the URL is probed from inside a container to catch self-hosted names that don't resolve there.
- **`cww auth`** stores or renews an agent token or a repo's git credential. Stopped workspaces pick up renewed secrets on their next start.
- **Per-project workspace images:** a `.cww/Dockerfile` is built on top of the agent image at every create.
- **New commands:** `cww cp` (scp-style copy between host and workspace), `cww export-skill` (share a host skill with a repo's workspaces, including running ones), and `cww install-skill` (opt-in host-side skill for the agent on your machine).
- **Built-in workspace skill,** loaded into every workspace and re-synced on every start, so the agent inside knows how its environment is wired.
- **Scoped services env:** `~/.cww/services/<project>.env` and `~/.cww/services/<project>/<workspace>.env` on top of `~/.cww/services.env`.
- **Default Claude models:** `ANTHROPIC_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, overridable per project.
- **TypeScript LSP** built into the claude and opencode images.
- **Image freshness:** `cww list` shows each workspace image's age and drift (`--versions` adds the agent CLI version), and `cww create` warns before creating a workspace on an old image.
- `cww create --remote <name>` to clone from a non-origin remote; `cww tunnel-command --terse`.
- Bash and zsh tab completion for commands, flags and workspace names.
- tmux copies to the system clipboard (OSC 52) on terminals that support it; `bat` in the base image.

### Fixed

- A failed in-container clone no longer looks like success: the workspace opens on `cww.log` instead of starting the agent in an empty directory.
- Recreating a workspace re-syncs the services file from the project instead of reusing a stale copy.
- Home directories above a mounted cache (such as `~/.ivy2`, `~/.cache`) are writable, so tools that write beside the cache work.
- The built-in browser can no longer be started twice, and the workspace skill documents how to recover it.
- The keep-alive tmux client no longer shrinks the agent's pane to 80×24.

## 0.2.0 — 2026-07-09

- The host-side CLI is rewritten from Bash to TypeScript on Bun: no build step and no npm runtime dependencies, with a unit test suite. Prerequisites become Docker, Git and Bun; `install.sh` offers to install Bun.
- `cww list` sizes its columns instead of clipping them; long container hostnames are truncated to the kernel's 63-character limit; starting a stopped workspace from `cww create` restarts its whole stack.

## 0.1.0 — 2026-07-09

First release: disposable Docker workspaces that clone a repo and run its services, with Claude Code or Mistral Vibe inside, a built-in browser, dependency caches, and SSH tunnelling to workspace ports. Written in Bash.
