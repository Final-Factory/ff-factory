# Restart FF Factory (optionally updating it first) from any shell: admin or not, desktop or SSH.
#   .\restart.ps1                  drain busy agents (up to 10 min), restart, resume them
#   .\restart.ps1 -Update          same, and pull + npm ci + rebuild the web UI before starting again
#   .\restart.ps1 -NoDrain         restart at once; agents cut off mid-turn are still resumed afterwards
#   .\restart.ps1 -DrainMinutes 3
# Or double-click restart.cmd. See docs/restart.md.
#
# The app always comes back NON-elevated: it is started through the Limited "ffsb-server" task
# (scripts/install-autostart.ps1), never from this shell, so it cannot inherit admin rights. Unity
# editors inherit the server's token, and an elevated editor stops on Unity's administrator dialog.
# Safe to run twice: a second run while one is in progress exits; a run with nothing running starts it.
param(
  [switch]$Update,
  [switch]$NoDrain,
  [int]$DrainMinutes = 10,
  [string]$Reason = '',
  # Internal: an elevated server that is handing itself off (server/elevation.ts). It exits by itself
  # once the supervisor is gone; there is nothing to drain.
  [int]$ExitingServerPid = 0
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $AppRoot
New-Item -ItemType Directory -Force $DataDir | Out-Null
if (!$Reason) { $Reason = if ($Update) { 'update (restart.ps1 -Update)' } else { 'restart (restart.ps1)' } }

# One restart at a time. The lock holds "<pid> <start ticks>", so a reused pid does not count.
$lock = Join-Path $DataDir 'restart.lock'
$me = "$PID $((Get-Process -Id $PID).StartTime.Ticks)"
if (Test-Path $lock) {
  $held = "$(Get-Content $lock -Raw)".Trim() -split ' '
  $p = if ($held.Count -eq 2) { Get-Process -Id ([int]$held[0]) -ErrorAction SilentlyContinue }
  if ($p -and "$($p.StartTime.Ticks)" -eq $held[1] -and [int]$held[0] -ne $PID) {
    "A restart is already in progress (pid $($held[0])); see data\supervisor.log. Not starting another."
    exit 0
  }
}
[IO.File]::WriteAllText($lock, $me)

try {
  $elevated = Test-Elevated
  $task = Get-LimitedTask
  Write-AppLog "restart.ps1: $Reason (this shell elevated: $elevated; Limited $TaskName task: $([bool]$task))"
  $sup = Get-Supervisor
  $srv = Get-Server

  if (!$elevated -and ($sup.State -eq 'unreadable' -or $srv.State -eq 'unreadable')) {
    $what = @(if ($sup.State -eq 'unreadable') { "supervisor pid $($sup.Id)" }; if ($srv.State -eq 'unreadable') { "server pid $($srv.Id)" }) -join ', '
    throw ("FF Factory is running ELEVATED ($what) and this shell is not, so it cannot stop it. " +
      "Run this once from an elevated shell instead: right-click scripts\restart.cmd > Run as administrator. " +
      "It stops the elevated app and brings it back non-elevated through the $TaskName task. " +
      "(Or, from the dashboard, ask the orchestrator to run request_app_update: the updated server hands itself to the task.)")
  }

  # 1. Drain, while the supervisor still runs: if this script is interrupted, the app keeps working
  #    (the server gives up waiting after a few minutes and carries on).
  if ($srv.State -eq 'ours' -and $ExitingServerPid -eq 0) {
    $drainMode = if ($NoDrain) { $false } else { 'auto' }
    $req = @{ drain = $drainMode; drainMinutes = $DrainMinutes; reason = $Reason; update = [bool]$Update; hold = $true } | ConvertTo-Json -Compress
    $done = Join-Path $DataDir 'drain.done'
    Remove-Item -Force $done -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText((Join-Path $DataDir 'restart.request'), $req)
    if (!$NoDrain) { "Asking busy agents to commit, push and end their turn (up to $DrainMinutes min)..." }
    $deadline = (Get-Date).AddMinutes($DrainMinutes).AddSeconds(90)
    $shown = Get-Date
    while (!(Test-Path $done) -and (Get-Process -Id $srv.Id -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
      Start-Sleep 2
      if (((Get-Date) - $shown).TotalSeconds -ge 30) { "  still waiting for agents to finish their turn..."; $shown = Get-Date }
    }
    if (Test-Path $done) { Write-AppLog 'drain done' } else { Write-AppLog 'no drain confirmation (older server, or it timed out); stopping anyway' }
    Remove-Item -Force $done -ErrorAction SilentlyContinue
  }

  # 2. Stop the supervisor, so it does not restart the server behind us (possibly elevated).
  $sup = Get-Supervisor
  if ($sup.State -ne 'none') {
    Stop-Process -Id $sup.Id -Force
    Write-AppLog "stopped supervisor pid $($sup.Id)"
  }
  Remove-Item -Force (Join-Path $DataDir 'supervisor.pid') -ErrorAction SilentlyContinue

  # 3. Stop the server; it records which sessions to resume on the way out.
  if ($ExitingServerPid) {
    if (!(Wait-Exit $ExitingServerPid 60)) { Stop-Process -Id $ExitingServerPid -Force -ErrorAction SilentlyContinue }
  }
  $srv = Get-Server
  if ($srv.State -ne 'none') {
    Stop-AppServer $srv 60
    Write-AppLog "stopped server pid $($srv.Id)"
  }

  # 4. The next supervisor updates before it starts the server.
  if ($Update) { [IO.File]::WriteAllText((Join-Path $DataDir 'update.request'), (Get-Date -Format o)) }

  # 5. Start again, non-elevated.
  $prevSup = if (Test-Path (Join-Path $DataDir 'supervisor.pid')) { Get-Content (Join-Path $DataDir 'supervisor.pid') -Raw } else { '' }
  $env:FFSB_NO_DEELEVATE = $null
  $started = $false
  if ($task) {
    schtasks.exe /run /tn $TaskName | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-AppLog "schtasks /run /tn $TaskName failed (exit $LASTEXITCODE)" }
    else {
      Write-AppLog "started the $TaskName task"
      for ($i = 0; $i -lt 60 -and !$started; $i++) {
        Start-Sleep 1
        $s = Get-Supervisor
        $started = $s.State -eq 'ours' -and "$($s.Id)" -ne "$prevSup".Trim()
      }
      if (!$started) { Write-AppLog "the $TaskName task did not start a supervisor within 60 s" }
    }
  } else {
    Write-AppLog "WARNING: no Limited $TaskName task. Run scripts\install-autostart.ps1 once so the app is always started non-elevated in the desktop session."
  }
  if (!$started) {
    if ($elevated) {
      # Better an app that runs (and refuses to start Unity, with a banner) than none. The flag keeps
      # the server from trying to hand itself to a task that just failed.
      $env:FFSB_NO_DEELEVATE = '1'
      Write-AppLog 'WARNING: starting the supervisor from this ELEVATED shell; the server will refuse to start Unity editors until it is restarted non-elevated'
    }
    Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'supervise.ps1')
    Write-AppLog 'started the supervisor directly'
  }

  # 6. Report when it is up.
  $wait = if ($Update) { 20 } else { 3 }
  "Waiting for the server (up to $wait min$(if ($Update) { ', the update runs first' }))..."
  $until = (Get-Date).AddMinutes($wait)
  $srv = $null
  while ((Get-Date) -lt $until) {
    Start-Sleep 3
    $s = Get-Server
    if ($s.State -ne 'none') { $srv = $s; break }
  }
  if ($srv) {
    Write-AppLog "restart.ps1: server is up (pid $($srv.Id))"
    "FF Factory is back (server pid $($srv.Id)). Interrupted agents are resumed automatically; the orchestrator gets a summary."
  } else {
    Write-AppLog 'restart.ps1: the server did not come up in time'
    "The server did not come up within $wait min. Last lines of data\supervisor.log and data\server.err.log:"
    Get-Content (Join-Path $DataDir 'supervisor.log') -Tail 15 -ErrorAction SilentlyContinue
    Get-Content (Join-Path $DataDir 'server.err.log') -Tail 15 -ErrorAction SilentlyContinue
    exit 1
  }
} catch {
  Write-AppLog "restart.ps1 FAILED: $($_.Exception.Message)" | Out-Null
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  Remove-Item -Force $lock -ErrorAction SilentlyContinue
}
