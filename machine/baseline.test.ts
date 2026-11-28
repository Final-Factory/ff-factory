import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentClaude, probeBaseline, toolCommands } from './baseline.ts';
import { installHelpersOf } from './installSsh.ts';
import { AGENT_NODE } from '../server/agentNode.ts';
import { FEATURE_KEYS, NON_FEATURE_KEYS, PINNED_DAEMON_NODE, baselineDrift, daemonNodePinLine, driftLine, featureFlags, flagValue, portalSettings, sanitizeBaseline, versionOf } from '../shared/machineBaseline.ts';

test('w6603: versionOf reads the version from each tool line, past node warnings', () => {
  assert.equal(versionOf('git version 2.56.1.windows.1\n'), '2.56.1.windows.1');
  assert.equal(versionOf('(node:1) ExperimentalWarning: x\nv24.22.1'), '24.22.1');
  assert.equal(versionOf('2.1.312 (Claude Code)'), '2.1.312');
  assert.equal(versionOf('Python 3.10.11'), '3.10.11');
  assert.equal(versionOf('gh version 2.80.0 (2026-01-01)\nhttps://x'), '2.80.0');
  assert.equal(versionOf(''), 'unknown');
});

test('w6603: flagValue sorts keys and writes the root and home as <root> and <home>', () => {
  assert.equal(flagValue(undefined), 'unset');
  const win = (s: string) => s.replace(/\//g, String.fromCharCode(92));
  assert.equal(flagValue({ b: 1, a: win('F:/ffw/x') }, { root: win('F:/ffw') }), JSON.stringify({ a: win('<root>/x'), b: 1 }));
  assert.equal(flagValue(['/Users/me/ffw/a'], { root: '/Users/me/ffw', home: '/Users/me' }), '["<root>/a"]');
  assert.equal(flagValue('x'.repeat(400)).length, 160);
});

test('w6603: agentClaude prefers the configured one, then the SDK binary, then claude', () => {
  assert.equal(agentClaude('C:/c/claude.exe'), 'C:/c/claude.exe');
  assert.equal(agentClaude(undefined, 'win32', 'x64', () => 'X/sdk/package.json'), path.join('X/sdk', 'claude.exe'));
  assert.equal(agentClaude(undefined, 'darwin', 'arm64', () => 'X/sdk/package.json'), path.join('X/sdk', 'claude'));
  assert.equal(agentClaude(undefined, 'linux', 'x64', () => { throw new Error('nope'); }), 'claude');
});

test('w6603: on Windows the agents\' own node and git are probed when installed', () => {
  const c = toolCommands({ root: 'F:/ffw', claude: 'claude', platform: 'win32', env: {}, exists: () => true });
  assert.match(c.git[0], /tools.git.cmd.git\.exe$/);
  assert.match(c.bash[0], /tools.git.bin.bash\.exe$/);
  assert.equal(c.python[0], 'python');
  const none = toolCommands({ root: 'F:/ffw', claude: 'claude', platform: 'win32', env: { FF_PYTHON: 'P:/py.exe' }, exists: () => false });
  assert.deepEqual([none.agentNode[0], none.git[0], none.python[0]], ['node', 'git', 'P:/py.exe']);
});

test('w6603: probeBaseline reports versions, a missing tool and a failed one', async () => {
  const run = async (cmd: string) => {
    if (cmd === 'uv') throw new Error('spawn uv ENOENT');
    if (cmd === 'gh') return { code: 2, stdout: '', stderr: 'boom' };
    return { code: 0, stdout: cmd === 'python' ? 'Python 3.12.10' : 'tool 1.2.3', stderr: '' };
  };
  const b = await probeBaseline({ run, cfg: { storeLock: true }, root: 'R', claude: 'claude', platform: 'win32', env: {}, exists: () => false });
  assert.equal(b.tools.python, '3.12.10');
  assert.equal(b.tools.uv, 'missing');
  assert.equal(b.tools.gh, 'failed (exit 2)');
  assert.equal(b.flags.storeLock, 'true');
  assert.equal(b.flags.workerFence, 'unset');
});

test('w6603: drift compares machines of one OS only, and a lone report is no drift', () => {
  const tools = (python: string) => ({ tools: { python }, flags: { storeLock: 'true' } });
  const d = baselineDrift([
    { id: 'a', platform: 'win32', baseline: tools('3.10.11') },
    { id: 'b', platform: 'win32', baseline: tools('3.12.10') },
    { id: 'c', platform: 'win32', baseline: tools('3.12.10') },
    { id: 'm', platform: 'darwin', baseline: tools('3.9.6') },
  ]);
  assert.equal(d.get('darwin'), undefined);
  assert.deepEqual(d.get('win32'), [{ key: 'tool.python', values: [{ value: '3.12.10', machines: ['b', 'c'] }, { value: '3.10.11', machines: ['a'] }] }]);
  assert.equal(driftLine('a', d.get('win32')), 'tool.python 3.10.11 (3.12.10 on b, c)');
  assert.equal(driftLine('z', d.get('win32')), undefined);
  const p = baselineDrift([
    { id: 'a', platform: 'win32', portal: portalSettings({ belowNormal: true }) },
    { id: 'b', platform: 'win32', portal: portalSettings({}) },
  ]);
  assert.equal(driftLine('b', p.get('win32')), 'portal.belowNormal off (on on a)');
});

test('w6603: sanitizeBaseline keeps short strings only', () => {
  assert.equal(sanitizeBaseline(undefined), undefined);
  assert.deepEqual(sanitizeBaseline({ tools: { git: '2', 'bad key!': 'x', n: 3 }, flags: 'no' }), { tools: { git: '2' }, flags: {} });
  assert.equal(sanitizeBaseline({ tools: { a: 'y'.repeat(999) } })!.tools.a.length, 160);
});

test('w6603 (w6613 review): every DaemonConfig key is in exactly one of FEATURE_KEYS and NON_FEATURE_KEYS', () => {
  const src = fs.readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8');
  const start = src.indexOf('interface DaemonConfig {');
  const body = src.slice(start, src.indexOf('\n}', start));
  const keys = [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z]+)\??:/gm)].map((m) => m[1]);
  assert.ok(keys.length > 40, `read ${keys.length} keys`);
  const lists = [...FEATURE_KEYS, ...NON_FEATURE_KEYS] as string[];
  for (const k of keys) assert.equal(lists.filter((x) => x === k).length, 1, `DaemonConfig.${k}: add it to FEATURE_KEYS or NON_FEATURE_KEYS`);
  for (const k of lists) assert.ok(keys.includes(k), `${k} is no DaemonConfig key`);
});

