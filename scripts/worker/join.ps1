<#
.SYNOPSIS
  Join this Windows PC to FF Factory in one step (w1592, docs/worker-install.md "Adding a machine with a join code").

.DESCRIPTION
  Run it on a PC that is connected to Tailscale, with the join code an owner got from add_machine join_code: the
  dashboard's ff-factory-join.cmd downloads it and runs it with -File, or type this in a PowerShell:
    irm https://<the portal>/join/windows.ps1 | iex
  Elevated or not: an administrator window of the person signed in installs for that person (install.ps1 -Owner).
  Everything it prints goes to a log, %LOCALAPPDATA%\FFFactory\join\join.log, which it names on screen; the code and the
  credential are never printed, so never logged. Exit 3: Tailscale or the portal cannot be reached; 2 or 1: another step
  stopped it, named on screen. The portal serves this file with its own address written in. It:
  1. finds the portal over the tailnet and checks the code with it (the code works only from the tailnet device it was
     made for, once, within its hour);
  2. checks node 22.6+, git 2.48+, git-lfs and Claude Code, and installs the missing ones with winget (or Claude Code's
     own installer) on your yes; reports Unity Hub and editors, and installs none;
  3. redeems the code: the portal makes the machine's record and answers its credential, which goes straight into a
     file only you can read, never onto the screen; runs the worker installer (install.ps1 -NoSsh: the Dev Drive, the
     daemon) with that file, and deletes the file;
  4. shows what the portal sees.
  No OpenSSH Server, firewall rule or tailnet tag (w1596): the portal updates, restarts and unloads this PC over its
  daemon's own link to the portal (docs/worker-install.md, "Updates over the daemon's link").
  Run again on a PC that is already installed, it updates the install instead and needs no code; one that joined with
  ssh keeps it as it is.

.PARAMETER Root
  The worker's root folder (default: <the fixed drive with the most free space>:\ffw).
.PARAMETER MaxSandboxes
  Overrides the sandboxes the code or the PC's RAM gives; so do -MaxAgentsPerSandbox and -MaxUnity.
.PARAMETER DryRun
  Check everything and change nothing: the code stays unused.
.PARAMETER Yes
  Ask nothing but the code: take the defaults, install the missing tools.
#>
param(
    [string]$PortalUrl = '__FF_PORTAL_URL__',
    [string]$Root = '',
    [int]$MaxSandboxes = 0,
    [int]$MaxAgentsPerSandbox = 0,
    [int]$MaxUnity = 0,
    [switch]$DryRun,
    [switch]$Yes,
    # Tests only (scripts/worker/join.test.ts): a fake tailscale, a fake installer, and no machine setup (tools).
    [string]$Tailscale = '',
    [string]$Installer = '',
    [switch]$SkipMachineSetup
)

$ErrorActionPreference = 'Stop'
$script:InstallUrl = 'https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1'
$script:OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows

# The run's log (w1603): every line this script and the installer print, never the code or the credential (neither is
# ever printed). ff-factory-join.cmd names it in FF_JOIN_LOG; the PowerShell line gets the same place.
$script:Log = $(if ($env:FF_JOIN_LOG) { $env:FF_JOIN_LOG } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'FFFactory\join\join.log' } else { Join-Path ([IO.Path]::GetTempPath()) 'ff-factory-join.log' })
$script:CurrentStep = 'Starting'

function Write-Log([string]$text) {
    try {
        $dir = Split-Path -Parent $script:Log
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::AppendAllText($script:Log, "$text`r`n", (New-Object Text.UTF8Encoding $false))
    } catch { }
}
function Say([string]$text) { Write-Host $text; Write-Log $text }
function Step([string]$text) { $script:CurrentStep = $text; Write-Host ''; Write-Host "== $text"; Write-Log ''; Write-Log "== $text" }

function Ask([string]$question, [string]$default) {
    if ($Yes) { return $default }
    $a = Read-Host ($(if ($default) { "$question [$default]" } else { $question }))
    if ($a) { $a.Trim() } else { $default }
}

function Confirm-Step([string]$question, [bool]$default) {
    if ($Yes) { return $default }
    $a = Read-Host "$question $(if ($default) { '[Y/n]' } else { '[y/N]' })"
    if (-not $a) { return $default }
    return $a.Trim() -match '^[Yy]'
}

