# Start or restart the FF Factory server in the CURRENT desktop session. This is what the ffsb-server
# logon task runs (RunLevel Limited). By hand, use restart.ps1 (or restart.cmd) instead: it drains busy
# agents first, resumes them afterwards, and works from any shell.
# - No supervisor running: launch supervise.ps1 hidden (it starts node and keeps it up).
# - Supervisor running: stop node; the supervisor starts it again with the current code.
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $AppRoot
New-Item -ItemType Directory -Force data | Out-Null

# Run from an elevated shell, everything started here would be elevated too; go through the task.
if ((Test-Elevated) -and !$env:FFSB_NO_DEELEVATE) {
  & (Join-Path $PSScriptRoot 'restart.ps1') -NoDrain -Reason 'start-server.ps1 was run from an elevated shell'
  exit $LASTEXITCODE
}

$sup = Get-Supervisor
$srv = Get-Server
if ($sup.State -eq 'unreadable' -or $srv.State -eq 'unreadable') {
  'An ELEVATED FF Factory is running and this shell cannot stop it. Run scripts\restart.cmd once as administrator; it brings the app back non-elevated.'
  exit 1
}
if ($sup.State -eq 'ours') {
  Stop-AppServer $srv 30
  "restarting server under supervisor pid $($sup.Id)"
} else {
  Stop-AppServer $srv 30
  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'supervise.ps1')
  'started supervisor'
}
