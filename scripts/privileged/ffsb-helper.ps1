# The privileged helper (docs/self-recovery.md). install-privileged-helpers.ps1 copies it to
# %ProgramData%\ffsb-helpers (writable only by SYSTEM and Administrators) and registers one SYSTEM task per
# action with every argument fixed; the app's user may only start those tasks. Each run writes
# <ResultDir>\<Action>.json: { action, ok, at, detail }.
#
# A worker install's Dev Drive (w900) adds -Flex: the letter is a preference, not a rule. If another volume has taken it,
# the next free letter from V: down to A: is used (devdrive-lib.ps1), and what holds the old letter is repointed: the
# state file, the daemon's config and pool state, the root's two junctions, and the worktrees' recorded paths.
#   -StateFile     <root>\devdrive.json: { letter, ... }; its letter wins over -Letter (the drive may have moved before)
#   -DaemonConfig  <root>\daemon\daemon.json (sandboxes.root and sandboxes.librarySeed are rewritten)
#   -WorkerRoot    <root>: its sandboxes\ and seed\ junctions, its repo\ (git worktree repair), daemon\sandboxes.json.
#                  A root on the drive itself (w1070, V:\ffw) moves with the letter, and so does -DaemonConfig.
#   -Skip          letters never to use
#
# grow (w1918) makes the VHDX's maximum the state file's wantGB, which the daemon writes: only larger (ReFS cannot shrink), at
# most the size of the volume that holds the VHDX, never while an editor uses the drive. The daemon starts it only when no
# agent or editor is in a sandbox; the drive is detached for it (diskpart expand vdisk needs that), then reattached and its
# partition extended (ReFS grows online).
#
# dedup (w4502) runs one FULL ReFS deduplication pass on the drive, where dedup is enabled (LothDesktop since w1576). The
# daily scheduled job is incremental ("only new or changed files will be processed", Microsoft's Start-ReFSDedupJob docs),
# and on 2026-11-16 it left 54 GB of byte-identical files that predated its last run unshared, so the installer runs this
# action weekly. Dedup runs on live files (the nightly job has done so since 2026-10-19); it skips files changed in the last
# hour, as the schedule does, and takes at most half the CPU.
param(
  [Parameter(Mandatory)][ValidateSet('mount', 'trim', 'compact', 'detach', 'reboot', 'pagefile', 'grow', 'dedup')][string]$Action,
  [Parameter(Mandatory)][string]$Vhdx,
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z]$')][string]$Letter,
  [Parameter(Mandatory)][string]$ResultDir,
  [int]$PagefileGB = 0,
  [switch]$Flex,
  [string]$StateFile = '',
  [string]$DaemonConfig = '',
  [string]$WorkerRoot = '',
  [string[]]$Skip = @()
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $ResultDir | Out-Null
. (Join-Path $PSScriptRoot 'devdrive-lib.ps1')
$LetterChangedFrom = ''
function Done([bool]$ok, [string]$detail) {
  $r = [ordered]@{ action = $Action; ok = $ok; at = (Get-Date).ToUniversalTime().ToString('o'); detail = $detail }
  [IO.File]::WriteAllText((Join-Path $ResultDir "$Action.json"), ($r | ConvertTo-Json -Compress))
  exit ([int](!$ok))
}

