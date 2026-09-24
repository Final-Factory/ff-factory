# The privileged helper (docs/self-recovery.md). install-privileged-helpers.ps1 copies it to
# %ProgramData%\ffsb-helpers (writable only by SYSTEM and Administrators) and registers one SYSTEM task per
# action with every argument fixed; the app's user may only start those tasks. Each run writes
# <ResultDir>\<Action>.json: { action, ok, at, detail }.
param(
  [Parameter(Mandatory)][ValidateSet('mount', 'trim', 'compact', 'detach', 'reboot', 'pagefile')][string]$Action,
  [Parameter(Mandatory)][string]$Vhdx,
  [Parameter(Mandatory)][ValidatePattern('^[D-Zd-z]$')][string]$Letter,
  [Parameter(Mandatory)][string]$ResultDir,
  [int]$PagefileGB = 0
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $ResultDir | Out-Null
function Done([bool]$ok, [string]$detail) {
  $r = [ordered]@{ action = $Action; ok = $ok; at = (Get-Date).ToUniversalTime().ToString('o'); detail = $detail }
  [IO.File]::WriteAllText((Join-Path $ResultDir "$Action.json"), ($r | ConvertTo-Json -Compress))
  exit ([int](!$ok))
}
function Drive { Test-Path "$($Letter):\" }

# Attach the VHDX if it is not, bring its disk online and give its data partition the drive letter.
function Mount-DevDrive {
  $img = Get-DiskImage -ImagePath $Vhdx
  if (-not $img.Attached) { Mount-DiskImage -ImagePath $Vhdx | Out-Null; Start-Sleep 2; $img = Get-DiskImage -ImagePath $Vhdx }
  $disk = $img | Get-Disk
  if ($disk.IsOffline) { Set-Disk -Number $disk.Number -IsOffline $false }
  if ($disk.IsReadOnly) { Set-Disk -Number $disk.Number -IsReadOnly $false }
  $part = Get-Partition -DiskNumber $disk.Number | Where-Object { $_.Type -ne 'Reserved' -and $_.Size -gt 1GB } | Sort-Object Size -Descending | Select-Object -First 1
  if (-not $part) { throw "no data partition on disk $($disk.Number)" }
  if ("$($part.DriveLetter)" -ne $Letter.ToUpper()) { $part | Set-Partition -NewDriveLetter $Letter }
  for ($i = 0; $i -lt 15 -and -not (Drive); $i++) { Start-Sleep 2 }
  if (-not (Drive)) { throw "the VHDX is attached but $($Letter): did not appear" }
}

try {
  switch ($Action) {
    'mount' {
      if (Drive) { Done $true "$($Letter): is already there" }
      Mount-DevDrive
      Done $true "attached $Vhdx as $($Letter):"
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
    'detach' {
      # For the recovery self-test (host_recovery "selftest"): the drive goes away as it did on 2026-09-24, and the
      # app must notice and reattach it through ffsb-helper-mount. Refused while any editor uses the drive.
      $users = Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" | Where-Object { $_.CommandLine -match "(?i)$($Letter):[\\/]" }
      if ($users) { Done $false "refused: $(@($users).Count) Unity editor(s) use $($Letter): (stop them first)" }
      if (-not (Get-DiskImage -ImagePath $Vhdx).Attached) { Done $true "already detached" }
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
