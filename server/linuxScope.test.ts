import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, probeOomPolicy, probeScopes, resetScopeProbe, scopeEndCause, scopeUnit, scoped, scopesUsable } from '../machine/linuxScope.ts';

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

test("w2884: scopeEndCause names systemd's OOM line from a scope's journal, and nothing for a plain exit", () => {
  const oom = 'Started ffw-agent-h1.scope.\nffw-agent-h1.scope: A process of this unit has been killed by the OOM killer.\nffw-agent-h1.scope: Failed with result \'oom-kill\'.\n';
  assert.match(scopeEndCause('u', () => ({ status: 0, stdout: oom })) ?? '', /oom-kill/);
  assert.match(scopeEndCause('u', () => ({ status: 0, stdout: 'ffw-agent-h1.scope: systemd-oomd killed 12 process(es) in this unit.\n' })) ?? '', /systemd-oomd/);
  assert.equal(scopeEndCause('u', () => ({ status: 0, stdout: 'Started ffw-agent-h1.scope.\nffw-agent-h1.scope: Consumed 3min CPU time.\n' })), undefined);
  assert.equal(scopeEndCause('u', () => ({ status: null, stdout: '' })), undefined, 'no journal');
  assert.equal(scopeEndCause('u', () => { throw new Error('no journalctl'); }), undefined);
});
