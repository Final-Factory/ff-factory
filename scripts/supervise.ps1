# Keeps the FF Factory server running: starts node, and restarts it whenever it exits
# (crash, or a deliberate restart). One supervisor per machine; its pid is in data\supervisor.pid.
# Started hidden in the desktop session by start-server.ps1 (the ffsb-server task) or restart.ps1.
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $AppRoot
New-Item -ItemType Directory -Force data | Out-Null
$log = Join-Path $DataDir 'supervisor.log'

# Never supervise elevated: node, every agent shell and every Unity editor would inherit admin rights
# (and an elevated editor stops on Unity's administrator dialog). Hand off to the Limited task, which
# starts a fresh supervisor, unless restart.ps1 already tried that and fell back to us.
if ((Test-Elevated) -and !$env:FFSB_NO_DEELEVATE -and (Get-LimitedTask)) {
  Write-AppLog "supervisor started elevated (pid $PID); handing off to the Limited $TaskName task" | Out-Null
  schtasks.exe /run /tn $TaskName | Out-Null
  if ($LASTEXITCODE -eq 0) { exit 0 }
  Write-AppLog "schtasks /run /tn $TaskName failed (exit $LASTEXITCODE); supervising elevated, so the server will refuse to start Unity" | Out-Null
  $env:FFSB_NO_DEELEVATE = '1'
}

$PID | Out-File (Join-Path $DataDir 'supervisor.pid') -Encoding ascii
# At boot the sandbox Dev Drive is attached by a startup task; don't start the server before it exists.
try {
  $sbRoot = (Get-Content (Join-Path $AppRoot 'config.json') -Raw | ConvertFrom-Json).sandboxRoot
  $drive = Split-Path -Qualifier $sbRoot
  for ($i = 0; $i -lt 150 -and !(Test-Path "$drive\"); $i++) { Start-Sleep 2 }
  if (!(Test-Path "$drive\")) { "$(Get-Date -Format s) WARNING: $drive not available after 5 min; starting anyway" | Out-File $log -Append }
} catch { }

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
  # Back off when it keeps dying quickly (a crash loop), reset after a healthy run.
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 3 } else { $delay = [Math]::Min($delay * 2, 300) }
  if (Test-Path $updateFlag) { $delay = 3 }
  "$(Get-Date -Format s) server exited with code $($proc.ExitCode); restarting in $($delay)s" | Out-File $log -Append
  Start-Sleep $delay
}
