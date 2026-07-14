#!/bin/bash
# opencode's half of the entrypoint's browser wiring. Invoked by the base
# entrypoint (docker/base/entrypoint.sh) exactly once per boot with the
# resolved browser mode as $1 (on|off); must stay idempotent across container
# restarts. Failures should warn, not fail the boot.
#
# The image bakes a chrome-devtools mcp entry into the global
# ~/.config/opencode/opencode.json (see that file): nothing to do when the
# browser is on. When it is off, strip the entry so the agent doesn't see a
# dead server — a no-op once the key is gone. (A repo-committed opencode.json
# merges OVER the global config, so it can't resurrect the stripped entry.)

[ "$1" = "off" ] || exit 0

cfg="$HOME/.config/opencode/opencode.json"
if [ -f "$cfg" ]; then
    tmp="$(mktemp)" && jq 'del(.mcp["chrome-devtools"])' "$cfg" > "$tmp" && mv "$tmp" "$cfg" || \
        echo "[cww] WARNING: could not strip the chrome-devtools MCP entry from ~/.config/opencode/opencode.json" >&2
fi
