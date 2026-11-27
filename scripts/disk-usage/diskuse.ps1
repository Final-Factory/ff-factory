<#
.SYNOPSIS
  Real disk use of folders on a ReFS Dev Drive (w6291), where du counts block-cloned and hard-linked clusters once per file.
.DESCRIPTION
  LogicalGB is what du and Explorer add up. PhysicalGB is the union of the clusters the folder's files point at
  (FSCTL_GET_RETRIEVAL_POINTERS): a block clone or a hard link is counted once. ExclusiveGB is the clusters no other
  folder of the same run points at: what deleting that folder alone would free. ALL is the union across the folders.
  Junctions and symbolic links are never followed. Read-only: it opens each file for its attributes only.
  Measure only the install drive (never C:), and never name <root>\steam or <root>\secrets (-Children always skips them).
  On ReFS it ends with the gap: used minus the folders' union minus ReFS metadata, and the folders it did not measure.
.EXAMPLE
  powershell -File scripts\disk-usage\diskuse.ps1 -Folders V:\ffw\players,V:\ffw\player-cache
.EXAMPLE
  powershell -File scripts\disk-usage\diskuse.ps1 -Children V:\ffw -Exclude steam,secrets
#>
param([string[]]$Folders = @(), [string]$Children, [string[]]$Exclude = @('steam', 'secrets'), [switch]$LogicalOnly, [string[]]$Skip = @())
$ErrorActionPreference = 'Stop'
# `powershell -File` hands `-Exclude steam,secrets` in as ONE string "steam,secrets", which excluded nothing (w6552):
# split every list on commas, and never let a caller's -Exclude drop steam and secrets.
$Folders = @($Folders | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$Skip = @($Skip | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$Exclude = @(@($Exclude | ForEach-Object { $_ -split ',' }) + 'steam', 'secrets' | Where-Object { $_ } | Select-Object -Unique)
$closed = @()
if ($Children) {
  foreach ($d in Get-ChildItem -LiteralPath $Children -Directory | Where-Object { $_.Name -notin $Exclude -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }) {
    # A folder this account cannot list (the daemon's own, on a fenced worker) would print as 0 GB: name it instead.
    try { $null = [IO.Directory]::EnumerateFileSystemEntries($d.FullName).GetEnumerator().MoveNext(); $Folders += $d.FullName } catch { $closed += $d.Name }
  }
}
if (-not $Folders.Count) { throw 'name -Folders or -Children' }
if (-not ('DiskUse' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'DiskUse.cs') }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Folders[0]))
$r = [DiskUse]::Measure($Folders, -not $LogicalOnly, $Skip)
"{0}Z  {1}: {2} file system, {3:N1} GB used, {4:N1} GB free" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm'), $drive.Name, $drive.DriveFormat, (($drive.TotalSize - $drive.TotalFreeSpace) / 1e9), ($drive.AvailableFreeSpace / 1e9)
$r | ForEach-Object {
  [pscustomobject]@{ Folder = $_.Folder; LogicalGB = [math]::Round($_.Logical / 1e9, 2); PhysicalGB = [math]::Round($_.Physical / 1e9, 2); ExclusiveGB = [math]::Round($_.Exclusive / 1e9, 2); Files = $_.Files; NoExtentGB = [math]::Round($_.NoExtentBytes / 1e9, 2); Reparse = $_.Reparse; Skipped = $_.Skipped; Errors = $_.Errors; Sec = [math]::Round($_.Seconds) }
} | Format-Table -AutoSize | Out-String -Width 200
# The space no measured folder holds (w6552): used, minus the union of the folders, minus ReFS's own metadata, which
# `fsutil volume diskfree` reports without elevation ("Total metadata bytes", ReFS only). What is left lives in folders
# not measured (named below), System Volume Information, the recycle bin, files deleted while still open, or frees
# ReFS has not finished; the walk takes minutes while the drive changes, so read it to a GB or two.
if (-not $LogicalOnly) {
  $used = $drive.TotalSize - $drive.TotalFreeSpace
  $all = ($r | Where-Object { $_.Folder -eq 'ALL' } | Select-Object -First 1).Physical
  if ($null -eq $all) { $all = ($r | Select-Object -First 1).Physical }
  $meta = 0
  $line = & fsutil volume diskfree $drive.Name 2>$null | Where-Object { $_ -match 'metadata' } | Select-Object -First 1
  if ($line) { $digits = ((($line -split ':', 2)[1] -split '\(')[0]) -replace '[^0-9]', ''; if ($digits) { $meta = [long]$digits } }
  "Used {0:N1} GB = folders measured {1:N1} GB + ReFS metadata {2:N1} GB + not in them {3:N1} GB" -f ($used / 1e9), ($all / 1e9), ($meta / 1e9), (($used - $all - $meta) / 1e9)
  if ($Children) { "Not measured: excluded {0}{1}" -f ($Exclude -join ', '), $(if ($closed.Count) { "; this account cannot list $($closed -join ', ')" } else { '' }) }
  else { 'Not measured: everything outside the folders named' }
}
