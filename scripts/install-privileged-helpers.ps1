# Installs the privileged helpers (docs/self-recovery.md). Run ONCE, as administrator (e.g. over SSH from
# another machine with an elevated account); after that the app recovers the sandbox drive by itself.
#
#   .\install-privileged-helpers.ps1                       # defaults below
#   .\install-privileged-helpers.ps1 -PagefileGB 48        # also offer a fixed-pagefile action
#   .\install-privileged-helpers.ps1 -Uninstall
#   .\install-privileged-helpers.ps1 -Vhdx D:\work\ffw\devdrive.vhdx -Letter V -Flex -StateFile D:\work\ffw\devdrive.json `
#       -DaemonConfig D:\work\ffw\daemon\daemon.json -WorkerRoot D:\work\ffw -Actions mount,trim,compact,grow
#                                                          # a worker install's Dev Drive (w900, scripts/worker/devdrive.ps1 runs this)
#
# What it does: copies scripts\privileged\ffsb-helper.ps1 to %ProgramData%\ffsb-helpers (writable only by
# SYSTEM and Administrators), and registers one SYSTEM task per action (ffsb-helper-mount, which also runs
# at every boot, -trim, -compact, -reboot, and -pagefile with -PagefileGB) whose arguments are fixed here. The app's user gets
# read + run rights on those tasks only: it can start an action, not change what it runs.
#
# -Actions deduprepair (w6597) registers ffsb-helper-deduprepair, which is NOT a SYSTEM task: it runs
# refs-dedup-repair.ps1 nightly at 01:30 (before the daily ReFS dedup job) as LOCAL SERVICE with its own task SID
# (ProcessTokenSidType Unrestricted) and only SeChangeNotifyPrivilege. That SID gets query, start and stop on the
# refsdedupsvc service (one ACE in its DACL, LCRPWP: query status, start, stop) and write on results\dedup-repair; nothing else. -Uninstall
# removes the task and that ACE.
param(
  [string]$Vhdx = 'C:\ffsb-devdrive.vhdx',
  [string]$Letter = 'F',
  # The account the app runs as. Default: the account of the app's ffsb-server logon task, else the account
  # running this script. (Not USERDOMAIN\USERNAME: over OpenSSH USERDOMAIN is WORKGROUP, which is no account.)
  [string]$User = '',
  [int]$PagefileGB = 0,
  [switch]$Uninstall,
  # A worker install's Dev Drive (w900): the letter is a preference; the helper picks the next free one if it is taken
  # and repoints the state file, the daemon's config and pool state, the root's junctions and the worktrees. See
  # ffsb-helper.ps1. -Actions limits the tasks to those named (default: all, which is what BEAST has).
  [switch]$Flex,
  [string]$StateFile = '',
  [string]$DaemonConfig = '',
  [string]$WorkerRoot = '',
  [string]$Skip = '',
  [string[]]$Actions = @(),
  # ffsb-helper-deduprepair's mode (w6597): repair, or check (find and log, change nothing).
  [ValidateSet('repair', 'check')][string]$DedupRepairMode = 'repair'
)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'run this as administrator' }

