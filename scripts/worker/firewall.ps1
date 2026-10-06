<#
.SYNOPSIS
  The worker install's Windows Firewall rules (w513, docs/worker-install.md): run elevated by scripts/worker/worker.ts.

.DESCRIPTION
  Built players run only from <Root>\slotK\player\finalfactory.exe (K = 0..Count-1; scripts/nightly/player_slots.py),
  so each slot path needs its rules once. This adds, per slot, allow rules for inbound and outbound, TCP and UDP, on
  every profile, in the group "Final Factory player slots" (the group scripts/nightly/setup_player_slot_firewall.ps1
  uses too), after deleting rules an earlier prompt left for those exact paths (a dismissed prompt leaves Block rules,
  and a block outranks an allow). -UnityExe adds the same for the Unity editors (play mode's networking), in the
  group "Final Factory Unity editors". It records Root and Count in %ProgramData%\FinalFactory\player-slots.json,
  where player_slots.py finds the slots outside the daemon (a CI runner, a person's shell).

  -Remove deletes both groups' rules, and the config file if it points at -Root.
  Idempotent. Never touches NotifyOnListen (lothsahn, 2026-10-06: the prompts stay on).
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [int]$Count = 8,
    [string]$UnityExe = '',
    [switch]$Remove,
    [string]$LogFile = '',
    # A test install beside a live one: its own rule groups ("<group> <suffix>") and no slot config (the live one's stays).
    [string]$GroupSuffix = ''
)
$ErrorActionPreference = 'Stop'
$SlotGroup = 'Final Factory player slots'
$UnityGroup = 'Final Factory Unity editors'
if ($GroupSuffix) { $SlotGroup = "$SlotGroup $GroupSuffix"; $UnityGroup = "$UnityGroup $GroupSuffix" }
$Config = Join-Path $env:ProgramData 'FinalFactory\player-slots.json'

function Say([string]$text) {
    Write-Host $text
    if ($LogFile) { Add-Content -LiteralPath $LogFile -Value $text }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say 'FAILED: this step changes Windows Firewall rules and needs administrator rights.'
    exit 1
}

function Add-Allow([string]$exe, [string]$name, [string]$group, [string]$why) {
    # Rules an earlier prompt made for this exact path (outside our groups): a Block one would win.
    $stale = @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue |
               Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Group -ne $SlotGroup -and $_.Group -ne $UnityGroup })
    if ($stale.Count) {
        Say "  ${name}: removing $($stale.Count) earlier rule(s) for $exe"
        $stale | Remove-NetFirewallRule
    }
    $n = 0
    foreach ($dir in 'Inbound', 'Outbound') {
        foreach ($proto in 'TCP', 'UDP') {
            New-NetFirewallRule -DisplayName "$name ($dir $proto)" -Group $group -Direction $dir -Program $exe `
                -Protocol $proto -Action Allow -Profile Any -Description $why | Out-Null
            $n++
        }
    }
    $n
}

try {
    $old = @(Get-NetFirewallRule -Group $SlotGroup -ErrorAction SilentlyContinue) + @(Get-NetFirewallRule -Group $UnityGroup -ErrorAction SilentlyContinue)
    if ($old.Count) { $old | Remove-NetFirewallRule }
    if ($Remove) {
        $removedConfig = $false
        if (-not $GroupSuffix -and (Test-Path -LiteralPath $Config)) {
            $rec = Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
            if ([string]$rec.root -and ([IO.Path]::GetFullPath([string]$rec.root)).TrimEnd('\') -ieq ([IO.Path]::GetFullPath($Root)).TrimEnd('\')) {
                Remove-Item -LiteralPath $Config -Force
                $removedConfig = $true
            }
        }
        Say "Removed $($old.Count) firewall rule(s)$(if ($removedConfig) { " and $Config" } else { '' })."
        exit 0
    }
    $made = 0
    for ($k = 0; $k -lt $Count; $k++) {
        $made += Add-Allow (Join-Path $Root "slot$k\player\finalfactory.exe") "Final Factory player slot$k" $SlotGroup 'Worker player slot (scripts/nightly/player_slots.py, w513)'
    }
    $editors = 0
    foreach ($exe in @($UnityExe -split ';' | Where-Object { $_ })) {
        $made += Add-Allow $exe "Unity editor $(Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $exe)))" $UnityGroup 'Unity editor play mode (worker install, w513)'
        $editors++
    }
    if (-not $GroupSuffix) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Config) | Out-Null
        [IO.File]::WriteAllText($Config, (@{ root = $Root; count = $Count } | ConvertTo-Json))
    }
    Say "OK: $made allow rule(s): $Root\slot0..slot$($Count - 1)\player\finalfactory.exe and $editors Unity editor(s); slot root recorded in $Config."
} catch {
    Say "FAILED: $($_.Exception.Message)"
    exit 1
}
