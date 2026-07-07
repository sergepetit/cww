#!/bin/bash
# create-task.sh - Create a workspace: a container that clones the repo and runs
# the app's services. The workspace is identified by a NAME you choose; git
# inside it (branches, rebases, pushes) is entirely yours — cww dictates none.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"
source "$SCRIPT_DIR/lib/agents.sh"

CWW_DIR="$(get_cww_dir)"

# Provision any dependency-cache dir the project declares under ~/.cww/cache,
# so a declared cache "just works" on create without a separate `cww cache`
# step. Only touches dirs that don't exist yet — already-provisioned caches
# (and their ownership) are left untouched, keeping this cheap on every create.
provision_declared_caches() {
    local services_file="$1"
    [[ -f "$services_file" ]] || return 0
    local src expanded
    # Cache mount sources look like "${HOME}/.cww/cache/<...>:<container-path>".
    grep -oE '(\$\{HOME\}|\$HOME)/\.cww/cache/[^:"[:space:]]+' "$services_file" 2>/dev/null \
        | sort -u | while read -r src; do
        expanded="${src//'${HOME}'/$HOME}"; expanded="${expanded//'$HOME'/$HOME}"
        if [[ ! -d "$expanded" ]]; then
            info "Provisioning declared cache: $expanded"
            provision_cache_dir "$expanded" || warn "Could not provision $expanded; that cache mount may not be writable inside the workspace."
        fi
    done
}