# ---------------------------------------------------------------- the portal

function Invoke-Portal([string]$method, [string]$path, $body = $null, [string]$token = '') {
    $headers = @{}
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    $p = @{ Method = $method; Uri = "$($script:Portal)$path"; Headers = $headers; TimeoutSec = 60; UseBasicParsing = $true }
    if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 5 -Compress); $p.ContentType = 'application/json' }
    try {
        $r = Invoke-WebRequest @p
        return [pscustomobject]@{ Ok = $true; Status = [int]$r.StatusCode; Body = ($r.Content | ConvertFrom-Json) }
    } catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        $msg = "$($_.ErrorDetails.Message)"
        # Windows PowerShell 5.1 can leave ErrorDetails empty; its HttpWebResponse still holds the portal's answer.
        $resp = $_.Exception.Response
        if (-not $msg -and $resp -and $resp.PSObject.Methods['GetResponseStream']) {
            try {
                $s = $resp.GetResponseStream()
                if ($s.CanSeek) { $s.Position = 0 }
                $msg = (New-Object IO.StreamReader($s)).ReadToEnd()
            } catch { }
        }
        $err = $null
        if ($msg) { try { $err = ($msg | ConvertFrom-Json).error } catch { $err = $msg } }
        if (-not $err) { $err = $_.Exception.Message }
        return [pscustomobject]@{ Ok = $false; Status = $status; Error = "$err" }
    }
}

# ---------------------------------------------------------------- facts about this PC

function Find-TailscaleExe {
    if ($Tailscale) { return $Tailscale }
    $c = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}

# This PC as Tailscale sees it: connected or not, its device name and tags.
function Get-TailnetSelf([string]$exe) {
    if (-not $exe) { return $null }
    $raw = (& $exe status --json 2>$null) -join "`n"
    if (-not $raw) { return $null }
    try { $j = $raw | ConvertFrom-Json } catch { return $null }
    $name = ''
    if ($j.Self -and $j.Self.DNSName) { $name = ([string]$j.Self.DNSName).TrimEnd('.').Split('.')[0].ToLower() }
    $tags = @()
    if ($j.Self -and $j.Self.Tags) { $tags = @($j.Self.Tags) }
    [pscustomobject]@{ Running = ($j.BackendState -eq 'Running'); Name = $name; Tags = $tags }
}

function Get-FreeGB([string]$path) {
    try {
        $q = [IO.Path]::GetPathRoot($path)
        if (-not $q) { return $null }
        return [math]::Round(([IO.DriveInfo]::new($q)).AvailableFreeSpace / 1GB, 1)
    } catch { return $null }
}

# The fixed drive with the most free space, for the default root.
function Get-DefaultRoot {
    $best = $null
    foreach ($d in [IO.DriveInfo]::GetDrives()) {
        if ($d.DriveType -ne 'Fixed' -or -not $d.IsReady) { continue }
        if (-not $best -or $d.AvailableFreeSpace -gt $best.AvailableFreeSpace) { $best = $d }
    }
    if (-not $best) { return (Join-Path $HOME 'ffw') }
    return (Join-Path $best.RootDirectory.FullName 'ffw')
}

function Get-MachineFacts([string]$root) {
    $ram = $null
    try { $ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1) } catch { }
    $facts = @{ os = 'windows'; cpus = [Environment]::ProcessorCount }
    if ($ram) { $facts.ramGB = $ram }
    $free = Get-FreeGB $root
    if ($null -ne $free) { $facts.freeGB = $free }
    return $facts
}

# The root of an install already on this PC: -Root if it holds one, else the folder the daemon's task runs from.
function Find-ExistingInstall([string]$root) {
    $marks = @('root.json', 'moved.json', 'root-move.json')
    if ($root) {
        foreach ($m in $marks) { if (Test-Path -LiteralPath (Join-Path $root $m)) { return $root } }
        return $null
    }
    if (-not $script:OnWindows) { return $null }
    $t = Get-ScheduledTask -TaskName 'FFFactoryDaemon' -ErrorAction SilentlyContinue
    if (-not $t) { return $null }
    $found = Get-RootFromTaskArguments ([string]$t.Actions[0].Arguments)
    if (-not $found) { return $null }
    foreach ($m in $marks) { if (Test-Path -LiteralPath (Join-Path $found $m)) { return $found } }
    return $null
}

