# install.ps1 - Install Coder Workspace Workflow on Windows.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# The Windows counterpart of install.sh: same file layout, same image build,
# a cww.cmd launcher instead of the sh shim, PowerShell completion instead of
# bash/zsh. Runs on Windows PowerShell 5.1 and PowerShell 7.
#
# Prerequisites are checked, never installed: for anything missing it prints
# where to get it and stops.
#
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the
# ANSI code page.

$ErrorActionPreference = 'Stop'

function Info($msg)    { Write-Host '[INFO] ' -ForegroundColor Blue -NoNewline; Write-Host $msg }
function Success($msg) { Write-Host '[OK] ' -ForegroundColor Green -NoNewline; Write-Host $msg }
function Warn($msg)    { Write-Host '[WARN] ' -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Fail($msg)    { Write-Host '[ERROR] ' -ForegroundColor Red -NoNewline; Write-Host $msg }

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Configuration. Overridable like install.sh's CWW_INSTALL_DIR / CWW_BIN_DIR.
$Home_ = [Environment]::GetFolderPath('UserProfile')
$InstallDir = if ($env:CWW_INSTALL_DIR) { $env:CWW_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'coder-workspace-workflow' }
$BinDir = if ($env:CWW_BIN_DIR) { $env:CWW_BIN_DIR } else { Join-Path $InstallDir 'bin' }
$SourceDir = $PSScriptRoot

# The install replaces directories under InstallDir, so refuse anything that
# isn't an absolute, non-root path.
foreach ($d in @($InstallDir, $BinDir)) {
    if (-not [IO.Path]::IsPathRooted($d) -or ([IO.Path]::GetPathRoot($d) -eq $d)) {
        Fail "Refusing to install to '$d'. Set CWW_INSTALL_DIR / CWW_BIN_DIR to an absolute path."
        exit 1
    }
}

Write-Host ''
Write-Host '============================================================'
Write-Host '       Coder Workspace Workflow (cww) - Installation'
Write-Host '============================================================'
Write-Host ''

# --- Prerequisites ---------------------------------------------------------
Info 'Checking prerequisites...'
$missing = $false

if (Have 'git') {
    Success 'Git found'
} else {
    Fail 'Git is not installed. cww needs it on this machine. Install one of:'
    Write-Host '    winget install --id Git.Git -e'
    Write-Host '    https://git-scm.com/download/win'
    $missing = $true
}

if (Have 'bun') {
    Success 'Bun found'
} else {
    Fail 'Bun is not installed. The cww CLI runs on Bun (https://bun.sh). Install one of:'
    if (Have 'npm') { Write-Host '    npm install -g bun' }
    Write-Host '    winget install --id Oven-sh.Bun -e'
    Write-Host '    powershell -c "irm bun.sh/install.ps1 | iex"'
    if (-not (Have 'npm')) { Write-Host '    npm install -g bun            (if you have Node.js)' }
    $missing = $true
}

# cww drives the docker CLI and 'docker compose'; either Rancher Desktop (with
# the dockerd/moby engine) or Docker Desktop provides both.
$engineUp = $false
if (Have 'docker') {
    Success 'Docker CLI found'
    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail "'docker compose' is not available. Rancher Desktop and Docker Desktop both ship it;"
        Write-Host '    make sure their bin directory is on PATH.'
        $missing = $true
    }
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) {
        $engineUp = $true
        Success 'Container engine is running'
    } else {
        Warn 'The container engine is not reachable. Start Rancher Desktop or Docker Desktop.'
        Warn "The image build is skipped; run 'cww build' once it is up."
    }
} else {
    Fail 'The docker CLI is not installed. Install a container engine, one of:'
    Write-Host '    Rancher Desktop  https://rancherdesktop.io  (choose the dockerd (moby) engine)'
    Write-Host '    Docker Desktop   https://www.docker.com/products/docker-desktop/'
    $missing = $true
}

if ($missing) {
    Write-Host ''
    Fail 'Install the missing prerequisites above, open a new terminal, and re-run this installer.'
    exit 1
}

# --- Files -----------------------------------------------------------------
Info "Installing files to $InstallDir..."
New-Item -ItemType Directory -Force $InstallDir, $BinDir | Out-Null

function Replace-Dir($name) {
    $dest = Join-Path $InstallDir $name
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Force $dest | Out-Null
    return $dest
}

