#!/bin/bash
# install.sh - Install Coder Workspace Workflow
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Configuration
INSTALL_DIR="${CWW_INSTALL_DIR:-$HOME/.local/share/coder-workspace-workflow}"
BIN_DIR="${CWW_BIN_DIR:-$HOME/.local/bin}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║       Coder Workspace Workflow (cww) - Installation        ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check prerequisites
info "Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    error "Docker is not installed. Please install Docker first."
    exit 1
fi
success "Docker found"

if ! command -v git &> /dev/null; then
    error "Git is not installed. Please install Git first."
    exit 1
fi
success "Git found"

if ! command -v jq &> /dev/null; then
    warn "jq is not installed. Some features may not work correctly."
    warn "Install with: brew install jq (macOS) or apt install jq (Linux)"
fi

# Create directories
info "Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# Copy files
info "Installing files to $INSTALL_DIR..."

# Copy scripts
mkdir -p "$INSTALL_DIR/scripts/lib"
cp "$SOURCE_DIR/scripts/cww" "$INSTALL_DIR/scripts/"
cp "$SOURCE_DIR/scripts/"*.sh "$INSTALL_DIR/scripts/"
cp "$SOURCE_DIR/scripts/lib/"*.sh "$INSTALL_DIR/scripts/lib/"

# Copy docker files
mkdir -p "$INSTALL_DIR/docker"
cp "$SOURCE_DIR/docker/Dockerfile" "$INSTALL_DIR/docker/"
cp "$SOURCE_DIR/docker/entrypoint.sh" "$INSTALL_DIR/docker/"
cp "$SOURCE_DIR/docker/statusline.sh" "$INSTALL_DIR/docker/"
cp "$SOURCE_DIR/docker/cww-prompt.sh" "$INSTALL_DIR/docker/"
cp "$SOURCE_DIR/docker/cww-browser.sh" "$INSTALL_DIR/docker/"
cp "$SOURCE_DIR/docker/vibe-mcp.toml" "$INSTALL_DIR/docker/"
# Copy tmux.conf to docker dir for Docker build context
cp "$SOURCE_DIR/templates/tmux.conf" "$INSTALL_DIR/docker/"

# Copy templates
mkdir -p "$INSTALL_DIR/templates"
cp "$SOURCE_DIR/templates/"* "$INSTALL_DIR/templates/"

# Copy examples
mkdir -p "$INSTALL_DIR/examples"
cp "$SOURCE_DIR/examples/"* "$INSTALL_DIR/examples/"

# Make scripts executable
chmod +x "$INSTALL_DIR/scripts/cww"
chmod +x "$INSTALL_DIR/scripts/"*.sh
chmod +x "$INSTALL_DIR/docker/entrypoint.sh"
chmod +x "$INSTALL_DIR/docker/cww-browser.sh"

success "Files installed"

# Create symlink
info "Creating symlink in $BIN_DIR..."
ln -sf "$INSTALL_DIR/scripts/cww" "$BIN_DIR/cww"
success "Symlink created: $BIN_DIR/cww"

# Build the default agent's Docker image. The Dockerfile has one target per
# coding agent (claude, vibe); which one is the default comes from CWW_AGENT in
# an existing ~/.cww/env, falling back to claude. The other agents' images
# build on demand ('cww build <agent>', or on first 'cww create --agent ...').
DEFAULT_AGENT="claude"
if [[ -f "$HOME/.cww/env" ]]; then
    # shellcheck disable=SC1091
    DEFAULT_AGENT="$(source "$HOME/.cww/env" 2>/dev/null; echo "${CWW_AGENT:-claude}")"
    [[ -z "$DEFAULT_AGENT" ]] && DEFAULT_AGENT=claude
fi
echo ""
info "Building Docker image for the '$DEFAULT_AGENT' agent (this may take a few minutes)..."
BUILD_TAGS=(-t "coder-workspace-workflow:$DEFAULT_AGENT")
# ':latest' stays an alias of the claude image for compose files that predate
# per-agent images.
[[ "$DEFAULT_AGENT" == "claude" ]] && BUILD_TAGS+=(-t coder-workspace-workflow:latest)
if docker build --target "$DEFAULT_AGENT" "${BUILD_TAGS[@]}" "$INSTALL_DIR/docker"; then
    success "Docker image built: coder-workspace-workflow:$DEFAULT_AGENT"
    info "Other agents build on demand, e.g.: cww build vibe"
else
    error "Failed to build Docker image"
    warn "You can try again later with: cww build"
fi

# Check PATH — and fix it by appending to the right shell rc file.
echo ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    # Pick the rc file for the user's login shell.
    case "${SHELL:-}" in
        */zsh) RC_FILE="$HOME/.zshrc" ;;
        *)     RC_FILE="$HOME/.bashrc" ;;
    esac
    PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
    if [[ -f "$RC_FILE" ]] && grep -Fq "$PATH_LINE" "$RC_FILE"; then
        warn "$BIN_DIR not in current PATH, but already exported in $RC_FILE"
        warn "Open a new shell (or: source $RC_FILE) to pick up cww."
    else
        {
            echo ""
            echo "# Added by cww install.sh"
            echo "$PATH_LINE"
        } >> "$RC_FILE"
        success "Added $BIN_DIR to PATH in $RC_FILE"
        warn "Open a new shell (or: source $RC_FILE) to pick up cww."
    fi
fi

# Seed the per-user env file (git credential) from the template, without
# clobbering an existing one.
ENV_FILE="$HOME/.cww/env"
ENV_SEEDED=false
mkdir -p "$HOME/.cww"
if [[ ! -f "$ENV_FILE" ]]; then
    cp "$INSTALL_DIR/examples/cww.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ENV_SEEDED=true
fi

# Done
echo ""
echo "════════════════════════════════════════════════════════════"
success "Installation complete!"
echo ""
echo "Before first use — set your git credential so the container can clone/push:"
if [[ "$ENV_SEEDED" == "true" ]]; then
    echo "  A template was created at ~/.cww/env (mode 600). Edit it and set:"
else
    echo "  Edit ~/.cww/env (chmod 600) and set:"
fi
echo "    CWW_GIT_USER   - your platform login (REQUIRED for Forgejo/Gitea)"
echo "    CWW_GIT_TOKEN  - a token with repository Read+Write, scoped as tightly"
echo "                     as your host allows"
echo "  Forgejo: Settings → Applications → Access Tokens, permission"
echo "           repository = Read and Write. Newer versions can also limit the"
echo "           token to Specific repositories; if yours can't, use a dedicated"
echo "           machine account for single-repo isolation."
echo "  Full notes: $INSTALL_DIR/examples/cww.env.example"
echo ""
echo "Quick start:"
echo "  cd /path/to/your/project"
echo "  cww create <workspace-name>"
echo ""
echo "Commands:"
echo "  cww create   - Create a workspace (container clones the repo)"
echo "  cww teardown - Remove a workspace's containers, volumes, network, and metadata"
echo "  cww attach   - Re-attach to a workspace's agent session"
echo "  cww shell    - Open a plain shell running in a workspace"
echo "  cww start    - Resume a stopped workspace (inverse of stop)"
echo "  cww stop     - Pause a workspace (stop container)"
echo "  cww reset    - Re-run the project's .cww/reset.sh (reset/reseed data)"
echo "  cww list     - List all workspaces"
echo "  cww help     - Show all commands"
echo ""
echo "════════════════════════════════════════════════════════════"
