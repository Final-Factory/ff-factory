# Keeps the FF Factory server running: starts node, and restarts it whenever it exits
# (crash, or a deliberate restart). One supervisor per machine; its pid is in data\supervisor.pid.
# Started hidden in the desktop session by start-server.ps1 (the ffsb-server task) or restart.ps1.
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $AppRoot
New-Item -ItemType Directory -Force data | Out-Null
$log = Join-Path $DataDir 'supervisor.log'

# Never supervise elevated: node and every orchestrator shell would inherit admin rights. Hand off to the
# Limited task, which starts a fresh supervisor, unless restart.ps1 already tried that and fell back to us.
# (The sandbox drive is no concern here since w510: the portal holds no sandboxes, and BEAST's own daemon's guard
# attaches its Dev Drive.)
if ((Test-Elevated) -and !$env:FFSB_NO_DEELEVATE -and (Get-LimitedTask)) {
  Write-AppLog "supervisor started elevated (pid $PID); handing off to the Limited $TaskName task" | Out-Null
  schtasks.exe /run /tn $TaskName | Out-Null
  if ($LASTEXITCODE -eq 0) { exit 0 }
  Write-AppLog "schtasks /run /tn $TaskName failed (exit $LASTEXITCODE); supervising elevated" | Out-Null
  $env:FFSB_NO_DEELEVATE = '1'
}

$PID | Out-File (Join-Path $DataDir 'supervisor.pid') -Encoding ascii
# request_app_update and restart.ps1 -Update leave data\update.request; the update runs here, between
# server runs, because npm ci replaces the node_modules the server runs from. The result goes to
# data\update.result.json for the next server's restart summary.
$updateFlag = Join-Path $DataDir 'update.request'
function Invoke-Update {
  Remove-Item -Force $updateFlag
  $result = [ordered]@{ ok = $false; at = (Get-Date).ToUniversalTime().ToString('o'); headBefore = "$(git rev-parse HEAD)".Trim() }
  "$(Get-Date -Format s) update requested: running update-steps.ps1" | Out-File $log -Append
  try {
    & (Join-Path $PSScriptRoot 'update-steps.ps1') *>&1 | Out-File $log -Append
    $result.ok = $true
    "$(Get-Date -Format s) update done" | Out-File $log -Append
  } catch {
    $result.error = $_.Exception.Message
    "$(Get-Date -Format s) update FAILED: $($_.Exception.Message); starting whatever is on disk" | Out-File $log -Append
  }
  Set-Location $AppRoot
  $result.headAfter = "$(git rev-parse HEAD)".Trim()
  [IO.File]::WriteAllText((Join-Path $DataDir 'update.result.json'), ($result | ConvertTo-Json -Compress))
}

$delay = 3
while ($true) {
  if (Test-Path $updateFlag) { Invoke-Update; $delay = 3 }
  # Keep the previous run's output for post-mortems, and the first crash of a streak for good.
  foreach ($f in 'server.out.log', 'server.err.log') {
    $p = Join-Path $DataDir $f
    if (Test-Path $p) {
      if ($delay -eq 6 -and !(Test-Path "$p.firstcrash")) { Copy-Item $p "$p.firstcrash" }
      Move-Item -Force $p "$p.prev"
    }
  }
  $proc = Start-Process node -ArgumentList 'server/index.ts' -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $DataDir 'server.out.log') -RedirectStandardError (Join-Path $DataDir 'server.err.log')
  $null = $proc.Handle   # cache the handle so ExitCode is readable after exit
  $proc.Id | Out-File (Join-Path $DataDir 'server.pid') -Encoding ascii
  $started = Get-Date
  "$(Get-Date -Format s) started server pid $($proc.Id)" | Out-File $log -Append
  $proc.WaitForExit()
  # Back off when it keeps dying quickly (a crash loop), reset after a healthy run. At most a minute: a damaged data
  # file no longer stops the server (server/durable.ts starts it from the last good version), so what is left loops
  # on something that clears by itself (a port, a drive), and the portal is back within a minute of it clearing.
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 3 } else { $delay = [Math]::Min($delay * 2, 60) }
  if (Test-Path $updateFlag) { $delay = 3 }
  # The error that ended it, so a loop is readable in this log without opening server.err.log.
  $why = ''
  $errLog = Join-Path $DataDir 'server.err.log'
  if ($proc.ExitCode -ne 0 -and (Test-Path $errLog)) {
    $line = Get-Content $errLog -Tail 60 -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\w*(Error|Exception)\b|^\s*Error:' } | Select-Object -Last 1
    if ($line) { $why = "; last error: $($line.Trim())" }
  }
  "$(Get-Date -Format s) server exited with code $($proc.ExitCode)$why; restarting in $($delay)s" | Out-File $log -Append
  Start-Sleep $delay
}
