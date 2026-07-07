# cww: workspace-aware bash prompt (appended to ~/.bashrc)
# Shows the workspace name (CWW_WORKSPACE, injected by cww) and the LIVE git
# branch of the current directory, so a `cww shell` always makes it obvious
# which workspace and branch you're on. The branch is computed on every prompt
# (not read from the boot-time BRANCH_NAME env) so it tracks checkouts you do
# inside the container.
__cww_git_branch() {
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return
    local ref
    ref="$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)"
    [ -n "$ref" ] && printf ' (%s)' "$ref"
}
PS1='\[\e[01;32m\]${CWW_WORKSPACE:-workspace}\[\e[00m\]:\[\e[01;34m\]\w\[\e[00m\]\[\e[01;33m\]$(__cww_git_branch)\[\e[00m\]\$ '
