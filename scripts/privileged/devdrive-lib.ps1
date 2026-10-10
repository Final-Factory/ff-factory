# Shared by the privileged helper (ffsb-helper.ps1: the boot mount and the remount) and by scripts/worker/devdrive.ps1
# (the installer's create-or-reuse), so the two attach a Dev Drive VHDX the same way. Dot-sourced, never run on its own.
# The functions read $Vhdx, $Letter, $ResultDir and $Action from the script that dot-sources them (PowerShell's dynamic
# scope), which is why the helper's own copies of them moved here unchanged (w900).
#
# Letters (w900, lothsahn: "starting with V: and moving back towards A until it finds an available drive letter"):
# V, U, T ... C, then B, then A. W: to Z: are left alone (Z: is where a person maps a share first). A letter is not free
# when it is in use (a volume, a SUBST, a CD drive), is a mapped network drive (this session's, or any user's persistent
# mapping in the registry), is reserved (Windows remembers the letter of every volume it has seen, in MountedDevices, and
# gives it back when that volume returns), or the caller excluded it. A: and B: come last because they once meant floppy
# drives and some old tools still treat them so.

function Get-LetterOrder {
  $order = @()
  foreach ($c in 86..67) { $order += [string][char]$c }   # V down to C
  $order + 'B' + 'A'
}

function ConvertTo-Letters($list) {
  @($list | ForEach-Object { "$_" -split '[,;\s]+' } | ForEach-Object { $_ -replace '[:\\/]', '' } | Where-Object { $_ -match '^[A-Za-z]$' } | ForEach-Object { $_.ToUpper() } | Select-Object -Unique)
}

# The pure part: which letter, and why each earlier one was passed over. $Prefer (a letter this Dev Drive already
# had) is kept when nothing but its own reservation stands in its way: $Reserved is ignored for it, because the
# reservation is most likely its own. Returns @{ Letter; Rejected = @{ 'V' = 'in use'; ... } }; Letter is $null when
# every letter A-V is taken.
function Select-DriveLetter {
  param([string[]]$InUse = @(), [string[]]$Mapped = @(), [string[]]$Reserved = @(), [string[]]$Skip = @(), [string]$Prefer = '')
  $inUse = ConvertTo-Letters $InUse; $mapped = ConvertTo-Letters $Mapped; $reserved = ConvertTo-Letters $Reserved; $skip = ConvertTo-Letters $Skip
  $rejected = [ordered]@{}
  function Why([string]$l, [bool]$ownReservation) {
    if ($skip -contains $l) { return 'excluded' }
    if ($inUse -contains $l) { return 'in use' }
    if ($mapped -contains $l) { return 'mapped network drive' }
    if (-not $ownReservation -and $reserved -contains $l) { return 'reserved by Windows for another volume' }
    return $null
  }
  $p = (ConvertTo-Letters $Prefer | Select-Object -First 1)
  if ($p) {
    $why = Why $p $true
    if (-not $why) { return @{ Letter = $p; Rejected = $rejected } }
    $rejected[$p] = $why
  }
  foreach ($l in Get-LetterOrder) {
    if ($rejected.Contains($l)) { continue }
    $why = Why $l $false
    if (-not $why) { return @{ Letter = $l; Rejected = $rejected } }
    $rejected[$l] = $why
  }
  return @{ Letter = $null; Rejected = $rejected }
}

