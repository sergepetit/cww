# pi — Pi coding agent (@earendil-works/pi-coding-agent, pi.dev), layered on
# the shared cww base image.
#
# Build the base first — 'cww build pi' does both steps in order:
#   docker build -t cww-base:latest <cww>/docker/base
#   docker build -t coder-workspace-workflow:pi <cww>/src/agents/pi
# FROM cww-base:latest resolves against the LOCAL image store only; if the
# base was never built, BuildKit falls back to trying to pull
# docker.io/library/cww-base and dies with a confusing registry error.
FROM cww-base:latest
USER root

# Install the Pi CLI. --ignore-scripts is Pi's own recommended install form
# (pi.dev). No chrome-devtools-mcp here, unlike the other agent images: Pi has
# no MCP support ("No MCP" — pi.dev), so it can't drive the cww browser stack.
# The base image still runs headful Chrome + noVNC for the human to watch/take
# over; the agent simply has no MCP bridge to it. See docs/pi-agent-plan.md.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Stamp the installed CLI version into the image. It is nowhere in image
# metadata, so this file is what lets 'cww list --versions' report what a
# workspace runs without launching the agent. First line only; a failure leaves
# the file empty rather than breaking the build, and the host degrades to '?'.
RUN mkdir -p /usr/local/share/cww && \
    pi --version 2>/dev/null | head -1 > /usr/local/share/cww/agent-version

# This agent's inspection marker (see docker/base/entrypoint.sh). Deliberately
# NOT named CWW_AGENT, which is a host-side config variable the compose
# env_file injects at runtime (env_file overrides image ENV). No browser-hook.sh
# is shipped — Pi has no MCP entry to strip, and the entrypoint skips a missing
# hook cleanly.
ENV CWW_IMAGE_AGENT=pi

USER developer
# --approve trusts the project-local files (/workspace) for this run, clearing
# Pi's one blocking first-run prompt — its input-loading guard against a repo
# silently changing settings/extensions (the analog of copilot's trustedFolders
# and claude's trust dialog). Tool use itself needs no flag: Pi is
# permissionless by default (pi.dev's design — an agent that can already write
# and run code makes per-tool prompts security theatre), the same stance
# claude's --dangerously-skip-permissions and opencode's --auto opt into. The
# container is the sandbox.
ENV CWW_AGENT_CMD="pi --approve"
