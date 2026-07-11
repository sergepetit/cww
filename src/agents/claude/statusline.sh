#!/usr/bin/env bash
# Claude Code status line for cww containers.
#
# Renders three fields separated by " | ":
#     <cwd> | <model name> | <context tokens>
#
# Input is the status JSON that Claude Code streams on stdin. Fields used:
#   .workspace.current_dir              current working directory
#   .model.display_name                 human-readable model name (e.g. "Opus")
#   .context_window.total_input_tokens  tokens currently in the context window
#       (input + cache reads/writes) from the most recent API response; this is
#       null/0 before the first response and again right after /compact.

# Pull the three values out in a single jq pass. `// fallback` keeps the line
# rendering even when a field is missing or null early in the session.
IFS=$'\t' read -r cwd model tokens < <(
    jq -r '[
        (.workspace.current_dir // .cwd // ""),
        (.model.display_name // "?"),
        (.context_window.total_input_tokens // 0)
    ] | @tsv'
)

# Abbreviate the home directory to ~ for a shorter path.
[ -n "$HOME" ] && cwd=${cwd/#$HOME/\~}

# Group an integer into thousands separated by a space (locale-independent),
# e.g. 123456 -> "123 456".
group_thousands() {
    local n=$1 out=
    while [ "${#n}" -gt 3 ]; do
        out=" ${n: -3}$out"
        n=${n:0:${#n}-3}
    done
    printf '%s%s' "$n" "$out"
}

printf '%s | %s | %s tokens' "$cwd" "$model" "$(group_thousands "$tokens")"