# The TypeScript CLI runs directly under Bun: no build step, no node_modules.
$null = Replace-Dir 'src'
Copy-Item -Recurse -Force (Join-Path $SourceDir 'src\*') (Join-Path $InstallDir 'src')
Copy-Item -Force (Join-Path $SourceDir 'package.json') $InstallDir

# The shared base-image build context, with tmux.conf staged into it.
$null = Replace-Dir 'docker'
New-Item -ItemType Directory -Force (Join-Path $InstallDir 'docker\base') | Out-Null
Copy-Item -Recurse -Force (Join-Path $SourceDir 'docker\base\*') (Join-Path $InstallDir 'docker\base')
Copy-Item -Force (Join-Path $SourceDir 'templates\tmux.conf') (Join-Path $InstallDir 'docker\base')

$null = Replace-Dir 'templates'
Copy-Item -Recurse -Force (Join-Path $SourceDir 'templates\*') (Join-Path $InstallDir 'templates')

$null = Replace-Dir 'docs'
Copy-Item -Force (Join-Path $SourceDir 'docs\*.md') (Join-Path $InstallDir 'docs')

# The host-side skill's references/. install.sh symlinks them to docs/;
# here they are copies (directory symlinks need admin rights on Windows).
# Keep the list in sync with BUILTIN_SKILL_REFERENCES in src/agents/registry.ts
# -- tests/install-skill.test.ts fails if they drift.
$HostSkillRefList = @('user-guide.md', 'accessing-services.md', 'git-strategy.md', 'cww-project-config.md')
$hostSkillRefs = Join-Path $InstallDir 'templates\skills\cww-host\references'
if (Test-Path $hostSkillRefs) { Remove-Item -Recurse -Force $hostSkillRefs }
New-Item -ItemType Directory -Force $hostSkillRefs | Out-Null
foreach ($doc in $HostSkillRefList) {
    Copy-Item -Force (Join-Path $InstallDir "docs\$doc") $hostSkillRefs
}

$null = Replace-Dir 'examples'
Copy-Item -Force (Join-Path $SourceDir 'examples\*') (Join-Path $InstallDir 'examples')

$null = Replace-Dir 'completions'
Copy-Item -Force (Join-Path $SourceDir 'completions\*') (Join-Path $InstallDir 'completions')

Success 'Files installed'

