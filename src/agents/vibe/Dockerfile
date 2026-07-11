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

# Vibe is a Python 3.12+ tool; Ubuntu 24.04 ships 3.12. pipx gives it an
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

# tmux launches CWW_AGENT_CMD via 'sh -c' (not a login shell), so pipx's bin
# dir must be on PATH explicitly.
ENV PATH="/home/developer/.local/bin:${PATH}"

# Auth is supplied at runtime via MISTRAL_API_KEY in the env_file (or a
# repo-committed .vibe/config.toml for custom providers). --yolo auto-approves
# tool use (the container is sandboxed, same rationale as claude's
# --dangerously-skip-permissions); --trust marks the freshly cloned /workspace
# trusted so a project .vibe/config.toml is honored.
ENV CWW_AGENT_CMD="vibe --yolo --trust"
