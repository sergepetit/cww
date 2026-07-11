#!/bin/bash
# claude's half of the entrypoint's browser wiring. Invoked by the base
# entrypoint (docker/base/entrypoint.sh) exactly once per boot with the
# resolved browser mode as $1 (on|off); must stay idempotent across container
# restarts. Failures should warn, not fail the boot.
#
# The image bakes a chrome-devtools mcpServers entry into ~/.claude.json (see
# claude-onboarding.json): nothing to do when the browser is on. When it is
# off, strip the entry so the agent doesn't see a dead server — a no-op once
# the key is gone.

[ "$1" = "off" ] || exit 0

if [ -f "$HOME/.claude.json" ]; then
    tmp="$(mktemp)" && jq 'del(.mcpServers["chrome-devtools"])' "$HOME/.claude.json" > "$tmp" && mv "$tmp" "$HOME/.claude.json" || \
        echo "[cww] WARNING: could not strip the chrome-devtools MCP entry from ~/.claude.json" >&2
fi
