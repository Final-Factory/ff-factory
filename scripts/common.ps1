# Shared by the app's scripts; dot-source it: . (Join-Path $PSScriptRoot 'common.ps1')
$AppRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $AppRoot 'data'
# The logon task scripts/install-autostart.ps1 registers. It runs at RunLevel Limited in the desktop
# session, so whatever it starts is never elevated and its Unity editors get the GPU.
# FFSB_TASK_NAME overrides it for tests, so a test instance can never start the real app.
$TaskName = if ($env:FFSB_TASK_NAME) { $env:FFSB_TASK_NAME } else { 'ffsb-server' }

function Write-AppLog([string]$Line) {
  # Same encoding as the supervisor's own lines (Out-File's default), so the log stays readable.
  "$(Get-Date -Format s) $Line" | Out-File (Join-Path $DataDir 'supervisor.log') -Append
  $Line
}

# Elevated as Unity sees it: an enabled Administrators group, or a high/system integrity token.
function Test-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return $true }
  return [bool](whoami.exe /groups | Select-String -Quiet 'S-1-16-(12288|16384)\b')
}

# The ffsb-server task, only if it exists and runs at RunLevel Limited (a task at Highest would start
# the app elevated again, and handing off to it would loop).
function Get-LimitedTask {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t -and [string]$t.Principal.RunLevel -eq 'Limited') { return $t }
  return $null
}

# The process a pid file names, and whether it is ours:
#   State 'ours'       its command line matches $Pattern
#   State 'unreadable' alive, a powershell/node process, but its command line cannot be read: from a
#                      non-elevated shell that is what an ELEVATED supervisor or server looks like
#   State 'none'       no pid file, gone, or the pid now belongs to something else (pids are reused)
function Get-OurProcess([string]$PidFile, [string]$Pattern) {
  $none = [pscustomobject]@{ State = 'none'; Id = 0 }
  if (!(Test-Path $PidFile)) { return $none }
  $id = 0
  if (![int]::TryParse(((Get-Content $PidFile -Raw) -as [string]).Trim(), [ref]$id) -or $id -le 0) { return $none }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if (!$p) { return $none }
  if ($p.CommandLine -like $Pattern) { return [pscustomobject]@{ State = 'ours'; Id = $id } }
  if ([string]::IsNullOrEmpty($p.CommandLine) -and $p.Name -in 'powershell.exe', 'pwsh.exe', 'node.exe') {
    return [pscustomobject]@{ State = 'unreadable'; Id = $id }
  }
  return $none
}

function Get-Supervisor { Get-OurProcess (Join-Path $DataDir 'supervisor.pid') '*supervise.ps1*' }
function Get-Server { Get-OurProcess (Join-Path $DataDir 'server.pid') '*server/index.ts*' }

function Wait-Exit([int]$Id, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds -and (Get-Process -Id $Id -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
  return !(Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

# Ask the server to stop the way the app itself does: it polls data\restart.request, records which
# sessions to resume, stops its agent processes, saves state and exits. Force only as a last resort.
function Stop-AppServer($Srv, [int]$Seconds = 60) {
  if ($Srv.State -eq 'none') { return }
  $flag = Join-Path $DataDir 'restart.request'
  [IO.File]::WriteAllText($flag, '')
  if (!(Wait-Exit $Srv.Id $Seconds)) {
    Write-AppLog "server pid $($Srv.Id) did not stop within $Seconds s; killing it"
    Stop-Process -Id $Srv.Id -Force -ErrorAction SilentlyContinue
    [void](Wait-Exit $Srv.Id 10)
  }
  Remove-Item -Force $flag -ErrorAction SilentlyContinue
}
