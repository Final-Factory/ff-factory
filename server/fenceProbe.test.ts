import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFence, type ProbeRun } from '../machine/fenceProbe.ts';
import { bareEnv } from '../machine/maxEventsFence.ts';

// w5377: a write fence that cannot run a no-op is reported, never thrown, so the daemon keeps working (w5555: and holds its sandbox workers).

const fake = (r: ReturnType<ProbeRun>): ProbeRun => () => r;

test('a fence whose no-op exits 0 applies', () => {
  assert.deepEqual(probeFence(['sandbox-exec', '-p', '(version 1)', '/usr/bin/true'], { run: fake({ status: 0 }) }), { ok: true });
});

test('a launcher that exits non-zero (Landlock missing: 125, a refused profile: 65) leaves the fence off and says why', () => {
  const r = probeFence(['python3', 'ff-landlock.py', '--', '/bin/true'], { run: fake({ status: 125, stderr: 'line1\nff-landlock: this kernel has no Landlock\n' }) });
  assert.equal(r.ok, false);
  assert.match(r.why ?? '', /exited 125/);
  assert.match(r.why ?? '', /no Landlock/);
});

test('a launcher that cannot start or hangs leaves the fence off', () => {
  assert.equal(probeFence(['python3'], { run: fake({ status: null, error: new Error('spawn python3 ENOENT') }) }).ok, false);
  const hung = probeFence(['x'], { run: fake({ status: null, signal: 'SIGTERM' }) });
  assert.equal(hung.ok, false);
  assert.match(hung.why ?? '', /SIGTERM/);
});

test('the probe never throws, even when the runner does', () => {
  const r = probeFence(['x'], {
    run: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(r, { ok: false, why: 'probe failed: boom' });
  assert.equal(probeFence([]).ok, false);
});

test('a real command that does not exist is a failed probe, not a crash', () => {
  assert.equal(probeFence(['ff-no-such-launcher-w5377', '--version'], { timeoutMs: 5000 }).ok, false);
});

test('w5838: a probe given bareEnv runs with none of the daemon environment (no tokens), and without it with all of it', () => {
  // The program fails when it sees any of the secret-shaped names the daemon holds; it is node itself, as the Low launcher is.
  const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'W5838_VAULT_SECRET'];
  const argv = [process.execPath, '-e', `process.exit(${JSON.stringify(names)}.some((n) => process.env[n]) ? 3 : 0)`];
  const had = process.env.W5838_VAULT_SECRET;
  process.env.W5838_VAULT_SECRET = 'not-a-real-secret';
  try {
    assert.deepEqual(probeFence(argv, { timeoutMs: 60_000, env: bareEnv() }), { ok: true });
    assert.equal(probeFence(argv, { timeoutMs: 60_000 }).ok, false, "without env the run gets the daemon's own");
    for (const k of Object.keys(bareEnv({ ...process.env, GH_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' }))) assert.ok(/^(SystemRoot|SYSTEMROOT|windir|WINDIR|SystemDrive|SYSTEMDRIVE)$/.test(k), k);
  } finally {
    if (had === undefined) delete process.env.W5838_VAULT_SECRET;
    else process.env.W5838_VAULT_SECRET = had;
  }
});
