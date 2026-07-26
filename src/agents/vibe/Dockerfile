# vibe — Mistral Vibe, layered on the shared cww base image.
#
# Build the base first — 'cww build vibe' does both steps in order:
#   docker build -t cww-base:latest <cww>/docker/base
#   docker build -t coder-workspace-workflow:vibe <cww>/src/agents/vibe
# FROM cww-base:latest resolves against the LOCAL image store only; if the
# base was never built, BuildKit falls back to trying to pull
# docker.io/library/cww-base and dies with a confusing registry error.
FROM cww-base:latest
USER root

# Vibe is a Python 3.12+ tool; Ubuntu 26.04 ships 3.14. pipx gives it an
# isolated venv under the developer's ~/.local.
RUN apt-get update && apt-get install -y python3 python3-venv pipx && \
    rm -rf /var/lib/apt/lists/*

# Chrome DevTools MCP server (same pin as the claude image) so Vibe drives the
# cww browser stack over CDP. Its [[mcp_servers]] entry ships as a snippet
# that browser-hook.sh appends to ~/.vibe/config.toml on boot (skipped when
# CWW_BROWSER=off) — appended at runtime rather than baked, so a disabled
# browser leaves no dead MCP entry to strip from TOML.
RUN npm install -g chrome-devtools-mcp@1.5.0
COPY vibe-mcp.toml /usr/local/share/cww/vibe-mcp.toml

# This agent's half of the entrypoint's browser wiring (see
# docker/base/entrypoint.sh). CWW_IMAGE_AGENT is an inspection marker only —
# deliberately NOT named CWW_AGENT, which is a host-side config variable the
# compose env_file injects at runtime (env_file overrides image ENV).
ENV CWW_IMAGE_AGENT=vibe
COPY browser-hook.sh /usr/local/share/cww/browser-hook.sh
RUN chmod 755 /usr/local/share/cww/browser-hook.sh

USER developer
RUN pipx install mistral-vibe

# Suppress the update check — same intent as claude's DISABLE_AUTOUPDATER and
# opencode's OPENCODE_DISABLE_AUTOUPDATE, but here it is load-bearing rather
# than belt-and-braces. Checks default on (enable_update_checks in vibe's
# settings), and the prompt is a launch gate: accepting runs 'uv tool upgrade'
# then 'brew upgrade' as a fallback, and this image has NEITHER (vibe arrives
# via pipx), so the update fails and vibe exits 1 — which kills the tmux pane
# instead of landing the user at a prompt. Even a *successful* update exits 0
# and asks to be relaunched. Env beats vibe's TOML config source, so this also
# holds when a repo commits its own .vibe/config.toml (which otherwise replaces
# the user config wholesale — see browser-hook.sh).
ENV VIBE_ENABLE_UPDATE_CHECKS=false

# tmux launches CWW_AGENT_CMD via 'sh -c' (not a login shell), so pipx's bin
# dir must be on PATH explicitly.
ENV PATH="/home/developer/.local/bin:${PATH}"

# Stamp the installed CLI version into the image. It is nowhere in image
# metadata, so this file is what lets 'cww list --versions' report what a
# workspace runs without launching the agent. Unlike the npm-based images this
# has to come after the developer-stage pipx install (and after the PATH above,
# which is what makes 'vibe' resolvable); root only to write under
# /usr/local/share. First line only; a failure leaves the file empty rather
# than breaking the build, and the host degrades to '?'.
USER root
RUN vibe --version 2>/dev/null | head -1 > /usr/local/share/cww/agent-version
USER developer

# Auth is supplied at runtime via MISTRAL_API_KEY in the env_file (or a
# repo-committed .vibe/config.toml for custom providers). --yolo auto-approves
# tool use (the container is sandboxed, same rationale as claude's
# --dangerously-skip-permissions); --trust marks the freshly cloned /workspace
# trusted so a project .vibe/config.toml is honored.
ENV CWW_AGENT_CMD="vibe --yolo --trust"