test('w6603 (w6613 review): sandboxCacheTrim compares on/off only; sessionSweep is sizing', () => {
  const f = featureFlags({ sandboxCacheTrim: { buildCacheGB: 9 }, sessionSweep: { graceMin: 5 } });
  assert.equal(f.sandboxCacheTrim, 'on');
  assert.equal(featureFlags({ sandboxCacheTrim: false }).sandboxCacheTrim, 'off');
  assert.equal(featureFlags({}).sandboxCacheTrim, 'unset');
  assert.equal(f.sessionSweep, undefined);
  assert.equal(featureFlags({ freezeWatch: false }).freezeWatch, 'false');
});

test('w6603 (w6613 review): the sanitiser caps keys, and a key with three values lists them all', () => {
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'v']));
  assert.equal(Object.keys(sanitizeBaseline({ tools: many })!.tools).length, 64);
  assert.deepEqual(sanitizeBaseline({ tools: { ['x'.repeat(41)]: 'v', 'a.b-c_1': 'v' } })!.tools, { 'a.b-c_1': 'v' });
  const d = baselineDrift(['1', '2', '2', '3'].map((v, i) => ({ id: `m${i}`, platform: 'linux' as const, baseline: { tools: { git: v }, flags: {} } })));
  assert.equal(driftLine('m0', d.get('linux')), 'tool.git 1 (2 on m1, m2; 3 on m3)');
});

test('w6603: a daemon off its OS pinned node is named, warn only; an OS with no pin and an unreported node are not', () => {
  assert.equal(daemonNodePinLine('win32', { tools: { daemonNode: '22.17.0' }, flags: {} }), 'daemon node 22.17.0, not the pinned 24.22.1');
  assert.equal(daemonNodePinLine('win32', { tools: { daemonNode: '24.22.1' }, flags: {} }), undefined);
  assert.equal(daemonNodePinLine('win32', { tools: {}, flags: {} }), undefined);
  assert.equal(daemonNodePinLine('win32', undefined), undefined);
  assert.equal(daemonNodePinLine('darwin', { tools: { daemonNode: '26.5.0' }, flags: {} }), undefined);
  assert.equal(daemonNodePinLine(undefined, { tools: { daemonNode: '26.5.0' }, flags: {} }), undefined);
});

test("w6603: the Windows daemon's pin is the agents' pinned node", () => {
  assert.equal(`v${PINNED_DAEMON_NODE.win32}`, AGENT_NODE.version);
});

test("w6603: the installer's helpers outside the root are reported from root.json, and nothing without one", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'w6603-helpers-'));
  assert.deepEqual(installHelpersOf(root), {});
  assert.deepEqual(installHelpersOf(undefined), {});
  const outside = [
    { kind: 'task', name: 'FFMachineDaemon' },
    { kind: 'firewall-group', name: 'Final Factory player slots' },
    { kind: 'firewall-group', name: 'Final Factory agent node' },
    { kind: 'firewall-group', name: 'Final Factory agent node' },
    { kind: 'authorized-key', name: 'portal' },
  ];
  fs.writeFileSync(path.join(root, 'root.json'), JSON.stringify({ outside }));
  assert.deepEqual(installHelpersOf(root), { 'install.firewallGroups': '2', 'install.portalSsh': 'yes' });
  fs.writeFileSync(path.join(root, 'root.json'), JSON.stringify({ outside: [{ kind: 'task', name: 'FFMachineDaemon' }] }));
  assert.deepEqual(installHelpersOf(root), { 'install.firewallGroups': '0', 'install.portalSsh': 'no' }, 'a join with -NoSsh and no firewall step (w1596)');
  fs.rmSync(root, { recursive: true, force: true });
});
