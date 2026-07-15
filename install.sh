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

# Configuration. HOME is required regardless of the CWW_* overrides — the
# installer also seeds ~/.cww/env and updates the shell rc file.
if [[ -z "${HOME:-}" ]]; then
    error "HOME is not set; refusing to guess install locations."
    exit 1
fi
INSTALL_DIR="${CWW_INSTALL_DIR:-$HOME/.local/share/coder-workspace-workflow}"
BIN_DIR="${CWW_BIN_DIR:-$HOME/.local/bin}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Refuse to run with unusable target dirs: the install 'rm -rf's paths under
# INSTALL_DIR and replaces BIN_DIR/cww, so neither may ever be empty, relative,
# or / (possible when HOME is unset in a stripped environment).
for dir_var in INSTALL_DIR BIN_DIR; do
    dir_val="${!dir_var}"
    if [[ -z "${dir_val#/}" || "$dir_val" != /* ]]; then
        error "$dir_var resolves to '$dir_val'. Set CWW_$dir_var (or HOME) to an absolute path."
        exit 1
    fi
done

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

# The CLI is TypeScript running on Bun (no build step, no npm dependencies).
# Offer the official installer, but never pipe remote code without an explicit
# yes.
BUN_INSTALL_CMD="curl -fsSL https://bun.sh/install | bash"
if ! command -v bun &> /dev/null; then
    warn "Bun is not installed. The cww CLI runs on Bun (https://bun.sh)."
    read -r -p "Install it now with the official installer ($BUN_INSTALL_CMD)? [y/N]: " REPLY || REPLY=""
    if [[ "$REPLY" =~ ^[Yy] ]]; then
        curl -fsSL https://bun.sh/install | bash
        # The installer lands in ~/.bun/bin and updates the shell rc itself;
        # extend PATH for THIS run so the rest of the install can see it.
        export PATH="$HOME/.bun/bin:$PATH"
        if ! command -v bun &> /dev/null; then
            error "Bun installation did not complete."
            exit 1
        fi
        success "Bun installed"
    else
        error "cww needs Bun. Install it yourself with: $BUN_INSTALL_CMD"
        exit 1
    fi
else
    success "Bun found"
fi

# Create directories
info "Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# Copy files
info "Installing files to $INSTALL_DIR..."

# Copy the TypeScript CLI (runs directly under Bun; no build step, no
# node_modules needed at runtime). The scripts/ dir is removed too: pre-Bun
# installs left the retired bash implementation there.
rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/scripts"
mkdir -p "$INSTALL_DIR/src"
cp -R "$SOURCE_DIR/src/." "$INSTALL_DIR/src/"
cp "$SOURCE_DIR/package.json" "$INSTALL_DIR/"

# Copy docker files: the shared base-image build context. Removed and
# recreated so leftovers from the retired multi-stage layout (a Dockerfile
# directly under docker/) don't linger. The per-agent build contexts
# (Dockerfile + baked config per agent) live under src/agents/ and ride the
# src/ copy above.
rm -rf "$INSTALL_DIR/docker"
mkdir -p "$INSTALL_DIR/docker/base"
cp -R "$SOURCE_DIR/docker/base/." "$INSTALL_DIR/docker/base/"
# Stage tmux.conf into the base build context
cp "$SOURCE_DIR/templates/tmux.conf" "$INSTALL_DIR/docker/base/"

# Copy templates (recursive: templates/skills/ holds the built-in workspace
# skill). Removed and recreated so retired templates don't linger.
rm -rf "$INSTALL_DIR/templates"
mkdir -p "$INSTALL_DIR/templates"
cp -R "$SOURCE_DIR/templates/." "$INSTALL_DIR/templates/"

# Copy docs — the built-in workspace skill bundles them as its reference
# material at create time (single source of truth, no duplicated copy).
rm -rf "$INSTALL_DIR/docs"
mkdir -p "$INSTALL_DIR/docs"
cp "$SOURCE_DIR/docs/"*.md "$INSTALL_DIR/docs/"

# Copy examples
mkdir -p "$INSTALL_DIR/examples"
cp "$SOURCE_DIR/examples/"* "$INSTALL_DIR/examples/"

# Copy shell completions
mkdir -p "$INSTALL_DIR/completions"
cp "$SOURCE_DIR/completions/"* "$INSTALL_DIR/completions/"

# Make scripts executable
chmod +x "$INSTALL_DIR/docker/base/entrypoint.sh"
chmod +x "$INSTALL_DIR/docker/base/cww-browser.sh"

success "Files installed"

# Create the launcher. A tiny sh shim rather than a symlink to cli.ts: it
# keeps the "Bun missing" error friendly and survives cli.ts moving.
info "Creating launcher in $BIN_DIR..."
# May be a symlink to the retired bash dispatcher from a pre-Bun install —
# remove it so the heredoc below doesn't write through it.
rm -f "$BIN_DIR/cww"
cat > "$BIN_DIR/cww" << EOF
#!/bin/sh
# cww launcher - generated by install.sh
command -v bun >/dev/null 2>&1 || {
    echo "cww runs on Bun, which is not installed." >&2
    echo "Install it with: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
}
exec bun "$INSTALL_DIR/src/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/cww"
success "Launcher created: $BIN_DIR/cww"

# Build the default agent's Docker image: the shared base (cww-base:latest)
# first, then the agent's own build context under src/agents/. Which agent is
# the default comes from CWW_AGENT in an existing ~/.cww/env, falling back to
# claude. The other agents' images build on demand ('cww build <agent>', or on
# first 'cww create --agent ...').
DEFAULT_AGENT="claude"
if [[ -f "$HOME/.cww/env" ]]; then
    # shellcheck disable=SC1091
    DEFAULT_AGENT="$(source "$HOME/.cww/env" 2>/dev/null; echo "${CWW_AGENT:-claude}")"
    [[ -z "$DEFAULT_AGENT" ]] && DEFAULT_AGENT=claude
fi
echo ""
info "Building Docker image for the '$DEFAULT_AGENT' agent (this may take a few minutes)..."
AGENT_TAGS=(-t "coder-workspace-workflow:$DEFAULT_AGENT")
# ':latest' stays an alias of the claude image — only the claude image — for
# compose files that predate per-agent images.
[[ "$DEFAULT_AGENT" == "claude" ]] && AGENT_TAGS+=(-t coder-workspace-workflow:latest)
if docker build -t cww-base:latest "$INSTALL_DIR/docker/base" && \
   docker build "${AGENT_TAGS[@]}" "$INSTALL_DIR/src/agents/$DEFAULT_AGENT"; then
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

# Shell completions (bash + zsh). Files are always installed; rc wiring only
# for the user's login shell, mirroring the PATH handling above.
echo ""
info "Installing shell completions..."
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"

BASH_COMPLETION_FILE="$DATA_HOME/bash-completion/completions/cww"
mkdir -p "$(dirname "$BASH_COMPLETION_FILE")"
cp "$SOURCE_DIR/completions/cww.bash" "$BASH_COMPLETION_FILE"

ZSH_COMPLETION_DIR="$DATA_HOME/zsh/site-functions"
mkdir -p "$ZSH_COMPLETION_DIR"
cp "$SOURCE_DIR/completions/_cww" "$ZSH_COMPLETION_DIR/_cww"

COMPLETION_MARKER="# Added by cww install.sh (shell completion)"
case "${SHELL:-}" in
    */zsh)
        # Works whichever side of compinit this lands on: if compinit already
        # ran, compdef exists and registers _cww now; if it runs later, it
        # finds _cww on the extended fpath by itself.
        if grep -Fq "$COMPLETION_MARKER" "$HOME/.zshrc" 2>/dev/null; then
            success "zsh completion installed (already registered in ~/.zshrc)"
        else
            {
                echo ""
                echo "$COMPLETION_MARKER"
                echo "fpath=(\"$ZSH_COMPLETION_DIR\" \$fpath)"
                echo "autoload -Uz _cww"
                echo '(( $+functions[compdef] )) && compdef _cww cww'
            } >> "$HOME/.zshrc"
            success "zsh completion registered in ~/.zshrc"
        fi
        warn "Open a new shell (or: source ~/.zshrc) to pick up completions."
        ;;
    */bash)
        # bash-completion >= 2.9 auto-loads the file; source it explicitly too
        # so completion also works without the bash-completion package.
        if grep -Fq "$COMPLETION_MARKER" "$HOME/.bashrc" 2>/dev/null; then
            success "bash completion installed (already registered in ~/.bashrc)"
        else
            {
                echo ""
                echo "$COMPLETION_MARKER"
                echo "[ -f \"$BASH_COMPLETION_FILE\" ] && source \"$BASH_COMPLETION_FILE\""
            } >> "$HOME/.bashrc"
            success "bash completion registered in ~/.bashrc"
        fi
        warn "Open a new shell (or: source ~/.bashrc) to pick up completions."
        ;;
    *)
        success "Completions installed for bash and zsh (login shell '${SHELL:-unknown}' not wired automatically)"
        ;;
esac

# Seed the per-user env file (agent auth) from the template, without
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
echo "Before first use — store the auth token for the coding agent you use:"
if [[ "$ENV_SEEDED" == "true" ]]; then
    echo "  A template was created at ~/.cww/env (mode 600)."
fi
echo "  Run 'cww auth' to store the token in ~/.cww/env"
echo "  (Claude Code: 'claude setup-token' -> CLAUDE_CODE_OAUTH_TOKEN)."
echo "  Each workspace receives only the credential of the auth method it is"
echo "  created with ('cww create --auth <method>')."
echo ""
echo "  The git credential is captured separately by the setup flow the first"
echo "  'cww create' runs in a repo — a token with repository Read+Write, scoped"
echo "  as tightly as your host allows, validated and stored in ~/.cww/credentials."
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
