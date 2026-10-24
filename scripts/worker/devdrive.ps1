# A worker install's Dev Drive (w900, docs/worker-install.md "The Dev Drive"): a dynamically expanding VHDX inside the
# install root, formatted as a ReFS Dev Drive and mounted at the first free letter from V: down to A:, so every sandbox's
# Library can be a block clone of one seed. Needs administrator rights; worker.ts runs it elevated.
#
#   -Action ensure   create the VHDX if there is none, otherwise reuse it; attach it, give it its letter; register the
#                    boot-mount tasks; write <Root>\devdrive.json. Safe to run again: it never recreates, formats or
#                    wipes a VHDX that has a partition.
#   -Action status   print <Root>\devdrive.json's facts as they are now (attached? letter? file system?) and change nothing.
#   -Action remove   the uninstall's half: take the tasks, the attachment and the VHDX away. Refuses unless the VHDX is
#                    <Root>\devdrive.vhdx.
#
# -Root is the folder that holds the VHDX (the host folder). -WorkerRoot is the worker root, when it is somewhere else: on
# the drive itself (w1070, <letter>:\ffw), whose sandboxes follow a letter change; -DaemonConfig is then the daemon's
# daemon.json, which stays in the host folder with the daemon (it remounts the drive, so it does not run from it).
#
# The last line it prints is `FFW-DEVDRIVE {json}` for the caller. Exit code 0 on success, 1 on a failure it names.
param(
  [Parameter(Mandatory)][ValidateSet('ensure', 'status', 'remove')][string]$Action,
  [Parameter(Mandatory)][string]$Root,
  # Maximum size in GB of the VHDX (what V: reports as its size; the file on the host grows only as the drive fills).
  [int]$MaxGB = 0,
  # The letter to try first; empty: the first free one from V: down.
  [string]$Letter = '',
  # The account whose daemon starts the helper tasks (resolved to a SID by install-privileged-helpers.ps1).
  [string]$User = '',
  # That account's SID: it is given the whole drive (the daemon runs as it, not elevated, and a new volume's root may not let it write).
  [string]$UserSid = '',
  # Letters never to use, e.g. 'U,T'.
  [string]$Skip = '',
  [switch]$NoTasks,
  [string]$WorkerRoot = '',
  # The daemon's daemon.json when it is not in the worker root: a root on the drive keeps the daemon in the host folder (w1070).
  [string]$DaemonConfig = ''
)
$ErrorActionPreference = 'Stop'
# No progress bars: nobody sees them in the installer's hidden window (w1993).
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot '..\privileged\devdrive-lib.ps1')

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$Vhdx = Join-Path $Root 'devdrive.vhdx'
$StateFile = Join-Path $Root 'devdrive.json'
$WorkerRoot = if ($WorkerRoot) { [IO.Path]::GetFullPath($WorkerRoot).TrimEnd('\') } else { $Root }
$ResultDir = Join-Path $env:ProgramData 'ffsb-helpers\results'
$Flex = $true
$LetterChangedFrom = ''
if (-not $DaemonConfig) { $DaemonConfig = Join-Path $WorkerRoot 'daemon\daemon.json' }
New-Item -ItemType Directory -Force $ResultDir | Out-Null

function Say([string]$line) { Write-Output $line; Log $line }
function Finish($obj) { Write-Output ('FFW-DEVDRIVE ' + (ConvertTo-Json -InputObject $obj -Compress -Depth 6)) }

function Read-State { if (Test-Path -LiteralPath $StateFile) { try { Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json } catch { $null } } }

function Get-Facts([string]$l) {
  $fs = ''; $dev = $false; $clone = $false
  if ($l -and (Test-Path "${l}:\")) {
    try { $fs = (Get-Volume -DriveLetter $l -ErrorAction Stop).FileSystem } catch { }
    $q = (fsutil devdrv query "${l}:" 2>&1 | Out-String) -replace '\s+', ' '
    $dev = ($q -match 'developer volume' -and $q -notmatch 'not a developer volume')
    $v = (fsutil fsinfo volumeinfo "${l}:" 2>&1 | Out-String)
    $clone = [bool]($v -match 'Block (Refcounting|Cloning)')
    Log "fsutil devdrv query ${l}: $q"
  }
  @{ fileSystem = $fs; devDrive = $dev; blockClone = $clone }
}

function Write-State([string]$l, [int]$gb, [bool]$created) {
  $f = Get-Facts $l
  $prev = Read-State
  $state = [ordered]@{
    vhdx       = $Vhdx
    letter     = $l.ToUpper()
    maxGB      = $gb
    label      = 'ffw'
    fileSystem = $f.fileSystem
    devDrive   = $f.devDrive
    blockClone = $f.blockClone
    createdAt  = $(if ($prev -and $prev.createdAt) { $prev.createdAt } else { (Get-Date).ToUniversalTime().ToString('o') })
    checkedAt  = (Get-Date).ToUniversalTime().ToString('o')
  }
  [IO.File]::WriteAllText($StateFile, (ConvertTo-Json -InputObject $state -Depth 6), (New-Object Text.UTF8Encoding($false)))
  $state['created'] = $created
  $state
}

function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

# One storage step in a job of its own, with a time limit (w1993): on desktop-coosego the install sat silent for minutes after
# the drive got its letter, one core busy and the disk idle, and nothing said which call it was in. Each step says what it
# starts, says it is still on it every 30 s, and one that does not end in time is stopped with its name, never left to hold
# the installer for its whole 30 minutes.
# Straight to stdout, not the function's output: a step's caller keeps or drops what the step returns, never these lines.
function Tell([string]$line) { [Console]::Out.WriteLine($line); Log $line }
function Invoke-Step([string]$what, [int]$seconds, [scriptblock]$block, [object[]]$argList = @()) {
  Tell "$what..."
  $t0 = Get-Date
  $job = Start-Job -ScriptBlock $block -ArgumentList $argList
  try {
    while (-not (Wait-Job -Job $job -Timeout 30)) {
      $s = [int]((Get-Date) - $t0).TotalSeconds
      if ($s -ge $seconds) { throw "$what did not finish in $seconds s, so it was stopped" }
      Tell "  still $what ($s s)"
    }
    $out = Receive-Job -Job $job -ErrorAction Stop
    Log ("{0}: done in {1:N0} s" -f $what, ((Get-Date) - $t0).TotalSeconds)
    return $out
  } finally { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
}

# GPT, one data partition, formatted as a Dev Drive (ReFS), then given the letter. A Windows that has no Dev Drive (before
# 11 22H2) gets plain ReFS, which still block-clones, and the caller is told (devDrive false).
function Initialize-DevDriveDisk($disk, [string]$l) {
  $n = [int]$disk.Number
  if ($disk.PartitionStyle -eq 'RAW') { Invoke-Step "initialising disk $n (GPT)" 120 { param($n) Initialize-Disk -Number $n -PartitionStyle GPT -ErrorAction Stop } @($n) | Out-Null }
  # No letter until it is formatted: a blank volume with a letter makes Explorer ask "You need to format the disk" (w1993).
  $part = Invoke-Step "making its partition" 120 { param($n) (New-Partition -DiskNumber $n -UseMaximumSize -AssignDriveLetter:$false -ErrorAction Stop).PartitionNumber } @($n)
  Format-DataPartition $n ([int]($part | Select-Object -Last 1)) $l
}

function Format-DataPartition([int]$n, [int]$part, [string]$l) {
  $fmt = {
    param($n, $p, $dev)
    $a = @{ FileSystem = 'ReFS'; NewFileSystemLabel = 'ffw'; Confirm = $false; ErrorAction = 'Stop' }
    if ($dev) { $a.DevDrive = $true }
    Get-Partition -DiskNumber $n -PartitionNumber $p -ErrorAction Stop | Format-Volume @a | Out-Null
  }
  try {
    Invoke-Step "formatting it as a ReFS Dev Drive" 600 $fmt @($n, $part, $true) | Out-Null
    $how = 'a ReFS Dev Drive'
  } catch {
    if ($_.Exception.Message -match 'did not finish') { throw }
    Say "Format-Volume -DevDrive failed ($($_.Exception.Message)); trying plain ReFS"
    Invoke-Step "formatting it as plain ReFS" 600 $fmt @($n, $part, $false) | Out-Null
    $how = 'plain ReFS (this Windows has no Dev Drive)'
  }
  if ("$((Get-Partition -DiskNumber $n -PartitionNumber $part).DriveLetter)".ToUpper() -ne $l.ToUpper()) {
    Invoke-Step "giving it the letter ${l}:" 120 { param($n, $p, $l) Set-Partition -DiskNumber $n -PartitionNumber $p -NewDriveLetter $l -ErrorAction Stop } @($n, $part, $l) | Out-Null
  }
  Say "formatted ${l}: as $how"
}

function Register-Tasks([string]$l) {
  if ($NoTasks) { return }
  $helpers = Join-Path $PSScriptRoot '..\install-privileged-helpers.ps1'
  $a = @{ Vhdx = $Vhdx; Letter = $l; Flex = $true; StateFile = $StateFile; DaemonConfig = $DaemonConfig; WorkerRoot = $WorkerRoot; Actions = @('mount', 'trim', 'compact', 'grow') }
  if ($User) { $a.User = $User }
  if ($Skip) { $a.Skip = $Skip }
  & $helpers @a | ForEach-Object { Say "helpers: $_" }
}

try {
  switch ($Action) {
    'status' {
      $st = Read-State
      $own = if (Test-Path -LiteralPath $Vhdx) { Get-OwnLetter } else { '' }
      # The VHDX's own maximum (w1918): Get-DiskImage reads it without administrator rights (measured on LothDesktop, 2026-10-23:
      # 300 GB), so an update over the link records the drive's real size, not a number in devdrive.json.
      $real = 0
      if (Test-Path -LiteralPath $Vhdx) { try { $real = [int][math]::Round((Get-DiskImage -ImagePath $Vhdx -ErrorAction Stop).Size / 1GB) } catch { } }
      Finish @{ exists = (Test-Path -LiteralPath $Vhdx); attached = [bool]$own; letter = $own; maxGB = $real; state = $st }
    }
    'ensure' {
      if (-not (Test-Admin)) { throw 'the Dev Drive needs administrator rights (an elevated session, or the installer asks for them once)' }
      $created = $false
      $st = Read-State
      if (-not (Test-Path -LiteralPath $Vhdx)) {
        if ($MaxGB -lt 50) { throw "the Dev Drive must be at least 50 GB (Windows' own minimum for one); got -MaxGB $MaxGB" }
        $free = (Get-Item -LiteralPath (Split-Path $Vhdx)).PSDrive.Free / 1GB
        if ($free -lt 20) { throw ("only {0:N0} GB free where {1} would go; it needs 20 GB to start" -f $free, $Vhdx) }
        $pick = Resolve-DriveLetter -Prefer $Letter -Skip $Skip
        if (-not $pick.Letter) { throw "no free drive letter from V: down to A: ($(Format-LetterRejections $pick.Rejected))" }
        $script:Letter = $pick.Letter
        Say "drive letter ${Letter}: (passed over: $(Format-LetterRejections $pick.Rejected))"
        $dp = Run-Diskpart @("create vdisk file=`"$Vhdx`" maximum=$($MaxGB * 1024) type=expandable")
        if ($dp -notmatch 'successfully created') { throw "diskpart could not create $Vhdx : $dp" }
        $created = $true
        Say "created $Vhdx ($MaxGB GB maximum, dynamically expanding)"
        try {
          Invoke-Step "attaching it" 120 { param($v) Mount-DiskImage -ImagePath $v -ErrorAction Stop | Out-Null } @($Vhdx) | Out-Null
          $disk = Get-DiskImage -ImagePath $Vhdx | Get-Disk
          Initialize-DevDriveDisk $disk $Letter
        } catch {
          # A VHDX this run made and could not finish is empty: take it away so the next run starts clean.
          $why = $_.Exception.Message
          Dismount-DiskImage -ImagePath $Vhdx -ErrorAction SilentlyContinue | Out-Null
          Remove-Item -LiteralPath $Vhdx -Force -ErrorAction SilentlyContinue
          throw "could not set up the new Dev Drive ($why); the empty VHDX was removed"
        }
      } else {
        # Reuse. Never format a VHDX that holds a partition. One with none is an earlier run cut off between creating it and
        # formatting it (nothing on it to lose): finish that.
        $known = if ($st -and "$($st.letter)" -match '^[A-Za-z]$') { "$($st.letter)" } else { $Letter }
        if (-not $known) { $known = (Resolve-DriveLetter -Prefer '' -Own (Get-OwnLetter) -Skip $Skip).Letter }
        $script:Letter = $known.ToUpper()
        $img = Get-DiskImage -ImagePath $Vhdx
        if (-not $img.Attached) { Mount-DiskImage -ImagePath $Vhdx | Out-Null }
        $disk = Get-DiskImage -ImagePath $Vhdx | Get-Disk
        if ($disk.IsOffline) { Set-Disk -Number $disk.Number -IsOffline $false }
        $data = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue | Where-Object { $_.Type -ne 'Reserved' -and $_.Size -gt 1GB })
        if (-not $data.Count) {
          $pick = Resolve-DriveLetter -Prefer $Letter -Skip $Skip
          if (-not $pick.Letter) { throw "no free drive letter from V: down to A: ($(Format-LetterRejections $pick.Rejected))" }
          $script:Letter = $pick.Letter
          Say "$Vhdx has no partition (an earlier run was cut off); finishing it as ${Letter}:"
          if ($MaxGB -lt 50 -and $st) { $MaxGB = [int]$st.maxGB }
          Initialize-DevDriveDisk $disk $Letter
        } elseif (-not $st -and @($data[0] | Get-Volume -ErrorAction SilentlyContinue | Where-Object { -not $_.FileSystem -or $_.FileSystem -eq 'RAW' }).Count) {
          # A partition with no file system and no devdrive.json (written only once a run finished): an earlier run cut off while
          # formatting (w1993, desktop-coosego), nothing on it to lose. Format it, on the letter it has or the next free one.
          $own = "$($data[0].DriveLetter)".Trim([char]0).ToUpper()
          if ($own -match '^[A-Z]$') { $script:Letter = $own } else {
            $pick = Resolve-DriveLetter -Prefer $Letter -Skip $Skip
            if (-not $pick.Letter) { throw "no free drive letter from V: down to A: ($(Format-LetterRejections $pick.Rejected))" }
            $script:Letter = $pick.Letter
          }
          Say "$Vhdx has a partition with no file system (an earlier run was cut off while formatting); formatting it as ${Letter}:"
          Format-DataPartition ([int]$disk.Number) ([int]$data[0].PartitionNumber) $Letter
        } elseif ((Get-OwnLetter) -ne $Letter.ToUpper()) {
          Mount-DevDrive
          if ($LetterChangedFrom) { Say "the letter changed from ${LetterChangedFrom}: to ${Letter}: (taken): $(Update-LetterDependents $LetterChangedFrom $Letter)" }
        }
        if (-not $MaxGB -and $st) { $MaxGB = [int]$st.maxGB }
        Say "reusing $Vhdx at ${Letter}:"
      }
      if ($UserSid -match '^S-1-') {
        Say "giving $UserSid full control of ${Letter}:\..."
        icacls "${Letter}:\" /grant "*${UserSid}:(OI)(CI)F" /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls ${Letter}:\ failed ($LASTEXITCODE)" }
        Say "gave $UserSid full control of ${Letter}:\"
      }
      # The maximum the VHDX really has, not the one asked for or recorded: a drive grown by hand (Resize-VHD or diskpart
      # expand, LothDesktop 275 -> 300 GiB on 2026-10-12, w1070) keeps its old number otherwise, and the host guard then
      # misjudges how much the file can still grow on its volume.
      try { $real = [int][math]::Round((Get-DiskImage -ImagePath $Vhdx -ErrorAction Stop).Size / 1GB); if ($real -ge 50) { if ($real -ne $MaxGB) { Say "the VHDX's maximum is $real GB (recorded: $MaxGB GB)" }; $MaxGB = $real } } catch { }
      $state = Write-State $Letter $MaxGB $created
      $state['letterChangedFrom'] = $LetterChangedFrom
      Register-Tasks $Letter
      Finish $state
    }
    'remove' {
      if (-not (Test-Admin)) { throw 'removing the Dev Drive needs administrator rights' }
      if ((Split-Path $Vhdx -Leaf) -ne 'devdrive.vhdx' -or -not $Vhdx.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: $Vhdx is not this root's devdrive.vhdx" }
      foreach ($t in @(Get-ScheduledTask -TaskName 'ffsb-helper-*' -ErrorAction SilentlyContinue)) {
        $args0 = [string]($t.Actions | Select-Object -First 1).Arguments
        if ($args0.IndexOf($Vhdx, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false; Say "removed task $($t.TaskName)" }
      }
      if (Test-Path -LiteralPath $Vhdx) {
        Dismount-DiskImage -ImagePath $Vhdx -ErrorAction SilentlyContinue | Out-Null
        Remove-Item -LiteralPath $Vhdx -Force
        Say "removed $Vhdx"
      }
      Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
      Finish @{ removed = $true }
    }
  }
} catch {
  # Never a bare "FAILED:" (w2004): the exception's type and the line it came from when its message is empty.
  $why = "$($_.Exception.Message)".Trim()
  if (-not $why) { $why = "$($_.Exception.GetType().FullName) with no message ($($_.FullyQualifiedErrorId))" }
  $at = "$($_.InvocationInfo.ScriptLineNumber)"
  if ($at -and $at -ne '0') { $why += " (devdrive.ps1 line $($at):$("$($_.InvocationInfo.Line)".Trim()))" }
  Write-Output "FAILED: $why"
  Log "FAILED: $why"
  exit 1
}
