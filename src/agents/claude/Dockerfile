# claude — Anthropic Claude Code, layered on the shared cww base image.
#
# Build the base first — 'cww build claude' does both steps in order:
#   docker build -t cww-base:latest <cww>/docker/base
#   docker build -t coder-workspace-workflow:claude <cww>/src/agents/claude
# FROM cww-base:latest resolves against the LOCAL image store only; if the
# base was never built, BuildKit falls back to trying to pull
# docker.io/library/cww-base and dies with a confusing registry error.
FROM cww-base:latest
USER root

# Install Claude Code CLI + the Chrome DevTools MCP server (pinned; it attaches
# to the cww browser stack over CDP — see the mcpServers entry in
# claude-onboarding.json) + the TypeScript language server that backs Claude
# Code's LSP tool (enabled via the typescript-lsp plugin baked below).
RUN npm install -g @anthropic-ai/claude-code chrome-devtools-mcp@1.5.0 \
    typescript-language-server typescript

# Stamp the installed CLI version into the image. It is nowhere in image
# metadata, so this file is what lets 'cww list --versions' report what a
# workspace runs without launching the agent. First line only; a failure leaves
# the file empty rather than breaking the build, and the host degrades to '?'.
RUN mkdir -p /usr/local/share/cww && \
    claude --version 2>/dev/null | head -1 > /usr/local/share/cww/agent-version

# Disable the auto-updater — a disposable container never self-updates.
# (Note: this stops update *attempts* but does NOT remove the harmless
# "No write permissions for auto-updates" /status diagnostic, which is an
# inherent filesystem check on the root-owned npm-global install dir. Removing
# that line entirely would require switching to the native installer under a
# user-writable ~/.local/bin, which isn't worth it here.)
ENV DISABLE_AUTOUPDATER=1

# Bake a minimal, static Claude Code config so a fresh unattended session lands
# straight at the prompt with ZERO interactive prompts — no host config is
# copied in (auth is supplied at runtime via CLAUDE_CODE_OAUTH_TOKEN in the
# env_file).
#
# claude-onboarding.json -> ~/.claude.json (stateful): the bits that can't be
# set via settings.json / env / flags (Claude Code issues #4714, #720):
#   - hasCompletedOnboarding    → skips the theme/welcome wizard
#   - bypassPermissionsModeAccepted → pre-accepts the one-time
#     '--dangerously-skip-permissions' acknowledgment
#   - projects["/workspace"].hasTrustDialogAccepted → pre-trusts the workspace
#     (the trust dialog is a separate gate that --dangerously-skip-permissions
#     does NOT bypass)
#   - the user-scope mcpServers entry (top level — applies to all projects, no
#     approval dialog) points chrome-devtools-mcp at the cww browser stack's
#     CDP port; browser-hook.sh strips it when CWW_BROWSER=off.
#
# settings.json -> ~/.claude/settings.json (declarative): theme + nonessential
# traffic off + a custom status line ("<cwd> | <model> | <context tokens>") +
# the typescript-lsp plugin enablement (extraKnownMarketplaces/enabledPlugins).
RUN mkdir -p /home/developer/.claude
COPY claude-onboarding.json /home/developer/.claude.json
COPY settings.json /home/developer/.claude/settings.json

# Bake the custom status line script referenced by settings.json above.
COPY statusline.sh /home/developer/.claude/statusline.sh
RUN chmod 755 /home/developer/.claude/statusline.sh && \
    chown -R developer:developer /home/developer/.claude /home/developer/.claude.json

# This agent's half of the entrypoint's browser wiring (see
# docker/base/entrypoint.sh). CWW_IMAGE_AGENT is an inspection marker only —
# deliberately NOT named CWW_AGENT, which is a host-side config variable the
# compose env_file injects at runtime (env_file overrides image ENV).
ENV CWW_IMAGE_AGENT=claude
COPY browser-hook.sh /usr/local/share/cww/browser-hook.sh
RUN chmod 755 /usr/local/share/cww/browser-hook.sh

USER developer

# Materialize the typescript-lsp plugin at build time so the first launch needs
# no marketplace fetch (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is on, and a
# workspace must reach the prompt with zero delays/prompts). 'marketplace add'
# clones anthropics/claude-plugins-official (public, unauthenticated) into
# ~/.claude/plugins/marketplaces/ and 'install' records it in
# ~/.claude/plugins/installed_plugins.json — that state, plus the
# extraKnownMarketplaces/enabledPlugins keys already baked in settings.json, is
# all the plugin system needs at runtime. The server binary itself is the
# npm-global typescript-language-server installed above.
#
# Running the claude CLI here also stamps volatile housekeeping (machineID,
# migration flags, settings reformat) into ~/.claude.json and settings.json, so
# re-COPY both afterwards: the baked configs stay byte-identical to this repo's,
# and each workspace generates its own identifiers on first run.
RUN claude plugin marketplace add anthropics/claude-plugins-official && \
    claude plugin install typescript-lsp@claude-plugins-official && \
    rm -rf /home/developer/.claude/backups
COPY --chown=developer:developer claude-onboarding.json /home/developer/.claude.json
COPY --chown=developer:developer settings.json /home/developer/.claude/settings.json

ENV CWW_AGENT_CMD="claude --dangerously-skip-permissions"
