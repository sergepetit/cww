#!/bin/bash
# teardown-task.sh - Tear down a workspace: stop and remove its whole compose
# stack (agent + services + network + volumes) and its host metadata.
#
# Git is your business inside the workspace — push whatever you want to keep
# BEFORE tearing down. Teardown does not push anything.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww teardown [workspace-name] [options]

Remove a workspace and everything it created: the agent container, its service
containers (DB, cache, ...), the network, and this workspace's volumes and host
metadata. This is destructive and does NOT push git — push anything you want to
keep first (e.g. 'cww shell $WORKSPACE_NAME' then 'git push').

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  -y, --yes        Don't prompt for confirmation
  -h, --help       Show this help message

Examples:
  cww teardown sandbox     # By workspace name
  cww teardown             # Auto-detected from the current repo
EOF
}

WORKSPACE_NAME=""
ASSUME_YES=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -y|--yes)  ASSUME_YES=true; shift ;;
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

info "Workspace: $WORKSPACE_NAME"
info "Container: $CONTAINER_NAME"

if [[ "$ASSUME_YES" != "true" ]]; then
    warn "This removes the container, its services, volumes, and metadata. Unpushed git work is lost."
    if ! confirm "Tear down '$WORKSPACE_NAME'?" "n"; then
        info "Aborted."
        exit 0
    fi
fi

info "Removing container and service stack..."
teardown_task "$TASK_DIR" "$CONTAINER_NAME"

success "Workspace '$WORKSPACE_NAME' torn down."
