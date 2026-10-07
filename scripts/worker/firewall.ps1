<#
.SYNOPSIS
  The worker install's Windows Firewall rules (w513, docs/worker-install.md): run elevated by scripts/worker/worker.ts.

.DESCRIPTION
  Built players run only from <Root>\slotK-P\player\finalfactory.exe: each sandbox slotK (K = 1..Pairs) owns slotK-0
  (peer 0, the host) and slotK-1 (peer 1, the client) (w576; scripts/nightly/player_slots.py, layout sandbox-pairs),
  so each of those paths needs its rules once. This adds, per player folder, allow rules for inbound and outbound, TCP and UDP, on
  every profile, in the group "Final Factory player slots" (the group scripts/nightly/setup_player_slot_firewall.ps1
  uses too), after deleting rules an earlier prompt left for those exact paths (a dismissed prompt leaves Block rules,
  and a block outranks an allow). -UnityExe adds the same for the Unity editors (play mode's networking), in the
  group "Final Factory Unity editors". It records Root, the layout and the count (Pairs) in %ProgramData%\FinalFactory\player-slots.json,
  where player_slots.py finds the slots outside the daemon (a CI runner, a person's shell).

  -Remove deletes both groups' rules, and the config file if it points at -Root.
  Idempotent. Never touches NotifyOnListen (lothsahn, 2026-10-06: the prompts stay on).
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    # The machine's sandbox count: player folders slot1-0..slot<Pairs>-1.
    [int]$Pairs = 1,
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

function Add-Allow([string]$exe, [string]$name, [string]$group, [string]$why, [switch]$One) {
    # A Block rule an earlier, dismissed prompt left for this exact path (outside our groups) would win over ours.
    # Allow rules people made stay: an uninstall then leaves the path as it found it.
    $stale = @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue |
               Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Group -ne $SlotGroup -and $_.Group -ne $UnityGroup -and $_.Action -eq 'Block' })
    if ($stale.Count) {
        Say "  ${name}: removing $($stale.Count) earlier Block rule(s) for $exe"
        $stale | Remove-NetFirewallRule
    }
    if ($One) {
        # One rule per player folder (lothsahn, w576): inbound, any protocol, every profile. The prompt only ever asks
        # about inbound (a listening player), and Windows allows outbound unless a rule blocks it.
        New-NetFirewallRule -DisplayName $name -Group $group -Direction Inbound -Program $exe -Protocol Any `
            -Action Allow -Profile Any -Description $why | Out-Null
        return 1
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
    # Each sandbox's pair, then the nightly lab's (lothsahn: "Let's use slotnightly-0 and slotnightly-1").
    foreach ($k in @(1..$Pairs) + 'nightly') {
        foreach ($p in 0, 1) {
            $who = if ($k -eq 'nightly') { 'The nightly lab' } else { "Sandbox slot$k" }
            $made += Add-Allow (Join-Path $Root "slot$k-$p\player\finalfactory.exe") "Final Factory player slot$k-$p" $SlotGroup "$who's player $p (scripts/nightly/player_slots.py, w576)" -One
        }
    }
    $editors = 0
    foreach ($exe in @($UnityExe -split ';' | Where-Object { $_ })) {
        $made += Add-Allow $exe "Unity editor $(Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $exe)))" $UnityGroup 'Unity editor play mode (worker install, w513)'
        $editors++
    }
    if (-not $GroupSuffix) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Config) | Out-Null
        [IO.File]::WriteAllText($Config, (@{ root = $Root; layout = 'sandbox-pairs'; count = $Pairs } | ConvertTo-Json))
    }
    Say "OK: $made allow rule(s): $Root\slot1-0..slot$Pairs-1 and slotnightly-0, -1 ($(2 * $Pairs + 2) player folders, one rule each) and $editors Unity editor(s)$(if ($GroupSuffix) { ' (test groups; no slot config)' } else { "; slot root recorded in $Config" })."
} catch {
    Say "FAILED: $($_.Exception.Message)"
    exit 1
}
