# The nightly ReFS dedup self-repair (w6597, docs/sandbox-disk.md "A remount of V: can stop the dedup service watching
# it"). After the Dev Drive's VHDX is detached and attached again, ReFsDedupSvc (demand-start, LocalSystem) may stop
# deduplicating the drive: the next scheduled job fails with 0x80070015 (device not ready) and the volume's task under
# \Microsoft\Windows\ReFsDedupSvc\ stays Running, so no job runs again until the service restarts (measured on LothDesktop,
# 2026-11-08 and 11-26). This finds that state and repairs it before the night's job: stop the service, end the volume's
# task if it is still Running, start the service, and wait for it to log that it watches the drive again (event 6).
#
# It runs as the task ffsb-helper-deduprepair (install-privileged-helpers.ps1 -Actions deduprepair): LOCAL SERVICE with the task's
# own SID (ProcessTokenSidType Unrestricted) and no privilege but SeChangeNotifyPrivilege. That task SID is granted query,
# start and stop on refsdedupsvc and nothing else (its service DACL), and write on <ResultDir> only. Every read here works
# without administrator rights: the two event logs (readable by service accounts), mountvol, schtasks /query. The night's
# dedup itself is the service's own task (SYSTEM), whose trigger runs it after this.
#
#   -Mode repair   find and repair (the task's mode)
#   -Mode check    find and say, change nothing (warn/log only)
#   -Mode force    tests only: run the repair even on a healthy drive (the forced test, docs/sandbox-disk.md)
#
# Once it has stopped the service it always starts it again (finally), whatever fails after the stop (w6597: the first
# forced test on LothDesktop left refsdedupsvc stopped). Native commands run through Native, never bare under 'Stop': in
# Windows PowerShell 5.1 a native command's stderr is a terminating error there.
#
# <ResultDir>\dedup-repair.json: { action, mode, ok, at, state, reasons, did, detail, whoami }; one line per run in
# dedup-repair.log beside it. ok is false only when the drive was broken and is still broken (or the check failed).
param(
  [string]$Letter = 'V',
  [Parameter(Mandatory)][string]$ResultDir,
  [ValidateSet('repair', 'check', 'force')][string]$Mode = 'repair',
  # A volume task Running this long after the last job start is stuck: the daily job caps itself at 2 h.
  [int]$StuckHours = 3,
  # Tests only: judge the logs as they stood at this time (implies -Mode check; the task state is read as it is now).
  [datetime]$AsOf = [datetime]::MinValue,
  # Tests only: throw right after the service stop, to prove the service is started again (the e2e runs it elevated).
  [switch]$FailAfterStop
)
$ErrorActionPreference = 'Stop'
if ($AsOf -ne [datetime]::MinValue) { $Mode = 'check' }
$Sys = Join-Path $env:SystemRoot 'System32'
$whoami = Join-Path $Sys 'whoami.exe'; $sc = Join-Path $Sys 'sc.exe'; $schtasks = Join-Path $Sys 'schtasks.exe'; $mountvol = Join-Path $Sys 'mountvol.exe'
$Service = 'refsdedupsvc'
$Log = 'Microsoft-Windows-ReFsDedupSvc/Operational'
$NotReady = -2147024875   # 0x80070015, ERROR_NOT_READY
$r = [ordered]@{ action = 'dedup-repair'; mode = $(if ($AsOf -ne [datetime]::MinValue) { "check as of $($AsOf.ToUniversalTime().ToString('s'))Z" } else { $Mode }); ok = $true; at = (Get-Date).ToUniversalTime().ToString('o'); state = ''; reasons = @(); did = @(); detail = ''; whoami = '' }

