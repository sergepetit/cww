# bash completion for cww — installed by install.sh.
#
# Commands and flags are hardcoded here (they ship with the CLI, so they can't
# drift from the installed version); workspace and agent names are dynamic,
# fetched via the hidden 'cww __complete <topic>' (fast: session files /
# the agent registry, no docker).

_cww() {
    local cur prev words cword
    if type _init_completion &>/dev/null; then
        _init_completion || return
    else
        # Without the bash-completion package (e.g. stock macOS bash).
        COMPREPLY=()
        cur=${COMP_WORDS[COMP_CWORD]}
        prev=${COMP_WORDS[COMP_CWORD-1]}
        words=("${COMP_WORDS[@]}")
        cword=$COMP_CWORD
    fi

    local commands="init auth create teardown attach shell start stop reset export-skill list tunnel-command cache build help version"
    local presets="npm m2 ivy2 sbt coursier gradle"

    if [[ $cword -eq 1 ]]; then
        if [[ $cur == -* ]]; then
            COMPREPLY=($(compgen -W "--help --version" -- "$cur"))
        else
            COMPREPLY=($(compgen -W "$commands" -- "$cur"))
        fi
        return
    fi

    local cmd=${words[1]}

    # Flags that take a value: complete the value, not more flags.
    case $prev in
        --agent)
            COMPREPLY=($(compgen -W "$(cww __complete agents 2>/dev/null)" -- "$cur"))
            return
            ;;
        --branch|--ref|--host)
            # Free-form values (branch completion deliberately not offered).
            return
            ;;
        --method)
            # Methods depend on the agent given as the first positional.
            COMPREPLY=($(compgen -W "$(cww __complete auth-methods "${words[2]}" 2>/dev/null)" -- "$cur"))
            return
            ;;
        --auth)
            # The agent may not be on the line yet: offer every agent's methods.
            COMPREPLY=($(compgen -W "$(cww __complete auth-methods-all 2>/dev/null)" -- "$cur"))
            return
            ;;
        --remote)
            COMPREPLY=($(compgen -W "$(git remote 2>/dev/null)" -- "$cur"))
            return
            ;;
        --from)
            # 'export-skill --from' names a host agent config; 'cache --from'
            # names a seed directory.
            if [[ $cmd == export-skill ]]; then
                COMPREPLY=($(compgen -W "$(cww __complete agents 2>/dev/null)" -- "$cur"))
            elif type _filedir &>/dev/null; then _filedir -d; else COMPREPLY=($(compgen -d -- "$cur")); fi
            return
            ;;
    esac

    if [[ $cur == -* ]]; then
        local flags="-h --help"
        case $cmd in
            create)                flags="--branch --ref --agent --auth --remote --no-attach -h --help" ;;
            init)                  flags="--remote --agent -h --help" ;;
            auth)                  flags="--method -h --help" ;;
            teardown|down)         flags="-y --yes -h --help" ;;
            list|ls)               flags="--json -h --help" ;;
            tunnel-command|tunnel) flags="--host -h --help" ;;
            cache)                 flags="--from -h --help" ;;
            export-skill)          flags="--from --copy -h --help" ;;
        esac
        COMPREPLY=($(compgen -W "$flags" -- "$cur"))
        return
    fi

    case $cmd in
        teardown|down|attach|shell|sh|start|stop|reset|tunnel-command|tunnel)
            COMPREPLY=($(compgen -W "$(cww __complete workspaces 2>/dev/null)" -- "$cur"))
            ;;
        build)
            COMPREPLY=($(compgen -W "$(cww __complete agents 2>/dev/null) all" -- "$cur"))
            ;;
        export-skill)
            # First positional: skill name; second: workspace.
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "$(cww __complete host-skills 2>/dev/null)" -- "$cur"))
            else
                COMPREPLY=($(compgen -W "$(cww __complete workspaces 2>/dev/null)" -- "$cur"))
            fi
            ;;
        auth)
            COMPREPLY=($(compgen -W "$(cww __complete auth-targets 2>/dev/null)" -- "$cur"))
            ;;
        cache)
            COMPREPLY=($(compgen -W "$presets" -- "$cur"))
            ;;
        create)
            # First positional may be a project path; the workspace name is new,
            # so only offer directories when the word already looks like a path.
            if [[ $cur == /* || $cur == .* || $cur == '~'* ]]; then
                if type _filedir &>/dev/null; then _filedir -d; else COMPREPLY=($(compgen -d -- "$cur")); fi
            fi
            ;;
        init)
            if type _filedir &>/dev/null; then _filedir -d; else COMPREPLY=($(compgen -d -- "$cur")); fi
            ;;
    esac
}

complete -F _cww cww
