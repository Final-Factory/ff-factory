<#
.SYNOPSIS
  Install an FF Factory worker on this Windows PC, everything under one root folder (w513, docs/worker-install.md).

.DESCRIPTION
  Asks once for what it needs (the root folder, the portal's URL, this machine's credential, the limits), checks every
  prerequisite and changes nothing if one is missing, then: creates the root, clones the game repo into it, installs
  the daemon as a scheduled task at your logon with its folders in the root, adds the Windows Firewall rules for the
  fixed player slots (one administrator prompt) and waits for the portal to see the machine. Safe to run again.

  Run it from a normal PowerShell (not "Run as administrator"). One command, from anywhere:
    irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1 | iex
  or from a clone of ff-factory:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\worker\install.ps1

.PARAMETER CredentialFile
  A file holding the credential, for an unattended run (tests). Without it the credential is asked for, hidden.

.PARAMETER SshHost
  The name the portal reaches this PC by over ssh (default: its tailnet name). -NoSsh sets up no portal ssh (w568).

.PARAMETER Update
  Update the install that is there (w613, docs/worker-install.md "Updating"), also from an ssh session, elevated or not:
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1))) -Update -Root D:\ffw
  It asks nothing: every setting, the credential and the task's user come from the install. -MaxSandboxes,
  -MaxAgentsPerSandbox, -MaxUnity change those; -DaemonRef (default: the commit the portal runs).

.PARAMETER Owner
  Elevated (an administrator's ssh session): the user what the install makes is given to. An update defaults to the
  user the daemon's task runs as.
.PARAMETER VoiceWhisper
  Whisper on this PC's GPU for the portal's mic (w615, docs/voice.md): a model name (large-v3-turbo) turns it on, off
  turns it off. Left out: a re-run keeps what the daemon has (a new install: off).
#>
param(
    [string]$Root = '',
    [string]$PortalUrl = '',
    [int]$MaxSandboxes = 0,
    [int]$MaxAgentsPerSandbox = 0,
    [int]$MaxUnity = 0,
    [int]$Slots = 8,
    [string]$Service = 'FFFactoryDaemon',
    [string]$Source = '',
    [string]$Ref = 'main',
    [string]$RepoUrl = 'https://github.com/Final-Factory/FinalFactory.git',
    [string]$CredentialFile = '',
    [switch]$NoFirewall,
    [switch]$NoCleanup,
    [switch]$AbsoluteWorktrees,
    [string]$UnitySlotsDir = '',
    [string]$SshHost = '',
    [switch]$NoSsh,
    [switch]$Update,
    [string]$DaemonRef = '',
    [string]$Owner = '',
    [string]$VoiceWhisper = ''
)
$ErrorActionPreference = 'Stop'

function Ask([string]$question, [string]$default) {
    $a = Read-Host ($(if ($default) { "$question [$default]" } else { $question }))
    if ($a) { $a.Trim() } else { $default }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
# An elevated install would leave the root's files owned by Administrators, and the daemon's non-elevated git refuses
# such a clone. An update (or -Owner) gives what it makes back to the task's user (icacls /setowner, as the portal's ssh
# deploy does), so it may run elevated: an administrator's ssh session always is (BEAST, w613).
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $Update -and -not $Owner) {
    Write-Host 'Run this from a normal PowerShell, not as administrator: the one step that needs admin rights (the firewall rules) asks for them itself.'
    exit 2
}

if ($Update) {
    # Asks nothing (an ssh session has no console to answer in): the install that is there says everything else.
    if (-not $Root) { Write-Host '-Update needs -Root (the root of the install to update).'; exit 2 }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'root.json'))) { Write-Host "$Root holds no worker install (no root.json): install it first, without -Update."; exit 2 }
} else {
# --- the questions, all at the start
Write-Host 'FF Factory worker install. Everything this machine''s worker uses goes in one folder (the root).'
if (-not $Root) { $Root = Ask 'Root folder (any empty or new folder on a fast drive with 200+ GB free, e.g. D:\ffw)' '' }
if (-not $PortalUrl) { $PortalUrl = Ask 'Portal URL' 'https://' }
if (-not $MaxSandboxes) { $MaxSandboxes = [int](Ask 'Sandboxes at once' '3') }
if (-not $MaxAgentsPerSandbox) { $MaxAgentsPerSandbox = [int](Ask 'Agents per sandbox' '2') }
if (-not $MaxUnity) { $MaxUnity = [int](Ask 'Unity editors at once' '2') }
if ($CredentialFile) {
    $credential = (Get-Content -Raw -LiteralPath $CredentialFile).Trim()
} else {
    $secure = Read-Host 'Machine credential from the portal (ffm_..., hidden)' -AsSecureString
    $credential = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $Root -or -not $PortalUrl -or -not $credential) { Write-Host 'The root, the portal URL and the credential are all needed.'; exit 2 }
}

