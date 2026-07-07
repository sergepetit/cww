#!/bin/bash
# Common utilities for Coder Workspace Workflow

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored messages
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

die() {
    error "$1"
    exit 1
}

# Get the directory where cww scripts are installed
get_cww_dir() {
    local script_path
    script_path="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
    # Go up from scripts/lib or scripts to the root
    if [[ "$script_path" == */lib ]]; then
        echo "$(dirname "$(dirname "$script_path")")"
    else
        echo "$(dirname "$script_path")"
    fi
}

# Sanitize a workspace/name for use in container/directory names
sanitize_name() {
    local name="$1"
    echo "$name" | tr '/' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g'
}

# Generate container name from project and workspace name
get_container_name() {
    local project="$1"
    local workspace="$2"
    echo "cww-$(sanitize_name "$project")-$(sanitize_name "$workspace")"
}

# Root directory holding per-task host metadata (session.json + compose files).
# The clone itself lives inside the container, not here.
get_tasks_root() {
    echo "${HOME}/.cww/tasks"
}

# Stable task name from project + workspace name. Namespaced by project because
# ~/.cww/tasks is global: two projects can share a workspace name.
get_task_name() {
    local project="$1"
    local workspace="$2"
    echo "$(sanitize_name "$project")-$(sanitize_name "$workspace")"
}

# Host metadata directory for a specific workspace.
get_task_dir() {
    local project="$1"
    local workspace="$2"
    echo "$(get_tasks_root)/$(get_task_name "$project" "$workspace")"
}

# Normalize a git remote URL to an https form the in-container credential
# helper (CWW_GIT_USER + CWW_GIT_TOKEN) can authenticate. SSH remotes are
# rewritten because we deliberately don't mount SSH keys into the container.
# (Self-hosted hosts on http / a non-443 port: set CWW_REPO_URL to override.)
normalize_git_url() {
    local url="$1"
    case "$url" in
        ssh://git@*)
            # ssh://git@host[:port]/path -> https://host/path. The SSH port is
            # dropped: it is not the web port (web is assumed on default 443).
            url="https://$(echo "${url#ssh://git@}" | sed -E 's#^([^/:]+)(:[0-9]+)?/#\1/#')"
            ;;
        git@*:*)
            # scp-style git@host:org/repo.git -> https://host/org/repo.git
            url="https://$(echo "${url#git@}" | sed -e 's#:#/#')"
            ;;
    esac
    echo "$url"
}

# Check if a directory is a git repository
is_git_repo() {
    local path="$1"
    git -C "$path" rev-parse --git-dir >/dev/null 2>&1
}

# Get the root of the git repository
get_git_root() {
    local path="$1"
    git -C "$path" rev-parse --show-toplevel 2>/dev/null
}

# Check if a branch exists
branch_exists() {
    local repo_path="$1"
    local branch="$2"
    git -C "$repo_path" show-ref --verify --quiet "refs/heads/$branch"
}

# Get current branch name
get_current_branch() {
    local repo_path="$1"
    git -C "$repo_path" branch --show-current
}

# Get current commit SHA
get_current_commit() {
    local repo_path="$1"
    git -C "$repo_path" rev-parse HEAD
}

# Check if container exists (running or stopped)
container_exists() {
    local name="$1"
    docker ps -a --format '{{.Names}}' | grep -q "^${name}$"
}

# Check if container is running
container_running() {
    local name="$1"
    docker ps --format '{{.Names}}' | grep -q "^${name}$"
}

# Read session.json from a task dir
read_session() {
    local task_dir="$1"
    local session_file="${task_dir}/session.json"
    if [[ -f "$session_file" ]]; then
        cat "$session_file"
    else
        echo "{}"
    fi
}

# Get a value from session.json
get_session_value() {
    local task_dir="$1"
    local key="$2"
    read_session "$task_dir" | jq -r ".$key // empty"
}

# Write session.json to a task dir
write_session() {
    local task_dir="$1"
    local json="$2"
    mkdir -p "$task_dir"
    echo "$json" > "${task_dir}/session.json"
}

# Run a docker compose subcommand against a task's whole stack, layering the
# same override files 'cww create' used. An explicit -p pins the project name to
# the task dir basename — the name compose derived from the cwd at 'up' time —
# so teardown targets the agent container AND its services (DB, etc.) + network,
# regardless of the current directory. Example: task_compose "$TASK_DIR" down.
task_compose() {
    local task_dir="$1"; shift
    local -a files=(-f "${task_dir}/docker-compose.yml")
    [[ -f "${task_dir}/docker-compose.services.yml" ]] && files+=(-f "${task_dir}/docker-compose.services.yml")
    [[ -f "${task_dir}/docker-compose.hosts.yml" ]] && files+=(-f "${task_dir}/docker-compose.hosts.yml")
    [[ -f "${task_dir}/docker-compose.browser.yml" ]] && files+=(-f "${task_dir}/docker-compose.browser.yml")
    docker compose -p "$(basename "$task_dir")" "${files[@]}" "$@"
}

# Whether new workspaces get the built-in headful browser (Chrome + noVNC,
# drivable by the agent via chrome-devtools-mcp). Default ON; set
# CWW_BROWSER=off (or 0/false/no) in ~/.cww/env or <repo>/.cww/env to skip it.
browser_enabled() {
    case "${CWW_BROWSER:-on}" in
        off|0|false|no) return 1 ;;
        *) return 0 ;;
    esac
}

