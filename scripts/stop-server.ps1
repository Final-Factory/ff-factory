# Stop the supervisor (so it does not restart node) and then the server, gracefully. The server
# records which agent sessions were busy; the next start resumes them (docs/restart.md).
. (Join-Path $PSScriptRoot 'common.ps1')
$sup = Get-Supervisor
$srv = Get-Server
if (!(Test-Elevated) -and ($sup.State -eq 'unreadable' -or $srv.State -eq 'unreadable')) {
  'An ELEVATED FF Factory is running and this shell cannot stop it. Run this from an elevated shell (or scripts\restart.cmd as administrator).'
  exit 1
}
if ($sup.State -ne 'none') { Stop-Process -Id $sup.Id -Force }
Stop-AppServer $srv 30
'stopped'
