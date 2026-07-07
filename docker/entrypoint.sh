#!/bin/bash
set -e

# Entrypoint for Coder Workspace Workflow container
# Starts a tmux session running the image's coding agent, or runs the provided
# command. Which agent this is comes from the image: each agent stage in the
# Dockerfile sets CWW_AGENT_CMD and bakes the agent's config (onboarding stub,
# trust, settings); auth arrives via env vars from ~/.cww/env. Nothing is
# copied from the host, so there is no config-copy step here.

SESSION_NAME="${TMUX_SESSION:-main}"

# Git setup: identity + an env-reading credential helper so the developer's
# token is used for clone/push but never written to disk (.git/config). Set on
# every boot (cheap, idempotent) so it survives a container restart.
if [ -n "$GIT_AUTHOR_NAME" ]; then
    git config --global user.name "$GIT_AUTHOR_NAME"
fi
if [ -n "$GIT_AUTHOR_EMAIL" ]; then
    git config --global user.email "$GIT_AUTHOR_EMAIL"
fi
if [ -n "$CWW_GIT_TOKEN" ]; then
    # Authenticate as <login>:<token>. This form works on Forgejo, Gitea, and
    # GitHub (classic/fine-grained PATs). CWW_GIT_USER is the platform login;
    # the x-access-token default suits GitHub App / fine-grained tokens, but
    # Forgejo/Gitea require the real username, so set CWW_GIT_USER for those.
    git config --global credential.helper \
        '!f(){ echo "username=${CWW_GIT_USER:-x-access-token}"; echo "password=$CWW_GIT_TOKEN"; };f'
fi

# Clone the repo into /workspace on first boot. The clone has a self-contained
# .git, so git works natively here. Skipped on restart (the clone persists in
# the container filesystem).
#
# BRANCH_NAME is just the ref to land on; cww imposes no branching workflow.
# Empty -> stay on the clone's default branch. Matches an existing upstream
# branch -> check it out (git dwim creates a local tracking branch). Otherwise
# -> start a brand-new branch from the default HEAD.
#
# On failure we warn but still drop into tmux: a clone/auth problem should leave
# the developer a live shell to diagnose, not kill the container.
clone_repo() {
    echo "[cww] Cloning $REPO_URL into /workspace ..."
    git clone "$REPO_URL" /workspace || return 1
    cd /workspace || return 1
    [ -z "$BRANCH_NAME" ] && return 0
    if git rev-parse --verify --quiet "origin/$BRANCH_NAME" >/dev/null; then
        git checkout "$BRANCH_NAME"
    else
        echo "[cww] '$BRANCH_NAME' not found upstream — starting a new branch."
        git checkout -b "$BRANCH_NAME"
    fi
}

if [ -n "$REPO_URL" ] && [ ! -d /workspace/.git ]; then
    if ! clone_repo; then
        echo "[cww] WARNING: repo setup failed (check REPO_URL / CWW_GIT_TOKEN / base branch)." >&2
        echo "[cww] Dropping into a shell so you can investigate; /workspace may be empty or partial." >&2
    fi
fi

# Browser stack (default on): headful Chrome + Xvfb + noVNC, shared by the
# agent (CDP on 127.0.0.1:9222) and the developer (noVNC on 7900). The agent's
# MCP access goes the way each agent's config format allows: claude images
# bake the entry (JSON, jq-stripped here when off); vibe images ship it as a
# snippet appended here when on (no TOML surgery needed when off). Idempotent
# across restarts: the launcher is re-run on boot, the jq strip is a no-op
# once the key is gone, and the append is guarded by a grep.
case "${CWW_BROWSER:-on}" in
    off|0|false|no)
        # No browser in this workspace: drop the baked chrome-devtools MCP
        # entry so the agent doesn't see a dead server.
        if [ -f "$HOME/.claude.json" ]; then
            tmp="$(mktemp)" && jq 'del(.mcpServers["chrome-devtools"])' "$HOME/.claude.json" > "$tmp" && mv "$tmp" "$HOME/.claude.json" || \
                echo "[cww] WARNING: could not strip the chrome-devtools MCP entry from ~/.claude.json" >&2
        fi
        ;;
    *)
        /usr/local/bin/cww-browser >> /tmp/cww-browser.log 2>&1 &
        if [ -f /usr/local/share/cww/vibe-mcp.toml ]; then
            if ! grep -qs 'name = "chrome-devtools"' "$HOME/.vibe/config.toml"; then
                mkdir -p "$HOME/.vibe"
                cat /usr/local/share/cww/vibe-mcp.toml >> "$HOME/.vibe/config.toml"
            fi
            # Vibe reads ONE config.toml: a trusted project config replaces the
            # user one, hiding the entry appended above. Flag it rather than
            # editing the repo's committed file (which would dirty the clone).
            if [ -f /workspace/.vibe/config.toml ] && \
               ! grep -q 'chrome-devtools' /workspace/.vibe/config.toml; then
                echo "[cww] NOTE: this repo commits .vibe/config.toml, which makes Vibe ignore ~/.vibe/config.toml — so the built-in browser's chrome-devtools MCP entry won't load." >&2
                echo "[cww] NOTE: to give Vibe browser access, add the [[mcp_servers]] block from /usr/local/share/cww/vibe-mcp.toml to the repo's .vibe/config.toml." >&2
            fi
        fi
        ;;
esac

# No arguments (the normal compose path): start tmux running the image's agent.
if [ $# -eq 0 ]; then
    if [ -z "$CWW_AGENT_CMD" ]; then
        echo "[cww] ERROR: CWW_AGENT_CMD is not set. Build the image via an agent" >&2
        echo "[cww] target ('cww build <agent>' or docker build --target <agent>)." >&2
        exit 1
    fi
    exec tmux new-session -A -s "$SESSION_NAME" -c /workspace "$CWW_AGENT_CMD"
fi

# Otherwise execute the provided command
exec "$@"