# Advisory nudge: if the repo has a known dependency manifest but no matching
# shared cache is mounted, suggest the relevant `cww cache` preset. Never fails.
suggest_caches() {
    local project_path="$1" services_file="$2"
    local declared=""
    [[ -f "$services_file" ]] && declared="$(cat "$services_file")"
    local -a tips=()
    [[ -f "$project_path/package.json" ]] && ! grep -q '\.npm/_cacache' <<<"$declared" && \
        tips+=("Node/npm: cww cache npm")
    [[ -f "$project_path/pom.xml" ]] && ! grep -q '\.m2/repository' <<<"$declared" && \
        tips+=("Maven:    cww cache m2")
    [[ -f "$project_path/build.sbt" ]] && ! grep -qE 'coursier|\.ivy2' <<<"$declared" && \
        tips+=("sbt:      cww cache coursier  (add ivy2 too)")
    { [[ -f "$project_path/build.gradle" || -f "$project_path/build.gradle.kts" ]]; } && \
        ! grep -q 'gradle/caches' <<<"$declared" && tips+=("Gradle:   cww cache gradle")
    [[ ${#tips[@]} -eq 0 ]] && return 0
    info "Tip: share a dependency cache across workspaces to speed up installs —"
    local t; for t in "${tips[@]}"; do echo "        $t"; done
    echo "        then add the printed volume line to .cww/docker-compose.services.yml"
}

# Generate docker-compose.yml from the template into the task dir. Reads the
# task parameters from the enclosing script's variables.
generate_compose() {
    local task_dir="$1"
    local template_file="${CWW_DIR}/templates/docker-compose.yml.template"
    local compose_file="${task_dir}/docker-compose.yml"

    sed -e "s|{{CONTAINER_NAME}}|${CONTAINER_NAME}|g" \
        -e "s|{{CWW_IMAGE}}|$(agent_image "$AGENT")|g" \
        -e "s|{{WORKSPACE_NAME}}|${WORKSPACE_NAME}|g" \
        -e "s|{{BRANCH_NAME}}|${BRANCH_NAME}|g" \
        -e "s|{{REPO_URL}}|${REPO_URL}|g" \
        -e "s|{{GIT_AUTHOR_NAME}}|${GIT_AUTHOR_NAME}|g" \
        -e "s|{{GIT_AUTHOR_EMAIL}}|${GIT_AUTHOR_EMAIL}|g" \
        -e "s|{{CWW_BROWSER}}|${CWW_BROWSER:-on}|g" \
        -e "s|{{HOME}}|${HOME}|g" \
        "$template_file" > "$compose_file"
}

# Render an optional extra_hosts override for the container's /etc/hosts from
# user-maintained host files (global ~/.cww/hosts and per-project <repo>/.cww/hosts).
# Each non-comment line is "hostname ip". Useful for internal VCS/registry hosts
# the container's DNS can't resolve on its own.
generate_hosts_override() {
    local task_dir="$1"
    local out="${task_dir}/docker-compose.hosts.yml"
    local -a entries=()
    local f host ip
    for f in "${HOME}/.cww/hosts" "${PROJECT_PATH}/.cww/hosts"; do
        [[ -f "$f" ]] || continue
        while read -r host ip _; do
            [[ -z "$host" || "$host" == \#* || -z "$ip" ]] && continue
            entries+=("      - \"${host}:${ip}\"")
        done < "$f"
    done
    if [[ ${#entries[@]} -gt 0 ]]; then
        {
            echo "services:"
            echo "  coder:"
            echo "    extra_hosts:"
            printf '%s\n' "${entries[@]}"
        } > "$out"
        info "Adding ${#entries[@]} extra host(s) to the container"
    else
        rm -f "$out"
    fi
}

# Render the override publishing the built-in browser's noVNC port (default on;
# CWW_BROWSER=off in ~/.cww/env or <repo>/.cww/env skips it, and the entrypoint
# then also skips launching the browser stack — the flag reaches it via the
# {{CWW_BROWSER}} template env). Kept out of the main template so a disabled
# browser publishes no dead port. Loopback-only with a Docker-assigned host
# port, so it rides 'cww list' / 'cww tunnel-command' like any service port.
generate_browser_override() {
    local task_dir="$1"
    local out="${task_dir}/docker-compose.browser.yml"
    if ! browser_enabled; then
        rm -f "$out"
        return 0
    fi
    cat > "$out" << 'EOF'
# Generated by cww - do not edit manually
services:
  coder:
    ports:
      - "127.0.0.1::7900"   # noVNC for the built-in browser
EOF
    info "Built-in browser enabled (noVNC on container port 7900; CWW_BROWSER=off disables)"
}

# Bring the task's compose stack up, layering any override files present.
compose_up() {
    local task_dir="$1"
    cd "$task_dir"
    local -a files=(-f docker-compose.yml)
    [[ -f docker-compose.services.yml ]] && files+=(-f docker-compose.services.yml)
    [[ -f docker-compose.hosts.yml ]] && files+=(-f docker-compose.hosts.yml)
    [[ -f docker-compose.browser.yml ]] && files+=(-f docker-compose.browser.yml)
    docker compose "${files[@]}" up -d
}

# Poll for the in-container tmux session. The entrypoint clones the repo before
# starting tmux, so the session appearing is a proxy for "clone finished."
# Returns non-zero after the timeout.
wait_for_session() {
    local container="$1" i
    for ((i = 0; i < 60; i++)); do
        docker exec "$container" tmux has-session -t main 2>/dev/null && return 0
        sleep 1
    done
    return 1
}

# Once the workspace is up: load any personal .cww assets, run the optional
# reset/seed script, then attach (or print how to). Used for fresh creates and
# for recreating a workspace whose container was removed — both start from a
# clean clone, so seeding is appropriate. (Plain attach/restart never reseeds.)
finalize_and_attach() {
    local container="$1"
    if ! wait_for_session "$container"; then
        warn "tmux session did not appear after 60s; the clone may have failed."
        warn "Investigate with: cww shell $WORKSPACE_NAME"
        exit 1
    fi
    # Personal skills/commands/agents are best-effort — a failure here must not
    # take down an otherwise-good workspace.
    materialize_cww_assets "$PROJECT_PATH" "$container" "$AGENT" || true
    run_reset_script "$PROJECT_PATH" "$container" || true  # rc 2 = no script, fine

    if [[ "$NO_ATTACH" == "true" ]]; then
        success "Workspace ready."
        info "Use 'cww attach $WORKSPACE_NAME' to connect, 'cww shell $WORKSPACE_NAME' for a shell."
        exit 0
    fi
    info "Attaching to the agent session ($(agent_label "$AGENT"))..."
    info "Press Ctrl-a d to detach, 'cww attach $WORKSPACE_NAME' to reattach"
    echo ""
    attach_agent_session "$container"
}

# Parse arguments
PROJECT_PATH=""
WORKSPACE_NAME=""
BRANCH_NAME=""
AGENT_ARG=""
NO_ATTACH=false

usage() {
    cat << EOF
Usage: cww create [project-path] <workspace-name> [options]

Create a workspace: a container that clones the repo and brings up the app's
services. You choose the workspace NAME; it identifies the workspace for every
other command. Git inside the workspace is yours — branch, rebase, and push
however you like; cww does not impose a workflow.

Arguments:
  project-path      Path to the git repository (default: current directory)
  workspace-name    Name for the workspace (e.g. sandbox, review, my-feature)

Options:
  --branch <ref>    Branch to check out inside the workspace
                    (default: the branch you're currently on; a name that
                    doesn't exist upstream is created fresh)
  --ref <ref>       Alias for --branch
  --agent <name>    Coding agent to run in the workspace: claude | vibe
                    (default: CWW_AGENT from ~/.cww/env or <repo>/.cww/env,
                    falling back to claude)
  --no-attach       Don't attach to tmux after creating
  -h, --help        Show this help message

Examples:
  cww create sandbox                  # From within a git repo
  cww create . sandbox                # Explicit current directory
  cww create /path/to/project review  # With full project path
  cww create sandbox --branch main    # Start on a specific branch
  cww create sandbox --agent vibe     # Run Mistral Vibe instead of the default agent
EOF
}

# Parse positional and optional arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --branch|--ref)
            BRANCH_NAME="$2"
            shift 2
            ;;
        --agent)
            AGENT_ARG="$2"
            validate_agent "$AGENT_ARG"
            shift 2
            ;;
        --no-attach)
            NO_ATTACH=true
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
            # Positional arguments: [project-path] <workspace-name>
            if [[ -z "$WORKSPACE_NAME" ]] && [[ -z "$PROJECT_PATH" ]]; then
                # First positional: a path (dir / "." / absolute) is the project;
                # anything else is the workspace name.
                if [[ "$1" == "." ]] || [[ "$1" == /* ]] || [[ -d "$1" ]]; then
                    PROJECT_PATH="$1"
                else
                    WORKSPACE_NAME="$1"
                fi
            elif [[ -z "$WORKSPACE_NAME" ]]; then
                WORKSPACE_NAME="$1"
            else
                die "Unexpected argument: $1"
            fi
            shift
            ;;
    esac
done

# Validate arguments
if [[ -z "$WORKSPACE_NAME" ]]; then
    error "Workspace name is required"
    usage
    exit 1
fi

# Resolve project path
if [[ -z "$PROJECT_PATH" ]]; then
    PROJECT_PATH="$(pwd)"
fi
PROJECT_PATH="$(resolve_project_path "$PROJECT_PATH")"
PROJECT_NAME="$(basename "$PROJECT_PATH")"

# Validate git repository
if ! is_git_repo "$PROJECT_PATH"; then
    die "Not a git repository: $PROJECT_PATH"
fi

# Get the actual git root (in case we're in a subdirectory)
GIT_ROOT="$(get_git_root "$PROJECT_PATH")"
if [[ "$GIT_ROOT" != "$PROJECT_PATH" ]]; then
    info "Using git root: $GIT_ROOT"
    PROJECT_PATH="$GIT_ROOT"
    PROJECT_NAME="$(basename "$PROJECT_PATH")"
fi

# Default the branch to check out to whatever the host is on. Empty (e.g.
# detached HEAD) is fine: the container simply stays on the clone's default.
if [[ -z "$BRANCH_NAME" ]]; then
    BRANCH_NAME="$(get_current_branch "$PROJECT_PATH")"
fi

# Determine the repo URL to clone inside the container and the developer's
# identity for authorship. The clone happens in the container; the host only
# supplies these coordinates.
#
# CWW_REPO_URL (optional) overrides the clone URL verbatim and skips
# normalization. Needed when origin is an SSH remote whose web endpoint can't be
# inferred — e.g. a self-hosted Forgejo/Gitea on plain http or a non-443 port,
# where the SSH->https rewrite would guess wrong.
#
# Env is layered: the global ~/.cww/env (tokens, Claude auth) is sourced first,
# then the per-project <repo>/.cww/env if present, so it can override CWW_REPO_URL
# for THIS repo. A global CWW_REPO_URL would otherwise pin every project to one
# clone URL — the per-project file is how each repo carries its own.
CWW_ENV_FILE="$HOME/.cww/env"
if [[ -f "$CWW_ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CWW_ENV_FILE"
fi
PROJECT_ENV_FILE="${PROJECT_PATH}/.cww/env"
if [[ -f "$PROJECT_ENV_FILE" ]]; then
    info "Loading per-project env: $PROJECT_ENV_FILE"
    # shellcheck disable=SC1090
    source "$PROJECT_ENV_FILE"
fi

# Which agent this workspace runs. Precedence: --agent > CWW_AGENT (global or
# per-project env, sourced above) > claude. A workspace whose metadata already
# exists keeps its recorded agent instead (see below).
AGENT="$(resolve_agent "$AGENT_ARG")"

if [[ -n "${CWW_REPO_URL:-}" ]]; then
    REPO_URL="$CWW_REPO_URL"
else
    REPO_URL="$(normalize_git_url "$(git -C "$PROJECT_PATH" remote get-url origin 2>/dev/null)")"
fi
if [[ -z "$REPO_URL" ]]; then
    die "Repository has no 'origin' remote and CWW_REPO_URL is unset. cww clones origin inside the container; add a remote or set CWW_REPO_URL in ${PROJECT_PATH}/.cww/env (per-project) or ~/.cww/env (global)."
fi
# '|| true' so an unset identity doesn't trip 'set -e' (git config exits 1 when
# the key is missing); the check below turns it into a clear, actionable error.
GIT_AUTHOR_NAME="$(git -C "$PROJECT_PATH" config user.name || true)"
GIT_AUTHOR_EMAIL="$(git -C "$PROJECT_PATH" config user.email || true)"
if [[ -z "$GIT_AUTHOR_NAME" || -z "$GIT_AUTHOR_EMAIL" ]]; then
    error "git identity not configured; the container needs it to author commits."
    echo "  Set it once per machine, then re-run 'cww create':" >&2
    echo "    git config --global user.name  \"Your Name\"" >&2
    echo "    git config --global user.email \"you@example.com\"" >&2
    exit 1
fi

# Calculate paths and names (keyed on the workspace name, not the branch)
TASK_DIR="$(get_task_dir "$PROJECT_NAME" "$WORKSPACE_NAME")"
CONTAINER_NAME="$(get_container_name "$PROJECT_NAME" "$WORKSPACE_NAME")"

# A workspace that already has metadata keeps its original agent: the recorded
# value beats flags/defaults so a recreate brings back the same workspace.
# (Sessions from before agents were recorded default to claude.)
if [[ -d "$TASK_DIR" ]]; then
    RECORDED_AGENT="$(get_session_value "$TASK_DIR" agent)"
    RECORDED_AGENT="${RECORDED_AGENT:-claude}"
    if [[ -n "$AGENT_ARG" && "$AGENT_ARG" != "$RECORDED_AGENT" ]]; then
        warn "Workspace '$WORKSPACE_NAME' was created with agent '$RECORDED_AGENT'; ignoring --agent $AGENT_ARG."
        warn "To switch agents, teardown the workspace and create it again."
    fi
    AGENT="$RECORDED_AGENT"
fi

info "Project: $PROJECT_NAME"
info "Workspace: $WORKSPACE_NAME"
info "Branch: ${BRANCH_NAME:-<repo default>}"
info "Agent: $(agent_label "$AGENT")"
info "Repo: $REPO_URL"
info "Container: $CONTAINER_NAME"

# Check if container already exists
if container_running "$CONTAINER_NAME"; then
    warn "Workspace '$WORKSPACE_NAME' is already running."
    if confirm "Attach to it?"; then
        attach_agent_session "$CONTAINER_NAME"
    fi
    exit 0
fi

if container_exists "$CONTAINER_NAME"; then
    warn "Workspace '$WORKSPACE_NAME' exists but is stopped."
    if confirm "Start and attach to it?"; then
        docker start "$CONTAINER_NAME"
        # Existing workspace with preserved state — attach, don't reseed.
        info "Attaching to the agent session..."
        attach_agent_session "$CONTAINER_NAME"
    fi
    exit 0
fi

# From here on a container gets (re)created, so the agent's auth and image must
# be in place. The attach-only paths above need neither.
agent_preflight "$AGENT" "$PROJECT_PATH"
ensure_agent_image "$AGENT"

PROJECT_SERVICES="${PROJECT_PATH}/.cww/docker-compose.services.yml"

# Task metadata exists but no container (e.g. it was removed): recreate it from
# the saved compose file. The clone is gone with the container, so the
# entrypoint re-clones fresh — a clean workspace, so finalize (seed) applies.
if [[ -d "$TASK_DIR" ]]; then
    warn "Workspace metadata exists at $TASK_DIR but no container is present."
    info "Recreating the workspace..."
    generate_compose "$TASK_DIR"
    generate_hosts_override "$TASK_DIR"
    generate_browser_override "$TASK_DIR"
    compose_up "$TASK_DIR"
    finalize_and_attach "$CONTAINER_NAME"
fi

# Write session metadata
mkdir -p "$TASK_DIR"
SESSION_JSON=$(cat << EOF
{
  "project": "$PROJECT_NAME",
  "workspace": "$WORKSPACE_NAME",
  "branch": "$BRANCH_NAME",
  "agent": "$AGENT",
  "container": "$CONTAINER_NAME",
  "taskDir": "$TASK_DIR",
  "mainRepo": "$PROJECT_PATH",
  "repoUrl": "$REPO_URL",
  "created": "$(date -Iseconds)"
}
EOF
)
write_session "$TASK_DIR" "$SESSION_JSON"

# Generate docker-compose.yml
info "Generating docker-compose configuration..."
generate_compose "$TASK_DIR"

# Check for project-specific services
if [[ -f "$PROJECT_SERVICES" ]]; then
    info "Found project-specific services configuration"
    cp "$PROJECT_SERVICES" "${TASK_DIR}/docker-compose.services.yml"
    # Ensure any declared ~/.cww/cache mount exists and is container-writable.
    provision_declared_caches "${TASK_DIR}/docker-compose.services.yml" || true
fi

# Start container
info "Starting workspace (the container clones the repo inside)..."
generate_hosts_override "$TASK_DIR"
generate_browser_override "$TASK_DIR"
compose_up "$TASK_DIR"

success "Container started successfully!"
echo ""
echo "Workspace: $WORKSPACE_NAME"
echo "Container: $CONTAINER_NAME"
echo ""

suggest_caches "$PROJECT_PATH" "${TASK_DIR}/docker-compose.services.yml" || true

finalize_and_attach "$CONTAINER_NAME"
