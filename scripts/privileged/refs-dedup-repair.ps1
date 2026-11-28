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
#
# <ResultDir>\dedup-repair.json: { action, mode, ok, at, state, reasons, did, detail, whoami }; one line per run in
# dedup-repair.log beside it. ok is false only when the drive was broken and is still broken (or the check failed).
param(
  [string]$Letter = 'V',
  [Parameter(Mandatory)][string]$ResultDir,
  [ValidateSet('repair', 'check')][string]$Mode = 'repair',
  # A volume task Running this long after the last job start is stuck: the daily job caps itself at 2 h.
  [int]$StuckHours = 3,
  # Tests only: judge the logs as they stood at this time (implies -Mode check; the task state is read as it is now).
  [datetime]$AsOf = [datetime]::MinValue
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
  $o = & $schtasks /query /tn $tn /fo csv /nh 2>&1
  # Only "cannot find" is missing; a refusal (access denied as LOCAL SERVICE) is unreadable, never taken as healthy (w6623 H2).
  if ($LASTEXITCODE -ne 0) { if ("$o" -match 'cannot find') { return 'missing' }; return "unreadable ($("$o".Trim()))" }
  $f = ("$($o | Select-Object -Last 1)" -split '","')
  return $f[-1].Trim('"')
}
function ServiceState {
  $o = (& $sc query $Service) -join ' '
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
  $vp = "$(& $mountvol $mp /L 2>$null)".Trim()
  $guid = [regex]::Match($vp, '\{[0-9a-fA-F-]+\}').Value
  if (-not $guid) { $r.state = "no volume at $mp"; Save }
  $tn = "\Microsoft\Windows\ReFsDedupSvc\$($guid.ToUpper())"
  $started = Events $Log 3 60 { (MountPoints $_) -contains $mp }
  if (-not $started.Count) { $r.state = "ReFS dedup has run no job on $mp (nothing to repair)"; Save }
  $lastStart = $started[0].TimeCreated
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
  if (-not $r.reasons.Count -and $task -like 'unreadable*') { $r.ok = $false; $r.state = "healthy by the event logs, but the volume task's state is $task, so a stuck task cannot be seen"; Save }
  if (-not $r.reasons.Count) { $r.state = "healthy (service $(ServiceState), task $task)"; Save }
  if ($Mode -eq 'check') { $r.state = 'broken (check only: nothing changed)'; $r.ok = $false; Save }

  # The repair.
  $t0 = Get-Date
  if ((ServiceState) -ne 'STOPPED') {
    $o = & $sc stop $Service 2>&1
    $r.did += "sc stop $Service (exit $LASTEXITCODE)"
    if (-not (WaitService 'STOPPED' 60)) { $r.did += "still $(ServiceState) after 60 s" }
  }
  $ts = TaskStatus $tn
  if ($ts -eq 'Running' -or $ts -like 'unreadable*') {
    $o = & $schtasks /end /tn $tn 2>&1
    $r.did += "schtasks /end $tn (exit $LASTEXITCODE$(if ($LASTEXITCODE) { ": $("$o".Trim())" }))"
  }
  $o = & $sc start $Service 2>&1
  $r.did += "sc start $Service (exit $LASTEXITCODE)"
  [void](WaitService 'RUNNING' 60)
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
