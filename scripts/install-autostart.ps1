# Register "ffsb-server": start the server (via the supervisor) whenever this user logs on.
# Runs only in the interactive session, which Unity needs for the GPU. Re-run to update.
$script = Join-Path $PSScriptRoot 'start-server.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'ffsb-server' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
"registered ffsb-server (at logon of $env:USERNAME)"
