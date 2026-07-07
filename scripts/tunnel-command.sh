#!/bin/bash
# tunnel-command.sh - Print the ssh command that forwards a task's published
# ports to another machine's localhost.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww tunnel-command [workspace-name] [options]

Print the ssh command to run FROM another machine to reach this workspace's
published ports on that machine's own localhost. Forwards every host port
the workspace's compose stack currently publishes (the PORTS column of cww list).

The workspace must be running for its ports to be published.

Arguments:
  workspace-name   Name of the workspace (optional if run inside its repo)

Options:
  --host <target>   SSH target to connect to (default: \$USER@\$(hostname))
  -h, --help        Show this help message

Examples:
  cww tunnel-command sandbox
  cww tunnel-command sandbox --host me@dev-box.internal
EOF
}

WORKSPACE_NAME=""
SSH_HOST=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            SSH_HOST="$2"
            shift 2
            ;;
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

# Default SSH target is this machine (the one running cww).
if [[ -z "$SSH_HOST" ]]; then
    SSH_HOST="${USER}@$(hostname -f 2>/dev/null || hostname)"
fi

# container->host port map across the task's compose stack (empty unless running).
port_map="$(get_port_map "$TASK_DIR")"

if [[ -z "$port_map" ]]; then
    warn "No published ports for '$WORKSPACE_NAME'."
    echo "The workspace must be running for its ports to be published." >&2
    echo "Start it with 'cww attach $WORKSPACE_NAME', then try again." >&2
    exit 1
fi

# Build one -L forward per binding, aimed at the CONTAINER port on the local
# side: -L <container>:localhost:<host>. The host port may be ephemeral (Docker
# picks a free one per stack so parallel branches never collide), but the
# container port is stable — so you always reach the app at localhost:<container>
# on the other machine, giving one fixed browser origin across tasks.
#
# Container ports below 1024 are privileged on the OTHER machine — an
# unprivileged ssh can't bind them ("bind: Permission denied") — so those get a
# deterministic +8000 offset (80 -> 8080, 443 -> 8443): still one stable local
# port per service, just an unprivileged one.
forwards=""
locals=""
remapped=""
while read -r container host; do
    [[ -z "$container" ]] && continue
    local_port="$container"
    if (( container < 1024 )); then
        local_port=$((container + 8000))
        remapped+="${remapped:+, }${container} -> ${local_port}"
    fi
    forwards+=" -L ${local_port}:localhost:${host}"
    locals+="${locals:+, }localhost:${local_port}"
done <<< "$port_map"

echo "Run this from the OTHER machine to reach $WORKSPACE_NAME's ports on its localhost:"
echo ""
echo "  ssh -N${forwards} ${SSH_HOST}"
echo ""
echo "Reachable there at: ${locals}"
if [[ -n "$remapped" ]]; then
    echo "(privileged container port(s) remapped locally: ${remapped})"
fi
