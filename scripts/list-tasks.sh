#!/bin/bash
# list-tasks.sh - List all active Coder Workspace Workflow sessions
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

usage() {
    cat << EOF
Usage: cww list [options]

List all active Coder Workspace Workflow sessions.

Options:
  --json         Output as JSON
  -h, --help     Show this help message
EOF
}

OUTPUT_JSON=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --json)
            OUTPUT_JSON=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            die "Unknown option: $1"
            ;;
        *)
            die "Unexpected argument: $1"
            ;;
    esac
done

# Collect all sessions
declare -a sessions
session_count=0

while IFS= read -r session_file; do
    if [[ -n "$session_file" ]] && [[ -f "$session_file" ]]; then
        task_dir="$(dirname "$session_file")"

        # Read session data.
        project="$(jq -r '.project // "unknown"' "$session_file")"
        workspace="$(jq -r '.workspace // "unknown"' "$session_file")"
        branch="$(jq -r '.branch // "unknown"' "$session_file")"
        agent="$(jq -r '.agent // "claude"' "$session_file")"
        container="$(jq -r '.container // "unknown"' "$session_file")"
        created="$(jq -r '.created // "unknown"' "$session_file")"

        # Check container status
        if container_running "$container"; then
            status="running"
        elif container_exists "$container"; then
            status="stopped"
        else
            status="no-container"
        fi

        # Published ports across the task's compose stack (empty unless running).
        # port_map is "container host" lines; render a compact "container->host"
        # display string and a structured JSON array from it.
        port_map="$(get_port_map "$task_dir")"
        ports_display=""
        ports_json="[]"
        if [[ -n "$port_map" ]]; then
            ports_display="$(echo "$port_map" | awk '{printf "%s->%s,", $1, $2}' | sed 's/,$//')"
            ports_json="$(echo "$port_map" | awk '{printf "%s{\"container\":%s,\"host\":%s}", (NR>1?",":""), $1, $2} END{print ""}')"
            ports_json="[${ports_json}]"
        fi

        sessions+=("$(cat << EOF
{
  "project": "$project",
  "workspace": "$workspace",
  "branch": "$branch",
  "agent": "$agent",
  "container": "$container",
  "status": "$status",
  "ports": $ports_json,
  "portsDisplay": "$ports_display",
  "taskDir": "$task_dir",
  "created": "$created"
}
EOF
)")
        ((++session_count))
    fi
done < <(find_all_sessions)

# Output results
if [[ "$OUTPUT_JSON" == "true" ]]; then
    if [[ $session_count -eq 0 ]]; then
        echo "[]"
    else
        echo "["
        for i in "${!sessions[@]}"; do
            echo "${sessions[$i]}"
            if [[ $i -lt $((session_count - 1)) ]]; then
                echo ","
            fi
        done
        echo "]"
    fi
else
    if [[ $session_count -eq 0 ]]; then
        echo "No workspaces found."
        echo ""
        echo "Use 'cww create <name>' to create one."
        exit 0
    fi

    # Print table header
    printf "%-20s %-10s %-15s %-8s %-24s %-40s\n" "WORKSPACE" "STATUS" "PROJECT" "AGENT" "PORTS" "TASK DIR"
    printf "%-20s %-10s %-15s %-8s %-24s %-40s\n" "---------" "------" "-------" "-----" "-----" "--------"

    # Print each session
    for session_json in "${sessions[@]}"; do
        project="$(echo "$session_json" | jq -r '.project')"
        workspace="$(echo "$session_json" | jq -r '.workspace')"
        agent="$(echo "$session_json" | jq -r '.agent')"
        status="$(echo "$session_json" | jq -r '.status')"
        ports="$(echo "$session_json" | jq -r '.portsDisplay')"
        task_dir="$(echo "$session_json" | jq -r '.taskDir')"

        # Truncate long values
        workspace_display="${workspace:0:20}"
        project_display="${project:0:15}"
        agent_display="${agent:0:8}"
        ports_display="${ports:0:24}"
        [[ -z "$ports_display" ]] && ports_display="-"
        taskdir_display="${task_dir:0:40}"

        # Color status
        case "$status" in
            running)
                status_display="${GREEN}running${NC}"
                ;;
            stopped)
                status_display="${YELLOW}stopped${NC}"
                ;;
            *)
                status_display="${RED}error${NC}"
                ;;
        esac

        printf "%-20s ${status_display}%-$((10 - ${#status}))s %-15s %-8s %-24s %-40s\n" \
            "$workspace_display" "" "$project_display" "$agent_display" "$ports_display" "$taskdir_display"
    done
fi
