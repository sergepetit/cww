#!/bin/bash
# cache-task.sh - Provision a persistent, shared dependency-cache directory that
# workspaces can bind-mount.
#
# Why this exists: a workspace's agent runs as the in-container `developer` user,
# whose UID does NOT match your host user. A cache dir you create on the host is
# therefore owned by "someone else" from inside the container (under rootless
# Docker it even looks root-owned via the user-namespace mapping), so the agent
# can't write it and `npm install` / Maven / sbt fail with permission errors.
#
# The fix is a one-time `chown` of the host dir to the UID `developer` has inside
# the container. We run that chown from a throwaway root container so it works
# without host `sudo` and, under rootless, lands on the correct subuid
# automatically. The ownership lives on the host dir, so it persists across
# workspace teardown/recreate and is shared by all (even parallel) workspaces.
#
# The dir lives under ~/.cww/cache/ — a dedicated, machine-level location that
# you never write to directly, so its container-side ownership is harmless and
# your own ~/.npm, ~/.m2, etc. are left untouched.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

CACHE_ROOT="${HOME}/.cww/cache"

# Well-known presets: <key> -> "<host-subdir>:<container-path>".
# The container paths match the cache locations the bundled toolchains use.
preset_mount() {
    case "$1" in
        npm)      echo "npm/_cacache:/home/developer/.npm/_cacache" ;;
        m2)       echo "m2/repository:/home/developer/.m2/repository" ;;
        ivy2)     echo "ivy2/cache:/home/developer/.ivy2/cache" ;;
        sbt)      echo "sbt/boot:/home/developer/.sbt/boot" ;;
        coursier) echo "coursier:/home/developer/.cache/coursier" ;;
        gradle)   echo "gradle/caches:/home/developer/.gradle/caches" ;;
        *)        return 1 ;;
    esac
}

PRESETS="npm m2 ivy2 sbt coursier gradle"

usage() {
    cat << EOF
Usage: cww cache <preset> [--from <dir>]
       cww cache <name> <container-path> [--from <dir>]

Provision a persistent, shared dependency-cache directory under ~/.cww/cache/
and chown it so a workspace's in-container 'developer' user can write it. Then
add the printed volume line to your project's .cww/docker-compose.services.yml.

Presets (host dir under ~/.cww/cache/ -> container path):
  npm        npm/_cacache   -> /home/developer/.npm/_cacache
  m2         m2/repository  -> /home/developer/.m2/repository
  ivy2       ivy2/cache     -> /home/developer/.ivy2/cache
  sbt        sbt/boot       -> /home/developer/.sbt/boot
  coursier   coursier       -> /home/developer/.cache/coursier
  gradle     gradle/caches  -> /home/developer/.gradle/caches

Custom: give any <name> plus the absolute <container-path> to mount it at.

Options:
  --from <dir>   Prime the cache by copying an existing dir's contents first
                 (e.g. --from ~/.npm/_cacache for a warm start). One-shot copy.
  -h, --help     Show this help message

Examples:
  cww cache npm                              # provision the npm cache
  cww cache npm --from ~/.npm/_cacache       # ... primed from your host cache
  cww cache pip .cache/pip /home/developer/.cache/pip   # a custom cache
EOF
}

# --- Parse arguments -------------------------------------------------------
FROM=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --from)    FROM="${2:?--from needs a directory}"; shift 2 ;;
        --from=*)  FROM="${1#--from=}"; shift ;;
        -*)        die "Unknown option: $1" ;;
        *)         POSITIONAL+=("$1"); shift ;;
    esac
done

[[ ${#POSITIONAL[@]} -ge 1 ]] || { usage; exit 1; }

NAME="${POSITIONAL[0]}"
if mount_spec="$(preset_mount "$NAME")"; then
    # Known preset: host subdir + container path are predefined.
    [[ ${#POSITIONAL[@]} -eq 1 ]] || die "Preset '$NAME' takes no container-path argument."
    HOST_SUBDIR="${mount_spec%%:*}"
    CONTAINER_PATH="${mount_spec#*:}"
else
    # Custom cache: require an absolute container path.
    [[ ${#POSITIONAL[@]} -eq 2 ]] || die "Unknown preset '$NAME'. For a custom cache: cww cache <name> <container-path>. Presets: $PRESETS"
    HOST_SUBDIR="$NAME"
    CONTAINER_PATH="${POSITIONAL[1]}"
    [[ "$CONTAINER_PATH" == /* ]] || die "Container path must be absolute (got '$CONTAINER_PATH')."
fi

HOST_DIR="${CACHE_ROOT}/${HOST_SUBDIR}"

# --- Provision -------------------------------------------------------------
mkdir -p "$HOST_DIR"

if [[ -n "$FROM" ]]; then
    if [[ -d "$FROM" ]]; then
        info "Priming from $FROM ..."
        cp -a "$FROM/." "$HOST_DIR/" 2>/dev/null || warn "Priming copy hit some unreadable files; continuing."
    else
        warn "--from '$FROM' is not a directory; skipping prime."
    fi
fi

# Create + hand ownership to the container 'developer' user (see common.sh).
info "Setting cache ownership for the in-container 'developer' user ..."
provision_cache_dir "$HOST_DIR" || die "Failed to provision ${HOST_DIR}."

success "Cache ready: ${HOST_DIR}"
cat << EOF

Add this to your project's .cww/docker-compose.services.yml, under a 'coder:'
service (it merges onto the base container):

  coder:
    volumes:
      - \${HOME}/.cww/cache/${HOST_SUBDIR}:${CONTAINER_PATH}

Then 'cww create' a workspace — the cache populates on first use and every later
workspace (even a fresh one) reuses it.
EOF
