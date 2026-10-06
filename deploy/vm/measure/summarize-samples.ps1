# Summarises a (possibly still running) measure-portal.ps1 output folder from its samples.csv and host.csv, for a
# partial report before the run ends. Read-only; prints to stdout.
#   powershell -NoProfile -File summarize-samples.ps1 -Dir <folder with samples.csv and host.csv>
param([Parameter(Mandatory)][string]$Dir)
function Median($xs) { $s = @($xs | Sort-Object); if (!$s.Count) { return 0 }; return $s[[int][math]::Floor(($s.Count - 1) / 2)] }
function Pct($xs, $q) { $s = @($xs | Sort-Object); if (!$s.Count) { return 0 }; return $s[[int][math]::Floor(($s.Count - 1) * $q)] }
function Max($xs) { $m = 0; foreach ($x in $xs) { if ($x -gt $m) { $m = $x } }; return $m }
$rows = Import-Csv (Join-Path $Dir 'samples.csv')
$times = @($rows | ForEach-Object { $_.time } | Sort-Object -Unique)
$prev = @{}   # pid/name -> cpu_s, io bytes
$per = @{}    # time -> role -> @{ ws; priv; cpu; io; tops }
$prevT = $null
foreach ($g in ($rows | Group-Object time | Sort-Object Name)) {
  $t = [datetime]$g.Name; $secs = if ($prevT) { ($t - $prevT).TotalSeconds } else { 0 }
  $s = @{}
  foreach ($r in $g.Group) {
    if (!$s.ContainsKey($r.role)) { $s[$r.role] = @{ ws = 0.0; priv = 0.0; cpu = 0.0; io = 0.0; tops = @{} } }
    $x = $s[$r.role]; $x.ws += [double]$r.ws_mb; $x.priv += [double]$r.private_mb; $x.tops[$r.top_pid] = 1
    $k = "$($r.pid)/$($r.name)"; $cpu = [double]$r.cpu_s; $io = [double]$r.io_read_b + [double]$r.io_write_b + [double]$r.io_other_b
    if ($prev.ContainsKey($k) -and $secs -gt 0) { $x.cpu += 100 * [math]::Max(0, $cpu - $prev[$k].cpu) / $secs; $x.io += [math]::Max(0, $io - $prev[$k].io) }
    $prev[$k] = @{ cpu = $cpu; io = $io }
  }
  if ($prevT) { $per[$g.Name] = $s }
  $prevT = $t
}
$days = ([datetime]$times[-1] - [datetime]$times[0]).TotalDays
"{0} samples from {1} to {2} ({3:N1} h); memory MB summed per role (processes and their tools); CPU % of one core; n = processes of the role at once" -f $per.Count, $times[0], $times[-1], ($days * 24)
'{0,-50} {1,8} {2,8} {3,8} {4,9} {5,9} {6,8} {7,8} {8,8} {9,6} {10,6} {11,10}' -f 'role', 'WS med', 'WS p95', 'WS max', 'priv med', 'priv max', 'CPU avg', 'CPU p95', 'CPU max', 'n med', 'n max', 'IO GB/day'
$roles = $per.Values | ForEach-Object { $_.Keys } | Sort-Object -Unique
$tot = @{ ws = @(); priv = @(); cpu = @() }
foreach ($s in $per.Values) { $tot.ws += ($s.Values | ForEach-Object { $_.ws } | Measure-Object -Sum).Sum; $tot.priv += ($s.Values | ForEach-Object { $_.priv } | Measure-Object -Sum).Sum; $tot.cpu += ($s.Values | ForEach-Object { $_.cpu } | Measure-Object -Sum).Sum }
foreach ($role in $roles) {
  $v = @($per.Values | ForEach-Object { if ($_.ContainsKey($role)) { $_[$role] } else { @{ ws = 0; priv = 0; cpu = 0; io = 0; tops = @{} } } })
  $ws = $v | ForEach-Object { $_.ws }; $pr = $v | ForEach-Object { $_.priv }; $cp = $v | ForEach-Object { $_.cpu }; $n = $v | ForEach-Object { $_.tops.Count }
  '{0,-50} {1,8:N0} {2,8:N0} {3,8:N0} {4,9:N0} {5,9:N0} {6,8:N1} {7,8:N1} {8,8:N1} {9,6} {10,6} {11,10:N2}' -f $role, (Median $ws), (Pct $ws 0.95), (Max $ws), (Median $pr), (Max $pr), (($cp | Measure-Object -Average).Average), (Pct $cp 0.95), (Max $cp), (Median $n), (Max $n), ((($v | ForEach-Object { $_.io }) | Measure-Object -Sum).Sum / 1GB / $days)
}
'{0,-50} {1,8:N0} {2,8:N0} {3,8:N0} {4,9:N0} {5,9:N0} {6,8:N1} {7,8:N1} {8,8:N1}' -f 'ALL', (Median $tot.ws), (Pct $tot.ws 0.95), (Max $tot.ws), (Median $tot.priv), (Max $tot.priv), (($tot.cpu | Measure-Object -Average).Average), (Pct $tot.cpu 0.95), (Max $tot.cpu)
$claudeTops = $rows | Where-Object { $_.name -eq 'claude.exe' -and $_.pid -eq $_.top_pid }
$perClaude = $claudeTops | Group-Object time | ForEach-Object { $_.Count }
"claude processes under the portal at once: median {0}, max {1}; one claude.exe's own working set: median {2:N0} MB, max {3:N0} MB" -f (Median $perClaude), (Max $perClaude), (Median ($claudeTops | ForEach-Object { [double]$_.ws_mb })), (Max ($claudeTops | ForEach-Object { [double]$_.ws_mb }))
"distinct claude sessions seen: {0}" -f @($claudeTops | Where-Object session | ForEach-Object { $_.session } | Sort-Object -Unique).Count
$h = @(Import-Csv (Join-Path $Dir 'host.csv'))
if ($h.Count -gt 1) {
  $hd = ([datetime]$h[-1].time - [datetime]$h[0].time).TotalDays; $rx = 0.0; $tx = 0.0
  for ($i = 1; $i -lt $h.Count; $i++) { $rx += [math]::Max(0, [double]$h[$i].nic_rx_b - [double]$h[$i - 1].nic_rx_b); $tx += [math]::Max(0, [double]$h[$i].nic_tx_b - [double]$h[$i - 1].nic_tx_b) }
  "host network adapters (the whole host, not only the portal): received {0:N2} GB/day, sent {1:N2} GB/day" -f ($rx / 1GB / $hd), ($tx / 1GB / $hd)
  "this script: working set median {0:N0} MB, CPU {1:N2}% of one core, sample median {2:N0} ms" -f (Median ($h | ForEach-Object { [double]$_.self_ws_mb })), (100 * ([double]$h[-1].self_cpu_s - [double]$h[0].self_cpu_s) / ($hd * 86400)), (Median ($h | ForEach-Object { [double]$_.sample_ms }))
  "server pids seen: {0}" -f ((@($h | ForEach-Object { $_.server_pid } | Select-Object -Unique)) -join ' -> ')
}
