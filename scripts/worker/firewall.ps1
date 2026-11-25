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

  -AgentNode names the agents' node (<root>\tools\node\node.exe, server/agentNode.ts, w1742): one inbound allow rule
  for that exact path, any protocol, every profile, from Tailscale only (100.64.0.0/10 and fd7a:115c:a1e0::/48;
  loopback is never filtered), in the group "Final Factory agent node" (w5581; before it, from any address). Its own
  listeners bind 127.0.0.1 (ff-factory's server/listenLoopback.test.ts), which never prompts; the rule is for any other
  node listen, so it never prompts either: on BEAST the instance portals (docs/instances.md) run on this node and their
  daemons and people reach them over the tailnet. It names no port: a new instance takes a new one (scripts/instance/new.ts
  --port). Back to any address (the revert, docs/worker-install.md "The agent node's firewall rule"):
  Get-NetFirewallRule -Group 'Final Factory agent node' | Set-NetFirewallRule -RemoteAddress Any, elevated. -StaleUnder (the root's tmp folder) deletes the rules earlier prompts left for programs
  under it: a worker's own node copies, each in a session temp folder the harness has since removed.

  -FfuServer names ffu-server's paths in the ffu slots (machine/ffuSlots.ts ffuServerExes, w5442): one inbound TCP allow
  rule per path, every profile, from Tailscale only (100.64.0.0/10 and fd7a:115c:a1e0::/48; loopback is never filtered),
  in the group "Final Factory ffu-server". Its ports come from flags (--listen, --peer-listen; port 0 picks one), so the
  rule goes by program and names no port. No UDP: ffu has no UDP socket.

  -Remove deletes the four groups' rules, and the config file if it points at -Root.
  Idempotent. Never touches NotifyOnListen (lothsahn, 2026-10-06: the prompts stay on).
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    # The machine's sandbox count: player folders slot1-0..slot<Pairs>-1.
    [int]$Pairs = 1,
    [string]$UnityExe = '',
    [string]$AgentNode = '',
    [string]$StaleUnder = '',
    # ffu-server's paths, ';'-separated (w5442).
    [string]$FfuServer = '',
    [switch]$Remove,
    [string]$LogFile = '',
    # A test install beside a live one: its own rule groups ("<group> <suffix>") and no slot config (the live one's stays).
    [string]$GroupSuffix = ''
)
$ErrorActionPreference = 'Stop'
$SlotGroup = 'Final Factory player slots'
$UnityGroup = 'Final Factory Unity editors'
$NodeGroup = 'Final Factory agent node'
$FfuGroup = 'Final Factory ffu-server'
if ($GroupSuffix) { $SlotGroup = "$SlotGroup $GroupSuffix"; $UnityGroup = "$UnityGroup $GroupSuffix"; $NodeGroup = "$NodeGroup $GroupSuffix"; $FfuGroup = "$FfuGroup $GroupSuffix" }
# The tailnet's addresses (Tailscale's CGNAT range and its IPv6 ULA prefix): ffu-server's peers on the other machines.
$Tailnet = @('100.64.0.0/10', 'fd7a:115c:a1e0::/48')
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

function Add-Allow([string]$exe, [string]$name, [string]$group, [string]$why, [switch]$One, [switch]$Tailnet, [string]$Protocol = 'TCP') {
    # A Block rule an earlier, dismissed prompt left for this exact path (outside our groups) would win over ours.
    # Allow rules people made stay: an uninstall then leaves the path as it found it. Except for a tailnet-only path
    # (-Tailnet, w5581): there an inbound Allow from outside our groups (an "allow access" prompt's, any address) would
    # undo the narrowing, and these are the install's own programs at its own paths, so it goes too.
    $stale = @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue |
               Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Group -ne $SlotGroup -and $_.Group -ne $UnityGroup -and $_.Group -ne $FfuGroup -and $_.Group -ne $NodeGroup -and
                   ($_.Action -eq 'Block' -or ($Tailnet -and $_.Action -eq 'Allow' -and [string]$_.Direction -eq 'Inbound')) })
    if ($stale.Count) {
        Say "  ${name}: removing $($stale.Count) earlier rule(s) for $exe outside the install's groups"
        $stale | Remove-NetFirewallRule
    }
    if ($Tailnet) {
        # ffu-server (w5442, TCP) and the agents' node (w5581, any protocol): inbound from the tailnet only, every
        # profile. Loopback is never filtered, so local callers still reach them.
        New-NetFirewallRule -DisplayName $name -Group $group -Direction Inbound -Program $exe -Protocol $Protocol `
            -RemoteAddress $script:Tailnet -Action Allow -Profile Any -Description $why | Out-Null
        return 1
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
    $old = @(Get-NetFirewallRule -Group $SlotGroup -ErrorAction SilentlyContinue) + @(Get-NetFirewallRule -Group $UnityGroup -ErrorAction SilentlyContinue) + @(Get-NetFirewallRule -Group $NodeGroup -ErrorAction SilentlyContinue) + @(Get-NetFirewallRule -Group $FfuGroup -ErrorAction SilentlyContinue)
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
    # Each sandbox's pair (w576). The nightly lab's own pair is gone since w1099: the night plays from its sandbox's pair.
    foreach ($k in 1..$Pairs) {
        foreach ($p in 0, 1) {
            $who = "Sandbox slot$k"
            $made += Add-Allow (Join-Path $Root "slot$k-$p\player\finalfactory.exe") "Final Factory player slot$k-$p" $SlotGroup "$who's player $p (scripts/nightly/player_slots.py, w576)" -One
        }
    }
    if ($AgentNode) {
        $made += Add-Allow $AgentNode 'Final Factory agent node' $NodeGroup "The agents' node at its one fixed path, from Tailscale only (server/agentNode.ts, w1742, w5581)" -Tailnet -Protocol Any
    }
    $ffu = 0
    foreach ($exe in @($FfuServer -split ';' | Where-Object { $_ })) {
        $slot = Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $exe))
        if ($slot -eq 'target') { $slot = Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $exe))) }
        $made += Add-Allow $exe "Final Factory ffu-server $slot $(Split-Path -Leaf (Split-Path -Parent $exe))" $FfuGroup "ffu-server in ffu sandbox $slot, from Tailscale only (machine/ffuSlots.ts ffuServerExes, w5442)" -Tailnet
        $ffu++
    }
    $staleGone = 0
    if ($StaleUnder) {
        # Rules prompts left for programs in the root's temp folders (a worker's node copy, w1742), never one of ours or a test install's.
        $under = ([IO.Path]::GetFullPath($StaleUnder)).TrimEnd('\') + '\'
        $staleRules = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { [string]$_.Program -like ($under + '*') } |
                        Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { ([string]$_.Group) -notlike 'Final Factory*' })
        if ($staleRules.Count) { $staleRules | Remove-NetFirewallRule; $staleGone = $staleRules.Count }
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
    Say "OK: $made allow rule(s): $Root\slot1-0..slot$Pairs-1 ($(2 * $Pairs) player folders, one rule each) and $editors Unity editor(s)$(if ($AgentNode) { ", one for the agents' node $AgentNode (Tailscale only)" } else { '' })$(if ($ffu) { ", $ffu for ffu-server in the ffu slots (Tailscale only)" } else { '' })$(if ($staleGone) { "; removed $staleGone rule(s) earlier prompts left under $StaleUnder" } else { '' })$(if ($GroupSuffix) { ' (test groups; no slot config)' } else { "; slot root recorded in $Config" })."
} catch {
    Say "FAILED: $($_.Exception.Message)"
    exit 1
}
