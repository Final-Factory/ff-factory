<#
.SYNOPSIS
  Join this Windows PC to FF Factory in one step (w1592, docs/worker-install.md "Adding a machine with a join code").

.DESCRIPTION
  Run it on a PC that is connected to Tailscale, from a normal PowerShell (not "Run as administrator"), with the join
  code an owner got from add_machine join_code:
    irm https://<the portal>/join/windows.ps1 | iex
  The portal serves this file with its own address written in. It:
  1. finds the portal over the tailnet and checks the code with it (the code works only from the tailnet device it was
     made for, once, within its hour);
  2. checks node 22.6+, git 2.48+, git-lfs and Claude Code, and installs the missing ones with winget (or Claude Code's
     own installer) on your yes; reports Unity Hub and editors, and installs none;
  3. turns on OpenSSH Server with a firewall rule for the tailnet only (one administrator prompt), so the portal can
     update this PC later;
  4. redeems the code: the portal makes the machine's record and answers its credential, which goes straight into a
     file only you can read, never onto the screen; runs the worker installer (install.ps1: the Dev Drive, the daemon,
     the portal's ssh key and host-key pin) with that file, and deletes the file;
  5. shows what the portal sees, and whether its ssh gets in (if not: the tailnet tag step, below).
  Run again on a PC that is already installed, it updates the install instead and needs no code.

.PARAMETER Root
  The worker's root folder (default: <the fixed drive with the most free space>:\ffw).
.PARAMETER MaxSandboxes
  Overrides the sandboxes the code or the PC's RAM gives; so do -MaxAgentsPerSandbox and -MaxUnity.
.PARAMETER DryRun
  Check everything and change nothing: the code stays unused.
.PARAMETER Yes
  Ask nothing but the code: take the defaults, install the missing tools.
.PARAMETER Tag
  Offer to tag this PC tag:fff-worker even when the portal's ssh already gets in, or on an update.
.PARAMETER NoTag
  Never offer the tag; print the step for a tailnet admin instead.
#>
param(
    [string]$PortalUrl = '__FF_PORTAL_URL__',
    [string]$Root = '',
    [int]$MaxSandboxes = 0,
    [int]$MaxAgentsPerSandbox = 0,
    [int]$MaxUnity = 0,
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Tag,
    [switch]$NoTag,
    # Tests only (scripts/worker/join.test.ts): a fake tailscale, a fake installer, and no machine setup (tools, sshd).
    [string]$Tailscale = '',
    [string]$Installer = '',
    [switch]$SkipMachineSetup
)

$ErrorActionPreference = 'Stop'
$script:WorkerTag = 'tag:fff-worker'
$script:InstallUrl = 'https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1'
$script:OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows

function Say([string]$text) { Write-Host $text }
function Step([string]$text) { Write-Host ''; Write-Host "== $text" }

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
            & $winget.Source install --id $m.Winget -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
        } else {
            Say 'Installing Claude Code (https://claude.ai/install.ps1)...'
            & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex' | Out-Host
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

# ---------------------------------------------------------------- OpenSSH Server, for the portal's later updates

function Test-SshdReady {
    $svc = Get-Service sshd -ErrorAction SilentlyContinue
    $rule = Get-NetFirewallRule -Name 'FFFactory-sshd-tailnet' -ErrorAction SilentlyContinue
    return [bool]($svc -and $svc.Status -eq 'Running' -and $svc.StartType -eq 'Automatic' -and $rule)
}

function Enable-Sshd([string]$work) {
    if (Test-SshdReady) { Say 'OpenSSH Server: running, starts with Windows, and the tailnet firewall rule is there.'; return $true }
    $result = Join-Path $work 'sshd-result.json'
    $elevated = @"
`$ErrorActionPreference = 'Stop'
`$out = @{}
try {
    `$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    if (`$cap -and `$cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name `$cap.Name | Out-Null; `$out.installed = `$true }
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'no sshd service after installing OpenSSH Server' }
    Set-Service sshd -StartupType Automatic
    Start-Service sshd
    if (-not (Get-NetFirewallRule -Name 'FFFactory-sshd-tailnet' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'FFFactory-sshd-tailnet' -DisplayName 'FF Factory: OpenSSH Server from the tailnet' -Group 'FF Factory' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress '100.64.0.0/10', 'fd7a:115c:a1e0::/48' -Action Allow -Profile Any | Out-Null
        `$out.firewall = 'added'
    }
    `$out.ok = `$true
} catch { `$out.error = "`$_" }
`$out | ConvertTo-Json | Set-Content -LiteralPath '$($result -replace "'", "''")' -Encoding UTF8
"@
    Say 'Turning on OpenSSH Server with a firewall rule for the tailnet only (Windows asks for administrator rights once)...'
    $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevated))
    try {
        Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64
    } catch {
        Say "The administrator prompt was refused: $($_.Exception.Message)"
        return $false
    }
    if (-not (Test-Path -LiteralPath $result)) { Say 'OpenSSH Server: the administrator step wrote no result.'; return $false }
    $r = Get-Content -Raw -LiteralPath $result | ConvertFrom-Json
    if (-not $r.ok) { Say "OpenSSH Server could not be set up: $($r.error)"; return $false }
    Say "OpenSSH Server: $(if ($r.installed) { 'installed, ' } else { '' })running, starts with Windows; firewall rule 'FF Factory: OpenSSH Server from the tailnet' $(if ($r.firewall) { 'added' } else { 'kept' })."
    return $true
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

# ---------------------------------------------------------------- the tailnet tag

function Show-TagStep([string]$name) {
    Say "For the portal's ssh to reach this PC, the tailnet policy's grant must cover it. One of these, by a tailnet admin:"
    Say "  - tag it: Tailscale admin console > Machines > $name > Edit ACL tags > $($script:WorkerTag) (the policy grants $($script:WorkerTag) port 22 from tag:fff-portal; docs/worker-install.md, 'The tailnet'), or"
    Say "  - name it: add $name to the policy's tcp:22 grant for tag:fff-portal (deploy/vm/RUNBOOK.md section 1, 'Adding a machine'), and turn off its key expiry."
    Say 'The daemon works meanwhile; only the portal''s updates over ssh wait for it.'
}

# Tags this PC through `tailscale login --advertise-tags`, on a yes: a browser sign-in by a tag owner.
function Add-WorkerTag([string]$exe, $self) {
    if ($NoTag -or -not $exe) { Show-TagStep $self.Name; return $false }
    Say "This PC is not tagged $($script:WorkerTag). Tagging it signs it into Tailscale again, in your browser (a tag owner's sign-in): the PC then belongs to the tag instead of your login, keeps its address and name, and its key no longer expires."
    if (-not (Confirm-Step "Tag it $($script:WorkerTag) now?" $false)) { Show-TagStep $self.Name; return $false }
    & $exe login "--advertise-tags=$($script:WorkerTag)" | Out-Host
    $after = Get-TailnetSelf $exe
    if (-not $after -or -not $after.Running -or -not ($after.Tags -contains $script:WorkerTag)) {
        Say 'The tag did not take (the policy may not have the tag yet, or the sign-in was not a tag owner''s).'
        Show-TagStep $self.Name
        return $false
    }
    $h = Invoke-Portal 'GET' '/api/health'
    if (-not $h.Ok) {
        Say "WARNING: tagged, and the portal no longer answers ($($h.Error)): the tailnet policy lacks the grants for $($script:WorkerTag) (docs/worker-install.md, 'The tailnet'). Undo with: tailscale login --force-reauth  (sign in as yourself)."
        return $false
    }
    Say "Tagged $($script:WorkerTag); the portal still answers."
    return $true
}

# ---------------------------------------------------------------- running the installer

function Invoke-Installer([string[]]$arguments, [string]$work) {
    $file = $Installer
    if (-not $file) {
        $file = Join-Path $work 'install.ps1'
        Invoke-WebRequest -UseBasicParsing -Uri $script:InstallUrl -OutFile $file
    }
    $shell = $(if ($script:OnWindows -and $PSVersionTable.PSEdition -eq 'Desktop') { 'powershell' } elseif (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' })
    & $shell -NoProfile -ExecutionPolicy Bypass -File $file @arguments | Out-Host
    return $LASTEXITCODE
}

# ---------------------------------------------------------------- the whole join

function Invoke-FFJoin {
    Say 'FF Factory: join this PC (one step). Nothing secret is shown on screen.'
    # install.ps1 refuses an elevated new install (its files would belong to Administrators), so this refuses first; a
    # test's own -Installer makes no files, which lets the tests run on CI's elevated Windows runner.
    if ($script:OnWindows -and -not $Installer) {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Say 'Run this from a normal PowerShell, not as administrator: the steps that need admin rights ask for them.'
            return 2
        }
    }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    if (-not $PortalUrl -or $PortalUrl -like '__FF_*') { $PortalUrl = Ask 'Portal URL (https://<portal>.<tailnet>.ts.net)' '' }
    $script:Portal = $PortalUrl.TrimEnd('/')

    Step 'Tailscale and the portal'
    $tsExe = Find-TailscaleExe
    $self = Get-TailnetSelf $tsExe
    if (-not $self -or -not $self.Running) {
        Say 'Tailscale is not connected on this PC. Install it (https://tailscale.com/download), sign in, then run this again.'
        return 2
    }
    Say "This PC is '$($self.Name)' on the tailnet$(if ($self.Tags.Count) { " (tags: $($self.Tags -join ', '))" } else { ' (no tags)' })."
    $h = Invoke-Portal 'GET' '/api/health'
    if (-not $h.Ok) { Say "The portal at $($script:Portal) does not answer: $($h.Error)"; return 2 }
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
        [void](Enable-Sshd $work)
    }
    $a = @('-Update', '-Root', $root)
    if ($MaxSandboxes) { $a += @('-MaxSandboxes', $MaxSandboxes) }
    if ($MaxAgentsPerSandbox) { $a += @('-MaxAgentsPerSandbox', $MaxAgentsPerSandbox) }
    if ($MaxUnity) { $a += @('-MaxUnity', $MaxUnity) }
    $code = Invoke-Installer $a $work
    if ($Tag -and -not ($self.Tags -contains $script:WorkerTag)) { [void](Add-WorkerTag $tsExe $self) }
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
            Say $(if (Test-SshdReady) { 'OpenSSH Server: ready.' } else { 'Would turn on OpenSSH Server with a tailnet-only firewall rule (one administrator prompt).' })
        }
        Say "Dry run: nothing was changed, and the code is still unused. Run it again without -DryRun to join."
        return 0
    }
    if (-not $Yes -and -not (Confirm-Step 'Go on: install what is missing, set up OpenSSH Server, enrol and install this PC?' $true)) { Say 'Stopped; nothing was changed and the code is still unused.'; return 1 }
    if (-not $SkipMachineSetup) {
        if (-not (Install-Tools)) { return 2 }
        Show-Unity
        Step 'OpenSSH Server'
        if (-not (Enable-Sshd $work)) { Say 'Going on without it: the daemon works, and the portal cannot update this PC over ssh until OpenSSH Server runs (run this again to retry).' }
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
    $a = @('-Root', $root, '-PortalUrl', $script:Portal, '-MaxSandboxes', $limits.maxSandboxes, '-MaxAgentsPerSandbox', $limits.maxAgentsPerSandbox, '-MaxUnity', $limits.maxUnity, '-CredentialFile', $credFile)
    try {
        $exit = Invoke-Installer $a $work
    } finally {
        Remove-Item -LiteralPath $credFile -Force -ErrorAction SilentlyContinue
    }
    Say "The credential file is deleted$(if (Test-Path -LiteralPath $credFile) { ' (NOT: remove it by hand: ' + $credFile + ')' })."

    Step 'What the portal sees'
    $who = Invoke-Portal 'GET' '/machine/whoami' $null $credential
    $ssh = Invoke-Portal 'GET' '/machine/ssh?check=1' $null $credential
    if ($ssh.Ok -and -not $ssh.Body.reachable -and -not $NoTag) { [void](Add-WorkerTag $tsExe $self); $ssh = Invoke-Portal 'GET' '/machine/ssh?check=1' $null $credential }
    elseif ($Tag -and -not ($self.Tags -contains $script:WorkerTag)) { [void](Add-WorkerTag $tsExe $self) }
    elseif ($ssh.Ok -and -not $ssh.Body.reachable) { Show-TagStep $self.Name }
    $credential = $null

    Step 'Summary'
    $id = $r.Body.machineId
    Say "- Machine: $id (tailnet device $($self.Name)), root $root."
    Say "- Installer: $(if ($exit -eq 0) { 'finished' } else { "stopped (exit $exit); its report is above. Fix that and run this again: it updates what is there, or asks for a new code if nothing was installed" })."
    if ($who.Ok) { Say "- The portal sees it: $(if ($who.Body.online) { 'online' } else { 'not online yet' })$(if ($who.Body.daemon) { ", daemon $($who.Body.daemon)" })$(if ($who.Body.root) { ", root $($who.Body.root)" }). list_machines shows it." }
    else { Say "- The portal's view: $($who.Error)" }
    if ($ssh.Ok) { Say "- The portal's ssh ($($ssh.Body.host)): $(if ($ssh.Body.reachable) { 'gets in, so the portal can update this PC' } else { "does not get in yet: $($ssh.Body.detail)" })." }
    Say '- No credential was shown or kept outside the install (its own secrets folder).'
    return $exit
}

if (-not $env:FF_JOIN_NO_MAIN) {
    $rc = Invoke-FFJoin
    # Run as a file (tests, -File), end with the code; through `irm | iex` an exit would close the person's window.
    if ($MyInvocation.MyCommand.Path) { exit $rc }
}