# --- the tools this script itself needs: node 22.6+ and git 2.48+ (the rest is checked by worker.ts)
function Find-Node {
    $best = $null; $bestv = [version]'0.0'
    $cands = @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    $cands += @(Join-Path $env:ProgramFiles 'nodejs\node.exe')
    foreach ($n in $cands | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $n)) { continue }
        $v = $null
        if ([version]::TryParse("$(& $n -p 'process.versions.node' 2>$null)".Trim(), [ref]$v) -and $v -gt $bestv) { $best = $n; $bestv = $v }
    }
    if ($best) { [pscustomobject]@{ Path = $best; Version = $bestv } }
}
function Offer-Winget([string]$what, [string]$id) {
    Write-Host "$what is needed."
    # Only a person's explicit "y" installs anything: an unattended run (no console, -CredentialFile) never does.
    $interactive = [Environment]::UserInteractive -and -not $CredentialFile -and -not [Console]::IsInputRedirected
    if ($interactive -and (Ask "Install it now with winget ($id)? [y/N]" 'N') -match '^[Yy]') {
        winget install --id $id -e --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) { Write-Host 'Installed. Open a new PowerShell (so the PATH has it) and run this installer again.' }
        else { Write-Host "winget could not install it (exit $LASTEXITCODE). Install it with: winget install --id $id -e" }
    } else {
        Write-Host "Install it with: winget install --id $id -e   then run this installer again."
    }
    exit 2
}
$node = Find-Node
if (-not $node -or $node.Version -lt [version]'22.6') { Offer-Winget 'Node.js 22.6 or newer' 'OpenJS.NodeJS.LTS' }
$gitv = $null
$gitOut = "$(git --version 2>$null)"
if ($gitOut -match 'git version (\d+)\.(\d+)') { $gitv = [version]"$($Matches[1]).$($Matches[2])" }
if (-not $gitv -or $gitv -lt [version]'2.48') { Offer-Winget "git 2.48 or newer (found: $(if ($gitOut) { $gitOut } else { 'none' }))" 'Git.Git' }

# --- the installer's own code: -Source, this script's checkout, or a fresh clone in the temp folder
$temp = $null
if (-not $Source -and $PSScriptRoot) {
    $here = Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue
    if ($here -and (Test-Path (Join-Path $here 'machine\daemon.ts'))) { $Source = $here.Path }
}
if (-not $Source) {
    $temp = Join-Path $env:TEMP ("ff-worker-src-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    # ff-factory is public: no credential helper and no prompt (an ssh session cannot reach the credential manager, w613).
    $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
    git -c credential.helper= -c credential.interactive=never clone --quiet --depth 1 --branch $Ref https://github.com/Final-Factory/ff-factory.git $temp
    if ($LASTEXITCODE -ne 0) { Write-Host 'Could not download the installer (git clone ff-factory failed).'; exit 2 }
    $Source = $temp
}

$flags = @('--disable-warning=ExperimentalWarning')
if ($node.Version -lt [version]'23.6') { $flags = @('--experimental-strip-types') + $flags }
if ($Update) {
    $argv = $flags + @((Join-Path $Source 'scripts\worker\worker.ts'), 'update', '--root', $Root)
    if ($MaxSandboxes) { $argv += @('--max-sandboxes', $MaxSandboxes) }
    if ($MaxAgentsPerSandbox) { $argv += @('--max-agents-per-sandbox', $MaxAgentsPerSandbox) }
    if ($MaxUnity) { $argv += @('--max-unity', $MaxUnity) }
    if ($DaemonRef) { $argv += @('--ref', $DaemonRef) }
    if ($Owner) { $argv += @('--owner', $Owner) }
    if ($VoiceWhisper) { $argv += @('--voice-whisper', $VoiceWhisper) }
    # A local checkout given with -Source is the daemon code too: no download at all.
    if ($Source -and -not $temp) { $argv += @('--source', $Source) }
    try {
        $null | & $node.Path @argv
        $code = $LASTEXITCODE
    } finally {
        if ($temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    }
    exit $code
}
$argv = $flags + @((Join-Path $Source 'scripts\worker\worker.ts'), 'install', '--root', $Root, '--portal-url', $PortalUrl,
    '--max-sandboxes', $MaxSandboxes, '--max-agents-per-sandbox', $MaxAgentsPerSandbox, '--max-unity', $MaxUnity,
    '--slots', $Slots, '--service', $Service, '--repo-url', $RepoUrl, '--credential-stdin')
if ($NoFirewall) { $argv += '--no-firewall' }
if ($NoCleanup) { $argv += '--no-cleanup' }
if ($AbsoluteWorktrees) { $argv += '--absolute-worktrees' }
if ($UnitySlotsDir) { $argv += @('--unity-slots-dir', $UnitySlotsDir) }
if ($SshHost) { $argv += @('--ssh-host', $SshHost) }
if ($NoSsh) { $argv += '--no-ssh' }
if ($Owner) { $argv += @('--owner', $Owner) }
if ($VoiceWhisper) { $argv += @('--voice-whisper', $VoiceWhisper) }
try {
    $credential | & $node.Path @argv
    $code = $LASTEXITCODE
} finally {
    $credential = $null
    if ($temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
exit $code