# Emit "CONTAINER_PORT HOST_PORT" lines for every published binding across a
# task's whole compose stack (agent + services). Compose labels every container
# with com.docker.compose.project set to the task dir basename — the same -p
# name task_compose pins — so we can find them regardless of container state.
# IPv6 (:::) rows are dropped: Docker can assign a different ephemeral host port
# to the v6 binding, and tunnel-command forwards over IPv4 localhost. Only
# running containers publish ports, so this is empty for stopped tasks.
get_port_map() {
    local task_dir="$1"
    local project
    project="$(basename "$task_dir")"
    docker ps --filter "label=com.docker.compose.project=${project}" \
        --format '{{.Ports}}' 2>/dev/null \
        | tr ',' '\n' \
        | grep -v ':::' \
        | grep -oE '[0-9.]+:[0-9]+->[0-9]+' \
        | sed -E 's/.*:([0-9]+)->([0-9]+)/\2 \1/' \
        | sort -u
}

# The published host ports for a task's stack as a sorted, comma-separated list
# (e.g. "49153,49155"). Thin wrapper over get_port_map; empty if none/stopped.
get_published_ports() {
    get_port_map "$1" | awk '{print $2}' | sort -un | paste -sd, -
}

# Tear down a workspace's whole compose stack (agent + services + network +
# this workspace's volumes) and remove its host metadata dir. Idempotent.
# Needs the compose files, so it runs before the task dir is removed.
teardown_task() {
    local task_dir="$1"
    local container="$2"
    task_compose "$task_dir" down --volumes --remove-orphans >/dev/null 2>&1 || true
    # Belt and suspenders: the agent container has an explicit container_name,
    # so remove it directly too in case the compose files were missing.
    [[ -n "$container" ]] && docker rm -f "$container" >/dev/null 2>&1 || true
    rm -rf "$task_dir"
}

# Copy optional personal skills/commands/agents from the host project's .cww/
# into the container's ~/.claude. The folder's presence is the opt-in — no flag.
# Copied host-side (cp -rL) so a symlink such as `.cww/skills -> ~/.claude/skills`
# resolves to real files before docker cp; the symlink target does not exist
# inside the container. (Team skills committed to the repo's .claude/skills ride
# the clone already and need none of this.)
# The skills/commands/agents triad is a Claude Code concept, so this is a no-op
# for other agents (a mapping into Vibe's ~/.vibe layout is a possible
# follow-up).
materialize_cww_assets() {
    local project_path="$1"
    local container="$2"
    local agent="${3:-claude}"
    local sub src stage
    if [[ "$agent" != "claude" ]]; then
        for sub in skills commands agents; do
            if [[ -d "${project_path}/.cww/${sub}" ]]; then
                info "Personal .cww/{skills,commands,agents} are Claude Code-specific; skipped for $agent."
                break
            fi
        done
        return 0
    fi
    for sub in skills commands agents; do
        src="${project_path}/.cww/${sub}"
        [[ -d "$src" ]] || continue
        stage="$(mktemp -d)" || continue
        if ! cp -rL "$src/." "$stage/" 2>/dev/null; then
            rm -rf "$stage"; continue
        fi
        docker exec "$container" mkdir -p "/home/developer/.claude/${sub}"
        docker cp "$stage/." "${container}:/home/developer/.claude/${sub}/" >/dev/null
        docker exec -u root "$container" chown -R developer:developer "/home/developer/.claude/${sub}" 2>/dev/null || true
        rm -rf "$stage"
        info "Loaded personal .cww/${sub} into the workspace (~/.claude/${sub})"
    done
}

# Run the project's optional .cww/reset.sh inside the container to reset/reseed
# service data. Runs as the developer user with cwd /workspace, so it can reach
# services over the compose network by hostname. Returns 2 (no output) when no
# script is present, so callers can decide whether to announce that.
run_reset_script() {
    local project_path="$1"
    local container="$2"
    local src="${project_path}/.cww/reset.sh"
    [[ -f "$src" ]] || return 2
    info "Running .cww/reset.sh in the workspace..."
    docker cp "$src" "${container}:/tmp/cww-reset.sh" >/dev/null
    docker exec -u root "$container" chmod +x /tmp/cww-reset.sh
    docker exec -w /workspace "$container" bash /tmp/cww-reset.sh
}

# Attach to a workspace's agent tmux session (replaces the current process).
attach_agent_session() {
    local container="$1"
    exec docker exec -it "$container" tmux attach -t main
}

