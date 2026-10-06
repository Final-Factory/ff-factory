<#
.SYNOPSIS
  Move this PC's FF Factory daemon from today's layout into one worker root (w513, docs/worker-install.md, "Migrating").

.DESCRIPTION
  -DryRun shows what would move where (rename or copy) and the space the copies need, and changes nothing.
  Without it: the root is installed beside the old layout, the small things are copied, then (once no agent there is
  mid-turn) the old daemon stops, the sandboxes move into the root with their git pointed at the root's own clone, the
  seed and the nightly lab follow, and the daemon starts from the root with the machine's own credential and settings.
  -Rollback undoes it until -Cleanup, which deletes the old layout (and with -Legacy archives ~/ff-worker and removes
  the old ad-hoc lab tasks). The runbook gives each machine's exact command.
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$From = '',
    [string]$FromService = '',
    [string]$OldSlots = '',
    [string[]]$Nightly = @(),
    [string]$PortalUrl = '',
    [int]$Slots = 8,
    [int]$MaxSandboxes = 3,
    [int]$MaxAgentsPerSandbox = 2,
    [int]$MaxUnity = 2,
    [string]$Service = 'FFFactoryDaemon',
    [string]$Source = '',
    [string]$RepoUrl = 'https://github.com/Final-Factory/FinalFactory.git',
    [switch]$DryRun,
    [switch]$Rollback,
    [switch]$Cleanup,
    [switch]$Legacy,
    [switch]$NoFirewall,
    [switch]$NoCleanup,
    [switch]$AbsoluteWorktrees
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run this from a normal PowerShell, not as administrator (the firewall step asks for admin rights itself).'
    exit 2
}
$node = $null; $bestv = [version]'0.0'
foreach ($n in @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) | Select-Object -Unique) {
    $v = $null
    if ([version]::TryParse("$(& $n -p 'process.versions.node' 2>$null)".Trim(), [ref]$v) -and $v -gt $bestv) { $node = $n; $bestv = $v }
}
if (-not $node -or $bestv -lt [version]'22.6') { Write-Host 'Node.js 22.6 or newer is needed (winget install --id OpenJS.NodeJS.LTS -e).'; exit 2 }
if (-not $Source) { $Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$flags = @('--disable-warning=ExperimentalWarning')
if ($bestv -lt [version]'23.6') { $flags = @('--experimental-strip-types') + $flags }
$argv = $flags + @((Join-Path $Source 'scripts\worker\worker.ts'), 'migrate', '--root', $Root, '--slots', $Slots, '--max-sandboxes', $MaxSandboxes, '--max-agents-per-sandbox', $MaxAgentsPerSandbox, '--max-unity', $MaxUnity, '--service', $Service, '--repo-url', $RepoUrl)
if ($From) { $argv += @('--from', $From) }
if ($FromService) { $argv += @('--from-service', $FromService) }
if ($OldSlots) { $argv += @('--old-slots', $OldSlots) }
if ($Nightly.Count) { $argv += @('--nightly', ($Nightly -join ';')) }
if ($PortalUrl) { $argv += @('--portal-url', $PortalUrl) }
foreach ($s in @(@('DryRun', 'dry-run'), @('Rollback', 'rollback'), @('Cleanup', 'cleanup'), @('Legacy', 'legacy'), @('NoFirewall', 'no-firewall'), @('NoCleanup', 'no-cleanup'), @('AbsoluteWorktrees', 'absolute-worktrees'))) {
    if ((Get-Variable -Name $s[0] -ValueOnly).IsPresent) { $argv += "--$($s[1])" }
}
& $node @argv
exit $LASTEXITCODE
