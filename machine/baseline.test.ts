import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agentClaude, probeBaseline, toolCommands } from './baseline.ts';
import { baselineDrift, driftLine, flagValue, portalSettings, sanitizeBaseline, versionOf } from '../shared/machineBaseline.ts';

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
