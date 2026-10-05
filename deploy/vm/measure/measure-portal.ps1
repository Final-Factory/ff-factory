# Measures the FF Factory portal's footprint on the Windows host it runs on today (BEAST), for sizing the portal VM
# (docs/portal-on-ffbox-host.md, "Sizing"). READ-ONLY: it lists processes, reads state.json and folder sizes, and writes
# only into -OutDir (default: a new folder under %TEMP%). It never stops, starts or changes anything, and prints no
# secret: from config.json it reads only dataDir, repo.basePath, standingRoot and sandboxRoot.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File measure-portal.ps1 -AppRoot C:\ff-sandboxes -Minutes 120
#
# What it reports (summary.txt; every sample in samples.csv):
#   - the portal's node process and every process under it, grouped by role: the dispatcher, each person's
#     orchestrator, standing agents, workers (if any still run under the portal), and their tools; working set and
#     private bytes (typical = median, peak = max over the samples), CPU (% of one core, mean and peak)
#   - how many claude processes of each role were alive at once (median and max)
#   - data/ in total and by folder, and what was written per day over the last -HistoryDays days (by file time)
#   - the base clone (.git, LFS objects, working tree) and the user's ~/.claude/projects folders for the base clone
#     and the standing agents
#   - the portal process's I/O bytes (all I/O, network included; an upper bound for its network)
param(
  [string]$AppRoot = 'C:\ff-sandboxes',
  [int]$Minutes = 60,
  [int]$IntervalSeconds = 30,
  [int]$HistoryDays = 14,
  [string]$OutDir = '',
  # For a test on another machine: measure this process tree instead of the one data\server.pid names.
  [int]$ServerPid = 0
)
$ErrorActionPreference = 'Stop'
if (!$OutDir) { $OutDir = Join-Path $env:TEMP ('fff-measure-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$summary = Join-Path $OutDir 'summary.txt'
function Say([string]$line) { $line; Add-Content -Path $summary -Value $line -Encoding UTF8 }

# ---------------------------------------------------------------- paths, from config.json (paths only)
$cfgFile = if ($env:FFSB_CONFIG) { $env:FFSB_CONFIG } else { Join-Path $AppRoot 'config.json' }
$cfg = $null
if (Test-Path $cfgFile) { $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json }
function Resolve-From([string]$base, [string]$p) { if (!$p) { return $null }; if ([IO.Path]::IsPathRooted($p)) { return $p }; return [IO.Path]::GetFullPath((Join-Path $base $p)) }
$dataDir = if ($cfg -and $cfg.dataDir) { Resolve-From $AppRoot $cfg.dataDir } else { Join-Path $AppRoot 'data' }
$basePath = if ($cfg -and $cfg.repo) { $cfg.repo.basePath } else { $null }
$sandboxRoot = if ($cfg) { $cfg.sandboxRoot } else { $null }
$standingRoot = if ($cfg -and $cfg.standingRoot) { $cfg.standingRoot } elseif ($sandboxRoot) { Join-Path $sandboxRoot '_agents' } else { $null }

Say "FF Factory portal footprint, measured on $env:COMPUTERNAME from $(Get-Date -Format 's') for $Minutes min every $IntervalSeconds s"
Say "app $AppRoot; data $dataDir; base clone $basePath; standing agents $standingRoot"
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Say "host: $cores logical CPUs, $ramGB GB RAM"

# ---------------------------------------------------------------- roles, from state.json
$roleOf = @{}   # sdkSessionId -> role label
$stateFile = Join-Path $dataDir 'state.json'
if (Test-Path $stateFile) {
  try {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    $disp = $state.orchestratorId
    $byKind = @{}
    foreach ($s in $state.sessions) {
      $role = if ($s.id -eq $disp) { 'dispatcher' } elseif ($s.kind -eq 'orchestrator') { 'orchestrator' } elseif ($s.kind -eq 'standing') { 'standing' } elseif ($s.machineId) { 'worker (machine)' } else { 'worker (host)' }
      if ($s.sdkSessionId) { $roleOf[[string]$s.sdkSessionId] = $role }
      $key = "$role/$($s.status)"
      $byKind[$key] = 1 + [int]$byKind[$key]
    }
    Say ("state.json: {0:N1} MB, {1} sessions; by role/status: {2}" -f ((Get-Item $stateFile).Length / 1MB), @($state.sessions).Count, (($byKind.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '))
    Say ("standing agents defined: {0}" -f @($state.standingAgents).Count)
    $state = $null
  } catch { Say "state.json unreadable: $($_.Exception.Message)" }
} else { Say "no state.json at $stateFile" }

# ---------------------------------------------------------------- the process tree
if (!$ServerPid) {
  $pidFile = Join-Path $dataDir 'server.pid'
  if (Test-Path $pidFile) { $ServerPid = [int]((Get-Content $pidFile -Raw).Trim()) }
}
$srv = if ($ServerPid) { Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid" } else { $null }
if (!$srv) { Say "the portal's server process was not found (pid '$ServerPid'); process sampling skipped" }

function Get-RoleOfClaude($cmd) {
  if ($cmd -match '--resume[ =]+"?([0-9a-f-]{36})') { $r = $roleOf[$Matches[1]]; if ($r) { return $r } }
  return 'claude (session not matched: new, or not resumed)'
}

$csv = Join-Path $OutDir 'samples.csv'
'time,pid,ppid,name,role,top_pid,ws_mb,private_mb,cpu_s' | Set-Content $csv -Encoding UTF8
$samples = @()   # one hashtable per sample: role -> @{ ws; priv; cpu; n }
$prevCpu = @{}; $prevAt = $null
$ioStart = $null; $ioEnd = $null
$deadline = (Get-Date).AddMinutes($Minutes)
while ($srv -and (Get-Date) -lt $deadline) {
  $now = Get-Date
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, PrivatePageCount, UserModeTime, KernelModeTime, CreationDate, ReadTransferCount, WriteTransferCount, OtherTransferCount
  $byPid = @{}; $kids = @{}
  foreach ($p in $all) {
    $byPid[[int]$p.ProcessId] = $p
    $pp = [int]$p.ParentProcessId
    if (!$kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }
    [void]$kids[$pp].Add($p)
  }
  if (!$byPid.ContainsKey($ServerPid)) { Say "$(Get-Date -Format s) the server process $ServerPid ended; sampling stopped"; break }
  $node = $byPid[$ServerPid]
  $io = @{ at = $now; read = [double]$node.ReadTransferCount; write = [double]$node.WriteTransferCount; other = [double]$node.OtherTransferCount }
  if (!$ioStart) { $ioStart = $io }
  $ioEnd = $io
  # Walk the tree; each process is charged to its top claude process (or to "portal" for node and its non-claude kids).
  $rows = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($byPid[$ServerPid], 'portal (node server)', $ServerPid))
  while ($stack.Count) {
    $item = $stack.Pop(); $p = $item[0]; $role = $item[1]; $top = $item[2]
    if ($p.Name -match '^claude(\.exe)?$' -and $role -eq 'portal (node server)') { $role = Get-RoleOfClaude $p.CommandLine; $top = [int]$p.ProcessId }
    $cpu = ([double]$p.UserModeTime + [double]$p.KernelModeTime) / 1e7
    $ws = [math]::Round($p.WorkingSetSize / 1MB, 1); $priv = [math]::Round($p.PrivatePageCount / 1MB, 1)
    Add-Content $csv -Value ('{0},{1},{2},{3},"{4}",{5},{6},{7},{8}' -f $now.ToString('s'), $p.ProcessId, $p.ParentProcessId, $p.Name, $role, $top, $ws, $priv, [math]::Round($cpu, 1))
    if (!$rows.ContainsKey($role)) { $rows[$role] = @{ ws = 0.0; priv = 0.0; cpuDelta = 0.0; tops = @{} } }
    $r = $rows[$role]; $r.ws += $ws; $r.priv += $priv; $r.tops[$top] = 1
    $key = "$($p.ProcessId)/$($p.CreationDate)"
    if ($prevCpu.ContainsKey($key)) { $r.cpuDelta += [math]::Max(0, $cpu - $prevCpu[$key]) }
    $prevCpu[$key] = $cpu
    if ($kids.ContainsKey([int]$p.ProcessId)) { foreach ($k in $kids[[int]$p.ProcessId]) { $stack.Push(@($k, $role, $top)) } }
  }
  if ($prevAt) {
    $secs = ($now - $prevAt).TotalSeconds
    $sample = @{}
    foreach ($role in $rows.Keys) { $r = $rows[$role]; $sample[$role] = @{ ws = $r.ws; priv = $r.priv; cpu = 100 * $r.cpuDelta / $secs; n = $r.tops.Count } }
    $samples += , $sample
  }
  $prevAt = $now
  Start-Sleep -Seconds $IntervalSeconds
}

function Median($xs) { $s = @($xs | Sort-Object); if (!$s.Count) { return 0 }; return $s[[int][math]::Floor(($s.Count - 1) / 2)] }
function Max($xs) { $m = 0; foreach ($x in $xs) { if ($x -gt $m) { $m = $x } }; return $m }
function Mean($xs) { $a = @($xs); if (!$a.Count) { return 0 }; return ($a | Measure-Object -Sum).Sum / $a.Count }
if ($samples.Count) {
  Say ''
  Say "Processes, $($samples.Count) samples (memory in MB summed over each role's processes and their tools; CPU in % of one core):"
  Say ('{0,-48} {1,12} {2,12} {3,14} {4,14} {5,10} {6,10} {7,8} {8,8}' -f 'role', 'WS typical', 'WS peak', 'private typ.', 'private peak', 'CPU mean', 'CPU peak', 'n typ.', 'n max')
  $roles = $samples | ForEach-Object { $_.Keys } | Sort-Object -Unique
  $totWs = @(); $totPriv = @(); $totCpu = @()
  foreach ($s in $samples) { $totWs += ($s.Values | ForEach-Object { $_.ws } | Measure-Object -Sum).Sum; $totPriv += ($s.Values | ForEach-Object { $_.priv } | Measure-Object -Sum).Sum; $totCpu += ($s.Values | ForEach-Object { $_.cpu } | Measure-Object -Sum).Sum }
  foreach ($role in $roles) {
    $vals = $samples | ForEach-Object { if ($_.ContainsKey($role)) { $_[$role] } else { @{ ws = 0; priv = 0; cpu = 0; n = 0 } } }
    Say ('{0,-48} {1,12:N0} {2,12:N0} {3,14:N0} {4,14:N0} {5,10:N1} {6,10:N1} {7,8} {8,8}' -f $role, (Median ($vals | ForEach-Object { $_.ws })), (Max ($vals | ForEach-Object { $_.ws })), (Median ($vals | ForEach-Object { $_.priv })), (Max ($vals | ForEach-Object { $_.priv })), (Mean ($vals | ForEach-Object { $_.cpu })), (Max ($vals | ForEach-Object { $_.cpu })), (Median ($vals | ForEach-Object { $_.n })), (Max ($vals | ForEach-Object { $_.n })))
  }
  Say ('{0,-48} {1,12:N0} {2,12:N0} {3,14:N0} {4,14:N0} {5,10:N1} {6,10:N1}' -f 'ALL (the portal and everything under it)', (Median $totWs), (Max $totWs), (Median $totPriv), (Max $totPriv), (Mean $totCpu), (Max $totCpu))
}
if ($ioStart -and $ioEnd -and $ioEnd.at -gt $ioStart.at) {
  $h = ($ioEnd.at - $ioStart.at).TotalHours
  Say ("node server I/O over {0:N1} h (all I/O, network included): read {1:N0} MB, write {2:N0} MB, other {3:N0} MB; per day at this rate: {4:N1} GB" -f $h, (($ioEnd.read - $ioStart.read) / 1MB), (($ioEnd.write - $ioStart.write) / 1MB), (($ioEnd.other - $ioStart.other) / 1MB), ((($ioEnd.read + $ioEnd.write + $ioEnd.other) - ($ioStart.read + $ioStart.write + $ioStart.other)) / 1GB / $h * 24))
}

# ---------------------------------------------------------------- disk
function Get-Tree([string]$path) {
  if (!$path -or !(Test-Path $path)) { return $null }
  $files = @(Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue)
  return @{ bytes = ($files | Measure-Object Length -Sum).Sum; count = $files.Count; files = $files }
}
function GB($b) { '{0:N2} GB' -f ($b / 1GB) }
Say ''
Say 'Disk:'
$d = Get-Tree $dataDir
if ($d) {
  Say "data/: $(GB $d.bytes) in $($d.count) files"
  Get-ChildItem -LiteralPath $dataDir -Force | ForEach-Object {
    if ($_.PSIsContainer) { $t = Get-Tree $_.FullName; if ($t) { Say ("  {0,-28} {1,10} {2,8} files" -f ($_.Name + '/'), (GB $t.bytes), $t.count) } }
  }
  $loose = @(Get-ChildItem -LiteralPath $dataDir -Force -File); Say ("  {0,-28} {1,10} {2,8} files" -f '(files at the top)', (GB (($loose | Measure-Object Length -Sum).Sum)), $loose.Count)
  Say "written per day over the last $HistoryDays days (by each file's last write; a file appended to over several days counts on its last day):"
  $since = (Get-Date).Date.AddDays(-$HistoryDays)
  $d.files | Where-Object { $_.LastWriteTime -ge $since } | Group-Object { $_.LastWriteTime.ToString('yyyy-MM-dd') } | Sort-Object Name | ForEach-Object {
    $byTop = $_.Group | Group-Object { ($_.FullName.Substring($dataDir.Length).TrimStart('\') -split '\\')[0] } | Sort-Object { -($_.Group | Measure-Object Length -Sum).Sum } | Select-Object -First 3
    Say ("  {0}: {1,10} in {2,6} files; most in {3}" -f $_.Name, (GB (($_.Group | Measure-Object Length -Sum).Sum)), $_.Count, (($byTop | ForEach-Object { "$($_.Name) $(GB (($_.Group | Measure-Object Length -Sum).Sum))" }) -join ', '))
  }
  $tr = Join-Path $dataDir 'transcripts'
  if (Test-Path $tr) {
    $made = @(Get-ChildItem -LiteralPath $tr -File | Where-Object { $_.CreationTime -ge $since })
    Say ("transcripts created in the last {0} days: {1} ({2:N1} a day)" -f $HistoryDays, $made.Count, ($made.Count / $HistoryDays))
  }
  $d = $null
}
if ($basePath -and (Test-Path $basePath)) {
  $git = Get-Tree (Join-Path $basePath '.git')
  $lfs = Get-Tree (Join-Path $basePath '.git\lfs\objects')
  $all = Get-Tree $basePath
  Say ("base clone {0}: .git {1} (LFS objects {2}); working tree without .git {3}; {4} files" -f $basePath, (GB $git.bytes), (GB $(if ($lfs) { $lfs.bytes } else { 0 })), (GB ($all.bytes - $git.bytes)), ($all.count - $git.count))
}
$proj = Join-Path $env:USERPROFILE '.claude\projects'
if (Test-Path $proj) {
  $t = Get-Tree $proj; Say "~/.claude/projects (every session history of this user, workers included): $(GB $t.bytes) in $($t.count) files"
  foreach ($p in @($basePath, $standingRoot)) {
    if (!$p) { continue }
    $prefix = ($p -replace '[:\\/_. ]', '-')
    $dirs = @(Get-ChildItem -LiteralPath $proj -Directory | Where-Object { $_.Name -like "$prefix*" })
    $b = 0; foreach ($x in $dirs) { $b += (Get-Tree $x.FullName).bytes }
    Say "  folders for $p*: $($dirs.Count), $(GB $b)"
  }
}
Say ''
Say "Samples: $csv"