function Save {
  New-Item -ItemType Directory -Force $ResultDir | Out-Null
  [IO.File]::WriteAllText((Join-Path $ResultDir 'dedup-repair.json'), ($r | ConvertTo-Json -Compress -Depth 4))
  $line = '{0} {1} ok={2} {3}: {4} {5} {6}' -f $r.at, $r.mode, $r.ok, $r.state, ($r.reasons -join '; '), ($r.did -join '; '), $r.detail
  [IO.File]::AppendAllText((Join-Path $ResultDir 'dedup-repair.log'), $line.TrimEnd() + "`r`n")
  exit ([int](-not $r.ok))
}
# A native command, its stderr kept as text: under 'Stop', WinPS 5.1 turns stderr into a terminating NativeCommandError.
function Native([string]$exe, [string[]]$a) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $o = @(& $exe @a 2>&1 | ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } })
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  [pscustomobject]@{ code = $code; out = (($o | Where-Object { "$_".Trim() -and "$_" -ne 'System.Management.Automation.RemoteException' }) -join ' ').Trim() }
}
function MountPoints($e) {
  try { @((([xml]$e.ToXml()).Event.EventData.Data.'#text' | ConvertFrom-Json).Volume.MountPoints) } catch { @() }
}
function Events([string]$logName, [int[]]$ids, [int]$max, [scriptblock]$where) {
  $f = @{ LogName = $logName; Id = $ids }
  if ($AsOf -ne [datetime]::MinValue) { $f.EndTime = $AsOf }
  # No matching event is an answer; any other error (access denied, a missing log) is not, and fails the run (w6623 M1).
  $err = $null
  $ev = @(Get-WinEvent -FilterHashtable $f -MaxEvents $max -ErrorAction SilentlyContinue -ErrorVariable err | Where-Object $where)
  $bad = @($err | Where-Object { "$($_.FullyQualifiedErrorId)" -notmatch 'NoMatchingEventsFound' })
  if ($bad.Count) { throw "cannot read $($logName): $($bad[0].Exception.Message)" }
  $ev
}
function Newest6([string]$mp) { Events $Log 6 20 { (MountPoints $_) -contains $mp } | Select-Object -First 1 }
function TaskStatus([string]$tn) {
  # A service stop deletes the volume task, so 'missing' is an answer here, not an error (w6597 forced test).
  $x = Native $schtasks @('/query', '/tn', $tn, '/fo', 'csv', '/nh')
  # Only "cannot find" is missing; a refusal (access denied as LOCAL SERVICE) is unreadable, never taken as healthy (w6623 H2).
  if ($x.code -ne 0) { if ($x.out -match 'cannot find') { return 'missing' }; return "unreadable ($($x.out))" }
  $f = ($x.out -split '","')
  return $f[-1].Trim('"')
}
function ServiceState {
  $o = (Native $sc @('query', $Service)).out
  if ($o -match 'STATE\s+:\s+\d+\s+(\w+)') { return $Matches[1] }
  return "unknown ($($o -replace '\s+', ' '))"
}
function WaitService([string]$want, [int]$sec) {
  for ($i = 0; $i -lt $sec; $i += 2) { if ((ServiceState) -eq $want) { return $true }; Start-Sleep -Seconds 2 }
  return ((ServiceState) -eq $want)
}