# The task's action runs <root>\daemon\run-daemon.ps1 (worker.ts supervisorFacts).
function Get-RootFromTaskArguments([string]$arguments) {
    if ($arguments -match '"?([A-Za-z]:\\[^"]*?)\\daemon\\run-daemon\.ps1') { return $Matches[1] }
    return $null
}

function Get-InstalledMachineId([string]$root) {
    try { return [string]((Get-Content -Raw -LiteralPath (Join-Path $root 'root.json') | ConvertFrom-Json).machine) } catch { return '' }
}

# ---------------------------------------------------------------- the tools

function Update-SessionPath {
    $paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
    $extra = @((Join-Path $env:ProgramFiles 'Git\cmd'), (Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $HOME '.local\bin'), (Join-Path $env:APPDATA 'npm'))
    $env:Path = (@($paths -split ';') + $extra | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Get-ToolVersion([string]$cmd, [string[]]$arguments, [string]$pattern) {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue
    if (-not $c) { return $null }
    $out = "$(& $c.Source @arguments 2>$null)"
    if ($out -match $pattern) { return [version]"$($Matches[1]).$($Matches[2])" }
    return $null
}

# What is missing: each with what installs it.
function Get-MissingTools {
    $missing = @()
    $node = Get-ToolVersion 'node' @('-p', 'process.versions.node') '^(\d+)\.(\d+)'
    if (-not $node -or $node -lt [version]'22.6') { $missing += [pscustomobject]@{ Name = 'Node.js 22.6 or newer'; Found = "$node"; Winget = 'OpenJS.NodeJS.LTS' } }
    $git = Get-ToolVersion 'git' @('--version') 'git version (\d+)\.(\d+)'
    if (-not $git -or $git -lt [version]'2.48') { $missing += [pscustomobject]@{ Name = 'git 2.48 or newer'; Found = "$git"; Winget = 'Git.Git' } }
    elseif (-not (Get-ToolVersion 'git' @('lfs', 'version') 'git-lfs/(\d+)\.(\d+)')) { $missing += [pscustomobject]@{ Name = 'git-lfs'; Found = ''; Winget = 'GitHub.GitLFS' } }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { $missing += [pscustomobject]@{ Name = 'Claude Code'; Found = ''; Winget = '' } }
    return , $missing
}

function Install-Tools {
    Update-SessionPath
    $missing = Get-MissingTools
    if (-not $missing.Count) { Say 'node, git, git-lfs and Claude Code: all here.'; return $true }
    Say "Missing: $(($missing | ForEach-Object { if ($_.Found) { "$($_.Name) (found $($_.Found))" } else { $_.Name } }) -join ', ')."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget -and ($missing | Where-Object { $_.Winget })) {
        Say 'winget is not on this PC: install "App Installer" from the Microsoft Store, then run this again. Or install by hand:'
        $missing | ForEach-Object { if ($_.Winget) { Say "  winget install --id $($_.Winget) -e" } else { Say '  irm https://claude.ai/install.ps1 | iex' } }
        return $false
    }
    # No second question: the one before it ("Go on: install what is missing...") covers this (w1592: the installer
    # sets the PC up without asking again).
    foreach ($m in $missing) {
        if ($m.Winget) {
            Say "Installing $($m.Name) (winget $($m.Winget))..."
            & $winget.Source install --id $m.Winget -e --silent --accept-source-agreements --accept-package-agreements | ForEach-Object { Write-Log ([string]$_); $_ } | Out-Host
        } else {
            Say 'Installing Claude Code (https://claude.ai/install.ps1)...'
            # Downloaded to a file and run with -File: Defender blocks a PowerShell whose command line downloads and runs a
            # script (`-Command "irm ... | iex"`), and the person sees only "Access is denied." (w1603).
            $file = Join-Path ([IO.Path]::GetTempPath()) "ff-claude-install-$PID.ps1"
            Invoke-WebRequest -UseBasicParsing -Uri 'https://claude.ai/install.ps1' -OutFile $file
            & powershell -NoProfile -ExecutionPolicy Bypass -File $file | ForEach-Object { Write-Log ([string]$_); $_ } | Out-Host
        }
    }
    Update-SessionPath
    $still = Get-MissingTools
    if ($still.Count) {
        Say "Still missing after the install: $(($still | ForEach-Object { $_.Name }) -join ', '). Open a new PowerShell and run this again; if it stays missing, install it by hand."
        return $false
    }
    Say 'node, git, git-lfs and Claude Code: all here now.'
    return $true
}

# Unity Hub and its editors: reported, never installed (a multi-GB download whose licence needs your own sign-in).
function Show-Unity {
    $hub = Join-Path $env:ProgramFiles 'Unity Hub\Unity Hub.exe'
    $editors = @(Get-ChildItem -Directory -Path (Join-Path $env:ProgramFiles 'Unity\Hub\Editor') -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'Editor\Unity.exe') } | ForEach-Object { $_.Name })
    $hubText = $(if (Test-Path -LiteralPath $hub) { 'Unity Hub is installed' } else { 'Unity Hub is not installed (winget install --id Unity.UnityHub -e)' })
    $edText = $(if ($editors.Count) { "editors: $($editors -join ', ')" } else { 'no Unity editor yet' })
    Say "Unity: $hubText; $edText. The game's sandboxes need its Unity version: install it in Unity Hub and sign in there (this script installs no editor)."
}

