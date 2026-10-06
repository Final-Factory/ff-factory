<#
.SYNOPSIS
  Remove an FF Factory worker install from this Windows PC (w513, docs/worker-install.md).

.DESCRIPTION
  Refuses, naming them, while agents are mid-turn there or its sandboxes hold unpushed commits or uncommitted files
  (-Force discards them). Then: the portal forgets the machine, the daemon's task goes, whatever still runs from the
  root is stopped, the firewall rules go (one administrator prompt), the root is deleted, and a check lists anything
  left. What it leaves on purpose (Unity Hub's editors, the tools' own files in your home folder) is listed at the end.

    powershell -NoProfile -ExecutionPolicy Bypass -File <root>\daemon\src\scripts\worker\uninstall.ps1 -Root <root>
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$Force,
    [switch]$Yes,
    [switch]$KeepRegistration
)
$ErrorActionPreference = 'Stop'
$node = $null; $bestv = [version]'0.0'
foreach ($n in @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) | Select-Object -Unique) {
    $v = $null
    if ([version]::TryParse("$(& $n -p 'process.versions.node' 2>$null)".Trim(), [ref]$v) -and $v -gt $bestv) { $node = $n; $bestv = $v }
}
if (-not $node -or $bestv -lt [version]'22.6') { Write-Host 'Node.js 22.6 or newer is needed (winget install --id OpenJS.NodeJS.LTS -e).'; exit 2 }
$src = Join-Path $PSScriptRoot '..\..'
if (-not (Test-Path (Join-Path $src 'scripts\worker\worker.ts'))) { $src = Join-Path $Root 'daemon\src' }
# The code may live inside the root it deletes: run a copy from the temp folder.
$copy = Join-Path $env:TEMP ("ff-worker-uninstall-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $copy | Out-Null
foreach ($d in 'scripts', 'server', 'shared', 'machine') { Copy-Item -Recurse -LiteralPath (Join-Path $src $d) -Destination (Join-Path $copy $d) }
Copy-Item -LiteralPath (Join-Path $src 'package.json') -Destination $copy
$flags = @('--disable-warning=ExperimentalWarning')
if ($bestv -lt [version]'23.6') { $flags = @('--experimental-strip-types') + $flags }
$argv = $flags + @((Join-Path $copy 'scripts\worker\worker.ts'), 'uninstall', '--root', $Root)
if ($Force) { $argv += '--force' }
if ($Yes) { $argv += '--yes' }
if ($KeepRegistration) { $argv += '--keep-registration' }
Push-Location $env:TEMP
try { & $node @argv; $code = $LASTEXITCODE } finally { Pop-Location; Remove-Item -LiteralPath $copy -Recurse -Force -ErrorAction SilentlyContinue }
exit $code