try {
  # Who this runs as, measured each run: the groups that are enabled and the privileges the token holds.
  try {
    $g = & $whoami /groups /fo csv | ConvertFrom-Csv | Where-Object { $_.Attributes -match 'Enabled group' } | ForEach-Object { "$($_.'Group Name') ($($_.SID))" }
    $p = & $whoami /priv /fo csv | ConvertFrom-Csv | ForEach-Object { "$($_.'Privilege Name') $($_.State)" }
    $r.whoami = "user $(& $whoami); groups: $($g -join ', '); privileges: $($p -join ', ')"
  } catch { $r.whoami = "whoami failed: $($_.Exception.Message)" }

  $mp = "$($Letter):\"
  $vp = (Native $mountvol @($mp, '/L')).out
  $guid = [regex]::Match($vp, '\{[0-9a-fA-F-]+\}').Value
  if (-not $guid) { $r.state = "no volume at $mp"; Save }
  $tn = "\Microsoft\Windows\ReFsDedupSvc\$($guid.ToUpper())"
  $started = Events $Log 3 60 { (MountPoints $_) -contains $mp }
  if (-not $started.Count -and $Mode -ne 'force') { $r.state = "ReFS dedup has run no job on $mp (nothing to repair)"; Save }
  $lastStart = if ($started.Count) { $started[0].TimeCreated } else { [datetime]::MaxValue }
  $ev6 = Newest6 $mp
  $dm = Events 'Microsoft-Windows-ReFS/Operational' 303 200 { $_.Message -match [regex]::Escape($guid) } | Select-Object -First 1
  $end = Events $Log 4, 13 60 { (MountPoints $_) -contains $mp } | Select-Object -First 1
  $task = TaskStatus $tn

  if ($dm -and (-not $ev6 -or $ev6.TimeCreated -lt $dm.TimeCreated)) {
    $r.reasons += "not watched: no 'started monitoring' (event 6) for $mp since its dismount at $($dm.TimeCreated.ToUniversalTime().ToString('s'))Z"
  }
  if ($end -and $end.Id -eq 13 -and (-not $ev6 -or $ev6.TimeCreated -lt $end.TimeCreated)) {
    $code = [regex]::Match($end.Message, '"StatusCode":\s*(-?\d+)').Groups[1].Value
    if ("$code" -eq "$NotReady") { $r.reasons += "last job failed at $($end.TimeCreated.ToUniversalTime().ToString('s'))Z with 0x80070015 (device not ready)" }
  }
  if ($task -eq 'Running' -and $lastStart -lt (Get-Date).AddHours(-$StuckHours)) {
    $r.reasons += "stuck: $tn Running, last job start $($lastStart.ToUniversalTime().ToString('s'))Z"
  }
  if ($Mode -eq 'force') { $r.reasons += "forced test (-Mode force): repair whatever the state (task $task, service $(ServiceState))" }
  if (-not $r.reasons.Count -and $task -like 'unreadable*') { $r.ok = $false; $r.state = "healthy by the event logs, but the volume task's state is $task, so a stuck task cannot be seen"; Save }
  if (-not $r.reasons.Count) { $r.state = "healthy (service $(ServiceState), task $task)"; Save }
  if ($Mode -eq 'check') { $r.state = 'broken (check only: nothing changed)'; $r.ok = $false; Save }

  # The repair. Once the service is stopped it is started again whatever happens next (finally).
  $t0 = Get-Date
  try {
    if ((ServiceState) -ne 'STOPPED') {
      $x = Native $sc @('stop', $Service)
      $r.did += "sc stop $Service (exit $($x.code)$(if ($x.code) { ": $($x.out)" }))"
      if (-not (WaitService 'STOPPED' 60)) { $r.did += "still $(ServiceState) after 60 s" }
    }
    if ($FailAfterStop) { throw 'test fault right after the stop (-FailAfterStop)' }
    $ts = TaskStatus $tn
    if ($ts -eq 'Running' -or $ts -like 'unreadable*') {
      $x = Native $schtasks @('/end', '/tn', $tn)
      $r.did += "schtasks /end $tn (exit $($x.code)$(if ($x.code) { ": $($x.out)" }))"
    } elseif ($ts -eq 'missing') {
      $r.did += 'volume task gone after the stop (expected: the service makes it again when it starts)'
    }
  } finally {
    $x = Native $sc @('start', $Service)
    $r.did += "sc start $Service (exit $($x.code)$(if ($x.code) { ": $($x.out)" }))"
    [void](WaitService 'RUNNING' 60)
    $r.did += "service $(ServiceState)"
  }
  $seen = $null
  for ($i = 0; $i -lt 60 -and -not $seen; $i++) {
    $n = Newest6 $mp
    if ($n -and $n.TimeCreated -ge $t0) { $seen = $n } else { Start-Sleep -Seconds 2 }
  }
  $task = TaskStatus $tn
  if ($seen -and $task -ne 'Running' -and $task -notlike 'unreadable*') {
    $r.state = "repaired: the service watches $mp again (event 6 at $($seen.TimeCreated.ToUniversalTime().ToString('s'))Z), task $task"
  } else {
    $r.ok = $false
    $r.state = "repair did not finish: event 6 $(if ($seen) { 'seen' } else { 'not seen within 120 s' }), service $(ServiceState), task $task"
  }
  Save
} catch {
  $r.ok = $false
  $r.state = 'check failed'
  $r.detail = $_.Exception.Message
  Save
}
