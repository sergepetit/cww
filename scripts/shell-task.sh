#!/bin/bash
# shell-task.sh - Open a plain login shell in a workspace (not the agent).
# For running git, inspecting services, or poking at the box without touching
# the agent session running in tmux.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww shell [workspace-name]

Drop into a login shell (as 'developer', cwd /workspace) inside the workspace's
container. The agent's tmux session keeps running untouched — use 'cww attach'
to reach the agent instead.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww shell sandbox    # Shell into the 'sandbox' workspace
  cww shell            # From within the project repo directory
EOF
}

WORKSPACE_NAME=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            die "Unknown option: $1"
            ;;
        *)
            WORKSPACE_NAME="$1"
            shift
            ;;
    esac
done

# Resolve the session (by workspace name, or auto-detect from the current repo)
CONTAINER_NAME=""
if SESSION_FILE="$(resolve_session_file "$WORKSPACE_NAME")"; then
    TASK_DIR="$(dirname "$SESSION_FILE")"
    WORKSPACE_NAME="$(get_session_value "$TASK_DIR" "workspace")"
    [[ -z "$WORKSPACE_NAME" ]] && WORKSPACE_NAME="$(get_session_value "$TASK_DIR" "branch")"
    CONTAINER_NAME="$(get_session_value "$TASK_DIR" "container")"
elif [[ -n "$WORKSPACE_NAME" ]]; then
    # No recorded session, but a name was given: fall back to matching a
    # container by name pattern.
    sanitized="$(sanitize_name "$WORKSPACE_NAME")"
    CONTAINER_NAME=$(docker ps -a --format '{{.Names}}' | grep -E "^cww-.*-${sanitized}$" | head -1)
fi

if [[ -z "$CONTAINER_NAME" ]]; then
    if [[ -z "$WORKSPACE_NAME" ]]; then
        error "Could not determine the workspace from the current directory. Please specify a name."
    else
        error "No workspace found: $WORKSPACE_NAME"
    fi
    usage
    exit 1
fi

if ! container_exists "$CONTAINER_NAME"; then
    die "Container does not exist: $CONTAINER_NAME"
fi

# Bring the stack up if stopped, same as attach — a shell is far more useful with
# the services reachable.
if ! container_running "$CONTAINER_NAME"; then
    if [[ -n "${TASK_DIR:-}" ]] && [[ -f "${TASK_DIR}/docker-compose.yml" ]]; then
        info "Stack is stopped. Starting container and services..."
        task_compose "$TASK_DIR" start || docker start "$CONTAINER_NAME"
    else
        info "Container is stopped. Starting..."
        docker start "$CONTAINER_NAME"
    fi
fi

info "Opening a shell in '$WORKSPACE_NAME' (exit to leave; the agent keeps running)"
echo ""
exec docker exec -it -w /workspace "$CONTAINER_NAME" bash -l
