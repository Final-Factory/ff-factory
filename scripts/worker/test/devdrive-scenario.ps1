# A Windows PC's disks, drive letters and Dev Drive VHDX, faked, so scripts/privileged/ffsb-helper.ps1 and devdrive-lib.ps1 run
# on any computer with PowerShell 7 (scripts/devdrive.test.ts; w900). The scenario is JSON on the command line:
#   { "attached": bool,          the VHDX is attached when the helper starts
#     "autoLetter": "E" | "",    the letter Windows gives the volume when it is attached ("" none)
#     "inUse": ["C","D"],        letters other volumes hold
#     "mapped": ["U"],           mapped network drives
#     "reserved": ["T"],         MountedDevices reservations
#     "state": { "letter": "V" } the contents of the state file (or null: none)
#     "files": { "daemon.json": {...}, "sandboxes.json": [...] }   written to <work>\daemon\
#   }
# It runs the real helper with the real library and prints one JSON object: what was called, the result file, the files.
param([Parameter(Mandatory)][string]$Helper, [Parameter(Mandatory)][string]$Work, [Parameter(Mandatory)][string]$Scenario, [string]$Letter = 'V', [string[]]$Skip = @(), [string]$Action = 'mount', [switch]$NoFlex)
$ErrorActionPreference = 'Stop'
$sc = $Scenario | ConvertFrom-Json
$global:Calls = New-Object System.Collections.ArrayList
$global:Sc = $sc
$global:Held = [string]$(if ($sc.attached) { $sc.autoLetter } else { '' })
$global:Attached = [bool]$sc.attached
$global:Gave = ''

# The Windows cmdlets the library calls. Functions win over cmdlets of the same name.
function global:Start-Sleep { }
function global:Get-DiskImage { param([string]$ImagePath) [pscustomobject]@{ ImagePath = $ImagePath; Attached = $global:Attached } }
function global:Mount-DiskImage { param([string]$ImagePath) [void]$global:Calls.Add('Mount-DiskImage'); $global:Attached = $true; $global:Held = [string]$global:Sc.autoLetter }
function global:Get-Disk { param([Parameter(ValueFromPipeline)]$In) process { [pscustomobject]@{ Number = 7; IsOffline = $false; IsReadOnly = $false; PartitionStyle = 'GPT' } } }
function global:Set-Disk { }
function global:Get-Partition { param([int]$DiskNumber, [Parameter(ValueFromPipeline)]$In)
  process { if ($global:Attached) { [pscustomobject]@{ Type = 'Basic'; Size = 900GB; DriveLetter = $(if ($global:Held) { [char]$global:Held } else { [char]0 }); PartitionNumber = 2 } } } }
function global:Set-Partition { param([Parameter(ValueFromPipeline)]$In, [string]$NewDriveLetter)
  process { [void]$global:Calls.Add("Set-Partition $NewDriveLetter"); $global:Held = $NewDriveLetter.ToUpper(); $global:Gave = $NewDriveLetter.ToUpper() } }
function global:Test-Path { param([string]$Path, [string]$LiteralPath, $PathType)
  $p = if ($LiteralPath) { $LiteralPath } else { $Path }
  if ($p -match '^([A-Za-z]):\\$') { return ($global:Held -eq $Matches[1].ToUpper()) -or ($global:Sc.inUse -contains $Matches[1].ToUpper()) }
  Microsoft.PowerShell.Management\Test-Path @PSBoundParameters }

# Which letters exist, as the library asks (the library's own Get-*Letters functions run; only what they read is faked).
function global:Get-PSDrive { param($PSProvider)
  foreach ($l in @($global:Sc.inUse) + $(if ($global:Held) { @($global:Held) } else { @() })) { [pscustomobject]@{ Name = $l } } }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter)
  if ($ClassName -eq 'Win32_LogicalDisk') { foreach ($l in @($global:Sc.mapped)) { [pscustomobject]@{ DeviceID = "${l}:" } } } }
function global:Get-Item { param([Parameter(Position = 0)]$Path, $LiteralPath, [switch]$Force)
  if ($Path -like 'HKLM:*MountedDevices') {
    $o = [pscustomobject]@{}
    $o | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { @($global:Sc.reserved | ForEach-Object { "\DosDevices\${_}:" }) }
    return $o
  }
  Microsoft.PowerShell.Management\Get-Item @PSBoundParameters }

# The files the helper repoints.
New-Item -ItemType Directory -Force (Join-Path $Work 'daemon'), (Join-Path $Work 'results') | Out-Null
$StateFile = Join-Path $Work 'devdrive.json'
if ($sc.state) { ($sc.state | ConvertTo-Json -Depth 8) | Set-Content -Encoding utf8 $StateFile }
foreach ($f in 'daemon.json', 'sandboxes.json') { if ($sc.files.$f) { (ConvertTo-Json -InputObject $sc.files.$f -Depth 12) | Set-Content -Encoding utf8 (Join-Path $Work "daemon/$f") } }

$args2 = @{ Action = $Action; Vhdx = (Join-Path $Work 'devdrive.vhdx'); Letter = $Letter; ResultDir = (Join-Path $Work 'results'); StateFile = $StateFile; DaemonConfig = (Join-Path $Work 'daemon/daemon.json'); WorkerRoot = $Work }
if (-not $NoFlex) { $args2.Flex = $true }
if ($Skip.Count) { $args2.Skip = $Skip }
try { & $Helper @args2 } catch { $global:Thrown = $_.Exception.Message }

$res = Join-Path $Work 'results/mount.json'
$out = [ordered]@{
  calls  = @($global:Calls)
  held   = $global:Held
  result = $(if (Test-Path -LiteralPath $res) { Get-Content -Raw -LiteralPath $res | ConvertFrom-Json } else { $null })
  thrown = $global:Thrown
  state  = $(if (Test-Path -LiteralPath $StateFile) { Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json } else { $null })
  daemon = $(if (Test-Path -LiteralPath (Join-Path $Work 'daemon/daemon.json')) { Get-Content -Raw -LiteralPath (Join-Path $Work 'daemon/daemon.json') | ConvertFrom-Json } else { $null })
  pool   = $(if (Test-Path -LiteralPath (Join-Path $Work 'daemon/sandboxes.json')) { , @(Get-Content -Raw -LiteralPath (Join-Path $Work 'daemon/sandboxes.json') | ConvertFrom-Json) } else { $null })
}
ConvertTo-Json -InputObject $out -Depth 12 -Compress
