# Installs the privileged helpers (docs/self-recovery.md). Run ONCE, as administrator (e.g. over SSH from
# another machine with an elevated account); after that the app recovers the sandbox drive by itself.
#
#   .\install-privileged-helpers.ps1                       # defaults below
#   .\install-privileged-helpers.ps1 -PagefileGB 48        # also offer a fixed-pagefile action
#   .\install-privileged-helpers.ps1 -Uninstall
#
# What it does: copies scripts\privileged\ffsb-helper.ps1 to %ProgramData%\ffsb-helpers (writable only by
# SYSTEM and Administrators), and registers one on-demand SYSTEM task per action (ffsb-helper-mount, -trim,
# -compact, -reboot, and -pagefile with -PagefileGB) whose arguments are fixed here. The app's user gets
# read + run rights on those tasks only: it can start an action, not change what it runs.
param(
  [string]$Vhdx = 'C:\ffsb-devdrive.vhdx',
  [string]$Letter = 'F',
  # The account the app runs as (the one whose desktop session the ffsb-server task starts).
  [string]$User = "$env:USERDOMAIN\$env:USERNAME",
  [int]$PagefileGB = 0,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'run this as administrator' }

$dir = Join-Path $env:ProgramData 'ffsb-helpers'
$results = Join-Path $dir 'results'
$actions = @('mount', 'trim', 'compact', 'reboot') + $(if ($PagefileGB -ge 4) { 'pagefile' } else { @() })

if ($Uninstall) {
  foreach ($a in 'mount', 'trim', 'compact', 'reboot', 'pagefile') { Unregister-ScheduledTask -TaskName "ffsb-helper-$a" -Confirm:$false -ErrorAction SilentlyContinue }
  "removed the ffsb-helper-* tasks (left $dir for its results)"
  return
}

# 1. The script, where only SYSTEM and Administrators can change it (so a task running it as SYSTEM cannot
#    be turned into anything else). Everyone may read it and the results.
New-Item -ItemType Directory -Force $dir, $results | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'privileged\ffsb-helper.ps1') (Join-Path $dir 'ffsb-helper.ps1')
icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls $dir failed" }

# 2. One SYSTEM task per action, on demand only, arguments fixed.
$sid = (New-Object Security.Principal.NTAccount($User)).Translate([Security.Principal.SecurityIdentifier]).Value
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
foreach ($a in $actions) {
  $name = "ffsb-helper-$a"
  $taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\ffsb-helper.ps1`" -Action $a -Vhdx `"$Vhdx`" -Letter $Letter -ResultDir `"$results`""
  if ($a -eq 'pagefile') { $taskArgs += " -PagefileGB $PagefileGB" }
  $task = New-ScheduledTask `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs) `
    -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew)
  Register-ScheduledTask -TaskName $name -InputObject $task -Force | Out-Null
  # 3. Let the app's user read and run this task (GR GX), nothing more.
  $t = $svc.GetFolder('\').GetTask($name)
  $sd = $t.GetSecurityDescriptor(4)   # DACL
  if ($sd -notmatch [regex]::Escape(";;;$sid)")) { $t.SetSecurityDescriptor("$sd(A;;GRGX;;;$sid)", 0) }
  "registered $name (runs as SYSTEM; $User may start it)"
}
"helpers installed in $dir for $Vhdx as $($Letter): ; the app starts them with: schtasks /run /tn ffsb-helper-<action>"
