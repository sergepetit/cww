# Coder Workspace Workflow - Development Container
# Multi-language base image with one final stage per coding agent. The base
# also carries the shared headful-browser stack (Chrome/Chromium + Xvfb + noVNC) that
# lets the developer watch/take over the browser the agent drives.
# Build a specific agent's image with:
#   docker build --target <claude|vibe> -t coder-workspace-workflow:<agent> .
# (or just run 'cww build <agent>', which does exactly that)

FROM ubuntu:24.04 AS base

ARG NODE_VERSION=20
ARG JAVA_VERSION=25
ARG TZ=UTC

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=${TZ}

# System dependencies. Deliberately no compilers (build-essential) or build
# tools like sbt: the agent has passwordless sudo and installs those on demand
# for the rare task that needs them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    git-lfs \
    sudo \
    fzf \
    tmux \
    procps \
    man-db \
    less \
    unzip \
    gnupg2 \
    openssl \
    jq \
    nano \
    vim \
    ripgrep \
    fd-find \
    ca-certificates \
    locales \
    && rm -rf /var/lib/apt/lists/*

# Configure UTF-8 locale for proper Unicode support
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Install Node.js via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Headful browser stack for agent/developer browser cooperation, plus
# Xvfb/x11vnc/noVNC so the developer can watch — and take over — the same
# browser the agent drives (see cww-browser.sh). No Playwright is baked in:
# projects that need it install their own version-matched copy on demand,
# like any other build tool. The browser is arch-dependent:
#   - amd64: Google Chrome (the browser chrome-devtools-mcp officially
#     supports; Google ships the deb for amd64 only).
#   - arm64: Chromium from the xtradeb PPA (native .deb for Ubuntu 24.04;
#     Ubuntu's own chromium-browser is a snap stub, unusable in containers).
#     The PPA key is fetched by full fingerprint from keyserver.ubuntu.com
#     (no add-apt-repository/dirmngr needed), and an apt pin restricts the
#     PPA to chromium* so no other package can ever come from it.
ARG TARGETARCH
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    if [ "$arch" = "amd64" ]; then \
        curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
        echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && \
        browser_pkg=google-chrome-stable; \
    else \
        curl -fsSL 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x5301FA4FD93244FBC6F6149982BB6851C64F6880' | gpg --dearmor -o /usr/share/keyrings/xtradeb-apps.gpg && \
        echo "deb [signed-by=/usr/share/keyrings/xtradeb-apps.gpg] https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) main" > /etc/apt/sources.list.d/xtradeb-apps.list && \
        printf '%s\n' \
            'Package: *' \
            'Pin: release o=LP-PPA-xtradeb-apps' \
            'Pin-Priority: -1' \
            '' \
            'Package: chromium*' \
            'Pin: release o=LP-PPA-xtradeb-apps' \
            'Pin-Priority: 500' \
            > /etc/apt/preferences.d/xtradeb-apps && \
        browser_pkg=chromium; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends \
    "$browser_pkg" \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/* && \
    { google-chrome --version || chromium --version; }

# The novnc package ships no index.html, so the bare noVNC port would show a
# directory listing; land straight on the connected, scaled viewer instead.
RUN printf '%s\n' '<!DOCTYPE html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1&resize=scale">' > /usr/share/novnc/index.html

# Install Java (Eclipse Temurin)
RUN curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo $VERSION_CODENAME) main" | tee /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && apt-get install -y --no-install-recommends temurin-${JAVA_VERSION}-jdk && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user matching typical host UID
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} developer 2>/dev/null || \
    groupadd developer || true && \
    useradd -m -s /bin/bash -g developer developer && \
    echo "developer ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/developer

# Setup workspace directory
RUN mkdir -p /workspace && \
    chown -R developer:developer /workspace /home/developer

# Bake a workspace-aware bash prompt into the developer's ~/.bashrc: it shows
# the workspace name (CWW_WORKSPACE) and the live git branch, so any shell
# opened with `cww shell` makes the workspace and branch obvious. Appended so it
# overrides Ubuntu's stock PS1; covers login shells (bash -l -> ~/.profile ->
# ~/.bashrc) and interactive shells alike.
COPY cww-prompt.sh /tmp/cww-prompt.sh
RUN cat /tmp/cww-prompt.sh >> /home/developer/.bashrc && \
    rm /tmp/cww-prompt.sh && \
    chown developer:developer /home/developer/.bashrc

# Copy tmux config (copied to docker/ dir during install)
COPY tmux.conf /home/developer/.tmux.conf
RUN chown developer:developer /home/developer/.tmux.conf

# Copy entrypoint and the browser-stack launcher it starts (CWW_BROWSER=off
# skips the launch; see cww-browser.sh for what runs and why).
COPY entrypoint.sh /entrypoint.sh
COPY cww-browser.sh /usr/local/bin/cww-browser
RUN chmod 755 /entrypoint.sh /usr/local/bin/cww-browser

USER developer
WORKDIR /workspace

# Configure git defaults
RUN git config --global init.defaultBranch main && \
    git config --global core.editor "vim"

# The entrypoint launches $CWW_AGENT_CMD (set by each agent stage below) inside
# tmux when the container starts with no arguments.
ENTRYPOINT ["/entrypoint.sh"]

# =============================================================================
# claude — Anthropic Claude Code
# =============================================================================
FROM base AS claude
USER root

# Install Claude Code CLI + the Chrome DevTools MCP server (pinned; it attaches
# to the cww browser stack over CDP — see the mcpServers entry baked below).
RUN npm install -g @anthropic-ai/claude-code chrome-devtools-mcp@1.5.0

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
# env_file). These live in the stateful ~/.claude.json because none of them can
# be set via settings.json / env / flags (Claude Code issues #4714, #720):
#   - hasCompletedOnboarding    → skips the theme/welcome wizard
#   - bypassPermissionsModeAccepted → pre-accepts the one-time
#     '--dangerously-skip-permissions' acknowledgment
#   - projects["/workspace"].hasTrustDialogAccepted → pre-trusts the workspace
#     (the trust dialog is a separate gate that --dangerously-skip-permissions
#     does NOT bypass)
# ~/.claude/settings.json holds the declarative bits (theme + nonessential
# traffic off + a custom status line: "<cwd> | <model> | <context tokens>").
# The user-scope mcpServers entry (top level of ~/.claude.json — applies to all
# projects, no approval dialog) points chrome-devtools-mcp at the cww browser
# stack's CDP port; the entrypoint strips it when CWW_BROWSER=off.
RUN mkdir -p /home/developer/.claude && \
    printf '%s\n' '{"hasCompletedOnboarding": true, "bypassPermissionsModeAccepted": true, "projects": {"/workspace": {"hasTrustDialogAccepted": true}}, "mcpServers": {"chrome-devtools": {"type": "stdio", "command": "chrome-devtools-mcp", "args": ["--browser-url=http://127.0.0.1:9222", "--usage-statistics=false"]}}}' > /home/developer/.claude.json && \
    printf '%s\n' '{"theme": "dark", "env": {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}, "statusLine": {"type": "command", "command": "/home/developer/.claude/statusline.sh", "padding": 0}}' > /home/developer/.claude/settings.json && \
    chown -R developer:developer /home/developer/.claude /home/developer/.claude.json

# Bake the custom status line script referenced by settings.json above.
COPY statusline.sh /home/developer/.claude/statusline.sh
RUN chmod 755 /home/developer/.claude/statusline.sh && \
    chown developer:developer /home/developer/.claude/statusline.sh

USER developer
ENV CWW_AGENT_CMD="claude --dangerously-skip-permissions"

# =============================================================================
# vibe — Mistral Vibe
# =============================================================================
FROM base AS vibe
USER root

# Vibe is a Python 3.12+ tool; Ubuntu 24.04 ships 3.12. pipx gives it an
# isolated venv under the developer's ~/.local.
RUN apt-get update && apt-get install -y python3 python3-venv pipx && \
    rm -rf /var/lib/apt/lists/*

# Chrome DevTools MCP server (same pin as the claude image) so Vibe drives the
# cww browser stack over CDP. Its [[mcp_servers]] entry ships as a snippet the
# entrypoint appends to ~/.vibe/config.toml on boot (skipped when
# CWW_BROWSER=off) — appended at runtime rather than baked, so a disabled
# browser leaves no dead MCP entry to strip from TOML.
RUN npm install -g chrome-devtools-mcp@1.5.0
COPY vibe-mcp.toml /usr/local/share/cww/vibe-mcp.toml

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
