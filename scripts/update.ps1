# Pull, install exactly what the lock files say, rebuild the web UI, restart: restart.ps1 -Update.
# Kept for muscle memory; takes the same options (-NoDrain, -DrainMinutes). Without the user at the desktop,
# the orchestrator's request_app_update tool does the same through the supervisor.
& (Join-Path $PSScriptRoot 'restart.ps1') -Update @args
exit $LASTEXITCODE
