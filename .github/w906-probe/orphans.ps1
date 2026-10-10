# w906 probe only: live processes whose parent is gone (a stale ParentProcessId a kill-by-parent walk could match), and the runner's ancestry.
$all = @(Get-CimInstance Win32_Process)
$ids = @{}; foreach ($p in $all) { $ids[[int]$p.ProcessId] = $p }
foreach ($p in $all) { if (-not $ids.ContainsKey([int]$p.ParentProcessId)) { "orphan pid=$($p.ProcessId) deadparent=$($p.ParentProcessId) $($p.Name)" } }
$cur = $ids[[int]$PID]
while ($cur) { "ancestor pid=$($cur.ProcessId) ppid=$($cur.ParentProcessId) $($cur.Name)"; $cur = $ids[[int]$cur.ParentProcessId] }
