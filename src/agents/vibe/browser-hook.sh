#!/bin/bash
# vibe's half of the entrypoint's browser wiring. Invoked by the base
# entrypoint (docker/base/entrypoint.sh) exactly once per boot with the
# resolved browser mode as $1 (on|off); must stay idempotent across container
# restarts. Failures should warn, not fail the boot.
#
# Vibe's chrome-devtools [[mcp_servers]] entry ships as a snippet (see
# vibe-mcp.toml) appended to ~/.vibe/config.toml when the browser is on —
# appended at runtime rather than baked, so a disabled browser leaves no dead
# MCP entry to strip from TOML. The append is grep-guarded so restarts don't
# duplicate it. Nothing to undo when the browser is off.

[ "$1" = "on" ] || exit 0
[ -f /usr/local/share/cww/vibe-mcp.toml ] || exit 0

if ! grep -qs 'name = "chrome-devtools"' "$HOME/.vibe/config.toml"; then
    mkdir -p "$HOME/.vibe"
    cat /usr/local/share/cww/vibe-mcp.toml >> "$HOME/.vibe/config.toml"
fi

# Vibe reads ONE config.toml: a trusted project config replaces the user one,
# hiding the entry appended above. Flag it rather than editing the repo's
# committed file (which would dirty the clone).
if [ -f /workspace/.vibe/config.toml ] && \
   ! grep -q 'chrome-devtools' /workspace/.vibe/config.toml; then
    echo "[cww] NOTE: this repo commits .vibe/config.toml, which makes Vibe ignore ~/.vibe/config.toml — so the built-in browser's chrome-devtools MCP entry won't load." >&2
    echo "[cww] NOTE: to give Vibe browser access, add the [[mcp_servers]] block from /usr/local/share/cww/vibe-mcp.toml to the repo's .vibe/config.toml." >&2
fi
