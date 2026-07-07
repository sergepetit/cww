#!/bin/bash
# start-task.sh - Resume a stopped workspace: bring its whole compose stack back
# up without attaching. The inverse of 'cww stop'. (To make a NEW workspace, use
# 'cww create'; to resume AND attach, 'cww attach' / 'cww shell' start it too.)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww start [workspace-name]

Resume a stopped workspace — start its container and services back up (the
inverse of 'cww stop'), without attaching. Use 'cww create' to make a new
workspace; 'cww attach'/'cww shell' also start a stopped workspace on their way in.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww start sandbox    # Resume by workspace name
  cww start            # Resume from within the project repo directory
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
SESSION_FILE="$(resolve_session_file "$WORKSPACE_NAME")" || {
    if [[ -z "$WORKSPACE_NAME" ]]; then
        error "Could not determine the workspace from the current directory. Please specify a name."
    else
        error "No workspace found: $WORKSPACE_NAME"
        echo "  To create a new workspace, use 'cww create $WORKSPACE_NAME'." >&2
    fi
    usage
    exit 1
}

TASK_DIR="$(dirname "$SESSION_FILE")"
WORKSPACE_NAME="$(get_session_value "$TASK_DIR" "workspace")"
[[ -z "$WORKSPACE_NAME" ]] && WORKSPACE_NAME="$(get_session_value "$TASK_DIR" "branch")"
CONTAINER_NAME="$(get_session_value "$TASK_DIR" "container")"

info "Workspace: $WORKSPACE_NAME"
info "Container: $CONTAINER_NAME"

if ! container_exists "$CONTAINER_NAME"; then
    die "Container does not exist: $CONTAINER_NAME. Use 'cww create $WORKSPACE_NAME' to provision it."
fi

if container_running "$CONTAINER_NAME"; then
    success "Workspace '$WORKSPACE_NAME' is already running."
    echo ""
    echo "Use 'cww attach $WORKSPACE_NAME' for the agent, or 'cww shell $WORKSPACE_NAME' for a shell."
    exit 0
fi

# Bring the whole stack back up (agent container + services), mirroring how
# 'cww stop' takes it down. Fall back to the agent container alone if the compose
# files are gone.
if [[ -f "${TASK_DIR}/docker-compose.yml" ]]; then
    info "Starting container and service stack..."
    task_compose "$TASK_DIR" start || docker start "$CONTAINER_NAME"
else
    info "Starting container..."
    docker start "$CONTAINER_NAME"
fi

success "Workspace '$WORKSPACE_NAME' started."
echo ""
echo "Use 'cww attach $WORKSPACE_NAME' for the agent, or 'cww shell $WORKSPACE_NAME' for a shell."
