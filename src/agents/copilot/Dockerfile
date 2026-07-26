# copilot — GitHub Copilot CLI (@github/copilot), layered on the shared cww
# base image.
#
# Build the base first — 'cww build copilot' does both steps in order:
#   docker build -t cww-base:latest <cww>/docker/base
#   docker build -t coder-workspace-workflow:copilot <cww>/src/agents/copilot
# FROM cww-base:latest resolves against the LOCAL image store only; if the
# base was never built, BuildKit falls back to trying to pull
# docker.io/library/cww-base and dies with a confusing registry error.
FROM cww-base:latest
USER root

# Install the Copilot CLI (needs the base image's Node 22+) + the Chrome
# DevTools MCP server (same pin as the other agent images; it attaches to the
# cww browser stack over CDP — see mcp-config.json).
RUN npm install -g @github/copilot chrome-devtools-mcp@1.5.0

# Bake the global MCP config so the chrome-devtools entry pointing at the cww
# browser stack's CDP port is registered from the first session;
# browser-hook.sh strips it when CWW_BROWSER=off. config.json pre-trusts
# /workspace so the first session doesn't open on the folder-trust dialog (see
# the file). No host config or login is ever copied in — auth arrives at
# runtime via the env_file (COPILOT_GITHUB_TOKEN, or the BYOK COPILOT_*
# variables; the CLI's keychain login flow doesn't work headless anyway).
RUN mkdir -p /home/developer/.copilot
COPY mcp-config.json /home/developer/.copilot/mcp-config.json
COPY config.json /home/developer/.copilot/config.json
RUN chown -R developer:developer /home/developer/.copilot

# The image is the source of truth for the CLI version ('cww build copilot'
# rebuilds it); a container self-updating on start would drift from it. Every
# agent image suppresses updates, though for varying reasons: claude's
# DISABLE_AUTOUPDATER and opencode's OPENCODE_DISABLE_AUTOUPDATE are belt and
# braces over a second mechanism, vibe's VIBE_ENABLE_UPDATE_CHECKS is the only
# thing keeping a failed update from killing the pane, and this one is copilot's
# sole brake — its config.json has no autoUpdate key and the updater's state dir
# survives a compose restart.
ENV COPILOT_AUTO_UPDATE=false

# This agent's half of the entrypoint's browser wiring (see
# docker/base/entrypoint.sh). CWW_IMAGE_AGENT is an inspection marker only —
# deliberately NOT named CWW_AGENT, which is a host-side config variable the
# compose env_file injects at runtime (env_file overrides image ENV).
ENV CWW_IMAGE_AGENT=copilot
COPY browser-hook.sh /usr/local/share/cww/browser-hook.sh
RUN chmod 755 /usr/local/share/cww/browser-hook.sh

USER developer
# Auto-approve tools, paths, and URLs — same rationale as claude's
# --dangerously-skip-permissions and opencode's --auto: the container is the
# sandbox. (--yolo/--allow-all are today's aliases for exactly these three;
# spelling them out keeps the grant explicit if that shorthand ever widens.)
# They do not cover the folder-trust dialog — that's config.json above.
#
# --no-remote keeps the session on this machine. Without it, a GitHub-backed
# session is exported to GitHub web/mobile — readable there, and steerable
# from there — whenever the account's remote-sessions capability allows it,
# which is on by default. A cww workspace is a local sandbox; shipping its
# prompts, replies and tool activity off-box is a choice the developer should
# make, not a default. (Nothing to disable on BYOK workspaces, which run
# offline; drop the flag in a .cww/Dockerfile to get phone access back.)
ENV CWW_AGENT_CMD="copilot --allow-all-tools --allow-all-paths --allow-all-urls --no-remote"
