# opencode — OpenCode (opencode.ai), layered on the shared cww base image.
#
# Build the base first — 'cww build opencode' does both steps in order:
#   docker build -t cww-base:latest <cww>/docker/base
#   docker build -t coder-workspace-workflow:opencode <cww>/src/agents/opencode
# FROM cww-base:latest resolves against the LOCAL image store only; if the
# base was never built, BuildKit falls back to trying to pull
# docker.io/library/cww-base and dies with a confusing registry error.
FROM cww-base:latest
USER root

# Install the OpenCode CLI + the Chrome DevTools MCP server (same pin as the
# other agent images; it attaches to the cww browser stack over CDP — see the
# mcp entry in opencode.json) + typescript-language-server for OpenCode's
# native LSP support ("lsp": true in opencode.json).
#
# Note what the baked typescript-language-server is and is NOT for (verified
# against 1.18.4 — see docs/typescript-lsp-upstream.md). The built-in
# "typescript" server does NOT look on PATH: its which() call is OpenCode's
# package *fetcher*, so it downloads its own copy into
# ~/.cache/opencode/packages on first use and ignores this one. (Contrast vue
# and pyright, which do try PATH first and honour disableLspDownload.) The
# baked copy is what a repo-committed opencode.json spawns when it supplies a
# "command" verbatim — the only path to TypeScript intelligence in a workspace
# that cannot reach the npm registry.
#
# No global 'typescript' though (unlike the claude image): OpenCode resolves
# tsserver.js from the WORKSPACE ROOT's node_modules and won't spawn the server
# without it, so a global copy would never be used.
RUN npm install -g opencode-ai chrome-devtools-mcp@1.5.0 typescript-language-server

# Disable the auto-updater — a disposable container never self-updates.
# Belt and braces: this env var plus "autoupdate": false in opencode.json.
ENV OPENCODE_DISABLE_AUTOUPDATE=true

# Bake the global OpenCode config so a fresh unattended session lands straight
# at the prompt with ZERO first-run onboarding — no host config is copied in
# (auth arrives at runtime via a provider API key in the env_file).
#
# opencode.json -> ~/.config/opencode/opencode.json: auto-update off, session
# sharing disabled, LSP on (built-in servers — every one of them, TypeScript
# included, fetches its language server into ~/.cache/opencode/packages on
# first use), and the chrome-devtools MCP entry pointing at the cww browser
# stack's CDP port; browser-hook.sh strips it when CWW_BROWSER=off.
# A repo-committed opencode.json merges OVER this global config (unlike Vibe's
# replace-only config.toml), so project config can't hide the MCP entry.
#
# tui.json -> ~/.config/opencode/tui.json: the theme, which also skips the
# first-run theme picker.
RUN mkdir -p /home/developer/.config/opencode
COPY opencode.json /home/developer/.config/opencode/opencode.json
COPY tui.json /home/developer/.config/opencode/tui.json
RUN chown -R developer:developer /home/developer/.config

# This agent's half of the entrypoint's browser wiring (see
# docker/base/entrypoint.sh). CWW_IMAGE_AGENT is an inspection marker only —
# deliberately NOT named CWW_AGENT, which is a host-side config variable the
# compose env_file injects at runtime (env_file overrides image ENV).
ENV CWW_IMAGE_AGENT=opencode
COPY browser-hook.sh /usr/local/share/cww/browser-hook.sh
RUN chmod 755 /usr/local/share/cww/browser-hook.sh

USER developer
# --auto auto-approves tool use — same rationale as claude's
# --dangerously-skip-permissions and vibe's --yolo: the container is the
# sandbox.
ENV CWW_AGENT_CMD="opencode --auto"
