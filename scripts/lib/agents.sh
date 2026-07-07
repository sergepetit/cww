#!/bin/bash
# Agent backends for cww. Each workspace runs one coding agent inside its
# container; this lib is the single place that knows which agents exist, which
# image serves each one, and what each needs before launch. The launch command
# itself is baked into each per-agent image as CWW_AGENT_CMD (see
# docker/Dockerfile), so the host scripts never spell it out.
#
# Requires common.sh (die/info/warn/error/confirm, get_cww_dir) to be sourced
# first.

CWW_AGENTS="claude vibe"

validate_agent() {
    case "$1" in
        claude|vibe) return 0 ;;
        *) die "Unknown agent '$1' (available: ${CWW_AGENTS// /, })" ;;
    esac
}

# Resolve the agent for a new workspace. Precedence: explicit --agent argument
# > CWW_AGENT (from ~/.cww/env or <repo>/.cww/env, both sourced by the caller
# before this runs) > claude.
resolve_agent() {
    local agent="${1:-${CWW_AGENT:-claude}}"
    validate_agent "$agent"
    echo "$agent"
}

agent_image() {
    echo "coder-workspace-workflow:$1"
}

agent_label() {
    case "$1" in
        claude) echo "Claude Code" ;;
        vibe)   echo "Mistral Vibe" ;;
        *)      echo "$1" ;;
    esac
}

# Per-agent auth preflight. The container authenticates ONLY via env cww passes
# in (~/.cww/env, <repo>/.cww/env, or the caller's environment) — nothing is
# copied from the host — so fail fast with instructions rather than dropping
# the user into an in-container login screen.
agent_preflight() {
    local agent="$1" project_path="$2"
    case "$agent" in
        claude)
            # We deliberately don't copy the host's Claude login: as of this
            # writing a copied credential is unsupported across machines and
            # can silently fall back to metered API billing.
            if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
                error "No CLAUDE_CODE_OAUTH_TOKEN found (checked ~/.cww/env and the environment)."
                echo "  Claude Code in the container needs it to authenticate on your subscription." >&2
                echo "  Generate one (uses your Pro/Max plan, not API usage billing) and add it:" >&2
                echo "    claude setup-token" >&2
                echo "    echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> ~/.cww/env" >&2
                exit 1
            fi
            ;;
        vibe)
            if [[ -z "${MISTRAL_API_KEY:-}" ]]; then
                # A repo-committed .vibe/config.toml rides the clone into the
                # container and can point Vibe at a custom (local or alternate)
                # OpenAI-compatible provider that needs no Mistral key.
                if [[ -f "${project_path}/.vibe/config.toml" ]]; then
                    warn "No MISTRAL_API_KEY set; assuming ${project_path}/.vibe/config.toml configures a custom provider."
                else
                    error "No MISTRAL_API_KEY found (checked ~/.cww/env and the environment)."
                    echo "  Mistral Vibe in the container needs it to authenticate. Either:" >&2
                    echo "    - get a key at https://console.mistral.ai and add it:" >&2
                    echo "        echo 'MISTRAL_API_KEY=...' >> ~/.cww/env" >&2
                    echo "    - or commit a .vibe/config.toml to the repo with a [[providers]]" >&2
                    echo "      entry for a local/alternate OpenAI-compatible endpoint." >&2
                    exit 1
                fi
            fi
            ;;
    esac
}

# Build one agent's image from the multi-stage Dockerfile. Shared by
# 'cww build' and ensure_agent_image.
build_agent_image() {
    local agent="$1" cww_dir image
    validate_agent "$agent"
    cww_dir="$(get_cww_dir)"
    image="$(agent_image "$agent")"
    # tmux.conf is staged into the build context (same dance as install.sh).
    cp "$cww_dir/templates/tmux.conf" "$cww_dir/docker/" 2>/dev/null || true
    info "Building $image ..."
    docker build --target "$agent" -t "$image" "$cww_dir/docker"
    success "Image built: $image"
}

# Make sure the agent's image exists locally, offering to build it on the spot.
ensure_agent_image() {
    local agent="$1" image
    image="$(agent_image "$agent")"
    docker image inspect "$image" >/dev/null 2>&1 && return 0
    warn "Image '$image' is not built yet."
    if confirm "Build it now (may take a few minutes)?"; then
        build_agent_image "$agent"
    else
        die "Run 'cww build $agent' first."
    fi
}
