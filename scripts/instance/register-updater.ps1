# Registers ff-instances-update (w14, docs/instances.md): every 5 minutes, as this user and not elevated, it rolls the
# computer's instances to the commit the lead portal verified. Run it once from the updater's own checkout:
#   powershell -NoProfile -File scripts\instance\register-updater.ps1 -List F:\ffw\instances\instances.json -Node F:\ffw\tools\node\node.exe
# Undo: Unregister-ScheduledTask -TaskName ff-instances-update -Confirm:$false
param(
  [Parameter(Mandatory = $true)][string]$List,
  [string]$Node = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$TaskName = 'ff-instances-update',
  [int]$EveryMinutes = 5
)
$ErrorActionPreference = 'Stop'
$app = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $app 'scripts\instance\update-all.ts'
if (-not (Test-Path $List)) { throw "no list at $List (example: scripts\instance\instances.example.json)" }
if (-not (Test-Path $Node)) { throw "no node at $Node" }
# conhost --headless: no console window on the desktop. A roll drains each instance for up to 30 minutes, so a pass may
# run for hours; IgnoreNew keeps the next 5-minute start from overlapping it (the script's lock file does too).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$Node`" `"$script`" --list `"$List`"" -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# The plain user name: over ssh $env:USERDOMAIN reads WORKGROUP (docs/project.md, w4038).
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Rolls this computer's FF Factory instances to the lead portal's verified commit (w14). List: $List" -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