# Find all active cww sessions
find_all_sessions() {
    find "$(get_tasks_root)" -maxdepth 2 -name session.json -type f 2>/dev/null
}

# Resolve a session.json path either by workspace name or, with no name,
# by auto-detecting the single workspace belonging to the current git repo.
# Echoes the session file path on success; non-zero exit (no output) on
# no-match or an ambiguous cwd (multiple workspaces for the same repo).
resolve_session_file() {
    local workspace="$1"
    local f

    if [[ -n "$workspace" ]]; then
        while IFS= read -r f; do
            if [[ "$(jq -r '.workspace // empty' "$f")" == "$workspace" ]]; then
                echo "$f"
                return 0
            fi
        done < <(find_all_sessions)
        return 1
    fi

    # No branch given: match tasks whose mainRepo is the current git root.
    local root
    root="$(get_git_root "$(pwd)")"
    [[ -z "$root" ]] && return 1
    local matches=()
    while IFS= read -r f; do
        [[ "$(jq -r '.mainRepo // empty' "$f")" == "$root" ]] && matches+=("$f")
    done < <(find_all_sessions)
    if [[ ${#matches[@]} -eq 1 ]]; then
        echo "${matches[0]}"
        return 0
    fi
    return 1
}

# Resolve project path from argument or current directory
resolve_project_path() {
    local arg="$1"
    local resolved

    if [[ -z "$arg" ]] || [[ "$arg" == "." ]]; then
        resolved="$(pwd)"
    elif [[ "$arg" == /* ]]; then
        resolved="$arg"
    else
        resolved="$(pwd)/$arg"
    fi

    # Normalize path
    resolved="$(cd "$resolved" 2>/dev/null && pwd)" || die "Directory does not exist: $arg"
    echo "$resolved"
}

# Prompt for yes/no
confirm() {
    local prompt="${1:-Continue?}"
    local default="${2:-y}"
    local yn

    if [[ "$default" == "y" ]]; then
        read -r -p "$prompt [Y/n]: " yn
        yn="${yn:-y}"
    else
        read -r -p "$prompt [y/N]: " yn
        yn="${yn:-n}"
    fi

    [[ "$yn" =~ ^[Yy] ]]
}

# Prompt for choice
prompt_choice() {
    local prompt="$1"
    shift
    local options=("$@")
    local i=1

    echo "$prompt"
    for opt in "${options[@]}"; do
        echo "  $i) $opt"
        ((i++))
    done

    local choice
    read -r -p "Choice [1-${#options[@]}]: " choice

    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#options[@]} )); then
        echo "$choice"
    else
        echo "0"
    fi
}

# ---------------------------------------------------------------------------
# Dependency-cache provisioning
#
# A workspace's agent runs as the in-container `developer` user, whose UID never
# matches the host user, so a host-owned bind-mount dir isn't writable from
# inside (under rootless Docker it even looks root-owned). These helpers create
# such a dir and hand its ownership to `developer`, so npm/Maven/sbt caches
# shared from the host are writable. Used by `cww cache` and auto-provisioning
# on create.
# ---------------------------------------------------------------------------

# Any locally-built cww image works for these helpers — the `developer` user
# is identical across the per-agent images (they share the same base stage).
find_any_cww_image() {
    local tag
    for tag in claude vibe latest; do
        if docker image inspect "coder-workspace-workflow:$tag" >/dev/null 2>&1; then
            echo "coder-workspace-workflow:$tag"
            return 0
        fi
    done
    return 1
}

# Echo the `developer` UID:GID from the image (queried, not hardcoded — it can
# shift with the base image). Cached in a global to avoid repeated docker runs.
get_developer_ids() {
    local image="$1"
    if [[ -z "${_CWW_DEV_IDS:-}" ]]; then
        _CWW_DEV_IDS="$(docker run --rm --entrypoint sh "$image" -c \
            'printf "%s:%s" "$(id -u developer)" "$(id -g developer)"')" || return 1
    fi
    echo "$_CWW_DEV_IDS"
}

# Ensure a host cache dir exists and is owned by the container `developer`.
# The chown runs in a throwaway root container, so it needs no host sudo and,
# under rootless, lands on the correct subuid automatically. Args: <host-dir>
# Returns non-zero (rather than exiting) on failure, so callers can choose to
# hard-fail (`|| die`) or continue (`|| warn`).
provision_cache_dir() {
    local host_dir="$1" image ids uid gid
    image="$(find_any_cww_image)" || {
        error "No cww image found. Run 'cww build' first."; return 1; }
    ids="$(get_developer_ids "$image")" || { error "Could not read 'developer' UID from the image."; return 1; }
    uid="${ids%%:*}"; gid="${ids#*:}"
    [[ -n "$uid" && -n "$gid" ]] || { error "Could not read 'developer' UID from the image."; return 1; }
    mkdir -p "$host_dir" || return 1
    docker run --rm --user 0 --entrypoint chown -v "${host_dir}:/c" "$image" -R "${uid}:${gid}" /c
}
