# The sandbox Dev Drive: a dynamically expanding VHDX formatted as a ReFS Dev Drive, so every
# sandbox's Library can be a block clone of one seed (near-zero space until an editor rewrites it).
#   .\devdrive.ps1 -Create    make the VHDX, format it, register the boot-mount task (admin)
#   .\devdrive.ps1 -Mount     attach it if it is not attached (what the boot task runs)
param(
  [switch]$Create,
  [switch]$Mount,
  [string]$Path = 'C:\ffsb-devdrive.vhdx',
  [string]$Letter = 'F',
  [int]$MaxGB = 900
)
$ErrorActionPreference = 'Stop'

function Attach {
  $img = Get-DiskImage -ImagePath $Path
  if (-not $img.Attached) { Mount-DiskImage -ImagePath $Path | Out-Null; Start-Sleep 2 }
  $part = Get-DiskImage -ImagePath $Path | Get-Disk | Get-Partition | Where-Object Type -ne 'Reserved' | Select-Object -First 1
  if ($part.DriveLetter -ne $Letter) { $part | Set-Partition -NewDriveLetter $Letter }
  "attached $Path as ${Letter}:"
}

if ($Create) {
  if (Test-Path $Path) { throw "$Path already exists" }
  if (Get-PSDrive -Name $Letter -EA SilentlyContinue) { throw "drive ${Letter}: is already in use" }
  $script = Join-Path $env:TEMP 'ffsb-devdrive.txt'
  "create vdisk file=`"$Path`" maximum=$($MaxGB * 1024) type=expandable" | Out-File $script -Encoding ascii
  diskpart /s $script | Out-Null
  Remove-Item $script
  Mount-DiskImage -ImagePath $Path | Out-Null
  $disk = Get-DiskImage -ImagePath $Path | Get-Disk
  Initialize-Disk -Number $disk.Number -PartitionStyle GPT
  New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter $Letter | Out-Null
  Format-Volume -DriveLetter $Letter -DevDrive -FileSystem ReFS -NewFileSystemLabel 'ffsb' -Confirm:$false | Out-Null
  # Attach at every boot, before anyone logs on (a VHDX attachment does not survive a reboot).
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mount -Path `"$Path`" -Letter $Letter"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName 'ffsb-devdrive-mount' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
  "created ${Letter}: ($MaxGB GB max, dynamic) and registered ffsb-devdrive-mount"
} elseif ($Mount) {
  Attach
} else {
  "usage: devdrive.ps1 -Create | -Mount"
}