try {
  switch ($Action) {
    'mount' {
      if ($Flex) {
        # A worker install's drive: its letter is the one it last had (the state file), and "already there" means this
        # VHDX's own volume holds it, not that something else answers to that letter.
        $pref = $Letter
        if ($StateFile -and (Test-Path -LiteralPath $StateFile)) {
          try { $l = (Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json).letter; if ("$l" -match '^[A-Za-z]$') { $pref = "$l" } } catch { Log "could not read $StateFile : $($_.Exception.Message)" }
        }
        # A worker root on the drive (w1070): the task names its daemon.json and root at the letter it was registered with.
        if ($pref.ToUpper() -ne $Letter.ToUpper()) {
          if ($DaemonConfig) { $script:DaemonConfig = Convert-PathLetter $DaemonConfig $Letter $pref }
          if ($WorkerRoot) { $script:WorkerRoot = Convert-PathLetter $WorkerRoot $Letter $pref }
        }
        $script:Letter = $pref.ToUpper()
        if ((Get-OwnLetter) -eq $script:Letter) { Done $true "$($Letter): is already there" }
      } elseif (Drive) { Done $true "$($Letter): is already there" }
      Mount-DevDrive
      $detail = "attached $Vhdx as $($Letter):"
      if ($LetterChangedFrom) { $detail = "$detail; the letter changed from $($LetterChangedFrom): to $($Letter): ($(Update-LetterDependents $LetterChangedFrom $Letter))" }
      Done $true $detail
    }
    'trim' {
      if (-not (Drive)) { Done $false "$($Letter): is not mounted" }
      Optimize-Volume -DriveLetter $Letter -ReTrim
      Done $true "retrimmed $($Letter): (free space inside the volume handed back to the VHDX)"
    }
    'compact' {
      $users = Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" | Where-Object { $_.CommandLine -match "(?i)$($Letter):[\\/]" }
      if ($users) { Done $false "refused: $(@($users).Count) Unity editor(s) use $($Letter): (stop them first)" }
      $before = (Get-Item $Vhdx).Length
      $fs = if (Drive) { (Get-Volume -DriveLetter $Letter).FileSystem } else { '?' }
      # Reclaiming space from a dynamic VHDX needs Optimize-VHD (the Hyper-V PowerShell module). diskpart's
      # "compact vdisk" finds unused space through the NTFS file system inside, so it reclaims nothing for ReFS
      # (the first try on 2026-09-24 went 245.6 -> 245.6 GB): do not detach the drive for a no-op.
      if (-not (Get-Command Optimize-VHD -ErrorAction SilentlyContinue)) {
        if ($fs -ne 'NTFS') { Done $false ("cannot compact: Optimize-VHD (Hyper-V PowerShell module) is not installed, and diskpart only compacts NTFS volumes ({0}: is {1}). The VHDX stays {2:N1} GB. Install the module once (docs/self-recovery.md), then compact again." -f $Letter, $fs, ($before / 1GB)) }
      }
      if (Drive) { Optimize-Volume -DriveLetter $Letter -ReTrim -ErrorAction SilentlyContinue }
      $how = ''
      if (Drive) { Write-VolumeCache -DriveLetter $Letter -ErrorAction SilentlyContinue }
      Dismount-DiskImage -ImagePath $Vhdx | Out-Null
      try {
        if (Get-Command Optimize-VHD -ErrorAction SilentlyContinue) {
          # Full needs the disk attached read-only; Pretrimmed (blocks the retrim above released) needs it detached.
          try {
            Mount-DiskImage -ImagePath $Vhdx -Access ReadOnly -NoDriveLetter | Out-Null
            Optimize-VHD -Path $Vhdx -Mode Full
            $how = 'Optimize-VHD Full'
          } catch {
            $how = "Optimize-VHD Pretrimmed (Full: $($_.Exception.Message))"
          } finally {
            Dismount-DiskImage -ImagePath $Vhdx -ErrorAction SilentlyContinue | Out-Null
          }
          if ($how -like 'Optimize-VHD Pretrimmed*') { Optimize-VHD -Path $Vhdx -Mode Pretrimmed }
        } else {
          $dp = Join-Path $env:TEMP 'ffsb-compact.txt'
          @("select vdisk file=`"$Vhdx`"", 'attach vdisk readonly', 'compact vdisk', 'detach vdisk') | Set-Content -Encoding ascii $dp
          $out = diskpart /s $dp 2>&1 | Out-String
          if ($out -match 'error|failed|not supported') { throw "diskpart: $($out -replace '\s+', ' ')" }
          $how = 'diskpart compact vdisk'
        }
      } finally {
        Mount-DevDrive
      }
      $after = (Get-Item $Vhdx).Length
      $freed = ($before - $after) / 1GB
      $msg = "{0}: {1:N1} GB -> {2:N1} GB (reclaimed {3:N1} GB), {4}: reattached" -f $how, ($before / 1GB), ($after / 1GB), $freed, $Letter
      if ($freed -lt 1) { Done $false "compaction reclaimed nothing: $msg" }
      Done $true $msg
    }
    'grow' {
      if (-not $StateFile -or -not (Test-Path -LiteralPath $StateFile)) { Done $false 'no state file (devdrive.json) says what size is wanted' }
      $st = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
      if ($null -eq $st.wantGB) { Done $true 'devdrive.json wants no other size' }
      $want = 0
      if (-not [int]::TryParse("$($st.wantGB)", [ref]$want) -or $want -lt 1) { Done $false "devdrive.json's wantGB is not a whole number of GB: '$($st.wantGB)'" }
      $have = [int][math]::Round((Get-DiskImage -ImagePath $Vhdx).Size / 1GB)
      if ($want -le $have) { Done $true "the VHDX's maximum is already $have GB (wanted $want GB); it never shrinks" }
      # At most the volume that holds the VHDX (an expandable VHDX takes room as it fills; the host guard watches that).
      $hostGB = 2048
      try { $hostGB = [int][math]::Floor((Get-Volume -DriveLetter (Split-Path -Qualifier $Vhdx).TrimEnd(':')).Size / 1GB) } catch { }
      if ($want -gt $hostGB) { Done $false "refused: $want GB is more than the $hostGB GB volume that holds $Vhdx" }
      $users = Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" | Where-Object { $_.CommandLine -match "(?i)$($Letter):[\\/]" }
      if ($users) { Done $false "refused: $(@($users).Count) Unity editor(s) use $($Letter): (stop them first)" }
      if ($Flex) { $own = Get-OwnLetter; if ($own) { $script:Letter = $own } }
      if (Drive) { Write-VolumeCache -DriveLetter $Letter -ErrorAction SilentlyContinue }
      if ((Get-DiskImage -ImagePath $Vhdx).Attached) { Dismount-DiskImage -ImagePath $Vhdx | Out-Null }
      $out = ''
      try {
        $out = Run-Diskpart @("select vdisk file=`"$Vhdx`"", "expand vdisk maximum=$($want * 1024)")
        Log "diskpart expand vdisk maximum=$($want * 1024): $out"
      } finally {
        Mount-DevDrive
      }
      $now = [int][math]::Round((Get-DiskImage -ImagePath $Vhdx).Size / 1GB)
      if ($now -lt $want) { Done $false "the VHDX is still $now GB after diskpart expand vdisk ($out); $($Letter): is attached again" }
      $part = Get-Partition -DriveLetter $Letter
      $before = $part.Size
      $max = (Get-PartitionSupportedSize -DriveLetter $Letter).SizeMax
      if ($max -gt $before + 64MB) { Resize-Partition -DriveLetter $Letter -Size $max }
      $after = (Get-Partition -DriveLetter $Letter).Size
      $st.PSObject.Properties.Remove('wantGB')
      $st | Add-Member -NotePropertyName maxGB -NotePropertyValue $want -Force
      [IO.File]::WriteAllText($StateFile, ($st | ConvertTo-Json -Depth 8))
      Done $true ("grew {0}: from {1} to {2} GB (its volume {3:N1} -> {4:N1} GB); devdrive.json says {2} GB" -f $Letter, $have, $want, ($before / 1GB), ($after / 1GB))
    }
    'detach' {
      # For the recovery self-test (host_recovery "selftest"): the drive goes away as it did on 2026-09-24, and the
      # app must notice and reattach it through ffsb-helper-mount. Refused while any editor uses the drive.
      $users = Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" | Where-Object { $_.CommandLine -match "(?i)$($Letter):[\\/]" }
      if ($users) { Done $false "refused: $(@($users).Count) Unity editor(s) use $($Letter): (stop them first)" }
      if (-not (Get-DiskImage -ImagePath $Vhdx).Attached) { Done $true "already detached" }
      if (Drive) { Write-VolumeCache -DriveLetter $Letter -ErrorAction SilentlyContinue }
      Dismount-DiskImage -ImagePath $Vhdx | Out-Null
      Done $true "detached $Vhdx ($($Letter): is gone until ffsb-helper-mount attaches it)"
    }
    'reboot' {
      # Without automatic logon the desktop session (and with it the app and the editors' GPU) would not come
      # back after a reboot, so the reboot would make things worse.
      $wl = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
      if ("$($wl.AutoAdminLogon)" -ne '1' -or -not $wl.DefaultUserName) { Done $false 'refused: automatic logon is not set up (Sysinternals Autologon), so the app would not come back after a reboot' }
      $last = Join-Path $ResultDir 'reboot.json'
      if ((Test-Path $last) -and ((Get-Date) - (Get-Item $last).LastWriteTime).TotalHours -lt 6) {
        $prev = Get-Content $last -Raw | ConvertFrom-Json
        if ($prev.ok) { Done $false 'refused: a reboot was already done in the last 6 hours' }
      }
      shutdown.exe /r /t 120 /d p:4:1 /c 'FF Factory: controlled reboot to recover the sandbox drive (cancel with shutdown /a)'
      Done $true 'reboot in 2 minutes (shutdown /a cancels it)'
    }
    'dedup' {
      # Start-ReFSDedupJob returns as soon as the job starts and the job runs on in the background (w4509: the first
      # pass on LothDesktop wrote "0 min, 49.4 -> 49.4 GB" while it really ran 43 min and saved 161 GB). So poll
      # Get-ReFSDedupStatus every 30 s until the job is no longer running, bounded by the job's own 5 h Duration plus
      # 15 min (630 polls; the task's 6 h ExecutionTimeLimit is the outer bound), then report what it did.
      if (-not (Drive)) { Done $false "$($Letter): is not mounted" }
      $vol = "$($Letter):"
      # Every Dev Drive install registers this task (w4517), but ReFS dedup runs only where it was turned on for the volume
      # (Enable-ReFSDedup; LothDesktop's V: since w1576). Elsewhere there is nothing to run: say so, and succeed.
      $en = try { Get-ReFSDedupStatus -Volume $vol } catch { $null; $why = $_.Exception.Message }
      if (-not $en) { Done $true "ReFS dedup is not available on $vol ($why); nothing to run" }
      if (-not $en.Enabled) { Done $true "ReFS dedup is not enabled on $vol (Enable-ReFSDedup was never run for it); nothing to run" }
      $free0 = (Get-Volume -DriveLetter $Letter).SizeRemaining
      $t0 = Get-Date
      Start-ReFSDedupJob -Volume $vol -FullRun -Duration (New-TimeSpan -Hours 5) -CpuPercentage 50 -MinimumLastModifiedTimeHours 1 | Out-Null
      $st = $null; $seen = $false; $errs = 0; $polls = 0; $maxPolls = 630
      while ($true) {
        Start-Sleep -Seconds 30
        $polls++
        try { $st = Get-ReFSDedupStatus -Volume $vol; $errs = 0 } catch {
          if (++$errs -ge 10) { Done $false "dedup status unreadable 10 times in a row after $polls polls: $($_.Exception.Message)" }
          continue
        }
        if ($st.Running) { $seen = $true }
        # Done once it has stopped and this run is the one the status describes (it was seen running, or its LastRunTime
        # is ours), so a poll that lands before the job registers is not read as the end.
        elseif ($seen -or ($st.LastRunTime -and ([datetime]$st.LastRunTime) -ge $t0.AddMinutes(-1))) { break }
        elseif ($polls -ge 20) { Done $false "full dedup job on $vol was never seen running in $polls polls, and the last run the status shows ($($st.LastRunTime)) is older than this start" }
        if ($polls -ge $maxPolls) {
          Done $false ("full dedup job on $vol still running after {0:N0} min ({1} polls); free {2:N1} -> {3:N1} GB so far" -f ((Get-Date) - $t0).TotalMinutes, $polls, ($free0 / 1GB), ((Get-Volume -DriveLetter $Letter).SizeRemaining / 1GB))
        }
      }
      $free1 = (Get-Volume -DriveLetter $Letter).SizeRemaining
      $ok = ([string]$st.LastRunStatus -eq '0')
      Done $ok ("full dedup job on $vol (5 h cap, 50% CPU) started at {0:s}, ran {1:N0} min ({2} polls); free {3:N1} -> {4:N1} GB; job duration {5}, saved {6:N1} GB on this run, processed {7:N1} GB, LastRunStatus {8}" -f $t0, ((Get-Date) - $t0).TotalMinutes, $polls, ($free0 / 1GB), ($free1 / 1GB), $st.LastRunDuration, ($st.SavingsOnLastRun / 1GB), ($st.ProcessedOnLastRun / 1GB), $st.LastRunStatus)
    }
    'pagefile' {
      if ($PagefileGB -lt 4) { Done $false 'no fixed pagefile size was configured at install' }
      $cs = Get-CimInstance Win32_ComputerSystem
      if ($cs.AutomaticManagedPagefile) { $cs | Set-CimInstance -Property @{ AutomaticManagedPagefile = $false } }
      $mb = $PagefileGB * 1024
      $pf = Get-CimInstance Win32_PageFileSetting | Where-Object { $_.Name -like 'C:*' }
      if ($pf) { $pf | Set-CimInstance -Property @{ InitialSize = [uint32]$mb; MaximumSize = [uint32]$mb } }
      else { New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = 'C:\pagefile.sys'; InitialSize = [uint32]$mb; MaximumSize = [uint32]$mb } | Out-Null }
      Done $true "pagefile fixed at $PagefileGB GB (takes effect after the next reboot)"
    }
  }
} catch {
  Done $false $_.Exception.Message
}
