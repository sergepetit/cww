# PowerShell completion for cww - installed by install.ps1, dot-sourced from
# $PROFILE. Works in Windows PowerShell 5.1 and PowerShell 7.
#
# Like the zsh/bash scripts: commands and flags are hardcoded here (they ship
# with the CLI, so they can't drift from the installed version); workspace and
# agent names are dynamic, fetched via the hidden 'cww __complete <topic>'
# (fast: session files / the agent registry, no docker).
#
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the
# ANSI code page.

$global:CwwCompletionCommands = [ordered]@{
    'init'           = 'Set a repo up for cww (store git credential, preflight checks)'
    'auth'           = "Store or renew an agent token / this repo's git credential"
    'create'         = 'Create a workspace (clones the repo, brings up services)'
    'teardown'       = "Remove a workspace's containers, volumes, network, and metadata"
    'attach'         = "Re-attach to a workspace's agent session"
    'shell'          = 'Open a plain login shell in a workspace (not the agent)'
    'start'          = 'Resume a stopped workspace (inverse of stop)'
    'stop'           = 'Stop a workspace (its filesystem is preserved)'
    'reset'          = "Re-run the project's .cww/reset.sh (reset/reseed data)"
    'cp'             = 'Copy files between the host and a workspace (scp-style)'
    'export-skill'   = 'Export a personal skill from the host agent config into workspaces'
    'install-skill'  = 'Install the host-side cww skill into an agent config on this machine'
    'list'           = 'List all workspaces and how current their images are'
    'tunnel-command' = "Print the ssh command to reach a workspace's ports"
    'cache'          = 'Provision a shared dependency-cache dir (npm, m2, ...)'
    'build'          = 'Build/rebuild a per-agent Docker image with the current agent CLI'
    'help'           = 'Show the help message'
    'version'        = 'Show the version'
}

# Flags per command. A flag listed in $global:CwwCompletionFlagValues takes a value.
$global:CwwCompletionFlags = @{
    'create'         = @('--branch', '--ref', '--agent', '--auth', '--remote', '--no-attach')
    'init'           = @('--remote', '--agent')
    'auth'           = @('--method')
    'teardown'       = @('--yes', '-y')
    'down'           = @('--yes', '-y')
    'export-skill'   = @('--from', '--copy')
    'install-skill'  = @('--all', '--copy', '--remove')
    'tunnel-command' = @('--host', '--terse')
    'tunnel'         = @('--host', '--terse')
    'list'           = @('--versions', '--json')
    'ls'             = @('--versions', '--json')
    'cache'          = @('--from')
    'build'          = @('--cached')
}

$global:CwwCompletionFlagValues = @('--branch', '--ref', '--agent', '--auth', '--remote', '--method', '--from', '--host')

function global:CwwCompletionQuery([string[]]$topic) {
    @(& cww __complete @topic 2>$null) | Where-Object { $_ }
}

function global:CwwCompletionResults([string[]]$candidates, [string]$word, [string]$type = 'ParameterValue') {
    foreach ($c in $candidates) {
        if ($c -like "$word*") {
            [System.Management.Automation.CompletionResult]::new($c, $c, $type, $c)
        }
    }
}

Register-ArgumentCompleter -Native -CommandName cww, cww.cmd -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    # Elements before the cursor, minus the word being completed.
    $elements = @($commandAst.CommandElements |
        Where-Object { $_.Extent.EndOffset -lt $cursorPosition -or
                       ($_.Extent.EndOffset -eq $cursorPosition -and $wordToComplete -eq '') } |
        ForEach-Object { $_.ToString() })
    if ($wordToComplete -ne '' -and $elements.Count -gt 0 -and $elements[-1] -eq $wordToComplete) {
        $elements = @($elements | Select-Object -First ($elements.Count - 1))
    }

    # Position 1: the command itself.
    if ($elements.Count -le 1) {
        foreach ($name in $global:CwwCompletionCommands.Keys) {
            if ($name -like "$wordToComplete*") {
                [System.Management.Automation.CompletionResult]::new($name, $name, 'Command', $global:CwwCompletionCommands[$name])
            }
        }
        return
    }

    $command = $elements[1]
    $previous = $elements[-1]

    # A flag's value.
    if ($global:CwwCompletionFlagValues -contains $previous) {
        switch ($previous) {
            '--agent'  { CwwCompletionResults (CwwCompletionQuery 'agents') $wordToComplete; return }
            '--auth'   { CwwCompletionResults (CwwCompletionQuery 'auth-methods-all') $wordToComplete; return }
            '--method' {
                $agent = if ($elements.Count -gt 2) { $elements[2] } else { '' }
                CwwCompletionResults (CwwCompletionQuery 'auth-methods', $agent) $wordToComplete
                return
            }
            '--remote' { CwwCompletionResults (@(git remote 2>$null)) $wordToComplete; return }
            '--from'   {
                if ($command -eq 'export-skill') { CwwCompletionResults (CwwCompletionQuery 'agents') $wordToComplete }
                return  # cache --from: nothing here, PowerShell falls back to paths
            }
            default    { return }  # free-form (--branch, --host)
        }
    }

    if ($wordToComplete.StartsWith('-')) {
        $flags = @($global:CwwCompletionFlags[$command]) + @('--help')
        CwwCompletionResults $flags $wordToComplete 'ParameterName'
        return
    }

    # Positionals: count those already given (skipping flags and their values).
    $positionals = 0
    for ($i = 2; $i -lt $elements.Count; $i++) {
        $e = $elements[$i]
        if ($e.StartsWith('-')) {
            if ($global:CwwCompletionFlagValues -contains $e) { $i++ }
        } else {
            $positionals++
        }
    }

    switch -Regex ($command) {
        '^(attach|shell|sh|start|stop|reset|teardown|down|tunnel-command|tunnel)$' {
            if ($positionals -eq 0) { CwwCompletionResults (CwwCompletionQuery 'workspaces') $wordToComplete }
        }
        '^auth$' {
            if ($positionals -eq 0) { CwwCompletionResults (CwwCompletionQuery 'auth-targets') $wordToComplete }
        }
        '^(install-skill)$' {
            if ($positionals -eq 0) { CwwCompletionResults (CwwCompletionQuery 'agents') $wordToComplete }
        }
        '^build$' {
            if ($positionals -eq 0) { CwwCompletionResults (@(CwwCompletionQuery 'agents') + 'all') $wordToComplete }
        }
        '^export-skill$' {
            if ($positionals -eq 0) { CwwCompletionResults (CwwCompletionQuery 'host-skills') $wordToComplete }
            elseif ($positionals -eq 1) { CwwCompletionResults (CwwCompletionQuery 'workspaces') $wordToComplete }
        }
        '^cache$' {
            if ($positionals -eq 0) { CwwCompletionResults @('npm', 'm2', 'ivy2', 'sbt', 'coursier', 'gradle') $wordToComplete }
        }
        '^cp$' {
            # '<workspace>:' prefixes; with none matching, PowerShell falls
            # back to path completion.
            $names = @(CwwCompletionQuery 'workspaces' | ForEach-Object { "${_}:" })
            CwwCompletionResults $names $wordToComplete
        }
        # create/init positionals are paths: return nothing so PowerShell
        # completes paths itself.
    }
}
