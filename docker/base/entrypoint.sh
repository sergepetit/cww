#!/bin/bash
set -e

# Entrypoint for Coder Workspace Workflow container
# Starts a tmux session running the image's coding agent, or runs the provided
# command. Which agent this is comes from the image: each per-agent image
# (src/agents/<name>/Dockerfile) sets CWW_AGENT_CMD and bakes the agent's
# config (onboarding stub, trust, settings); auth arrives via env vars from
# ~/.cww/env. Nothing is copied from the host, so there is no config-copy
# step here.

SESSION_NAME="${TMUX_SESSION:-main}"

# Refreshed secrets from the host: cww copies this file in before each start
# (src/lib/env-refresh.ts), so tokens rotated after the container was created
# override the frozen create-time env_file values here — the agent relaunched
# below inherits them. Assignments only, and deliberately kept after sourcing
# so a bare 'docker restart' outside cww still applies the last refresh.
if [ -f "$HOME/.cww-env-refresh" ]; then
    set -a
    . "$HOME/.cww-env-refresh"
    set +a
fi

# Dependency-cache mounts: make the dirs *above* them writable.
#
# 'cww cache' chowns the host dir to this container's developer UID, so a mount
# like ~/.cww/cache/ivy2/cache -> ~/.ivy2/cache is writable. But ~/.ivy2 itself
# doesn't exist in the image (no sbt is baked in), and Docker creates a bind
# mount's missing parent dirs as root:root — while we run as 'developer'. The
# cache then works and everything the toolchain writes *beside* it fails: sbt
# can't create ~/.ivy2/.sbt.ivy.lock, npm can't write ~/.npm/_logs, and a
# root-owned ~/.cache breaks every XDG-cache user, not just coursier.
#
# So walk our own mount table and chown the root-owned ancestors. Ancestors
# only: the mount points themselves already carry the host dir's ownership, and
# recursing would write through to the host over a potentially huge cache.
# Reading /proc/self/mountinfo rather than a hardcoded list covers the presets,
# the custom 'cww cache <name> <container-path>' form, and the read-only config
# mounts (~/.m2/settings.xml, ~/.sbt/repositories, ...) with nothing to keep in
# sync. Idempotent, so a restart is a no-op.
fix_mount_parents() {
    local mp dir
    while read -r mp; do
        dir=$(dirname "$mp")
        while [ "$dir" != "$HOME" ] && [ "$dir" != "/" ]; do
            if [ "$(stat -c %u "$dir")" = 0 ]; then
                sudo -n chown "$(id -u):$(id -g)" "$dir" || return 1
            fi
            dir=$(dirname "$dir")
        done
    done < <(awk -v home="$HOME/" 'index($5, home) == 1 {print $5}' /proc/self/mountinfo)
}
fix_mount_parents || echo "[cww] WARNING: could not fix ownership of the home dirs above your mounted caches; a cache may be unwritable." >&2

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
# On failure we warn but still start tmux: a clone/auth problem should leave
# the developer a live session to diagnose, not kill the container. The full
# clone/checkout output lands in /workspace/cww.log (a header plus the git
# output), a marker at $SETUP_FAILED_MARKER tells the host CLI and the tmux
# launch below that setup failed, and the session then opens the log in less
# over a shell instead of the agent.
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

SETUP_FAILED_MARKER=/tmp/cww-setup-failed
if [ -n "$REPO_URL" ] && [ ! -d /workspace/.git ]; then
    # Clear a previous boot's failure artifacts: this boot retries the clone,
    # and a leftover cww.log would make 'git clone' refuse the non-empty
    # /workspace.
    rm -f /workspace/cww.log "$SETUP_FAILED_MARKER"
    clone_repo 2>&1 | tee /tmp/cww-setup.log
    if [ "${PIPESTATUS[0]}" -ne 0 ]; then
        {
            echo "[cww] Workspace setup FAILED at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            echo "[cww] repo:   $REPO_URL"
            echo "[cww] branch: ${BRANCH_NAME:-<repo default>}"
            echo "[cww] auth:   CWW_GIT_USER=${CWW_GIT_USER:-<unset>}, CWW_GIT_TOKEN $([ -n "$CWW_GIT_TOKEN" ] && echo "set" || echo "NOT set")"
            echo "[cww] Fix the cause (URL reachable from the container? token/user valid?),"
            echo "[cww] then retry the clone by hand in this shell, or 'cww teardown' and"
            echo "[cww] 'cww create' again. Tip: 'cww init' on the host stores and"
            echo "[cww] validates the credential up front."
            echo "--- clone/checkout output --------------------------------------------------"
            cat /tmp/cww-setup.log
        } > /workspace/cww.log
        touch "$SETUP_FAILED_MARKER"
        echo "[cww] WARNING: repo setup failed; details in /workspace/cww.log." >&2
    fi
fi

# Browser stack (default on): headful Chrome + Xvfb + noVNC, shared by the
# agent (CDP on 127.0.0.1:9222) and the developer (noVNC on 7900). The base
# stays agent-agnostic: the agent-specific half of the wiring (this image's
# MCP config) lives in /usr/local/share/cww/browser-hook.sh, shipped by the
# agent's own Dockerfile (src/agents/<name>/browser-hook.sh). The hook runs
# exactly once per boot with the resolved mode as $1, must stay idempotent
# across container restarts, and a hook failure warns but never kills the
# boot.
case "${CWW_BROWSER:-on}" in
    off|0|false|no) browser_mode=off ;;
    *)              browser_mode=on ;;
esac
if [ "$browser_mode" = "on" ]; then
    /usr/local/bin/cww-browser >> /tmp/cww-browser.log 2>&1 &
fi
if [ -x /usr/local/share/cww/browser-hook.sh ]; then
    /usr/local/share/cww/browser-hook.sh "$browser_mode" || \
        echo "[cww] WARNING: browser-hook.sh $browser_mode failed; this agent's browser/MCP wiring may be incomplete." >&2
fi

# No arguments (the normal compose path): start tmux running the image's agent.
# When repo setup failed, open the failure log over a shell instead — an agent
# in an empty workspace is useless, and the developer needs the error first.
# (The marker persists across restarts until a boot clones successfully, so
# reattaching to a broken workspace lands on the log too.)
#
# -f ignore-size on every new-session here: this client is PID 1's foreground
# process, it exists only to keep the container alive, and nobody ever looks at
# it — but it stays attached for the container's whole life at the pty's default
# 80x24. Without the flag tmux counts it when sizing the window, so under the
# default 'window-size latest' it reflows the agent's pane to 80x24 whenever it
# happens to be the most recent client, garbling the UI of whoever is actually
# attached. Flagged, tmux sizes to the real clients only.
if [ $# -eq 0 ]; then
    if [ -f "$SETUP_FAILED_MARKER" ]; then
        # -X keeps the log in the terminal scrollback after q — the developer
        # usually wants to copy the error out.
        exec tmux new-session -A -f ignore-size -s "$SESSION_NAME" -c /workspace \
            "less -X /workspace/cww.log; exec bash -l"
    fi
    if [ -z "$CWW_AGENT_CMD" ]; then
        echo "[cww] ERROR: CWW_AGENT_CMD is not set. This looks like the bare base image;" >&2
        echo "[cww] build and run a per-agent image instead ('cww build <agent>')." >&2
        exit 1
    fi
    exec tmux new-session -A -f ignore-size -s "$SESSION_NAME" -c /workspace "$CWW_AGENT_CMD"
fi

# Otherwise execute the provided command
exec "$@"
