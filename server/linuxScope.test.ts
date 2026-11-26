import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, limitsUsable, probeLimits, probeOomPolicy, probeScopes, resetScopeProbe, scopeEndCause, scopeUnit, scoped, scopesUsable, oomPolicyUsable, warmScopeProbes } from '../machine/linuxScope.ts';

// w2474: on Linux each editor and agent host gets a systemd scope of its own, out of the daemon's cgroup, so that
// systemd-oomd's whole-cgroup kill under memory pressure takes the editor, not the daemon and its link to the portal.

test('a Linux PC whose user manager answers runs the command in a scope of its own', () => {
  const c = scoped('unity', 'slot1', '/home/u/Unity/Hub/Editor/6000.3.1f1/Editor/Unity', ['-projectPath', '/home/u/ffw/sandboxes/slot1'], { platform: 'linux', usable: () => true, oom: () => false });
  assert.equal(c.bin, 'systemd-run');
  const at = c.args.indexOf('--');
  assert.deepEqual(c.args.slice(0, 4), ['--user', '--scope', '--quiet', '--collect']);
  assert.match(c.args[4], /^--unit=ffw-unity-slot1-[0-9a-z]+\.scope$/);
  assert.deepEqual(c.args.slice(at + 1), ['/home/u/Unity/Hub/Editor/6000.3.1f1/Editor/Unity', '-projectPath', '/home/u/ffw/sandboxes/slot1']);
});

test('a Mac, a Windows PC, or a Linux PC without a user manager starts the command as before', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    assert.deepEqual(scoped('agent', 'a', '/bin/node', ['x'], { platform, usable: () => true }), { bin: '/bin/node', args: ['x'] });
  }
  assert.deepEqual(scoped('agent', 'a', '/bin/node', ['x'], { platform: 'linux', usable: () => false }), { bin: '/bin/node', args: ['x'] });
});

test('scope names are unique and use only unit-name characters', () => {
  const names = new Set<string>();
  for (let i = 0; i < 50; i++) names.add(scopeUnit('agent', '.host 8188c1c4/../é', 1_800_000_000_000));
  assert.equal(names.size, 50, 'systemd refuses a second scope of a name that is still loaded');
  for (const n of names) assert.match(n, /^ffw-agent-[A-Za-z0-9][A-Za-z0-9_.-]*\.scope$/);
  assert.match(scopeUnit('unity', ''), /^ffw-unity-x-/);
  assert.ok(scopeUnit('unity', 'y'.repeat(300)).length < 100);
});

test('inScope puts the command after -- unchanged', () => {
  assert.deepEqual(inScope('u.scope', 'node', ['--a', '-b']).args.slice(-4), ['--', 'node', '--a', '-b']);
});

test('the probe trusts only the command having run, not systemd-run exiting 0', () => {
  // systemd 255 with no user bus: "Failed to connect to bus", nothing run, exit 0 (measured, Ubuntu 24.04 under WSL).
  assert.equal(probeScopes(() => ({ status: 0, stdout: '' })), false);
  assert.equal(probeScopes(() => ({ status: 1, stdout: '' })), false);
  assert.equal(probeScopes(() => ({ status: null, stdout: '' })), false, 'timed out');
  assert.equal(probeScopes(() => ({ status: 0, stdout: 'ffw-scope-ok\n' })), true);
});

test('the probe runs once and its answer is kept ten minutes', () => {
  resetScopeProbe();
  let n = 0;
  const probe = () => (n++, true);
  assert.equal(scopesUsable(probe, 0), true);
  assert.equal(scopesUsable(probe, 9 * 60_000), true);
  assert.equal(n, 1);
  scopesUsable(probe, 11 * 60_000);
  assert.equal(n, 2);
  resetScopeProbe();
});

test('w2884: a scope gets OOMPolicy=continue where systemd takes it, so an OOM-killed build does not end its agent host', () => {
  const c = scoped('agent', 'h1', '/bin/node', ['host.ts'], { platform: 'linux', usable: () => true, oom: () => true });
  const at = c.args.indexOf('--');
  assert.deepEqual(c.args.slice(at - 2, at), ['-p', 'OOMPolicy=continue']);
  assert.deepEqual(c.args.slice(at + 1), ['/bin/node', 'host.ts']);
  assert.match(c.unit ?? '', /^ffw-agent-h1-/);
  assert.ok(c.args.includes(`--unit=${c.unit}`));
  // A systemd older than 253 refuses the property: the scope starts without it.
  const old = scoped('agent', 'h1', '/bin/node', ['host.ts'], { platform: 'linux', usable: () => true, oom: () => false });
  assert.ok(!old.args.includes('OOMPolicy=continue'));
  assert.equal(probeOomPolicy(() => ({ status: 1, stdout: '' })), false);
  assert.equal(probeOomPolicy(() => ({ status: 0, stdout: 'ffw-scope-ok\n' })), true);
});