# ---------------------------------------------------------------- the credential file

# A new folder only this account can read (its ACL protected from inheritance), for the credential and the result files.
function New-PrivateFolder {
    $base = $(if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR } else { [IO.Path]::GetTempPath() })
    $dir = Join-Path $base ('ff-join-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
    New-Item -ItemType Directory -Path $dir | Out-Null
    if ($script:OnWindows) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        Set-Acl -LiteralPath $dir -AclObject $acl
    } else {
        & chmod 700 $dir
    }
    return $dir
}

# ---------------------------------------------------------------- running the installer

function Invoke-Installer([string[]]$arguments, [string]$work) {
    $file = $Installer
    if (-not $file) {
        $file = Join-Path $work 'install.ps1'
        Invoke-WebRequest -UseBasicParsing -Uri $script:InstallUrl -OutFile $file
    }
    $shell = $(if ($script:OnWindows -and $PSVersionTable.PSEdition -eq 'Desktop') { 'powershell' } elseif (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' })
    & $shell -NoProfile -ExecutionPolicy Bypass -File $file @arguments | ForEach-Object { Write-Log ([string]$_); $_ } | Out-Host
    return $LASTEXITCODE
}

# ---------------------------------------------------------------- the whole join

# An elevated window (an administrator Command Prompt, w1603: desktop-coosego) of the person signed in: install.ps1 gives
# what it makes to them (-Owner), and their daemon runs as them, not elevated. Another account's elevated window (Windows'
# Administrator protection runs it as a separate admin account, or Run as a different user) would install for that account,
# so it is refused. Returns the owner, '' when not elevated, or $null for a refusal.
function Get-ElevatedOwner {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return '' }
    $console = ''
    try { $console = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName } catch { }
    if ($console) {
        $sid = ''
        try { $sid = (New-Object Security.Principal.NTAccount($console)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
        if ($sid -and $sid -ne $id.User.Value) {
            Say "This window runs as administrator account '$($id.Name)', not as '$console', who is signed in: the install would belong to the wrong account. Double-click ff-factory-join.cmd instead (or run it from a Command Prompt that is not 'as administrator')."
            return $null
        }
    }
    return $id.Name
}

function Invoke-FFJoin {
    Write-Log ''
    # ff-factory-join.cmd tells from this file that PowerShell ran this script (w1603: Defender had stopped it from starting).
    if ($env:FF_JOIN_STARTED) { try { [IO.File]::WriteAllText($env:FF_JOIN_STARTED, "started`r`n") } catch { } }
    Write-Log "$(Get-Date -Format o) join.ps1 started (PowerShell $($PSVersionTable.PSVersion), as $([Environment]::UserName))"
    Say 'FF Factory: join this PC (one step). Nothing secret is shown on screen.'
    Say "This run's log (no secrets in it): $($script:Log)"
    $script:Owner = ''
    # A test's own -Installer makes no files, which lets the tests run on CI's elevated Windows runner.
    if ($script:OnWindows -and -not $Installer) {
        $script:Owner = Get-ElevatedOwner
        if ($null -eq $script:Owner) { return 2 }
        if ($script:Owner) { Say "This window is elevated: the install is made for $($script:Owner), and its daemon runs as $($script:Owner), not elevated." }
    }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    if (-not $PortalUrl -or $PortalUrl -like '__FF_*') { $PortalUrl = Ask 'Portal URL (https://<portal>.<tailnet>.ts.net)' '' }
    $script:Portal = $PortalUrl.TrimEnd('/')

    Step 'Tailscale and the portal'
    $tsExe = Find-TailscaleExe
    $self = Get-TailnetSelf $tsExe
    if (-not $self -or -not $self.Running) {
        Say 'Tailscale is not connected on this PC. Install it (https://tailscale.com/download), sign in, then run this again.'
        return 3
    }
    Say "This PC is '$($self.Name)' on the tailnet$(if ($self.Tags.Count) { " (tags: $($self.Tags -join ', '))" } else { ' (no tags)' })."
    $h = Invoke-Portal 'GET' '/api/health'
    if (-not $h.Ok) { Say "The portal at $($script:Portal) does not answer: $($h.Error)"; return 3 }
    Say "The portal at $($script:Portal) answers."

    $work = New-PrivateFolder
    try {
        $existing = Find-ExistingInstall $Root
        if ($existing) { return (Invoke-Update $existing $tsExe $self $work) }
        return (Invoke-NewJoin $tsExe $self $work)
    } finally {
        # Only the folder this run made: the credential file, the installer copy and the administrator step's result.
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Update([string]$root, [string]$tsExe, $self, [string]$work) {
    $id = Get-InstalledMachineId $root
    Step "Already installed$(if ($id) { " as $id" }) at ${root}: updating it (no join code needed)"
    if ($DryRun) { Say "Dry run: it would update the install at $root (install.ps1 -Update) and change nothing else now."; return 0 }
    if (-not $SkipMachineSetup) {
        if (-not (Install-Tools)) { return 2 }
        Show-Unity
    }
    $a = @('-Update', '-Root', $root)
    if ($MaxSandboxes) { $a += @('-MaxSandboxes', $MaxSandboxes) }
    if ($MaxAgentsPerSandbox) { $a += @('-MaxAgentsPerSandbox', $MaxAgentsPerSandbox) }
    if ($MaxUnity) { $a += @('-MaxUnity', $MaxUnity) }
    $code = Invoke-Installer $a $work
    Step 'Summary'
    Say $(if ($code -eq 0) { "Updated$(if ($id) { " $id" }) at $root; the installer's report is above." } else { "The update did not finish (exit $code); its report is above. Run this again once that is fixed." })
    return $code
}

function Invoke-NewJoin([string]$tsExe, $self, [string]$work) {
    $rootGuess = $(if ($Root) { $Root } else { Get-DefaultRoot })
    $facts = Get-MachineFacts $rootGuess
    $code = $env:FF_JOIN_CODE
    if (-not $code) { $code = Read-Host 'Join code (from the owner who added this PC)' }
    $chk = Invoke-Portal 'POST' '/machine/join' @{ code = $code; check = $true; facts = $facts }
    if (-not $chk.Ok) { Say "The portal refused the code: $($chk.Error)"; return 2 }
    $c = $chk.Body
    $limits = @{ maxSandboxes = [int]$c.limits.maxSandboxes; maxAgentsPerSandbox = [int]$c.limits.maxAgentsPerSandbox; maxUnity = [int]$c.limits.maxUnity }
    if ($MaxSandboxes) { $limits.maxSandboxes = $MaxSandboxes }
    if ($MaxAgentsPerSandbox) { $limits.maxAgentsPerSandbox = $MaxAgentsPerSandbox }
    if ($MaxUnity) { $limits.maxUnity = $MaxUnity }
    Say "The code is good: this PC joins as '$($c.machineId)' (code valid until $($c.expiresAt))."
    $from = $(if ($MaxSandboxes -or $MaxAgentsPerSandbox -or $MaxUnity) { 'as given here' } elseif ($c.limitsFrom -eq 'code') { "the owner's, with the code" } else { "from this PC: $($c.defaultsWhy)" })
    Say "Limits: $($limits.maxSandboxes) sandboxes, $($limits.maxAgentsPerSandbox) agents per sandbox, $($limits.maxUnity) Unity editors at once ($from)."
    $root = $(if ($Root) { $Root } else { Ask 'Root folder (an empty or new folder on a fast drive with 200+ GB free)' $rootGuess })
    Say "Root: $root ($(Get-FreeGB $root) GB free on its drive). install.ps1 also makes a Dev Drive there for the sandboxes (one administrator prompt)."

    Step 'Tools'
    if ($DryRun) {
        if (-not $SkipMachineSetup) {
            Update-SessionPath
            $missing = Get-MissingTools
            Say $(if ($missing.Count) { "Would install: $(($missing | ForEach-Object { $_.Name }) -join ', ')." } else { 'node, git, git-lfs and Claude Code: all here.' })
            Show-Unity
        }
        Say "Dry run: nothing was changed, and the code is still unused. Run it again without -DryRun to join."
        return 0
    }
    if (-not $Yes -and -not (Confirm-Step 'Go on: install what is missing, enrol and install this PC?' $true)) { Say 'Stopped; nothing was changed and the code is still unused.'; return 1 }
    if (-not $SkipMachineSetup) {
        if (-not (Install-Tools)) { return 2 }
        Show-Unity
    }

    Step 'Enrolling'
    $r = Invoke-Portal 'POST' '/machine/join' @{ code = $code; facts = $facts }
    $code = $null
    if (-not $r.Ok) { Say "The portal refused the join: $($r.Error)"; return 2 }
    $credFile = Join-Path $work 'machine-credential'
    [IO.File]::WriteAllText($credFile, "$($r.Body.credential)`n")
    $credential = [string]$r.Body.credential
    $r.Body.credential = $null
    Say "The portal made the record for '$($r.Body.machineId)' and issued its credential (...$($r.Body.last4)), written to a private file for the installer."

    Step 'Installing (install.ps1)'
    $a = @('-Root', $root, '-PortalUrl', $script:Portal, '-MaxSandboxes', $limits.maxSandboxes, '-MaxAgentsPerSandbox', $limits.maxAgentsPerSandbox, '-MaxUnity', $limits.maxUnity, '-CredentialFile', $credFile, '-NoSsh')
    if ($script:Owner) { $a += @('-Owner', $script:Owner) }
    try {
        $exit = Invoke-Installer $a $work
    } finally {
        Remove-Item -LiteralPath $credFile -Force -ErrorAction SilentlyContinue
    }
    Say "The credential file is deleted$(if (Test-Path -LiteralPath $credFile) { ' (NOT: remove it by hand: ' + $credFile + ')' })."

    Step 'What the portal sees'
    $who = Invoke-Portal 'GET' '/machine/whoami' $null $credential
    $credential = $null

    Step 'Summary'
    $id = $r.Body.machineId
    Say "- Machine: $id (tailnet device $($self.Name)), root $root."
    Say "- Installer: $(if ($exit -eq 0) { 'finished' } else { "stopped (exit $exit); its report is above. Fix that and run this again: it updates what is there, or asks for a new code if nothing was installed" })."
    if ($who.Ok) { Say "- The portal sees it: $(if ($who.Body.online) { 'online' } else { 'not online yet' })$(if ($who.Body.daemon) { ", daemon $($who.Body.daemon)" })$(if ($who.Body.root) { ", root $($who.Body.root)" }). list_machines shows it." }
    else { Say "- The portal's view: $($who.Error)" }
    Say "- Updates: the portal updates, restarts and unloads this PC over its daemon's own link; no ssh, firewall rule or tailnet tag is needed."
    Say '- No credential was shown or kept outside the install (its own secrets folder).'
    return $exit
}

if (-not $env:FF_JOIN_NO_MAIN) {
    # Any error no step caught: the step it stopped at and the error itself, on screen and in the log (w1603).
    $rc = try { Invoke-FFJoin } catch {
        Say ''
        Say "FAILED at the step '$($script:CurrentStep)': $($_.Exception.Message)"
        Write-Log "$($_.InvocationInfo.PositionMessage)"
        1
    }
    if ($rc -ne 0) { Say "It stopped (exit $rc) at '$($script:CurrentStep)': the reason is the line above. Everything this run printed is in $($script:Log)." }
    # Run as a file (tests, -File), end with the code; through `irm | iex` an exit would close the person's window.
    if ($MyInvocation.MyCommand.Path) { exit $rc }
}
