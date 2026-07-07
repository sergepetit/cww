#!/bin/bash
# stop-task.sh - Stop a container without cleanup (pause work)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww stop [workspace-name]

Stop a workspace's container without tearing it down. The filesystem survives;
'cww attach' (or 'cww shell') restarts it. Use this to pause work and free up
resources. To remove a workspace entirely, use 'cww teardown'.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww stop sandbox    # Stop by workspace name
  cww stop            # Stop from within the project repo directory
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

# Stop the whole stack (agent container + services like the DB), preserving
# every container's filesystem so 'cww attach' can restart it. Fall back to
# stopping just the agent container if the compose files are missing.
if [[ -f "${TASK_DIR}/docker-compose.yml" ]]; then
    info "Stopping container and service stack..."
    task_compose "$TASK_DIR" stop
elif container_running "$CONTAINER_NAME"; then
    info "Stopping container..."
    docker stop "$CONTAINER_NAME"
elif ! container_exists "$CONTAINER_NAME"; then
    warn "Container does not exist: $CONTAINER_NAME"
    exit 0
else
    warn "Container is already stopped: $CONTAINER_NAME"
    exit 0
fi

success "Stack stopped. Work is preserved in the containers."
echo ""
echo "Use 'cww attach $WORKSPACE_NAME' to resume."
