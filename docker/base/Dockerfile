# Coder Workspace Workflow — shared base image, tagged cww-base:latest.
# Multi-language dev environment plus the shared headful-browser stack
# (Chrome/Chromium + Xvfb + noVNC) that lets the developer watch/take over the
# browser the agent drives. Per-agent images build FROM this tag — see
# src/agents/<name>/Dockerfile; 'cww build <agent>' always (re)builds this
# base first, then the agent image (a no-op rebuild is seconds thanks to the
# layer cache).
#
# cww-base:latest is a plain, unnamespaced local tag — never referenced by
# compose templates and never shown to users in 'cww list'. An unrelated
# same-named local image would be silently overwritten by 'cww build' (and,
# conversely, silently used as the base if cww's own was never built).
# Acceptable for a local dev tool.

FROM ubuntu:24.04

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

# Install Bun system-wide (single static binary + bunx symlink in
# /usr/local/bin). Baked so cww itself — a TypeScript-on-Bun CLI — can be
# developed in a workspace out of the box. The official installer picks the
# right build for the arch (x64/aarch64) and CPU baseline.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash && \
    bun --version

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

# Shells opened later ('cww shell' docker-execs bash) get the create-time
# container env, not what the entrypoint sourced — so source the host-side
# secret refresh (see entrypoint.sh) from .bashrc too, keeping what the
# developer sees consistent with what the agent got.
RUN printf '%s\n' '' \
    '# cww: refreshed secrets, copied in by the host before each start' \
    'if [ -f "$HOME/.cww-env-refresh" ]; then set -a; . "$HOME/.cww-env-refresh"; set +a; fi' \
    >> /home/developer/.bashrc

# Copy tmux config (staged into this build context by 'cww build'/install.sh)
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

# The entrypoint launches $CWW_AGENT_CMD (set by each agent image) inside
# tmux when the container starts with no arguments.
ENTRYPOINT ["/entrypoint.sh"]
