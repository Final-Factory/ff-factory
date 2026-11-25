import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENT_NODE, agentNodeDir, agentNodeExe, agentNodePathDir, ensureAgentNode, firewallCheckScript, parseFirewallCheck, type AgentNodeDeps } from './agentNode.ts';

/**
 * w1742: the agents' node lives at one fixed path per Windows worker root, so no worker unpacks its own into a session temp
 * folder (a new program path, and a Windows Firewall prompt, every session). These hold the swap with a fake download
 * and a fake tar: the folder's path never changes, a wrong download is refused, a busy folder is left alone.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-node-'));
const unpackedName = AGENT_NODE.zip.replace(/\.zip$/, '');

/** Deps whose "node.exe" is a text file holding its version, and whose tar makes the unpacked folder. */
function fake(zipBytes: Buffer, o: { tarFails?: boolean; version?: string } = {}) {
  const said: string[] = [];
  const d: AgentNodeDeps = {
    platform: 'win32',
    say: (l) => void said.push(l),
    download: async () => zipBytes,
    tar: 'tar',
    exec: async (cmd, args) => {
      if (cmd === 'tar') {
        if (o.tarFails) return { code: 1, stdout: '', stderr: 'bad zip' };
        const into = path.join(args[args.indexOf('-C') + 1], unpackedName);
        fs.mkdirSync(into, { recursive: true });
        fs.writeFileSync(path.join(into, 'node.exe'), o.version ?? AGENT_NODE.version);
        return { code: 0, stdout: '', stderr: '' };
      }
      // "<exe> --version": the fake exe's text
      return fs.existsSync(cmd) ? { code: 0, stdout: `${fs.readFileSync(cmd, 'utf8')}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'no such file' };
    },
  };
  return { d, said };
}

/** A download whose SHA-256 is the pinned one, as far as the code can tell: the pin replaced for the test. */
function pinned(bytes: Buffer, fn: () => Promise<void>) {
  const real = AGENT_NODE.sha256;
  (AGENT_NODE as { sha256: string }).sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return fn().finally(() => ((AGENT_NODE as { sha256: string }).sha256 = real));
}

test('the agent node goes to <root>/tools/node, is current on the next run, and the path stays when the version changes (w1742)', async () => {
  const root = tmp();
  const zip = Buffer.from('a zip');
  await pinned(zip, async () => {
    const f = fake(zip);
    assert.equal(await ensureAgentNode(root, f.d), 'installed');
    assert.equal(fs.readFileSync(agentNodeExe(root), 'utf8'), AGENT_NODE.version);
    assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), ['node'], 'nothing left beside it');
    assert.equal(await ensureAgentNode(root, f.d), 'current');
    // An older node there: replaced in place, the same folder.
    fs.writeFileSync(agentNodeExe(root), 'v22.0.0');
    assert.equal(await ensureAgentNode(root, f.d), 'installed');
    assert.equal(fs.readFileSync(agentNodeExe(root), 'utf8'), AGENT_NODE.version);
    assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), ['node']);
    assert.match(f.said.at(-1)!, /installed at .*\(was v22\.0\.0\)/);
  });
});

test('a download with the wrong SHA-256, a failed unpack or a wrong version leaves the old node and no part folder (w1742)', async () => {
  const root = tmp();
  fs.mkdirSync(agentNodeDir(root), { recursive: true });
  fs.writeFileSync(agentNodeExe(root), 'v22.0.0');
  const bad = fake(Buffer.from('not the pinned zip'));
  assert.equal(await ensureAgentNode(root, bad.d), 'failed');
  assert.match(bad.said.at(-1)!, /^WARNING: .*SHA-256/);
  const zip = Buffer.from('a zip');
  await pinned(zip, async () => {
    assert.equal(await ensureAgentNode(root, fake(zip, { tarFails: true }).d), 'failed');
    assert.equal(await ensureAgentNode(root, fake(zip, { version: 'v1.0.0' }).d), 'failed');
  });
  assert.equal(fs.readFileSync(agentNodeExe(root), 'utf8'), 'v22.0.0');
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), ['node']);
});

test('not Windows: nothing to place, and nothing goes on PATH; Windows: the folder once node.exe is there (w1742)', async () => {
  const root = tmp();
  const f = fake(Buffer.from('x'));
  assert.equal(await ensureAgentNode(root, { ...f.d, platform: 'linux' }), 'skipped');
  assert.ok(!fs.existsSync(path.join(root, 'tools')));
  assert.equal(agentNodePathDir(root, 'darwin', () => true), undefined);
  assert.equal(agentNodePathDir(undefined, 'win32', () => true), undefined);
  assert.equal(agentNodePathDir(root, 'win32', () => false), undefined);
  assert.equal(agentNodePathDir(root, 'win32', () => true), agentNodeDir(root));
});

test('w1742: the firewall read names each path, quoted, and the temp folder in lower case with one trailing backslash', () => {
  const s = firewallCheckScript(["V:\\ffw\\tools\\node\\node.exe", "C:\\it's\\player.exe"], 'V:\\ffw\\TMP\\');
  assert.ok(s.includes("@('V:\\ffw\\tools\\node\\node.exe', 'C:\\it''s\\player.exe')"), s);
  assert.ok(s.includes("$p.StartsWith('v:\\ffw\\tmp\\')"), s);
  assert.ok(s.includes("-notlike 'Final Factory*'"), 'the install\'s own groups (a test install\'s too) are never stale');
});

test('w1742: the firewall answer (as lothdesktop gave it after #517: node and a tenth slot missing, six temp-node rules)', () => {
  const out = 'ok V:\\ffw\\players\\slot1-0\\player\\finalfactory.exe\r\nmissing V:\\ffw\\tools\\node\\node.exe\r\nmissing V:\\ffw\\players\\slot9-0\\player\\finalfactory.exe\r\nstale=6\r\n';
  assert.deepEqual(parseFirewallCheck(out), { wide: [], missing: ['V:\\ffw\\tools\\node\\node.exe', 'V:\\ffw\\players\\slot9-0\\player\\finalfactory.exe'], stale: 6, from: [], peers: [], peersUnknown: [] });
  assert.deepEqual(parseFirewallCheck('ok A\nstale=0'), { missing: [], wide: [], stale: 0, from: [], peers: [], peersUnknown: [] });
  assert.equal(parseFirewallCheck('reading the firewall rules failed: Access is denied'), undefined, 'an unreadable answer is not "all there"');
});

test('w5581: the firewall read lists the tailnet-only paths an allow rule does not keep to the tailnet', () => {
  const node = 'F:\\ffw\\tools\\node\\node.exe';
  const s = firewallCheckScript([node], 'F:\\ffw\\tmp', [node]);
  assert.ok(s.includes('Get-NetFirewallAddressFilter'), 'reads every address filter in one bulk read');
  assert.ok(s.includes("$tailnet = @('100.64.0.0/255.192.0.0', '100.64.0.0/10', 'fd7a:115c:a1e0::/48')"), s);
  assert.ok(s.includes("foreach ($e in @('F:\\ffw\\tools\\node\\node.exe')) {"), s);
  assert.ok(firewallCheckScript([node], 'F:\\ffw\\tmp').includes('foreach ($e in @()) {'), 'no tailnet-only paths: nothing is wide');
  // BEAST before w5581 (the ops worker's read, 2026-11-25): the node's rule allowed every address.
  const out = `read apps=858 addrs=858 inbound=549\r\nok ${node}\r\nfrom ${node} Any\r\nwide ${node}\r\npeer ${node} 192.168.1.20:8891\r\nstale=0\r\n`;
  assert.deepEqual(parseFirewallCheck(out), { missing: [], wide: [node], stale: 0, from: [`${node} Any`], peers: [`${node} 192.168.1.20:8891`], peersUnknown: [], read: 'apps=858 addrs=858 inbound=549' });
  assert.deepEqual(parseFirewallCheck(`ok ${node}\nstale=0`), { missing: [], wide: [], stale: 0, from: [], peers: [], peersUnknown: [] });
});

/**
 * Runs firewallCheckScript in Windows PowerShell against stand-ins for the NetSecurity and network cmdlets, returning the
 * values BEAST's real ones gave (the ops worker's elevated read, 2026-11-25: RemoteAddress the string 'Any'). The earlier
 * tests only matched the script's text, and the check it held said "tailnet only" for BEAST's wide rule on every run.
 */
function runCheck(node: string, remote: string[], opts: { inBulk?: boolean; peers?: string[]; running?: boolean } = {}): string {
  const rule = '{a7aa1dbe-357d-42e0-9480-e0ae525264e7}';
  const arr = (xs: string[]) => `@(${xs.map((x) => `'${x}'`).join(',')})`;
  const mocks = `
function Get-NetFirewallApplicationFilter { @([pscustomobject]@{ InstanceID = '${rule}'; Program = '${node}' }, [pscustomobject]@{ InstanceID = 'other'; Program = 'C:/other.exe' }) }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline = $true)] $InputObject) process { if ($InputObject) { [pscustomobject]@{ InstanceID = '${rule}'; RemoteAddress = ${remote.length === 1 ? `'${remote[0]}'` : arr(remote)} } } } end { if (-not $InputObject) { ${opts.inBulk === false ? '' : `[pscustomobject]@{ InstanceID = '${rule}'; RemoteAddress = ${remote.length === 1 ? `'${remote[0]}'` : arr(remote)} };`} [pscustomobject]@{ InstanceID = 'other'; RemoteAddress = 'Any' } } } }
function Get-NetFirewallRule { param($Direction, $Name) [pscustomobject]@{ Name = '${rule}'; Enabled = 'True'; Action = 'Allow'; Group = 'Final Factory agent node' } }
function Get-Process { param($ErrorAction) ${opts.running === false ? '' : `[pscustomobject]@{ Id = 42; Path = '${node}' };`} [pscustomobject]@{ Id = 4; Path = $null } }
function Get-NetTCPConnection { param($State, $OwningProcess, $ErrorAction) if ($State -eq 'Listen') { [pscustomobject]@{ LocalPort = 8891 } } else { foreach ($p in ${arr(opts.peers ?? ['127.0.0.1', '100.86.157.116'])}) { [pscustomobject]@{ LocalPort = 8891; RemoteAddress = $p } }; [pscustomobject]@{ LocalPort = 50000; RemoteAddress = '8.8.8.8' } } }
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fwcheck-')), 'check.ps1');
  fs.writeFileSync(file, mocks + firewallCheckScript([node], 'F:\\ffw\\tmp', [node]));
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('w5581: the firewall read, run, finds BEAST\'s wide node rule and passes a tailnet one', { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, () => {
  const node = 'F:\\ffw\\tools\\node\\node.exe';
  const wide = parseFirewallCheck(runCheck(node, ['Any']));
  assert.deepEqual(wide?.wide, [node], 'BEAST: RemoteAddress Any is wide');
  assert.deepEqual(wide?.missing, []);
  assert.deepEqual(wide?.peers, [], 'loopback and tailnet peers, and connections to other ports, are not counted');
  assert.equal(wide?.read, 'apps=2 addrs=2 inbound=1');
  assert.deepEqual(parseFirewallCheck(runCheck(node, ['100.64.0.0/255.192.0.0', 'fd7a:115c:a1e0::/48']))?.wide, [], 'tailnet only');
  assert.deepEqual(parseFirewallCheck(runCheck(node, ['100.64.0.0/255.192.0.0', 'LocalSubnet']))?.wide, [node], 'anything beside the tailnet is wide');
  assert.deepEqual(parseFirewallCheck(runCheck(node, ['Any'], { inBulk: false }))?.wide, [node], 'a rule missing from the bulk read is read on its own');
  assert.deepEqual(parseFirewallCheck(runCheck(node, ['Any'], { peers: ['192.168.1.20', '::ffff:100.70.1.1', '::1'] }))?.peers, [`${node} 192.168.1.20:8891`], 'a LAN peer is one narrowing would cut off');
  assert.deepEqual(parseFirewallCheck(runCheck(node, ['Any'], { peers: ['::ffff:1.2.3.4.5', '2001:db8::1', '10.0.0.9'] }))?.peers, [`${node} ::ffff:1.2.3.4.5:8891`, `${node} 2001:db8::1:8891`, `${node} 10.0.0.9:8891`], 'an odd address is counted, and the rest after it still are');
  const off = parseFirewallCheck(runCheck(node, ['Any'], { running: false }));
  assert.deepEqual([off?.peers, off?.peersUnknown], [[], [`notrunning ${node}`]], 'a node not seen running is "could not see", never "none" (review of #1265)');
});

test('w5581: firewall.ps1 makes the agent node\'s rule from the tailnet only, any protocol, and firewallRepair warns of a wide one', () => {
  const ps = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'worker', 'firewall.ps1'), 'utf8');
  assert.match(ps, /Add-Allow \$AgentNode 'Final Factory agent node' \$NodeGroup "[^"]*" -Tailnet -Protocol Any/, 'the node: tailnet only, any protocol');
  assert.match(ps, /-Program \$exe -Protocol \$Protocol `\s*-RemoteAddress \$\(if \(\$AnyAddress\) \{ 'Any' \} else \{ \$script:Tailnet \}\)/, 'the tailnet branch passes the protocol, and -AgentNodeAnyAddress keeps it from any address');
  assert.match(ps, /-Tailnet -Protocol Any -AnyAddress:\$AgentNodeAnyAddress/);
  assert.match(ps, /Set-NetFirewallRule -RemoteAddress Any/, 'the header documents the revert');
  const worker = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'worker', 'worker.ts'), 'utf8');
  assert.match(worker, /WARNING: tailnet-only rule \(w5581, warn only\)/, 'a wide rule is warned of');
  assert.doesNotMatch(worker.match(/WARNING: tailnet-only rule[^`]*`/)![0], /Windows Firewall/, 'the warn stage leaves out the words that make the rollout rerun the tools elevated (machineRollout.publishTools)');
  // Review of #1265: a repair for a missing or stale rule re-makes every group, the node's too; while the node's rule is
  // wide that repair keeps it wide (firewall.ps1 -AgentNodeAnyAddress), so nothing narrows before the enforce stage.
  assert.match(worker, /firewallArgs\('add', l, m\.slots, unityEditors\(\), m\.firewallSuffix, seen\.wide\.includes\(node\)\)/);
  assert.match(worker, /nodeAnyAddress \? \['-AgentNodeAnyAddress'\] : \[\]/);
  // Second review of #1265: an elevated update re-makes the groups too, so it reads the node's rule first and keeps a wide one.
  assert.match(worker, /const nodeWide = o\.update && fs\.existsSync\(node\) \? await agentNodeRuleWide\(l, node\) : false;/);
  assert.match(worker, /firewallArgs\('add', l, o\.maxSandboxes, editors, o\.firewallSuffix, nodeWide\)/);
  assert.match(worker, /return !seen \|\| seen\.wide\.includes\(node\);/, 'an unread rule is kept as it is, never narrowed');
  assert.match(worker, /seen\.peersUnknown\.filter\(\(p\) => seen\.wide\.some/, 'only the wide paths\' unseen peers are listed, not every idle ffu-server');
});