test("w2884: scopeEndCause names systemd's OOM line from a scope's journal, and nothing for a plain exit", async () => {
  const oom = 'Started ffw-agent-h1.scope.\nffw-agent-h1.scope: A process of this unit has been killed by the OOM killer.\nffw-agent-h1.scope: Failed with result \'oom-kill\'.\n';
  assert.match(await scopeEndCause('u', async () => ({ status: 0, stdout: oom })) ?? '', /oom-kill/);
  assert.match(await scopeEndCause('u', async () => ({ status: 0, stdout: 'ffw-agent-h1.scope: systemd-oomd killed 12 process(es) in this unit.\n' })) ?? '', /systemd-oomd/);
  assert.equal(await scopeEndCause('u', async () => ({ status: 0, stdout: 'Started ffw-agent-h1.scope.\nffw-agent-h1.scope: Consumed 3min CPU time.\n' })), undefined);
  assert.equal(await scopeEndCause('u', async () => ({ status: null, stdout: '' })), undefined, 'no journal');
  assert.equal(await scopeEndCause('u', async () => { throw new Error('no journalctl'); }), undefined);
});

test('w5554: a worker host scope carries MemoryMax and TasksMax where the user manager delegates them', () => {
  const lim = { memoryBytes: 51_539_607_552, tasks: 16384 };
  const c = scoped('agent', 'h', '/bin/node', ['host.ts'], { platform: 'linux', usable: () => true, oom: () => true, limits: lim, limitsOk: () => true });
  const at = c.args.indexOf('--');
  const before = c.args.slice(0, at);
  assert.ok(before.includes('MemoryMax=51539607552') && before.includes('TasksMax=16384'), before.join(' '));
  assert.ok(before.includes('OOMPolicy=continue'), 'an OOM kill in the scope ends the runaway, not the host');
  assert.equal(c.limited, true);
  assert.deepEqual(c.args.slice(at + 1), ['/bin/node', 'host.ts']);
  // a user manager without the controllers: no properties systemd would take and nothing would hold
  const d = scoped('agent', 'h', '/bin/node', ['host.ts'], { platform: 'linux', usable: () => true, oom: () => false, limits: lim, limitsOk: () => false });
  assert.ok(!d.args.some((a) => a.startsWith('MemoryMax=') || a.startsWith('TasksMax=')));
  assert.equal(d.limited, undefined);
  // an editor, or a session that is no worker, has none
  assert.ok(!scoped('unity', 's', '/u', [], { platform: 'linux', usable: () => true, oom: () => false }).args.some((a) => a.startsWith('MemoryMax=')));
});

test('w5554: without a usable OOMPolicy the scope has no limits: systemd would end the whole scope, the agent included', () => {
  const lim = { memoryBytes: 51_539_607_552, tasks: 16384 };
  const c = scoped('agent', 'h', '/bin/node', ['host.ts'], { platform: 'linux', usable: () => true, oom: () => false, limits: lim, limitsOk: () => true });
  assert.ok(!c.args.some((a) => a.startsWith('MemoryMax=') || a.startsWith('TasksMax=') || a.startsWith('OOMPolicy=')), c.args.join(' '));
  assert.equal(c.limited, undefined, 'the caller logs that the limits are not applied');
  assert.match(c.unit ?? '', /^ffw-agent-h-/, 'still in a scope of its own');
});

test('w5554: the limits probe trusts only the scope reading its own limits back', () => {
  assert.equal(probeLimits(() => ({ status: 0, stdout: '1073741824\n4096\n' })), true);
  assert.equal(probeLimits(() => ({ status: 0, stdout: 'max\nmax\n' })), false, 'systemd took the properties, the cgroup holds nothing');
  assert.equal(probeLimits(() => ({ status: 0, stdout: '' })), false, 'no memory controller: no file');
  assert.equal(probeLimits(() => ({ status: 1, stdout: '1073741824\n4096\n' })), false);
  resetScopeProbe();
  let n = 0;
  assert.equal(limitsUsable(() => (n++, true), 0), true);
  assert.equal(limitsUsable(() => (n++, false), 1000), true, 'kept');
  assert.equal(n, 1);
  resetScopeProbe();
});

test('w5973: warmScopeProbes fills the kept answers off the loop, so scoped() at a launch runs no probe of its own', async () => {
  resetScopeProbe();
  const calls: string[][] = [];
  const run = async (args: string[]) => (calls.push(args), { status: 0, stdout: args.includes('sh') ? '1073741824\n4096\n' : 'ffw-scope-ok\n' });
  await Promise.all([warmScopeProbes({ platform: 'linux', run, now: () => 0 }), warmScopeProbes({ platform: 'linux', run, now: () => 0 })]);
  assert.equal(calls.length, 3, 'one warm-up at a time: three probes, not six');
  const never = () => assert.fail('probed on the caller thread');
  assert.equal(scopesUsable(never, 1000), true);
  assert.equal(oomPolicyUsable(never, 1000), true);
  assert.equal(limitsUsable(never, 1000), true);
  await warmScopeProbes({ platform: 'linux', run, now: () => 1000 });
  assert.equal(calls.length, 3, 'fresh answers are not probed again');
  await warmScopeProbes({ platform: 'win32', run, now: () => 10 * 60_000 });
  assert.equal(calls.length, 3, 'Linux only');
  resetScopeProbe();
  await warmScopeProbes({ platform: 'linux', run: async () => ({ status: 0, stdout: 'Failed to connect to bus' }), now: () => 0 });
  assert.equal(scopesUsable(never, 1), false, 'no user manager: kept as no, and the other two not tried');
  resetScopeProbe();
});