# Who may start the helpers: resolved to a SID before anything is registered.
function Resolve-Sid([string]$name) {
  foreach ($n in @($name, ($name -replace '^WORKGROUP\\', "$env:COMPUTERNAME\"), ($name -split '\\')[-1]) | Select-Object -Unique) {
    try { return @{ name = $n; sid = (New-Object Security.Principal.NTAccount($n)).Translate([Security.Principal.SecurityIdentifier]).Value } } catch { }
  }
  return $null
}
if (-not $User) {
  $appTask = Get-ScheduledTask -TaskName 'ffsb-server' -ErrorAction SilentlyContinue
  $User = if ($appTask -and $appTask.Principal.UserId) { $appTask.Principal.UserId } else { [Security.Principal.WindowsIdentity]::GetCurrent().Name }
}
$who = Resolve-Sid $User
if (-not $who) { throw "the account '$User' does not resolve to a SID; pass -User COMPUTERNAME\name (the account the app runs as)" }
$User = $who.name
"helpers will be startable by $User ($($who.sid))"

$dir = Join-Path $env:ProgramData 'ffsb-helpers'
# The dedup repair task's own SID (w6597): derived from the task's name, so it is the same before and after registering.
$RepairTask = 'ffsb-helper-deduprepair'
$RepairAccess = 'LCRPWP'   # SERVICE_QUERY_STATUS, SERVICE_START, SERVICE_STOP: what sc query, start and stop need, no more
function Get-TaskSid([string]$name) {
  # NT TASK\<name> where Windows resolves it; else computed the way service SIDs are (S-1-5-80 there): SHA-1 of the
  # upper-case name in UTF-16LE as five 32-bit numbers. (schtasks /showsid printed only its usage on windows-latest, elevated.)
  try { return (New-Object Security.Principal.NTAccount("NT TASK\$name")).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
  $b = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($name.ToUpperInvariant()))
  'S-1-5-87-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($b, $_ * 4) }) -join '-')
}
# '' where this Windows has no refsdedupsvc (w6623 B1: a null here broke -Uninstall and devdrive.ps1 remove).
function Get-DedupSvcSddl {
  if (-not (Get-Service refsdedupsvc -ErrorAction SilentlyContinue)) { return '' }
  "$(sc.exe sdshow refsdedupsvc | Where-Object { $_ -match '^D:' } | Select-Object -First 1)".Trim()
}
function Set-DedupSvcSddl([string]$sddl) {
  $o = sc.exe sdset refsdedupsvc $sddl 2>&1
  if ($LASTEXITCODE -ne 0) { throw "sc sdset refsdedupsvc failed: $o" }
}
function Remove-DedupRepairAce {
  $f = Join-Path $dir 'deduprepair.sid'
  $tsid = if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { try { Get-TaskSid $RepairTask } catch { '' } }
  if ($tsid -notmatch '^S-1-5-87-') { return }
  $cur = Get-DedupSvcSddl
  if (-not $cur) { return }
  # Every ACE for the task SID, whatever mask Windows prints it with (w6623 M6), then read back to be sure.
  $new = [regex]::Replace($cur, '\(A;;[^;]*;;;' + [regex]::Escape($tsid) + '\)', '')
  if ($new -eq $cur) { return }
  Set-DedupSvcSddl $new
  if ((Get-DedupSvcSddl) -match [regex]::Escape(";;;$tsid)")) { throw "refsdedupsvc still grants $tsid after sc sdset" }
  "removed $RepairTask's ACE from refsdedupsvc ($tsid)"
}
$results = Join-Path $dir 'results'
$actions = if ($Actions.Count) { @($Actions | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) } else { @('mount', 'trim', 'compact', 'detach', 'reboot') + $(if ($PagefileGB -ge 4) { 'pagefile' } else { @() }) }

if ($Uninstall) {
  # -Actions limits the uninstall too (devdrive.ps1 remove takes deduprepair away this way: its arguments name no VHDX).
  $gone = if ($Actions.Count) { $actions } else { @('mount', 'trim', 'compact', 'detach', 'reboot', 'pagefile', 'grow', 'dedup', 'deduprepair') }
  if ($gone -contains 'deduprepair') { Remove-DedupRepairAce }
  foreach ($a in $gone) { Unregister-ScheduledTask -TaskName "ffsb-helper-$a" -Confirm:$false -ErrorAction SilentlyContinue }
  "removed the tasks ffsb-helper-$($gone -join ', ffsb-helper-') (left $dir for its results)"
  return
}

# 1. The script, where only SYSTEM and Administrators can change it (so a task running it as SYSTEM cannot
#    be turned into anything else). Everyone may read it and the results.
New-Item -ItemType Directory -Force $dir, $results | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'privileged\ffsb-helper.ps1') (Join-Path $dir 'ffsb-helper.ps1')
Copy-Item -Force (Join-Path $PSScriptRoot 'privileged\devdrive-lib.ps1') (Join-Path $dir 'devdrive-lib.ps1')
Copy-Item -Force (Join-Path $PSScriptRoot 'privileged\refs-dedup-repair.ps1') (Join-Path $dir 'refs-dedup-repair.ps1')
icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls $dir failed" }

# 2. One SYSTEM task per action, arguments fixed. On demand, except mount, which also runs at every boot: a
#    VHDX attachment does not survive a reboot (or a power cut), and nothing else attaches the drive before
#    the app needs it.
$sid = $who.sid
# w6597: the nightly ReFS dedup self-repair, with only the rights the repair needs (see the header).
function Register-DedupRepair([string]$appSid) {
  $out = Join-Path $results 'dedup-repair'
  New-Item -ItemType Directory -Force $out | Out-Null
  $taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\refs-dedup-repair.ps1`" -Letter $Letter -ResultDir `"$out`" -Mode $DedupRepairMode"
  $task = New-ScheduledTask -Trigger (New-ScheduledTaskTrigger -Daily -At '01:30') `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs) `
    -Principal (New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited -ProcessTokenSidType Unrestricted -RequiredPrivilege 'SeChangeNotifyPrivilege') `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew)
  Register-ScheduledTask -TaskName $RepairTask -InputObject $task -Force | Out-Null
  # The task SID exists once the task does; kept beside the script so -Uninstall can take its ACE away.
  $tsid = Get-TaskSid $RepairTask
  Set-Content -Encoding ascii (Join-Path $dir 'deduprepair.sid') $tsid
  icacls $out /grant:r "*$($tsid):(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $out failed" }
  $t = $svc.GetFolder('\').GetTask($RepairTask)
  $sd = $t.GetSecurityDescriptor(4)
  if ($sd -notmatch [regex]::Escape(";;;$appSid)")) { $t.SetSecurityDescriptor("$sd(A;;GRGX;;;$appSid)", 0) }
  $cur = Get-DedupSvcSddl
  if (-not $cur) { return "registered $RepairTask (task SID $tsid, -Mode $DedupRepairMode, daily 01:30); this Windows has no refsdedupsvc, so it has nothing to repair and no service right was granted" }
  if ($cur -notmatch [regex]::Escape(";;;$tsid)")) {
    $orig = Join-Path $dir 'refsdedupsvc.sddl.orig'
    if (-not (Test-Path $orig)) { Set-Content -Encoding ascii $orig $cur }
    $i = $cur.IndexOf('S:'); $new = if ($i -ge 0) { $cur.Insert($i, "(A;;$RepairAccess;;;$tsid)") } else { "$cur(A;;$RepairAccess;;;$tsid)" }
    Set-DedupSvcSddl $new
    if ((Get-DedupSvcSddl) -notmatch [regex]::Escape("(A;;$RepairAccess;;;$tsid)")) { throw "refsdedupsvc does not show the ACE for $tsid after sc sdset" }
  }
  "registered $RepairTask (runs as LOCAL SERVICE with task SID $tsid, -Mode $DedupRepairMode, daily 01:30; refsdedupsvc grants it $RepairAccess; $User may start it)"
}
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
foreach ($a in $actions) {
  $name = "ffsb-helper-$a"
  if ($a -eq 'deduprepair') { Register-DedupRepair $sid; continue }
  $taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\ffsb-helper.ps1`" -Action $a -Vhdx `"$Vhdx`" -Letter $Letter -ResultDir `"$results`""
  if ($a -eq 'pagefile') { $taskArgs += " -PagefileGB $PagefileGB" }
  if ($Flex) {
    $taskArgs += ' -Flex'
    if ($StateFile) { $taskArgs += " -StateFile `"$StateFile`"" }
    if ($DaemonConfig) { $taskArgs += " -DaemonConfig `"$DaemonConfig`"" }
    if ($WorkerRoot) { $taskArgs += " -WorkerRoot `"$WorkerRoot`"" }
    if ($Skip) { $taskArgs += " -Skip `"$Skip`"" }
  }
  $extra = @{}
  $limit = New-TimeSpan -Hours 2
  if ($a -eq 'mount') { $boot = New-ScheduledTaskTrigger -AtStartup; $boot.Delay = 'PT30S'; $extra.Trigger = $boot }
  # dedup (w4502): a full pass every Sunday at 04:00, after the daily incremental job (02:00, about 30 min); the job caps
  # itself at 5 h, the task at 6 h. Only on a drive with ReFS dedup enabled: install it with -Actions dedup.
  if ($a -eq 'dedup') { $extra.Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '04:00'; $limit = New-TimeSpan -Hours 6 }
  $task = New-ScheduledTask @extra `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs) `
    -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit $limit -MultipleInstances IgnoreNew)
  Register-ScheduledTask -TaskName $name -InputObject $task -Force | Out-Null
  # 3. Let the app's user read and run this task (GR GX), nothing more.
  $t = $svc.GetFolder('\').GetTask($name)
  $sd = $t.GetSecurityDescriptor(4)   # DACL
  if ($sd -notmatch [regex]::Escape(";;;$sid)")) { $t.SetSecurityDescriptor("$sd(A;;GRGX;;;$sid)", 0) }
  "registered $name (runs as SYSTEM; $User may start it)"
}
"helpers installed in $dir for $Vhdx as $($Letter): ; the app starts them with: schtasks /run /tn ffsb-helper-<action>"
