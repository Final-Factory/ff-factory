# w906 probe only: every process start and stop on the runner, with its exit status, until the stop file appears.
param([string]$Out, [string]$StopFile)
Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStartTrace' -SourceIdentifier pstart | Out-Null
Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStopTrace' -SourceIdentifier pstop | Out-Null
while (-not (Test-Path $StopFile)) {
  $e = Wait-Event -Timeout 1
  if (-not $e) { continue }
  $i = $e.SourceEventArgs.NewEvent
  $t = (Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff')
  if ($e.SourceIdentifier -eq 'pstart') { Add-Content -LiteralPath $Out "$t START pid=$($i.ProcessID) ppid=$($i.ParentProcessID) $($i.ProcessName)" }
  else { Add-Content -LiteralPath $Out ("$t STOP pid=$($i.ProcessID) ppid=$($i.ParentProcessID) exit=0x{0:X8} $($i.ProcessName)" -f [uint32]$i.ExitStatus) }
  Remove-Event -EventIdentifier $e.EventIdentifier
}