# --- Launcher --------------------------------------------------------------
# A .cmd rather than a .ps1: it runs from cmd and PowerShell alike, whatever
# the execution policy.
Info "Creating launcher in $BinDir..."
$cli = Join-Path $InstallDir 'src\cli.ts'
$launcher = @(
    '@echo off',
    'rem cww launcher - generated by install.ps1',
    'where bun >nul 2>nul || (',
    '  echo cww runs on Bun, which is not installed. 1>&2',
    '  echo Install it with: npm install -g bun   or   winget install --id Oven-sh.Bun -e 1>&2',
    '  exit /b 1',
    ')',
    "bun `"$cli`" %*"
)
Set-Content -Path (Join-Path $BinDir 'cww.cmd') -Value $launcher -Encoding Ascii
Success "Launcher created: $(Join-Path $BinDir 'cww.cmd')"

# --- Image -----------------------------------------------------------------
# Same as install.sh: the shared base, then the default agent's image
# (CWW_AGENT from an existing ~/.cww/env, else claude).
$envFile = Join-Path $Home_ '.cww\env'
$defaultAgent = 'claude'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*(export\s+)?CWW_AGENT=(.*)$' | Select-Object -Last 1
    if ($line) {
        $value = $line.Matches[0].Groups[2].Value.Trim().Trim('"', "'")
        if ($value) { $defaultAgent = $value }
    }
}
if ($engineUp) {
    Write-Host ''
    Info "Building Docker image for the '$defaultAgent' agent (this may take a few minutes)..."
    $tags = @('-t', "coder-workspace-workflow:$defaultAgent")
    if ($defaultAgent -eq 'claude') { $tags += @('-t', 'coder-workspace-workflow:latest') }
    & docker build -t cww-base:latest (Join-Path $InstallDir 'docker\base')
    $ok = $LASTEXITCODE -eq 0
    if ($ok) {
        & docker build @tags (Join-Path $InstallDir "src\agents\$defaultAgent")
        $ok = $LASTEXITCODE -eq 0
    }
    if ($ok) {
        Success "Docker image built: coder-workspace-workflow:$defaultAgent"
        Info 'Other agents build on demand, e.g.: cww build vibe'
    } else {
        Fail 'Failed to build Docker image'
        Warn 'You can try again later with: cww build'
    }
}

# --- PATH ------------------------------------------------------------------
Write-Host ''
# Edited in the registry directly: [Environment]::SetEnvironmentVariable would
# expand entries like %USERPROFILE%\... and store the value as a plain string,
# freezing them. Then running programs (Explorer, so new terminals) are told
# the environment changed.
$envKey = Get-Item 'HKCU:\Environment'
$userPath = $envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$entries = @($userPath -split ';' | Where-Object { $_ })
if ($entries -notcontains $BinDir) {
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Type ExpandString -Value ((@($entries) + $BinDir) -join ';')
    Add-Type -Namespace CwwInstall -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    $result = [UIntPtr]::Zero
    # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5s
    [void][CwwInstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    Success "Added $BinDir to your user PATH"
    Warn 'Close and reopen your terminal windows (all of them, for Windows Terminal) to pick up cww.'
    Warn 'Installed over ssh or remote tools? Sign out and back in: the desktop is not notified from there.'
}
# This session, so the rest of the install (and a caller dot-sourcing it) sees cww.
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }

# --- Completion ------------------------------------------------------------
# Dot-sourced from the profile of both Windows PowerShell 5.1 and PowerShell 7
# (they keep separate profiles).
Write-Host ''
Info 'Installing PowerShell completion...'
$completion = Join-Path $InstallDir 'completions\cww.ps1'
$marker = '# Added by cww install.ps1 (shell completion)'
$documents = [Environment]::GetFolderPath('MyDocuments')
foreach ($profileDir in @('WindowsPowerShell', 'PowerShell')) {
    $profilePath = Join-Path $documents "$profileDir\Microsoft.PowerShell_profile.ps1"
    if ((Test-Path $profilePath) -and (Select-String -Path $profilePath -SimpleMatch $marker -Quiet)) {
        continue
    }
    New-Item -ItemType Directory -Force (Split-Path $profilePath) | Out-Null
    Add-Content -Path $profilePath -Encoding Ascii -Value @('', $marker, "if (Test-Path '$completion') { . '$completion' }")
}
Success 'Completion registered in your PowerShell profile'
# The policy a new terminal gets: this run's own -ExecutionPolicy Bypass sits
# in the Process scope, so skip that one. All Undefined means the Windows
# client default, Restricted.
$policy = 'Restricted'
foreach ($scope in @('MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine')) {
    $p = Get-ExecutionPolicy -Scope $scope
    if ($p -ne 'Undefined') { $policy = "$p"; break }
}
if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') {
    Warn "Your execution policy ($policy) keeps PowerShell from loading profiles, so completion stays off."
    Warn 'To enable it: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'
}

# --- Per-user env file -----------------------------------------------------
$envSeeded = $false
New-Item -ItemType Directory -Force (Join-Path $Home_ '.cww') | Out-Null
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $InstallDir 'examples\cww.env.example') $envFile
    $envSeeded = $true
}

# --- Done ------------------------------------------------------------------
Write-Host ''
Write-Host '============================================================'
Success 'Installation complete!'
Write-Host ''
Write-Host 'Before first use - store the auth token for the coding agent you use:'
if ($envSeeded) {
    Write-Host '  A template was created at ~/.cww/env (readable only by you, like the rest of your profile).'
}
Write-Host "  Run 'cww auth' to store the token in ~/.cww/env"
Write-Host "  (Claude Code: 'claude setup-token' -> CLAUDE_CODE_OAUTH_TOKEN)."
Write-Host ''
Write-Host "  The git credential is captured by the setup flow the first 'cww create'"
Write-Host '  runs in a repo, validated and stored in ~/.cww/credentials.'
Write-Host "  Full notes: $(Join-Path $InstallDir 'examples\cww.env.example')"
Write-Host ''
Write-Host 'Quick start (in a new terminal):'
Write-Host '  cd C:\path\to\your\project'
Write-Host '  cww create <workspace-name>'
Write-Host ''
Write-Host 'Optional - teach the coding agent on THIS machine about cww:'
Write-Host '  cww install-skill'
Write-Host ''
Write-Host "Commands: run 'cww help'."
Write-Host '============================================================'
