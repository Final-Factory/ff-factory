<#
.SYNOPSIS
  Real disk use of folders on a ReFS Dev Drive (w6291), where du counts block-cloned and hard-linked clusters once per file.
.DESCRIPTION
  LogicalGB is what du and Explorer add up. PhysicalGB is the union of the clusters the folder's files point at
  (FSCTL_GET_RETRIEVAL_POINTERS): a block clone or a hard link is counted once. ExclusiveGB is the clusters no other
  folder of the same run points at: what deleting that folder alone would free. ALL is the union across the folders.
  Junctions and symbolic links are never followed. Read-only: it opens each file for its attributes only.
  Measure only the install drive (never C:), and never name <root>\steam or <root>\secrets.
.EXAMPLE
  powershell -File scripts\disk-usage\diskuse.ps1 -Folders V:\ffw\players,V:\ffw\player-cache
.EXAMPLE
  powershell -File scripts\disk-usage\diskuse.ps1 -Children V:\ffw -Exclude steam,secrets
#>
param([string[]]$Folders = @(), [string]$Children, [string[]]$Exclude = @('steam', 'secrets'), [switch]$LogicalOnly, [string[]]$Skip = @())
$ErrorActionPreference = 'Stop'
if ($Children) { $Folders += Get-ChildItem -LiteralPath $Children -Directory | Where-Object { $_.Name -notin $Exclude -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | ForEach-Object { $_.FullName } }
if (-not $Folders.Count) { throw 'name -Folders or -Children' }
if (-not ('DiskUse' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'DiskUse.cs') }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Folders[0]))
$r = [DiskUse]::Measure($Folders, -not $LogicalOnly, $Skip)
"{0}Z  {1}: {2} file system, {3:N1} GB used, {4:N1} GB free" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm'), $drive.Name, $drive.DriveFormat, (($drive.TotalSize - $drive.TotalFreeSpace) / 1e9), ($drive.AvailableFreeSpace / 1e9)
$r | ForEach-Object {
  [pscustomobject]@{ Folder = $_.Folder; LogicalGB = [math]::Round($_.Logical / 1e9, 2); PhysicalGB = [math]::Round($_.Physical / 1e9, 2); ExclusiveGB = [math]::Round($_.Exclusive / 1e9, 2); Files = $_.Files; NoExtentGB = [math]::Round($_.NoExtentBytes / 1e9, 2); Reparse = $_.Reparse; Skipped = $_.Skipped; Errors = $_.Errors; Sec = [math]::Round($_.Seconds) }
} | Format-Table -AutoSize | Out-String -Width 200
