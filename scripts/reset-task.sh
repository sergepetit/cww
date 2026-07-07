#!/bin/bash
# reset-task.sh - Re-run the project's optional .cww/reset.sh inside a workspace
# to reset and reseed its service data. Same script cww runs when a workspace is
# created; run it again any time to get back to a clean, seeded state.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww reset [workspace-name]

Run the project's .cww/reset.sh inside the workspace (resets/reseeds service
data). No-op if the project has no .cww/reset.sh.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -h, --help       Show this help message

Examples:
  cww reset sandbox    # Reset the 'sandbox' workspace
  cww reset            # Auto-detected from the current repo
EOF
}

WORKSPACE_NAME=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        -*)        die "Unknown option: $1" ;;
        *)         WORKSPACE_NAME="$1"; shift ;;
    esac
done

# Resolve the session (by workspace name, or auto-detect from the current repo)
SESSION_FILE="$(resolve_session_file "$WORKSPACE_NAME")" || {
    if [[ -z "$WORKSPACE_NAME" ]]; then
        error "Could not determine the workspace from the current directory. Specify a name."
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
PROJECT_PATH="$(get_session_value "$TASK_DIR" "mainRepo")"

if ! container_running "$CONTAINER_NAME"; then
    die "Workspace '$WORKSPACE_NAME' is not running. Start it with 'cww attach $WORKSPACE_NAME' first."
fi

info "Workspace: $WORKSPACE_NAME"
if run_reset_script "$PROJECT_PATH" "$CONTAINER_NAME"; then
    success "Reset complete."
else
    rc=$?
    if [[ $rc -eq 2 ]]; then
        warn "No .cww/reset.sh in this project — nothing to run."
        echo "  Add ${PROJECT_PATH}/.cww/reset.sh to define how to reset/reseed service data." >&2
    else
        die "reset.sh exited with status $rc"
    fi
fi
