#!/bin/bash
# attach-task.sh - Re-attach to a workspace's agent session
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww attach [workspace-name]

Re-attach to a workspace's agent session (Claude Code, Mistral Vibe, ...). For
a plain shell instead of the agent, use 'cww shell'.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww attach sandbox    # Attach by workspace name
  cww attach            # Attach from within the project repo directory
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

info "Container: $CONTAINER_NAME"

# Check container status
if ! container_exists "$CONTAINER_NAME"; then
    die "Container does not exist: $CONTAINER_NAME"
fi

if ! container_running "$CONTAINER_NAME"; then
    # 'cww stop' stops the whole compose stack, so restart the whole stack —
    # otherwise the agent comes back up with its services (DB, etc.) still down.
    # Fall back to the agent container alone when the compose files are gone
    # (e.g. the pattern-matched path below, with no task dir).
    if [[ -n "${TASK_DIR:-}" ]] && [[ -f "${TASK_DIR}/docker-compose.yml" ]]; then
        info "Stack is stopped. Starting container and services..."
        task_compose "$TASK_DIR" start || docker start "$CONTAINER_NAME"
    else
        info "Container is stopped. Starting..."
        docker start "$CONTAINER_NAME"
    fi
fi

# Attach to tmux session
info "Attaching to the agent session in '$WORKSPACE_NAME'..."
info "Press Ctrl-a d to detach"
echo ""
attach_agent_session "$CONTAINER_NAME"