# Persistent network mappings are per user (HKU\<sid>\Network\<letter>). A boot task runs as SYSTEM with no user
# loaded, so the profiles' hives are read too, loaded for a moment when they are not already.
function Get-MappedLetters {
  $letters = @()
  try { $letters += Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' -ErrorAction Stop | ForEach-Object { $_.DeviceID } } catch { }
  try {
    foreach ($k in Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction Stop) {
      $n = Join-Path $k.PSPath 'Network'
      if (Test-Path $n) { $letters += (Get-ChildItem $n -ErrorAction SilentlyContinue).PSChildName }
    }
  } catch { }
  try {
    $loaded = @(Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction Stop | ForEach-Object { $_.PSChildName })
    $i = 0
    foreach ($p in Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction Stop) {
      $sid = $p.PSChildName
      $dir = (Get-ItemProperty $p.PSPath -ErrorAction SilentlyContinue).ProfileImagePath
      if ($loaded -contains $sid -or -not $dir) { continue }
      $dat = Join-Path ([Environment]::ExpandEnvironmentVariables($dir)) 'NTUSER.DAT'
      if (-not (Test-Path -LiteralPath $dat)) { continue }
      $tmp = "ffw-letters-$PID-$((++$i))"
      reg.exe load "HKU\$tmp" $dat 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { continue }
      try {
        $n = "Registry::HKEY_USERS\$tmp\Network"
        if (Test-Path $n) { $letters += (Get-ChildItem $n -ErrorAction SilentlyContinue).PSChildName }
      } finally {
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        reg.exe unload "HKU\$tmp" 2>$null | Out-Null
      }
    }
  } catch { }
  ConvertTo-Letters $letters
}

# The letters Windows has put aside: every \DosDevices\X: value of MountedDevices (a volume it has seen, plugged in or not).
function Get-ReservedLetters {
  try {
    $key = Get-Item 'HKLM:\SYSTEM\MountedDevices' -ErrorAction Stop
    ConvertTo-Letters @($key.GetValueNames() | ForEach-Object { if ($_ -match '^\\DosDevices\\([A-Za-z]):$') { $Matches[1] } })
  } catch { @() }
}

function Get-InUseLetters {
  $letters = @()
  try { $letters += [IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name } } catch { }
  try { $letters += Get-PSDrive -PSProvider FileSystem -ErrorAction Stop | ForEach-Object { $_.Name } } catch { }
  try { $letters += Get-Volume -ErrorAction Stop | ForEach-Object { $_.DriveLetter } } catch { }
  ConvertTo-Letters $letters
}

# The choice on this computer. $Own: the letter this Dev Drive's volume holds now (it is "in use" by itself).
function Resolve-DriveLetter {
  param([string]$Prefer = '', [string]$Own = '', [string[]]$Skip = @())
  $own = ConvertTo-Letters $Own
  $inUse = @(Get-InUseLetters | Where-Object { $own -notcontains $_ })
  Select-DriveLetter -InUse $inUse -Mapped (Get-MappedLetters) -Reserved (Get-ReservedLetters) -Skip $Skip -Prefer $Prefer
}

function Format-LetterRejections($rejected) {
  if (-not $rejected -or $rejected.Count -eq 0) { return 'none passed over' }
  ($rejected.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)" }) -join ', '
}

# ---- attaching, unchanged from the helper's own functions (BEAST, 2026-09-24) -----------------------------------

# In Flex mode "there" means this VHDX's own volume holds the letter, not that something answers to it.
function Drive { if ($Flex) { (Get-OwnLetter) -eq "$Letter".ToUpper() } else { Test-Path "$($Letter):\" } }

# Every mount attempt, for post-mortems (the boot mount on 2026-09-24 failed with "Access denied" from the
# storage CIM provider and left no trace).
function Log([string]$m) {
  try { "$(Get-Date -Format s) [$Action] $m" | Out-File -Append -Encoding utf8 (Join-Path $ResultDir 'mount.log') } catch { }
}

function Run-Diskpart([string[]]$lines) {
  $dp = Join-Path $env:TEMP "ffsb-diskpart-$PID.txt"
  $lines | Set-Content -Encoding ascii $dp
  try { return (diskpart /s $dp 2>&1 | Out-String) -replace '\s+', ' ' } finally { Remove-Item $dp -ErrorAction SilentlyContinue }
}

# Attach the VHDX if it is not, bring its disk online and give its data partition the drive letter. The
# storage cmdlets (a CIM provider) can refuse early in boot, so each step is retried, and diskpart, which does
# not go through that provider, is the fallback for attaching and for the letter.
# With $Flex set by the caller (a worker install's Dev Drive, w900) a letter that another volume has taken is not an
# error: the next free one (Resolve-DriveLetter) is used, $Letter is updated, and $LetterChangedFrom says what it was.
function Mount-DevDrive {
  $attached = $false
  for ($i = 1; $i -le 3 -and -not $attached; $i++) {
    try {
      $img = Get-DiskImage -ImagePath $Vhdx -ErrorAction Stop
      if (-not $img.Attached) { Mount-DiskImage -ImagePath $Vhdx -ErrorAction Stop | Out-Null; Start-Sleep 2; Log "attached with Mount-DiskImage (try $i)" }
      $attached = $true
    } catch {
      Log "Mount-DiskImage try $i failed: $($_.Exception.Message)"
      Start-Sleep -Seconds (5 * $i)
    }
  }
  if (-not $attached) {
    $out = Run-Diskpart @("select vdisk file=`"$Vhdx`"", 'attach vdisk')
    Log "diskpart attach vdisk: $out"
    if ($out -notmatch 'successfully attached|already attached|is already') { throw "could not attach $Vhdx (Mount-DiskImage failed 3 times; diskpart: $out)" }
  }
  $lettered = $false
  for ($i = 1; $i -le 3 -and -not $lettered; $i++) {
    try {
      $disk = Get-DiskImage -ImagePath $Vhdx -ErrorAction Stop | Get-Disk -ErrorAction Stop
      if ($disk.IsOffline) { Set-Disk -Number $disk.Number -IsOffline $false }
      if ($disk.IsReadOnly) { Set-Disk -Number $disk.Number -IsReadOnly $false }
      $part = Get-Partition -DiskNumber $disk.Number -ErrorAction Stop | Where-Object { $_.Type -ne 'Reserved' -and $_.Size -gt 1GB } | Sort-Object Size -Descending | Select-Object -First 1
      if (-not $part) { throw "no data partition on disk $($disk.Number)" }
      if ($Flex) {
        # Windows gave the volume its remembered letter, or none, or the lowest free one. Keep the one it has when it
        # is the preferred one; otherwise take the preferred one if free, else the next free one.
        $held = ConvertTo-PartitionLetter $part.DriveLetter
        if ($held -ne $Letter.ToUpper()) {
          $pick = Resolve-DriveLetter -Prefer $Letter -Own $held -Skip $Skip
          if (-not $pick.Letter) { throw [InvalidOperationException]::new("no free drive letter from V: down to A: ($(Format-LetterRejections $pick.Rejected))") }
          if ($pick.Letter -ne $Letter.ToUpper()) {
            Log "$($Letter): is taken ($(Format-LetterRejections $pick.Rejected)); using $($pick.Letter): instead"
            $script:LetterChangedFrom = $Letter.ToUpper()
            $script:Letter = $pick.Letter
          }
        }
      }
      if ((ConvertTo-PartitionLetter $part.DriveLetter) -ne $Letter.ToUpper()) { $part | Set-Partition -NewDriveLetter $Letter -ErrorAction Stop; Log "gave disk $($disk.Number) partition $($part.PartitionNumber) the letter $($Letter):" }
      $lettered = $true
    } catch {
      Log "partition/letter try $i failed: $($_.Exception.Message)"
      # Nothing to retry: every letter is taken (a letter assigned by hand below would be somebody else's).
      if ($_.Exception -is [InvalidOperationException]) { throw }
      Start-Sleep -Seconds (5 * $i)
    }
  }
  if (-not $lettered -and -not (Drive)) {
    # GPT disks made by devdrive.ps1: partition 1 is the reserved one, 2 the data (ReFS) one.
    foreach ($n in 2, 1) {
      $out = Run-Diskpart @("select vdisk file=`"$Vhdx`"", 'online disk noerr', 'attributes disk clear readonly noerr', "select partition $n", "assign letter=$Letter noerr")
      Log "diskpart assign letter (partition $n): $out"
      Start-Sleep 2
      if (Drive) { break }
    }
  }
  for ($i = 0; $i -lt 15 -and -not (Drive); $i++) { Start-Sleep 2 }
  if (-not (Drive)) { throw "the VHDX is attached but $($Letter): did not appear (see $(Join-Path $ResultDir 'mount.log'))" }
  Log "$($Letter): is there"
}

# The letter this Dev Drive's volume holds now ('' when it is detached or has none).
function Get-OwnLetter {
  try {
    $img = Get-DiskImage -ImagePath $Vhdx -ErrorAction Stop
    if (-not $img.Attached) { return '' }
    $part = $img | Get-Disk -ErrorAction Stop | Get-Partition -ErrorAction Stop | Where-Object { $_.Type -ne 'Reserved' -and $_.Size -gt 1GB } | Sort-Object Size -Descending | Select-Object -First 1
    return ConvertTo-PartitionLetter $part.DriveLetter
  } catch { return '' }
}

# A partition's DriveLetter is a char, and [char]0 (a NUL, not an empty string) when it has none.
function ConvertTo-PartitionLetter($DriveLetter) {
  $l = "$DriveLetter".Trim([char]0, ' ').ToUpper()
  if ($l -match '^[A-Z]$') { $l } else { '' }
}

# ---- when the letter has to change (w900) -------------------------------------------------------------------------
# Everything that stores a path on the drive stores its letter. These are the pure parts (testable anywhere).

# "V:\sandboxes\slot1" -> "U:\sandboxes\slot1"; any other string, and a path on another letter, unchanged.
function Convert-PathLetter([string]$Value, [string]$From, [string]$To) {
  if ($Value -match '^([A-Za-z]):([\\/].*)?$' -and $Matches[1].ToUpper() -eq $From.ToUpper()) { return "$($To.ToUpper()):$($Matches[2])" }
  return $Value
}

# A parsed JSON value with every string that starts on $From: put on $To. Returns the new value; $script:Changed counts them.
function Convert-JsonLetter($Node, [string]$From, [string]$To) {
  if ($Node -is [string]) {
    $n = Convert-PathLetter $Node $From $To
    if ($n -ne $Node) { $script:Changed++ }
    return $n
  }
  if ($Node -is [System.Collections.IList]) { return ,@($Node | ForEach-Object { Convert-JsonLetter $_ $From $To }) }
  if ($Node -is [pscustomobject]) {
    foreach ($p in @($Node.PSObject.Properties)) { $p.Value = Convert-JsonLetter $p.Value $From $To }
    return $Node
  }
  return $Node
}

# Rewrite one JSON file in place (a temp file beside it, then a rename). Returns how many strings changed.
function Update-JsonFileLetter([string]$File, [string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $File)) { return 0 }
  $script:Changed = 0
  $raw = [IO.File]::ReadAllText($File)
  if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
  $doc = $raw | ConvertFrom-Json
  $doc = Convert-JsonLetter $doc $From $To
  if ($script:Changed -gt 0) {
    $tmp = "$File.ffw-tmp"
    [IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $doc -Depth 32), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $File -Force
  }
  return $script:Changed
}

# Everything that stored the old letter (reads $StateFile, $DaemonConfig and $WorkerRoot from the caller): the state file, the daemon's config and its pool state, the root's junctions and
# the worktrees' recorded paths. Each step is its own try, so one that fails does not stop the rest; the summary says which.
function Update-LetterDependents([string]$From, [string]$To) {
  $done = @()
  if ($StateFile -and (Test-Path -LiteralPath $StateFile)) {
    try { $n = Update-JsonFileLetter $StateFile $From $To; $st = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json; $st.letter = $To.ToUpper(); [IO.File]::WriteAllText($StateFile, (ConvertTo-Json -InputObject $st -Depth 8), (New-Object Text.UTF8Encoding($false))); $done += "state file" } catch { $done += "state file FAILED: $($_.Exception.Message)" }
  }
  if ($DaemonConfig) { try { $n = Update-JsonFileLetter $DaemonConfig $From $To; $done += "daemon.json ($n paths)" } catch { $done += "daemon.json FAILED: $($_.Exception.Message)" } }
  if ($WorkerRoot) {
    try { $n = Update-JsonFileLetter (Join-Path $WorkerRoot 'daemon\sandboxes.json') $From $To; $done += "sandboxes.json ($n paths)" } catch { $done += "sandboxes.json FAILED: $($_.Exception.Message)" }
    foreach ($name in 'sandboxes', 'seed') {
      try {
        # Only a junction (a root whose sandboxes are on the drive); a real folder is the install's own and is left alone.
        $link = Join-Path $WorkerRoot $name
        $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
          cmd.exe /d /c rmdir "`"$link`"" | Out-Null
          cmd.exe /d /c mklink /J "`"$link`"" "`"$($To):\$name`"" | Out-Null
          $done += "junction $name"
        }
      } catch { $done += "junction $name FAILED: $($_.Exception.Message)" }
    }
    try {
      $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
      if (-not $git -and $env:ProgramFiles) { $git = Join-Path $env:ProgramFiles 'Git\cmd\git.exe' }
      $dirs = @(Get-ChildItem -LiteralPath "$($To):\sandboxes" -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
      if ($dirs.Count -and (-not $git -or -not (Test-Path -LiteralPath $git))) { $done += 'git worktree repair SKIPPED: git.exe not found (run: git -C <root>\repo worktree repair <each sandbox>)' }
      elseif ($dirs.Count) {
        $out = & $git -c safe.directory=* -C (Join-Path $WorkerRoot 'repo') worktree repair @dirs 2>&1 | Out-String
        $done += "git worktree repair ($($dirs.Count) sandboxes)"
        Log "git worktree repair: $($out -replace '\s+', ' ')"
      }
    } catch { $done += "git worktree repair FAILED: $($_.Exception.Message)" }
  }
  Log "letter $($From): -> $($To): : $($done -join '; ')"
  $done -join '; '
}
